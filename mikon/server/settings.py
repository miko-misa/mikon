from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    project_root: Path
    watch: tuple[Path, ...]
    store: Path
    python: str | None = None
    occupancy_mem_mb: int = 500
    occupancy_util: float = 5.0
    docs_root: Path | None = None
    max_module_nest_depth: int = 8


def load_settings(project_root: Path | None = None) -> Settings:
    root = (project_root or Path.cwd()).resolve()
    path = root / "mikon.toml"
    data: dict = {}
    if path.exists():
        data = tomllib.loads(path.read_text(encoding="utf-8"))

    mikon_data = data.get("mikon", {})
    gpu_data = data.get("gpu", {})
    docs_data = data.get("docs", {})
    modules_data = data.get("modules", {})

    watch_values = mikon_data.get("watch", ["src"])
    watch_paths = tuple((root / item).resolve() for item in watch_values)
    store = (root / mikon_data.get("store", ".mikon")).resolve()
    docs_root = docs_data.get("root", "docs")
    python_raw = mikon_data.get("python")
    python: str | None = None
    if python_raw is not None:
        p = Path(python_raw)
        python = str(root / p if not p.is_absolute() else p)
    return Settings(
        project_root=root,
        watch=watch_paths,
        store=store,
        python=python,
        occupancy_mem_mb=int(gpu_data.get("occupancy_mem_mb", 500)),
        occupancy_util=float(gpu_data.get("occupancy_util", 5)),
        docs_root=(root / docs_root).resolve(),
        max_module_nest_depth=int(modules_data.get("max_nest_depth", 8)),
    )
