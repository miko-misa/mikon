from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Generic, TypeVar, get_type_hints

from pydantic_core import core_schema

from mikon.sdk.config import Config

T = TypeVar("T")


class ModuleValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ModuleDefinition:
    name: str
    target: Callable[..., Any] | type
    implements: type
    config_type: type[Config]
    source_file: str
    lineno: int
    doc: str | None

    @property
    def implements_key(self) -> str:
        return interface_key(self.implements)


_MODULES: dict[str, ModuleDefinition] = {}


class ModuleRef(Generic[T]):
    def __class_getitem__(cls, item: type) -> type:
        return _slot_type(item, factory=False)


class ModuleFactory(Generic[T]):
    def __class_getitem__(cls, item: type) -> type:
        return _slot_type(item, factory=True)


class _ModuleSlot:
    __mikon_implements__: type
    __mikon_factory__: bool

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> core_schema.CoreSchema:
        return core_schema.no_info_plain_validator_function(cls._validate)

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema: core_schema.CoreSchema, handler: Any) -> dict[str, Any]:
        return module_slot_json_schema(cls.__mikon_implements__, cls.__mikon_factory__)

    @classmethod
    def _validate(cls, value: Any) -> dict[str, Any]:
        return validate_module_payload(value, cls.__mikon_implements__)


def module(
    target: Callable[..., Any] | type | None = None,
    *,
    name: str | None = None,
    implements: type,
):
    def decorate(item: Callable[..., Any] | type):
        module_name = name or item.__name__
        config_type = _extract_config_type(item)
        if not _is_compatible(item, implements):
            raise TypeError(f"mikon module {module_name!r} is not compatible with {interface_key(implements)}")
        source_file = inspect.getsourcefile(item) or "<unknown>"
        try:
            _, lineno = inspect.getsourcelines(item)
        except OSError:
            lineno = 0
        definition = ModuleDefinition(
            name=module_name,
            target=item,
            implements=implements,
            config_type=config_type,
            source_file=source_file,
            lineno=lineno,
            doc=inspect.getdoc(item),
        )
        existing = _MODULES.get(module_name)
        if existing is not None and existing.target is not item:
            raise ValueError(f"duplicate mikon module name: {module_name}")
        _MODULES[module_name] = definition
        return item

    if target is None:
        return decorate
    return decorate(target)


def get_module_registry() -> dict[str, ModuleDefinition]:
    return dict(_MODULES)


def clear_module_registry() -> None:
    _MODULES.clear()


def interface_key(value: type) -> str:
    return f"{value.__module__}.{value.__qualname__}"


def is_module_slot_type(value: Any) -> bool:
    return isinstance(value, type) and issubclass(value, _ModuleSlot)


def module_slot_json_schema(implements: type, factory: bool) -> dict[str, Any]:
    one_of: list[dict[str, Any]] = []
    for definition in sorted(_compatible_modules(implements), key=lambda item: item.name):
        schema = definition.config_type.model_json_schema()
        properties = dict(schema.get("properties", {}))
        properties = {
            "__module__": {
                "const": definition.name,
                "default": definition.name,
                "title": "Module",
            },
            **properties,
        }
        module_schema: dict[str, Any] = {
            "title": definition.name,
            "type": "object",
            "properties": properties,
            "required": ["__module__", *schema.get("required", [])],
            "additionalProperties": False,
        }
        if "$defs" in schema:
            module_schema["$defs"] = schema["$defs"]
        one_of.append(module_schema)

    title = f"{'ModuleFactory' if factory else 'ModuleRef'}[{interface_key(implements)}]"
    if not one_of:
        return {
            "title": title,
            "type": "object",
            "properties": {"__module__": {"type": "string"}},
            "required": ["__module__"],
            "additionalProperties": True,
            "x-mikon-module-ref": interface_key(implements),
            "x-mikon-module-factory": factory,
        }
    return {
        "title": title,
        "oneOf": one_of,
        "x-mikon-module-ref": interface_key(implements),
        "x-mikon-module-factory": factory,
    }


def validate_module_payload(value: Any, implements: type) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ModuleValidationError("module value must be an object")
    module_name = value.get("__module__")
    if not isinstance(module_name, str) or not module_name:
        raise ModuleValidationError("module value must include __module__")
    definition = _MODULES.get(module_name)
    if definition is None:
        raise ModuleValidationError(f"unknown module: {module_name}")
    if definition not in _compatible_modules(implements):
        raise ModuleValidationError(f"module {module_name} is not compatible with {interface_key(implements)}")
    config_payload = {key: item for key, item in value.items() if key != "__module__"}
    model = definition.config_type.model_validate(config_payload)
    return {"__module__": module_name, **model.model_dump(mode="json")}


def instantiate_config_modules(config: Config, max_depth: int) -> None:
    _instantiate_model(config, type(config), max_depth=max_depth, depth=0)


def validate_module_nest_depth(value: Any, max_depth: int) -> None:
    def walk(item: Any, depth: int) -> None:
        if isinstance(item, dict):
            current_depth = depth
            if "__module__" in item:
                current_depth += 1
                if current_depth > max_depth:
                    raise ModuleValidationError(f"module nesting exceeds max depth {max_depth}")
            for child in item.values():
                walk(child, current_depth)
        elif isinstance(item, list):
            for child in item:
                walk(child, depth)

    walk(value, 0)


def _slot_type(implements: type, factory: bool) -> type:
    suffix = "Factory" if factory else "Ref"
    name = f"Module{suffix}_{implements.__module__.replace('.', '_')}_{implements.__qualname__.replace('.', '_')}"
    return type(
        name,
        (_ModuleSlot,),
        {
            "__mikon_implements__": implements,
            "__mikon_factory__": factory,
            "__module__": __name__,
        },
    )


def _compatible_modules(implements: type) -> list[ModuleDefinition]:
    return [definition for definition in _MODULES.values() if _implements_compatible(definition.implements, implements)]


def _implements_compatible(candidate: type, expected: type) -> bool:
    if candidate is expected:
        return True
    try:
        return issubclass(candidate, expected)
    except TypeError:
        return False


def _instantiate_model(model: Config, model_type: type[Config], *, max_depth: int, depth: int) -> None:
    for field_name, field in model_type.model_fields.items():
        annotation = field.annotation
        value = getattr(model, field_name)
        if is_module_slot_type(annotation):
            setattr(
                model,
                field_name,
                _instantiate_payload(
                    value,
                    annotation.__mikon_factory__,
                    max_depth=max_depth,
                    depth=depth + 1,
                ),
            )
        elif isinstance(value, Config):
            _instantiate_model(value, type(value), max_depth=max_depth, depth=depth)


def _instantiate_payload(value: Any, factory: bool, *, max_depth: int, depth: int) -> Any:
    if depth > max_depth:
        raise ModuleValidationError(f"module nesting exceeds max depth {max_depth}")
    if not isinstance(value, dict):
        raise ModuleValidationError("module value must be an object")
    module_name = value.get("__module__")
    if not isinstance(module_name, str):
        raise ModuleValidationError("module value must include __module__")
    definition = _MODULES.get(module_name)
    if definition is None:
        raise ModuleValidationError(f"unknown module: {module_name}")
    config_payload = {key: item for key, item in value.items() if key != "__module__"}
    module_config = definition.config_type.model_validate(config_payload)
    _instantiate_model(module_config, definition.config_type, max_depth=max_depth, depth=depth)
    if factory:
        return lambda **kwargs: _construct_module(definition, module_config.model_copy(deep=True), kwargs)
    return _construct_module(definition, module_config, {})


def _construct_module(definition: ModuleDefinition, config: Config, kwargs: dict[str, Any]) -> Any:
    return definition.target(config, **kwargs)


def _extract_config_type(target: Callable[..., Any] | type) -> type[Config]:
    callable_target = target.__init__ if inspect.isclass(target) else target
    signature = inspect.signature(callable_target)
    try:
        hints = get_type_hints(callable_target)
    except Exception:
        hints = {}
    config_types: list[type[Config]] = []
    for parameter in signature.parameters.values():
        if parameter.name in {"self", "cls"}:
            continue
        annotation = hints.get(parameter.name, parameter.annotation)
        if isinstance(annotation, type) and issubclass(annotation, Config):
            config_types.append(annotation)
    if len(config_types) != 1:
        raise TypeError(f"mikon module {target!r} must declare exactly one Config parameter")
    return config_types[0]


def _is_compatible(target: Callable[..., Any] | type, implements: type) -> bool:
    if inspect.isclass(target):
        try:
            if issubclass(target, implements):
                return True
        except TypeError:
            pass
        if _is_protocol(implements):
            return _structurally_matches(target, implements)
        return False

    try:
        hints = get_type_hints(target)
    except Exception:
        hints = {}
    returned = hints.get("return", inspect.signature(target).return_annotation)
    if isinstance(returned, type):
        try:
            return issubclass(returned, implements)
        except TypeError:
            return _is_protocol(implements) and _structurally_matches(returned, implements)
    return False


def _is_protocol(value: type) -> bool:
    return bool(getattr(value, "_is_protocol", False))


def _structurally_matches(target: type, protocol: type) -> bool:
    members: set[str] = set()
    for base in reversed(protocol.__mro__):
        if not _is_protocol(base):
            continue
        if base.__module__ == "typing" and base.__qualname__ == "Protocol":
            continue
        annotations = getattr(base, "__annotations__", {})
        for name in annotations:
            if not name.startswith("_"):
                members.add(name)
        for name, item in base.__dict__.items():
            if not name.startswith("_") and callable(item):
                members.add(name)
    return all(hasattr(target, name) for name in members)
