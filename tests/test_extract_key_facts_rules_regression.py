import os
import sys
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
WORKER_DIR = ROOT / "apps/worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import extract_key_facts  # noqa: E402


class ExtractKeyFactsRulesRegressionTest(unittest.TestCase):
    def test_detect_predicate_with_lemma_hints(self) -> None:
        sentence = "障害対応を通して学習した内容を整理した"
        predicate, confidence = extract_key_facts.detect_predicate(sentence)
        self.assertEqual(predicate, "learned")
        self.assertGreaterEqual(confidence, 0.75)

    def test_task_bullet_prefers_next_action(self) -> None:
        row = {
            "id": "task-reg-1",
            "title": "次回対応",
            "details": "- TODO 監視閾値を更新する",
            "status": "todo",
            "priority": 2,
            "due_at": None,
            "scheduled_at": None,
            "done_at": None,
            "source_note_id": None,
        }
        facts = extract_key_facts.extract_from_task_rules(row, max_facts=12)
        predicates = {f.predicate for f in facts}
        self.assertIn("next_action", predicates)

    def test_object_type_normalization(self) -> None:
        obj_type1, obj_json1 = extract_key_facts._object_type_and_json("due_at", "2026-03-01")
        self.assertEqual(obj_type1, "date")
        self.assertIsNone(obj_json1)

        obj_type2, obj_json2 = extract_key_facts._object_type_and_json("priority", "3")
        self.assertEqual(obj_type2, "number")
        self.assertIsNotNone(obj_json2)

    def test_dedupe_normalized_key(self) -> None:
        facts = [
            extract_key_facts.Fact(subject="me", predicate="learned", object_text="retry 戦略"),
            extract_key_facts.Fact(subject="me", predicate="learned", object_text="retry戦略"),
        ]
        deduped = extract_key_facts.dedupe_facts(facts, max_facts=12)
        self.assertEqual(len(deduped), 1)

    def test_rules_fallback_without_sudachi(self) -> None:
        row = {
            "id": "note-reg-1",
            "note_type": "thought",
            "title": "簡易メモ",
            "summary": "",
            "body": "TODO: 次回は要件を確認する",
            "occurred_at": "2026-02-21T00:00:00Z",
            "journal_date": None,
            "mood_score": None,
            "energy_score": None,
            "source_url": None,
        }
        old = os.environ.get("BRAIN_DOCK_DISABLE_SUDACHI")
        os.environ["BRAIN_DOCK_DISABLE_SUDACHI"] = "1"
        try:
            facts = extract_key_facts.extract_from_note_rules(row, max_facts=12)
        finally:
            if old is None:
                os.environ.pop("BRAIN_DOCK_DISABLE_SUDACHI", None)
            else:
                os.environ["BRAIN_DOCK_DISABLE_SUDACHI"] = old
        predicates = {f.predicate for f in facts}
        self.assertIn("next_action", predicates)


if __name__ == "__main__":
    unittest.main()
