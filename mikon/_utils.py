from __future__ import annotations

from pathlib import Path


def is_relative_to(path: Path, root: Path) -> bool:
    """Return True if *path* is contained within *root*, resolving symlinks on both sides."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False
