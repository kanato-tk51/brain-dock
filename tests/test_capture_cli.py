import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
SCHEMA_SQL = ROOT / "schemas/sql/001_core.sql"
CAPTURE_CLI = ROOT / "apps/cli/capture.py"


class CaptureCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "brain_dock.db"
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def run_cli(self, *args: str, input_text: str | None = None) -> dict:
        cmd = ["python3", str(CAPTURE_CLI), "--db", str(self.db_path), *args]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            input=input_text,
        )
        return json.loads(result.stdout.strip())

    def test_inserts_capture_and_reuses_source(self) -> None:
        out1 = self.run_cli(
            "--source-kind",
            "cli",
            "--source-detail",
            "unit-test",
            "--occurred-at",
            "2026-02-21T12:00:00Z",
            "今日の学びをメモ",
        )
        self.assertEqual(out1["status"], "new")
        self.assertEqual(out1["input_type"], "note")
        self.assertTrue(out1["source_created"])
        self.assertGreater(out1["text_length"], 0)

        out2 = self.run_cli(
            "--source-kind",
            "cli",
            "--source-detail",
            "unit-test",
            "次のメモ",
        )
        self.assertFalse(out2["source_created"])

        sources = self.conn.execute(
            "SELECT COUNT(*) AS c FROM sources WHERE kind = 'cli' AND detail = 'unit-test'"
        ).fetchone()["c"]
        self.assertEqual(sources, 1)

        cap = self.conn.execute(
            "SELECT input_type, raw_text, occurred_at, sensitivity, status FROM captures_raw ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(cap)
        self.assertEqual(cap["input_type"], "note")
        self.assertEqual(cap["occurred_at"], "2026-02-21T12:00:00Z")
        self.assertEqual(cap["sensitivity"], "internal")
        self.assertEqual(cap["status"], "new")

    def test_stdin_auto_detects_task(self) -> None:
        out = self.run_cli("--stdin", input_text="TODO: PRレビューをする p1")
        self.assertEqual(out["input_type"], "task")

        row = self.conn.execute(
            "SELECT raw_text, input_type FROM captures_raw LIMIT 1"
        ).fetchone()
        self.assertEqual(row["input_type"], "task")
        self.assertIn("TODO", row["raw_text"])

    def test_dry_run_writes_nothing(self) -> None:
        out = self.run_cli("--dry-run", "dry run capture")
        self.assertTrue(out["dry_run"])

        source_count = self.conn.execute("SELECT COUNT(*) AS c FROM sources").fetchone()["c"]
        capture_count = self.conn.execute("SELECT COUNT(*) AS c FROM captures_raw").fetchone()["c"]
        self.assertEqual(source_count, 0)
        self.assertEqual(capture_count, 0)


if __name__ == "__main__":
    unittest.main()
