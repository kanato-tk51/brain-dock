#!/usr/bin/env python3
"""Minimal JSON contract validator for worker result payloads."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def worker_schema_path(name: str) -> Path:
    return repo_root() / "schemas" / "json" / "worker" / f"{name}.result.schema.json"


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, int) or isinstance(value, float)) and not isinstance(value, bool)


def _matches_type(expected_type: str, value: Any) -> bool:
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return _is_int(value)
    if expected_type == "number":
        return _is_number(value)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "null":
        return value is None
    return False


def _validate(schema: dict[str, Any], value: Any, path: str, errors: list[str]) -> None:
    schema_type = schema.get("type")
    if schema_type is not None:
        if isinstance(schema_type, list):
            if not any(_matches_type(str(t), value) for t in schema_type):
                errors.append(f"{path}: expected one of {schema_type}, got {type(value).__name__}")
                return
        else:
            if not _matches_type(str(schema_type), value):
                errors.append(f"{path}: expected {schema_type}, got {type(value).__name__}")
                return

    enum_values = schema.get("enum")
    if enum_values is not None and value not in enum_values:
        errors.append(f"{path}: value {value!r} not in enum {enum_values}")

    if _is_number(value):
        minimum = schema.get("minimum")
        if minimum is not None and float(value) < float(minimum):
            errors.append(f"{path}: value {value} < minimum {minimum}")
        maximum = schema.get("maximum")
        if maximum is not None and float(value) > float(maximum):
            errors.append(f"{path}: value {value} > maximum {maximum}")

    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                errors.append(f"{path}: missing required property {key!r}")

        properties = schema.get("properties", {})
        additional_allowed = schema.get("additionalProperties", True)

        for key, item in value.items():
            child_path = f"{path}.{key}"
            if key in properties:
                prop_schema = properties[key]
                if isinstance(prop_schema, dict):
                    _validate(prop_schema, item, child_path, errors)
            elif additional_allowed is False:
                errors.append(f"{path}: additional property {key!r} is not allowed")

    if isinstance(value, list):
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for idx, item in enumerate(value):
                _validate(item_schema, item, f"{path}[{idx}]", errors)


def validate_contract(schema_path: Path, payload: dict[str, Any]) -> None:
    if not schema_path.exists():
        raise FileNotFoundError(f"worker result schema not found: {schema_path}")

    with schema_path.open("r", encoding="utf-8") as f:
        schema = json.load(f)

    if not isinstance(schema, dict):
        raise ValueError(f"invalid schema format: {schema_path}")

    errors: list[str] = []
    _validate(schema, payload, "$", errors)
    if errors:
        joined = "; ".join(errors[:10])
        raise ValueError(f"result payload does not match contract {schema_path.name}: {joined}")
