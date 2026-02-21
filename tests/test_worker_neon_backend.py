import subprocess
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
PROCESS_CAPTURES = ROOT / "apps/worker/process_captures.py"
EXTRACT_KEY_FACTS = ROOT / "apps/worker/extract_key_facts.py"


class WorkerNeonBackendTest(unittest.TestCase):
    def run_cmd(self, *cmd: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(cmd),
            cwd=ROOT,
            capture_output=True,
            text=True,
        )

    def test_process_captures_requires_neon_dsn(self) -> None:
        result = self.run_cmd(
            "python3",
            str(PROCESS_CAPTURES),
            "--backend",
            "neon",
            "--limit",
            "1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--neon-dsn is required", result.stderr)

    def test_extract_key_facts_requires_neon_dsn(self) -> None:
        result = self.run_cmd(
            "python3",
            str(EXTRACT_KEY_FACTS),
            "--backend",
            "neon",
            "--source",
            "notes",
            "--limit",
            "1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--neon-dsn is required", result.stderr)


if __name__ == "__main__":
    unittest.main()
