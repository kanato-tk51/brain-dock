#!/usr/bin/env python3
"""Evaluate rule quality on local gold fixtures."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
WORKER_DIR = ROOT / "apps" / "worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import extract_key_facts  # noqa: E402
import process_captures  # noqa: E402


CLASS_LABELS = ["task", "journal", "learning", "thought"]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def classification_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    stats = {label: {"tp": 0, "fp": 0, "fn": 0} for label in CLASS_LABELS}
    correct = 0
    for row in rows:
        text = str(row["text"])
        input_type = str(row.get("input_type", "note"))
        expected = str(row["expected_label"])

        pred_result = process_captures.classify_capture(input_type, text)
        predicted = "task" if pred_result["is_task"] else pred_result["note_type"]
        if predicted == expected:
            correct += 1

        for label in CLASS_LABELS:
            if predicted == label and expected == label:
                stats[label]["tp"] += 1
            elif predicted == label and expected != label:
                stats[label]["fp"] += 1
            elif predicted != label and expected == label:
                stats[label]["fn"] += 1

    per_class: dict[str, dict[str, float]] = {}
    f1_sum = 0.0
    for label in CLASS_LABELS:
        tp = stats[label]["tp"]
        fp = stats[label]["fp"]
        fn = stats[label]["fn"]
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        f1_sum += f1
        per_class[label] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
        }

    macro_f1 = f1_sum / len(CLASS_LABELS)
    accuracy = correct / len(rows) if rows else 0.0
    return {
        "samples": len(rows),
        "accuracy": round(accuracy, 4),
        "macro_f1": round(macro_f1, 4),
        "per_class": per_class,
    }


def _build_note_row(text: str, note_id: str) -> dict[str, Any]:
    return {
        "id": note_id,
        "note_type": "thought",
        "title": "",
        "summary": "",
        "body": text,
        "occurred_at": "2026-02-21T00:00:00Z",
        "journal_date": None,
        "mood_score": None,
        "energy_score": None,
        "source_url": None,
    }


def _build_task_row(text: str, task_id: str) -> dict[str, Any]:
    return {
        "id": task_id,
        "title": text,
        "details": text,
        "status": "todo",
        "priority": 2,
        "due_at": None,
        "scheduled_at": None,
        "done_at": None,
        "source_note_id": None,
    }


def facts_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    predicate_hits = 0
    object_hits = 0
    total_fact_count = 0
    normalized_keys: set[tuple[str, str, str]] = set()

    for idx, row in enumerate(rows, start=1):
        text = str(row["text"])
        item_type = str(row.get("item_type", "note"))
        expected = row["expected"]
        expected_predicate = str(expected["predicate"])
        expected_object_contains = str(expected.get("object_contains", "")).strip()

        if item_type == "task":
            sample_row = _build_task_row(text, f"task-eval-{idx}")
            facts = extract_key_facts.extract_from_task_rules(sample_row, max_facts=12)
        else:
            sample_row = _build_note_row(text, f"note-eval-{idx}")
            facts = extract_key_facts.extract_from_note_rules(sample_row, max_facts=12)

        total_fact_count += len(facts)
        for fact in facts:
            normalized_keys.add(
                (
                    fact.subject.strip().lower(),
                    fact.predicate.strip().lower(),
                    extract_key_facts._normalize_for_dedupe(fact.object_text),
                )
            )

        pred_matches = [f for f in facts if f.predicate == expected_predicate]
        if pred_matches:
            predicate_hits += 1

        if expected_object_contains:
            lowered = expected_object_contains.lower()
            if any(lowered in f.object_text.lower() for f in pred_matches):
                object_hits += 1
        elif pred_matches:
            object_hits += 1

    samples = len(rows)
    predicate_precision = predicate_hits / samples if samples else 0.0
    object_match_rate = object_hits / samples if samples else 0.0
    duplicate_rate = 0.0
    if total_fact_count > 0:
        duplicate_rate = (total_fact_count - len(normalized_keys)) / total_fact_count

    return {
        "samples": samples,
        "predicate_precision": round(predicate_precision, 4),
        "object_match_rate": round(object_match_rate, 4),
        "duplicate_rate": round(duplicate_rate, 4),
        "facts_total": total_fact_count,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate local rule quality.")
    parser.add_argument(
        "--captures-labels",
        default="tests/fixtures/gold/process_captures_labels.jsonl",
        help="Gold labels for capture classification",
    )
    parser.add_argument(
        "--facts-labels",
        default="tests/fixtures/gold/key_facts_labels.jsonl",
        help="Gold labels for key fact extraction",
    )
    parser.add_argument("--min-macro-f1", type=float, default=0.80)
    parser.add_argument("--min-predicate-precision", type=float, default=0.85)
    parser.add_argument("--max-duplicate-rate", type=float, default=0.05)
    parser.add_argument("--expected-captures-samples", type=int, default=100)
    parser.add_argument("--expected-facts-samples", type=int, default=100)
    parser.add_argument("--enforce", action="store_true", help="Exit non-zero when thresholds fail")
    args = parser.parse_args()

    captures = load_jsonl(ROOT / args.captures_labels)
    facts = load_jsonl(ROOT / args.facts_labels)

    captures_metrics = classification_metrics(captures)
    facts_metrics_payload = facts_metrics(facts)
    report = {
        "captures": captures_metrics,
        "facts": facts_metrics_payload,
        "thresholds": {
            "min_macro_f1": args.min_macro_f1,
            "min_predicate_precision": args.min_predicate_precision,
            "max_duplicate_rate": args.max_duplicate_rate,
            "expected_captures_samples": args.expected_captures_samples,
            "expected_facts_samples": args.expected_facts_samples,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if args.enforce:
        if captures_metrics["samples"] != args.expected_captures_samples:
            return 1
        if facts_metrics_payload["samples"] != args.expected_facts_samples:
            return 1
        if captures_metrics["macro_f1"] < args.min_macro_f1:
            return 1
        if facts_metrics_payload["predicate_precision"] < args.min_predicate_precision:
            return 1
        if facts_metrics_payload["duplicate_rate"] > args.max_duplicate_rate:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
