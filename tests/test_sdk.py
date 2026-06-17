import json
import math
from typing import Protocol, runtime_checkable

import pytest
from pydantic import Field

import mikon
from mikon.sdk.datasets import clear_dataset_registry, get_dataset_registry
from mikon.sdk.job import clear_registry, get_registry
from mikon.sdk.module import clear_module_registry, get_module_registry, instantiate_config_modules


def setup_function() -> None:
    clear_registry()
    clear_module_registry()
    clear_dataset_registry()


def test_job_decorator_registers_config_schema() -> None:
    class TrainConfig(mikon.Config):
        lr: float = Field(1e-3, gt=0, le=1)

    @mikon.job
    def train(config: TrainConfig, ctx: mikon.RunContext) -> None:
        pass

    registry = get_registry()
    assert registry["train"].config_type is TrainConfig
    assert "lr" in TrainConfig.model_json_schema()["properties"]


def test_job_requires_run_context() -> None:
    class TrainConfig(mikon.Config):
        lr: float = 0.1

    with pytest.raises(TypeError):

        @mikon.job
        def train(config: TrainConfig) -> None:
            pass


def test_run_context_logs_metrics_and_artifacts(tmp_path) -> None:
    ctx = mikon.RunContext(tmp_path)
    ctx.log_metric("loss", 0.5, step=1)
    source = tmp_path / "source.txt"
    source.write_text("payload", encoding="utf-8")
    destination = ctx.log_artifact("nested/result.txt", source)

    metric = json.loads((tmp_path / "metrics.jsonl").read_text(encoding="utf-8").strip())
    assert metric["name"] == "loss"
    assert metric["step"] == 1
    assert destination.read_text(encoding="utf-8") == "payload"


def test_run_context_rejects_invalid_metric_values(tmp_path) -> None:
    ctx = mikon.RunContext(tmp_path)

    with pytest.raises(TypeError):
        ctx.log_metric("flag", True)
    with pytest.raises(ValueError):
        ctx.log_metric("loss", math.nan)
    with pytest.raises(ValueError):
        ctx.log_metric("", 1.0)


def test_run_context_rejects_artifact_path_traversal(tmp_path) -> None:
    ctx = mikon.RunContext(tmp_path)
    source = tmp_path / "source.txt"
    source.write_text("payload", encoding="utf-8")

    with pytest.raises(ValueError):
        ctx.log_artifact("../escape.txt", source)
    with pytest.raises(ValueError):
        ctx.log_artifact(str((tmp_path / "absolute.txt").resolve()), source)


def test_module_decorator_and_module_ref_schema() -> None:
    @runtime_checkable
    class Block(Protocol):
        def forward(self, value: int) -> int:
            ...

    class BlockConfig(mikon.Config):
        width: int = Field(4, ge=1)

    @mikon.module(implements=Block)
    class Linear:
        def __init__(self, config: BlockConfig) -> None:
            self.config = config

        def forward(self, value: int) -> int:
            return value + self.config.width

    class TrainConfig(mikon.Config):
        block: mikon.ModuleRef[Block]

    registry = get_module_registry()
    assert registry["Linear"].config_type is BlockConfig
    schema = TrainConfig.model_json_schema()
    field_schema = schema["properties"]["block"]
    assert field_schema["oneOf"][0]["properties"]["__module__"]["const"] == "Linear"
    resolved = TrainConfig.model_validate({"block": {"__module__": "Linear"}})
    assert resolved.model_dump(mode="json")["block"] == {"__module__": "Linear", "width": 4}


def test_module_protocol_compatibility_checks_inherited_members() -> None:
    class BaseBlock(Protocol):
        def encode(self, value: int) -> int:
            ...

    class Block(BaseBlock, Protocol):
        def forward(self, value: int) -> int:
            ...

    class BlockConfig(mikon.Config):
        width: int = 1

    @mikon.module(implements=Block)
    class CompleteBlock:
        def __init__(self, config: BlockConfig) -> None:
            self.config = config

        def encode(self, value: int) -> int:
            return value

        def forward(self, value: int) -> int:
            return value + self.config.width

    with pytest.raises(TypeError):

        @mikon.module(implements=Block)
        class IncompleteBlock:
            def __init__(self, config: BlockConfig) -> None:
                self.config = config

            def forward(self, value: int) -> int:
                return value

    assert get_module_registry()["CompleteBlock"].config_type is BlockConfig


def test_module_factory_creates_fresh_config_instances() -> None:
    class Block(Protocol):
        def forward(self, value: int) -> int:
            ...

    class BlockConfig(mikon.Config):
        values: list[int] = Field(default_factory=list)

    @mikon.module(implements=Block)
    class Accumulator:
        def __init__(self, config: BlockConfig) -> None:
            self.config = config

        def forward(self, value: int) -> int:
            self.config.values.append(value)
            return len(self.config.values)

    class TrainConfig(mikon.Config):
        block: mikon.ModuleFactory[Block]

    config = TrainConfig.model_validate({"block": {"__module__": "Accumulator"}})
    instantiate_config_modules(config, max_depth=8)

    first = config.block()
    second = config.block()

    assert first.forward(1) == 1
    assert first.forward(2) == 2
    assert second.forward(3) == 1


def test_artifact_ref_unwraps_marker_and_round_trips() -> None:
    class InferConfig(mikon.Config):
        weights: mikon.ArtifactRef
        batch: int = 8

    config = InferConfig.model_validate(
        {"weights": {"__artifact_ref__": {"step": 0, "artifact": "model.pt"}}}
    )
    assert config.weights.step == 0
    assert config.weights.artifact == "model.pt"
    assert config.weights.run_id is None
    dumped = config.model_dump(mode="json")
    assert dumped["weights"] == {"__artifact_ref__": {"artifact": "model.pt", "step": 0}}


def test_artifact_ref_path_requires_resolution() -> None:
    class InferConfig(mikon.Config):
        weights: mikon.ArtifactRef

    unresolved = InferConfig.model_validate(
        {"weights": {"__artifact_ref__": {"run_id": "train__x", "artifact": "model.pt"}}}
    )
    with pytest.raises(RuntimeError):
        _ = unresolved.weights.path

    resolved = InferConfig.model_validate(
        {
            "weights": {
                "__artifact_ref__": {
                    "run_id": "train__x",
                    "artifact": "model.pt",
                    "resolved_path": "/tmp/model.pt",
                }
            }
        }
    )
    assert str(resolved.weights.path) == "/tmp/model.pt"


def test_artifact_ref_field_gets_picker_ui_hint() -> None:
    from mikon.server.schema import derive_ui_schema

    class InferConfig(mikon.Config):
        weights: mikon.ArtifactRef

    ui_schema = derive_ui_schema(InferConfig.model_json_schema())
    assert ui_schema["weights"]["ui:widget"] == "artifact-ref"


def test_dataset_register_and_context_inputs(tmp_path, monkeypatch) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "mikon.toml").write_text("[mikon]\nstore = \".mikon\"\n", encoding="utf-8")
    data = project / "data"
    data.mkdir()
    monkeypatch.chdir(project)

    registered = mikon.datasets.register("mnist", data, "digits")
    assert registered["path"] == str(data.resolve())

    store = project / ".mikon"
    source_run = store / "runs" / "source"
    (source_run / "artifacts").mkdir(parents=True)
    (source_run / "artifacts" / "model.pt").write_text("weights", encoding="utf-8")
    (source_run / "artifacts" / "bundle").mkdir()
    (source_run / "artifacts" / "bundle" / "weights.bin").write_text("bundle", encoding="utf-8")
    run_dir = store / "runs" / "consumer"
    run_dir.mkdir(parents=True)

    ctx = mikon.RunContext(run_dir)
    assert ctx.use_dataset("mnist") == data.resolve()
    assert ctx.use_artifact("source", "model.pt").read_text(encoding="utf-8") == "weights"
    assert ctx.use_artifact("source", "bundle").is_dir()
    with pytest.raises(ValueError):
        ctx.use_artifact("source", "../model.pt")
    with pytest.raises(ValueError):
        ctx.use_artifact("source", str((source_run / "artifacts" / "model.pt").resolve()))
    with pytest.raises(ValueError):
        ctx.use_artifact("..", "model.pt")
    with pytest.raises(ValueError):
        ctx.use_artifact("bad/run", "model.pt")

    records = [json.loads(line) for line in (run_dir / "inputs.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [record["type"] for record in records] == ["uses-dataset", "consumes-artifact", "consumes-artifact"]
    assert records[0]["dataset"] == "mnist"
    assert records[1]["run_id"] == "source"


def test_dataset_decorator_and_context_add_dir(tmp_path, monkeypatch) -> None:
    class BuildConfig(mikon.Config):
        split: str = "train"

    @mikon.dataset
    def mnist(config: BuildConfig, ctx: mikon.DatasetContext) -> None:
        ctx.add_dir(ctx.staging_dir / config.split, description="digits")

    with pytest.raises(TypeError):

        @mikon.dataset(name="bad")
        def bad(config: BuildConfig) -> None:
            pass

    with pytest.raises(ValueError):

        @mikon.dataset(name="mnist")
        def duplicate(config: BuildConfig, ctx: mikon.DatasetContext) -> None:
            pass

    project = tmp_path / "project"
    project.mkdir()
    (project / "mikon.toml").write_text("[mikon]\nstore = \".mikon\"\n", encoding="utf-8")
    monkeypatch.chdir(project)

    run_dir = project / ".mikon" / "runs" / "builder-run"
    data = run_dir / "staging" / "train"
    data.mkdir(parents=True)
    ctx = mikon.DatasetContext(run_dir, "mnist")
    registered = ctx.add_dir(data, description="digits")
    meta = json.loads((project / ".mikon" / "datasets" / "mnist" / "meta.json").read_text(encoding="utf-8"))
    output = json.loads((run_dir / "outputs.jsonl").read_text(encoding="utf-8").strip())

    assert get_dataset_registry()["mnist"].config_type is BuildConfig
    assert registered == data.resolve()
    assert meta["source"] == "builder"
    assert meta["builder_run_id"] == "builder-run"
    assert output["type"] == "produces-dataset"
