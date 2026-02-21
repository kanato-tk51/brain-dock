#!/usr/bin/env python3
"""
Extract structured key_facts from notes/tasks.

Usage:
  python3 apps/worker/extract_key_facts.py --db /path/to/brain_dock.db
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


EXTRACTOR_VERSION = "rules-v1"
DEFAULT_MIN_CONFIDENCE = 0.70
DEFAULT_MAX_FACTS_PER_ITEM = 12

SUPPORTED_OBJECT_TYPES = {"text", "number", "date", "bool", "json"}

PREDICATE_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(学ん|学び|learned?|気づ|わかった|理解|insight)", re.IGNORECASE), "learned"),
    (re.compile(r"(決め|決定|decid|choose|選ん)", re.IGNORECASE), "decided"),
    (re.compile(r"(課題|問題|詰ま|blocked|障害|困|難し)", re.IGNORECASE), "blocked_by"),
    (re.compile(r"(改善|improve|良くな|効率化|optimi)", re.IGNORECASE), "improved"),
    (re.compile(r"(次|next|todo|やる|やりたい|will)", re.IGNORECASE), "next_action"),
    (re.compile(r"(試し|試した|検証|experiment|test)", re.IGNORECASE), "tested"),
    (re.compile(r"(感じ|feel|疲|つら|嬉|楽しい|不安)", re.IGNORECASE), "felt"),
]

BULLET_RE = re.compile(r"^\s*(?:[-*・]|[0-9]+[.)])\s+")


@dataclass(frozen=True)
class Fact:
    subject: str
    predicate: str
    object_text: str
    object_type: str = "text"
    object_json: str | None = None
    evidence_excerpt: str | None = None
    occurred_at: str | None = None
    confidence: float = 0.8

    def key(self) -> tuple[str, str, str]:
        return (self.subject.strip(), self.predicate.strip(), self.object_text.strip())

    def to_record(self) -> dict[str, Any]:
        return {
            "subject": self.subject.strip(),
            "predicate": self.predicate.strip(),
            "object_text": self.object_text.strip(),
            "object_type": self.object_type.strip(),
            "object_json": self.object_json,
            "evidence_excerpt": self.evidence_excerpt,
            "occurred_at": self.occurred_at,
            "confidence": self.confidence,
        }


def _new_id() -> str:
    # uuid7 is available in recent Python; fallback keeps portability.
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())  # type: ignore[attr-defined]
    return str(uuid.uuid4())


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"[。.!?！？\n]+", text)
    out: list[str] = []
    for part in parts:
        cleaned = re.sub(r"\s+", " ", part).strip()
        if 8 <= len(cleaned) <= 240:
            out.append(cleaned)
    return out


def detect_predicate(sentence: str) -> tuple[str, float]:
    for pattern, predicate in PREDICATE_HINTS:
        if pattern.search(sentence):
            return predicate, 0.82
    return "mentions", 0.72


def clamp_text(value: str, max_len: int) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip()
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rstrip() + "..."


def make_meta_fact(
    *,
    subject: str,
    predicate: str,
    object_text: str,
    object_type: str = "text",
    confidence: float = 0.95,
    occurred_at: str | None = None,
    object_json: str | None = None,
) -> Fact:
    return Fact(
        subject=subject,
        predicate=predicate,
        object_text=clamp_text(object_text, 1000),
        object_type=object_type,
        object_json=object_json,
        confidence=confidence,
        occurred_at=occurred_at,
    )


def extract_from_note(row: sqlite3.Row, max_facts: int) -> list[Fact]:
    note_id = row["id"]
    note_type = row["note_type"]
    occurred_at = row["occurred_at"]
    source_url = row["source_url"]
    title = row["title"] or ""
    summary = row["summary"] or ""
    body = row["body"] or ""
    mood_score = row["mood_score"]
    energy_score = row["energy_score"]
    journal_date = row["journal_date"]

    facts: list[Fact] = []
    subject = "me"

    if summary:
        facts.append(
            make_meta_fact(
                subject=f"note:{note_id}",
                predicate="summary",
                object_text=summary,
                confidence=0.90,
                occurred_at=occurred_at,
            )
        )
    if source_url:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="captured_source",
                object_text=source_url,
                confidence=0.96,
                occurred_at=occurred_at,
            )
        )
    if note_type == "journal" and journal_date:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="journal_date",
                object_text=journal_date,
                object_type="date",
                confidence=0.97,
                occurred_at=occurred_at,
            )
        )
    if mood_score is not None:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="mood_score",
                object_text=str(mood_score),
                object_type="number",
                object_json=json.dumps({"value": mood_score}, ensure_ascii=False),
                confidence=0.97,
                occurred_at=occurred_at,
            )
        )
    if energy_score is not None:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="energy_score",
                object_text=str(energy_score),
                object_type="number",
                object_json=json.dumps({"value": energy_score}, ensure_ascii=False),
                confidence=0.97,
                occurred_at=occurred_at,
            )
        )

    text = "\n".join([title, summary, body]).strip()
    sentences = split_sentences(text)
    for sentence in sentences:
        predicate, confidence = detect_predicate(sentence)
        facts.append(
            Fact(
                subject=subject,
                predicate=predicate,
                object_text=clamp_text(sentence, 1000),
                evidence_excerpt=clamp_text(sentence, 350),
                occurred_at=occurred_at,
                confidence=confidence,
            )
        )
        if len(facts) >= max_facts:
            break

    return dedupe_facts(facts, max_facts=max_facts)


def extract_from_task(row: sqlite3.Row, max_facts: int) -> list[Fact]:
    task_id = row["id"]
    title = row["title"] or ""
    details = row["details"] or ""
    status = row["status"]
    priority = row["priority"]
    due_at = row["due_at"]
    scheduled_at = row["scheduled_at"]
    done_at = row["done_at"]
    source_note_id = row["source_note_id"]

    subject = f"task:{task_id}"
    facts: list[Fact] = [
        make_meta_fact(subject=subject, predicate="status", object_text=status, confidence=0.98),
        make_meta_fact(
            subject=subject,
            predicate="priority",
            object_text=str(priority),
            object_type="number",
            object_json=json.dumps({"value": priority}, ensure_ascii=False),
            confidence=0.98,
        ),
    ]

    if due_at:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="due_at",
                object_text=due_at,
                object_type="date",
                confidence=0.98,
                occurred_at=due_at,
            )
        )
    if scheduled_at:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="scheduled_at",
                object_text=scheduled_at,
                object_type="date",
                confidence=0.96,
                occurred_at=scheduled_at,
            )
        )
    if done_at:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="completed_at",
                object_text=done_at,
                object_type="date",
                confidence=0.99,
                occurred_at=done_at,
            )
        )
    if source_note_id:
        facts.append(
            make_meta_fact(
                subject=subject,
                predicate="derived_from_note",
                object_text=source_note_id,
                confidence=0.95,
            )
        )

    text = "\n".join([title, details]).strip()
    for sentence in split_sentences(text):
        predicate, confidence = detect_predicate(sentence)
        if BULLET_RE.match(sentence) or predicate == "next_action":
            predicate = "next_action"
            confidence = max(confidence, 0.84)
        facts.append(
            Fact(
                subject=subject,
                predicate=predicate,
                object_text=clamp_text(sentence, 1000),
                evidence_excerpt=clamp_text(sentence, 350),
                confidence=confidence,
            )
        )
        if len(facts) >= max_facts:
            break

    return dedupe_facts(facts, max_facts=max_facts)


def dedupe_facts(facts: Iterable[Fact], max_facts: int) -> list[Fact]:
    seen: set[tuple[str, str, str]] = set()
    out: list[Fact] = []
    for fact in facts:
        key = fact.key()
        if not key[0] or not key[1] or not key[2]:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(fact)
        if len(out) >= max_facts:
            break
    return out


def validate_fact_schema(fact: Fact) -> tuple[bool, str | None]:
    if fact.object_type not in SUPPORTED_OBJECT_TYPES:
        return False, f"unsupported object_type: {fact.object_type}"
    if not (0.0 <= fact.confidence <= 1.0):
        return False, f"confidence out of range: {fact.confidence}"
    if not fact.subject.strip():
        return False, "subject is empty"
    if not fact.predicate.strip():
        return False, "predicate is empty"
    if not fact.object_text.strip():
        return False, "object_text is empty"
    if len(fact.subject) > 120:
        return False, "subject too long"
    if len(fact.predicate) > 80:
        return False, "predicate too long"
    if len(fact.object_text) > 1000:
        return False, "object_text too long"
    if fact.evidence_excerpt and len(fact.evidence_excerpt) > 500:
        return False, "evidence_excerpt too long"
    return True, None


def fetch_notes(
    conn: sqlite3.Connection,
    *,
    note_id: str | None,
    limit: int,
    only_changed: bool,
) -> list[sqlite3.Row]:
    if note_id:
        query = """
        SELECT *
        FROM notes
        WHERE id = :note_id AND deleted_at IS NULL
        """
        return list(conn.execute(query, {"note_id": note_id}))

    if not only_changed:
        query = """
        SELECT *
        FROM notes
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT :limit
        """
        return list(conn.execute(query, {"limit": limit}))

    query = """
    SELECT n.*
    FROM notes n
    WHERE n.deleted_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM key_facts k
          WHERE k.note_id = n.id AND k.deleted_at IS NULL
        )
        OR n.updated_at > COALESCE(
          (SELECT MAX(k.updated_at) FROM key_facts k WHERE k.note_id = n.id),
          '1970-01-01'
        )
      )
    ORDER BY n.updated_at DESC
    LIMIT :limit
    """
    return list(conn.execute(query, {"limit": limit}))


def fetch_tasks(
    conn: sqlite3.Connection,
    *,
    task_id: str | None,
    limit: int,
    only_changed: bool,
) -> list[sqlite3.Row]:
    if task_id:
        query = """
        SELECT *
        FROM tasks
        WHERE id = :task_id AND deleted_at IS NULL
        """
        return list(conn.execute(query, {"task_id": task_id}))

    if not only_changed:
        query = """
        SELECT *
        FROM tasks
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT :limit
        """
        return list(conn.execute(query, {"limit": limit}))

    query = """
    SELECT t.*
    FROM tasks t
    WHERE t.deleted_at IS NULL
      AND (
        NOT EXISTS (
          SELECT 1 FROM key_facts k
          WHERE k.task_id = t.id AND k.deleted_at IS NULL
        )
        OR t.updated_at > COALESCE(
          (SELECT MAX(k.updated_at) FROM key_facts k WHERE k.task_id = t.id),
          '1970-01-01'
        )
      )
    ORDER BY t.updated_at DESC
    LIMIT :limit
    """
    return list(conn.execute(query, {"limit": limit}))


def soft_delete_existing_facts(
    conn: sqlite3.Connection,
    *,
    note_id: str | None = None,
    task_id: str | None = None,
) -> int:
    if bool(note_id) == bool(task_id):
        raise ValueError("exactly one of note_id or task_id must be set")

    if note_id:
        res = conn.execute(
            """
            UPDATE key_facts
            SET deleted_at = datetime('now'), updated_at = datetime('now')
            WHERE note_id = ? AND deleted_at IS NULL
            """,
            (note_id,),
        )
        return res.rowcount

    res = conn.execute(
        """
        UPDATE key_facts
        SET deleted_at = datetime('now'), updated_at = datetime('now')
        WHERE task_id = ? AND deleted_at IS NULL
        """,
        (task_id,),
    )
    return res.rowcount


def insert_facts(
    conn: sqlite3.Connection,
    *,
    note_id: str | None = None,
    task_id: str | None = None,
    facts: list[Fact],
    min_confidence: float,
    dry_run: bool,
) -> tuple[int, int]:
    inserted = 0
    skipped = 0

    for fact in facts:
        ok, reason = validate_fact_schema(fact)
        if not ok:
            skipped += 1
            continue
        if fact.confidence < min_confidence:
            skipped += 1
            continue

        if dry_run:
            inserted += 1
            continue

        conn.execute(
            """
            INSERT INTO key_facts (
              id, note_id, task_id,
              subject, predicate, object_text, object_type,
              object_json, evidence_excerpt, occurred_at,
              confidence, sensitivity, extractor_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _new_id(),
                note_id,
                task_id,
                fact.subject,
                fact.predicate,
                fact.object_text,
                fact.object_type,
                fact.object_json,
                fact.evidence_excerpt,
                fact.occurred_at,
                fact.confidence,
                "internal",
                EXTRACTOR_VERSION,
            ),
        )
        inserted += 1

    return inserted, skipped


def resolve_schema_path(schema_arg: str) -> Path:
    schema_path = Path(schema_arg)
    if schema_path.exists():
        return schema_path

    repo_root = Path(__file__).resolve().parents[2]
    candidate = repo_root / schema_arg
    if candidate.exists():
        return candidate

    raise FileNotFoundError(
        f"schema file not found: {schema_arg}. expected schemas/json/key_facts.schema.json"
    )


def ensure_schema_file_exists(path: Path) -> None:
    # The worker currently performs lightweight validation in Python.
    # We still ensure the schema file exists as contract documentation.
    with path.open("r", encoding="utf-8") as f:
        json.load(f)


def run(args: argparse.Namespace) -> int:
    ensure_schema_file_exists(resolve_schema_path(args.schema))
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    total_items = 0
    total_inserted = 0
    total_skipped = 0
    total_replaced = 0

    try:
        if args.source in {"all", "notes"}:
            notes = fetch_notes(
                conn,
                note_id=args.note_id,
                limit=args.limit,
                only_changed=not args.all_rows,
            )
            for note in notes:
                total_items += 1
                facts = extract_from_note(note, max_facts=args.max_facts_per_item)
                if args.replace_existing and not args.dry_run:
                    total_replaced += soft_delete_existing_facts(conn, note_id=note["id"])
                ins, skp = insert_facts(
                    conn,
                    note_id=note["id"],
                    facts=facts,
                    min_confidence=args.min_confidence,
                    dry_run=args.dry_run,
                )
                total_inserted += ins
                total_skipped += skp

        if args.source in {"all", "tasks"}:
            tasks = fetch_tasks(
                conn,
                task_id=args.task_id,
                limit=args.limit,
                only_changed=not args.all_rows,
            )
            for task in tasks:
                total_items += 1
                facts = extract_from_task(task, max_facts=args.max_facts_per_item)
                if args.replace_existing and not args.dry_run:
                    total_replaced += soft_delete_existing_facts(conn, task_id=task["id"])
                ins, skp = insert_facts(
                    conn,
                    task_id=task["id"],
                    facts=facts,
                    min_confidence=args.min_confidence,
                    dry_run=args.dry_run,
                )
                total_inserted += ins
                total_skipped += skp

        if not args.dry_run:
            conn.commit()

    finally:
        conn.close()

    print(
        json.dumps(
            {
                "source": args.source,
                "items_processed": total_items,
                "facts_inserted": total_inserted,
                "facts_skipped": total_skipped,
                "facts_replaced": total_replaced,
                "dry_run": args.dry_run,
                "extractor_version": EXTRACTOR_VERSION,
            },
            ensure_ascii=False,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract key_facts from notes/tasks into key_facts table."
    )
    parser.add_argument("--db", required=True, help="SQLite database path")
    parser.add_argument(
        "--source",
        choices=["all", "notes", "tasks"],
        default="all",
        help="Extraction source",
    )
    parser.add_argument("--note-id", help="Extract for one note ID")
    parser.add_argument("--task-id", help="Extract for one task ID")
    parser.add_argument(
        "--limit", type=int, default=200, help="Max rows per source when note/task ID is not set"
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=DEFAULT_MIN_CONFIDENCE,
        help="Minimum confidence to persist facts",
    )
    parser.add_argument(
        "--max-facts-per-item",
        type=int,
        default=DEFAULT_MAX_FACTS_PER_ITEM,
        help="Safety cap per note/task",
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="Soft-delete previous facts for each processed item before inserting new facts",
    )
    parser.add_argument(
        "--all-rows",
        action="store_true",
        help="Process all rows, not only changed rows",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run extraction without writing to DB",
    )
    parser.add_argument(
        "--schema",
        default="schemas/json/key_facts.schema.json",
        help="Schema file path (contract check)",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.note_id and args.source not in {"all", "notes"}:
        raise SystemExit("--note-id can be used only with --source all|notes")
    if args.task_id and args.source not in {"all", "tasks"}:
        raise SystemExit("--task-id can be used only with --source all|tasks")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
