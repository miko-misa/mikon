from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, model_serializer, model_validator

ARTIFACT_REF_KEY = "__artifact_ref__"


class ArtifactRef(BaseModel):
    """Reference to an artifact produced by an upstream run in a job chain.

    Declared as a Config field. In the chain submission payload it carries a
    ``step`` index; the server rewrites it to a concrete ``run_id`` and, just
    before the downstream run starts, injects ``resolved_path``. Inside a job,
    read the file via :pyattr:`path`.
    """

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"x-mikon-widget": "artifact-ref"},
    )

    artifact: str
    step: int | None = None
    run_id: str | None = None
    resolved_path: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _unwrap_marker(cls, data: Any) -> Any:
        if isinstance(data, dict) and ARTIFACT_REF_KEY in data and len(data) == 1:
            return data[ARTIFACT_REF_KEY]
        return data

    @model_serializer(mode="plain")
    def _wrap_marker(self) -> dict[str, Any]:
        inner: dict[str, Any] = {"artifact": self.artifact}
        if self.step is not None:
            inner["step"] = self.step
        if self.run_id is not None:
            inner["run_id"] = self.run_id
        if self.resolved_path is not None:
            inner["resolved_path"] = self.resolved_path
        return {ARTIFACT_REF_KEY: inner}

    @property
    def path(self) -> Path:
        if not self.resolved_path:
            raise RuntimeError(
                "ArtifactRef is not resolved yet; .path is only available at run time."
            )
        return Path(self.resolved_path)
