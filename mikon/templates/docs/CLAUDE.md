# mikon

mikon is a self-hosted GPU job management tool for ML experiments. It provides a CLI, Python SDK, REST API, and web dashboard. Jobs are Python scripts decorated with `@mikon.job`; mikon handles GPU allocation, process lifecycle, metric logging, and artifact storage.

Full documentation: **`docs/USAGE.md`** in this project (or `docs/USAGE-ja.md` for Japanese).

---

## CLI

```
mikon serve [--host HOST] [--port PORT] [--token SECRET]
mikon run <job_path> --gpu <id>[,<id>...] [--config config.json] [--set key=val]
mikon stop <run_id>
mikon doctor
mikon dataset register <name> <path> [--description TEXT]
```

- `--gpu` accepts unified GPU ids (e.g. `nvidia:0`, `amd:1`). Use `mikon doctor` to list available GPUs.
- `--set` supports dotted keys: `--set optimizer.lr=0.001`
- `--token` is required when `--host` is outside localhost.

---

## Writing a job

```python
import mikon
from mikon import Config, RunContext
from pydantic import Field

class MyConfig(Config):
    lr: float = Field(1e-3, gt=0, le=1)
    epochs: int = Field(10, ge=1, le=100)

@mikon.job
def train(config: MyConfig, ctx: RunContext) -> None:
    for epoch in range(config.epochs):
        loss = compute_loss(...)
        ctx.log_metric("loss", loss, step=epoch)

    model_path = ctx.artifacts_dir / "model.pt"
    torch.save(model, model_path)
    ctx.log_artifact("model.pt", model_path)
```

**`RunContext` key methods:**

| Method | Description |
|--------|-------------|
| `ctx.log_metric(key, value, step=None)` | Record a scalar metric |
| `ctx.log_artifact(name, path)` | Register a file as an artifact |
| `ctx.artifacts_dir` | Path for storing artifact files |
| `ctx.add_dir(path, description=None)` | Register a directory as a dataset |

---

## mikon.toml

```toml
[mikon]
watch = ["src"]            # directories to auto-scan for jobs
store = ".mikon"           # run/metric/artifact storage root
# python = ".venv/bin/python"  # venv isolation (optional)

[gpu]
occupancy_mem_mb = 500     # MiB above which GPU is considered occupied
occupancy_util = 5         # % utilization above which GPU is considered occupied

[modules]
max_nest_depth = 8         # max nesting depth for ModuleRef/ModuleFactory

[docs]
root = "docs"              # document root shown in dashboard Docs tab
```

---

## REST API (`http://localhost:8000/api`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/jobs` | List discovered jobs |
| GET | `/jobs/{name}` | Job detail with config schema |
| POST | `/runs` | Launch a job `{"job", "gpus", "config", "force"}` |
| GET | `/runs` | List runs (filter: status, job, tags, group_id) |
| GET | `/runs/{id}` | Run detail |
| POST | `/runs/{id}/stop` | Stop a running job |
| PATCH | `/runs/{id}` | Update tags, group, star, notes |
| DELETE | `/runs/{id}` | Delete run and all its files |
| GET | `/runs/{id}/metrics` | Metric records |
| GET | `/runs/{id}/logs` | Log lines |
| GET | `/runs/{id}/artifacts` | Artifact list |
| GET | `/runs/{id}/lineage` | Lineage graph |
| GET | `/resources` | GPU/CPU status |
| GET | `/groups` | List groups |
| POST | `/groups` | Create group |
| GET | `/configs` | List saved configs |
| PUT | `/configs/{name}` | Save a config |
| GET | `/compare/runs` | Compare multiple runs |

---

## Store layout

```
.mikon/
  runs/
    {job}__{YYYYMMDD-HHMMSS}__{4hex}/
      meta.json        # job, start time, GPUs, tags, star, group_id
      status.json      # running / completed / failed / stopped / unknown
      config.json      # config at launch time
      metrics.jsonl    # log_metric records (one JSON object per line)
      artifacts.jsonl  # log_artifact records
      inputs.jsonl     # dataset/artifact/module inputs
      logs/
        stdout.log
        stderr.log
  datasets/
    {name}.json
  configs/
    {name}.json
  groups/
    {group_id}.json
```

---

## Notes

- Prefer `mikon run` CLI over calling `POST /api/runs` directly — it handles config loading and error reporting.
- GPU ids come from `mikon doctor`; format is `{vendor}:{index}` (e.g. `nvidia:0`).
- Config is plain JSON; use `--set` for one-off overrides without editing the file.
- `mikon serve` must be running before using the dashboard or REST API.
