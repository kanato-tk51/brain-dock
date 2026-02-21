#!/usr/bin/env python3
"""
Extract structured key_facts from notes/tasks.

Usage:
  python3 apps/worker/extract_key_facts.py --db /path/to/brain_dock.db
  NEON_DATABASE_URL=postgresql://... python3 apps/worker/extract_key_facts.py --backend neon --source all
"""

from __future__ import annotations

import argparse
import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping
from urllib import error as urlerror
from urllib import request as urlrequest

from db_runtime import (
    DEFAULT_NEON_CONNECT_TIMEOUT_S,
    DEFAULT_NEON_DSN_ENV,
    epoch_expr,
    exec_write,
    fetch_all,
    is_sqlite_conn,
    open_connection,
    now_expr,
)
from japanese_nlp import MorphToken, tokenize_with_lemma
from json_contract import validate_contract, worker_schema_path
from rule_lexicon import OBJECT_STOP_LEMMAS, PREDICATE_LEMMA_HINTS


EXTRACTOR_VERSION_RULES = "rules-v1"
CONTRACT_VERSION = "1.0"
DEFAULT_MIN_CONFIDENCE = 0.70
DEFAULT_MAX_FACTS_PER_ITEM = 12
DEFAULT_LLM_MODEL = "gpt-4.1-mini"
DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
DEFAULT_LLM_TIMEOUT_S = 45
DEFAULT_LLM_MAX_INPUT_CHARS = 6000

SUPPORTED_OBJECT_TYPES = {"text", "number", "date", "bool", "json"}

PREDICATE_HINTS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"(学ん|学び|学習|learned?|気づ|わかった|理解|insight)", re.IGNORECASE),
        "learned",
    ),
    (re.compile(r"(決め|決定|decid|choose|選ん)", re.IGNORECASE), "decided"),
    (re.compile(r"(課題|問題|詰ま|blocked|障害|困|難し)", re.IGNORECASE), "blocked_by"),
    (re.compile(r"(改善|improve|良くな|効率化|最適|optimi)", re.IGNORECASE), "improved"),
    (re.compile(r"(次|next|todo|やる|やりたい|will|明日|次回|予定)", re.IGNORECASE), "next_action"),
    (re.compile(r"(試し|試した|試験|実験|実施|検証|experiment|test)", re.IGNORECASE), "tested"),
    (re.compile(r"(感じ|feel|疲|つら|嬉|楽しい|不安|安心|緊張|落ち込|モヤモヤ)", re.IGNORECASE), "felt"),
]

BULLET_RE = re.compile(r"^\s*(?:[-*・]|[0-9]+[.)])\s+")
DATE_CANDIDATE_RE = re.compile(r"(?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|今日|昨日|明日)")
NUMBER_CANDIDATE_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")

RowLike = Mapping[str, Any]


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
        if not (4 <= len(cleaned) <= 240):
            continue
        tokens = tokenize_with_lemma(cleaned)
        if tokens and len(tokens) <= 1 and len(cleaned) < 10:
            continue
        if len(cleaned) >= 4:
            out.append(cleaned)
    return out


def _norm_lemma(value: str) -> str:
    return value.strip().lower()


def _object_type_and_json(predicate: str, object_text: str) -> tuple[str, str | None]:
    if predicate in {"journal_date", "due_at", "scheduled_at", "completed_at"}:
        return "date", None
    if DATE_CANDIDATE_RE.search(object_text):
        return "date", None

    number_match = NUMBER_CANDIDATE_RE.search(object_text)
    if predicate in {"mood_score", "energy_score", "priority"} or (
        number_match and object_text.strip() == number_match.group(0)
    ):
        try:
            value = float(number_match.group(0)) if number_match else float(object_text)
            return "number", json.dumps({"value": value}, ensure_ascii=False)
        except Exception:
            return "number", None

    return "text", None


def _extract_object_text(sentence: str, predicate: str, tokens: list[MorphToken]) -> str:
    if not tokens:
        return clamp_text(sentence, 1000)

    hints = {_norm_lemma(v) for v in PREDICATE_LEMMA_HINTS.get(predicate, set())}
    predicate_idx = -1
    for idx, tok in enumerate(tokens):
        if _norm_lemma(tok.lemma) in hints:
            predicate_idx = idx
            break

    if predicate_idx >= 0:
        window = tokens[max(0, predicate_idx - 4) : min(len(tokens), predicate_idx + 5)]
    else:
        window = tokens

    object_parts: list[str] = []
    for tok in window:
        lemma = _norm_lemma(tok.lemma)
        if not lemma or lemma in OBJECT_STOP_LEMMAS:
            continue
        if tok.pos.startswith("名詞") or tok.pos.startswith("形容詞") or tok.pos.startswith("動詞"):
            object_parts.append(tok.surface)

    if not object_parts:
        for tok in tokens:
            lemma = _norm_lemma(tok.lemma)
            if tok.pos.startswith("名詞") and lemma not in OBJECT_STOP_LEMMAS:
                object_parts.append(tok.surface)

    object_text = "".join(object_parts).strip()
    if len(object_text) < 2:
        object_text = sentence
    return clamp_text(object_text, 1000)


def detect_predicate(sentence: str, *, tokens: list[MorphToken] | None = None) -> tuple[str, float]:
    for pattern, predicate in PREDICATE_HINTS:
        if pattern.search(sentence):
            return predicate, 0.82

    token_list = tokens if tokens is not None else tokenize_with_lemma(sentence)
    lemma_set = {_norm_lemma(tok.lemma) for tok in token_list if _norm_lemma(tok.lemma)}
    for predicate, hints in PREDICATE_LEMMA_HINTS.items():
        if lemma_set.intersection({_norm_lemma(v) for v in hints}):
            return predicate, 0.79
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


def extract_from_note_rules(row: RowLike, max_facts: int) -> list[Fact]:
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
        tokens = tokenize_with_lemma(sentence)
        predicate, confidence = detect_predicate(sentence, tokens=tokens)
        object_text = _extract_object_text(sentence, predicate, tokens)
        object_type, object_json = _object_type_and_json(predicate, object_text)
        facts.append(
            Fact(
                subject=subject,
                predicate=predicate,
                object_text=object_text,
                object_type=object_type,
                object_json=object_json,
                evidence_excerpt=clamp_text(sentence, 350),
                occurred_at=occurred_at,
                confidence=confidence,
            )
        )
        if len(facts) >= max_facts:
            break

    return dedupe_facts(facts, max_facts=max_facts)


def extract_from_task_rules(row: RowLike, max_facts: int) -> list[Fact]:
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
        tokens = tokenize_with_lemma(sentence)
        predicate, confidence = detect_predicate(sentence, tokens=tokens)
        if BULLET_RE.match(sentence) or predicate == "next_action":
            predicate = "next_action"
            confidence = max(confidence, 0.84)
        object_text = _extract_object_text(sentence, predicate, tokens)
        object_type, object_json = _object_type_and_json(predicate, object_text)
        facts.append(
            Fact(
                subject=subject,
                predicate=predicate,
                object_text=object_text,
                object_type=object_type,
                object_json=object_json,
                evidence_excerpt=clamp_text(sentence, 350),
                confidence=confidence,
            )
        )
        if len(facts) >= max_facts:
            break

    return dedupe_facts(facts, max_facts=max_facts)


def dedupe_facts(facts: Iterable[Fact], max_facts: int) -> list[Fact]:
    seen_exact: set[tuple[str, str, str]] = set()
    seen_normalized: set[tuple[str, str, str]] = set()
    out: list[Fact] = []
    for fact in facts:
        key = fact.key()
        if not key[0] or not key[1] or not key[2]:
            continue

        normalized_object = _normalize_for_dedupe(fact.object_text)
        normalized_key = (
            _norm_lemma(fact.subject),
            _norm_lemma(fact.predicate),
            normalized_object,
        )

        if key in seen_exact or normalized_key in seen_normalized:
            continue
        seen_exact.add(key)
        seen_normalized.add(normalized_key)
        out.append(fact)
        if len(out) >= max_facts:
            break
    return out


def _normalize_for_dedupe(text: str) -> str:
    tokens = tokenize_with_lemma(text)
    if tokens:
        lemmas = [
            _norm_lemma(tok.lemma)
            for tok in tokens
            if _norm_lemma(tok.lemma) and _norm_lemma(tok.lemma) not in OBJECT_STOP_LEMMAS
        ]
        if lemmas:
            return " ".join(lemmas[:16])
    cleaned = re.sub(r"\s+", "", text).lower()
    cleaned = re.sub(r"[^0-9a-zぁ-んァ-ヶ一-龠ー]", "", cleaned)
    return cleaned


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
    conn: Any,
    *,
    note_id: str | None,
    limit: int,
    only_changed: bool,
) -> list[RowLike]:
    if note_id:
        query = """
        SELECT *
        FROM notes
        WHERE id = %s AND deleted_at IS NULL
        """
        return fetch_all(conn, query, (note_id,))

    if not only_changed:
        query = """
        SELECT *
        FROM notes
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT %s
        """
        return fetch_all(conn, query, (limit,))

    epoch = epoch_expr(conn)
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
          {epoch}
        )
      )
    ORDER BY n.updated_at DESC
    LIMIT %s
    """
    return fetch_all(conn, query.format(epoch=epoch), (limit,))


def fetch_tasks(
    conn: Any,
    *,
    task_id: str | None,
    limit: int,
    only_changed: bool,
) -> list[RowLike]:
    if task_id:
        query = """
        SELECT *
        FROM tasks
        WHERE id = %s AND deleted_at IS NULL
        """
        return fetch_all(conn, query, (task_id,))

    if not only_changed:
        query = """
        SELECT *
        FROM tasks
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT %s
        """
        return fetch_all(conn, query, (limit,))

    epoch = epoch_expr(conn)
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
          {epoch}
        )
      )
    ORDER BY t.updated_at DESC
    LIMIT %s
    """
    return fetch_all(conn, query.format(epoch=epoch), (limit,))


def soft_delete_existing_facts(
    conn: Any,
    *,
    note_id: str | None = None,
    task_id: str | None = None,
) -> int:
    if bool(note_id) == bool(task_id):
        raise ValueError("exactly one of note_id or task_id must be set")

    now = now_expr(conn)
    if note_id:
        return exec_write(
            conn,
            f"""
            UPDATE key_facts
            SET deleted_at = {now}, updated_at = {now}
            WHERE note_id = %s AND deleted_at IS NULL
            """,
            (note_id,),
        )

    return exec_write(
        conn,
        f"""
        UPDATE key_facts
        SET deleted_at = {now}, updated_at = {now}
        WHERE task_id = %s AND deleted_at IS NULL
        """,
        (task_id,),
    )


def insert_facts(
    conn: Any,
    *,
    note_id: str | None = None,
    task_id: str | None = None,
    facts: list[Fact],
    min_confidence: float,
    dry_run: bool,
    extractor_version: str,
) -> tuple[int, int]:
    inserted = 0
    skipped = 0

    for fact in facts:
        ok, _ = validate_fact_schema(fact)
        if not ok:
            skipped += 1
            continue
        if fact.confidence < min_confidence:
            skipped += 1
            continue

        if dry_run:
            inserted += 1
            continue

        insert_sql = """
            INSERT INTO key_facts (
              id, note_id, task_id,
              subject, predicate, object_text, object_type,
              object_json, evidence_excerpt, occurred_at,
              confidence, sensitivity, extractor_version
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        if is_sqlite_conn(conn):
            insert_sql = insert_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
        else:
            insert_sql += " ON CONFLICT DO NOTHING"

        rowcount = exec_write(
            conn,
            insert_sql,
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
                extractor_version,
            ),
        )
        if rowcount == 1:
            inserted += 1
        else:
            skipped += 1

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


def load_schema(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("schema must be a JSON object")
    return data


def note_prompt_payload(row: RowLike, max_chars: int) -> dict[str, Any]:
    return {
        "item_type": "note",
        "id": row["id"],
        "note_type": row["note_type"],
        "title": clamp_text((row["title"] or ""), 300),
        "summary": clamp_text((row["summary"] or ""), 500),
        "body": clamp_text((row["body"] or ""), max_chars),
        "occurred_at": row["occurred_at"],
        "journal_date": row["journal_date"],
        "mood_score": row["mood_score"],
        "energy_score": row["energy_score"],
        "source_url": row["source_url"],
    }


def task_prompt_payload(row: RowLike, max_chars: int) -> dict[str, Any]:
    return {
        "item_type": "task",
        "id": row["id"],
        "title": clamp_text((row["title"] or ""), 300),
        "details": clamp_text((row["details"] or ""), max_chars),
        "status": row["status"],
        "priority": row["priority"],
        "due_at": row["due_at"],
        "scheduled_at": row["scheduled_at"],
        "done_at": row["done_at"],
        "source_note_id": row["source_note_id"],
    }


def _parse_facts_payload(payload: Any, max_facts: int) -> list[Fact]:
    if isinstance(payload, dict):
        raw_items = payload.get("facts", [])
    else:
        raw_items = payload

    if not isinstance(raw_items, list):
        raise ValueError("LLM response facts must be a list")

    facts: list[Fact] = []
    for item in raw_items[:max_facts]:
        if not isinstance(item, dict):
            continue
        subject = str(item.get("subject", "")).strip()
        predicate = str(item.get("predicate", "")).strip()
        object_text = str(item.get("object_text", "")).strip()
        object_type = str(item.get("object_type", "text")).strip() or "text"
        evidence_excerpt = item.get("evidence_excerpt")
        occurred_at = item.get("occurred_at")
        object_json = item.get("object_json")
        confidence_raw = item.get("confidence", 0.8)

        try:
            confidence = float(confidence_raw)
        except (TypeError, ValueError):
            confidence = 0.0

        fact = Fact(
            subject=clamp_text(subject, 120),
            predicate=clamp_text(predicate, 80),
            object_text=clamp_text(object_text, 1000),
            object_type=object_type,
            object_json=(str(object_json) if object_json is not None else None),
            evidence_excerpt=(
                clamp_text(str(evidence_excerpt), 500)
                if evidence_excerpt is not None and str(evidence_excerpt).strip()
                else None
            ),
            occurred_at=(str(occurred_at) if occurred_at is not None else None),
            confidence=confidence,
        )
        facts.append(fact)

    return dedupe_facts(facts, max_facts=max_facts)


def _extract_json_text_from_chat_response(data: dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("LLM response missing choices")

    message = choices[0].get("message", {})
    content = message.get("content")

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        pieces: list[str] = []
        for part in content:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str):
                    pieces.append(text)
        joined = "".join(pieces).strip()
        if joined:
            return joined

    raise ValueError("LLM response content is not a JSON string")


def extract_with_llm(
    *,
    item_payload: dict[str, Any],
    schema_array: dict[str, Any],
    api_key: str,
    model: str,
    base_url: str,
    timeout_s: int,
    max_facts: int,
) -> list[Fact]:
    wrapper_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["facts"],
        "properties": {
            "facts": schema_array,
        },
    }

    system_prompt = (
        "You extract compact factual memories from personal notes/tasks. "
        "Return only factual claims that are explicitly supported by the input. "
        "No speculation. Keep predicates short and reusable."
    )

    user_prompt = (
        "Extract key facts from this item. "
        "Use subject/predicate/object_text. "
        "Set confidence between 0 and 1.\n\n"
        f"ITEM:\n{json.dumps(item_payload, ensure_ascii=False)}"
    )

    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "key_facts_output",
                "strict": True,
                "schema": wrapper_schema,
            },
        },
    }

    url = base_url.rstrip("/") + "/chat/completions"
    req = urlrequest.Request(
        url,
        method="POST",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urlrequest.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8")
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM HTTPError: {e.code} {detail}") from e
    except urlerror.URLError as e:
        raise RuntimeError(f"LLM URLError: {e}") from e

    data = json.loads(body)
    json_text = _extract_json_text_from_chat_response(data)
    structured_payload = json.loads(json_text)
    return _parse_facts_payload(structured_payload, max_facts=max_facts)


def extract_facts_for_note(
    row: RowLike,
    *,
    extractor: Literal["rules", "llm"],
    args: argparse.Namespace,
    schema_array: dict[str, Any],
) -> list[Fact]:
    if extractor == "rules":
        return extract_from_note_rules(row, max_facts=args.max_facts_per_item)

    api_key = os.environ.get(args.llm_api_key_env)
    if not api_key:
        raise RuntimeError(f"environment variable not set: {args.llm_api_key_env}")

    payload = note_prompt_payload(row, max_chars=args.llm_max_input_chars)
    return extract_with_llm(
        item_payload=payload,
        schema_array=schema_array,
        api_key=api_key,
        model=args.llm_model,
        base_url=args.llm_base_url,
        timeout_s=args.llm_timeout,
        max_facts=args.max_facts_per_item,
    )


def extract_facts_for_task(
    row: RowLike,
    *,
    extractor: Literal["rules", "llm"],
    args: argparse.Namespace,
    schema_array: dict[str, Any],
) -> list[Fact]:
    if extractor == "rules":
        return extract_from_task_rules(row, max_facts=args.max_facts_per_item)

    api_key = os.environ.get(args.llm_api_key_env)
    if not api_key:
        raise RuntimeError(f"environment variable not set: {args.llm_api_key_env}")

    payload = task_prompt_payload(row, max_chars=args.llm_max_input_chars)
    return extract_with_llm(
        item_payload=payload,
        schema_array=schema_array,
        api_key=api_key,
        model=args.llm_model,
        base_url=args.llm_base_url,
        timeout_s=args.llm_timeout,
        max_facts=args.max_facts_per_item,
    )


def run(args: argparse.Namespace) -> int:
    schema = load_schema(resolve_schema_path(args.schema))
    if schema.get("type") != "array":
        raise ValueError("key_facts schema root must be array")

    extractor: Literal["rules", "llm"] = args.extractor
    extractor_version = (
        EXTRACTOR_VERSION_RULES if extractor == "rules" else f"llm-{args.llm_model}"
    )

    conn = open_connection(
        backend=args.backend,
        db=args.db,
        neon_dsn=args.neon_dsn,
        neon_dsn_env=args.neon_dsn_env,
        neon_connect_timeout=args.neon_connect_timeout,
    )

    total_items = 0
    total_inserted = 0
    total_skipped = 0
    total_replaced = 0
    errors = 0

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
                try:
                    facts = extract_facts_for_note(
                        note,
                        extractor=extractor,
                        args=args,
                        schema_array=schema,
                    )
                except Exception:
                    errors += 1
                    continue
                if args.replace_existing and not args.dry_run:
                    total_replaced += soft_delete_existing_facts(conn, note_id=note["id"])
                ins, skp = insert_facts(
                    conn,
                    note_id=note["id"],
                    facts=facts,
                    min_confidence=args.min_confidence,
                    dry_run=args.dry_run,
                    extractor_version=extractor_version,
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
                try:
                    facts = extract_facts_for_task(
                        task,
                        extractor=extractor,
                        args=args,
                        schema_array=schema,
                    )
                except Exception:
                    errors += 1
                    continue
                if args.replace_existing and not args.dry_run:
                    total_replaced += soft_delete_existing_facts(conn, task_id=task["id"])
                ins, skp = insert_facts(
                    conn,
                    task_id=task["id"],
                    facts=facts,
                    min_confidence=args.min_confidence,
                    dry_run=args.dry_run,
                    extractor_version=extractor_version,
                )
                total_inserted += ins
                total_skipped += skp

        if not args.dry_run:
            conn.commit()

    finally:
        conn.close()

    result_payload = {
        "source": args.source,
        "extractor": extractor,
        "contract_version": CONTRACT_VERSION,
        "items_processed": total_items,
        "facts_inserted": total_inserted,
        "facts_skipped": total_skipped,
        "facts_replaced": total_replaced,
        "errors": errors,
        "dry_run": args.dry_run,
        "extractor_version": extractor_version,
    }
    validate_contract(worker_schema_path("extract_key_facts"), result_payload)
    print(json.dumps(result_payload, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract key_facts from notes/tasks into key_facts table."
    )
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
        help="Schema file path for structured key_facts",
    )
    parser.add_argument(
        "--extractor",
        choices=["rules", "llm"],
        default="rules",
        help="Extractor backend",
    )
    parser.add_argument(
        "--llm-model",
        default=DEFAULT_LLM_MODEL,
        help="LLM model for structured output (when --extractor llm)",
    )
    parser.add_argument(
        "--llm-base-url",
        default=DEFAULT_LLM_BASE_URL,
        help="LLM API base URL (when --extractor llm)",
    )
    parser.add_argument(
        "--llm-api-key-env",
        default="OPENAI_API_KEY",
        help="Environment variable name containing API key",
    )
    parser.add_argument(
        "--llm-timeout",
        type=int,
        default=DEFAULT_LLM_TIMEOUT_S,
        help="LLM request timeout seconds",
    )
    parser.add_argument(
        "--llm-max-input-chars",
        type=int,
        default=DEFAULT_LLM_MAX_INPUT_CHARS,
        help="Max chars sent to LLM for a single item",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.backend == "sqlite" and not args.db:
        parser.error("--db is required when --backend sqlite")
    if args.note_id and args.source not in {"all", "notes"}:
        raise SystemExit("--note-id can be used only with --source all|notes")
    if args.task_id and args.source not in {"all", "tasks"}:
        raise SystemExit("--task-id can be used only with --source all|tasks")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
