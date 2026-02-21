import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
EVAL_SCRIPT = ROOT / "scripts/eval/eval_rules.py"


class EvalRulesTest(unittest.TestCase):
    def test_eval_script_outputs_metrics_and_passes_thresholds(self) -> None:
        result = subprocess.run(
            ["python3", str(EVAL_SCRIPT), "--enforce"],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)
        self.assertGreaterEqual(payload["captures"]["macro_f1"], 0.80)
        self.assertGreaterEqual(payload["facts"]["predicate_precision"], 0.85)
        self.assertLessEqual(payload["facts"]["duplicate_rate"], 0.05)


if __name__ == "__main__":
    unittest.main()
