#!/usr/bin/env python3
"""
Capture free-form input into captures_raw.

Usage:
  python3 apps/cli/capture.py --db /path/to/brain_dock.db "今日の学びメモ"
  echo "TODO: PRレビューする p1" | python3 apps/cli/capture.py --db /path/to/brain_dock.db --stdin
  SUPABASE_SERVICE_ROLE_KEY=*** python3 apps/cli/capture.py --backend supabase --supabase-url https://<project>.supabase.co "ブラウザ経由メモ"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import uuid
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest


URL_RE = re.compile(r"https?://[^\s)>\"]+")
TASK_HINT_RE = re.compile(
    r"^\s*(?:\[[ xX]\]|\(\s\)|todo|task|やること|宿題|next)\b|(?:\bTODO\b|締切|期限|やる|対応する)",
    re.IGNORECASE,
)

SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),  # common API key shape
    re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{12,}"
    ),
]
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\+?\d[\d\-\s()]{8,}\d")
POSTAL_RE = re.compile(r"\b\d{3}-\d{4}\b")
DEFAULT_SUPABASE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"
DEFAULT_SUPABASE_TIMEOUT_S = 20


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


class SupabaseClient:
    def __init__(self, *, base_url: str, api_key: str, timeout_s: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    def _request_json(
        self,
        *,
        method: str,
        path: str,
        query: dict[str, str] | None = None,
        payload: dict | None = None,
        prefer: str | None = None,
    ) -> list[dict]:
        if not path.startswith("/"):
            raise ValueError("path must start with '/'")

        query_str = ""
        if query:
            query_str = "?" + urlparse.urlencode(query)
        url = f"{self.base_url}{path}{query_str}"

        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer

        req = urlrequest.Request(url, method=method, data=body, headers=headers)

        try:
            with urlrequest.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read().decode("utf-8")
        except urlerror.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Supabase API error {e.code}: {detail}") from e
        except urlerror.URLError as e:
            raise RuntimeError(f"Supabase URL error: {e}") from e

        if not raw.strip():
            return []
        data = json.loads(raw)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
        raise RuntimeError("unexpected Supabase response payload")

    def find_source_by_id(self, source_id: str) -> dict | None:
        rows = self._request_json(
            method="GET",
            path="/rest/v1/sources",
            query={
                "select": "id,kind,detail",
                "id": f"eq.{source_id}",
                "limit": "1",
            },
        )
        return rows[0] if rows else None

    def find_source_by_kind_detail(self, *, kind: str, detail: str) -> dict | None:
        rows = self._request_json(
            method="GET",
            path="/rest/v1/sources",
            query={
                "select": "id,kind,detail,created_at",
                "kind": f"eq.{kind}",
                "detail": f"eq.{detail}",
                "order": "created_at.asc",
                "limit": "1",
            },
        )
        return rows[0] if rows else None

    def upsert_source(self, *, source_id: str, kind: str, detail: str) -> None:
        self._request_json(
            method="POST",
            path="/rest/v1/sources",
            query={"on_conflict": "id"},
            payload={
                "id": source_id,
                "kind": kind,
                "detail": detail,
            },
            prefer="resolution=merge-duplicates,return=representation",
        )

    def insert_capture(
        self,
        *,
        capture_id: str,
        source_id: str,
        input_type: str,
        raw_text: str,
        occurred_at: str | None,
        sensitivity: str,
        pii_score: float,
    ) -> None:
        payload = {
            "id": capture_id,
            "source_id": source_id,
            "input_type": input_type,
            "raw_text": raw_text,
            "sensitivity": sensitivity,
            "pii_score": pii_score,
            "status": "new",
        }
        if occurred_at:
            payload["occurred_at"] = occurred_at

        self._request_json(
            method="POST",
            path="/rest/v1/captures_raw",
            payload=payload,
            prefer="return=representation",
        )


def resolve_source_id(conn: sqlite3.Connection, args: argparse.Namespace) -> tuple[str, bool]:
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


def resolve_source_id_supabase(
    client: SupabaseClient, args: argparse.Namespace
) -> tuple[str, bool]:
    if args.source_id:
        existing = client.find_source_by_id(args.source_id)
        if existing:
            return args.source_id, False
        if not args.dry_run:
            client.upsert_source(
                source_id=args.source_id,
                kind=args.source_kind,
                detail=args.source_detail,
            )
        return args.source_id, True

    existing = client.find_source_by_kind_detail(
        kind=args.source_kind,
        detail=args.source_detail,
    )
    if existing:
        return str(existing["id"]), False

    source_id = _new_id()
    if not args.dry_run:
        client.upsert_source(
            source_id=source_id,
            kind=args.source_kind,
            detail=args.source_detail,
        )
    return source_id, True


def insert_capture(
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


def insert_capture_supabase(
    client: SupabaseClient,
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

    client.insert_capture(
        capture_id=capture_id,
        source_id=source_id,
        input_type=input_type,
        raw_text=raw_text,
        occurred_at=occurred_at,
        sensitivity=sensitivity,
        pii_score=pii_score,
    )
    return capture_id


def run_sqlite(args: argparse.Namespace, raw_text: str, input_type: str, pii_score: float) -> tuple[str, str, bool]:
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        source_id, source_created = resolve_source_id(conn, args)
        capture_id = insert_capture(
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


def run_supabase(args: argparse.Namespace, raw_text: str, input_type: str, pii_score: float) -> tuple[str, str, bool]:
    if not args.supabase_url:
        raise SystemExit("--supabase-url is required when --backend supabase")

    api_key = os.environ.get(args.supabase_key_env)
    if not api_key:
        raise SystemExit(f"environment variable not set: {args.supabase_key_env}")

    client = SupabaseClient(
        base_url=args.supabase_url,
        api_key=api_key,
        timeout_s=args.supabase_timeout,
    )
    source_id, source_created = resolve_source_id_supabase(client, args)
    capture_id = insert_capture_supabase(
        client,
        source_id=source_id,
        input_type=input_type,
        raw_text=raw_text,
        occurred_at=args.occurred_at,
        sensitivity=args.sensitivity,
        pii_score=pii_score,
        dry_run=args.dry_run,
    )
    return capture_id, source_id, source_created


def run(args: argparse.Namespace) -> int:
    raw_text = read_text(args)
    input_type = detect_input_type(raw_text, args.input_type)
    pii_score = resolve_pii_score(raw_text, args.pii_score)

    if args.backend == "sqlite":
        capture_id, source_id, source_created = run_sqlite(args, raw_text, input_type, pii_score)
    elif args.backend == "supabase":
        capture_id, source_id, source_created = run_supabase(args, raw_text, input_type, pii_score)
    else:
        raise SystemExit(f"unsupported backend: {args.backend}")

    result_payload = {
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
        choices=["sqlite", "supabase"],
        default="sqlite",
        help="Storage backend",
    )
    parser.add_argument("--db", help="SQLite database path (for --backend sqlite)")
    parser.add_argument("--supabase-url", help="Supabase project URL (for --backend supabase)")
    parser.add_argument(
        "--supabase-key-env",
        default=DEFAULT_SUPABASE_KEY_ENV,
        help="Environment variable that stores Supabase API key",
    )
    parser.add_argument(
        "--supabase-timeout",
        type=int,
        default=DEFAULT_SUPABASE_TIMEOUT_S,
        help="Supabase HTTP timeout seconds",
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
