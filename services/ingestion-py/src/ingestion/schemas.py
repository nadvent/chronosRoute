"""
Pydantic v2 Domain Schemas & DTOs for the ChronosRoute Edge Ingestion & ML Gateway.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class TelemetryPing(BaseModel):
    """High-frequency courier GPS ping validated at the HTTP/WebSocket edge."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    courier_id: UUID
    lat: float = Field(..., ge=-90.0, le=90.0, description="WGS84 latitude in degrees")
    lon: float = Field(..., ge=-180.0, le=180.0, description="WGS84 longitude in degrees")
    speed_mps: float = Field(..., ge=0.0, description="Instantaneous ground speed (m/s)")
    heading_deg: float = Field(
        default=0.0,
        ge=0.0,
        le=360.0,
        validation_alias=AliasChoices("heading_deg", "heading"),
        description="Compass bearing in degrees [0, 360]",
    )
    battery_pct: int = Field(
        default=100,
        ge=0,
        le=100,
        description="Courier device battery percentage [0, 100]",
    )
    recorded_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="UTC timestamp when the GPS fix was captured",
    )

    @field_validator("recorded_at", mode="after")
    @classmethod
    def ensure_timezone_aware(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


class TelemetryBatchRequest(BaseModel):
    """Batch wrapper for multiple courier GPS telemetry pings."""

    model_config = ConfigDict(extra="ignore")

    pings: list[TelemetryPing] = Field(..., min_length=1, max_length=10_000)


class TelemetryIngestResponse(BaseModel):
    """Acknowledgement returned when telemetry pings are buffered into the bounded queue."""

    status: str = "queued"
    accepted: int = Field(..., ge=0)
    queue_depth: int = Field(..., ge=0)


class WeatherGridResponse(BaseModel):
    """Spatial weather conditions and derived traffic speed multiplier for a geohash cell."""

    geohash: str = Field(..., min_length=1, max_length=16)
    precipitation_mm: float = Field(..., ge=0.0)
    wind_speed_kmh: float = Field(..., ge=0.0)
    speed_multiplier: float = Field(..., gt=0.0, le=2.0)
    is_degraded: bool = False


class RouteBaselineResponse(BaseModel):
    """Baseline route distance, duration, and geometry between two WGS84 coordinates."""

    origin_lat: float = Field(..., ge=-90.0, le=90.0)
    origin_lon: float = Field(..., ge=-180.0, le=180.0)
    dest_lat: float = Field(..., ge=-90.0, le=90.0)
    dest_lon: float = Field(..., ge=-180.0, le=180.0)
    distance_meters: float = Field(..., ge=0.0)
    duration_seconds: float = Field(..., ge=0.0)
    encoded_polyline: str = ""
    is_degraded: bool = False


class RoadGraphResponse(BaseModel):
    """Summary of OSM road network topology fetched from Overpass API."""

    bbox: tuple[float, float, float, float]
    node_count: int = Field(..., ge=0)
    edge_count: int = Field(..., ge=0)
    is_degraded: bool = False


class RoadGraphNetworkResponse(BaseModel):
    """Compact drivable OSM road graph geometry & topology fetched from Overpass API."""

    bbox: tuple[float, float, float, float]
    nodes: list[tuple[float, float]] = Field(
        default_factory=list,
        description="Road intersection/shape coordinates as [lon, lat] tuples",
    )
    edges: list[tuple[int, int, str, bool, float]] = Field(
        default_factory=list,
        description="Compact directed edge tuples: [u_idx, v_idx, highway_class, oneway, speed_mps]",
    )
    node_count: int = Field(..., ge=0)
    edge_count: int = Field(..., ge=0)
    is_degraded: bool = False


class EtaCompareResponse(BaseModel):
    """Comparison between OSRM baseline duration and ONNX residual-adjusted ETA."""

    origin_lat: float = Field(..., ge=-90.0, le=90.0)
    origin_lon: float = Field(..., ge=-180.0, le=180.0)
    dest_lat: float = Field(..., ge=-90.0, le=90.0)
    dest_lon: float = Field(..., ge=-180.0, le=180.0)
    distance_meters: float = Field(..., ge=0.0)
    osrm_baseline_seconds: float = Field(..., ge=0.0)
    onnx_multiplier: float = Field(..., ge=0.5, le=3.0)
    onnx_eta_seconds: float = Field(..., ge=0.0)
    delta_seconds: float
    is_degraded: bool = False


class SimulationBurstRequest(BaseModel):
    """Configuration for spawning a bounded simulated GPS ping burst."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    rate_per_sec: int = Field(
        default=500,
        validation_alias=AliasChoices("rate_per_sec", "ratePerSec"),
    )
    duration_sec: int = Field(
        default=5,
        validation_alias=AliasChoices("duration_sec", "durationSec"),
    )
    center_lat: float = Field(
        default=51.5074,
        ge=-90.0,
        le=90.0,
        validation_alias=AliasChoices("center_lat", "centerLat"),
    )
    center_lon: float = Field(
        default=-0.1278,
        ge=-180.0,
        le=180.0,
        validation_alias=AliasChoices("center_lon", "centerLon"),
    )
    courier_count: int = Field(
        default=40,
        validation_alias=AliasChoices("courier_count", "courierCount"),
    )

    @field_validator("rate_per_sec", mode="after")
    @classmethod
    def clamp_rate_per_sec(cls, value: int) -> int:
        return max(50, min(5000, int(value)))

    @field_validator("duration_sec", mode="after")
    @classmethod
    def clamp_duration_sec(cls, value: int) -> int:
        return max(1, min(15, int(value)))

    @field_validator("courier_count", mode="after")
    @classmethod
    def clamp_courier_count(cls, value: int) -> int:
        return max(1, min(500, int(value)))


class SimulationFaultRequest(BaseModel):
    """Enable or clear fault injection on a named external upstream."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    upstream: Literal["open_meteo", "osrm", "overpass"]
    status_code: Literal[429, 503, 504] | None = Field(
        default=None,
        validation_alias=AliasChoices("status_code", "statusCode"),
    )
    probe_now: bool = Field(
        default=True,
        validation_alias=AliasChoices("probe_now", "probeNow"),
    )

    @field_validator("upstream", mode="before")
    @classmethod
    def normalize_upstream(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip().lower().replace("-", "_")
        return value


class WeatherGridCell(BaseModel):
    """Single spatial cell in a simulated or cached weather grid overlay."""

    geohash: str = Field(..., min_length=1, max_length=16)
    lat: float = Field(..., ge=-90.0, le=90.0)
    lon: float = Field(..., ge=-180.0, le=180.0)
    precipitation_mm: float = Field(..., ge=0.0)
    wind_speed_kmh: float = Field(..., ge=0.0)
    speed_multiplier: float = Field(..., gt=0.0, le=2.0)
    severity_score: float = Field(default=0.0, ge=0.0, le=1.0)


class SimulationWeatherSurgeRequest(BaseModel):
    """Trigger a localized weather surge grid in Redis and optional orchestrator re-optimization."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    center_lat: float = Field(
        default=51.5074,
        ge=-90.0,
        le=90.0,
        validation_alias=AliasChoices("center_lat", "centerLat"),
    )
    center_lon: float = Field(
        default=-0.1278,
        ge=-180.0,
        le=180.0,
        validation_alias=AliasChoices("center_lon", "centerLon"),
    )
    precipitation_mm: float = Field(
        default=25.0,
        ge=0.0,
        le=200.0,
        validation_alias=AliasChoices("precipitation_mm", "precipitationMm"),
    )
    wind_speed_kmh: float = Field(
        default=45.0,
        ge=0.0,
        le=200.0,
        validation_alias=AliasChoices("wind_speed_kmh", "windSpeedKmh"),
    )
    grid_radius: int = Field(
        default=2,
        ge=1,
        le=5,
        validation_alias=AliasChoices("grid_radius", "gridRadius"),
    )
    trigger_reoptimize: bool = Field(
        default=True,
        validation_alias=AliasChoices("trigger_reoptimize", "triggerReoptimize"),
    )
    hub_id: UUID | None = Field(
        default=None,
        validation_alias=AliasChoices("hub_id", "hubId"),
    )
    batch_size: int = Field(
        default=20,
        ge=1,
        le=200,
        validation_alias=AliasChoices("batch_size", "batchSize"),
    )


class IngestionMetrics(BaseModel):
    """Micro-batch flusher throughput and queue depth metrics."""

    events_per_sec: float = Field(..., ge=0.0)
    total_enqueued: int = Field(..., ge=0)
    total_flushed: int = Field(..., ge=0)
    queue_depth: int = Field(..., ge=0)
    max_queue_size: int = Field(..., gt=0)
    batches_flushed: int = Field(default=0, ge=0)
    flush_errors: int = Field(default=0, ge=0)


class CircuitBreakerMetrics(BaseModel):
    """Per-upstream circuit breaker telemetry snapshot."""

    state: str
    failure_count: int = Field(..., ge=0)
    failure_threshold: int = Field(default=5, ge=1)
    total_calls: int = Field(..., ge=0)
    total_successes: int = Field(default=0, ge=0)
    total_failures: int = Field(..., ge=0)
    total_short_circuited: int = Field(..., ge=0)
    short_circuited: int = Field(default=0, ge=0)
    error_rate: float = Field(..., ge=0.0)
    injected_status: int | None = None


class SystemMetricsResponse(BaseModel):
    """Aggregated gateway ingestion, circuit breaker, and orchestrator metrics."""

    timestamp: datetime
    ingestion: IngestionMetrics
    circuit_breakers: dict[str, CircuitBreakerMetrics]
    orchestrator: dict[str, Any]
