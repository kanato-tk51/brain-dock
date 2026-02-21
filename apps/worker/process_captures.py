#!/usr/bin/env python3
"""
Process raw captures into structured notes/tasks.

Usage:
  python3 apps/worker/process_captures.py --db /path/to/brain_dock.db
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import uuid
from typing import Literal

from json_contract import validate_contract, worker_schema_path


SOURCE_KIND = "ingestion-rules-v1"
CONTRACT_VERSION = "1.0"
MAX_TITLE_LEN = 120

URL_RE = re.compile(r"https?://[^\s)>\"]+")
TASK_HINT_RE = re.compile(
    r"^\s*(?:\[[ xX]\]|\( \)|todo|task|やること|宿題|next)\b|(?:\bTODO\b|締切|期限|やる|対応する)",
    re.IGNORECASE,
)
LEARNING_HINT_RE = re.compile(
    r"(学び|学ん|気づ|理解|読んだ|記事|動画|learn|lesson|insight|knowledge)",
    re.IGNORECASE,
)
JOURNAL_HINT_RE = re.compile(
    r"(今日|昨日|朝|夜|日記|振り返り|体調|気分|睡眠|mood|journal|diary)",
    re.IGNORECASE,
)
THOUGHT_HINT_RE = re.compile(
    r"(考え|思考|悩み|仮説|不安|why|how|should|idea)",
    re.IGNORECASE,
)
PRIORITY_RE = re.compile(r"\b[pP]([1-4])\b")
MOOD_RE = re.compile(r"(?:mood|気分)\s*[:：]?\s*([1-5])", re.IGNORECASE)
ENERGY_RE = re.compile(r"(?:energy|元気|活力)\s*[:：]?\s*([1-5])", re.IGNORECASE)
LEADING_TASK_PREFIX_RE = re.compile(
    r"^\s*(?:\[[ xX]\]|\(\s\)|todo[:：]?\s*|task[:：]?\s*|やること[:：]?\s*)",
    re.IGNORECASE,
)


def _new_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())  # type: ignore[attr-defined]
    return str(uuid.uuid4())


def clamp(value: str, max_len: int) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip()
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rstrip() + "..."


def first_non_empty_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def detect_note_type(input_type: str, text: str) -> Literal["journal", "learning", "thought"]:
    if input_type == "url":
        return "learning"
    if LEARNING_HINT_RE.search(text):
        return "learning"
    if JOURNAL_HINT_RE.search(text):
        return "journal"
    if THOUGHT_HINT_RE.search(text):
        return "thought"
    return "thought"


def detect_task_like(input_type: str, text: str) -> bool:
    if input_type == "task":
        return True
    if TASK_HINT_RE.search(text):
        return True
    return False


def extract_url(text: str) -> str | None:
    m = URL_RE.search(text)
    if not m:
        return None
    return m.group(0)


def extract_priority(text: str) -> int:
    m = PRIORITY_RE.search(text)
    if not m:
        return 3
    value = int(m.group(1))
    if 1 <= value <= 4:
        return value
    return 3


def extract_score(pattern: re.Pattern[str], text: str) -> int | None:
    m = pattern.search(text)
    if not m:
        return None
    value = int(m.group(1))
    if 1 <= value <= 5:
        return value
    return None


def note_title(text: str, fallback: str) -> str:
    line = first_non_empty_line(text)
    if not line:
        line = fallback
    return clamp(line, MAX_TITLE_LEN)


def task_title(text: str) -> str:
    line = first_non_empty_line(text)
    if not line:
        return "Untitled task"
    line = LEADING_TASK_PREFIX_RE.sub("", line).strip()
    if not line:
        line = "Untitled task"
    return clamp(line, MAX_TITLE_LEN)


def fetch_captures(conn: sqlite3.Connection, capture_id: str | None, limit: int) -> list[sqlite3.Row]:
    if capture_id:
        return list(
            conn.execute(
                """
                SELECT *
                FROM captures_raw
                WHERE id = :capture_id
                """,
                {"capture_id": capture_id},
            )
        )

    return list(
        conn.execute(
            """
            SELECT *
            FROM captures_raw
            WHERE status = 'new'
            ORDER BY created_at ASC
            LIMIT :limit
            """,
            {"limit": limit},
        )
    )


def write_task(
    conn: sqlite3.Connection,
    capture: sqlite3.Row,
    *,
    dry_run: bool,
) -> str:
    existing = conn.execute(
        """
        SELECT id
        FROM tasks
        WHERE source_capture_id = ? AND deleted_at IS NULL
        LIMIT 1
        """,
        (capture["id"],),
    ).fetchone()
    if existing:
        return str(existing["id"])

    task_id = _new_id()
    raw_text = capture["raw_text"] or ""
    if dry_run:
        return task_id

    conn.execute(
        """
        INSERT INTO tasks (
          id, source_capture_id, title, details, status, priority, source, sensitivity, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'todo', ?, 'extracted', ?, datetime('now'), datetime('now'))
        """,
        (
            task_id,
            capture["id"],
            task_title(raw_text),
            raw_text,
            extract_priority(raw_text),
            capture["sensitivity"],
        ),
    )
    return task_id


def write_note(
    conn: sqlite3.Connection,
    capture: sqlite3.Row,
    *,
    dry_run: bool,
) -> str:
    existing = conn.execute(
        """
        SELECT id
        FROM notes
        WHERE source_capture_id = ? AND deleted_at IS NULL
        LIMIT 1
        """,
        (capture["id"],),
    ).fetchone()
    if existing:
        return str(existing["id"])

    note_id = _new_id()
    raw_text = capture["raw_text"] or ""
    input_type = capture["input_type"] or "note"
    occurred_at = capture["occurred_at"] or capture["created_at"]
    ntype = detect_note_type(input_type, raw_text)
    source_url = extract_url(raw_text)
    summary = clamp(raw_text, 160)
    if source_url:
        summary = clamp(re.sub(URL_RE, "", raw_text).strip() or raw_text, 160)
    mood_score = extract_score(MOOD_RE, raw_text) if ntype == "journal" else None
    energy_score = extract_score(ENERGY_RE, raw_text) if ntype == "journal" else None
    journal_date = occurred_at[:10] if (ntype == "journal" and occurred_at) else None

    if dry_run:
        return note_id

    conn.execute(
        """
        INSERT INTO notes (
          id, source_capture_id, note_type, title, summary, body, occurred_at, journal_date,
          mood_score, energy_score, source_url, source_id, sensitivity, review_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
        """,
        (
            note_id,
            capture["id"],
            ntype,
            note_title(raw_text, fallback=f"{ntype} note"),
            summary,
            raw_text,
            occurred_at,
            journal_date,
            mood_score,
            energy_score,
            source_url if ntype == "learning" else None,
            capture["source_id"],
            capture["sensitivity"],
        ),
    )
    return note_id


def mark_capture_processed(
    conn: sqlite3.Connection,
    capture_id: str,
    *,
    parsed_note_id: str | None = None,
    parsed_task_id: str | None = None,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    conn.execute(
        """
        UPDATE captures_raw
        SET status = 'processed',
            parsed_note_id = ?,
            parsed_task_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
        """,
        (parsed_note_id, parsed_task_id, capture_id),
    )


def mark_capture_blocked(
    conn: sqlite3.Connection,
    capture_id: str,
    *,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    conn.execute(
        """
        UPDATE captures_raw
        SET status = 'blocked', updated_at = datetime('now')
        WHERE id = ?
        """,
        (capture_id,),
    )


def process_one(conn: sqlite3.Connection, capture: sqlite3.Row, dry_run: bool) -> tuple[str, str]:
    capture_id = capture["id"]
    status = capture["status"]
    pii_score = float(capture["pii_score"] or 0)
    input_type = capture["input_type"] or "note"
    raw_text = capture["raw_text"] or ""

    if status in {"blocked", "processed", "archived"}:
        return ("skipped", capture_id)
    if pii_score >= 0.9:
        mark_capture_blocked(conn, capture_id, dry_run=dry_run)
        return ("blocked", capture_id)

    if detect_task_like(input_type, raw_text):
        task_id = write_task(conn, capture, dry_run=dry_run)
        mark_capture_processed(conn, capture_id, parsed_task_id=task_id, dry_run=dry_run)
        return ("task", task_id)

    note_id = write_note(conn, capture, dry_run=dry_run)
    mark_capture_processed(conn, capture_id, parsed_note_id=note_id, dry_run=dry_run)
    return ("note", note_id)


def run(args: argparse.Namespace) -> int:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    created_notes = 0
    created_tasks = 0
    blocked = 0
    skipped = 0
    errors = 0

    try:
        captures = fetch_captures(conn, capture_id=args.capture_id, limit=args.limit)
        for capture in captures:
            try:
                kind, _ = process_one(conn, capture, dry_run=args.dry_run)
            except Exception:
                errors += 1
                continue
            if kind == "note":
                created_notes += 1
            elif kind == "task":
                created_tasks += 1
            elif kind == "blocked":
                blocked += 1
            else:
                skipped += 1

        if not args.dry_run:
            conn.commit()
    finally:
        conn.close()

    result_payload = {
        "processor": SOURCE_KIND,
        "contract_version": CONTRACT_VERSION,
        "captures_processed": created_notes + created_tasks + blocked,
        "notes_created": created_notes,
        "tasks_created": created_tasks,
        "captures_blocked": blocked,
        "captures_skipped": skipped,
        "errors": errors,
        "dry_run": args.dry_run,
    }
    validate_contract(worker_schema_path("process_captures"), result_payload)
    print(json.dumps(result_payload, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Process captures_raw into notes/tasks.")
    parser.add_argument("--db", required=True, help="SQLite database path")
    parser.add_argument("--capture-id", help="Process one capture by ID")
    parser.add_argument("--limit", type=int, default=200, help="Max new captures to process")
    parser.add_argument("--dry-run", action="store_true", help="Do not write DB")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
