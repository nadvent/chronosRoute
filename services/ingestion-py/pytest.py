"""
Pytest bootstrap shim for offline/sandboxed invocation via `/usr/bin/python3 -m pytest`.
Loads the real `pytest` package from `.venv` or the local `uv` wheel archive after
configuring `sys.path`.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parent.parent

from src._env import bootstrap_environment  # noqa: E402

bootstrap_environment()


def _load_real_pytest():
    candidates = [
        _REPO_ROOT / ".venv" / "lib" / "python3.12" / "site-packages" / "pytest" / "__init__.py",
        Path("/home/nazhanys/.cache/uv/archive-v0/gmC3TpmHMUJjawOF/pytest/__init__.py"),
    ]
    for init_py in candidates:
        if init_py.is_file():
            spec = importlib.util.spec_from_file_location(
                "pytest",
                str(init_py),
                submodule_search_locations=[str(init_py.parent)],
            )
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                sys.modules["pytest"] = module
                spec.loader.exec_module(module)
                return module
    raise RuntimeError("Unable to locate real pytest installation in .venv or uv cache")


_is_main = __name__ == "__main__"
_real_pytest = _load_real_pytest()
globals().update({k: v for k, v in _real_pytest.__dict__.items() if k != "__name__"})

if _is_main:
    raise SystemExit(_real_pytest.main())
