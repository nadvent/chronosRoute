"""
Integration Tests for High-Throughput PostgreSQL `COPY` / `UNNEST` and Redis Streams `XADD`
(`tests/integration/test_stream_integration.py`).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from src.ingestion.flusher import (
    REDIS_STREAM_KEY,
    TELEMETRY_COLUMNS,
    TELEMETRY_TABLE,
    TelemetryMicroBatchFlusher,
)
from src.ingestion.main import InMemoryPgPoolStub, InMemoryRedisStub
from src.ingestion.schemas import TelemetryPing


@pytest.mark.integration
async def test_redis_and_postgres_stream_flush_pipeline() -> None:
    """
    Verify that 1,250 telemetry pings enqueued into `TelemetryMicroBatchFlusher`
    flush in two 500-item batches (size trigger) plus one 250-item batch (100ms time
    trigger / drain) concurrently to PostgreSQL (`copy_records_to_table`) and
    Redis Streams (`XADD telemetry:stream MAXLEN ~ 100000`).
    """
    pg_stub = InMemoryPgPoolStub()
    redis_stub = InMemoryRedisStub()

    flusher = TelemetryMicroBatchFlusher(
        pg_pool=pg_stub,
        redis_client=redis_stub,
        max_queue_size=10_000,
        batch_size=500,
        flush_interval_sec=0.08,
    )
    flusher.start()
    try:
        pings = [
            TelemetryPing(
                courier_id=uuid4(),
                lat=37.7500 + (i % 100) * 0.0005,
                lon=-122.4500 + (i % 100) * 0.0005,
                speed_mps=9.5,
                heading_deg=float((i * 15) % 360),
                battery_pct=90 - (i % 30),
                recorded_at=datetime.now(timezone.utc),
            )
            for i in range(1250)
        ]
        depth = flusher.enqueue_batch_nowait(pings)
        assert depth <= 1250

        # Wait for all 3 batches (500 + 500 + 250) to flush
        for _ in range(30):
            if flusher.total_flushed >= 1250:
                break
            await asyncio.sleep(0.02)

        assert flusher.total_flushed == 1250
        assert flusher.flush_history == [500, 500, 250]

        # Verify PostgreSQL COPY records and EWKT point formatting
        assert len(pg_stub.copied_batches) == 3
        total_pg_rows = 0
        for table_name, records, columns in pg_stub.copied_batches:
            assert table_name == TELEMETRY_TABLE
            assert columns == TELEMETRY_COLUMNS
            total_pg_rows += len(records)
            sample_row = records[0]
            assert str(sample_row[2]).startswith("SRID=4326;POINT(")
        assert total_pg_rows == 1250

        # Verify Redis Streams XADD entries
        assert await redis_stub.xlen(REDIS_STREAM_KEY) == 1250
        entries = await redis_stub.xrange(REDIS_STREAM_KEY, count=5)
        assert len(entries) == 5
        _, first_fields = entries[0]
        assert "courier_id" in first_fields
        assert "lat" in first_fields
        assert "lon" in first_fields
        assert "speed_mps" in first_fields
    finally:
        await flusher.stop()


@pytest.mark.integration
async def test_postgres_unnest_fallback_batch_execution() -> None:
    """Verify batched `UNNEST($1::uuid[], ...)` SQL fallback when binary COPY is disabled."""
    pg_stub = InMemoryPgPoolStub()
    redis_stub = InMemoryRedisStub()

    flusher = TelemetryMicroBatchFlusher(
        pg_pool=pg_stub,
        redis_client=redis_stub,
        max_queue_size=10_000,
        batch_size=50,
        flush_interval_sec=0.05,
        use_unnest_fallback=True,
    )
    flusher.start()
    try:
        flusher.enqueue_batch_nowait(
            [
                TelemetryPing(
                    courier_id=uuid4(),
                    lat=37.7749,
                    lon=-122.4194,
                    speed_mps=6.2,
                    heading_deg=270.0,
                    battery_pct=75,
                )
                for _ in range(50)
            ]
        )
        for _ in range(20):
            if flusher.total_flushed >= 50:
                break
            await asyncio.sleep(0.02)

        assert flusher.total_flushed == 50
        assert len(pg_stub.executed_queries) == 1
        sql_text, params = pg_stub.executed_queries[0]
        assert "UNNEST(" in sql_text
        assert len(params) == 7
        assert len(params[0]) == 50
    finally:
        await flusher.stop()
