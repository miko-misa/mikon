# mikon

> 日本語版: [README-ja.md](README-ja.md)

A self-hosted tool for managing AI development (training and evaluation jobs) on GPU servers from a browser.

**Write Python the way you normally would, and just add a decorator to your functions.** mikon automatically discovers your jobs, generates config forms, allocates GPUs, launches runs, and displays metrics, logs, and artifacts in real time.

---

## Features

- **Decorator-only discovery** — Just add `@mikon.job`. No registration step, no code changes required.
- **Auto-generated config UI** — Pydantic fields on `class Config(mikon.Config)` become form widgets automatically (sliders, selects, checkboxes, etc.)
- **NVIDIA and AMD support** — Specify GPUs in unified `nvidia:0` / `amd:0` format. `CUDA_VISIBLE_DEVICES` / `ROCR_VISIBLE_DEVICES` are set automatically.
- **Live monitoring** — Metric charts and log streams update every few seconds via SSE.
- **Artifact management** — Call `ctx.log_artifact()` to make files downloadable from the browser.
- **Lineage tracking** — `ctx.use_dataset()` / `ctx.use_artifact()` automatically build an upstream/downstream graph.
- **Module system** — Register swappable components with `@mikon.module`; the UI generates a module-selection form automatically.
- **Dataset management** — Register existing paths or create datasets with a builder function.
- **Document viewer** — Markdown, Typst, and TypMark files placed in `docs/` are viewable in the dashboard.
- **File-based persistence** — No SQL database required. Everything is stored as text files under `.mikon/`.
- **Independent processes** — Jobs keep running even if the dashboard is restarted.

---

## Requirements

- Python 3.11+
- GPU server with NVIDIA drivers or AMD ROCm installed
- `typst` CLI (optional, for Typst document rendering)
- `typmark-cli` CLI (optional, for TypMark document rendering)

---

## Quick Start

```bash
# Install
uv tool install mikon   # or: pip install mikon

# Initialize project
mikon init
```

```python
# src/train.py
import mikon
from mikon import Config, RunContext
from pydantic import Field
from typing import Literal

class TrainConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    epochs: int = Field(10, ge=1, le=1000)
    optimizer: Literal["adam", "sgd"] = "adam"

@mikon.job
def train(config: TrainConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = 1.0 / (epoch + 1)
        ctx.log_metric("loss", loss, step=epoch)
```

```bash
# Start the server on the GPU machine
mikon serve

# Launch a job from the CLI
mikon run train --gpu nvidia:0

# Access the dashboard from your local machine via SSH port forwarding
ssh -L 8000:localhost:8000 you@gpu-server
# → Open http://localhost:8000 in your browser
```

---

## Installation

```bash
uv tool install mikon   # recommended
pip install mikon
```

Dependencies (`pynvml`, `psutil`, `watchfiles`, `fastapi`, etc.) are installed automatically.

---

## Documentation

For the full usage guide, SDK reference, CLI options, and API error model, see [USAGE.md](USAGE.md).

---

## License

MIT
