"""
Environment path bootstrapper for ChronosRoute ingestion-py.
Ensures pure-Python wheels in the local .venv or uv cache are importable when invoked
via system /usr/bin/python3 in offline/sandboxed environments.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parent.parent

_UV_ARCHIVE_DIRS = [
    "/home/nazhanys/.cache/uv/archive-v0/gmC3TpmHMUJjawOF",  # pytest 9.2.0
    "/home/nazhanys/.cache/uv/archive-v0/1r3O1efYVSBY88Wv",  # pluggy 1.7.0
    "/home/nazhanys/.cache/uv/archive-v0/TZCJkiEbFhVNX8W8",  # iniconfig 2.3.1
    "/home/nazhanys/.cache/uv/archive-v0/8ZiCgBG4JDVHgjyZ",  # fastapi 0.162.0
    "/home/nazhanys/.cache/uv/archive-v0/B6jZFbwqp7CN0yiF",  # opentelemetry_api 1.45.2
    "/home/nazhanys/.cache/uv/archive-v0/-ETq0Ec6Pu61rMTB",  # importlib_metadata 8.9.0
    "/home/nazhanys/.cache/uv/archive-v0/_Fw8xor0RfZR4Zh4",  # zipp 4.1.2
    "/home/nazhanys/.cache/uv/archive-v0/xOSqw-ziLtSISjFU",  # starlette 1.10.0
    "/home/nazhanys/.cache/uv/archive-v0/c8pLFlAoY6TxixTb",  # anyio 4.16.0
    "/home/nazhanys/.cache/uv/archive-v0/U6PssRPBmsl5xtp2",  # sniffio 1.3.1
    "/home/nazhanys/.cache/uv/archive-v0/RKSIq7TvVnHYxVc-",  # httpx 0.28.1
    "/home/nazhanys/.cache/uv/archive-v0/ZgNkYQ0DHtdUm7zb",  # httpcore 1.0.9
    "/home/nazhanys/.cache/uv/archive-v0/s_ZK3fa9aLKnruhK",  # httpx2 2.16.0
    "/home/nazhanys/.cache/uv/archive-v0/ar1MmBowd6hRzL8v",  # httpcore2 2.16.0
    "/home/nazhanys/.cache/uv/archive-v0/Rw5fD3KyXPmdDUq5",  # h11 0.16.0
    "/home/nazhanys/.cache/uv/archive-v0/LifYb9eWYTOtc2Rn",  # pydantic_settings 2.16.2
    "/home/nazhanys/.cache/uv/archive-v0/Fz9joQidnYhFD86U",  # python_dotenv 1.2.4
    "/home/nazhanys/.cache/uv/archive-v0/XsBSdbeXEb4RGEym",  # annotated_doc 0.0.5
    "/home/nazhanys/.cache/uv/archive-v0/1o_vKQWe4nDn9qZy",  # uvicorn 0.54.0
    "/home/nazhanys/.cache/uv/archive-v0/d2Du-d03RUu8JJI_",  # websockets 17.4
    "/home/nazhanys/.cache/uv/archive-v0/9Q6ZD0nM7N8QN--O",  # click 8.5.1
    "/home/nazhanys/.cache/uv/archive-v0/-0wmWQlWPUFeLMOu",  # protobuf 7.36.2
    "/home/nazhanys/.cache/uv/archive-v0/exG1_VASzngnputD",  # onnx_ir 1.0.0
]


def bootstrap_environment() -> None:
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")

    service_root_str = str(SERVICE_ROOT)
    if service_root_str not in sys.path:
        sys.path.insert(0, service_root_str)

    venv_site = REPO_ROOT / ".venv" / "lib" / "python3.12" / "site-packages"
    if venv_site.is_dir() and str(venv_site) not in sys.path:
        sys.path.append(str(venv_site))

    for archive_dir in _UV_ARCHIVE_DIRS:
        if os.path.isdir(archive_dir) and archive_dir not in sys.path:
            sys.path.append(archive_dir)


bootstrap_environment()
