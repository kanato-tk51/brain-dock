#!/usr/bin/env python3
"""Structured output schema v2 for fact-centric claim extraction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


SUPPORTED_MODALITIES = {"fact", "plan", "hypothesis", "request", "feeling"}
SUPPORTED_POLARITIES = {"affirm", "negate"}
SUPPORTED_RELATIONS = {"supports", "contradicts", "caused_by", "follow_up", "same_event"}
SUPPORTED_ENTITY_TYPES = {"person", "organization", "project", "place", "concept", "other"}
SUPPORTED_ME_ROLES = {"actor", "experiencer", "observer", "recipient", "none"}
SUPPORTED_DIMENSION_TYPES = {
    "person",
    "place",
    "activity",
    "emotion",
    "health",
    "topic",
    "project",
    "item",
    "reason",
    "time_hint",
}
SUPPORTED_DIMENSION_SOURCES = {"llm", "rule", "manual"}
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
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "subject_text",
                        "predicate",
                        "object_text_raw",
                        "object_text_canonical",
                        "me_role",
                        "modality",
                        "polarity",
                        "certainty",
                        "time_start_utc",
                        "time_end_utc",
                        "subject_entity_name",
                        "object_entity_name",
                        "dimensions",
                        "evidence_spans",
                    ],
                    "properties": {
                        "subject_text": {"type": "string", "minLength": 1, "maxLength": 120},
                        "predicate": {"type": "string", "enum": sorted(SUPPORTED_PREDICATES)},
                        "object_text_raw": {"type": "string", "minLength": 1, "maxLength": 1000},
                        "object_text_canonical": {"type": "string", "minLength": 1, "maxLength": 1000},
                        "me_role": {"type": "string", "enum": sorted(SUPPORTED_ME_ROLES)},
                        "modality": {"type": "string", "enum": sorted(SUPPORTED_MODALITIES)},
                        "polarity": {"type": "string", "enum": sorted(SUPPORTED_POLARITIES)},
                        "certainty": {"type": "number", "minimum": 0, "maximum": 1},
                        "time_start_utc": {"type": ["string", "null"], "maxLength": 40},
                        "time_end_utc": {"type": ["string", "null"], "maxLength": 40},
                        "subject_entity_name": {"type": ["string", "null"], "maxLength": 160},
                        "object_entity_name": {"type": ["string", "null"], "maxLength": 160},
                        "dimensions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["dimension_type", "dimension_value", "confidence", "source"],
                                "properties": {
                                    "dimension_type": {
                                        "type": "string",
                                        "enum": sorted(SUPPORTED_DIMENSION_TYPES),
                                    },
                                    "dimension_value": {"type": "string", "minLength": 1, "maxLength": 200},
                                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                                    "source": {
                                        "type": "string",
                                        "enum": sorted(SUPPORTED_DIMENSION_SOURCES),
                                    },
                                },
                            },
                        },
                        "evidence_spans": {
                            "type": "array",
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
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "entity_type", "aliases"],
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 160},
                        "entity_type": {"type": "string", "enum": sorted(SUPPORTED_ENTITY_TYPES)},
                        "aliases": {
                            "type": "array",
                            "items": {"type": "string", "minLength": 1, "maxLength": 160},
                        },
                    },
                },
            },
            "links": {
                "type": "array",
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
class ParsedDimension:
    dimension_type: str
    dimension_value: str
    confidence: float
    source: str


@dataclass(frozen=True)
class ParsedClaim:
    subject_text: str
    predicate: str
    object_text_raw: str = ""
    object_text_canonical: str = ""
    me_role: str = "none"
    modality: str = "fact"
    polarity: str = "affirm"
    certainty: float = 0.5
    time_start_utc: str | None = None
    time_end_utc: str | None = None
    subject_entity_name: str | None = None
    object_entity_name: str | None = None
    dimensions: list[ParsedDimension] | None = None
    evidence_spans: list[ParsedEvidenceSpan] | None = None
    object_text: str = ""

    def __post_init__(self) -> None:
        dims = self.dimensions if self.dimensions is not None else []
        spans = self.evidence_spans if self.evidence_spans is not None else []
        object.__setattr__(self, "dimensions", dims)
        object.__setattr__(self, "evidence_spans", spans)

        raw = self.object_text_raw or self.object_text
        canonical = self.object_text_canonical or raw
        object.__setattr__(self, "object_text_raw", raw[:1000])
        object.__setattr__(self, "object_text_canonical", canonical[:1000])
        object.__setattr__(self, "object_text", canonical[:1000])

        if self.me_role not in SUPPORTED_ME_ROLES:
            object.__setattr__(self, "me_role", "none")


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


def parse_claims_output(payload: dict[str, Any]) -> ParsedClaimsOutput:
    raw_claims = payload.get("claims", [])
    raw_entities = payload.get("entities", [])
    raw_links = payload.get("links", [])

    claims: list[ParsedClaim] = []
    for item in raw_claims:
        if not isinstance(item, dict):
            continue
        modality = str(item.get("modality", "")).strip()
        polarity = str(item.get("polarity", "")).strip()
        me_role = str(item.get("me_role", "")).strip()
        if (
            modality not in SUPPORTED_MODALITIES
            or polarity not in SUPPORTED_POLARITIES
            or me_role not in SUPPORTED_ME_ROLES
        ):
            continue

        try:
            certainty = float(item.get("certainty", 0.0))
        except (TypeError, ValueError):
            continue
        if certainty < 0 or certainty > 1:
            continue

        subject_text = str(item.get("subject_text", "")).strip()
        predicate = str(item.get("predicate", "")).strip()
        object_text_raw = str(item.get("object_text_raw", item.get("object_text", ""))).strip()
        object_text_canonical = str(item.get("object_text_canonical", object_text_raw)).strip()
        if predicate not in SUPPORTED_PREDICATES:
            continue
        if not subject_text or not object_text_raw or not object_text_canonical:
            continue

        evidence_rows = item.get("evidence_spans", [])
        evidence_spans: list[ParsedEvidenceSpan] = []
        if isinstance(evidence_rows, list):
            for span in evidence_rows:
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

        dimensions: list[ParsedDimension] = []
        raw_dimensions = item.get("dimensions", [])
        if isinstance(raw_dimensions, list):
            for dim in raw_dimensions:
                if not isinstance(dim, dict):
                    continue
                dim_type = str(dim.get("dimension_type", "")).strip()
                dim_value = str(dim.get("dimension_value", "")).strip()
                dim_source = str(dim.get("source", "llm")).strip()
                if (
                    dim_type not in SUPPORTED_DIMENSION_TYPES
                    or not dim_value
                    or dim_source not in SUPPORTED_DIMENSION_SOURCES
                ):
                    continue
                try:
                    dim_conf = float(dim.get("confidence", 0.0))
                except (TypeError, ValueError):
                    continue
                if dim_conf < 0 or dim_conf > 1:
                    continue
                dimensions.append(
                    ParsedDimension(
                        dimension_type=dim_type,
                        dimension_value=dim_value[:200],
                        confidence=dim_conf,
                        source=dim_source,
                    )
                )

        claims.append(
            ParsedClaim(
                subject_text=subject_text[:120],
                predicate=predicate[:80],
                object_text_raw=object_text_raw[:1000],
                object_text_canonical=object_text_canonical[:1000],
                me_role=me_role,
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
                dimensions=dimensions,
                evidence_spans=evidence_spans,
            )
        )

    entities: list[ParsedEntity] = []
    if isinstance(raw_entities, list):
        for item in raw_entities:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            entity_type = str(item.get("entity_type", "")).strip()
            if not name or entity_type not in SUPPORTED_ENTITY_TYPES:
                continue
            aliases: list[str] = []
            raw_aliases = item.get("aliases", [])
            if isinstance(raw_aliases, list):
                for alias in raw_aliases:
                    if isinstance(alias, str) and alias.strip():
                        aliases.append(alias.strip()[:160])
            entities.append(ParsedEntity(name=name[:160], entity_type=entity_type, aliases=aliases))

    links: list[ParsedClaimLink] = []
    if isinstance(raw_links, list):
        for item in raw_links:
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
