"""
Bounded Asyncio Queue & Micro-Batch Flusher (`[HUMAN-OWNED]`).

Implements backpressure-safe telemetry buffering (`asyncio.Queue(maxsize=10_000)`),
dual-trigger micro-batching (every 500 items OR 100ms), graceful `CancelledError`
shutdown draining, and concurrent persistence to PostgreSQL (`copy_records_to_table` /
batched `UNNEST`) and Redis Streams (`XADD telemetry:stream MAXLEN ~ 100000`).
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
from collections import deque
from collections.abc import Callable, Coroutine, Sequence
from typing import Any

from src.ingestion.schemas import TelemetryPing

logger = logging.getLogger(__name__)

TELEMETRY_TABLE = "courier_telemetry"
TELEMETRY_COLUMNS = (
    "courier_id",
    "recorded_at",
    "location",
    "speed_mps",
    "heading_deg",
    "battery_pct",
)
REDIS_STREAM_KEY = "telemetry:stream"
REDIS_STREAM_MAXLEN = 100_000

UNNEST_INSERT_SQL = """
INSERT INTO courier_telemetry (
    courier_id,
    recorded_at,
    location,
    speed_mps,
    heading_deg,
    battery_pct
)
SELECT
    u.courier_id,
    u.recorded_at,
    ST_SetSRID(ST_MakePoint(u.lon, u.lat), 4326)::geography,
    u.speed_mps,
    u.heading_deg,
    u.battery_pct
FROM UNNEST(
    $1::uuid[],
    $2::timestamptz[],
    $3::float8[],
    $4::float8[],
    $5::float4[],
    $6::float4[],
    $7::int2[]
) AS u(courier_id, recorded_at, lon, lat, speed_mps, heading_deg, battery_pct);
"""


def format_postgis_ewkt(lon: float, lat: float) -> str:
    """Format WGS84 coordinates as PostGIS EWKT point string for COPY."""
    return f"SRID=4326;POINT({lon:.6f} {lat:.6f})"


class TelemetryMicroBatchFlusher:
    """
    Bounded in-memory micro-batch flusher for courier GPS telemetry.

    Hard Invariants:
    - Never uses an unbounded queue (`max_queue_size` must be > 0, default 10,000).
    - Never blocks the event loop on enqueue (`enqueue_nowait` uses `put_nowait`,
      raising `asyncio.QueueFull` so FastAPI returns HTTP 429/503 backpressure).
    - Flushes every `batch_size` (500) items OR `flush_interval_sec` (0.1s / 100ms).
    - Drains and flushes all remaining buffered items on `asyncio.CancelledError`.
    """

    def __init__(
        self,
        pg_pool: Any = None,
        redis_client: Any = None,
        max_queue_size: int = 10_000,
        batch_size: int = 500,
        flush_interval_sec: float = 0.1,
        stream_key: str = REDIS_STREAM_KEY,
        stream_maxlen: int = REDIS_STREAM_MAXLEN,
        use_unnest_fallback: bool = False,
        on_ping_enqueued: Callable[[list[TelemetryPing]], Coroutine[Any, Any, None] | None]
        | None = None,
        on_batch_flushed: Callable[[list[TelemetryPing]], Coroutine[Any, Any, None] | None]
        | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_queue_size <= 0:
            raise ValueError("max_queue_size must be strictly positive (unbounded queues banned)")
        if batch_size <= 0:
            raise ValueError("batch_size must be strictly positive")
        if flush_interval_sec <= 0.0:
            raise ValueError("flush_interval_sec must be strictly positive")

        self._pg_pool = pg_pool
        self._redis_client = redis_client
        self._max_queue_size = max_queue_size
        self._batch_size = batch_size
        self._flush_interval_sec = flush_interval_sec
        self._stream_key = stream_key
        self._stream_maxlen = stream_maxlen
        self._use_unnest_fallback = use_unnest_fallback
        self._on_ping_enqueued = on_ping_enqueued
        self._on_batch_flushed = on_batch_flushed
        self._clock = clock

        self._queue: asyncio.Queue[TelemetryPing] = asyncio.Queue(maxsize=max_queue_size)
        self._task: asyncio.Task[None] | None = None
        self._running = False
        self._enqueue_timestamps: deque[float] = deque(maxlen=50_000)
        self._background_callbacks: set[asyncio.Task[Any]] = set()

        # Observability counters
        self.total_enqueued: int = 0
        self.total_flushed: int = 0
        self.batches_flushed: int = 0
        self.flush_errors: int = 0
        self.last_flush_size: int = 0
        self.flush_history: list[int] = []

    @property
    def queue(self) -> asyncio.Queue[TelemetryPing]:
        return self._queue

    @property
    def max_queue_size(self) -> int:
        return self._max_queue_size

    @property
    def batch_size(self) -> int:
        return self._batch_size

    @property
    def flush_interval_sec(self) -> float:
        return self._flush_interval_sec

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    def get_events_per_sec(self, window_sec: float = 5.0) -> float:
        """Compute rolling ingestion rate (events/sec) over the past `window_sec` seconds."""
        if window_sec <= 0.0:
            raise ValueError("window_sec must be strictly positive")
        cutoff = self._clock() - window_sec
        while self._enqueue_timestamps and self._enqueue_timestamps[0] < cutoff:
            self._enqueue_timestamps.popleft()
        return round(len(self._enqueue_timestamps) / window_sec, 2)

    @property
    def events_per_sec(self) -> float:
        """Rolling 5-second telemetry ingestion rate in events/sec."""
        return self.get_events_per_sec(window_sec=5.0)

    def _fire_enqueued_callback(self, pings: list[TelemetryPing]) -> None:
        if self._on_ping_enqueued is None or not pings:
            return
        try:
            maybe_coro = self._on_ping_enqueued(pings)
            if inspect.isawaitable(maybe_coro):
                try:
                    loop = asyncio.get_running_loop()
                    task = loop.create_task(maybe_coro)
                    self._background_callbacks.add(task)
                    task.add_done_callback(self._background_callbacks.discard)
                except RuntimeError:
                    if inspect.iscoroutine(maybe_coro):
                        maybe_coro.close()
        except Exception:
            logger.debug("on_ping_enqueued callback error", exc_info=True)

    def enqueue_nowait(self, ping: TelemetryPing) -> int:
        """
        Enqueue a single telemetry ping without blocking.
        Raises `asyncio.QueueFull` immediately if the bounded queue is at capacity.
        """
        self._queue.put_nowait(ping)
        self.total_enqueued += 1
        self._enqueue_timestamps.append(self._clock())
        self._fire_enqueued_callback([ping])
        return self._queue.qsize()

    def enqueue_batch_nowait(self, pings: Sequence[TelemetryPing]) -> int:
        """
        Atomically enqueue a batch of telemetry pings without blocking.
        Raises `asyncio.QueueFull` if the remaining queue capacity cannot fit the entire batch.
        """
        available = self._max_queue_size - self._queue.qsize()
        if len(pings) > available:
            raise asyncio.QueueFull(
                f"Queue capacity exceeded: needed {len(pings)}, available {available}"
            )
        for ping in pings:
            self._queue.put_nowait(ping)
        self.total_enqueued += len(pings)
        now = self._clock()
        self._enqueue_timestamps.extend([now] * len(pings))
        self._fire_enqueued_callback(list(pings))
        return self._queue.qsize()

    def start(self) -> asyncio.Task[None]:
        """Start the background micro-batch flush loop task."""
        if self._task is None or self._task.done():
            self._running = True
            self._task = asyncio.create_task(self.run(), name="telemetry-microbatch-flusher")
        return self._task

    async def stop(self) -> None:
        """Cancel the background loop and ensure all remaining queued items are drained."""
        self._running = False
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # Final defensive drain in case items were enqueued right as the task exited
        await self._drain_remaining([])
        if self._background_callbacks:
            await asyncio.gather(*list(self._background_callbacks), return_exceptions=True)
        self._task = None

    async def run(self) -> None:
        """
        Main background worker loop.
        Flushes whenever `batch_size` (500) items accumulate OR `flush_interval_sec` (100ms)
        elapses after the first item in a batch arrives.
        On `asyncio.CancelledError`, drains and flushes all buffered pings before exiting.
        """
        self._running = True
        loop = asyncio.get_running_loop()
        current_batch: list[TelemetryPing] = []

        try:
            while self._running:
                first_ping = await self._queue.get()
                current_batch = [first_ping]
                deadline = loop.time() + self._flush_interval_sec

                # Drain immediately available items without context switching
                while len(current_batch) < self._batch_size:
                    try:
                        current_batch.append(self._queue.get_nowait())
                    except asyncio.QueueEmpty:
                        break

                # Wait up to the remaining 100ms window for additional items to reach batch_size
                while len(current_batch) < self._batch_size:
                    remaining = deadline - loop.time()
                    if remaining <= 0.0:
                        break
                    try:
                        next_ping = await asyncio.wait_for(self._queue.get(), timeout=remaining)
                        current_batch.append(next_ping)
                        # Greedily pull any burst peers that arrived simultaneously
                        while len(current_batch) < self._batch_size:
                            try:
                                current_batch.append(self._queue.get_nowait())
                            except asyncio.QueueEmpty:
                                break
                    except TimeoutError:
                        break

                batch_to_flush = current_batch
                current_batch = []
                await self._flush_batch(batch_to_flush)
        except asyncio.CancelledError:
            await self._drain_remaining(current_batch)
            raise

    async def _drain_remaining(self, partial_batch: list[TelemetryPing]) -> None:
        """Drain all items remaining in the bounded queue and flush in micro-batches."""
        pending = list(partial_batch)
        while not self._queue.empty():
            try:
                pending.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break

        for idx in range(0, len(pending), self._batch_size):
            chunk = pending[idx : idx + self._batch_size]
            if chunk:
                await self._flush_batch(chunk)

    async def _flush_batch(self, batch: list[TelemetryPing]) -> None:
        """Concurrently flush a micro-batch to PostgreSQL and Redis Streams."""
        if not batch:
            return

        try:
            await asyncio.gather(
                self._write_postgres(batch),
                self._write_redis(batch),
            )
            if self._on_batch_flushed is not None:
                maybe_coro = self._on_batch_flushed(batch)
                if inspect.isawaitable(maybe_coro):
                    await maybe_coro

            batch_len = len(batch)
            self.total_flushed += batch_len
            self.batches_flushed += 1
            self.last_flush_size = batch_len
            self.flush_history.append(batch_len)
        except Exception as exc:
            self.flush_errors += 1
            logger.exception("Failed to flush telemetry micro-batch of size %d: %s", len(batch), exc)
        finally:
            for _ in batch:
                try:
                    self._queue.task_done()
                except ValueError:
                    pass

    async def _write_postgres(self, batch: list[TelemetryPing]) -> None:
        """Bulk insert telemetry pings using asyncpg `copy_records_to_table` or `UNNEST`."""
        if self._pg_pool is None:
            return

        if hasattr(self._pg_pool, "acquire"):
            acquire_ctx = self._pg_pool.acquire()
            async with acquire_ctx as conn:
                await self._write_postgres_conn(conn, batch)
        else:
            await self._write_postgres_conn(self._pg_pool, batch)

    async def _write_postgres_conn(self, conn: Any, batch: list[TelemetryPing]) -> None:
        if not self._use_unnest_fallback and hasattr(conn, "copy_records_to_table"):
            records = [
                (
                    ping.courier_id,
                    ping.recorded_at,
                    format_postgis_ewkt(ping.lon, ping.lat),
                    float(ping.speed_mps),
                    float(ping.heading_deg),
                    int(ping.battery_pct),
                )
                for ping in batch
            ]
            await conn.copy_records_to_table(
                TELEMETRY_TABLE,
                records=records,
                columns=TELEMETRY_COLUMNS,
            )
        elif hasattr(conn, "execute"):
            await conn.execute(
                UNNEST_INSERT_SQL,
                [p.courier_id for p in batch],
                [p.recorded_at for p in batch],
                [float(p.lon) for p in batch],
                [float(p.lat) for p in batch],
                [float(p.speed_mps) for p in batch],
                [float(p.heading_deg) for p in batch],
                [int(p.battery_pct) for p in batch],
            )

    async def _write_redis(self, batch: list[TelemetryPing]) -> None:
        """Append telemetry pings to Redis Streams with `XADD telemetry:stream MAXLEN ~ 100000`."""
        if self._redis_client is None:
            return

        entries = [
            {
                "courier_id": str(ping.courier_id),
                "lat": f"{ping.lat:.6f}",
                "lon": f"{ping.lon:.6f}",
                "speed_mps": f"{ping.speed_mps:.2f}",
                "heading_deg": f"{ping.heading_deg:.2f}",
                "battery_pct": str(ping.battery_pct),
                "recorded_at": ping.recorded_at.isoformat(),
            }
            for ping in batch
        ]

        if hasattr(self._redis_client, "pipeline"):
            pipe = self._redis_client.pipeline(transaction=False)
            for fields in entries:
                pipe.xadd(
                    self._stream_key,
                    fields,
                    maxlen=self._stream_maxlen,
                    approximate=True,
                )
            res = pipe.execute()
            if inspect.isawaitable(res):
                await res
        elif hasattr(self._redis_client, "xadd"):
            for fields in entries:
                res = self._redis_client.xadd(
                    self._stream_key,
                    fields,
                    maxlen=self._stream_maxlen,
                    approximate=True,
                )
                if inspect.isawaitable(res):
                    await res
