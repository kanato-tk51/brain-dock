import json
import os
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib import parse as urlparse


ROOT = Path("/Users/takahashikanato/brain-dock")
CAPTURE_CLI = ROOT / "apps/cli/capture.py"


class _FakeSupabaseState:
    def __init__(self) -> None:
        self.sources: dict[str, dict] = {}
        self.captures: dict[str, dict] = {}
        self._seq = 0

    def next_created_at(self) -> str:
        self._seq += 1
        return f"2026-02-21T00:00:{self._seq:02d}Z"


class _FakeSupabaseHandler(BaseHTTPRequestHandler):
    state: _FakeSupabaseState

    def _send_json(self, code: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        content_len = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(content_len).decode("utf-8")
        data = json.loads(raw) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("expected JSON object")
        return data

    @staticmethod
    def _parse_eq(value: str) -> str:
        if value.startswith("eq."):
            return value[3:]
        return value

    def do_GET(self) -> None:  # noqa: N802
        parts = urlparse.urlsplit(self.path)
        if parts.path != "/rest/v1/sources":
            self._send_json(404, {"error": "not found"})
            return

        query = urlparse.parse_qs(parts.query)
        rows = list(self.state.sources.values())

        if "id" in query and query["id"]:
            target = self._parse_eq(query["id"][0])
            rows = [row for row in rows if row.get("id") == target]
        if "kind" in query and query["kind"]:
            target = self._parse_eq(query["kind"][0])
            rows = [row for row in rows if row.get("kind") == target]
        if "detail" in query and query["detail"]:
            target = self._parse_eq(query["detail"][0])
            rows = [row for row in rows if row.get("detail", "") == target]

        if query.get("order") == ["created_at.asc"]:
            rows.sort(key=lambda r: str(r.get("created_at", "")))

        if "limit" in query and query["limit"]:
            try:
                limit = int(query["limit"][0])
            except ValueError:
                limit = len(rows)
            rows = rows[: max(0, limit)]

        select_cols = None
        if "select" in query and query["select"]:
            select_cols = [v.strip() for v in query["select"][0].split(",") if v.strip()]

        if select_cols:
            rows = [{k: row.get(k) for k in select_cols if k in row} for row in rows]

        self._send_json(200, rows)

    def do_POST(self) -> None:  # noqa: N802
        parts = urlparse.urlsplit(self.path)
        if parts.path == "/rest/v1/sources":
            data = self._read_json()
            source_id = str(data["id"])
            current = self.state.sources.get(source_id, {})
            merged = {**current, **data}
            if "created_at" not in merged:
                merged["created_at"] = self.state.next_created_at()
            self.state.sources[source_id] = merged
            self._send_json(201, [merged])
            return

        if parts.path == "/rest/v1/captures_raw":
            data = self._read_json()
            capture_id = str(data["id"])
            if "created_at" not in data:
                data["created_at"] = self.state.next_created_at()
            self.state.captures[capture_id] = data
            self._send_json(201, [data])
            return

        self._send_json(404, {"error": "not found"})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


class CaptureCliSupabaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.state = _FakeSupabaseState()
        _FakeSupabaseHandler.state = self.state
        self.server = HTTPServer(("127.0.0.1", 0), _FakeSupabaseHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def run_cli(self, *args: str, input_text: str | None = None) -> dict:
        env = os.environ.copy()
        env["SUPABASE_SERVICE_ROLE_KEY"] = "dummy-test-key"
        cmd = [
            "python3",
            str(CAPTURE_CLI),
            "--backend",
            "supabase",
            "--supabase-url",
            self.base_url,
            *args,
        ]
        result = subprocess.run(
            cmd,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            input=input_text,
            env=env,
        )
        return json.loads(result.stdout.strip())

    def test_supabase_insert_and_source_reuse(self) -> None:
        out1 = self.run_cli("--source-kind", "cli", "--source-detail", "webhook", "今日の学び")
        out2 = self.run_cli("--source-kind", "cli", "--source-detail", "webhook", "次の学び")

        self.assertTrue(out1["source_created"])
        self.assertFalse(out2["source_created"])
        self.assertEqual(out1["source_id"], out2["source_id"])
        self.assertEqual(len(self.state.sources), 1)
        self.assertEqual(len(self.state.captures), 2)

    def test_supabase_stdin_task_and_dry_run(self) -> None:
        out = self.run_cli("--stdin", input_text="TODO: PRレビューをする p1")
        self.assertEqual(out["input_type"], "task")
        self.assertEqual(len(self.state.captures), 1)

        out_dry = self.run_cli("--dry-run", "dry run")
        self.assertTrue(out_dry["dry_run"])
        self.assertEqual(len(self.state.captures), 1)


if __name__ == "__main__":
    unittest.main()
