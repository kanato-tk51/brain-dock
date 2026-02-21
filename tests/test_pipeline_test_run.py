import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
PIPELINE_RUNNER = ROOT / "apps/cli/pipeline_test_run.py"


class PipelineTestRunTest(unittest.TestCase):
    def _run(self, *extra: str) -> dict:
        cmd = ["python3", str(PIPELINE_RUNNER), *extra]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return json.loads(lines[0])

    def test_runs_stage_1_to_3_for_learning_note(self) -> None:
        payload = self._run("https://example.com 記事で学んだこと")
        self.assertEqual(payload["db_mode"], "ephemeral")
        self.assertEqual(payload["capture"]["status"], "new")
        self.assertEqual(payload["process"]["errors"], 0)
        self.assertEqual(payload["extract"]["errors"], 0)
        self.assertGreaterEqual(payload["extract"]["facts_inserted"], 1)
        self.assertEqual(len(payload["preview"]["captures_raw"]), 1)
        self.assertGreaterEqual(len(payload["preview"]["notes"]), 1)

    def test_runs_stage_1_to_3_for_task(self) -> None:
        payload = self._run("--input-type", "task", "TODO: 週報を更新する")
        self.assertGreaterEqual(payload["process"]["tasks_created"], 1)
        self.assertEqual(len(payload["preview"]["tasks"]), 1)
        predicates = {item["predicate"] for item in payload["preview"]["key_facts"]}
        self.assertIn("status", predicates)

    def test_keep_db_option_persists_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "kept_pipeline.db"
            payload = self._run("--keep-db", str(db_path), "短い思考メモ")
            self.assertEqual(payload["db_mode"], "kept")
            self.assertEqual(payload["db_path"], str(db_path.resolve()))
            self.assertTrue(db_path.exists())


if __name__ == "__main__":
    unittest.main()
