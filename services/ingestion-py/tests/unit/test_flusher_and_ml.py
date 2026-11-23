"""
Unit Tests for Bounded Micro-Batch Flusher (`src/ingestion/flusher.py`) and
Spatio-Temporal Feature Engineering & ONNX Parity (`src/ml/`).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from uuid import uuid4

import numpy as np
import pytest

from src.ingestion.flusher import TelemetryMicroBatchFlusher
from src.ingestion.main import InMemoryPgPoolStub, InMemoryRedisStub
from src.ingestion.schemas import TelemetryPing
from src.ml.export_onnx import (
    export_and_verify,
    score_onnx_runtime,
    train_eta_residual_model,
    verify_onnx_parity,
)
from src.ml.features import (
    FEATURE_DIM,
    build_feature_matrix,
    cyclical_encode,
    initial_bearing_deg,
    spherical_haversine_km,
)


def _make_ping(speed: float = 7.5) -> TelemetryPing:
    return TelemetryPing(
        courier_id=uuid4(),
        lat=37.7749,
        lon=-122.4194,
        speed_mps=speed,
        heading_deg=90.0,
        battery_pct=88,
    )


def test_flusher_forbids_unbounded_queue() -> None:
    with pytest.raises(ValueError, match="max_queue_size"):
        TelemetryMicroBatchFlusher(max_queue_size=0)
    with pytest.raises(ValueError, match="max_queue_size"):
        TelemetryMicroBatchFlusher(max_queue_size=-5)


async def test_flusher_size_trigger_500_items() -> None:
    """Flusher must flush immediately when 500 items accumulate without waiting for a long timeout."""
    pg_stub = InMemoryPgPoolStub()
    redis_stub = InMemoryRedisStub()
    flushed_event = asyncio.Event()

    async def on_flushed(batch: list[TelemetryPing]) -> None:
        if len(batch) == 500:
            flushed_event.set()

    flusher = TelemetryMicroBatchFlusher(
        pg_pool=pg_stub,
        redis_client=redis_stub,
        max_queue_size=10_000,
        batch_size=500,
        flush_interval_sec=5.0,  # Long interval proves the 500-item size trigger fired
        on_batch_flushed=on_flushed,
    )
    flusher.start()
    try:
        t0 = time.monotonic()
        flusher.enqueue_batch_nowait([_make_ping() for _ in range(500)])
        await asyncio.wait_for(flushed_event.wait(), timeout=0.5)
        elapsed = time.monotonic() - t0

        assert elapsed < 0.45
        assert flusher.total_flushed == 500
        assert flusher.last_flush_size == 500
        assert len(pg_stub.copied_batches) == 1
        assert len(pg_stub.copied_batches[0][1]) == 500
        assert await redis_stub.xlen("telemetry:stream") == 500
    finally:
        await flusher.stop()


async def test_flusher_time_trigger_100ms() -> None:
    """Flusher must flush partial batches (< 500 items) when the 100ms deadline expires."""
    pg_stub = InMemoryPgPoolStub()
    redis_stub = InMemoryRedisStub()
    flushed_event = asyncio.Event()

    async def on_flushed(batch: list[TelemetryPing]) -> None:
        flushed_event.set()

    flusher = TelemetryMicroBatchFlusher(
        pg_pool=pg_stub,
        redis_client=redis_stub,
        max_queue_size=10_000,
        batch_size=500,
        flush_interval_sec=0.1,
        on_batch_flushed=on_flushed,
    )
    flusher.start()
    try:
        flusher.enqueue_batch_nowait([_make_ping() for _ in range(12)])
        await asyncio.wait_for(flushed_event.wait(), timeout=0.4)
        assert flusher.total_flushed == 12
        assert flusher.last_flush_size == 12
    finally:
        await flusher.stop()


async def test_flusher_cancelled_error_drains_remaining_items() -> None:
    """On `asyncio.CancelledError`, flusher must drain and flush all remaining buffered pings."""
    pg_stub = InMemoryPgPoolStub()
    redis_stub = InMemoryRedisStub()
    flusher = TelemetryMicroBatchFlusher(
        pg_pool=pg_stub,
        redis_client=redis_stub,
        max_queue_size=10_000,
        batch_size=500,
        flush_interval_sec=10.0,  # Long interval so items are still buffered when cancelled
    )

    flusher.enqueue_batch_nowait([_make_ping() for _ in range(75)])
    task = flusher.start()
    await asyncio.sleep(0.02)

    # Cancel task directly to simulate SIGTERM shutdown
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert flusher.queue_depth == 0
    assert flusher.total_flushed == 75
    assert len(pg_stub.copied_batches) == 1
    assert len(pg_stub.copied_batches[0][1]) == 75
    assert await redis_stub.xlen("telemetry:stream") == 75


def test_cyclical_encoding_wrap_around_continuity() -> None:
    """0:00 and 24:00 (and 0 deg and 360 deg) must map to identical cyclical coordinates."""
    h_sin_0, h_cos_0 = cyclical_encode(0.0, period=24.0)
    h_sin_24, h_cos_24 = cyclical_encode(24.0, period=24.0)
    assert np.allclose(h_sin_0, h_sin_24, atol=1e-6)
    assert np.allclose(h_cos_0, h_cos_24, atol=1e-6)

    # 23:00 and 00:00 should be adjacent on the unit circle (angle 15 deg)
    h_sin_23, h_cos_23 = cyclical_encode(23.0, period=24.0)
    euclid_23_to_0 = float(np.hypot(h_sin_23 - h_sin_0, h_cos_23 - h_cos_0))
    assert euclid_23_to_0 < 0.30

    deg_sin_0, deg_cos_0 = cyclical_encode(0.0, period=360.0)
    deg_sin_360, deg_cos_360 = cyclical_encode(360.0, period=360.0)
    assert np.allclose(deg_sin_0, deg_sin_360, atol=1e-6)
    assert np.allclose(deg_cos_0, deg_cos_360, atol=1e-6)


def test_spherical_haversine_and_feature_matrix_shape() -> None:
    # SF Ferry Building to Mission Dolores (~4.2 km)
    dist_km = spherical_haversine_km(37.7955, -122.3937, 37.7597, -122.4271)
    assert 4.0 < float(dist_km) < 5.5

    bearing = initial_bearing_deg(37.7955, -122.3937, 37.7597, -122.4271)
    assert 200.0 < float(bearing) < 250.0

    mat = build_feature_matrix(
        hour_of_day=[8.5, 17.5, 23.0],
        heading_deg=[45.0, 180.0, 359.0],
        precipitation_mm=[0.0, 12.5, 2.0],
        wind_speed_kmh=[10.0, 35.0, 15.0],
    )
    assert mat.shape == (3, FEATURE_DIM)
    assert mat.dtype == np.float32


def test_onnx_export_and_runtime_parity(tmp_path: Path) -> None:
    onnx_file = tmp_path / "eta_residual_v1.onnx"
    report = export_and_verify(output_path=onnx_file, verify=True, atol=1e-5)

    assert onnx_file.is_file()
    assert report["valid"] is True
    assert report["max_abs_diff"] <= 1e-5

    model = train_eta_residual_model()
    parity = verify_onnx_parity(model, onnx_file, atol=1e-5)
    assert parity["valid"] is True

    # Score custom batch and verify multiplier bounds [0.5, 3.0]
    features = build_feature_matrix(
        hour_of_day=np.linspace(0, 23, 16),
        heading_deg=np.linspace(0, 350, 16),
        precipitation_mm=np.linspace(0, 20, 16),
        wind_speed_kmh=np.linspace(0, 50, 16),
    )
    preds = score_onnx_runtime(onnx_file, features)
    assert preds.shape == (16, 1)
    assert preds.dtype == np.float32
    assert bool(np.all((preds >= 0.5) & (preds <= 3.0)))
