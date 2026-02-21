import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
SCHEMA_SQL = ROOT / "schemas/sql/001_core.sql"
WORKER = ROOT / "apps/worker/extract_key_facts.py"


class ExtractKeyFactsTest(unittest.TestCase):
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
            INSERT INTO notes (
              id, note_type, title, summary, body, occurred_at, source_id, sensitivity
            ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
            """,
            (
                "note-1",
                "learning",
                "Retry戦略の学び",
                "バックオフ戦略を学んだ",
                "今日は障害対応で retry with exponential backoff を学んだ。次回も使う。",
                "src-1",
                "internal",
            ),
        )
        self.conn.execute(
            """
            INSERT INTO tasks (
              id, source_note_id, title, details, status, priority, due_at, source, sensitivity
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 day'), ?, ?)
            """,
            (
                "task-1",
                "note-1",
                "リリースチェックを更新する",
                "次回のリリース前にチェックリストを改善する",
                "todo",
                2,
                "manual",
                "internal",
            ),
        )
        self.conn.commit()

    def run_worker(self, *extra_args: str) -> dict:
        cmd = [
            "python3",
            str(WORKER),
            "--db",
            str(self.db_path),
            "--all-rows",
            "--replace-existing",
            *extra_args,
        ]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout.strip())

    def test_extracts_facts_for_notes_and_tasks(self) -> None:
        output = self.run_worker("--source", "all")
        self.assertGreater(output["facts_inserted"], 0)

        count = self.conn.execute("SELECT COUNT(*) FROM key_facts WHERE deleted_at IS NULL").fetchone()[0]
        self.assertGreater(count, 0)

        predicates = {
            row[0]
            for row in self.conn.execute(
                "SELECT predicate FROM key_facts WHERE deleted_at IS NULL"
            ).fetchall()
        }
        self.assertIn("learned", predicates)
        self.assertIn("summary", predicates)
        self.assertIn("status", predicates)

    def test_dry_run_does_not_write(self) -> None:
        output = self.run_worker("--source", "notes", "--dry-run")
        self.assertGreaterEqual(output["facts_inserted"], 0)

        count = self.conn.execute("SELECT COUNT(*) FROM key_facts").fetchone()[0]
        self.assertEqual(count, 0)


if __name__ == "__main__":
    unittest.main()
