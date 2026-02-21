import json
import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
CAPTURE_CLI = ROOT / "apps/cli/capture.py"


class CaptureCliNeonTest(unittest.TestCase):
    def run_cli(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        run_env = os.environ.copy()
        if env:
            run_env.update(env)
        cmd = ["python3", str(CAPTURE_CLI), *args]
        return subprocess.run(
            cmd,
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=run_env,
        )

    def test_neon_backend_requires_dsn(self) -> None:
        result = self.run_cli("--backend", "neon", "test neon")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--neon-dsn is required", result.stderr)

    def test_neon_dry_run_works_with_env_dsn(self) -> None:
        result = self.run_cli(
            "--backend",
            "neon",
            "--dry-run",
            "dry run neon",
            env={"NEON_DATABASE_URL": "postgresql://user:pass@localhost:5432/db"},
        )
        self.assertEqual(result.returncode, 0)
        output = json.loads(result.stdout.strip())
        self.assertEqual(output["backend"], "neon")
        self.assertTrue(output["dry_run"])
        self.assertEqual(output["input_type"], "note")


if __name__ == "__main__":
    unittest.main()
