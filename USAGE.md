# mikon Usage Guide

> 日本語版: [USAGE-ja.md](USAGE-ja.md)

> A complete developer reference covering all implemented features (Phases 1–4).

---

## Table of Contents

1. [Installation](#1-installation)
2. [Project Initialization](#2-project-initialization)
3. [Writing Jobs](#3-writing-jobs)
4. [Designing Config](#4-designing-config)
5. [RunContext API](#5-runcontext-api)
6. [Starting the Server](#6-starting-the-server)
7. [CLI Reference](#7-cli-reference)
8. [Module System](#8-module-system)
9. [Datasets](#9-datasets)
10. [Lineage](#10-lineage)
11. [Organization: Tags, Groups, and Stars](#11-organization-tags-groups-and-stars)
12. [Saved Configs](#12-saved-configs)
13. [Run Comparison](#13-run-comparison)
14. [Document Viewer](#14-document-viewer)
15. [mikon.toml Reference](#15-mikontoml-reference)
16. [Store Layout](#16-store-layout)
17. [GPU Management](#17-gpu-management)
18. [Authentication and Access Control](#18-authentication-and-access-control)
19. [API Error Model](#19-api-error-model)

---

## 1. Installation

Requirements: **Python 3.11+**, a GPU server (NVIDIA or AMD ROCm).

```bash
# With uv (recommended)
uv tool install mikon

# With pip
pip install mikon
```

Dependencies (`pynvml`, `psutil`, `watchfiles`, etc.) are installed automatically. `nvidia-smi` is bundled with the driver and does not need to be installed separately. For AMD, mikon works with `amdsmi` or the `rocm-smi` / `amd-smi` CLI.

---

## 2. Project Initialization

```bash
cd /your/project
mikon init
```

Generated files:

```
mikon.toml          # Server configuration
src/
  example.py        # Sample job (safe to delete)
```

Pass `--force` to overwrite existing files.

---

## 3. Writing Jobs

A "job" is a unit of work that runs on a GPU, produces artifacts, and exits. **Just add the `@mikon.job` decorator to a function** — mikon discovers it automatically with no registration step.

```python
import mikon
from mikon import Config, RunContext
from pydantic import Field
from typing import Literal

class TrainConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    batch: int = Field(32, ge=1, le=512)
    epochs: int = Field(10, ge=1, le=1000)
    optimizer: Literal["adam", "sgd"] = "adam"

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = 1.0 / (epoch + 1)
        ctx.log_metric("loss", loss, step=epoch)
        ctx.log_metric("lr", config.lr, step=epoch)

    ckpt = ctx.artifacts_dir / "model.pt"
    ckpt.write_text("dummy weights")
    ctx.log_artifact("model.pt", ckpt)
```

**Signature requirements:**

```python
def fn(config: <Config subclass>, ctx: RunContext) -> None
```

- First argument: a subclass of `Config` (the parameter name is up to you)
- Second argument: `RunContext` (the parameter name is up to you)
- Return value: `None` (ignored)

`@mikon.job` accepts an optional `name=` argument:

```python
@mikon.job(name="my-train")    # Override the name shown in the UI
def train(...): ...
```

Names must match `[A-Za-z0-9_.-]+`. When omitted, the decorated function's `__name__` is used.

Python files in the directories listed under `watch` in `mikon.toml` are scanned automatically. Saving a file triggers `watchfiles` to reload the registry — no server restart needed.

---

## 4. Designing Config

`mikon.Config` extends **Pydantic v2's `BaseModel`**. Field constraints are reflected directly in the auto-generated UI form.

```python
from mikon import Config
from pydantic import Field
from typing import Literal

class MyConfig(Config):
    # Numeric field with both minimum and maximum → rendered as a slider
    lr: float = Field(1e-3, gt=0, le=1)
    batch: int = Field(32, ge=1, le=512)

    # Literal / Enum → rendered as a select
    optimizer: Literal["adam", "sgd", "adamw"] = "adam"

    # Optional field
    weight_decay: float | None = None

    # Nested Config (rendered as a collapsible section)
    class SchedulerConfig(Config):
        type: Literal["cosine", "linear"] = "cosine"
        warmup: int = Field(100, ge=0)

    scheduler: SchedulerConfig = SchedulerConfig()
```

**UI auto-mapping rules:**

| Type / Constraint | UI Widget |
| --- | --- |
| `int` / `float` with both `minimum` and `maximum` | Slider |
| `Literal[...]` / `Enum` | Select |
| `str` | Text input |
| `bool` | Checkbox |
| Nested `Config` subclass | Collapsible section |
| `ModuleRef[T]` / `ModuleFactory[T]` | Module selector + sub-form |

**Using `description` as help text:**

```python
lr: float = Field(1e-3, gt=0, le=1, description="Learning rate (recommended for Adam: 1e-3 to 3e-4)")
```

**Type coercion rules for `--set` on the CLI:**

- Values that parse as valid JSON (numbers, booleans, arrays, objects) are treated as that type
- Values that do not parse as JSON are treated as strings
- Dotted keys create nested dicts: `model.depth=50`

---

## 5. RunContext API

`RunContext` is the runtime handle injected as the second argument to every job.

### 5.1 Properties

| Property | Type | Description |
| --- | --- | --- |
| `ctx.artifacts_dir` | `pathlib.Path` | Output directory for artifacts. Created automatically at launch. |

### 5.2 Metrics

```python
ctx.log_metric(name: str, value: int | float, step: int | None = None) -> None
```

- `name`: Series name (e.g. `"loss"`, `"accuracy/val"`)
- `value`: Numeric value (`int` or `float`)
- `step`: Omitting it produces a simple time series. Passing `step=epoch` sets the X axis to step values.

Records appear in the dashboard chart within a few seconds. Writes are thread-safe.

### 5.3 Artifacts

```python
ctx.log_artifact(name: str, path: str | pathlib.Path) -> pathlib.Path
```

- `name`: Alias for the artifact. Can include `/` to create a subdirectory structure.
- `path`: Path to a file or directory (the source is copied into `artifacts/`)
- Returns: the path inside `artifacts/` where the file was copied

```python
# Single file
ctx.log_artifact("weights/final.pt", Path("checkpoints/epoch_10.pt"))

# Entire directory
ctx.log_artifact("outputs/", Path("results/"))
```

Artifacts are listed and downloadable from the "Artifacts" tab in the dashboard.

### 5.4 Dataset Reference

```python
ctx.use_dataset(name: str) -> pathlib.Path
```

Returns the path of the registered dataset `name` and records a `uses-dataset` lineage edge in `inputs.jsonl`.

```python
data_dir = ctx.use_dataset("imagenet")
# data_dir is a Path pointing to the registered location
```

### 5.5 Artifact Reference from Another Run

```python
ctx.use_artifact(run_id: str, name: str) -> pathlib.Path
```

Returns the path of an artifact from another run and records a `consumes-artifact` lineage edge.

```python
weights = ctx.use_artifact("train__20260612-153000__a1b2", "weights/final.pt")
```

- `run_id` must match `[A-Za-z0-9_.-]+` (path separators and `..` are rejected)
- `name` is a path relative to `artifacts/` (directory traversal via `..` is rejected)

---

## 6. Starting the Server

On the GPU server:

```bash
mikon serve
# Binds to http://127.0.0.1:8000 by default
```

Access the dashboard from your local machine via SSH port forwarding:

```bash
ssh -L 8000:localhost:8000 you@gpu-server
# → Open http://localhost:8000 in your browser
```

The dashboard shows the job list, active and completed runs, and GPU status. Changes to files in the `watch` directories trigger an automatic reload.

---

## 7. CLI Reference

### `mikon init`

Initialize a mikon project.

```
mikon init [--force]
```

| Option | Description |
| --- | --- |
| `--force` | Overwrite existing files |

### `mikon serve`

Start the dashboard server.

```
mikon serve [--host HOST] [--port PORT] [--token TOKEN]
```

| Option | Default | Description |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8000` | Bind port |
| `--token` | none | Bearer token. Required when binding to any address other than `localhost`. |

### `mikon run`

Launch a job via the server.

```
mikon run <JOB> --gpu <GPU_IDS> [--config CONFIG] [--set KEY=VALUE ...] [--force] [--server URL]
```

| Argument / Option | Description |
| --- | --- |
| `JOB` | Job name (as shown in the UI) |
| `--gpu` | Comma-separated GPU IDs (e.g. `nvidia:0`, `nvidia:0,nvidia:1`, `amd:0`) |
| `--config` | Path to a JSON config file |
| `--set` | Override a config value as `key=value` (repeatable). Supports JSON values and dotted-key nesting. |
| `--force` | Launch even if the GPU is occupied |
| `--server` | Server URL (default: `http://127.0.0.1:8000`) |

**Examples:**

```bash
# Minimal
mikon run train --gpu nvidia:0

# Config file + overrides
mikon run train --gpu nvidia:0 --config base.json --set lr=3e-4 --set batch=64

# Multi-GPU
mikon run train --gpu nvidia:0,nvidia:1

# Force launch on an occupied GPU
mikon run train --gpu nvidia:0 --force

# Remote server
mikon run train --gpu nvidia:0 --server http://10.0.0.5:8000
```

**`--set` type coercion:**

| Input | Result |
| --- | --- |
| `--set epochs=50` | `{"epochs": 50}` (integer) |
| `--set lr=3e-4` | `{"lr": 0.0003}` (float) |
| `--set use_amp=true` | `{"use_amp": true}` (boolean) |
| `--set tags=["a","b"]` | `{"tags": ["a", "b"]}` (array) |
| `--set model.depth=50` | `{"model": {"depth": 50}}` (nested via dot notation) |
| `--set name=hello` | `{"name": "hello"}` (string) |

### `mikon stop`

Stop a running job (sends `SIGTERM`).

```
mikon stop <RUN_ID> [--server URL]
```

### `mikon doctor`

Diagnose GPU detection and framework compatibility.

```
mikon doctor
```

Checks and prints:

- GPU vendor detection (NVIDIA / AMD)
- Compatibility between installed frameworks (torch / jax / tensorflow) and the GPU
- Misconfigurations such as a CUDA-build of torch installed on an AMD machine

### `mikon dataset register`

Register an existing path as a dataset.

```
mikon dataset register <NAME> <PATH> [--description DESC] [--server URL]
```

| Argument / Option | Description |
| --- | --- |
| `NAME` | Dataset name (`[A-Za-z0-9_.-]+`) |
| `PATH` | Path to the dataset (must exist on the server) |
| `--description` | Optional description |
| `--server` | Server URL |

### `mikon dataset build`

Launch a dataset builder.

```
mikon dataset build <NAME> [--config CONFIG] [--set KEY=VALUE ...] [--gpu GPU_IDS] [--force] [--server URL]
```

| Argument / Option | Description |
| --- | --- |
| `NAME` | Name of the function decorated with `@mikon.dataset` |
| `--config` | Path to a JSON config file |
| `--set` | Config overrides |
| `--gpu` | GPU IDs (optional; omit for CPU-only preprocessing) |
| `--force` | Launch even if the GPU is occupied |

---

## 8. Module System

Modules are **swappable components** that can be plugged into a job's config. When you define preprocessing steps, model architectures, or loss functions as modules, the UI generates a selection form automatically.

### 8.1 Defining an Interface

```python
from typing import Protocol, runtime_checkable

@runtime_checkable
class ModelBlock(Protocol):
    def forward(self, x): ...
```

The interface can be a `Protocol` or a regular base class.

### 8.2 Implementing and Registering a Module

```python
from mikon import Config
from pydantic import Field

class ResNetConfig(Config):
    depth: int = Field(50, ge=18)

@mikon.module(implements=ModelBlock)    # Can be used in any job that accepts ModelBlock
class ResNet:
    def __init__(self, config: ResNetConfig):
        self.config = config

    def forward(self, x):
        ...
```

- `@mikon.module(implements=T)` is discovered automatically (place the file inside a `watch` directory)
- Override the name with `name=` (defaults to the class or function name)
- Both classes and functions can be registered

### 8.3 Using a Module in a Job: `ModuleRef[T]`

```python
import mikon
from mikon import Config, RunContext

class TrainConfig(Config):
    lr: float = 1e-3
    model: mikon.ModuleRef[ModelBlock]   # Renders a selection form in the UI

@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    # config.model is already an instantiated object
    output = config.model.forward(input_data)
```

For a job with a `ModuleRef[T]` field, the UI shows a list of all modules that implement `T`. Selecting one expands that module's own config form below.

### 8.4 Deferred Construction: `ModuleFactory[T]`

```python
class TrainConfig(Config):
    model: mikon.ModuleFactory[ModelBlock]

@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    # Creates a new instance on each call; kwargs are forwarded
    model_a = config.model(seed=1)
    model_b = config.model(seed=2)
```

`ModuleFactory[T]` is a callable that creates a new instance each time it is called. Use it when you need runtime arguments or data-parallel setups.

### 8.5 Nested Modules

Modules can themselves have `ModuleRef` / `ModuleFactory` fields.

```python
class PipelineConfig(Config):
    encoder: mikon.ModuleRef[Encoder]
    decoder: mikon.ModuleRef[Decoder]

@mikon.module(implements=Pipeline)
class EncDecPipeline:
    def __init__(self, config: PipelineConfig): ...
```

The maximum nesting depth is controlled by `[modules] max_nest_depth` in `mikon.toml` (default: `8`).

### 8.6 Serialization Format

Module field values are stored internally in `config.json` as:

```json
{
  "__module__": "ResNet",
  "depth": 50
}
```

`__module__` holds the module name; the remaining keys are that module's Config fields.

---

## 9. Datasets

### 9.1 Registering an Existing Path

```python
# From Python (e.g. a script run before the server starts)
import mikon.datasets
mikon.datasets.register("mnist", path="/data/mnist", description="Handwritten digits")
```

```bash
# From the CLI
mikon dataset register mnist /data/mnist --description "Handwritten digits"
```

Names must match `[A-Za-z0-9_.-]+`.

### 9.2 Creating with a Builder

```python
from mikon import Config, DatasetContext
from pydantic import Field

class Cifar10Config(Config):
    root: str = "/data/cache"
    train_only: bool = False

@mikon.dataset
def cifar10(config: Cifar10Config, ctx: DatasetContext) -> None:
    # Download or prepare the data
    download_to(ctx.staging_dir, config.root)

    # Register the finished directory as "cifar10"
    ctx.add_dir(ctx.staging_dir, description="CIFAR-10 dataset")
```

Builder function signature:

```python
def fn(config: <Config subclass>, ctx: DatasetContext) -> None
```

**`DatasetContext` API:**

| Method / Property | Description |
| --- | --- |
| `ctx.staging_dir` | Temporary working directory (`pathlib.Path`) |
| `ctx.dataset_name` | Builder name (the dataset name used for registration) |
| `ctx.add_dir(path, description=None)` | Register a directory as a dataset in the store |

### 9.3 Referencing a Dataset from a Job

```python
@mikon.job
def train(config: TrainConfig, ctx: RunContext):
    data_dir = ctx.use_dataset("mnist")   # Returns a Path
    # Read from data_dir
```

`use_dataset` automatically records a `uses-dataset` lineage edge.

---

## 10. Lineage

mikon automatically records the following edges:

| Edge type | Recorded when |
| --- | --- |
| `uses-dataset` | `ctx.use_dataset(name)` is called |
| `consumes-artifact` | `ctx.use_artifact(run_id, name)` is called |
| `uses-module` | A job is launched with a Config containing module fields |
| `produces-dataset` | A dataset builder completes via `ctx.add_dir(...)` |

The "Lineage" view in the UI shows a graph centered on a selected run, traversing upstream (parents) and downstream (children) to a configurable depth. Module links are collapsed by default and can be expanded on demand.

**Manual links** (e.g. "I looked at this run before choosing these hyperparameters") can be added from the UI without requiring an artifact connection.

**API:**

```
GET /api/runs/{run_id}/lineage?direction=both&depth=2&include_modules=false
```

| Parameter | Values | Default | Description |
| --- | --- | --- | --- |
| `direction` | `ancestors` / `descendants` / `both` | `both` | Which direction to traverse |
| `depth` | 0–20 | `2` | How many hops to follow |
| `include_modules` | `true` / `false` | `false` | Whether to include `uses-module` edges |

**Manual links:**

Runs, datasets, artifacts, and modules that are related but not connected by an automatic edge can be linked manually. Links appear in the Lineage view.

```
POST /api/links
Body: { "src": "<node_id>", "dst": "<node_id>", "note": "<optional text>" }

DELETE /api/links/{link_id}
```

Node ID format:

| Prefix | Example | Refers to |
| --- | --- | --- |
| `run:` | `run:train__20260612-153000__a1b2` | A run |
| `dataset:` | `dataset:imagenet` | A registered dataset |
| `artifact:` | `artifact:train__20260612-153000__a1b2/weights/final.pt` | A specific artifact |
| `module:` | `module:ResNet` | A registered module |

---

## 11. Organization: Tags, Groups, Stars, and Deletion

Annotations can be set at **launch time** (via the UI job launch form or `POST /api/runs`) or edited **after the fact** (via the UI Overview tab or `PATCH /api/runs/{run_id}`).

**`POST /api/runs` request body (`CreateRunRequest`):**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `job` | `str` | (required) | Job name |
| `config` | `dict` | (required) | Config values |
| `gpus` | `list[str]` | (required, ≥1) | GPU IDs |
| `force` | `bool` | `false` | Launch even if the GPU is occupied |
| `annotations` | `Annotations \| null` | `null` | Tags, star, group, title, memo |
| `save_config_as` | `str \| null` | `null` | Save the config under this name at launch time (see §12) |

| Field | Type | Description |
| --- | --- | --- |
| `title` | `str \| null` | Display name. Shown as the primary label in lists and the detail header. Defaults to run ID when unset. |
| `memo` | `str \| null` | Free-text note |
| `tags` | `list[str]` | Arbitrary tags (multiple allowed) |
| `star` | `bool` | Starred / favourited |
| `group_ids` | `list[str]` | List of group IDs this run belongs to |

**Groups** are first-class containers for collecting and comparing multiple runs side by side.

Filtering in `GET /api/runs`:

```
GET /api/runs?tag=baseline&star=true&group=<group_id>&job=train&status=completed
```

### Deleting Runs

Runs can be deleted from the run detail page or via the bulk-delete action in the runs list. A confirmation dialog is always shown. Runs with `status=running` cannot be deleted.

```
DELETE /api/runs/{run_id}    # 204 No Content
```

Deleting a run permanently removes its entire store directory — metadata, logs, metrics, and artifacts. **This operation cannot be undone.**

---

## 12. Saved Configs

A **saved config** is a named set of config values for a specific job. Saved configs can be selected in the UI launch form to pre-fill fields, eliminating the need to re-enter the same values for repeated experiments.

### Saving a config

**At launch time (UI):** The job launch form has a "Save config as" field. Filling it in saves the config automatically when the run is created.

**At launch time (API):** Set `save_config_as` in `CreateRunRequest`:

```json
{
  "job": "train",
  "config": { "lr": 3e-4, "epochs": 50 },
  "gpus": ["nvidia:0"],
  "save_config_as": "baseline-lr3e-4"
}
```

**Directly (API):**

```
PUT /api/configs/{name}
Body: { "job": "<job_name>", "values": { ... } }
```

Names must match `[A-Za-z0-9_.-]+`. Saving to an existing name overwrites it if the config belongs to the same job; saving to a name that belongs to a different job returns `409 config-name-conflict`.

### Managing saved configs

```
GET    /api/configs               # List all saved configs
GET    /api/configs/{name}        # Get a specific saved config
DELETE /api/configs/{name}        # Delete a saved config  (204 No Content)
```

### Config diff (schema change detection)

When a job's Config class changes (fields added, removed, or type-changed), call `/diff` to see whether a saved config is still compatible with the current schema:

```
POST /api/configs/{name}/diff
Body (optional): { "job": "<target_job_name>" }
```

Response (`ConfigDiff`):

| Field | Type | Description |
| --- | --- | --- |
| `name` | `str` | Config name |
| `job` | `str` | Target job |
| `compatible` | `bool` | Whether the saved values are usable with the current schema |
| `changes` | `list` | Differences detected. Each entry: `field`, `kind` (`added` / `removed` / `type_changed` / `constraint_changed`), `detail` |
| `migrated_values` | `dict` | Values after applying defaults for newly added fields |

`compatible` is `false` if any `type_changed` or `constraint_changed` difference is found. `added` / `removed` fields alone do not break compatibility (defaults are applied or the value is dropped).

---

## 13. Run Comparison

Compare config values and metrics across multiple runs side by side:

```
GET /api/compare/runs?run_id=<id1>&run_id=<id2>[&run_id=<id3>...]
```

At least 2 `run_id` query parameters are required.

**Response (`CompareRunsResponse`):**

| Field | Description |
| --- | --- |
| `runs[]` | One entry per run: `run_id`, `job`, `status`, `config`, and per-metric stats (`count`, `latest`, `min`, `max`) |
| `config_fields[]` | Union of all config keys across all runs |
| `metric_names[]` | Union of all metric names across all runs |
| `config_diffs[]` | Config fields whose values differ across runs. Each entry: `field`, `values` (map of `run_id → value`), `missing_run_ids` |

`config_diffs` contains only the fields that vary — fields with identical values across all runs are omitted.

---

## 14. Document Viewer

Markdown, Typst, and TypMark files placed in the project's `docs/` directory (configurable via `[docs] root` in `mikon.toml`) are viewable in the "Docs" tab of the dashboard.

```
docs/
  index.md
  assets/
    plot.png          # Image files (.avif / .gif / .jpeg / .jpg / .png / .webp)
  experiments/
    notes.md
  reports/
    summary.typ       # Typst document
    report.tmd        # TypMark document
```

**Behavior and constraints:**

- Markdown is rendered to HTML server-side; dangerous HTML is sanitized.
- Relative images in Markdown (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`) are only displayed if they reside under `docs/assets/`. External image URLs and references outside `docs/` are not shown.
- Typst documents are compiled to SVG only if the `typst` CLI is on `PATH`. If the CLI is absent, compilation fails, or SVG output exceeds 5 MiB, the document degrades to source display with a reason shown in the UI.
- TypMark documents (`.tmd`) are rendered to HTML by `typmark-cli --render` if the CLI is on `PATH`. The rendered output is displayed in a sandboxed iframe. If the CLI is absent or rendering fails, the document degrades to source display.
- Documents in all formats hot-reload automatically in the browser when the source file is saved — no manual refresh needed.
- File size limits: documents 2 MiB, assets 10 MiB.
- Hidden files and directories (names beginning with `.`) are excluded from the tree.
- Symbolic links that point outside `docs/` are rejected (circular symlinks are also detected).
- Document editing, full-text search, and PDF export are out of scope.

---

## 15. mikon.toml Reference

```toml
[mikon]
# Directories to auto-scan for jobs (relative or absolute paths)
watch = ["src"]

# Storage root for runs, metrics, and artifacts (relative path)
store = ".mikon"

# Python interpreter used for job discovery and subprocess execution (optional).
# Accepts a relative path (resolved from the project root) or an absolute path.
# Symlinks are preserved so that pyvenv.cfg is found correctly for virtual envs.
# Default: sys.executable (the Python that runs the mikon server)
# python = ".venv/bin/python"

[gpu]
# Memory usage (MiB) above which a GPU is considered occupied
# (NVIDIA: nvml; AMD: amdsmi or CLI)
occupancy_mem_mb = 500

# Utilization (%) above which a GPU is considered occupied
occupancy_util = 5

[modules]
# Maximum nesting depth for ModuleRef / ModuleFactory (prevents cycles)
max_nest_depth = 8

[docs]
# Document root shown in the dashboard Docs tab (relative path)
root = "docs"
```

All keys are optional. Default values are used when `mikon.toml` does not exist.

---

## 16. Store Layout

The store defaults to `.mikon/` (configurable via `store` in `mikon.toml`). The `MIKON_STORE` environment variable overrides it at runtime.

```
.mikon/
  runs/
    train__20260612-153000__a1b2/    # run_id = {job}__{YYYYMMDD-HHMMSS}__{4hex}
      meta.json          # job name, start time, GPUs, tags, star, group_id, etc.
      status.json        # current status (running/completed/failed/stopped/unknown)
      config.json        # resolved config at launch time
      metrics.jsonl      # log_metric records (one JSON object per line)
      artifacts.jsonl    # log_artifact records (one JSON object per line)
      inputs.jsonl       # use_dataset / use_artifact / uses-module records
      heartbeat          # updated by the runner every 2 s (stale >30 s → unknown)
      logs/
        stdout.log
        stderr.log
      artifacts/
        model.pt         # file copied by log_artifact
  datasets/
    mnist/
      meta.json          # name, path, description, source, created_at
  configs/               # saved configs (PUT /api/configs/{name})
  groups/                # groups (POST /api/groups)
  links/                 # manual links (POST /api/links)
```

**Run ID format:** `{job}__{YYYYMMDD-HHMMSS}__{4hex}` (example: `train__20260612-153000__a1b2`)

All files are plain text and can be read directly without the dashboard. The dashboard is a display layer over these files; jobs run as independent processes and survive a dashboard restart.

---

## 17. GPU Management

### GPU ID Format

mikon uses a unified `vendor:index` format for GPU identifiers:

| Format | Description |
| --- | --- |
| `nvidia:0` | NVIDIA GPU at index 0 |
| `nvidia:1` | NVIDIA GPU at index 1 |
| `amd:0` | AMD GPU at index 0 |

**Constraint: all GPUs in a single job must be from the same vendor.** Mixing vendors (e.g. `nvidia:0,amd:0`) returns `422 gpus-mixed-vendor`.

### Automatic Environment Variables

When a job is launched, mikon sets the following environment variable based on the selected GPU vendor:

| Vendor | Environment variable |
| --- | --- |
| NVIDIA | `CUDA_VISIBLE_DEVICES=0,1,...` |
| AMD | `ROCR_VISIBLE_DEVICES=0,1,...` |

You do not need to select GPUs in your code.

### Occupancy Check

By default, launching a job on a GPU that exceeds `occupancy_mem_mb` or `occupancy_util` is blocked (`409 gpu-occupied`). Pass `--force` to override.

### Diagnostics

```bash
mikon doctor
```

Checks whether GPUs are correctly detected and whether installed frameworks are compatible (e.g. detects a CUDA build of torch on an AMD machine).

---

## 18. Authentication and Access Control

| Bind address | Authentication |
| --- | --- |
| `127.0.0.1` (default) | None (SSH port forwarding recommended) |
| External (`0.0.0.0`, etc.) | `--token <TOKEN>` required |

When bound to an external address, all `/api` endpoints require an `Authorization: Bearer <token>` header.

```bash
mikon serve --host 0.0.0.0 --port 8000 --token mysecrettoken
```

The current CLI does not support passing a token as an argument, so connecting to an external server from the CLI requires using `httpx` / `curl` directly, or routing through a local SSH forward.

---

## 19. API Error Model

mikon returns errors in [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457) format (`application/problem+json`).

```json
{
  "type": "/problems/gpu-occupied",
  "title": "Selected GPU is occupied",
  "status": 409,
  "detail": "GPU nvidia:0 is in use.",
  "instance": "/api/runs",
  "gpus": ["nvidia:0"],
  "occupied_by": [{"pid": 12345, "user": "alice", "used_mib": 18442}]
}
```

All error types:

| type | status | Meaning |
| --- | --- | --- |
| `/problems/job-not-found` | 404 | Unknown job name |
| `/problems/run-not-found` | 404 | Unknown run ID |
| `/problems/gpu-occupied` | 409 | Non-force launch on an occupied GPU |
| `/problems/gpus-mixed-vendor` | 422 | Multiple GPU vendors specified for one job |
| `/problems/gpu-not-found` | 422 | Specified GPU does not exist |
| `/problems/run-not-stoppable` | 409 | Stop requested on an already-terminal run |
| `/problems/config-validation-failed` | 422 | Config violates its schema |
| `/problems/config-name-conflict` | 409 | Config name already belongs to a different job |
| `/problems/registry-stale` | 503 | Discovery import is failing |
| `/problems/dataset-not-found` | 404 | Unknown dataset name |
| `/problems/dataset-builder-not-found` | 404 | Unknown dataset builder name |
| `/problems/dataset-validation-failed` | 422 | Invalid dataset registration values |
| `/problems/invalid-name` | 422 | Name contains invalid characters |
| `/problems/group-not-found` | 404 | Unknown group ID |
| `/problems/group-validation-failed` | 422 | Invalid group name or description |
| `/problems/link-not-found` | 404 | Unknown link ID |
| `/problems/link-validation-failed` | 422 | Manual link references an invalid node ID |
| `/problems/run-start-failed` | 500 | Subprocess launch failed |
| `/problems/doc-not-found` | 404 | Unknown docs path |
| `/problems/doc-unsupported` | 415/422 | Unsupported extension or invalid docs root |
| `/problems/doc-too-large` | 413 | Document or asset exceeds the size limit |
