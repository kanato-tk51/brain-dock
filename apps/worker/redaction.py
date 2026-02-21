#!/usr/bin/env python3
"""PII scoring + masking helpers for LLM-safe extraction."""

from __future__ import annotations

import re
from dataclasses import dataclass


SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{12,}"
    ),
]
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"\+?\d[\d\-\s()]{8,}\d")
POSTAL_RE = re.compile(r"\b\d{3}-\d{4}\b")


@dataclass(frozen=True)
class RedactionResult:
    original_text: str
    llm_text: str
    pii_score: float
    risk_level: str
    redaction_state: str


def estimate_pii_score(text: str) -> float:
    score = 0.0
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            score = max(score, 0.95)
    if EMAIL_RE.search(text):
        score = max(score, 0.55)
    if PHONE_RE.search(text):
        score = max(score, 0.65)
    if POSTAL_RE.search(text):
        score = max(score, 0.70)
    return min(score, 1.0)


def classify_risk(pii_score: float) -> str:
    if pii_score >= 0.90:
        return "high"
    if pii_score >= 0.50:
        return "medium"
    return "low"


def _mask_with_same_length(text: str, pattern: re.Pattern[str]) -> str:
    def repl(match: re.Match[str]) -> str:
        return "█" * len(match.group(0))

    return pattern.sub(repl, text)


def mask_text(text: str) -> str:
    masked = text
    for pattern in SECRET_PATTERNS:
        masked = _mask_with_same_length(masked, pattern)
    masked = _mask_with_same_length(masked, EMAIL_RE)
    masked = _mask_with_same_length(masked, PHONE_RE)
    masked = _mask_with_same_length(masked, POSTAL_RE)
    return masked


def redact_for_llm(text: str) -> RedactionResult:
    pii_score = estimate_pii_score(text)
    risk_level = classify_risk(pii_score)
    if risk_level == "high":
        return RedactionResult(
            original_text=text,
            llm_text="",
            pii_score=pii_score,
            risk_level=risk_level,
            redaction_state="blocked",
        )
    if risk_level == "medium":
        return RedactionResult(
            original_text=text,
            llm_text=mask_text(text),
            pii_score=pii_score,
            risk_level=risk_level,
            redaction_state="masked",
        )
    return RedactionResult(
        original_text=text,
        llm_text=text,
        pii_score=pii_score,
        risk_level=risk_level,
        redaction_state="none",
    )
