"""
Per-Upstream Circuit Breaker & Fault Injection Resilience Tests
(`tests/resilience/test_per_upstream_breakers.py`).
"""

from __future__ import annotations

import json

import httpx
import pytest

from src.ingestion.main import InMemoryRedisStub
from src.ingestion.resilience import (
    CircuitBreaker,
    CircuitState,
    ResilientExternalClient,
)


class FakeClock:
    def __init__(self, initial: float = 2000.0) -> None:
        self.now = initial

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


async def test_independent_per_upstream_circuit_breakers() -> None:
    """Tripping `osrm` must leave `open_meteo` and `overpass` breakers CLOSED and healthy."""

    async def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "/route/v1/driving/" in url:
            return httpx.Response(503, json={"error": "osrm down"})
        if "forecast" in url:
            return httpx.Response(
                200,
                json={"current": {"precipitation": 1.5, "wind_speed_10m": 12.0}},
            )
        if "interpreter" in url:
            return httpx.Response(
                200,
                json={"elements": [{"type": "node", "id": 1}, {"type": "way", "id": 2}]},
            )
        return httpx.Response(404)

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    clock = FakeClock()
    client = ResilientExternalClient(
        http_client=http_client,
        redis_client=InMemoryRedisStub(),
        breakers={
            "open_meteo": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0, clock=clock),
            "osrm": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0, clock=clock),
            "overpass": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0, clock=clock),
        },
        max_retries=1,
        base_backoff_sec=0.001,
        cap_backoff_sec=0.002,
    )
    try:
        assert set(client.breakers.keys()) == {"open_meteo", "osrm", "overpass"}
        assert client.circuit_breaker is client.breakers["open_meteo"]

        # Trip OSRM breaker -> falls back to Haversine degraded estimate
        route_res = await client.fetch_route_baseline(51.5074, -0.1278, 51.5200, -0.0900)
        assert route_res.is_degraded is True
        assert client.breakers["osrm"].state == CircuitState.OPEN

        # Open-Meteo and Overpass remain CLOSED and operational
        weather_res = await client.fetch_weather_grid("gcpvj0")
        assert weather_res.is_degraded is False
        assert client.breakers["open_meteo"].state == CircuitState.CLOSED

        graph_res = await client.fetch_road_graph((51.49, -0.15, 51.53, -0.10))
        assert graph_res.is_degraded is False
        assert graph_res.node_count == 1
        assert graph_res.edge_count == 1
        assert client.breakers["overpass"].state == CircuitState.CLOSED
    finally:
        await http_client.aclose()


async def test_fault_injection_trips_breaker_and_triggers_redis_fallback() -> None:
    """
    Setting `fault_injection_modes[upstream]` must raise `UpstreamHttpError` inside
    `breaker.call(...)` without hitting HTTP transport, transition `CLOSED -> OPEN`,
    and serve cached Redis fallback (`is_degraded=True`).
    """
    redis_stub = InMemoryRedisStub()
    await redis_stub.set(
        "weather:grid:gcpvj0",
        json.dumps(
            {
                "geohash": "gcpvj0",
                "precipitation_mm": 18.0,
                "wind_speed_kmh": 35.0,
                "speed_multiplier": 0.724,
                "is_degraded": False,
            }
        ),
    )

    http_calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal http_calls
        http_calls += 1
        return httpx.Response(
            200,
            json={"current": {"precipitation": 0.0, "wind_speed_10m": 5.0}},
        )

    clock = FakeClock()
    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ResilientExternalClient(
        http_client=http_client,
        redis_client=redis_stub,
        circuit_breaker=CircuitBreaker(failure_threshold=2, recovery_timeout_sec=15.0, clock=clock),
        max_retries=1,
        base_backoff_sec=0.001,
        cap_backoff_sec=0.002,
    )
    try:
        client.set_fault_injection("open_meteo", 503)
        res1 = await client.fetch_weather_grid("gcpvj0")
        assert res1.is_degraded is True
        assert res1.precipitation_mm == 18.0
        assert res1.speed_multiplier == 0.724
        assert http_calls == 0

        # Subsequent call while OPEN short-circuits immediately
        res2 = await client.fetch_weather_grid("gcpvj0")
        assert res2.is_degraded is True
        assert http_calls == 0

        statuses = client.get_breaker_statuses()
        om_status = statuses["open_meteo"]
        assert om_status["state"] == "OPEN"
        assert om_status["total_calls"] == 3
        assert om_status["total_failures"] == 2
        assert om_status["total_short_circuited"] == 1
        assert om_status["injected_status"] == 503
        assert om_status["error_rate"] == pytest.approx(2 / 3)

        # Clear fault injection and verify natural HALF_OPEN -> CLOSED recovery
        client.set_fault_injection("open_meteo", None)
        clock.advance(16.0)
        res3 = await client.fetch_weather_grid("gcpvj0")
        assert res3.is_degraded is False
        assert http_calls == 1
        assert client.breakers["open_meteo"].state == CircuitState.CLOSED
    finally:
        await http_client.aclose()


async def test_fetch_weather_grid_defaults_to_london_coordinates() -> None:
    """Verify default coordinates for `fetch_weather_grid` target London (51.5074, -0.1278)."""
    seen_params: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen_params["latitude"] = request.url.params.get("latitude", "")
        seen_params["longitude"] = request.url.params.get("longitude", "")
        return httpx.Response(
            200,
            json={"current": {"precipitation": 0.0, "wind_speed_10m": 8.0}},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = ResilientExternalClient(http_client=http_client, redis_client=InMemoryRedisStub())
    try:
        res = await client.fetch_weather_grid("gcpvj0")
        assert res.is_degraded is False
        assert float(seen_params["latitude"]) == pytest.approx(51.5074)
        assert float(seen_params["longitude"]) == pytest.approx(-0.1278)
    finally:
        await http_client.aclose()
