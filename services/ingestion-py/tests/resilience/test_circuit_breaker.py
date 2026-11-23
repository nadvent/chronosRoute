"""
Resilience & Concurrency Chaos Test Suite (`tests/resilience/test_circuit_breaker.py`).

Verifies:
1. `CLOSED -> OPEN -> HALF_OPEN -> CLOSED` and `HALF_OPEN -> OPEN` transitions.
2. Single-probe `asyncio.Lock` gate in `HALF_OPEN` under 20x concurrency (zero stampede).
3. `TokenBucketRateLimiter` capacity, depletion, and time-based refill.
4. `full_jitter_backoff` exponential bounds `[0, min(cap, base * 2 ** attempt)]`.
5. `ResilientExternalClient` bounded `asyncio.Semaphore(16)` concurrency and Redis
   `GET weather:grid:{geohash}` fallback with `is_degraded=True` on HTTP 429/503/timeout.
"""

from __future__ import annotations

import asyncio
import json
import random

import httpx
import pytest

from src.ingestion.main import InMemoryRedisStub
from src.ingestion.resilience import (
    CircuitBreaker,
    CircuitBreakerOpenError,
    CircuitState,
    ResilientExternalClient,
    TokenBucketRateLimiter,
    full_jitter_backoff,
)


class FakeClock:
    def __init__(self, initial: float = 1000.0) -> None:
        self.now = initial

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


async def test_circuit_breaker_state_transitions() -> None:
    """Verify CLOSED -> OPEN -> HALF_OPEN -> CLOSED and HALF_OPEN -> OPEN transitions."""
    clock = FakeClock()
    cb = CircuitBreaker(failure_threshold=3, recovery_timeout_sec=10.0, clock=clock)
    assert cb.state == CircuitState.CLOSED

    async def failing_op() -> str:
        raise RuntimeError("Upstream 503")

    async def succeeding_op() -> str:
        return "ok"

    # 3 consecutive failures trip CLOSED -> OPEN
    for _ in range(3):
        with pytest.raises(RuntimeError):
            await cb.call(failing_op)

    assert cb.state == CircuitState.OPEN
    assert cb.failure_count == 3

    # Calls while OPEN are immediately short-circuited
    with pytest.raises(CircuitBreakerOpenError):
        await cb.call(succeeding_op)
    assert cb.total_short_circuited == 1

    # Advance clock past recovery_timeout_sec -> HALF_OPEN
    clock.advance(10.5)
    assert cb.state == CircuitState.HALF_OPEN

    # If probe fails in HALF_OPEN, breaker immediately re-opens
    with pytest.raises(RuntimeError):
        await cb.call(failing_op)
    assert cb.state == CircuitState.OPEN

    # Advance clock again -> HALF_OPEN, then succeed -> CLOSED
    clock.advance(11.0)
    assert cb.state == CircuitState.HALF_OPEN
    res = await cb.call(succeeding_op)
    assert res == "ok"
    assert cb.state == CircuitState.CLOSED
    assert cb.failure_count == 0


async def test_half_open_single_probe_lock_prevents_stampede() -> None:
    """
    When transitioning to HALF_OPEN under 20 concurrent requests, only 1 probe
    request is permitted to hit the upstream while the other 19 fail fast with
    CircuitBreakerOpenError.
    """
    clock = FakeClock()
    cb = CircuitBreaker(failure_threshold=2, recovery_timeout_sec=5.0, clock=clock)

    async def fail_fast() -> None:
        raise RuntimeError("boom")

    for _ in range(2):
        with pytest.raises(RuntimeError):
            await cb.call(fail_fast)
    assert cb.state == CircuitState.OPEN

    clock.advance(6.0)
    assert cb.state == CircuitState.HALF_OPEN

    upstream_invocations = 0
    probe_started = asyncio.Event()
    release_probe = asyncio.Event()

    async def slow_upstream_probe() -> str:
        nonlocal upstream_invocations
        upstream_invocations += 1
        probe_started.set()
        await release_probe.wait()
        return "recovered"

    async def worker() -> str:
        try:
            return await cb.call(slow_upstream_probe)
        except CircuitBreakerOpenError:
            return "short_circuited"

    tasks = [asyncio.create_task(worker()) for _ in range(20)]
    await asyncio.wait_for(probe_started.wait(), timeout=0.5)
    # Give all 19 peer coroutines a turn to hit the HALF_OPEN lock
    await asyncio.sleep(0.02)
    assert cb.half_open_probe_lock.locked() is True
    assert upstream_invocations == 1

    release_probe.set()
    results = await asyncio.gather(*tasks)

    assert upstream_invocations == 1
    assert results.count("recovered") == 1
    assert results.count("short_circuited") == 19
    assert cb.state == CircuitState.CLOSED


async def test_token_bucket_rate_limiter_and_full_jitter_backoff() -> None:
    clock = FakeClock()
    limiter = TokenBucketRateLimiter(rate_per_sec=10.0, capacity=3.0, clock=clock)

    assert limiter.try_acquire(1.0) is True
    assert limiter.try_acquire(1.0) is True
    assert limiter.try_acquire(1.0) is True
    # Bucket is now empty
    assert limiter.try_acquire(1.0) is False

    # Advance 0.25s -> refills 2.5 tokens
    clock.advance(0.25)
    assert limiter.try_acquire(2.0) is True
    assert limiter.try_acquire(1.0) is False

    rng = random.Random(12345)
    for attempt in range(8):
        cap = min(1.5, 0.05 * (2**attempt))
        samples = [
            full_jitter_backoff(attempt, base_delay=0.05, cap_delay=1.5, rng=rng)
            for _ in range(30)
        ]
        assert all(0.0 <= s <= cap for s in samples)
        assert max(samples) > 0.0


async def test_resilient_client_redis_fallback_on_429_503_and_timeout() -> None:
    """
    When Open-Meteo returns 429/503 or times out and trips the circuit breaker,
    `fetch_weather_grid` must return cached Redis speeds (`GET weather:grid:{geohash}`)
    with `is_degraded=True` rather than raising a 500 error.
    """
    redis_stub = InMemoryRedisStub()
    await redis_stub.set(
        "weather:grid:9q8yy",
        json.dumps(
            {
                "geohash": "9q8yy",
                "precipitation_mm": 12.0,
                "wind_speed_kmh": 30.0,
                "speed_multiplier": 0.81,
                "is_degraded": False,
            }
        ),
    )

    mode = "503"
    upstream_calls = 0

    async def transport_handler(request: httpx.Request) -> httpx.Response:
        nonlocal upstream_calls
        upstream_calls += 1
        if mode == "503":
            return httpx.Response(503, json={"error": "service unavailable"})
        if mode == "429":
            return httpx.Response(429, json={"error": "rate limited"})
        if mode == "timeout":
            raise httpx.ReadTimeout("Upstream timed out", request=request)
        return httpx.Response(
            200,
            json={"current": {"precipitation": 0.0, "wind_speed_10m": 5.0}},
        )

    clock = FakeClock()
    cb = CircuitBreaker(failure_threshold=2, recovery_timeout_sec=30.0, clock=clock)
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(transport_handler))
    client = ResilientExternalClient(
        http_client=http_client,
        redis_client=redis_stub,
        circuit_breaker=cb,
        max_concurrency=16,
        max_retries=1,
        base_backoff_sec=0.001,
        cap_backoff_sec=0.005,
    )
    try:
        # 1st call: initial + 1 retry = 2 failures -> trips circuit breaker to OPEN
        res1 = await client.fetch_weather_grid("9q8yy")
        assert res1.is_degraded is True
        assert res1.speed_multiplier == 0.81
        assert res1.precipitation_mm == 12.0
        assert cb.state == CircuitState.OPEN
        assert upstream_calls == 2

        # Subsequent call while OPEN does not hit upstream at all, returns Redis cache
        res2 = await client.fetch_weather_grid("9q8yy")
        assert res2.is_degraded is True
        assert res2.speed_multiplier == 0.81
        assert upstream_calls == 2

        # Advance clock to HALF_OPEN and test timeout fallback
        clock.advance(35.0)
        mode = "timeout"
        res3 = await client.fetch_weather_grid("9q8yy")
        assert res3.is_degraded is True
        assert cb.state == CircuitState.OPEN

        # Advance clock to HALF_OPEN and recover with 200 OK
        clock.advance(35.0)
        mode = "200"
        res4 = await client.fetch_weather_grid("9q8yy")
        assert res4.is_degraded is False
        assert res4.speed_multiplier == 1.0
        assert cb.state == CircuitState.CLOSED
    finally:
        await http_client.aclose()


async def test_resilient_client_enforces_semaphore_16_bound() -> None:
    """Concurrent fan-out of 40 calls must never exceed `max_concurrency=16` in flight."""

    async def slow_handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.02)
        return httpx.Response(
            200,
            json={"current": {"precipitation": 1.0, "wind_speed_10m": 10.0}},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(slow_handler))
    client = ResilientExternalClient(
        http_client=http_client,
        redis_client=InMemoryRedisStub(),
        max_concurrency=16,
    )
    try:
        results = await asyncio.gather(
            *[client.fetch_weather_grid(f"9q8y{i:02d}") for i in range(40)]
        )
        assert len(results) == 40
        assert all(not r.is_degraded for r in results)
        assert client.peak_in_flight <= 16
        assert client.peak_in_flight >= 2
    finally:
        await http_client.aclose()
