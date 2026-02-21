#!/usr/bin/env python3
"""Japanese NLP helpers with safe fallback when Sudachi is unavailable."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Any


DISABLE_ENV = "BRAIN_DOCK_DISABLE_SUDACHI"


@dataclass(frozen=True)
class MorphToken:
    surface: str
    lemma: str
    pos: str


def _disabled() -> bool:
    return os.environ.get(DISABLE_ENV) == "1"


@lru_cache(maxsize=1)
def _load_tokenizer() -> Any | None:
    if _disabled():
        return None
    try:
        from sudachipy import dictionary, tokenizer
    except Exception:
        return None

    try:
        return dictionary.Dictionary().create(tokenizer.Tokenizer.SplitMode.C)
    except Exception:
        return None


def sudachi_available() -> bool:
    if _disabled():
        return False
    return _load_tokenizer() is not None


def tokenize_with_lemma(text: str) -> list[MorphToken]:
    if not text.strip():
        return []
    if _disabled():
        return []

    tokenizer = _load_tokenizer()
    if tokenizer is None:
        return []

    try:
        morphemes = tokenizer.tokenize(text)
    except Exception:
        return []

    out: list[MorphToken] = []
    for m in morphemes:
        surface = m.surface()
        lemma = m.dictionary_form()
        if not lemma or lemma == "*":
            lemma = surface
        pos_parts = m.part_of_speech()
        pos = ",".join(pos_parts[:2]) if pos_parts else ""
        out.append(MorphToken(surface=surface, lemma=lemma, pos=pos))
    return out
