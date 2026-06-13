from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, get_type_hints

from mikon.sdk.config import Config
from mikon.sdk.context import RunContext


@dataclass(frozen=True)
class JobDefinition:
    name: str
    func: Callable[..., Any]
    config_type: type[Config]
    source_file: str
    lineno: int
    doc: str | None


_REGISTRY: dict[str, JobDefinition] = {}


def job(func: Callable[..., Any] | None = None, *, name: str | None = None):
    """Mark a function as a mikon job."""

    def decorate(target: Callable[..., Any]) -> Callable[..., Any]:
        job_name = name or target.__name__
        config_type = _extract_config_type(target)
        source_file = inspect.getsourcefile(target) or "<unknown>"
        try:
            _, lineno = inspect.getsourcelines(target)
        except OSError:
            lineno = 0
        definition = JobDefinition(
            name=job_name,
            func=target,
            config_type=config_type,
            source_file=source_file,
            lineno=lineno,
            doc=inspect.getdoc(target),
        )
        existing = _REGISTRY.get(job_name)
        if existing is not None and existing.func is not target:
            raise ValueError(f"duplicate mikon job name: {job_name}")
        _REGISTRY[job_name] = definition
        return target

    if func is None:
        return decorate
    return decorate(func)


def get_registry() -> dict[str, JobDefinition]:
    return dict(_REGISTRY)


def clear_registry() -> None:
    _REGISTRY.clear()


def _extract_config_type(func: Callable[..., Any]) -> type[Config]:
    signature = inspect.signature(func)
    try:
        hints = get_type_hints(func)
    except Exception:
        hints = {}

    config_candidates: list[type[Config]] = []
    has_context = False
    for parameter in signature.parameters.values():
        annotation = hints.get(parameter.name, parameter.annotation)
        if annotation is inspect.Signature.empty:
            continue
        if _is_config_type(annotation):
            config_candidates.append(annotation)
        if _is_run_context_type(annotation):
            has_context = True

    if len(config_candidates) != 1:
        raise TypeError(
            f"mikon job {func.__name__!r} must declare exactly one Config parameter"
        )
    if not has_context:
        raise TypeError(f"mikon job {func.__name__!r} must declare a RunContext parameter")
    return config_candidates[0]


def _is_config_type(value: Any) -> bool:
    return isinstance(value, type) and issubclass(value, Config)


def _is_run_context_type(value: Any) -> bool:
    return isinstance(value, type) and issubclass(value, RunContext)
