import sys
import unittest
from pathlib import Path


ROOT = Path("/Users/takahashikanato/brain-dock")
WORKER_DIR = ROOT / "apps/worker"
if str(WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(WORKER_DIR))

from claim_schema import claims_response_schema  # noqa: E402


def _assert_all_properties_are_required(node: dict) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "object":
        properties = node.get("properties")
        if isinstance(properties, dict) and properties:
            required = node.get("required")
            if isinstance(required, list):
                missing = [key for key in properties.keys() if key not in required]
                if missing:
                    raise AssertionError(f"missing required keys for strict schema: {missing}")

    properties = node.get("properties")
    if isinstance(properties, dict):
        for value in properties.values():
            if isinstance(value, dict):
                _assert_all_properties_are_required(value)

    items = node.get("items")
    if isinstance(items, dict):
        _assert_all_properties_are_required(items)


class ClaimSchemaTest(unittest.TestCase):
    def test_strict_response_schema_has_required_for_all_properties(self) -> None:
        schema = claims_response_schema()
        _assert_all_properties_are_required(schema)


if __name__ == "__main__":
    unittest.main()
