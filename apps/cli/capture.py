#!/usr/bin/env python3
"""
Capture free-form input into captures_raw.

Usage:
  python3 apps/cli/capture.py --db /path/to/brain_dock.db "今日の学びメモ"
  echo "TODO: PRレビューする p1" | python3 apps/cli/capture.py --db /path/to/brain_dock.db --stdin
  NEON_DATABASE_URL=postgresql://... python3 apps/cli/capture.py --backend neon "ブラウザ経由メモ"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid


URL_RE = re.compile(r"https?://[^\s)>\"]+")
TASK_HINT_RE = re.compile(
    r"^\s*(?:\[[ xX]\]|\(\s\)|todo|task|やること|宿題|next)\b|(?:\bTODO\b|締切|期限|やる|対応する)",
    re.IGNORECASE,
)

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{12,}"
    ),
]
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\+?\d[\d\-\s()]{8,}\d")
POSTAL_RE = re.compile(r"\b\d{3}-\d{4}\b")

DEFAULT_NEON_DSN_ENV = "NEON_DATABASE_URL"
DEFAULT_NEON_CONNECT_TIMEOUT_S = 15


def _new_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())  # type: ignore[attr-defined]
    return str(uuid.uuid4())


def normalize_text(text: str) -> str:
    return text.strip()


def read_text(args: argparse.Namespace) -> str:
    chunks: list[str] = []
    cli_text = " ".join(args.text).strip()
    if cli_text:
        chunks.append(cli_text)
    if args.stdin:
        stdin_text = sys.stdin.read().strip()
        if stdin_text:
            chunks.append(stdin_text)

    text = normalize_text("\n".join(chunks))
    if not text:
        raise SystemExit("no capture text. pass text args or use --stdin")
    return text


def detect_input_type(raw_text: str, requested: str) -> str:
    if requested != "auto":
        return requested
    if URL_RE.search(raw_text):
        return "url"
    if TASK_HINT_RE.search(raw_text):
        return "task"
    return "note"


def estimate_pii_score(raw_text: str) -> float:
    score = 0.0

    for pattern in SECRET_PATTERNS:
        if pattern.search(raw_text):
            score = max(score, 0.95)

    if EMAIL_RE.search(raw_text):
        score = max(score, 0.55)
    if PHONE_RE.search(raw_text):
        score = max(score, 0.65)
    if POSTAL_RE.search(raw_text):
        score = max(score, 0.70)

    return min(score, 1.0)


def resolve_pii_score(raw_text: str, override: float | None) -> float:
    if override is None:
        return estimate_pii_score(raw_text)
    if override < 0 or override > 1:
        raise SystemExit("--pii-score must be within 0.0..1.0")
    return override


def resolve_source_id_sqlite(conn: sqlite3.Connection, args: argparse.Namespace) -> tuple[str, bool]:
    if args.source_id:
        existing = conn.execute(
            "SELECT id FROM sources WHERE id = ? LIMIT 1",
            (args.source_id,),
        ).fetchone()
        if existing:
            return str(existing["id"]), False

        if not args.dry_run:
            conn.execute(
                """
                INSERT INTO sources (id, kind, detail, created_at)
                VALUES (?, ?, ?, datetime('now'))
                """,
                (args.source_id, args.source_kind, args.source_detail),
            )
        return args.source_id, True

    existing = conn.execute(
        """
        SELECT id
        FROM sources
        WHERE kind = ? AND coalesce(detail, '') = ?
        ORDER BY created_at ASC
        LIMIT 1
        """,
        (args.source_kind, args.source_detail),
    ).fetchone()
    if existing:
        return str(existing["id"]), False

    source_id = _new_id()
    if not args.dry_run:
        conn.execute(
            """
            INSERT INTO sources (id, kind, detail, created_at)
            VALUES (?, ?, ?, datetime('now'))
            """,
            (source_id, args.source_kind, args.source_detail),
        )
    return source_id, True


def insert_capture_sqlite(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    input_type: str,
    raw_text: str,
    occurred_at: str | None,
    sensitivity: str,
    pii_score: float,
    dry_run: bool,
) -> str:
    capture_id = _new_id()
    if dry_run:
        return capture_id

    conn.execute(
        """
        INSERT INTO captures_raw (
          id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, coalesce(?, datetime('now')), ?, ?, 'new', datetime('now'), datetime('now'))
        """,
        (
            capture_id,
            source_id,
            input_type,
            raw_text,
            occurred_at,
            sensitivity,
            pii_score,
        ),
    )
    return capture_id


def _require_psycopg():
    try:
        import psycopg  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on local env
        raise SystemExit(
            "psycopg is not installed. install with: pip install 'psycopg[binary]'"
        ) from exc
    return psycopg


def open_neon_connection(dsn: str, connect_timeout_s: int):
    psycopg = _require_psycopg()
    try:
        return psycopg.connect(dsn, connect_timeout=connect_timeout_s)
    except Exception as exc:  # pragma: no cover - external infra
        raise SystemExit(f"failed to connect to Neon: {exc}") from exc


def resolve_source_id_neon(conn, args: argparse.Namespace) -> tuple[str, bool]:
    if args.source_id:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM sources WHERE id = %s LIMIT 1", (args.source_id,))
            row = cur.fetchone()
        if row:
            return args.source_id, False

        if not args.dry_run:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO sources (id, kind, detail, created_at)
                    VALUES (%s, %s, %s, now())
                    """,
                    (args.source_id, args.source_kind, args.source_detail),
                )
        return args.source_id, True

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id
            FROM sources
            WHERE kind = %s AND coalesce(detail, '') = %s
            ORDER BY created_at ASC
            LIMIT 1
            """,
            (args.source_kind, args.source_detail),
        )
        row = cur.fetchone()
    if row:
        return str(row[0]), False

    source_id = _new_id()
    if not args.dry_run:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sources (id, kind, detail, created_at)
                VALUES (%s, %s, %s, now())
                """,
                (source_id, args.source_kind, args.source_detail),
            )
    return source_id, True


def insert_capture_neon(
    conn,
    *,
    source_id: str,
    input_type: str,
    raw_text: str,
    occurred_at: str | None,
    sensitivity: str,
    pii_score: float,
    dry_run: bool,
) -> str:
    capture_id = _new_id()
    if dry_run:
        return capture_id

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO captures_raw (
              id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status, created_at, updated_at
            ) VALUES (%s, %s, %s, %s, coalesce(%s::timestamptz, now()), %s, %s, 'new', now(), now())
            """,
            (
                capture_id,
                source_id,
                input_type,
                raw_text,
                occurred_at,
                sensitivity,
                pii_score,
            ),
        )
    return capture_id


def run_sqlite(args: argparse.Namespace, raw_text: str, input_type: str, pii_score: float) -> tuple[str, str, bool]:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        source_id, source_created = resolve_source_id_sqlite(conn, args)
        capture_id = insert_capture_sqlite(
            conn,
            source_id=source_id,
            input_type=input_type,
            raw_text=raw_text,
            occurred_at=args.occurred_at,
            sensitivity=args.sensitivity,
            pii_score=pii_score,
            dry_run=args.dry_run,
        )

        if not args.dry_run:
            conn.commit()
    finally:
        conn.close()
    return capture_id, source_id, source_created


def resolve_neon_dsn(args: argparse.Namespace) -> str:
    if args.neon_dsn:
        return args.neon_dsn
    env_value = os.environ.get(args.neon_dsn_env)
    if env_value:
        return env_value
    raise SystemExit(
        f"--neon-dsn is required when --backend neon (or set env: {args.neon_dsn_env})"
    )


def run_neon(args: argparse.Namespace, raw_text: str, input_type: str, pii_score: float) -> tuple[str, str, bool]:
    dsn = resolve_neon_dsn(args)

    if args.dry_run:
        source_id = args.source_id if args.source_id else _new_id()
        source_created = args.source_id is None
        capture_id = _new_id()
        _ = dsn
        return capture_id, source_id, source_created

    conn = open_neon_connection(dsn, args.neon_connect_timeout)
    try:
        source_id, source_created = resolve_source_id_neon(conn, args)
        capture_id = insert_capture_neon(
            conn,
            source_id=source_id,
            input_type=input_type,
            raw_text=raw_text,
            occurred_at=args.occurred_at,
            sensitivity=args.sensitivity,
            pii_score=pii_score,
            dry_run=args.dry_run,
        )
        conn.commit()
    finally:
        conn.close()

    return capture_id, source_id, source_created


def run(args: argparse.Namespace) -> int:
    raw_text = read_text(args)
    input_type = detect_input_type(raw_text, args.input_type)
    pii_score = resolve_pii_score(raw_text, args.pii_score)

    if args.backend == "sqlite":
        capture_id, source_id, source_created = run_sqlite(args, raw_text, input_type, pii_score)
    elif args.backend == "neon":
        capture_id, source_id, source_created = run_neon(args, raw_text, input_type, pii_score)
    else:
        raise SystemExit(f"unsupported backend: {args.backend}")

    result_payload = {
        "backend": args.backend,
        "capture_id": capture_id,
        "source_id": source_id,
        "source_created": source_created,
        "input_type": input_type,
        "sensitivity": args.sensitivity,
        "pii_score": pii_score,
        "status": "new",
        "dry_run": args.dry_run,
        "text_length": len(raw_text),
    }
    print(json.dumps(result_payload, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Capture text into captures_raw.")
    parser.add_argument(
        "--backend",
        choices=["sqlite", "neon"],
        default="sqlite",
        help="Storage backend",
    )
    parser.add_argument("--db", help="SQLite database path (for --backend sqlite)")
    parser.add_argument("--neon-dsn", help="Neon PostgreSQL DSN (for --backend neon)")
    parser.add_argument(
        "--neon-dsn-env",
        default=DEFAULT_NEON_DSN_ENV,
        help="Environment variable name for Neon DSN",
    )
    parser.add_argument(
        "--neon-connect-timeout",
        type=int,
        default=DEFAULT_NEON_CONNECT_TIMEOUT_S,
        help="Neon connection timeout seconds",
    )
    parser.add_argument(
        "text",
        nargs="*",
        help="Capture text (use --stdin to read from standard input)",
    )
    parser.add_argument("--stdin", action="store_true", help="Read capture text from stdin")
    parser.add_argument(
        "--input-type",
        choices=["auto", "note", "task", "url", "quick"],
        default="auto",
        help="Capture input_type. auto infers from text.",
    )
    parser.add_argument("--source-id", help="Existing source ID (optional)")
    parser.add_argument("--source-kind", default="cli", help="Source kind (cli/mobile/browser/import)")
    parser.add_argument("--source-detail", default="capture-cli", help="Source detail label")
    parser.add_argument(
        "--sensitivity",
        choices=["public", "internal", "sensitive"],
        default="internal",
        help="Sensitivity level",
    )
    parser.add_argument("--occurred-at", help="Event timestamp text (optional)")
    parser.add_argument(
        "--pii-score",
        type=float,
        help="Override detected pii score (0.0..1.0)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Do not write DB")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.backend == "sqlite" and not args.db:
        parser.error("--db is required when --backend sqlite")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
