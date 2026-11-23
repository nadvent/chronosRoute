"""
Pytest configuration and native asyncio test runner hook for services/ingestion-py.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

import pytest

from src._env import bootstrap_environment

bootstrap_environment()


def pytest_addoption(parser: pytest.Parser) -> None:
    try:
        parser.addini("asyncio_mode", "Asyncio mode for coroutine tests", default="auto")
    except ValueError:
        pass


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers",
        "integration: integration tests requiring external services (PostgreSQL, Redis)",
    )
    config.addinivalue_line(
        "markers",
        "asyncio: mark a test function as an asyncio coroutine",
    )


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: pytest.Function) -> bool | None:
    testfunction = pyfuncitem.obj
    if inspect.iscoroutinefunction(testfunction):
        funcargs = pyfuncitem.funcargs
        testargs = {arg: funcargs[arg] for arg in pyfuncitem._fixtureinfo.argnames}
        asyncio.run(testfunction(**testargs))
        return True
    return None
