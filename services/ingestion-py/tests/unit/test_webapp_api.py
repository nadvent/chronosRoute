"""
Unit Tests for Phase 1B Webapp Integration API Endpoints, Rolling Throughput Metrics,
ONNX ETA Comparison, Simulation Chaos Endpoints, and `WS /ws/telemetry`
(`tests/unit/test_webapp_api.py`).
"""

from __future__ import annotations

import time
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from src.ingestion.flusher import TelemetryMicroBatchFlusher
from src.ingestion.main import InMemoryPgPoolStub, InMemoryRedisStub, app
from src.ingestion.resilience import CircuitBreaker, ResilientExternalClient
from src.ingestion.schemas import TelemetryPing


class _FakeClock:
    def __init__(self, initial: float = 5000.0) -> None:
        self.now = initial

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _sample_ping(lat: float = 51.5074, lon: float = -0.1278) -> TelemetryPing:
    return TelemetryPing(
        courier_id=uuid4(),
        lat=lat,
        lon=lon,
        speed_mps=8.2,
        heading_deg=90.0,
        battery_pct=95,
    )


def test_rolling_5s_events_per_sec_and_enqueue_callback() -> None:
    """Flusher must track rolling 5s `events_per_sec` and invoke `on_ping_enqueued`."""
    clock = _FakeClock()
    observed: list[int] = []

    flusher = TelemetryMicroBatchFlusher(
        pg_pool=InMemoryPgPoolStub(),
        redis_client=InMemoryRedisStub(),
        max_queue_size=10_000,
        on_ping_enqueued=lambda batch: observed.append(len(batch)),
        clock=clock,
    )
    assert flusher.events_per_sec == 0.0

    flusher.enqueue_batch_nowait([_sample_ping() for _ in range(50)])
    assert flusher.events_per_sec == pytest.approx(10.0)
    assert observed == [50]

    clock.advance(2.0)
    flusher.enqueue_nowait(_sample_ping())
    assert flusher.events_per_sec == pytest.approx(51 / 5.0, abs=0.01)
    assert observed == [50, 1]

    # Advance past first batch's 5s window while second ping remains within 5s
    clock.advance(3.5)
    assert flusher.events_per_sec == pytest.approx(1 / 5.0, abs=0.01)

    clock.advance(5.0)
    assert flusher.events_per_sec == 0.0


def test_cors_and_london_weather_defaults() -> None:
    seen_url: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_url["url"] = str(request.url)
        return httpx.Response(
            200,
            json={"current": {"precipitation": 2.0, "wind_speed_10m": 15.0}},
        )

    with TestClient(app) as client:
        mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        app.state.resilient_client = ResilientExternalClient(
            http_client=mock_http,
            redis_client=app.state.redis_client,
        )
        res = client.get(
            "/api/v1/weather/gcpvj0",
            headers={"Origin": "http://localhost:5173"},
        )
        assert res.status_code == 200
        assert res.headers.get("access-control-allow-origin") == "*"
        assert "latitude=51.5074" in seen_url["url"]
        assert "longitude=-0.1278" in seen_url["url"]


def test_system_metrics_offline_and_online_orchestrator() -> None:
    with TestClient(app) as client:
        # 1. Force offline orchestrator response (503/ConnectError)
        def offline_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("orchestrator offline", request=request)

        app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(offline_handler))
        res_offline = client.get("/api/v1/system/metrics")
        assert res_offline.status_code == 200
        body = res_offline.json()
        assert "timestamp" in body
        assert set(body["circuit_breakers"].keys()) == {"open_meteo", "osrm", "overpass"}
        assert body["ingestion"]["max_queue_size"] == 10_000
        assert body["orchestrator"]["status"] == "offline"

        # 2. Mock live orchestrator metrics payload
        def online_handler(request: httpx.Request) -> httpx.Response:
            if "/api/v1/orchestrator/metrics" in str(request.url):
                return httpx.Response(
                    200,
                    json={
                        "status": "UP",
                        "virtualThreadsEnabled": True,
                        "activeVirtualThreads": 14,
                        "hikariActiveConnections": 3,
                        "hikariMaxConnections": 32,
                        "postgisQueryLatencyMs": 1.8,
                    },
                )
            return httpx.Response(404)

        app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(online_handler))
        res_online = client.get("/api/v1/system/metrics")
        assert res_online.status_code == 200
        orch = res_online.json()["orchestrator"]
        assert orch["status"] == "UP"
        assert orch["activeVirtualThreads"] == 14
        assert orch["hikariMaxConnections"] == 32


def test_eta_compare_osrm_and_degraded_haversine_fallback() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/route/v1/driving/" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "routes": [
                        {
                            "distance": 4500.0,
                            "duration": 420.0,
                            "geometry": "_p~iF~ps|U",
                        }
                    ]
                },
            )
        return httpx.Response(404)

    with TestClient(app) as client:
        mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        app.state.resilient_client = ResilientExternalClient(
            http_client=mock_http,
            redis_client=InMemoryRedisStub(),
            breakers={
                "open_meteo": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
                "osrm": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
                "overpass": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
            },
            max_retries=1,
            base_backoff_sec=0.001,
            cap_backoff_sec=0.002,
        )

        # Normal OSRM baseline + ONNX inference
        res = client.get(
            "/api/v1/eta/compare",
            params={
                "origin_lat": 51.5074,
                "origin_lon": -0.1278,
                "dest_lat": 51.5246,
                "dest_lon": -0.0950,
                "hour_of_day": 8.5,
                "precipitation_mm": 12.0,
                "wind_speed_kmh": 28.0,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["distance_meters"] == 4500.0
        assert data["osrm_baseline_seconds"] == 420.0
        assert 0.5 <= data["onnx_multiplier"] <= 3.0
        assert data["onnx_eta_seconds"] == pytest.approx(
            420.0 * data["onnx_multiplier"], abs=0.05
        )
        assert data["delta_seconds"] == pytest.approx(
            data["onnx_eta_seconds"] - 420.0, abs=0.02
        )
        assert data["is_degraded"] is False

        # Fault inject OSRM -> Haversine urban fallback + ONNX still scores cleanly
        fault_res = client.post(
            "/api/v1/simulation/fault-injection",
            json={"upstream": "osrm", "status_code": 503, "probe_now": True},
        )
        assert fault_res.status_code == 200
        assert fault_res.json()["breaker"]["state"] == "OPEN"

        degraded_res = client.get(
            "/api/v1/eta/compare",
            params={
                "origin_lat": 51.5074,
                "origin_lon": -0.1278,
                "dest_lat": 51.5246,
                "dest_lon": -0.0950,
            },
        )
        assert degraded_res.status_code == 200
        degraded = degraded_res.json()
        assert degraded["is_degraded"] is True
        assert degraded["distance_meters"] > 2000.0
        assert degraded["osrm_baseline_seconds"] > 100.0
        assert 0.5 <= degraded["onnx_multiplier"] <= 3.0


def test_fault_injection_and_ws_telemetry_broadcast() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/telemetry") as ws:
            hello = ws.receive_json()
            assert hello["type"] == "system_status"
            assert "circuit_breakers" in hello["data"]

            # Inject 503 on OSRM -> trips to OPEN and broadcasts event
            res_open = client.post(
                "/api/v1/simulation/fault-injection",
                json={"upstream": "osrm", "status_code": 503},
            )
            assert res_open.status_code == 200
            body_open = res_open.json()
            assert body_open["breaker"]["state"] == "OPEN"
            assert body_open["circuit_breakers"]["open_meteo"]["state"] == "CLOSED"

            msg_open = ws.receive_json()
            assert msg_open["type"] == "circuit_breaker"
            assert msg_open["data"]["upstream"] == "osrm"
            assert msg_open["data"]["breaker"]["state"] == "OPEN"

            # Clear fault injection -> resets to CLOSED and broadcasts event
            res_clear = client.post(
                "/api/v1/simulation/fault-injection",
                json={"upstream": "osrm", "status_code": None},
            )
            assert res_clear.status_code == 200
            assert res_clear.json()["breaker"]["state"] == "CLOSED"

            msg_clear = ws.receive_json()
            assert msg_clear["type"] == "circuit_breaker"
            assert msg_clear["data"]["injected_status"] is None
            assert msg_clear["data"]["breaker"]["state"] == "CLOSED"


def test_telemetry_ingest_broadcasts_to_ws_telemetry() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/telemetry") as ws_sub:
            assert ws_sub.receive_json()["type"] == "system_status"

            # 1. HTTP POST /api/v1/telemetry broadcasts to WS /ws/telemetry
            ping_payload = _sample_ping().model_dump(mode="json")
            post_res = client.post("/api/v1/telemetry", json=ping_payload)
            assert post_res.status_code == 202

            frame1 = ws_sub.receive_json()
            assert frame1["type"] == "telemetry_batch"
            assert frame1["data"]["count"] == 1
            assert frame1["data"]["simulated"] is False

            # 2. Inbound WS /ws/v1/telemetry also broadcasts to WS /ws/telemetry
            with client.websocket_connect("/ws/v1/telemetry") as ws_in:
                ws_in.send_json(_sample_ping().model_dump(mode="json"))
                ack = ws_in.receive_json()
                assert ack["status"] == "queued"

                frame2 = ws_sub.receive_json()
                assert frame2["type"] == "telemetry_batch"
                assert frame2["data"]["count"] == 1


def test_simulation_burst_clamping_and_broadcast() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/telemetry") as ws_sub:
            assert ws_sub.receive_json()["type"] == "system_status"

            # Excessive parameters clamp to [50, 5000] and [1, 15]
            res1 = client.post(
                "/api/v1/simulation/burst",
                json={"rate_per_sec": 25000, "duration_sec": 99},
            )
            assert res1.status_code == 202
            body1 = res1.json()
            assert body1["rate_per_sec"] == 5000
            assert body1["duration_sec"] == 15
            assert body1["center_lat"] == pytest.approx(51.5074)
            assert body1["center_lon"] == pytest.approx(-0.1278)

            # Replacement burst cancels previous task cleanly and clamps lower bounds
            res2 = client.post(
                "/api/v1/simulation/burst",
                json={"rate_per_sec": 5, "duration_sec": 0},
            )
            assert res2.status_code == 202
            body2 = res2.json()
            assert body2["rate_per_sec"] == 50
            assert body2["duration_sec"] == 1

            # Wait briefly for a simulated telemetry_batch frame
            deadline = time.monotonic() + 2.0
            found_sim = False
            while time.monotonic() < deadline:
                msg = ws_sub.receive_json()
                if msg["type"] == "telemetry_batch" and msg["data"].get("simulated") is True:
                    found_sim = True
                    assert msg["data"]["count"] >= 1
                    break
            assert found_sim is True


def test_simulation_weather_surge_caches_redis_and_forwards_reoptimize() -> None:
    reopt_requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "/api/v1/dispatch/reoptimize" in str(request.url):
            reopt_requests.append({"headers": dict(request.headers), "body": request.content})
            return httpx.Response(
                200,
                json={
                    "distanceSavedMeters": 340,
                    "resolvedViolations": 2,
                    "solveTelemetry": {"solveDurationMs": 95, "solverStatus": "OPTIMAL"},
                },
            )
        return httpx.Response(404)

    with TestClient(app) as client:
        redis_stub = InMemoryRedisStub()
        app.state.redis_client = redis_stub
        app.state.resilient_client = ResilientExternalClient(
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            redis_client=redis_stub,
        )
        app.state.http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        with client.websocket_connect("/ws/telemetry") as ws_sub:
            assert ws_sub.receive_json()["type"] == "system_status"

            res = client.post(
                "/api/v1/simulation/weather-surge",
                json={
                    "center_lat": 51.5074,
                    "center_lon": -0.1278,
                    "precipitation_mm": 30.0,
                    "wind_speed_kmh": 40.0,
                    "grid_radius": 1,
                    "trigger_reoptimize": True,
                },
            )
            assert res.status_code == 200
            body = res.json()
            assert body["status"] == "applied"
            assert body["cells_updated"] == 9
            assert body["reoptimized"] is True
            assert len(reopt_requests) == 1

            # All 9 geohash cells cached in Redis
            weather_keys = [k for k in redis_stub.kv if k.startswith("weather:grid:")]
            assert len(weather_keys) == 9

            msg1 = ws_sub.receive_json()
            msg2 = ws_sub.receive_json()
            assert {msg1["type"], msg2["type"]} == {"weather_surge", "solver_event"}
