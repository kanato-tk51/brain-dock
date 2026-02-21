import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
SCHEMA_SQL = ROOT / "schemas/sql/001_core.sql"
WORKER = ROOT / "apps/worker/process_captures.py"


class ProcessCapturesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "brain_dock.db"
        self.conn = sqlite3.connect(self.db_path)
        schema = SCHEMA_SQL.read_text(encoding="utf-8")
        self.conn.executescript(schema)
        self.seed_data()

    def tearDown(self) -> None:
        self.conn.close()
        self.tmpdir.cleanup()

    def seed_data(self) -> None:
        self.conn.execute(
            "INSERT INTO sources (id, kind, detail) VALUES (?, ?, ?)",
            ("src-1", "cli", "test"),
        )
        self.conn.execute(
            """
            INSERT INTO captures_raw (
              id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status
            ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
            """,
            (
                "cap-note",
                "src-1",
                "note",
                "今日の振り返り。mood:4 energy:3 先延ばしを減らせた。",
                "internal",
                0.0,
                "new",
            ),
        )
        self.conn.execute(
            """
            INSERT INTO captures_raw (
              id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status
            ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
            """,
            (
                "cap-task",
                "src-1",
                "quick",
                "TODO: PRレビューをする p1",
                "internal",
                0.0,
                "new",
            ),
        )
        self.conn.execute(
            """
            INSERT INTO captures_raw (
              id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status
            ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
            """,
            (
                "cap-url",
                "src-1",
                "url",
                "https://example.com/llm-memory この記事で学んだことをメモ",
                "internal",
                0.0,
                "new",
            ),
        )
        self.conn.execute(
            """
            INSERT INTO captures_raw (
              id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status
            ) VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
            """,
            (
                "cap-block",
                "src-1",
                "note",
                "秘密っぽい情報",
                "internal",
                0.95,
                "new",
            ),
        )
        self.conn.commit()

    def run_worker(self, *extra_args: str) -> dict:
        cmd = ["python3", str(WORKER), "--db", str(self.db_path), *extra_args]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout.strip())

    def test_processes_new_captures(self) -> None:
        output = self.run_worker()
        self.assertEqual(output["notes_created"], 2)
        self.assertEqual(output["tasks_created"], 1)
        self.assertEqual(output["captures_blocked"], 1)
        self.assertEqual(output["errors"], 0)

        notes = self.conn.execute("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL").fetchone()[0]
        tasks = self.conn.execute("SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL").fetchone()[0]
        self.assertEqual(notes, 2)
        self.assertEqual(tasks, 1)

        statuses = {
            row[0]: row[1]
            for row in self.conn.execute("SELECT id, status FROM captures_raw").fetchall()
        }
        self.assertEqual(statuses["cap-note"], "processed")
        self.assertEqual(statuses["cap-task"], "processed")
        self.assertEqual(statuses["cap-url"], "processed")
        self.assertEqual(statuses["cap-block"], "blocked")

    def test_dry_run_does_not_write(self) -> None:
        output = self.run_worker("--dry-run")
        self.assertGreaterEqual(output["captures_processed"], 1)

        notes = self.conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
        tasks = self.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
        self.assertEqual(notes, 0)
        self.assertEqual(tasks, 0)

        new_count = self.conn.execute(
            "SELECT COUNT(*) FROM captures_raw WHERE status = 'new'"
        ).fetchone()[0]
        self.assertEqual(new_count, 4)


if __name__ == "__main__":
    unittest.main()
