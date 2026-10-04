"""Assemble a kernel-only Vercel context from the canonical Python package."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/tmp/b123-kernel-repository-deploy"))
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    repository = source.parents[1]
    output = args.output.resolve()
    if output == repository or output.is_relative_to(repository):
        parser.error("Choose a deployment context outside the repository")
    output.mkdir(parents=True, exist_ok=True)
    for filename in ("pyproject.toml", "uv.lock"):
        shutil.copy2(repository / filename, output / filename)
    shutil.copytree(repository / "python" / "build123d_fiber", output / "python" / "build123d_fiber", dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info"))
    backend = output / "deployment" / "kernel"
    backend.mkdir(parents=True, exist_ok=True)
    for filename in ("app.py", "vercel.json", "pyproject.toml", "uv.lock", ".python-version"):
        shutil.copy2(source / filename, backend / filename)
    if (source / "fonts").exists():
        shutil.copytree(source / "fonts", backend / "fonts", dirs_exist_ok=True)
    if (source / "native-libs").exists():
        shutil.copytree(source / "native-libs", backend / "native-libs", dirs_exist_ok=True)
    print(output)


if __name__ == "__main__":
    main()
