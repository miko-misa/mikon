from __future__ import annotations

from typing import Any


class ProblemException(Exception):
    def __init__(
        self,
        *,
        type: str,
        title: str,
        status: int,
        detail: str | None = None,
        **extensions: Any,
    ) -> None:
        super().__init__(detail or title)
        self.type = type
        self.title = title
        self.status = status
        self.detail = detail
        self.extensions = extensions

    def to_dict(self, instance: str | None = None) -> dict[str, Any]:
        data: dict[str, Any] = {
            "type": self.type,
            "title": self.title,
            "status": self.status,
            "detail": self.detail,
            "instance": instance,
        }
        data.update(self.extensions)
        return {key: value for key, value in data.items() if value is not None}
