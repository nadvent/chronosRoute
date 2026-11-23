"""
Unit & Smoke Tests for the FastAPI Edge Ingestion Gateway (`src/ingestion/main.py`).
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from src.ingestion.flusher import TelemetryMicroBatchFlusher
from src.ingestion.main import InMemoryPgPoolStub, InMemoryRedisStub, app
from src.ingestion.resilience import CircuitBreaker, ResilientExternalClient


def test_health_check() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"
        assert body["service"] == "ingestion-py"
        assert body["max_queue_size"] == 10_000


def test_telemetry_post_single_and_batch() -> None:
    with TestClient(app) as client:
        single_payload = {
            "courier_id": str(uuid4()),
            "lat": 37.7749,
            "lon": -122.4194,
            "speed_mps": 8.5,
            "heading_deg": 180.0,
            "battery_pct": 92,
            "recorded_at": datetime.now(timezone.utc).isoformat(),
        }
        res_single = client.post("/api/v1/telemetry", json=single_payload)
        assert res_single.status_code == 202
        assert res_single.json()["accepted"] == 1
        assert res_single.json()["status"] == "queued"

        batch_payload = {
            "pings": [
                {
                    "courier_id": str(uuid4()),
                    "lat": 37.7750 + i * 0.0001,
                    "lon": -122.4190 - i * 0.0001,
                    "speed_mps": 6.0,
                    "heading": 90.0,
                    "battery_pct": 85,
                }
                for i in range(5)
            ]
        }
        res_batch = client.post("/api/v1/telemetry", json=batch_payload)
        assert res_batch.status_code == 202
        assert res_batch.json()["accepted"] == 5


def test_telemetry_validation_rejects_invalid_coordinates() -> None:
    with TestClient(app) as client:
        bad_payload = {
            "courier_id": str(uuid4()),
            "lat": 95.0,  # invalid latitude > 90
            "lon": -122.4194,
            "speed_mps": -1.0,  # invalid negative speed
        }
        res = client.post("/api/v1/telemetry", json=bad_payload)
        assert res.status_code == 422


def test_telemetry_backpressure_http_429_when_queue_full() -> None:
    with TestClient(app) as client:
        # Replace flusher with a tiny non-started bounded queue of size 2
        small_flusher = TelemetryMicroBatchFlusher(
            pg_pool=InMemoryPgPoolStub(),
            redis_client=InMemoryRedisStub(),
            max_queue_size=2,
            batch_size=500,
            flush_interval_sec=10.0,
        )
        app.state.flusher = small_flusher

        ping = {
            "courier_id": str(uuid4()),
            "lat": 37.7749,
            "lon": -122.4194,
            "speed_mps": 5.0,
            "heading_deg": 45.0,
            "battery_pct": 80,
        }
        assert client.post("/api/v1/telemetry", json=ping).status_code == 202
        assert client.post("/api/v1/telemetry", json=ping).status_code == 202

        # 3rd ping exceeds bounded queue capacity -> HTTP 429 backpressure
        overflow = client.post("/api/v1/telemetry", json=ping)
        assert overflow.status_code == 429
        assert "Retry-After" in overflow.headers


def test_websocket_telemetry_stream_and_backpressure() -> None:
    with TestClient(app) as client:
        small_flusher = TelemetryMicroBatchFlusher(
            pg_pool=InMemoryPgPoolStub(),
            redis_client=InMemoryRedisStub(),
            max_queue_size=1,
            batch_size=500,
            flush_interval_sec=10.0,
        )
        app.state.flusher = small_flusher

        with client.websocket_connect("/ws/v1/telemetry") as ws:
            ping = {
                "courier_id": str(uuid4()),
                "lat": 37.7749,
                "lon": -122.4194,
                "speed_mps": 4.2,
                "heading_deg": 120.0,
            }
            ws.send_json(ping)
            ack1 = ws.receive_json()
            assert ack1["status"] == "queued"
            assert ack1["queue_depth"] == 1

            # Second message hits QueueFull backpressure
            ws.send_json(ping)
            ack2 = ws.receive_json()
            assert ack2["status"] == "backpressure"
            assert ack2["code"] == 429


def test_weather_and_route_endpoints_with_mock_transport() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "forecast" in str(request.url):
            return httpx.Response(
                200,
                json={"current": {"precipitation": 5.0, "wind_speed_10m": 25.0}},
            )
        if "/route/v1/driving/" in str(request.url):
            return httpx.Response(
                200,
                json={
                    "routes": [
                        {
                            "distance": 4250.5,
                            "duration": 390.2,
                            "geometry": "_p~iF~ps|U_ulLnnqC",
                        }
                    ]
                },
            )
        return httpx.Response(503)

    with TestClient(app) as client:
        mock_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        redis_stub = InMemoryRedisStub()
        app.state.resilient_client = ResilientExternalClient(
            http_client=mock_http,
            redis_client=redis_stub,
            circuit_breaker=CircuitBreaker(failure_threshold=3, recovery_timeout_sec=5.0),
            max_concurrency=16,
        )

        w_res = client.get("/api/v1/weather/9q8yyk")
        assert w_res.status_code == 200
        w_body = w_res.json()
        assert w_body["geohash"] == "9q8yyk"
        assert w_body["precipitation_mm"] == 5.0
        assert w_body["is_degraded"] is False

        r_res = client.get(
            "/api/v1/route/baseline",
            params={
                "origin_lat": 37.7749,
                "origin_lon": -122.4194,
                "dest_lat": 37.7849,
                "dest_lon": -122.4094,
            },
        )
        assert r_res.status_code == 200
        r_body = r_res.json()
        assert r_body["distance_meters"] == 4250.5
        assert r_body["encoded_polyline"] == "_p~iF~ps|U_ulLnnqC"
        assert r_body["is_degraded"] is False
