from __future__ import annotations

import hashlib
import json
from typing import Any


def schema_hash(schema: dict[str, Any]) -> str:
    payload = json.dumps(schema, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def config_hash(config: dict[str, Any]) -> str:
    payload = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def derive_ui_schema(schema: dict[str, Any]) -> dict[str, Any]:
    ui_schema: dict[str, Any] = {}
    properties = schema.get("properties", {})
    for name, field_schema in properties.items():
        normalized = _non_null_schema(field_schema)
        field_ui: dict[str, Any] = {}
        field_type = normalized.get("type")
        if field_type in {"number", "integer"} and _has_bounds(normalized):
            field_ui["ui:widget"] = "range"
        if "description" in normalized:
            field_ui["ui:help"] = normalized["description"]
        if field_ui:
            ui_schema[name] = field_ui
    return ui_schema


def _non_null_schema(schema: dict[str, Any]) -> dict[str, Any]:
    any_of = schema.get("anyOf")
    if isinstance(any_of, list):
        for item in any_of:
            if item.get("type") != "null":
                merged = dict(item)
                if "default" in schema:
                    merged["default"] = schema["default"]
                if "description" in schema and "description" not in merged:
                    merged["description"] = schema["description"]
                return merged
    return schema


def _has_bounds(schema: dict[str, Any]) -> bool:
    lower = any(key in schema for key in ("minimum", "exclusiveMinimum"))
    upper = any(key in schema for key in ("maximum", "exclusiveMaximum"))
    return lower and upper
