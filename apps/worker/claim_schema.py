#!/usr/bin/env python3
"""Structured output schema for fact-first claim extraction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


SUPPORTED_MODALITIES = {"fact", "plan", "hypothesis", "request", "feeling"}
SUPPORTED_POLARITIES = {"affirm", "negate"}
SUPPORTED_RELATIONS = {"supports", "contradicts", "caused_by", "follow_up", "same_event"}
SUPPORTED_ENTITY_TYPES = {"person", "organization", "project", "place", "concept", "other"}
SUPPORTED_PREDICATES = {
    "did",
    "was_with",
    "went_to",
    "experienced",
    "chose",
    "ended",
    "felt",
    "was_affected_by",
    "happened",
    "decided",
    "learned",
    "planned",
    "requested",
    "mentions",
}


def claims_response_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["claims", "entities", "links"],
        "properties": {
            "claims": {
                "type": "array",
                "maxItems": 24,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "subject_text",
                        "predicate",
                        "object_text",
                        "modality",
                        "polarity",
                        "certainty",
                        "time_start_utc",
                        "time_end_utc",
                        "subject_entity_name",
                        "object_entity_name",
                        "evidence_spans",
                    ],
                    "properties": {
                        "subject_text": {"type": "string", "minLength": 1, "maxLength": 120},
                        "predicate": {"type": "string", "enum": sorted(SUPPORTED_PREDICATES)},
                        "object_text": {"type": "string", "minLength": 1, "maxLength": 1000},
                        "modality": {"type": "string", "enum": sorted(SUPPORTED_MODALITIES)},
                        "polarity": {"type": "string", "enum": sorted(SUPPORTED_POLARITIES)},
                        "certainty": {"type": "number", "minimum": 0, "maximum": 1},
                        "time_start_utc": {"type": ["string", "null"], "maxLength": 40},
                        "time_end_utc": {"type": ["string", "null"], "maxLength": 40},
                        "subject_entity_name": {"type": ["string", "null"], "maxLength": 160},
                        "object_entity_name": {"type": ["string", "null"], "maxLength": 160},
                        "evidence_spans": {
                            "type": "array",
                            "maxItems": 4,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["char_start", "char_end", "excerpt"],
                                "properties": {
                                    "char_start": {"type": ["integer", "null"], "minimum": 0},
                                    "char_end": {"type": ["integer", "null"], "minimum": 0},
                                    "excerpt": {"type": "string", "minLength": 1, "maxLength": 500},
                                },
                            },
                        },
                    },
                },
            },
            "entities": {
                "type": "array",
                "maxItems": 40,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "entity_type", "aliases"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 160},
                        "entity_type": {"type": "string", "enum": sorted(SUPPORTED_ENTITY_TYPES)},
                        "aliases": {
                            "type": "array",
                            "maxItems": 10,
                            "items": {"type": "string", "minLength": 1, "maxLength": 160},
                        },
                    },
                },
            },
            "links": {
                "type": "array",
                "maxItems": 30,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["from_claim_index", "to_claim_index", "relation_type", "confidence"],
                    "properties": {
                        "from_claim_index": {"type": "integer", "minimum": 0},
                        "to_claim_index": {"type": "integer", "minimum": 0},
                        "relation_type": {"type": "string", "enum": sorted(SUPPORTED_RELATIONS)},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                },
            },
        },
    }


@dataclass(frozen=True)
class ParsedEvidenceSpan:
    char_start: int | None
    char_end: int | None
    excerpt: str


@dataclass(frozen=True)
class ParsedClaim:
    subject_text: str
    predicate: str
    object_text: str
    modality: str
    polarity: str
    certainty: float
    time_start_utc: str | None
    time_end_utc: str | None
    subject_entity_name: str | None
    object_entity_name: str | None
    evidence_spans: list[ParsedEvidenceSpan]


@dataclass(frozen=True)
class ParsedEntity:
    name: str
    entity_type: str
    aliases: list[str]


@dataclass(frozen=True)
class ParsedClaimLink:
    from_claim_index: int
    to_claim_index: int
    relation_type: str
    confidence: float


@dataclass(frozen=True)
class ParsedClaimsOutput:
    claims: list[ParsedClaim]
    entities: list[ParsedEntity]
    links: list[ParsedClaimLink]


def parse_claims_output(payload: dict[str, Any], max_claims: int = 24) -> ParsedClaimsOutput:
    raw_claims = payload.get("claims", [])
    raw_entities = payload.get("entities", [])
    raw_links = payload.get("links", [])

    claims: list[ParsedClaim] = []
    for item in raw_claims[:max_claims]:
        if not isinstance(item, dict):
            continue
        modality = str(item.get("modality", "")).strip()
        polarity = str(item.get("polarity", "")).strip()
        if modality not in SUPPORTED_MODALITIES or polarity not in SUPPORTED_POLARITIES:
            continue
        try:
            certainty = float(item.get("certainty", 0.0))
        except (TypeError, ValueError):
            continue
        if certainty < 0 or certainty > 1:
            continue

        evidence_rows = item.get("evidence_spans", [])
        evidence_spans: list[ParsedEvidenceSpan] = []
        if isinstance(evidence_rows, list):
            for span in evidence_rows[:4]:
                if not isinstance(span, dict):
                    continue
                excerpt = str(span.get("excerpt", "")).strip()
                if not excerpt:
                    continue
                char_start = span.get("char_start")
                char_end = span.get("char_end")
                cs = int(char_start) if isinstance(char_start, int) and char_start >= 0 else None
                ce = int(char_end) if isinstance(char_end, int) and char_end >= 0 else None
                if (cs is None) != (ce is None):
                    cs, ce = None, None
                if cs is not None and ce is not None and ce <= cs:
                    cs, ce = None, None
                evidence_spans.append(
                    ParsedEvidenceSpan(
                        char_start=cs,
                        char_end=ce,
                        excerpt=excerpt[:500],
                    )
                )
        if not evidence_spans:
            continue

        subject_text = str(item.get("subject_text", "")).strip()
        predicate = str(item.get("predicate", "")).strip()
        object_text = str(item.get("object_text", "")).strip()
        if predicate not in SUPPORTED_PREDICATES:
            continue
        if not subject_text or not predicate or not object_text:
            continue

        claims.append(
            ParsedClaim(
                subject_text=subject_text[:120],
                predicate=predicate[:80],
                object_text=object_text[:1000],
                modality=modality,
                polarity=polarity,
                certainty=certainty,
                time_start_utc=(str(item.get("time_start_utc")).strip() if item.get("time_start_utc") else None),
                time_end_utc=(str(item.get("time_end_utc")).strip() if item.get("time_end_utc") else None),
                subject_entity_name=(
                    str(item.get("subject_entity_name")).strip()[:160]
                    if item.get("subject_entity_name")
                    else None
                ),
                object_entity_name=(
                    str(item.get("object_entity_name")).strip()[:160]
                    if item.get("object_entity_name")
                    else None
                ),
                evidence_spans=evidence_spans,
            )
        )

    entities: list[ParsedEntity] = []
    if isinstance(raw_entities, list):
        for item in raw_entities[:40]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            entity_type = str(item.get("entity_type", "")).strip()
            if not name or entity_type not in SUPPORTED_ENTITY_TYPES:
                continue
            aliases: list[str] = []
            raw_aliases = item.get("aliases", [])
            if isinstance(raw_aliases, list):
                for alias in raw_aliases[:10]:
                    if isinstance(alias, str) and alias.strip():
                        aliases.append(alias.strip()[:160])
            entities.append(ParsedEntity(name=name[:160], entity_type=entity_type, aliases=aliases))

    links: list[ParsedClaimLink] = []
    if isinstance(raw_links, list):
        for item in raw_links[:30]:
            if not isinstance(item, dict):
                continue
            relation_type = str(item.get("relation_type", "")).strip()
            if relation_type not in SUPPORTED_RELATIONS:
                continue
            fidx = item.get("from_claim_index")
            tidx = item.get("to_claim_index")
            if not isinstance(fidx, int) or not isinstance(tidx, int):
                continue
            try:
                confidence = float(item.get("confidence", 0.0))
            except (TypeError, ValueError):
                continue
            if confidence < 0 or confidence > 1:
                continue
            links.append(
                ParsedClaimLink(
                    from_claim_index=fidx,
                    to_claim_index=tidx,
                    relation_type=relation_type,
                    confidence=confidence,
                )
            )

    return ParsedClaimsOutput(claims=claims, entities=entities, links=links)
