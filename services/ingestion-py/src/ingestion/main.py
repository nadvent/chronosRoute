"""
FastAPI Lifespan & Edge Ingestion Gateway Endpoints (`[CO-AUTHORED]`).

Initializes shared `httpx.AsyncClient`, bounded `TelemetryMicroBatchFlusher`
(`asyncio.Queue(maxsize=10_000)`), and `ResilientExternalClient` (`asyncio.Semaphore(16)`)
once inside the application lifespan hook.
"""

from __future__ import annotations

import asyncio
import math
import random
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from src._env import REPO_ROOT, SERVICE_ROOT, bootstrap_environment
from src.ingestion.flusher import TelemetryMicroBatchFlusher
from src.ingestion.resilience import (
    CircuitState,
    ResilientExternalClient,
    _haversine_meters,
    compute_weather_speed_multiplier,
)
from src.ingestion.schemas import (
    CircuitBreakerMetrics,
    EtaCompareResponse,
    IngestionMetrics,
    RoadGraphNetworkResponse,
    RoadGraphResponse,
    RouteBaselineResponse,
    SimulationBurstRequest,
    SimulationFaultRequest,
    SimulationWeatherSurgeRequest,
    SystemMetricsResponse,
    TelemetryBatchRequest,
    TelemetryIngestResponse,
    TelemetryPing,
    WeatherGridCell,
    WeatherGridResponse,
)
from src.ml.export_onnx import score_onnx_runtime
from src.ml.features import build_feature_matrix

bootstrap_environment()

try:
    import asyncpg  # type: ignore[import-untyped]
except ImportError:
    asyncpg = None

try:
    import redis.asyncio as redis_async  # type: ignore[import-untyped]
except ImportError:
    redis_async = None


class Settings(BaseSettings):
    """Runtime configuration for the ChronosRoute Ingestion Gateway."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "ChronosRoute Ingestion Gateway"
    postgres_async_url: str = "postgresql://chronos:chronos_dev_password@localhost:5432/chronos_route"
    redis_url: str = "redis://localhost:6379/0"
    osrm_url: str = "http://localhost:5000"
    open_meteo_url: str = "https://api.open-meteo.com/v1/forecast"
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    orchestrator_url: str = "http://localhost:8080"
    concurrency_limit: int = 16
    max_queue_size: int = 10_000
    batch_size: int = 500
    flush_interval_sec: float = 0.1


settings = Settings()


class InMemoryRedisStub:
    """Lightweight bounded async Redis stub used when external Redis is offline in unit tests."""

    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self._seq: int = 0

    async def get(self, key: str) -> str | None:
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self.kv[key] = value
        return True

    async def xadd(
        self,
        stream_key: str,
        fields: dict[str, str],
        maxlen: int = 100_000,
        approximate: bool = True,
    ) -> str:
        self._seq += 1
        entry_id = f"{self._seq}-0"
        bucket = self.streams.setdefault(stream_key, [])
        bucket.append((entry_id, dict(fields)))
        if len(bucket) > maxlen:
            del bucket[: len(bucket) - maxlen]
        return entry_id

    async def xlen(self, stream_key: str) -> int:
        return len(self.streams.get(stream_key, []))

    async def xrange(
        self,
        stream_key: str,
        min_id: str = "-",
        max_id: str = "+",
        count: int | None = None,
    ) -> list[tuple[str, dict[str, str]]]:
        items = list(self.streams.get(stream_key, []))
        return items[:count] if count is not None else items

    def pipeline(self, transaction: bool = False) -> _InMemoryRedisPipeline:
        return _InMemoryRedisPipeline(self)

    async def aclose(self) -> None:
        return None


class _InMemoryRedisPipeline:
    def __init__(self, stub: InMemoryRedisStub) -> None:
        self._stub = stub
        self._ops: list[tuple[str, dict[str, str], int, bool]] = []

    def xadd(
        self,
        stream_key: str,
        fields: dict[str, str],
        maxlen: int = 100_000,
        approximate: bool = True,
    ) -> _InMemoryRedisPipeline:
        self._ops.append((stream_key, fields, maxlen, approximate))
        return self

    async def execute(self) -> list[str]:
        ids: list[str] = []
        for stream_key, fields, maxlen, approximate in self._ops:
            entry_id = await self._stub.xadd(
                stream_key,
                fields,
                maxlen=maxlen,
                approximate=approximate,
            )
            ids.append(entry_id)
        self._ops.clear()
        return ids


class InMemoryPgPoolStub:
    """Lightweight asyncpg pool/connection stub used when PostgreSQL is offline in unit tests."""

    def __init__(self) -> None:
        self.copied_batches: list[tuple[str, list[tuple[Any, ...]], tuple[str, ...]]] = []
        self.executed_queries: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def acquire(self) -> AsyncGenerator[InMemoryPgPoolStub, None]:
        yield self

    async def copy_records_to_table(
        self,
        table_name: str,
        *,
        records: list[tuple[Any, ...]],
        columns: tuple[str, ...],
    ) -> str:
        self.copied_batches.append((table_name, list(records), tuple(columns)))
        return f"COPY {len(records)}"

    async def execute(self, query: str, *args: Any) -> str:
        self.executed_queries.append((query, args))
        return "INSERT 0"

    async def close(self) -> None:
        return None


_GEOHASH_ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz"


def _encode_geohash(lat: float, lon: float, precision: int = 6) -> str:
    """Encode WGS84 `(lat, lon)` into a standard base32 geohash string."""
    lat_interval = [-90.0, 90.0]
    lon_interval = [-180.0, 180.0]
    chars: list[str] = []
    bits = 0
    ch = 0
    is_lon = True
    bit_masks = (16, 8, 4, 2, 1)

    while len(chars) < precision:
        if is_lon:
            mid = (lon_interval[0] + lon_interval[1]) / 2.0
            if lon >= mid:
                ch |= bit_masks[bits]
                lon_interval[0] = mid
            else:
                lon_interval[1] = mid
        else:
            mid = (lat_interval[0] + lat_interval[1]) / 2.0
            if lat >= mid:
                ch |= bit_masks[bits]
                lat_interval[0] = mid
            else:
                lat_interval[1] = mid
        is_lon = not is_lon
        bits += 1
        if bits == 5:
            chars.append(_GEOHASH_ALPHABET[ch])
            bits = 0
            ch = 0
    return "".join(chars)


def _resolve_onnx_model_path() -> Path:
    """Resolve the ONNX residual ETA model path across local dev and Docker layouts."""
    candidates = (
        Path("../../models/eta_residual_v1.onnx"),
        SERVICE_ROOT / "models" / "eta_residual_v1.onnx",
        REPO_ROOT / "models" / "eta_residual_v1.onnx",
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def _offline_orchestrator_metrics() -> dict[str, Any]:
    """Return safe fallback metrics when orchestrator-java is unreachable."""
    return {
        "status": "offline",
        "virtualThreadsEnabled": True,
        "activeVirtualThreads": 0,
        "bulkheadMaxPermits": 24,
        "bulkheadAvailablePermits": 24,
        "bulkheadTotalAcquisitions": 0,
        "peakConcurrentBatchHolders": 0,
        "hikariActiveConnections": 0,
        "hikariIdleConnections": 0,
        "hikariMaxConnections": 32,
        "postgisQueryLatencyMs": 0.0,
        "solverDeadlineMs": 450,
        "lastSolveDurationMs": 0,
        "lastMatrixPreprocessMs": 0,
        "lastObjectiveCost": 0.0,
        "lastIterationsCompleted": 0,
        "solverWorkers": 8,
    }


class WebSocketBroadcastHub:
    """Bounded fan-out hub for browser `WS /ws/telemetry` subscribers."""

    def __init__(self, max_clients: int = 256, send_timeout_sec: float = 0.25) -> None:
        if max_clients <= 0:
            raise ValueError("max_clients must be strictly positive")
        self._max_clients = max_clients
        self._send_timeout_sec = send_timeout_sec
        self._clients: set[WebSocket] = set()
        self._send_locks: dict[WebSocket, asyncio.Lock] = {}

    @property
    def client_count(self) -> int:
        return len(self._clients)

    async def connect(self, websocket: WebSocket) -> bool:
        if len(self._clients) >= self._max_clients:
            await websocket.close(code=1013, reason="WebSocket subscriber capacity reached")
            return False
        await websocket.accept()
        self._clients.add(websocket)
        self._send_locks[websocket] = asyncio.Lock()
        return True

    def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)
        self._send_locks.pop(websocket, None)

    async def send_to(self, websocket: WebSocket, message: dict[str, Any]) -> bool:
        lock = self._send_locks.get(websocket)
        try:
            if lock is not None:
                async with lock:
                    await asyncio.wait_for(
                        websocket.send_json(message), timeout=self._send_timeout_sec
                    )
            else:
                await asyncio.wait_for(
                    websocket.send_json(message), timeout=self._send_timeout_sec
                )
            return True
        except Exception:
            self.disconnect(websocket)
            return False

    async def broadcast(self, event_type: str, data: Any) -> int:
        if not self._clients:
            return 0
        message = {
            "type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data,
        }
        snapshot = list(self._clients)
        results = await asyncio.gather(
            *(self.send_to(client, message) for client in snapshot),
            return_exceptions=True,
        )
        return sum(1 for r in results if r is True)

    async def close_all(self) -> None:
        snapshot = list(self._clients)
        self._clients.clear()
        self._send_locks.clear()
        for client in snapshot:
            try:
                await client.close()
            except Exception:
                pass


def _pings_broadcast_payload(
    pings: list[TelemetryPing],
    queue_depth: int,
    events_per_sec: float,
    *,
    simulated: bool = False,
) -> dict[str, Any]:
    return {
        "pings": [p.model_dump(mode="json") for p in pings[:200]],
        "count": len(pings),
        "queue_depth": queue_depth,
        "events_per_sec": events_per_sec,
        "simulated": simulated,
    }


def _ensure_app_state(target_app: FastAPI) -> None:
    """Ensure `app.state` holds initialized singletons even if TestClient skipped lifespan."""
    if not hasattr(target_app.state, "redis_client") or target_app.state.redis_client is None:
        target_app.state.redis_client = InMemoryRedisStub()
    if not hasattr(target_app.state, "pg_pool") or target_app.state.pg_pool is None:
        target_app.state.pg_pool = InMemoryPgPoolStub()
    if not hasattr(target_app.state, "http_client") or target_app.state.http_client is None:
        target_app.state.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(2.0),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
    if not hasattr(target_app.state, "flusher") or target_app.state.flusher is None:
        target_app.state.flusher = TelemetryMicroBatchFlusher(
            pg_pool=target_app.state.pg_pool,
            redis_client=target_app.state.redis_client,
            max_queue_size=settings.max_queue_size,
            batch_size=settings.batch_size,
            flush_interval_sec=settings.flush_interval_sec,
        )
    if (
        not hasattr(target_app.state, "resilient_client")
        or target_app.state.resilient_client is None
    ):
        target_app.state.resilient_client = ResilientExternalClient(
            http_client=target_app.state.http_client,
            redis_client=target_app.state.redis_client,
            max_concurrency=settings.concurrency_limit,
            open_meteo_url=settings.open_meteo_url,
            osrm_url=settings.osrm_url,
            overpass_url=settings.overpass_url,
        )
    if not hasattr(target_app.state, "ws_hub") or target_app.state.ws_hub is None:
        target_app.state.ws_hub = WebSocketBroadcastHub()
    if not hasattr(target_app.state, "burst_task"):
        target_app.state.burst_task = None


@asynccontextmanager
async def lifespan(target_app: FastAPI) -> AsyncGenerator[None, None]:
    """
    FastAPI lifespan hook managing shared connection pools and the background
    micro-batch telemetry flusher. Attempts live asyncpg pool and redis.asyncio
    connections first, falling back gracefully to in-memory stubs when offline.
    """
    if getattr(target_app.state, "pg_pool", None) is None:
        if asyncpg is not None:
            try:
                target_app.state.pg_pool = await asyncpg.create_pool(
                    settings.postgres_async_url,
                    min_size=2,
                    max_size=16,
                    timeout=2.0,
                )
            except Exception:
                target_app.state.pg_pool = InMemoryPgPoolStub()
        else:
            target_app.state.pg_pool = InMemoryPgPoolStub()

    if getattr(target_app.state, "redis_client", None) is None:
        if redis_async is not None:
            try:
                live_redis = redis_async.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    socket_connect_timeout=1.0,
                )
                await live_redis.ping()
                target_app.state.redis_client = live_redis
            except Exception:
                target_app.state.redis_client = InMemoryRedisStub()
        else:
            target_app.state.redis_client = InMemoryRedisStub()

    _ensure_app_state(target_app)
    flusher: TelemetryMicroBatchFlusher = target_app.state.flusher
    flusher.start()
    try:
        yield
    finally:
        burst_task: asyncio.Task[None] | None = getattr(target_app.state, "burst_task", None)
        if burst_task is not None and not burst_task.done():
            burst_task.cancel()
            try:
                await burst_task
            except asyncio.CancelledError:
                pass
        target_app.state.burst_task = None

        if getattr(target_app.state, "ws_hub", None) is not None:
            await target_app.state.ws_hub.close_all()
            target_app.state.ws_hub = None

        await flusher.stop()
        if getattr(target_app.state, "http_client", None) is not None:
            await target_app.state.http_client.aclose()
            target_app.state.http_client = None
        if getattr(target_app.state, "redis_client", None) is not None and hasattr(
            target_app.state.redis_client, "aclose"
        ):
            await target_app.state.redis_client.aclose()
        if getattr(target_app.state, "pg_pool", None) is not None and hasattr(
            target_app.state.pg_pool, "close"
        ):
            await target_app.state.pg_pool.close()
        target_app.state.redis_client = None
        target_app.state.pg_pool = None
        target_app.state.flusher = None
        target_app.state.resilient_client = None


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_flusher(request: Request) -> TelemetryMicroBatchFlusher:
    _ensure_app_state(request.app)
    return request.app.state.flusher


def get_resilient_client(request: Request) -> ResilientExternalClient:
    _ensure_app_state(request.app)
    return request.app.state.resilient_client


def get_ws_hub(request: Request) -> WebSocketBroadcastHub:
    _ensure_app_state(request.app)
    return request.app.state.ws_hub


def get_http_client(request: Request) -> httpx.AsyncClient:
    _ensure_app_state(request.app)
    return request.app.state.http_client


@app.get("/health")
async def health_check(
    flusher: TelemetryMicroBatchFlusher = Depends(get_flusher),
) -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "ingestion-py",
        "queue_depth": flusher.queue_depth,
        "max_queue_size": flusher.max_queue_size,
    }


@app.post(
    "/api/v1/telemetry",
    response_model=TelemetryIngestResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def ingest_telemetry(
    payload: TelemetryPing | TelemetryBatchRequest | list[TelemetryPing],
    flusher: TelemetryMicroBatchFlusher = Depends(get_flusher),
    ws_hub: WebSocketBroadcastHub = Depends(get_ws_hub),
) -> TelemetryIngestResponse:
    """
    Non-blocking telemetry ingestion endpoint.
    Enqueues GPS pings via `put_nowait()` and returns HTTP 429 Too Many Requests
    backpressure immediately if the bounded 10,000-element queue is full.
    """
    try:
        if isinstance(payload, TelemetryPing):
            pings = [payload]
            depth = flusher.enqueue_nowait(payload)
            accepted = 1
        elif isinstance(payload, TelemetryBatchRequest):
            pings = list(payload.pings)
            depth = flusher.enqueue_batch_nowait(pings)
            accepted = len(pings)
        else:
            pings = list(payload)
            depth = flusher.enqueue_batch_nowait(pings)
            accepted = len(pings)
    except asyncio.QueueFull as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Telemetry queue at capacity (10,000 max); apply client backpressure",
            headers={"Retry-After": "1"},
        ) from exc

    await ws_hub.broadcast(
        "telemetry_batch",
        _pings_broadcast_payload(pings, depth, flusher.events_per_sec),
    )

    return TelemetryIngestResponse(
        status="queued",
        accepted=accepted,
        queue_depth=depth,
    )


@app.websocket("/ws/v1/telemetry")
async def websocket_telemetry(websocket: WebSocket) -> None:
    """High-frequency WebSocket telemetry ingestion stream with bounded queue backpressure."""
    _ensure_app_state(websocket.app)
    flusher: TelemetryMicroBatchFlusher = websocket.app.state.flusher
    ws_hub: WebSocketBroadcastHub = websocket.app.state.ws_hub
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_json()
            try:
                ping = TelemetryPing.model_validate(raw)
                depth = flusher.enqueue_nowait(ping)
                await ws_hub.broadcast(
                    "telemetry_batch",
                    _pings_broadcast_payload([ping], depth, flusher.events_per_sec),
                )
                await websocket.send_json(
                    {"status": "queued", "accepted": 1, "queue_depth": depth}
                )
            except ValidationError as exc:
                await websocket.send_json(
                    {"status": "invalid", "code": 422, "errors": exc.errors()}
                )
            except asyncio.QueueFull:
                await websocket.send_json(
                    {
                        "status": "backpressure",
                        "code": 429,
                        "detail": "Telemetry queue full",
                    }
                )
    except WebSocketDisconnect:
        return


@app.websocket("/ws/telemetry")
async def websocket_telemetry_broadcast(websocket: WebSocket) -> None:
    """Outbound live telemetry, circuit-breaker, and solver event broadcast stream."""
    _ensure_app_state(websocket.app)
    ws_hub: WebSocketBroadcastHub = websocket.app.state.ws_hub
    flusher: TelemetryMicroBatchFlusher = websocket.app.state.flusher
    resilient_client: ResilientExternalClient = websocket.app.state.resilient_client

    if not await ws_hub.connect(websocket):
        return

    try:
        await ws_hub.send_to(
            websocket,
            {
                "type": "system_status",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": {
                    "events_per_sec": flusher.events_per_sec,
                    "queue_depth": flusher.queue_depth,
                    "circuit_breakers": resilient_client.get_breaker_statuses(),
                },
            },
        )
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or '"ping"' in msg:
                await ws_hub.send_to(
                    websocket,
                    {
                        "type": "pong",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                )
    except WebSocketDisconnect:
        return
    except Exception:
        return
    finally:
        ws_hub.disconnect(websocket)


@app.get("/api/v1/weather/{geohash}", response_model=WeatherGridResponse)
async def get_weather_grid(
    geohash: str,
    lat: float = Query(default=51.5074, ge=-90.0, le=90.0),
    lon: float = Query(default=-0.1278, ge=-180.0, le=180.0),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> WeatherGridResponse:
    """
    Fetch spatial weather conditions for `geohash`.
    Falls back to cached Redis grid with `is_degraded=True` when the circuit breaker is OPEN.
    """
    return await resilient_client.fetch_weather_grid(geohash=geohash, lat=lat, lon=lon)


@app.get("/api/v1/route/baseline", response_model=RouteBaselineResponse)
async def get_route_baseline(
    origin_lat: float = Query(..., ge=-90.0, le=90.0),
    origin_lon: float = Query(..., ge=-180.0, le=180.0),
    dest_lat: float = Query(..., ge=-90.0, le=90.0),
    dest_lon: float = Query(..., ge=-180.0, le=180.0),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> RouteBaselineResponse:
    """Fetch baseline driving route polyline and duration from OSRM with degraded fallback."""
    return await resilient_client.fetch_route_baseline(
        origin_lat=origin_lat,
        origin_lon=origin_lon,
        dest_lat=dest_lat,
        dest_lon=dest_lon,
    )


@app.get("/api/v1/graph/bbox", response_model=RoadGraphResponse)
async def get_road_graph(
    south: float = Query(..., ge=-90.0, le=90.0),
    west: float = Query(..., ge=-180.0, le=180.0),
    north: float = Query(..., ge=-90.0, le=90.0),
    east: float = Query(..., ge=-180.0, le=180.0),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> RoadGraphResponse:
    """Fetch OSM street graph topology within a bounding box via Overpass API."""
    return await resilient_client.fetch_road_graph(bbox=(south, west, north, east))


@app.get("/api/v1/graph/network", response_model=RoadGraphNetworkResponse)
async def get_road_graph_network(
    south: float = Query(..., ge=-90.0, le=90.0),
    west: float = Query(..., ge=-180.0, le=180.0),
    north: float = Query(..., ge=-90.0, le=90.0),
    east: float = Query(..., ge=-180.0, le=180.0),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> RoadGraphNetworkResponse:
    """Fetch bounded drivable OSM road geometry & edges within a bounding box."""
    return await resilient_client.fetch_road_network(bbox=(south, west, north, east))


@app.get("/api/v1/system/metrics", response_model=SystemMetricsResponse)
async def get_system_metrics(
    flusher: TelemetryMicroBatchFlusher = Depends(get_flusher),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
    http_client: httpx.AsyncClient = Depends(get_http_client),
) -> SystemMetricsResponse:
    """Aggregate gateway ingestion throughput, per-upstream circuit breakers, and orchestrator metrics."""
    orchestrator_data = _offline_orchestrator_metrics()
    orch_url = f"{settings.orchestrator_url.rstrip('/')}/api/v1/orchestrator/metrics"
    try:
        resp = await http_client.get(orch_url, timeout=0.8)
        if resp.status_code == 200:
            payload = resp.json()
            if isinstance(payload, dict):
                orchestrator_data = payload
    except Exception:
        pass

    breaker_statuses = {
        name: CircuitBreakerMetrics.model_validate(status_dict)
        for name, status_dict in resilient_client.get_breaker_statuses().items()
    }
    return SystemMetricsResponse(
        timestamp=datetime.now(timezone.utc),
        ingestion=IngestionMetrics(
            events_per_sec=flusher.events_per_sec,
            total_enqueued=flusher.total_enqueued,
            total_flushed=flusher.total_flushed,
            queue_depth=flusher.queue_depth,
            max_queue_size=flusher.max_queue_size,
            batches_flushed=flusher.batches_flushed,
            flush_errors=flusher.flush_errors,
        ),
        circuit_breakers=breaker_statuses,
        orchestrator=orchestrator_data,
    )


@app.get("/api/v1/eta/compare", response_model=EtaCompareResponse)
async def compare_eta(
    origin_lat: float = Query(..., ge=-90.0, le=90.0),
    origin_lon: float = Query(..., ge=-180.0, le=180.0),
    dest_lat: float = Query(..., ge=-90.0, le=90.0),
    dest_lon: float = Query(..., ge=-180.0, le=180.0),
    hour_of_day: float | None = Query(default=None, ge=0.0, le=24.0),
    precipitation_mm: float = Query(default=0.0, ge=0.0, le=500.0),
    wind_speed_kmh: float = Query(default=5.0, ge=0.0, le=300.0),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> EtaCompareResponse:
    """Compare raw OSRM baseline duration against ONNX residual travel-time inference."""
    baseline = await resilient_client.fetch_route_baseline(
        origin_lat=origin_lat,
        origin_lon=origin_lon,
        dest_lat=dest_lat,
        dest_lon=dest_lon,
    )
    distance_m = float(baseline.distance_meters)
    osrm_sec = float(baseline.duration_seconds)
    is_degraded = bool(baseline.is_degraded)

    if osrm_sec <= 0.0 and (origin_lat != dest_lat or origin_lon != dest_lon):
        straight_m = _haversine_meters(origin_lat, origin_lon, dest_lat, dest_lon)
        distance_m = round(straight_m * 1.3, 2)
        osrm_sec = round(distance_m / 11.11, 2)
        is_degraded = True

    if hour_of_day is None:
        now = datetime.now(timezone.utc)
        effective_hour = now.hour + (now.minute / 60.0)
    else:
        effective_hour = float(hour_of_day)

    def _score_sync() -> float:
        features = build_feature_matrix(
            hour_of_day=effective_hour,
            heading_deg=None,
            origin_lat=origin_lat,
            origin_lon=origin_lon,
            dest_lat=dest_lat,
            dest_lon=dest_lon,
            precipitation_mm=precipitation_mm,
            wind_speed_kmh=wind_speed_kmh,
        )
        model_path = _resolve_onnx_model_path()
        preds = score_onnx_runtime(model_path, features)
        return float(preds[0, 0])

    multiplier = await asyncio.to_thread(_score_sync)
    onnx_eta_sec = round(osrm_sec * multiplier, 2)
    osrm_rounded = round(osrm_sec, 2)
    delta_sec = round(onnx_eta_sec - osrm_rounded, 2)

    return EtaCompareResponse(
        origin_lat=origin_lat,
        origin_lon=origin_lon,
        dest_lat=dest_lat,
        dest_lon=dest_lon,
        distance_meters=round(distance_m, 2),
        osrm_baseline_seconds=osrm_rounded,
        onnx_multiplier=round(multiplier, 4),
        onnx_eta_seconds=onnx_eta_sec,
        delta_seconds=delta_sec,
        is_degraded=is_degraded,
    )


def _compute_compass_bearing_deg(
    lat1: float, lon1: float, lat2: float, lon2: float, fallback: float = 0.0
) -> float:
    """Forward spherical compass bearing in [0, 360) clockwise from true North."""
    if abs(lat2 - lat1) < 1e-11 and abs(lon2 - lon1) < 1e-11:
        return fallback % 360.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _sample_quadratic_bezier(
    p0: tuple[float, float],
    ctrl: tuple[float, float],
    p2: tuple[float, float],
    steps: int = 5,
) -> list[tuple[float, float]]:
    """Sample a smooth quadratic Bezier curve of `(lon, lat)` vertices."""
    n = max(2, int(steps))
    out: list[tuple[float, float]] = []
    for i in range(n + 1):
        t = i / n
        u = 1.0 - t
        lon = u * u * p0[0] + 2.0 * u * t * ctrl[0] + t * t * p2[0]
        lat = u * u * p0[1] + 2.0 * u * t * ctrl[1] + t * t * p2[1]
        out.append((round(lon, 6), round(lat, 6)))
    return out


def _smooth_polyline_corners(
    coords: list[tuple[float, float]],
    fillet_m: float = 12.0,
    arc_steps: int = 3,
) -> list[tuple[float, float]]:
    """Smooth sharp street turns along a `(lon, lat)` polyline using Bezier turning fillets."""
    if len(coords) <= 2:
        return list(coords)
    out: list[tuple[float, float]] = [coords[0]]
    for i in range(1, len(coords) - 1):
        a = coords[i - 1]
        b = coords[i]
        c = coords[i + 1]
        len1 = _haversine_meters(a[1], a[0], b[1], b[0])
        len2 = _haversine_meters(b[1], b[0], c[1], c[0])
        if len1 < 6.0 or len2 < 6.0:
            out.append(b)
            continue
        brng1 = _compute_compass_bearing_deg(a[1], a[0], b[1], b[0])
        brng2 = _compute_compass_bearing_deg(b[1], b[0], c[1], c[0])
        turn = abs(brng2 - brng1)
        if turn > 180.0:
            turn = 360.0 - turn
        if turn < 18.0 or turn > 165.0:
            out.append(b)
            continue
        r = min(fillet_m, len1 * 0.35, len2 * 0.35)
        f1 = r / len1
        f2 = r / len2
        p0 = (b[0] + (a[0] - b[0]) * f1, b[1] + (a[1] - b[1]) * f1)
        p2 = (b[0] + (c[0] - b[0]) * f2, b[1] + (c[1] - b[1]) * f2)
        out.extend(_sample_quadratic_bezier(p0, b, p2, arc_steps))
    out.append(coords[-1])
    return out


def _build_curved_urban_road_network(
    center_lat: float, center_lon: float, rings: int = 3, spokes: int = 10
) -> tuple[list[tuple[float, float]], list[list[tuple[int, float, list[tuple[float, float]]]]]]:
    """
    Build a curved radial-ring orbital + arterial road network around `(center_lat, center_lon)`.
    Each adjacency edge carries multi-point curved geometry `[(lon, lat), ...]` so simulated
    live telemetry bursts glide smoothly along curved roads rather than orthogonal grids.
    """
    cos_lat = max(0.2, math.cos(math.radians(center_lat)))
    phase = center_lat * 0.13 + center_lon * 0.07
    radii_m = [950.0, 2100.0, 3400.0][:rings]

    def _spoke_angle(s: int, frac: float) -> float:
        base = (s / spokes) * math.tau
        sway = math.sin(frac * math.pi) * 0.14 * (1.0 if s % 2 == 0 else -1.0)
        return base + sway

    def _ring_pt(base_r: float, theta: float) -> tuple[float, float]:
        organic = 1.0 + 0.075 * math.sin(3.0 * theta + phase) + 0.045 * math.cos(5.0 * theta - phase)
        r = base_r * organic
        lat = max(-89.9, min(89.9, center_lat + (r * math.sin(theta)) / 111_320.0))
        lon = max(
            -179.9,
            min(179.9, center_lon + (r * math.cos(theta) * 1.06) / (111_320.0 * cos_lat)),
        )
        return (round(lon, 6), round(lat, 6))

    nodes: list[tuple[float, float]] = [(round(center_lon, 6), round(center_lat, 6))]
    for r_idx, base_r in enumerate(radii_m):
        frac = (r_idx + 1) / len(radii_m)
        for s in range(spokes):
            nodes.append(_ring_pt(base_r, _spoke_angle(s, frac)))

    adj: list[list[tuple[int, float, list[tuple[float, float]]]]] = [[] for _ in range(len(nodes))]

    def _add_curved_edge(
        u: int, v: int, spd: float, shape: list[tuple[float, float]]
    ) -> None:
        adj[u].append((v, spd, shape))
        adj[v].append((u, round(spd * 0.94, 2), list(reversed(shape))))

    # 1. Curved concentric orbital ring roads
    for r_idx, base_r in enumerate(radii_m):
        frac = (r_idx + 1) / len(radii_m)
        ring_spd = 16.0 if r_idx == len(radii_m) - 1 else 12.0
        for s in range(spokes):
            s_next = (s + 1) % spokes
            u = 1 + r_idx * spokes + s
            v = 1 + r_idx * spokes + s_next
            t0 = _spoke_angle(s, frac)
            t1 = _spoke_angle(s_next, frac)
            if t1 <= t0:
                t1 += math.tau
            arc = [_ring_pt(base_r, t0 + (t1 - t0) * (k / 5.0)) for k in range(6)]
            arc[0] = nodes[u]
            arc[-1] = nodes[v]
            _add_curved_edge(u, v, ring_spd, arc)

    # 2. Curved radial arterial spokes
    for s in range(spokes):
        spd = 13.5 if s % 2 == 0 else 10.5
        first_node = 1 + s
        mid_theta = _spoke_angle(s, 0.14) + (0.08 if s % 2 == 0 else -0.08)
        ctrl0 = _ring_pt(radii_m[0] * 0.52, mid_theta)
        _add_curved_edge(0, first_node, spd, _sample_quadratic_bezier(nodes[0], ctrl0, nodes[first_node], 5))
        for r_idx in range(len(radii_m) - 1):
            u = 1 + r_idx * spokes + s
            v = 1 + (r_idx + 1) * spokes + s
            dlon = nodes[v][0] - nodes[u][0]
            dlat = nodes[v][1] - nodes[u][1]
            sign = 1.0 if (s + r_idx) % 2 == 0 else -1.0
            ctrl = (
                round((nodes[u][0] + nodes[v][0]) * 0.5 - dlat * 0.15 * sign, 6),
                round((nodes[u][1] + nodes[v][1]) * 0.5 + dlon * 0.12 * sign, 6),
            )
            _add_curved_edge(u, v, spd, _sample_quadratic_bezier(nodes[u], ctrl, nodes[v], 5))

    return nodes, adj


async def _load_live_road_context(
    center_lat: float,
    center_lon: float,
    http_client: httpx.AsyncClient | None,
    resilient_client: ResilientExternalClient | None,
) -> tuple[
    list[tuple[UUID, list[tuple[float, float]]]],
    list[tuple[float, float]],
    list[list[tuple[int, float, list[tuple[float, float]]]]],
]:
    """
    Attempt to load active courier routes from orchestrator-java or cached Overpass road edges,
    falling back immediately to a curved orbital-ring road network so burst sims never stall.
    """
    active_routes: list[tuple[UUID, list[tuple[float, float]]]] = []
    if http_client is not None:
        try:
            snap_url = f"{settings.orchestrator_url.rstrip('/')}/api/v1/snapshot?limit=100"
            resp = await http_client.get(snap_url, timeout=0.3)
            if resp.status_code == 200:
                body = resp.json()
                for route in body.get("routes") or []:
                    cid_raw = route.get("courierId")
                    path = route.get("pathCoords") or []
                    if cid_raw and len(path) >= 2:
                        try:
                            cid = UUID(str(cid_raw))
                            coords = [
                                (float(pt[0]), float(pt[1])) for pt in path if len(pt) >= 2
                            ]
                            if len(coords) >= 2:
                                active_routes.append((cid, _smooth_polyline_corners(coords)))
                        except Exception:
                            continue
        except Exception:
            pass

    if resilient_client is not None and resilient_client.breakers["overpass"].state == CircuitState.CLOSED:
        cache_key = (
            f"graph:network:{center_lat - 0.025:.3f},{center_lon - 0.03:.3f},"
            f"{center_lat + 0.025:.3f},{center_lon + 0.03:.3f}"
        )
        cached = await resilient_client._redis_get_json(cache_key)
        if cached and len(cached.get("nodes") or []) >= 12 and len(cached.get("edges") or []) >= 12:
            nodes = [(float(p[0]), float(p[1])) for p in cached["nodes"] if len(p) >= 2]
            adj: list[list[tuple[int, float, list[tuple[float, float]]]]] = [
                [] for _ in range(len(nodes))
            ]
            for e in cached["edges"]:
                if len(e) >= 5:
                    u, v, _cls, oneway, spd = int(e[0]), int(e[1]), str(e[2]), bool(e[3]), float(e[4])
                    if 0 <= u < len(nodes) and 0 <= v < len(nodes) and u != v:
                        adj[u].append((v, max(4.5, spd), [nodes[u], nodes[v]]))
                        if not oneway:
                            adj[v].append((u, max(4.5, spd), [nodes[v], nodes[u]]))
            if any(adj):
                return active_routes, nodes, adj

    nodes, adj = _build_curved_urban_road_network(center_lat, center_lon)
    return active_routes, nodes, adj


async def _run_burst_simulation(
    req: SimulationBurstRequest,
    flusher: TelemetryMicroBatchFlusher,
    ws_hub: WebSocketBroadcastHub,
    http_client: httpx.AsyncClient | None = None,
    resilient_client: ResilientExternalClient | None = None,
) -> None:
    """Emit bounded curved road-following simulated courier GPS pings around `(center_lat, center_lon)`."""
    rng = random.Random(42)
    active_routes, road_nodes, road_adj = await _load_live_road_context(
        req.center_lat, req.center_lon, http_client, resilient_client
    )

    valid_nodes = [idx for idx, outs in enumerate(road_adj) if outs]
    if not valid_nodes:
        road_nodes, road_adj = _build_curved_urban_road_network(req.center_lat, req.center_lon)
        valid_nodes = [idx for idx, outs in enumerate(road_adj) if outs]

    couriers: list[dict[str, Any]] = []
    for i in range(req.courier_count):
        if i < len(active_routes):
            cid, path = active_routes[i]
            lon0, lat0 = path[0]
            lon1, lat1 = path[1]
            couriers.append(
                {
                    "courier_id": cid,
                    "mode": "route",
                    "path": path,
                    "seg_idx": 0,
                    "seg_offset_m": 0.0,
                    "speed_mps": rng.uniform(8.0, 14.0),
                    "lat": lat0,
                    "lon": lon0,
                    "heading_deg": _compute_compass_bearing_deg(lat0, lon0, lat1, lon1),
                    "battery_pct": rng.randint(60, 100),
                }
            )
        else:
            u = valid_nodes[rng.randrange(len(valid_nodes))]
            v, edge_spd, edge_geom = road_adj[u][rng.randrange(len(road_adj[u]))]
            lon0, lat0 = edge_geom[0]
            lon1, lat1 = edge_geom[1]
            couriers.append(
                {
                    "courier_id": uuid4(),
                    "mode": "graph",
                    "u": u,
                    "v": v,
                    "geom": edge_geom,
                    "sub_idx": 0,
                    "seg_offset_m": 0.0,
                    "speed_mps": round(edge_spd * rng.uniform(0.85, 1.1), 2),
                    "lat": lat0,
                    "lon": lon0,
                    "heading_deg": _compute_compass_bearing_deg(lat0, lon0, lat1, lon1),
                    "battery_pct": rng.randint(60, 100),
                }
            )

    tick_hz = 10
    tick_interval = 1.0 / tick_hz
    total_ticks = req.duration_sec * tick_hz
    pings_per_tick = max(1, round(req.rate_per_sec / tick_hz))
    cursor = 0

    try:
        for _ in range(total_ticks):
            now = datetime.now(timezone.utc)
            emitted: list[TelemetryPing] = []
            pings_per_courier_this_tick = max(1.0, pings_per_tick / max(1, len(couriers)))
            dt_per_ping = tick_interval / pings_per_courier_this_tick

            for _ in range(pings_per_tick):
                c = couriers[cursor % len(couriers)]
                cursor += 1
                step_m = c["speed_mps"] * dt_per_ping

                if c["mode"] == "route":
                    path = c["path"]
                    seg_idx = c["seg_idx"]
                    offset_m = c["seg_offset_m"] + step_m
                    while True:
                        lon_a, lat_a = path[seg_idx]
                        lon_b, lat_b = path[seg_idx + 1]
                        seg_len = max(1.0, _haversine_meters(lat_a, lon_a, lat_b, lon_b))
                        if offset_m < seg_len:
                            frac = offset_m / seg_len
                            c["lat"] = lat_a + (lat_b - lat_a) * frac
                            c["lon"] = lon_a + (lon_b - lon_a) * frac
                            c["heading_deg"] = _compute_compass_bearing_deg(
                                lat_a, lon_a, lat_b, lon_b, c["heading_deg"]
                            )
                            c["seg_idx"] = seg_idx
                            c["seg_offset_m"] = offset_m
                            break
                        offset_m -= seg_len
                        seg_idx += 1
                        if seg_idx >= len(path) - 1:
                            path.reverse()
                            seg_idx = 0
                else:
                    geom = c["geom"]
                    sub_idx = c["sub_idx"]
                    offset_m = c["seg_offset_m"] + step_m
                    for _hop in range(8):
                        lon_a, lat_a = geom[sub_idx]
                        lon_b, lat_b = geom[sub_idx + 1]
                        seg_len = max(1.0, _haversine_meters(lat_a, lon_a, lat_b, lon_b))
                        if offset_m < seg_len:
                            frac = offset_m / seg_len
                            c["lat"] = lat_a + (lat_b - lat_a) * frac
                            c["lon"] = lon_a + (lon_b - lon_a) * frac
                            c["heading_deg"] = _compute_compass_bearing_deg(
                                lat_a, lon_a, lat_b, lon_b, c["heading_deg"]
                            )
                            c["geom"] = geom
                            c["sub_idx"] = sub_idx
                            c["seg_offset_m"] = offset_m
                            break
                        offset_m -= seg_len
                        sub_idx += 1
                        if sub_idx >= len(geom) - 1:
                            u = c["u"]
                            v = c["v"]
                            outs = road_adj[v]
                            non_uturn = [edge for edge in outs if edge[0] != u]
                            choices = non_uturn if non_uturn else outs
                            if not choices:
                                geom = list(reversed(geom))
                                c["u"], c["v"] = v, u
                            else:
                                nxt, edge_spd, nxt_geom = choices[rng.randrange(len(choices))]
                                c["u"], c["v"] = v, nxt
                                geom = nxt_geom
                                c["speed_mps"] = round(edge_spd * rng.uniform(0.88, 1.08), 2)
                            sub_idx = 0

                ping = TelemetryPing(
                    courier_id=c["courier_id"],
                    lat=round(max(-89.9, min(89.9, c["lat"])), 6),
                    lon=round(max(-179.9, min(179.9, c["lon"])), 6),
                    speed_mps=round(c["speed_mps"], 2),
                    heading_deg=round(c["heading_deg"] % 360.0, 2),
                    battery_pct=c["battery_pct"],
                    recorded_at=now,
                )
                try:
                    flusher.enqueue_nowait(ping)
                    emitted.append(ping)
                except asyncio.QueueFull:
                    break

            if emitted:
                await ws_hub.broadcast(
                    "telemetry_batch",
                    _pings_broadcast_payload(
                        emitted,
                        flusher.queue_depth,
                        flusher.events_per_sec,
                        simulated=True,
                    ),
                )
            await asyncio.sleep(tick_interval)
    except asyncio.CancelledError:
        return


@app.post("/api/v1/simulation/burst", status_code=status.HTTP_202_ACCEPTED)
async def simulate_telemetry_burst(
    req: SimulationBurstRequest,
    request: Request,
    flusher: TelemetryMicroBatchFlusher = Depends(get_flusher),
    ws_hub: WebSocketBroadcastHub = Depends(get_ws_hub),
    http_client: httpx.AsyncClient = Depends(get_http_client),
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
) -> dict[str, Any]:
    """Spawn a bounded road-following GPS telemetry burst centered on `(center_lat, center_lon)`."""
    prior_task: asyncio.Task[None] | None = getattr(request.app.state, "burst_task", None)
    if prior_task is not None and not prior_task.done():
        prior_task.cancel()
        try:
            await prior_task
        except asyncio.CancelledError:
            pass

    task = asyncio.create_task(
        _run_burst_simulation(req, flusher, ws_hub, http_client, resilient_client),
        name="simulation-gps-burst",
    )
    request.app.state.burst_task = task
    return {
        "status": "started",
        "rate_per_sec": req.rate_per_sec,
        "duration_sec": req.duration_sec,
        "center_lat": req.center_lat,
        "center_lon": req.center_lon,
        "courier_count": req.courier_count,
    }


@app.post("/api/v1/simulation/fault-injection")
async def simulate_fault_injection(
    req: SimulationFaultRequest,
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
    ws_hub: WebSocketBroadcastHub = Depends(get_ws_hub),
) -> dict[str, Any]:
    """Inject or clear simulated faults (`429`/`503`/`504`/`null`) on an external upstream."""
    resilient_client.set_fault_injection(req.upstream, req.status_code)
    breaker = resilient_client.breakers[req.upstream]

    if req.status_code is not None and req.probe_now:
        for _ in range(breaker.failure_threshold + 1):
            if breaker.state == CircuitState.OPEN:
                break
            if req.upstream == "open_meteo":
                await resilient_client.fetch_weather_grid("gcpvj0", lat=51.5074, lon=-0.1278)
            elif req.upstream == "osrm":
                await resilient_client.fetch_route_baseline(51.5074, -0.1278, 51.5155, -0.0922)
            else:
                await resilient_client.fetch_road_graph((51.49, -0.15, 51.53, -0.10))
    elif req.status_code is None:
        resilient_client.reset_breaker(req.upstream)

    statuses = resilient_client.get_breaker_statuses()
    payload = {
        "upstream": req.upstream,
        "injected_status": req.status_code,
        "breaker": statuses[req.upstream],
        "circuit_breakers": statuses,
    }
    await ws_hub.broadcast("circuit_breaker", payload)
    return {"status": "ok", **payload}


@app.post("/api/v1/simulation/weather-surge")
async def simulate_weather_surge(
    req: SimulationWeatherSurgeRequest,
    resilient_client: ResilientExternalClient = Depends(get_resilient_client),
    ws_hub: WebSocketBroadcastHub = Depends(get_ws_hub),
    http_client: httpx.AsyncClient = Depends(get_http_client),
) -> dict[str, Any]:
    """Generate a storm grid in Redis around `(center_lat, center_lon)` and optionally re-optimize."""
    base_multiplier = compute_weather_speed_multiplier(req.precipitation_mm, req.wind_speed_kmh)
    cells: list[WeatherGridCell] = []
    step_deg = 0.015
    radius = req.grid_radius

    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            lat = max(-89.9, min(89.9, req.center_lat + dy * step_deg))
            lon = max(-179.9, min(179.9, req.center_lon + dx * step_deg))
            dist_norm = math.hypot(dx, dy) / max(1.0, math.hypot(radius, radius))
            falloff = max(0.35, 1.0 - 0.55 * dist_norm)
            cell_precip = round(req.precipitation_mm * falloff, 2)
            cell_wind = round(req.wind_speed_kmh * (0.65 + 0.35 * falloff), 2)
            cell_mult = compute_weather_speed_multiplier(cell_precip, cell_wind)
            severity = round(min(1.0, max(0.0, (1.0 - cell_mult) / 0.65)), 3)
            gh = _encode_geohash(lat, lon, precision=6)
            cell = WeatherGridCell(
                geohash=gh,
                lat=round(lat, 6),
                lon=round(lon, 6),
                precipitation_mm=cell_precip,
                wind_speed_kmh=cell_wind,
                speed_multiplier=cell_mult,
                severity_score=severity,
            )
            cells.append(cell)
            await resilient_client._redis_set_json(
                f"weather:grid:{gh}",
                {
                    "geohash": gh,
                    "precipitation_mm": cell_precip,
                    "wind_speed_kmh": cell_wind,
                    "speed_multiplier": cell_mult,
                    "is_degraded": False,
                },
            )

    surge_payload = {
        "center_lat": req.center_lat,
        "center_lon": req.center_lon,
        "precipitation_mm": req.precipitation_mm,
        "wind_speed_kmh": req.wind_speed_kmh,
        "speed_multiplier": base_multiplier,
        "cells_updated": len(cells),
        "cells": [cell.model_dump(mode="json") for cell in cells],
    }
    await ws_hub.broadcast("weather_surge", surge_payload)

    reoptimize_result: dict[str, Any] | None = None
    if req.trigger_reoptimize:
        reopt_url = f"{settings.orchestrator_url.rstrip('/')}/api/v1/dispatch/reoptimize"
        reopt_body: dict[str, Any] = {
            "batchSize": req.batch_size,
            "weatherSeverityScore": round(min(1.0, req.precipitation_mm / 50.0), 3),
            "speedMultiplier": base_multiplier,
        }
        if req.hub_id is not None:
            reopt_body["hubId"] = str(req.hub_id)
        try:
            resp = await http_client.post(
                reopt_url,
                json=reopt_body,
                headers={"Idempotency-Key": str(uuid4())},
                timeout=1.5,
            )
            if 200 <= resp.status_code < 300:
                parsed = resp.json()
                if isinstance(parsed, dict):
                    reoptimize_result = parsed
                    await ws_hub.broadcast("solver_event", reoptimize_result)
        except Exception:
            pass

    return {
        "status": "applied",
        **surge_payload,
        "reoptimized": reoptimize_result is not None,
        "solver_event": reoptimize_result,
    }
