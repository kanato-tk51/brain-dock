#!/usr/bin/env python3
"""
Extract fact-first claims from fact_documents using ChatGPT structured output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

from claim_schema_v2 import (
    SUPPORTED_PREDICATES,
    ParsedClaim,
    ParsedClaimLink,
    ParsedClaimsOutput,
    ParsedEvidenceSpan,
    claims_response_schema,
    parse_claims_output,
)
from db_runtime import (
    DEFAULT_NEON_CONNECT_TIMEOUT_S,
    DEFAULT_NEON_DSN_ENV,
    exec_write,
    fetch_one,
    is_sqlite_conn,
    now_expr,
    open_connection,
)
from json_contract import validate_contract, worker_schema_path
from redaction import redact_for_llm


WORKER_NAME = "extract-claims-llm-v1"
CONTRACT_VERSION = "1.0"
DEFAULT_LLM_MODEL = "gpt-4.1-mini"
DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1"
DEFAULT_LLM_TIMEOUT_S = 45
DEFAULT_LLM_MAX_INPUT_CHARS = 7000
DEFAULT_LLM_REASONING_EFFORT = "none"

MODEL_PRICING_PER_1M_USD: dict[str, dict[str, float]] = {
    "gpt-4.1-mini": {"input": 0.40, "cached_input": 0.10, "output": 1.60},
    "gpt-4o-mini": {"input": 0.15, "cached_input": 0.075, "output": 0.60},
    "gpt-4.1": {"input": 2.00, "cached_input": 0.50, "output": 8.00},
}

ME_REFERENCE_RE = re.compile(r"^(?:me|i|myself|私|わたし|僕|ぼく|俺|おれ|自分)$", re.IGNORECASE)
DECISION_PREDICATES = {"chose", "ended", "decided"}
EVENT_PREDICATES = {"happened", "experienced", "was_affected_by"}
CAUSE_HINT_RE = re.compile(r"(because|due to|ので|から|ため|せいで)", re.IGNORECASE)
RAIN_HINT_RE = re.compile(r"(rain|雨)", re.IGNORECASE)
TEMPORAL_PREFIX_RE = re.compile(
    r"^(今日|昨日|明日|今朝|今夜|昨夜|先週|今週|来週|先月|今月|来月|月曜(?:日)?|火曜(?:日)?|水曜(?:日)?|木曜(?:日)?|金曜(?:日)?|土曜(?:日)?|日曜(?:日)?)は"
)
STATE_CHANGE_HINT_RE = re.compile(
    r"(悪化|改善|回復|低下|上昇|不調|悪く|良く|崩れ|しんど|痛|つら|worsen|worsened|worsening|improv|recover)",
    re.IGNORECASE,
)
TOPIC_HINT_RE = re.compile(
    r"(喉(?:の調子)?|のど|体調|熱|咳|頭痛|胃|声|鼻|睡眠|気分|疲労|sore throat|throat|condition|health)",
    re.IGNORECASE,
)
CJK_RE = re.compile(r"[ぁ-んァ-ヶ一-龠]")
SENTENCE_SPLIT_RE = re.compile(r"[。！？]\s*")
ACTION_CLAUSE_SPLIT_RE = re.compile(r"[、]\s*")
ACTION_HINT_RE = re.compile(
    r"(した|して|行っ|帰宅|作業|トレ|運動|洗濯|寝|指示|出し|やっ|会議|勉強|読書|書い|送っ|連絡|準備|買っ)",
    re.IGNORECASE,
)
PLAN_HINT_RE = re.compile(
    r"(しよう|する予定|つもり|したい|忘れないよう|しなければ|べき|予定|to do|todo)",
    re.IGNORECASE,
)

PREDICATE_ALIAS_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(went_to|go|visit|行った|行く|向かった|訪れた)", re.IGNORECASE), "went_to"),
    (re.compile(r"(was_with|with|一緒|同行|同期と|友達と|同僚と)", re.IGNORECASE), "was_with"),
    (re.compile(r"(chose|choice|選んだ|決めた)", re.IGNORECASE), "chose"),
    (re.compile(r"(ended|解散|終わった|終了した)", re.IGNORECASE), "ended"),
    (re.compile(r"(felt|感じた|気分|emotion)", re.IGNORECASE), "felt"),
    (re.compile(r"(learned|学んだ|覚えた)", re.IGNORECASE), "learned"),
    (re.compile(r"(planned|予定|つもり)", re.IGNORECASE), "planned"),
    (re.compile(r"(requested|頼んだ|依頼)", re.IGNORECASE), "requested"),
    (re.compile(r"(affected|影響|左右)", re.IGNORECASE), "was_affected_by"),
    (re.compile(r"(happened|起きた|発生|降った)", re.IGNORECASE), "happened"),
    (re.compile(r"(did|した|実施|遊んだ)", re.IGNORECASE), "did"),
    (re.compile(r"(decided|判断|決断)", re.IGNORECASE), "decided"),
]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    if hasattr(uuid, "uuid7"):
        return str(uuid.uuid7())  # type: ignore[attr-defined]
    return str(uuid.uuid4())


def _normalize_alias(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", value).strip().lower()
    cleaned = re.sub(r"[^\wぁ-んァ-ヶ一-龠ー ]+", "", cleaned)
    return cleaned


def _safe_to_int(value: Any) -> int:
    try:
        return max(int(value), 0)
    except Exception:
        return 0


def _safe_to_float(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _estimate_request_cost_usd(
    *,
    model: str,
    input_tokens: int,
    cached_input_tokens: int,
    output_tokens: int,
) -> tuple[float, float | None, float | None, float | None]:
    pricing = MODEL_PRICING_PER_1M_USD.get(model)
    if pricing is None:
        for key, value in MODEL_PRICING_PER_1M_USD.items():
            if model.startswith(key):
                pricing = value
                break
    if pricing is None:
        return 0.0, None, None, None

    cached = min(max(cached_input_tokens, 0), max(input_tokens, 0))
    non_cached = max(input_tokens - cached, 0)
    total_price_per_1m = (
        non_cached * pricing["input"]
        + cached * pricing["cached_input"]
        + max(output_tokens, 0) * pricing["output"]
    )
    usd = total_price_per_1m / 1_000_000
    return round(max(usd, 0.0), 6), pricing["input"], pricing["cached_input"], pricing["output"]


def _supports_reasoning_effort(model: str) -> bool:
    normalized = model.lower().strip()
    return normalized.startswith("o") or normalized.startswith("gpt-5")


def _normalize_subject_text(subject_text: str) -> str:
    value = subject_text.strip()
    if not value:
        return "me"
    if ME_REFERENCE_RE.match(value):
        return "me"
    return value[:120]


def _canonicalize_predicate(predicate: str, object_text: str = "") -> str:
    raw = predicate.strip()
    if raw in SUPPORTED_PREDICATES:
        return raw
    candidate = f"{raw} {object_text}"
    for pattern, mapped in PREDICATE_ALIAS_PATTERNS:
        if pattern.search(candidate):
            return mapped
    return "mentions"


def _ensure_single_evidence(claim: ParsedClaim, raw_text: str) -> ParsedClaim:
    if claim.evidence_spans:
        return claim
    excerpt = raw_text.strip()[:200] or claim.object_text_canonical[:200]
    fallback_span = ParsedEvidenceSpan(char_start=None, char_end=None, excerpt=excerpt or "evidence unavailable")
    return ParsedClaim(
        subject_text=claim.subject_text,
        predicate=claim.predicate,
        object_text_raw=claim.object_text_raw,
        object_text_canonical=claim.object_text_canonical,
        me_role=claim.me_role,
        modality=claim.modality,
        polarity=claim.polarity,
        certainty=claim.certainty,
        time_start_utc=claim.time_start_utc,
        time_end_utc=claim.time_end_utc,
        subject_entity_name=claim.subject_entity_name,
        object_entity_name=claim.object_entity_name,
        dimensions=claim.dimensions,
        evidence_spans=[fallback_span],
    )


def _make_fallback_me_claim(raw_text: str, occurred_at_utc: str | None) -> ParsedClaim:
    snippet = raw_text.strip()
    excerpt = snippet[:200] if snippet else "no text"
    return ParsedClaim(
        subject_text="me",
        predicate="experienced",
        object_text_raw=(snippet[:1000] if snippet else "entry recorded"),
        object_text_canonical=(snippet[:1000] if snippet else "entry recorded"),
        me_role="experiencer",
        modality="fact",
        polarity="affirm",
        certainty=0.5,
        time_start_utc=occurred_at_utc,
        time_end_utc=None,
        subject_entity_name=None,
        object_entity_name=None,
        dimensions=[],
        evidence_spans=[ParsedEvidenceSpan(char_start=None, char_end=None, excerpt=excerpt)],
    )


def _contains_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text))


def _restore_object_text_from_evidence_if_translated(
    object_text: str,
    *,
    raw_text: str,
    evidence_spans: list[ParsedEvidenceSpan],
) -> str:
    if not raw_text.strip() or not evidence_spans:
        return object_text
    if not _contains_cjk(raw_text):
        return object_text
    if _contains_cjk(object_text):
        return object_text
    excerpt = evidence_spans[0].excerpt.strip()
    if excerpt and _contains_cjk(excerpt):
        return excerpt[:1000]
    return object_text


def _extract_context_topic(text: str) -> str | None:
    value = text.strip()
    if not value:
        return None
    m = re.search(r"(?P<topic>[^、。]{1,24}?)が(?:悪化|悪く|改善|回復|低下|上昇|不調|痛)", value)
    if m:
        topic = m.group("topic").strip()
        if topic:
            return topic[:24]
    m = TOPIC_HINT_RE.search(value)
    if m:
        return m.group(1)
    return None


def _needs_context_completion(text: str) -> bool:
    value = text.strip()
    if not value:
        return False
    if TOPIC_HINT_RE.search(value):
        return False
    if not STATE_CHANGE_HINT_RE.search(value):
        return False
    if TEMPORAL_PREFIX_RE.search(value):
        return True
    if value.startswith(("さらに", "急に", "案の定")):
        return True
    return len(value) <= 24


def _normalize_time_expression_prefix(text: str) -> str:
    value = text.strip()
    value = re.sub(r"^案の定", "", value).strip()
    value = TEMPORAL_PREFIX_RE.sub(r"\1に", value, count=1)
    return value


def _apply_context_completion(claims: list[ParsedClaim]) -> list[ParsedClaim]:
    latest_topic: str | None = None
    out: list[ParsedClaim] = []

    for claim in claims:
        object_text = claim.object_text_canonical.strip()
        current_topic = _extract_context_topic(object_text)
        if current_topic:
            latest_topic = current_topic
            out.append(claim)
            continue

        if latest_topic and _needs_context_completion(object_text) and latest_topic not in object_text:
            enriched = f"{latest_topic}が{_normalize_time_expression_prefix(object_text)}"
            out.append(
                ParsedClaim(
                    subject_text=claim.subject_text,
                    predicate=claim.predicate,
                    object_text_raw=claim.object_text_raw,
                    object_text_canonical=enriched[:1000],
                    me_role=claim.me_role,
                    modality=claim.modality,
                    polarity=claim.polarity,
                    certainty=claim.certainty,
                    time_start_utc=claim.time_start_utc,
                    time_end_utc=claim.time_end_utc,
                    subject_entity_name=claim.subject_entity_name,
                    object_entity_name=claim.object_entity_name,
                    dimensions=claim.dimensions,
                    evidence_spans=claim.evidence_spans,
                )
            )
            continue

        out.append(claim)

    return out


def _is_quality_ok(claim: ParsedClaim) -> bool:
    canonical = (claim.object_text_canonical or "").strip()
    return bool(canonical)


def apply_quality_gate(parsed: ParsedClaimsOutput) -> tuple[ParsedClaimsOutput, list[str]]:
    quality_flags: list[str] = []
    filtered_claims: list[ParsedClaim] = []
    index_map: dict[int, int] = {}
    for idx, claim in enumerate(parsed.claims):
        if _is_quality_ok(claim):
            index_map[idx] = len(filtered_claims)
            filtered_claims.append(claim)
            continue
        quality_flags.append(f"claim_rejected:{idx}")

    filtered_links: list[ParsedClaimLink] = []
    for link in parsed.links:
        if link.from_claim_index in index_map and link.to_claim_index in index_map:
            filtered_links.append(
                ParsedClaimLink(
                    from_claim_index=index_map[link.from_claim_index],
                    to_claim_index=index_map[link.to_claim_index],
                    relation_type=link.relation_type,
                    confidence=link.confidence,
                )
            )

    return ParsedClaimsOutput(claims=filtered_claims, entities=parsed.entities, links=filtered_links), quality_flags


def normalize_to_me_centric_claims(
    parsed: ParsedClaimsOutput,
    *,
    raw_text: str,
    declared_type: str,
    occurred_at_utc: str | None,
) -> ParsedClaimsOutput:
    normalized_claims: list[ParsedClaim] = []
    for claim in parsed.claims:
        subject_text = _normalize_subject_text(claim.subject_text)
        raw_object = (claim.object_text_raw or claim.object_text_canonical or claim.object_text)[:1000]
        predicate = _canonicalize_predicate(claim.predicate, raw_object)
        normalized_object = _restore_object_text_from_evidence_if_translated(
            (claim.object_text_canonical or raw_object)[:1000],
            raw_text=raw_text,
            evidence_spans=claim.evidence_spans,
        )
        me_role = claim.me_role
        if subject_text == "me" and me_role == "none":
            me_role = "experiencer"
        normalized = ParsedClaim(
            subject_text=subject_text,
            predicate=predicate,
            object_text_raw=raw_object,
            object_text_canonical=normalized_object,
            me_role=me_role,
            modality=claim.modality,
            polarity=claim.polarity,
            certainty=claim.certainty,
            time_start_utc=claim.time_start_utc or occurred_at_utc,
            time_end_utc=claim.time_end_utc,
            subject_entity_name=claim.subject_entity_name,
            object_entity_name=claim.object_entity_name,
            dimensions=claim.dimensions,
            evidence_spans=claim.evidence_spans,
        )
        normalized_claims.append(_ensure_single_evidence(normalized, raw_text))

    filtered_claims: list[ParsedClaim] = list(normalized_claims)
    index_map: dict[int, int] = {idx: idx for idx in range(len(filtered_claims))}

    if not filtered_claims:
        filtered_claims = [_make_fallback_me_claim(raw_text, occurred_at_utc)]
        index_map = {0: 0}

    filtered_claims = _apply_context_completion(filtered_claims)
    filtered_claims = _augment_missing_action_claims(
        filtered_claims,
        raw_text=raw_text,
        occurred_at_utc=occurred_at_utc,
    )

    filtered_links: list[ParsedClaimLink] = []
    for link in parsed.links:
        if link.from_claim_index not in index_map or link.to_claim_index not in index_map:
            continue
        filtered_links.append(
            ParsedClaimLink(
                from_claim_index=index_map[link.from_claim_index],
                to_claim_index=index_map[link.to_claim_index],
                relation_type=link.relation_type,
                confidence=link.confidence,
            )
        )

    decision_indexes = [idx for idx, claim in enumerate(filtered_claims) if claim.predicate in DECISION_PREDICATES]
    has_decision_cause = any(
        link.relation_type == "caused_by" and link.from_claim_index in decision_indexes for link in filtered_links
    )
    if decision_indexes and not has_decision_cause:
        cause_candidate_idx = -1
        for idx, claim in enumerate(filtered_claims):
            if idx in decision_indexes:
                continue
            if claim.predicate in EVENT_PREDICATES or RAIN_HINT_RE.search(claim.object_text_canonical):
                cause_candidate_idx = idx
                break
        if cause_candidate_idx >= 0:
            for decision_idx in decision_indexes:
                filtered_links.append(
                    ParsedClaimLink(
                        from_claim_index=decision_idx,
                        to_claim_index=cause_candidate_idx,
                        relation_type="caused_by",
                        confidence=0.75,
                    )
                )

    if decision_indexes and not any(claim.predicate in EVENT_PREDICATES for claim in filtered_claims):
        if RAIN_HINT_RE.search(raw_text) or CAUSE_HINT_RE.search(raw_text):
            filtered_claims.append(
                ParsedClaim(
                    subject_text="context",
                    predicate="happened",
                    object_text_raw=(raw_text[:180] if raw_text else "context event happened"),
                    object_text_canonical=(raw_text[:180] if raw_text else "context event happened"),
                    me_role="none",
                    modality="fact",
                    polarity="affirm",
                    certainty=0.7,
                    time_start_utc=occurred_at_utc,
                    time_end_utc=None,
                    subject_entity_name=None,
                    object_entity_name=None,
                    dimensions=[],
                    evidence_spans=[
                        ParsedEvidenceSpan(
                            char_start=None,
                            char_end=None,
                            excerpt=(raw_text[:180] if raw_text else "context event"),
                        )
                    ],
                )
            )
            cause_idx = len(filtered_claims) - 1
            for decision_idx in decision_indexes:
                filtered_links.append(
                    ParsedClaimLink(
                        from_claim_index=decision_idx,
                        to_claim_index=cause_idx,
                        relation_type="caused_by",
                        confidence=0.72,
                    )
                )

    return ParsedClaimsOutput(
        claims=filtered_claims,
        entities=parsed.entities,
        links=filtered_links,
    )


def _split_action_clauses(raw_text: str) -> list[str]:
    clauses: list[str] = []
    for sentence in SENTENCE_SPLIT_RE.split(raw_text):
        sentence = sentence.strip()
        if not sentence:
            continue
        parts = [segment.strip() for segment in ACTION_CLAUSE_SPLIT_RE.split(sentence) if segment.strip()]
        if not parts:
            continue
        clauses.extend(parts)
    return clauses


def _normalize_text_for_match(text: str) -> str:
    collapsed = re.sub(r"\s+", "", text).strip().lower()
    return re.sub(r"[。、！？・,.;:()（）「」『』\"'`]", "", collapsed)


def _char_ngrams(text: str, n: int = 2) -> set[str]:
    if not text:
        return set()
    if len(text) <= n:
        return {text}
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def _is_clause_covered(clause: str, claims: list[ParsedClaim]) -> bool:
    normalized_clause = _normalize_text_for_match(clause)
    if not normalized_clause:
        return True
    clause_ngrams = _char_ngrams(normalized_clause)
    for claim in claims:
        canonical = _normalize_text_for_match(claim.object_text_canonical or "")
        if not canonical:
            continue
        if canonical in normalized_clause or normalized_clause in canonical:
            return True
        canonical_ngrams = _char_ngrams(canonical)
        if not canonical_ngrams or not clause_ngrams:
            continue
        overlap = len(clause_ngrams & canonical_ngrams)
        ratio = overlap / max(1, min(len(clause_ngrams), len(canonical_ngrams)))
        if ratio >= 0.55:
            return True
    return False


def _clause_to_fallback_claim(clause: str, occurred_at_utc: str | None) -> ParsedClaim:
    is_plan = bool(PLAN_HINT_RE.search(clause))
    predicate = "planned" if is_plan else "did"
    modality = "plan" if is_plan else "fact"
    confidence = 0.72 if is_plan else 0.68
    excerpt = clause[:200]
    return ParsedClaim(
        subject_text="me",
        predicate=predicate,
        object_text_raw=clause[:1000],
        object_text_canonical=clause[:1000],
        me_role="actor",
        modality=modality,
        polarity="affirm",
        certainty=confidence,
        time_start_utc=occurred_at_utc,
        time_end_utc=None,
        subject_entity_name=None,
        object_entity_name=None,
        dimensions=[],
        evidence_spans=[ParsedEvidenceSpan(char_start=None, char_end=None, excerpt=excerpt or "action clause")],
    )


def _augment_missing_action_claims(
    claims: list[ParsedClaim],
    *,
    raw_text: str,
    occurred_at_utc: str | None,
) -> list[ParsedClaim]:
    out = list(claims)
    for clause in _split_action_clauses(raw_text):
        if len(clause) < 4:
            continue
        if not ACTION_HINT_RE.search(clause) and not PLAN_HINT_RE.search(clause):
            continue
        if _is_clause_covered(clause, out):
            continue
        out.append(_clause_to_fallback_claim(clause, occurred_at_utc))
    return out


def _resolve_environment() -> str:
    raw = (
        os.environ.get("BRAIN_DOCK_ENV")
        or os.environ.get("APP_ENV")
        or os.environ.get("VERCEL_ENV")
        or "local"
    ).lower()
    if raw in {"local", "staging", "production"}:
        return raw
    if raw == "preview":
        return "staging"
    return "local"


def log_openai_request(
    conn: Any,
    *,
    request_started_at: str,
    request_finished_at: str | None,
    status: str,
    model: str,
    source_ref_id: str | None,
    openai_request_id: str | None,
    input_tokens: int,
    cached_input_tokens: int,
    output_tokens: int,
    reasoning_output_tokens: int,
    input_chars: int | None,
    output_chars: int | None,
    request_cost_usd: float,
    input_price_per_1m_usd: float | None,
    cached_input_price_per_1m_usd: float | None,
    output_price_per_1m_usd: float | None,
    error_type: str | None,
    error_message: str | None,
    metadata_json: dict[str, Any],
) -> None:
    if is_sqlite_conn(conn):
        return
    try:
        exec_write(
            conn,
            """
            INSERT INTO public.openai_api_requests (
              id, request_started_at, request_finished_at, status, environment,
              endpoint, model, operation, workflow, actor, source_ref_type,
              source_ref_id, openai_request_id, input_tokens, cached_input_tokens,
              output_tokens, reasoning_output_tokens, input_chars, output_chars,
              input_price_per_1m_usd, cached_input_price_per_1m_usd, output_price_per_1m_usd,
              request_cost_usd, cost_source, error_type, error_message, metadata_json
            ) VALUES (
              %s, %s, %s, %s, %s, '/chat/completions', %s, 'extract_claims_llm',
              'fact_extraction', 'worker:extract_claims_llm', 'entry',
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'estimated',
              %s, %s, %s::jsonb
            )
            """,
            (
                _new_id(),
                request_started_at,
                request_finished_at,
                status,
                _resolve_environment(),
                model,
                source_ref_id,
                openai_request_id,
                max(input_tokens, 0),
                max(cached_input_tokens, 0),
                max(output_tokens, 0),
                max(reasoning_output_tokens, 0),
                input_chars,
                output_chars,
                input_price_per_1m_usd,
                cached_input_price_per_1m_usd,
                output_price_per_1m_usd,
                max(request_cost_usd, 0.0),
                error_type,
                (error_message[:1000] if error_message else None),
                json.dumps(metadata_json, ensure_ascii=False),
            ),
        )
    except Exception:
        return


def log_analysis_artifact(
    conn: Any,
    *,
    extraction_id: str | None,
    artifact_type: str,
    metadata_json: dict[str, Any],
    dry_run: bool,
) -> None:
    if dry_run or not extraction_id:
        return
    if is_sqlite_conn(conn):
        return
    try:
        payload = json.dumps(metadata_json, ensure_ascii=False, sort_keys=True)
        sha256 = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        exec_write(
            conn,
            """
            INSERT INTO public.fact_analysis_artifacts (
              id, extraction_id, artifact_type, sha256, metadata_json, expires_at, created_at
            ) VALUES (
              %s, %s, %s, %s, %s::jsonb, now() + interval '30 days', now()
            )
            """,
            (_new_id(), extraction_id, artifact_type, sha256, payload),
        )
    except Exception:
        return


def fetch_document(conn: Any, *, entry_id: str | None, document_id: str | None) -> dict[str, Any] | None:
    if document_id:
        return fetch_one(
            conn,
            """
            SELECT *
            FROM fact_documents
            WHERE id = %s
            LIMIT 1
            """,
            (document_id,),
        )
    if entry_id:
        return fetch_one(
            conn,
            """
            SELECT *
            FROM fact_documents
            WHERE entry_id = %s
            LIMIT 1
            """,
            (entry_id,),
        )
    return None


def update_document_redaction_state(
    conn: Any, *, document_id: str, pii_score: float, redaction_state: str, dry_run: bool
) -> None:
    if dry_run:
        return
    now = now_expr(conn)
    exec_write(
        conn,
        f"""
        UPDATE fact_documents
        SET pii_score = %s, redaction_state = %s, updated_at = {now}
        WHERE id = %s
        """,
        (pii_score, redaction_state, document_id),
    )


def ensure_entity(conn: Any, *, name: str, entity_type: str, dry_run: bool) -> str:
    row = fetch_one(
        conn,
        """
        SELECT id
        FROM fact_entities
        WHERE entity_type = %s AND canonical_name = %s
        LIMIT 1
        """,
        (entity_type, name),
    )
    if row:
        return str(row["id"])

    entity_id = _new_id()
    if dry_run:
        return entity_id
    now = now_expr(conn)
    exec_write(
        conn,
        f"""
        INSERT INTO fact_entities (
          id, entity_type, canonical_name, created_at, updated_at
        ) VALUES (%s, %s, %s, {now}, {now})
        """,
        (entity_id, entity_type, name),
    )
    return entity_id


def ensure_entity_alias(
    conn: Any, *, entity_id: str, alias: str, dry_run: bool
) -> None:
    normalized_alias = _normalize_alias(alias)
    if not normalized_alias:
        return
    if dry_run:
        return
    insert_sql = """
        INSERT INTO fact_entity_aliases (
          id, entity_id, alias, normalized_alias, created_at
        ) VALUES (%s, %s, %s, %s, now())
    """
    if is_sqlite_conn(conn):
        insert_sql = insert_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
    else:
        insert_sql += " ON CONFLICT DO NOTHING"
    exec_write(
        conn,
        insert_sql,
        (_new_id(), entity_id, alias, normalized_alias),
    )


def soft_delete_claims(conn: Any, *, entry_id: str, dry_run: bool) -> int:
    if dry_run:
        return 0
    now = now_expr(conn)
    return exec_write(
        conn,
        f"""
        UPDATE fact_claims
        SET deleted_at = {now}, updated_at = {now}, status = 'superseded'
        WHERE entry_id = %s AND deleted_at IS NULL
        """,
        (entry_id,),
    )


def insert_claim_bundle(
    conn: Any,
    *,
    document: dict[str, Any],
    parsed: ParsedClaimsOutput,
    extraction_id: str,
    extractor_version: str,
    replace_existing: bool,
    dry_run: bool,
) -> tuple[int, int, int, int]:
    entry_id = str(document["entry_id"])
    document_id = str(document["id"])

    if replace_existing:
        soft_delete_claims(conn, entry_id=entry_id, dry_run=dry_run)

    entity_ids_by_name: dict[str, str] = {}
    entities_upserted = 0
    for entity in parsed.entities:
        entity_id = ensure_entity(
            conn,
            name=entity.name,
            entity_type=entity.entity_type,
            dry_run=dry_run,
        )
        entity_ids_by_name[entity.name] = entity_id
        entities_upserted += 1
        for alias in entity.aliases:
            ensure_entity_alias(conn, entity_id=entity_id, alias=alias, dry_run=dry_run)

    claims_inserted = 0
    evidence_inserted = 0
    links_inserted = 0
    claim_ids_by_index: dict[int, str] = {}

    for idx, claim in enumerate(parsed.claims):
        subject_entity_id = (
            entity_ids_by_name.get(claim.subject_entity_name)
            if claim.subject_entity_name
            else None
        )
        object_entity_id = (
            entity_ids_by_name.get(claim.object_entity_name)
            if claim.object_entity_name
            else None
        )
        claim_id = _new_id()
        claim_ids_by_index[idx] = claim_id
        if dry_run:
            claims_inserted += 1
            evidence_inserted += len(claim.evidence_spans)
            continue

        insert_sql = """
            INSERT INTO fact_claims (
              id, document_id, entry_id, subject_text, subject_entity_id,
              predicate, object_text, object_text_raw, object_text_canonical, object_entity_id, me_role,
              modality, polarity, certainty, quality_score, quality_flags,
              time_start_utc, time_end_utc, status, extraction_id, extractor_version, revision_note, created_at, updated_at
            ) VALUES (
              %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s, %s,
              %s, %s, %s, %s, %s,
              %s, %s, 'active', %s, %s, %s, now(), now()
            )
        """
        if is_sqlite_conn(conn):
            insert_sql = insert_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
        else:
            insert_sql += " ON CONFLICT DO NOTHING"
        rowcount = exec_write(
            conn,
            insert_sql,
            (
                claim_id,
                document_id,
                entry_id,
                claim.subject_text,
                subject_entity_id,
                claim.predicate,
                claim.object_text_canonical,
                claim.object_text_raw,
                claim.object_text_canonical,
                object_entity_id,
                claim.me_role,
                claim.modality,
                claim.polarity,
                claim.certainty,
                claim.certainty,
                json.dumps([]),
                claim.time_start_utc,
                claim.time_end_utc,
                extraction_id,
                extractor_version,
                None,
            ),
        )
        if rowcount == 1:
            claims_inserted += 1
        else:
            continue

        for dim in claim.dimensions:
            dim_sql = """
                INSERT INTO fact_claim_dimensions (
                  id, claim_id, dimension_type, dimension_value, normalized_value,
                  confidence, source, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, now())
            """
            if is_sqlite_conn(conn):
                dim_sql = dim_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
            else:
                dim_sql += " ON CONFLICT DO NOTHING"
            normalized_value = _normalize_alias(dim.dimension_value)
            exec_write(
                conn,
                dim_sql,
                (
                    _new_id(),
                    claim_id,
                    dim.dimension_type,
                    dim.dimension_value,
                    normalized_value or dim.dimension_value.lower(),
                    dim.confidence,
                    dim.source,
                ),
            )

        for span in claim.evidence_spans:
            span_sql = """
                INSERT INTO fact_evidence_spans (
                  id, claim_id, document_id, char_start, char_end, excerpt, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, now())
            """
            if is_sqlite_conn(conn):
                span_sql = span_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
            else:
                span_sql += " ON CONFLICT DO NOTHING"
            rowcount = exec_write(
                conn,
                span_sql,
                (
                    _new_id(),
                    claim_id,
                    document_id,
                    span.char_start,
                    span.char_end,
                    span.excerpt,
                ),
            )
            if rowcount == 1:
                evidence_inserted += 1

    for link in parsed.links:
        from_claim_id = claim_ids_by_index.get(link.from_claim_index)
        to_claim_id = claim_ids_by_index.get(link.to_claim_index)
        if not from_claim_id or not to_claim_id:
            continue
        if dry_run:
            links_inserted += 1
            continue
        link_sql = """
            INSERT INTO fact_claim_links (
              id, from_claim_id, to_claim_id, relation_type, confidence, created_at
            ) VALUES (%s, %s, %s, %s, %s, now())
        """
        if is_sqlite_conn(conn):
            link_sql = link_sql.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1)
        else:
            link_sql += " ON CONFLICT DO NOTHING"
        rowcount = exec_write(
            conn,
            link_sql,
            (_new_id(), from_claim_id, to_claim_id, link.relation_type, link.confidence),
        )
        if rowcount == 1:
            links_inserted += 1

    return claims_inserted, evidence_inserted, entities_upserted, links_inserted


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
    raise ValueError("LLM response content is not json string")


def extract_with_llm(
    *,
    conn: Any,
    document: dict[str, Any],
    llm_text: str,
    model: str,
    reasoning_effort: str,
    base_url: str,
    api_key: str,
    timeout_s: int,
    extraction_id: str | None,
    dry_run: bool,
) -> tuple[ParsedClaimsOutput, dict[str, Any]]:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You extract factual memory claims for personal memory retrieval. "
                    "Center extraction on the user as subject 'me'. "
                    "Extract claims exhaustively: do not omit any concrete action, event, plan, decision, task, meeting point, movement, workout, chore, or reminder present in the text. "
                    "Split compound sentences into atomic claims in chronological order. "
                    "Object text must be self-contained and understandable alone, with minimal context completion if needed. "
                    "Use only allowed predicates from the schema enum. "
                    "When a decision/action is caused by an event, output two claims and add a link relation_type='caused_by' "
                    "from decision claim to cause claim. "
                    "Preserve modality/polarity, avoid speculation, and include evidence spans for every claim."
                ),
            },
            {
                "role": "user",
                "content": (
                    "Return structured claims from this document.\n\n"
                    f"declared_type={document['declared_type']}\n"
                    f"occurred_at_utc={document['occurred_at_utc']}\n"
                    "extraction_priority=me-centric factual memory\n"
                    "rules=extract all concrete actions and plans without omission; split into atomic claims; keep causal relations; no speculative emotions\n"
                    f"text={llm_text[:DEFAULT_LLM_MAX_INPUT_CHARS]}"
                ),
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "fact_claims_output",
                "strict": True,
                "schema": claims_response_schema(),
            },
        },
    }
    log_analysis_artifact(
        conn,
        extraction_id=extraction_id,
        artifact_type="prompt_meta",
        metadata_json={
            "document_id": str(document["id"]),
            "entry_id": str(document["entry_id"]),
            "model": model,
            "reasoning_effort": reasoning_effort,
            "message_count": len(payload["messages"]),
            "response_format": "json_schema",
        },
        dry_run=dry_run,
    )
    if reasoning_effort != "none" and _supports_reasoning_effort(model):
        payload["reasoning_effort"] = reasoning_effort
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

    request_started_at = _utc_now_iso()
    request_finished_at: str | None = None
    request_cost_usd = 0.0
    input_tokens = 0
    cached_input_tokens = 0
    output_tokens = 0
    reasoning_output_tokens = 0
    input_price_per_1m_usd: float | None = None
    cached_input_price_per_1m_usd: float | None = None
    output_price_per_1m_usd: float | None = None
    openai_request_id: str | None = None
    output_chars: int | None = None
    input_chars = len(llm_text)
    metadata = {
        "document_id": document["id"],
        "entry_id": document["entry_id"],
        "declared_type": document["declared_type"],
        "reasoning_effort": reasoning_effort,
    }

    try:
        with urlrequest.urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8")
            openai_request_id = resp.headers.get("x-request-id")
            request_finished_at = _utc_now_iso()
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        log_openai_request(
            conn,
            request_started_at=request_started_at,
            request_finished_at=_utc_now_iso(),
            status="error",
            model=model,
            source_ref_id=str(document["entry_id"]),
            openai_request_id=None,
            input_tokens=0,
            cached_input_tokens=0,
            output_tokens=0,
            reasoning_output_tokens=0,
            input_chars=input_chars,
            output_chars=None,
            request_cost_usd=0.0,
            input_price_per_1m_usd=None,
            cached_input_price_per_1m_usd=None,
            output_price_per_1m_usd=None,
            error_type="http_error",
            error_message=f"{e.code} {detail}",
            metadata_json=metadata,
        )
        log_analysis_artifact(
            conn,
            extraction_id=extraction_id,
            artifact_type="validation_error",
            metadata_json={
                "error_type": "http_error",
                "status_code": e.code,
            },
            dry_run=dry_run,
        )
        raise RuntimeError(f"LLM HTTPError: {e.code} {detail}") from e
    except urlerror.URLError as e:
        status = "timeout" if "timed out" in str(e).lower() else "error"
        log_openai_request(
            conn,
            request_started_at=request_started_at,
            request_finished_at=_utc_now_iso(),
            status=status,
            model=model,
            source_ref_id=str(document["entry_id"]),
            openai_request_id=None,
            input_tokens=0,
            cached_input_tokens=0,
            output_tokens=0,
            reasoning_output_tokens=0,
            input_chars=input_chars,
            output_chars=None,
            request_cost_usd=0.0,
            input_price_per_1m_usd=None,
            cached_input_price_per_1m_usd=None,
            output_price_per_1m_usd=None,
            error_type="network_error",
            error_message=str(e),
            metadata_json=metadata,
        )
        log_analysis_artifact(
            conn,
            extraction_id=extraction_id,
            artifact_type="validation_error",
            metadata_json={
                "error_type": "network_error",
                "detail": str(e),
            },
            dry_run=dry_run,
        )
        raise RuntimeError(f"LLM URLError: {e}") from e

    try:
        data = json.loads(body)
        usage = data.get("usage")
        if isinstance(usage, dict):
            input_tokens = _safe_to_int(usage.get("prompt_tokens"))
            output_tokens = _safe_to_int(usage.get("completion_tokens"))
            prompt_details = usage.get("prompt_tokens_details")
            if isinstance(prompt_details, dict):
                cached_input_tokens = _safe_to_int(prompt_details.get("cached_tokens"))
            completion_details = usage.get("completion_tokens_details")
            if isinstance(completion_details, dict):
                reasoning_output_tokens = _safe_to_int(completion_details.get("reasoning_tokens"))

        openai_request_id = str(data.get("id")) if data.get("id") is not None else openai_request_id
        request_cost_usd, input_price_per_1m_usd, cached_input_price_per_1m_usd, output_price_per_1m_usd = (
            _estimate_request_cost_usd(
                model=model,
                input_tokens=input_tokens,
                cached_input_tokens=cached_input_tokens,
                output_tokens=output_tokens,
            )
        )
        json_text = _extract_json_text_from_chat_response(data)
        output_chars = len(json_text)
        parsed_json = json.loads(json_text)
        parsed = parse_claims_output(parsed_json)
    except Exception as exc:
        log_openai_request(
            conn,
            request_started_at=request_started_at,
            request_finished_at=request_finished_at or _utc_now_iso(),
            status="error",
            model=model,
            source_ref_id=str(document["entry_id"]),
            openai_request_id=openai_request_id,
            input_tokens=input_tokens,
            cached_input_tokens=cached_input_tokens,
            output_tokens=output_tokens,
            reasoning_output_tokens=reasoning_output_tokens,
            input_chars=input_chars,
            output_chars=output_chars,
            request_cost_usd=request_cost_usd,
            input_price_per_1m_usd=input_price_per_1m_usd,
            cached_input_price_per_1m_usd=cached_input_price_per_1m_usd,
            output_price_per_1m_usd=output_price_per_1m_usd,
            error_type="parse_error",
            error_message=str(exc),
            metadata_json=metadata,
        )
        log_analysis_artifact(
            conn,
            extraction_id=extraction_id,
            artifact_type="validation_error",
            metadata_json={
                "error_type": "parse_error",
                "detail": str(exc),
                "openai_request_id": openai_request_id,
            },
            dry_run=dry_run,
        )
        raise RuntimeError(f"LLM parse failed: {exc}") from exc

    log_openai_request(
        conn,
        request_started_at=request_started_at,
        request_finished_at=request_finished_at or _utc_now_iso(),
        status="ok",
        model=model,
        source_ref_id=str(document["entry_id"]),
        openai_request_id=openai_request_id,
        input_tokens=input_tokens,
        cached_input_tokens=cached_input_tokens,
        output_tokens=output_tokens,
        reasoning_output_tokens=reasoning_output_tokens,
        input_chars=input_chars,
        output_chars=output_chars,
        request_cost_usd=request_cost_usd,
        input_price_per_1m_usd=input_price_per_1m_usd,
        cached_input_price_per_1m_usd=cached_input_price_per_1m_usd,
        output_price_per_1m_usd=output_price_per_1m_usd,
        error_type=None,
        error_message=None,
        metadata_json=metadata,
    )
    log_analysis_artifact(
        conn,
        extraction_id=extraction_id,
        artifact_type="response_meta",
        metadata_json={
            "openai_request_id": openai_request_id,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "request_cost_usd": request_cost_usd,
        },
        dry_run=dry_run,
    )
    return parsed, {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "request_cost_usd": request_cost_usd,
        "openai_request_id": openai_request_id,
    }


def run(args: argparse.Namespace) -> int:
    conn = open_connection(
        backend=args.backend,
        db=args.db,
        neon_dsn=args.neon_dsn,
        neon_dsn_env=args.neon_dsn_env,
        neon_connect_timeout=args.neon_connect_timeout,
    )
    extraction_id = args.extraction_id or _new_id()
    result = {
        "worker": WORKER_NAME,
        "contract_version": CONTRACT_VERSION,
        "job_id": args.job_id,
        "job_item_id": args.job_item_id,
        "extraction_id": extraction_id,
        "entry_id": args.entry_id,
        "document_id": args.document_id,
        "status": "failed",
        "claims_inserted": 0,
        "evidence_inserted": 0,
        "entities_upserted": 0,
        "links_inserted": 0,
        "request_tokens_in": 0,
        "request_tokens_out": 0,
        "request_cost_usd": 0.0,
        "error_code": None,
        "attempt_count": max(args.attempt_count, 1),
        "next_retry_at": None,
        "error": None,
        "dry_run": args.dry_run,
    }
    try:
        document = fetch_document(conn, entry_id=args.entry_id, document_id=args.document_id)
        if not document:
            raise RuntimeError("fact_document not found")

        result["entry_id"] = str(document["entry_id"])
        result["document_id"] = str(document["id"])

        redaction = redact_for_llm(str(document["raw_text"] or ""))
        effective_score = max(_safe_to_float(document.get("pii_score")), redaction.pii_score)
        update_document_redaction_state(
            conn,
            document_id=str(document["id"]),
            pii_score=effective_score,
            redaction_state=redaction.redaction_state,
            dry_run=args.dry_run,
        )
        if redaction.risk_level == "high":
            result["status"] = "blocked"
            result["error_code"] = "blocked_sensitive"
            result["error"] = "blocked_sensitive"
            if not args.dry_run:
                conn.commit()
            validate_contract(worker_schema_path("extract_claims_llm"), result)
            print(json.dumps(result, ensure_ascii=False))
            return 0

        api_key = os.environ.get(args.llm_api_key_env)
        if not api_key:
            raise RuntimeError(f"environment variable not set: {args.llm_api_key_env}")

        parsed, request_meta = extract_with_llm(
            conn=conn,
            document=document,
            llm_text=redaction.llm_text[: args.llm_max_input_chars],
            model=args.llm_model,
            reasoning_effort=args.llm_reasoning_effort,
            base_url=args.llm_base_url,
            api_key=api_key,
            timeout_s=args.llm_timeout,
            extraction_id=extraction_id,
            dry_run=args.dry_run,
        )
        result["request_tokens_in"] = _safe_to_int(request_meta.get("input_tokens"))
        result["request_tokens_out"] = _safe_to_int(request_meta.get("output_tokens"))
        result["request_cost_usd"] = _safe_to_float(request_meta.get("request_cost_usd"))
        parsed = normalize_to_me_centric_claims(
            parsed,
            raw_text=str(document.get("raw_text") or ""),
            declared_type=str(document.get("declared_type") or ""),
            occurred_at_utc=str(document.get("occurred_at_utc") or "") or None,
        )
        parsed, quality_flags = apply_quality_gate(parsed)
        if not parsed.claims:
            raise RuntimeError("quality_gate_rejected_all_claims")

        claims_inserted, evidence_inserted, entities_upserted, links_inserted = insert_claim_bundle(
            conn,
            document=document,
            parsed=parsed,
            extraction_id=extraction_id,
            extractor_version=f"llm-{args.llm_model}",
            replace_existing=args.replace_existing,
            dry_run=args.dry_run,
        )
        result["claims_inserted"] = claims_inserted
        result["evidence_inserted"] = evidence_inserted
        result["entities_upserted"] = entities_upserted
        result["links_inserted"] = links_inserted
        if quality_flags:
            result["error"] = ",".join(quality_flags[:5])
        result["status"] = "succeeded"

        if not args.dry_run:
            conn.commit()
    except Exception as exc:
        retry_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        result["status"] = "queued"
        result["error_code"] = "retryable_error"
        result["next_retry_at"] = retry_at
        result["error"] = str(exc)
        if not args.dry_run:
            conn.rollback()
    finally:
        conn.close()

    validate_contract(worker_schema_path("extract_claims_llm"), result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract fact claims from fact_documents by LLM")
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
    parser.add_argument("--entry-id", help="Entry ID")
    parser.add_argument("--document-id", help="Fact document ID")
    parser.add_argument("--job-id", help="Extraction job ID")
    parser.add_argument("--job-item-id", help="Extraction job item ID")
    parser.add_argument("--extraction-id", default="", help="Extraction execution ID")
    parser.add_argument("--attempt-count", type=int, default=1, help="Attempt count")
    parser.add_argument("--replace-existing", action="store_true", help="Replace existing active claims for the entry")
    parser.add_argument("--dry-run", action="store_true", help="No DB writes")
    parser.add_argument("--llm-model", default=DEFAULT_LLM_MODEL, help="OpenAI model")
    parser.add_argument(
        "--llm-reasoning-effort",
        choices=["none", "low", "medium", "high"],
        default=DEFAULT_LLM_REASONING_EFFORT,
        help="Reasoning effort (used only for models that support reasoning controls)",
    )
    parser.add_argument("--llm-base-url", default=DEFAULT_LLM_BASE_URL, help="OpenAI API base URL")
    parser.add_argument("--llm-api-key-env", default="OPENAI_API_KEY", help="API key environment variable")
    parser.add_argument("--llm-timeout", type=int, default=DEFAULT_LLM_TIMEOUT_S, help="Timeout seconds")
    parser.add_argument(
        "--llm-max-input-chars",
        type=int,
        default=DEFAULT_LLM_MAX_INPUT_CHARS,
        help="Max chars sent to LLM",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.backend == "sqlite" and not args.db:
        parser.error("--db is required when --backend sqlite")
    if not args.entry_id and not args.document_id:
        parser.error("--entry-id or --document-id is required")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
