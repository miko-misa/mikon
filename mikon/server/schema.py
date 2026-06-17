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
    defs = schema.get("$defs", {})
    properties = schema.get("properties", {})
    for name, field_schema in properties.items():
        normalized = _non_null_schema(field_schema)
        target = _deref(normalized, defs)
        field_ui: dict[str, Any] = {}
        if target.get("x-mikon-widget") == "artifact-ref":
            field_ui["ui:widget"] = "artifact-ref"
        else:
            field_type = target.get("type")
            if field_type in {"number", "integer"} and _has_bounds(target):
                field_ui["ui:widget"] = "range"
        if "description" in normalized:
            field_ui["ui:help"] = normalized["description"]
        if field_ui:
            ui_schema[name] = field_ui
    return ui_schema


def _deref(schema: dict[str, Any], defs: dict[str, Any]) -> dict[str, Any]:
    node = schema
    all_of = node.get("allOf")
    if isinstance(all_of, list) and len(all_of) == 1 and isinstance(all_of[0], dict):
        node = all_of[0]
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/$defs/"):
        name = ref.split("/")[-1]
        resolved = defs.get(name)
        if isinstance(resolved, dict):
            return resolved
    return node


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
