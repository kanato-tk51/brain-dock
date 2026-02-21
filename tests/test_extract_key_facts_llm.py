import json
import os
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
SCHEMA_SQL = ROOT / "schemas/sql/001_core.sql"
WORKER = ROOT / "apps/worker/extract_key_facts.py"


class _FakeLLMHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/chat/completions":
            self.send_response(404)
            self.end_headers()
            return

        content_len = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(content_len)

        body = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "facts": [
                                    {
                                        "subject": "me",
                                        "predicate": "learned",
                                        "object_text": "retry with exponential backoff",
                                        "object_type": "text",
                                        "confidence": 0.93,
                                        "evidence_excerpt": "retry with exponential backoff を学んだ",
                                    },
                                    {
                                        "subject": "me",
                                        "predicate": "next_action",
                                        "object_text": "次回も使う",
                                        "object_type": "text",
                                        "confidence": 0.8,
                                    },
                                ]
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ]
        }
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


class ExtractKeyFactsLLMTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "brain_dock.db"
        self.conn = sqlite3.connect(self.db_path)
        self.conn.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
        self.seed_data()

        self.server = HTTPServer(("127.0.0.1", 0), _FakeLLMHandler)
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
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
                "note-llm-1",
                "learning",
                "LLM学習メモ",
                "バックオフ戦略",
                "retry with exponential backoff を学んだ。次回も使う。",
                "src-1",
                "internal",
            ),
        )
        self.conn.commit()

    def test_llm_extractor_writes_facts(self) -> None:
        base_url = f"http://127.0.0.1:{self.server.server_port}"
        env = os.environ.copy()
        env["OPENAI_API_KEY"] = "dummy-key"

        cmd = [
            "python3",
            str(WORKER),
            "--db",
            str(self.db_path),
            "--source",
            "notes",
            "--all-rows",
            "--replace-existing",
            "--extractor",
            "llm",
            "--llm-base-url",
            base_url,
        ]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        output = json.loads(result.stdout.strip())

        self.assertEqual(output["extractor"], "llm")
        self.assertEqual(output["errors"], 0)
        self.assertGreater(output["facts_inserted"], 0)

        predicates = {
            row[0]
            for row in self.conn.execute(
                "SELECT predicate FROM key_facts WHERE deleted_at IS NULL"
            ).fetchall()
        }
        self.assertIn("learned", predicates)
        self.assertIn("next_action", predicates)


if __name__ == "__main__":
    unittest.main()
