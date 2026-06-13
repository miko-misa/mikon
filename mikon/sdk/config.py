from pydantic import BaseModel, ConfigDict


class Config(BaseModel):
    """Base class for job configuration schemas."""

    model_config = ConfigDict(extra="forbid")
