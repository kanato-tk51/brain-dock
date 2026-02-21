#!/usr/bin/env python3
"""
Run stage 1-3 pipeline locally on an ephemeral SQLite database.

Stages:
  1) capture -> captures_raw
  2) process_captures -> notes/tasks
  3) extract_key_facts -> key_facts

By default this command leaves no DB behind.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_SQL = REPO_ROOT / "schemas/sql/001_core.sql"
CAPTURE_CMD = REPO_ROOT / "apps/cli/capture.py"
PROCESS_CMD = REPO_ROOT / "apps/worker/process_captures.py"
EXTRACT_CMD = REPO_ROOT / "apps/worker/extract_key_facts.py"


def _read_text(args: argparse.Namespace) -> str:
    chunks: list[str] = []
    cli_text = " ".join(args.text).strip()
    if cli_text:
        chunks.append(cli_text)
    if args.stdin:
        stdin_text = sys.stdin.read().strip()
        if stdin_text:
            chunks.append(stdin_text)
    text = "\n".join(chunks).strip()
    if not text:
        raise SystemExit("no input text. pass text args or use --stdin")
    return text


def _init_sqlite(db_path: Path) -> None:
    schema = SCHEMA_SQL.read_text(encoding="utf-8")
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(schema)
        conn.commit()
    finally:
        conn.close()


def _run_json_cmd(cmd: list[str]) -> dict[str, Any]:
    proc = subprocess.run(
        cmd,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"command returned no output: {' '.join(cmd)}")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"command output is not JSON: {proc.stdout}") from exc


def _query_preview(db_path: Path) -> dict[str, list[dict[str, Any]]]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        captures = [
            dict(row)
            for row in conn.execute(
                """
                SELECT id, input_type, raw_text, status, parsed_note_id, parsed_task_id, pii_score
                FROM captures_raw
                ORDER BY created_at ASC
                """
            ).fetchall()
        ]
        notes = [
            dict(row)
            for row in conn.execute(
                """
                SELECT id, note_type, title, summary, source_url, mood_score, energy_score
                FROM notes
                WHERE deleted_at IS NULL
                ORDER BY created_at ASC
                """
            ).fetchall()
        ]
        tasks = [
            dict(row)
            for row in conn.execute(
                """
                SELECT id, title, status, priority, due_at
                FROM tasks
                WHERE deleted_at IS NULL
                ORDER BY created_at ASC
                """
            ).fetchall()
        ]
        facts = [
            dict(row)
            for row in conn.execute(
                """
                SELECT note_id, task_id, subject, predicate, object_text, confidence
                FROM key_facts
                WHERE deleted_at IS NULL
                ORDER BY created_at ASC
                """
            ).fetchall()
        ]
    finally:
        conn.close()
    return {
        "captures_raw": captures,
        "notes": notes,
        "tasks": tasks,
        "key_facts": facts,
    }


def run(args: argparse.Namespace) -> int:
    text = _read_text(args)
    keep_path: Path | None = Path(args.keep_db).resolve() if args.keep_db else None
    temp_dir = None
    if keep_path:
        keep_path.parent.mkdir(parents=True, exist_ok=True)
        db_path = keep_path
    else:
        temp_dir = tempfile.TemporaryDirectory(prefix="brain-dock-pipeline-")
        db_path = Path(temp_dir.name) / "pipeline_test.db"

    ephemeral_deleted = False
    try:
        _init_sqlite(db_path)

        stage1_cmd = [
            args.python_bin,
            str(CAPTURE_CMD),
            "--backend",
            "sqlite",
            "--db",
            str(db_path),
            "--input-type",
            args.input_type,
            "--source-kind",
            args.source_kind,
            "--source-detail",
            args.source_detail,
            "--sensitivity",
            args.sensitivity,
            text,
        ]
        if args.occurred_at:
            stage1_cmd.extend(["--occurred-at", args.occurred_at])
        capture_result = _run_json_cmd(stage1_cmd)

        stage2_cmd = [
            args.python_bin,
            str(PROCESS_CMD),
            "--backend",
            "sqlite",
            "--db",
            str(db_path),
            "--limit",
            str(args.limit),
        ]
        process_result = _run_json_cmd(stage2_cmd)

        stage3_cmd = [
            args.python_bin,
            str(EXTRACT_CMD),
            "--backend",
            "sqlite",
            "--db",
            str(db_path),
            "--source",
            args.extract_source,
            "--max-facts-per-item",
            str(args.max_facts_per_item),
            "--replace-existing",
        ]
        extract_result = _run_json_cmd(stage3_cmd)

        preview = _query_preview(db_path)

        payload = {
            "pipeline": "capture->process_captures->extract_key_facts",
            "db_mode": "kept" if keep_path else "ephemeral",
            "db_path": str(db_path) if keep_path else None,
            "capture": capture_result,
            "process": process_result,
            "extract": extract_result,
            "preview": preview,
        }
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()
            ephemeral_deleted = True
        if ephemeral_deleted and args.verbose:
            print(json.dumps({"ephemeral_db_deleted": True}, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run stages 1-3 locally on a temporary SQLite DB and print JSON preview."
    )
    parser.add_argument("text", nargs="*", help="Input text for stage-1 capture")
    parser.add_argument("--stdin", action="store_true", help="Read input text from stdin")
    parser.add_argument(
        "--input-type",
        choices=["auto", "note", "task", "url", "quick"],
        default="auto",
        help="Input type forwarded to stage-1 capture",
    )
    parser.add_argument(
        "--sensitivity",
        choices=["public", "internal", "sensitive"],
        default="internal",
        help="Sensitivity forwarded to stage-1 capture",
    )
    parser.add_argument("--occurred-at", help="Occurred timestamp text for stage-1 capture")
    parser.add_argument("--source-kind", default="pipeline-test", help="Source kind for capture")
    parser.add_argument("--source-detail", default="pipeline-test-cli", help="Source detail label")
    parser.add_argument("--limit", type=int, default=200, help="Limit forwarded to stage-2 worker")
    parser.add_argument(
        "--extract-source",
        choices=["all", "notes", "tasks"],
        default="all",
        help="Source forwarded to stage-3 extractor",
    )
    parser.add_argument(
        "--max-facts-per-item",
        type=int,
        default=12,
        help="Max facts per item for stage-3 extraction",
    )
    parser.add_argument(
        "--keep-db",
        help="Keep SQLite DB at this path instead of deleting temp DB",
    )
    parser.add_argument(
        "--python-bin",
        default=sys.executable,
        help="Python executable for invoking stage commands",
    )
    parser.add_argument("--verbose", action="store_true", help="Print extra diagnostic output")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
