import os
import sys
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
WORKER_DIR = ROOT / "apps/worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

import process_captures  # noqa: E402


class ProcessCapturesRulesRegressionTest(unittest.TestCase):
    def test_task_detection_for_todo(self) -> None:
        result = process_captures.classify_capture("quick", "TODO: 週報を更新する")
        self.assertTrue(result["is_task"])

    def test_learning_detection_for_url_only(self) -> None:
        result = process_captures.classify_capture("note", "https://example.com/learning")
        self.assertFalse(result["is_task"])
        self.assertEqual(result["note_type"], "learning")

    def test_journal_detection_for_daily_log(self) -> None:
        result = process_captures.classify_capture(
            "note",
            "今日の振り返り。mood:4 energy:3 体調は安定。",
        )
        self.assertFalse(result["is_task"])
        self.assertEqual(result["note_type"], "journal")

    def test_ambiguous_short_text_defaults_to_thought(self) -> None:
        result = process_captures.classify_capture("note", "メモ")
        self.assertFalse(result["is_task"])
        self.assertEqual(result["note_type"], "thought")

    def test_regex_only_fallback_when_sudachi_disabled(self) -> None:
        old = os.environ.get("BRAIN_DOCK_DISABLE_SUDACHI")
        os.environ["BRAIN_DOCK_DISABLE_SUDACHI"] = "1"
        try:
            result = process_captures.classify_capture("quick", "TODO: リリース準備")
        finally:
            if old is None:
                os.environ.pop("BRAIN_DOCK_DISABLE_SUDACHI", None)
            else:
                os.environ["BRAIN_DOCK_DISABLE_SUDACHI"] = old
        self.assertTrue(result["is_task"])


if __name__ == "__main__":
    unittest.main()
