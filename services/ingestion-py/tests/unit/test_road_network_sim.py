"""
Unit tests for OSM road-network geometry endpoint (`/api/v1/graph/network`),
Overpass circuit-breaker fallback, and road-following GPS burst simulation.
"""

from __future__ import annotations

import time

import httpx
import pytest
from fastapi.testclient import TestClient

from src.ingestion.main import (
    InMemoryRedisStub,
    _build_curved_urban_road_network,
    _compute_compass_bearing_deg,
    _smooth_polyline_corners,
    app,
)
from src.ingestion.resilience import CircuitBreaker, ResilientExternalClient, _haversine_meters


def test_compass_bearing_accounts_for_latitude() -> None:
    lat, lon = 51.5074, -0.1278
    assert _compute_compass_bearing_deg(lat, lon, lat + 0.01, lon) == pytest.approx(0.0, abs=0.2)
    assert _compute_compass_bearing_deg(lat, lon, lat, lon + 0.01) == pytest.approx(90.0, abs=0.2)
    assert _compute_compass_bearing_deg(lat, lon, lat - 0.01, lon) == pytest.approx(180.0, abs=0.2)
    assert _compute_compass_bearing_deg(lat, lon, lat, lon - 0.01) == pytest.approx(270.0, abs=0.2)


def test_road_network_endpoint_parses_drivable_osm_and_caches_fallback() -> None:
    sample_overpass = {
        "elements": [
            {"type": "node", "id": 10, "lat": 51.5070, "lon": -0.1280},
            {"type": "node", "id": 11, "lat": 51.5080, "lon": -0.1280},
            {"type": "node", "id": 12, "lat": 51.5080, "lon": -0.1260},
            {"type": "node", "id": 13, "lat": 51.5090, "lon": -0.1260},
            {
                "type": "way",
                "id": 100,
                "nodes": [10, 11, 12],
                "tags": {"highway": "primary", "oneway": "yes", "maxspeed": "30 mph"},
            },
            # Footway must be excluded from drivable road graph
            {
                "type": "way",
                "id": 101,
                "nodes": [12, 13],
                "tags": {"highway": "footway"},
            },
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if "interpreter" in str(request.url):
            return httpx.Response(200, json=sample_overpass)
        return httpx.Response(404)

    with TestClient(app) as client:
        redis_stub = InMemoryRedisStub()
        app.state.redis_client = redis_stub
        app.state.resilient_client = ResilientExternalClient(
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            redis_client=redis_stub,
            breakers={
                "open_meteo": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
                "osrm": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
                "overpass": CircuitBreaker(failure_threshold=2, recovery_timeout_sec=10.0),
            },
            max_retries=1,
            base_backoff_sec=0.001,
            cap_backoff_sec=0.002,
        )

        res = client.get(
            "/api/v1/graph/network",
            params={"south": 51.50, "west": -0.14, "north": 51.52, "east": -0.11},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["is_degraded"] is False
        assert body["node_count"] == 3  # node 13 (footway only) excluded
        assert body["edge_count"] == 2
        assert body["edges"][0][2] == "primary"
        assert body["edges"][0][3] is True
        assert body["edges"][0][4] == pytest.approx(13.41, abs=0.05)

        # Trip overpass breaker -> serves cached Redis road graph with is_degraded=True
        app.state.resilient_client.set_fault_injection("overpass", 503)
        degraded = client.get(
            "/api/v1/graph/network",
            params={"south": 51.50, "west": -0.14, "north": 51.52, "east": -0.11},
        )
        assert degraded.status_code == 200
        dbody = degraded.json()
        assert dbody["is_degraded"] is True
        assert dbody["node_count"] == 3
        assert dbody["edge_count"] == 2


def test_road_following_burst_simulation_emits_bounded_steps() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/telemetry") as ws_sub:
            assert ws_sub.receive_json()["type"] == "system_status"
            res = client.post(
                "/api/v1/simulation/burst",
                json={
                    "rate_per_sec": 120,
                    "duration_sec": 1,
                    "center_lat": 51.5074,
                    "center_lon": -0.1278,
                    "courier_count": 12,
                },
            )
            assert res.status_code == 202

            seen_by_courier: dict[str, tuple[float, float]] = {}
            max_step_m = 0.0
            frames = 0
            deadline = time.monotonic() + 2.5
            while time.monotonic() < deadline and frames < 5:
                msg = ws_sub.receive_json()
                if msg["type"] == "telemetry_batch" and msg["data"].get("simulated") is True:
                    frames += 1
                    for ping in msg["data"]["pings"]:
                        cid = ping["courier_id"]
                        lat, lon = float(ping["lat"]), float(ping["lon"])
                        assert 0.0 <= float(ping["heading_deg"]) <= 360.0
                        if cid in seen_by_courier:
                            plat, plon = seen_by_courier[cid]
                            max_step_m = max(max_step_m, _haversine_meters(plat, plon, lat, lon))
                        seen_by_courier[cid] = (lat, lon)

            assert frames >= 2
            assert max_step_m <= 20.0


def test_curved_urban_network_and_corner_smoothing() -> None:
    nodes, adj = _build_curved_urban_road_network(51.5074, -0.1278)
    assert len(nodes) == 31
    edge_shapes = [geom for outs in adj for (_v, _spd, geom) in outs]
    assert len(edge_shapes) > 80
    assert all(len(geom) >= 5 for geom in edge_shapes)

    sharp = [(-0.1278, 51.5074), (-0.1278, 51.5084), (-0.1262, 51.5084)]
    curved = _smooth_polyline_corners(sharp, fillet_m=12.0, arc_steps=3)
    assert len(curved) >= 5
    assert curved[0] == sharp[0]
    assert curved[-1] == sharp[-1]
