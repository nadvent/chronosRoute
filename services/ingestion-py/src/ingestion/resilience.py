"""
Outbound API Resilience State Machine (`[HUMAN-OWNED]`).

Protects Overpass, OSRM, and Open-Meteo fan-out calls with:
1. Bounded concurrency (`asyncio.Semaphore(16)`).
2. Token-bucket rate limiting (`TokenBucketRateLimiter`).
3. Full-jitter exponential backoff (`full_jitter_backoff`).
4. Three-state circuit breaker (`CLOSED -> OPEN -> HALF_OPEN`) with a single-probe
   `asyncio.Lock` gate in `HALF_OPEN` to prevent upstream stampedes.
5. Degraded Redis cache fallback (`GET weather:grid:{geohash}`, `is_degraded=True`).
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import random
import time
from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Any, TypeVar

import httpx

from src.ingestion.schemas import (
    RoadGraphNetworkResponse,
    RoadGraphResponse,
    RouteBaselineResponse,
    WeatherGridResponse,
)

T = TypeVar("T")


UPSTREAM_NAMES: tuple[str, ...] = ("open_meteo", "osrm", "overpass")
VALID_FAULT_STATUS_CODES: frozenset[int] = frozenset({429, 503, 504})

_DRIVABLE_HIGHWAY_SPEED_MPS: dict[str, float] = {
    "motorway": 22.0,
    "motorway_link": 16.0,
    "trunk": 17.0,
    "trunk_link": 13.5,
    "primary": 13.5,
    "primary_link": 11.5,
    "secondary": 11.5,
    "secondary_link": 9.5,
    "tertiary": 9.5,
    "tertiary_link": 8.0,
    "unclassified": 7.5,
    "residential": 7.5,
    "living_street": 5.5,
}


def _parse_osm_speed_mps(raw_maxspeed: Any, highway: str) -> float:
    """Parse OSM `maxspeed` tag (e.g. '30 mph', '50') into m/s with safe road-class default."""
    default_mps = _DRIVABLE_HIGHWAY_SPEED_MPS.get(highway, 8.5)
    if not isinstance(raw_maxspeed, str):
        return default_mps
    text = raw_maxspeed.strip().lower()
    if not text:
        return default_mps
    tokens = text.split()
    try:
        val = float(tokens[0])
    except ValueError:
        return default_mps
    if val <= 0:
        return default_mps
    if "mph" in text:
        return round(max(4.0, min(30.0, val * 0.44704)), 2)
    return round(max(4.0, min(30.0, val / 3.6)), 2)


class CircuitState(str, Enum):
    """Three-state resilience circuit breaker states."""

    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerOpenError(RuntimeError):
    """Raised when an outbound request is rejected by an OPEN or probing HALF_OPEN breaker."""


class UpstreamHttpError(RuntimeError):
    """Raised when an upstream API returns a retryable/failure HTTP status (e.g. 429, 503)."""

    def __init__(self, status_code: int, message: str = "") -> None:
        super().__init__(message or f"Upstream HTTP {status_code}")
        self.status_code = status_code


def full_jitter_backoff(
    attempt: int,
    base_delay: float = 0.05,
    cap_delay: float = 2.0,
    rng: random.Random | None = None,
) -> float:
    """
    Compute full-jitter exponential backoff delay:
        sleep = uniform(0, min(cap_delay, base_delay * (2 ** attempt)))
    Prevents synchronized retry waves (thundering herds) across coroutines.
    """
    if base_delay < 0.0 or cap_delay < 0.0:
        raise ValueError("base_delay and cap_delay must be non-negative")
    safe_attempt = max(0, int(attempt))
    exp_ceiling = min(cap_delay, base_delay * (2**safe_attempt))
    uniform_fn = rng.uniform if rng is not None else random.uniform
    return float(uniform_fn(0.0, exp_ceiling))


class TokenBucketRateLimiter:
    """
    Bounded token-bucket rate limiter for outbound API calls.
    Never blocks the event loop with synchronous `time.sleep()`.
    """

    def __init__(
        self,
        rate_per_sec: float = 50.0,
        capacity: float = 100.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if rate_per_sec <= 0.0:
            raise ValueError("rate_per_sec must be strictly positive")
        if capacity <= 0.0:
            raise ValueError("capacity must be strictly positive")

        self.rate_per_sec = float(rate_per_sec)
        self.capacity = float(capacity)
        self._clock = clock
        self._tokens = float(capacity)
        self._last_refill = self._clock()
        self._lock = asyncio.Lock()

    @property
    def available_tokens(self) -> float:
        self._refill()
        return self._tokens

    def _refill(self) -> None:
        now = self._clock()
        elapsed = max(0.0, now - self._last_refill)
        if elapsed > 0.0:
            self._tokens = min(self.capacity, self._tokens + elapsed * self.rate_per_sec)
            self._last_refill = now

    def try_acquire(self, tokens: float = 1.0) -> bool:
        """Synchronously attempt to consume `tokens` without waiting."""
        if tokens <= 0.0:
            return True
        self._refill()
        if self._tokens >= tokens:
            self._tokens -= tokens
            return True
        return False

    async def acquire(self, tokens: float = 1.0, max_wait_sec: float = 0.5) -> bool:
        """Acquire tokens, waiting asynchronously up to `max_wait_sec` if needed."""
        if tokens > self.capacity:
            return False
        async with self._lock:
            if self.try_acquire(tokens):
                return True
            deficit = tokens - self._tokens
            wait_time = deficit / self.rate_per_sec
            if wait_time > max_wait_sec:
                return False
            await asyncio.sleep(wait_time)
            return self.try_acquire(tokens)


class CircuitBreaker:
    """
    Three-state (`CLOSED -> OPEN -> HALF_OPEN`) asynchronous circuit breaker.

    In `HALF_OPEN`, enforces a strict single-probe gate (`_half_open_probe_lock`)
    so concurrent callers do not stampede a recovering upstream service:
    only 1 probe request is permitted through, while concurrent requests fail fast
    with `CircuitBreakerOpenError` and fall back to cached Redis data.
    """

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout_sec: float = 10.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if failure_threshold < 1:
            raise ValueError("failure_threshold must be >= 1")
        if recovery_timeout_sec <= 0.0:
            raise ValueError("recovery_timeout_sec must be > 0")

        self.failure_threshold = int(failure_threshold)
        self.recovery_timeout_sec = float(recovery_timeout_sec)
        self._clock = clock

        self._state: CircuitState = CircuitState.CLOSED
        self._failure_count: int = 0
        self._opened_at: float = 0.0
        self._half_open_probe_lock = asyncio.Lock()
        self._probe_in_flight: bool = False

        # Telemetry metrics
        self.total_calls: int = 0
        self.total_Successes: int = 0
        self.total_failures: int = 0
        self.total_short_circuited: int = 0

    @property
    def state(self) -> CircuitState:
        if self._state == CircuitState.OPEN:
            elapsed = self._clock() - self._opened_at
            if elapsed >= self.recovery_timeout_sec:
                self._state = CircuitState.HALF_OPEN
        return self._state

    @property
    def failure_count(self) -> int:
        return self._failure_count

    @property
    def half_open_probe_lock(self) -> asyncio.Lock:
        return self._half_open_probe_lock

    @property
    def total_successes(self) -> int:
        return self.total_Successes

    @property
    def error_rate(self) -> float:
        return float(self.total_failures) / max(1, self.total_calls)

    def reset(self) -> None:
        """Reset circuit breaker state and consecutive failure count back to CLOSED."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._opened_at = 0.0
        self._probe_in_flight = False

    def to_status_dict(self, injected_status: int | None = None) -> dict[str, Any]:
        """Serialize breaker telemetry and current state for observability APIs."""
        return {
            "state": self.state.value,
            "failure_count": self.failure_count,
            "failure_threshold": self.failure_threshold,
            "total_calls": self.total_calls,
            "total_successes": self.total_Successes,
            "total_failures": self.total_failures,
            "total_short_circuited": self.total_short_circuited,
            "short_circuited": self.total_short_circuited,
            "error_rate": self.error_rate,
            "injected_status": injected_status,
        }

    def record_success(self) -> None:
        """Transition to CLOSED and clear accumulated failure count."""
        self._failure_count = 0
        self._state = CircuitState.CLOSED
        self.total_Successes += 1

    def record_failure(self) -> None:
        """Record an upstream failure and trip to OPEN when threshold is reached or in HALF_OPEN."""
        self._failure_count += 1
        self.total_failures += 1
        if self._state == CircuitState.HALF_OPEN or self._failure_count >= self.failure_threshold:
            self._state = CircuitState.OPEN
            self._opened_at = self._clock()

    async def call(self, func: Callable[[], Awaitable[T]]) -> T:
        """
        Execute an async callable through the circuit breaker state machine.
        Raises `CircuitBreakerOpenError` immediately if `OPEN` or if a `HALF_OPEN`
        probe is already in flight.
        """
        self.total_calls += 1
        current_state = self.state

        if current_state == CircuitState.OPEN:
            self.total_short_circuited += 1
            raise CircuitBreakerOpenError("Circuit breaker is OPEN")

        if current_state == CircuitState.HALF_OPEN:
            if self._probe_in_flight or self._half_open_probe_lock.locked():
                self.total_short_circuited += 1
                raise CircuitBreakerOpenError(
                    "Circuit breaker is HALF_OPEN and single recovery probe is already in flight"
                )
            self._probe_in_flight = True
            try:
                async with self._half_open_probe_lock:
                    try:
                        result = await func()
                    except Exception:
                        self.record_failure()
                        raise
                    else:
                        self.record_success()
                        return result
            finally:
                self._probe_in_flight = False

        # CLOSED state
        try:
            result = await func()
        except Exception:
            self.record_failure()
            raise
        else:
            self.record_success()
            return result


def compute_weather_speed_multiplier(precipitation_mm: float, wind_speed_kmh: float) -> float:
    """Compute road edge speed multiplier in [0.35, 1.0] from precipitation and wind."""
    rain_penalty = 0.012 * max(0.0, float(precipitation_mm))
    wind_penalty = 0.003 * max(0.0, float(wind_speed_kmh) - 15.0)
    multiplier = max(0.35, min(1.0, 1.0 - rain_penalty - wind_penalty))
    return round(multiplier, 4)


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r_earth = 6_371_000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    return 2.0 * r_earth * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


class ResilientExternalClient:
    """
    Resilient outbound HTTP client for Open-Meteo, OSRM, and Overpass APIs.

    Shares a lifespan-scoped `httpx.AsyncClient` protected by:
    - `asyncio.Semaphore(16)` (bounded concurrency)
    - `TokenBucketRateLimiter`
    - `CircuitBreaker`
    - Full-jitter exponential backoff
    - Redis degraded cache fallback (`GET weather:grid:{geohash}`, `is_degraded=True`)
    """

    RETRYABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})

    def __init__(
        self,
        http_client: httpx.AsyncClient,
        redis_client: Any = None,
        circuit_breaker: CircuitBreaker | None = None,
        breakers: dict[str, CircuitBreaker] | None = None,
        rate_limiter: TokenBucketRateLimiter | None = None,
        max_concurrency: int = 16,
        max_retries: int = 2,
        base_backoff_sec: float = 0.01,
        cap_backoff_sec: float = 0.1,
        open_meteo_url: str = "https://api.open-meteo.com/v1/forecast",
        osrm_url: str = "http://localhost:5000",
        overpass_url: str = "https://overpass-api.de/api/interpreter",
    ) -> None:
        if max_concurrency <= 0:
            raise ValueError("max_concurrency must be strictly positive")

        self._http_client = http_client
        self._redis_client = redis_client
        open_meteo_breaker = circuit_breaker or CircuitBreaker()
        self.breakers: dict[str, CircuitBreaker] = {
            "open_meteo": open_meteo_breaker,
            "osrm": CircuitBreaker(),
            "overpass": CircuitBreaker(),
        }
        if breakers is not None:
            for name, br in breakers.items():
                key = self._normalize_upstream_name(name)
                if key not in self.breakers:
                    raise ValueError(f"Unknown upstream '{name}'; expected one of {UPSTREAM_NAMES}")
                self.breakers[key] = br
        # Backward-compatible alias for single-breaker tests & callers
        self.circuit_breaker: CircuitBreaker = self.breakers["open_meteo"]
        self.fault_injection_modes: dict[str, int | None] = {
            "open_meteo": None,
            "osrm": None,
            "overpass": None,
        }
        self.rate_limiter = rate_limiter or TokenBucketRateLimiter()
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self.max_concurrency = max_concurrency
        self.max_retries = max(0, int(max_retries))
        self.base_backoff_sec = base_backoff_sec
        self.cap_backoff_sec = cap_backoff_sec
        self._open_meteo_url = open_meteo_url
        self._osrm_url = osrm_url.rstrip("/")
        self._overpass_url = overpass_url

        # Track concurrent active calls for testing/observability
        self.active_in_flight: int = 0
        self.peak_in_flight: int = 0

    @staticmethod
    def _normalize_upstream_name(upstream: str) -> str:
        return upstream.strip().lower().replace("-", "_")

    def _validate_upstream(self, upstream: str) -> str:
        key = self._normalize_upstream_name(upstream)
        if key not in self.breakers:
            raise ValueError(f"Unknown upstream '{upstream}'; expected one of {UPSTREAM_NAMES}")
        return key

    def set_fault_injection(self, upstream: str, status_code: int | None) -> None:
        """Enable or clear simulated upstream HTTP fault status (`429`, `503`, `504`, or `None`)."""
        key = self._validate_upstream(upstream)
        if status_code is not None and status_code not in VALID_FAULT_STATUS_CODES:
            raise ValueError(
                f"Invalid fault injection status_code={status_code}; "
                f"allowed={sorted(VALID_FAULT_STATUS_CODES)}"
            )
        self.fault_injection_modes[key] = status_code

    def reset_breaker(self, upstream: str) -> None:
        """Reset a named upstream circuit breaker back to CLOSED."""
        key = self._validate_upstream(upstream)
        self.breakers[key].reset()

    def get_breaker_statuses(self) -> dict[str, dict[str, Any]]:
        """Return per-upstream circuit breaker states, rolling error rates, and fault modes."""
        return {
            name: breaker.to_status_dict(injected_status=self.fault_injection_modes.get(name))
            for name, breaker in self.breakers.items()
        }

    async def _request_with_resilience(
        self,
        method: str,
        url: str,
        *,
        upstream: str = "open_meteo",
        **kwargs: Any,
    ) -> httpx.Response:
        """Execute an HTTP request through Semaphore, RateLimiter, Retries, and CircuitBreaker."""
        key = self._validate_upstream(upstream)
        breaker = self.breakers[key]

        if not self.rate_limiter.try_acquire(1.0):
            raise UpstreamHttpError(429, "Local token bucket rate limit exceeded")

        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:

                async def _do_single_attempt() -> httpx.Response:
                    injected_status = self.fault_injection_modes.get(key)
                    if injected_status is not None:
                        raise UpstreamHttpError(injected_status, "Injected fault")
                    async with self.semaphore:
                        self.active_in_flight += 1
                        if self.active_in_flight > self.peak_in_flight:
                            self.peak_in_flight = self.active_in_flight
                        try:
                            response = await self._http_client.request(method, url, **kwargs)
                            if response.status_code in self.RETRYABLE_STATUS_CODES:
                                raise UpstreamHttpError(
                                    response.status_code,
                                    f"Upstream returned HTTP {response.status_code}",
                                )
                            response.raise_for_status()
                            return response
                        finally:
                            self.active_in_flight -= 1

                return await breaker.call(_do_single_attempt)
            except CircuitBreakerOpenError:
                # Never retry when the circuit breaker is already OPEN or HALF_OPEN locked
                raise
            except (
                UpstreamHttpError,
                httpx.TimeoutException,
                httpx.TransportError,
                httpx.HTTPStatusError,
                TimeoutError,
            ) as exc:
                last_exc = exc
                if breaker.state == CircuitState.OPEN or attempt >= self.max_retries:
                    break
                delay = full_jitter_backoff(
                    attempt,
                    base_delay=self.base_backoff_sec,
                    cap_delay=self.cap_backoff_sec,
                )
                if delay > 0.0:
                    await asyncio.sleep(delay)

        assert last_exc is not None
        raise last_exc

    async def _redis_get_json(self, key: str) -> dict[str, Any] | None:
        if self._redis_client is None or not hasattr(self._redis_client, "get"):
            return None
        try:
            raw = self._redis_client.get(key)
            if inspect.isawaitable(raw):
                raw = await raw
            if raw is None:
                return None
            if isinstance(raw, dict):
                return raw
            if isinstance(raw, (bytes, bytearray)):
                raw = raw.decode("utf-8")
            if isinstance(raw, str):
                data = json.loads(raw)
                if isinstance(data, dict):
                    return data
        except Exception:
            return None
        return None

    async def _redis_set_json(self, key: str, payload: dict[str, Any], ttl_sec: int = 900) -> None:
        if self._redis_client is None or not hasattr(self._redis_client, "set"):
            return
        try:
            serialized = json.dumps(payload)
            try:
                res = self._redis_client.set(key, serialized, ex=ttl_sec)
            except TypeError:
                res = self._redis_client.set(key, serialized)
            if inspect.isawaitable(res):
                await res
        except Exception:
            pass

    async def fetch_weather_grid(
        self,
        geohash: str,
        lat: float = 51.5074,
        lon: float = -0.1278,
    ) -> WeatherGridResponse:
        """
        Fetch spatial weather conditions for `geohash` from Open-Meteo.
        If the circuit breaker is OPEN or upstream returns 429/503/timeout,
        returns cached speeds from Redis (`GET weather:grid:{geohash}`) with `is_degraded=True`.
        """
        cache_key = f"weather:grid:{geohash}"
        try:
            resp = await self._request_with_resilience(
                "GET",
                self._open_meteo_url,
                upstream="open_meteo",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "precipitation,wind_speed_10m",
                },
            )
            body = resp.json()
            current = body.get("current", body)
            precip = float(current.get("precipitation", current.get("precipitation_mm", 0.0)))
            wind = float(current.get("wind_speed_10m", current.get("wind_speed_kmh", 0.0)))
            multiplier = float(
                current.get(
                    "speed_multiplier",
                    compute_weather_speed_multiplier(precip, wind),
                )
            )
            result = WeatherGridResponse(
                geohash=geohash,
                precipitation_mm=precip,
                wind_speed_kmh=wind,
                speed_multiplier=multiplier,
                is_degraded=False,
            )
            await self._redis_set_json(cache_key, result.model_dump())
            return result
        except Exception:
            cached = await self._redis_get_json(cache_key)
            if cached is not None:
                precip = float(cached.get("precipitation_mm", 0.0))
                wind = float(cached.get("wind_speed_kmh", 0.0))
                multiplier = float(
                    cached.get(
                        "speed_multiplier",
                        compute_weather_speed_multiplier(precip, wind),
                    )
                )
                return WeatherGridResponse(
                    geohash=geohash,
                    precipitation_mm=precip,
                    wind_speed_kmh=wind,
                    speed_multiplier=multiplier,
                    is_degraded=True,
                )
            return WeatherGridResponse(
                geohash=geohash,
                precipitation_mm=0.0,
                wind_speed_kmh=0.0,
                speed_multiplier=0.85,
                is_degraded=True,
            )

    async def fetch_route_baseline(
        self,
        origin_lat: float,
        origin_lon: float,
        dest_lat: float,
        dest_lon: float,
    ) -> RouteBaselineResponse:
        """
        Fetch baseline driving route from OSRM HTTP API with Redis fallback (`is_degraded=True`).
        """
        coord_key = f"{origin_lat:.4f},{origin_lon:.4f}:{dest_lat:.4f},{dest_lon:.4f}"
        cache_key = f"route:baseline:{coord_key}"
        url = (
            f"{self._osrm_url}/route/v1/driving/"
            f"{origin_lon:.6f},{origin_lat:.6f};{dest_lon:.6f},{dest_lat:.6f}"
        )
        try:
            resp = await self._request_with_resilience(
                "GET",
                url,
                upstream="osrm",
                params={"overview": "full"},
            )
            data = resp.json()
            routes = data.get("routes") or []
            first = routes[0] if routes else {}
            distance_m = float(first.get("distance", 0.0))
            duration_s = float(first.get("duration", 0.0))
            geometry = str(first.get("geometry", ""))
            result = RouteBaselineResponse(
                origin_lat=origin_lat,
                origin_lon=origin_lon,
                dest_lat=dest_lat,
                dest_lon=dest_lon,
                distance_meters=distance_m,
                duration_seconds=duration_s,
                encoded_polyline=geometry,
                is_degraded=False,
            )
            await self._redis_set_json(cache_key, result.model_dump())
            return result
        except Exception:
            cached = await self._redis_get_json(cache_key)
            if cached is not None:
                return RouteBaselineResponse(
                    origin_lat=origin_lat,
                    origin_lon=origin_lon,
                    dest_lat=dest_lat,
                    dest_lon=dest_lon,
                    distance_meters=float(cached.get("distance_meters", 0.0)),
                    duration_seconds=float(cached.get("duration_seconds", 0.0)),
                    encoded_polyline=str(cached.get("encoded_polyline", "")),
                    is_degraded=True,
                )
            straight_m = _haversine_meters(origin_lat, origin_lon, dest_lat, dest_lon)
            road_m = round(straight_m * 1.3, 2)
            duration_s = round(road_m / 11.11, 2)  # ~40 km/h urban baseline
            return RouteBaselineResponse(
                origin_lat=origin_lat,
                origin_lon=origin_lon,
                dest_lat=dest_lat,
                dest_lon=dest_lon,
                distance_meters=road_m,
                duration_seconds=duration_s,
                encoded_polyline="",
                is_degraded=True,
            )

    async def fetch_road_graph(
        self,
        bbox: tuple[float, float, float, float],
    ) -> RoadGraphResponse:
        """Fetch OSM street network elements within `bbox` from Overpass API."""
        south, west, north, east = bbox
        query = (
            f"[out:json][timeout:5];"
            f"(way['highway']({south},{west},{north},{east});>;);"
            f"out body;"
        )
        try:
            resp = await self._request_with_resilience(
                "POST",
                self._overpass_url,
                upstream="overpass",
                content=query.encode("utf-8"),
            )
            data = resp.json()
            elements = data.get("elements") or []
            nodes = sum(1 for el in elements if el.get("type") == "node")
            ways = sum(1 for el in elements if el.get("type") == "way")
            return RoadGraphResponse(
                bbox=bbox,
                node_count=nodes,
                edge_count=ways,
                is_degraded=False,
            )
        except Exception:
            return RoadGraphResponse(
                bbox=bbox,
                node_count=0,
                edge_count=0,
                is_degraded=True,
            )

    async def fetch_road_network(
        self,
        bbox: tuple[float, float, float, float],
        *,
        max_nodes: int = 12000,
        max_edges: int = 24000,
    ) -> RoadGraphNetworkResponse:
        """
        Fetch bounded drivable OSM street geometry & topology within `bbox` from Overpass API.
        Supports both `out geom qt;` inline way coordinate chains and `out body;` node references.
        Caches compact graph payloads in Redis and returns cached data with `is_degraded=True`
        when the `overpass` circuit breaker is OPEN or upstream fails.
        """
        south, west, north, east = bbox
        cache_key = f"graph:network:{south:.3f},{west:.3f},{north:.3f},{east:.3f}"
        query = (
            "[out:json][timeout:10];"
            f"way['highway'~'^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|"
            f"secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$']"
            f"({south},{west},{north},{east});"
            "out geom qt;"
        )
        try:
            resp = await self._request_with_resilience(
                "POST",
                self._overpass_url,
                upstream="overpass",
                content=query.encode("utf-8"),
            )
            data = resp.json()
            elements = data.get("elements") or []

            osm_nodes: dict[int, tuple[float, float]] = {}
            for el in elements:
                if el.get("type") == "node" and "id" in el and "lat" in el and "lon" in el:
                    osm_nodes[int(el["id"])] = (
                        round(float(el["lon"]), 6),
                        round(float(el["lat"]), 6),
                    )

            nodes: list[tuple[float, float]] = []
            osm_to_idx: dict[int, int] = {}
            coord_to_idx: dict[tuple[float, float], int] = {}
            edges: list[tuple[int, int, str, bool, float]] = []

            def _intern_node(osm_id: int) -> int | None:
                existing = osm_to_idx.get(osm_id)
                if existing is not None:
                    return existing
                coord = osm_nodes.get(osm_id)
                if coord is None or len(nodes) >= max_nodes:
                    return None
                idx = len(nodes)
                osm_to_idx[osm_id] = idx
                coord_to_idx[coord] = idx
                nodes.append(coord)
                return idx

            def _intern_coord(lon: float, lat: float) -> int | None:
                coord = (round(lon, 6), round(lat, 6))
                existing = coord_to_idx.get(coord)
                if existing is not None:
                    return existing
                if len(nodes) >= max_nodes:
                    return None
                idx = len(nodes)
                coord_to_idx[coord] = idx
                nodes.append(coord)
                return idx

            for el in elements:
                if len(edges) >= max_edges:
                    break
                if el.get("type") != "way":
                    continue
                tags = el.get("tags") or {}
                highway = str(tags.get("highway", "")).strip().lower()
                if highway not in _DRIVABLE_HIGHWAY_SPEED_MPS:
                    continue
                oneway_tag = str(tags.get("oneway", "")).strip().lower()
                is_oneway = oneway_tag in {"yes", "1", "true"} or highway in {
                    "motorway",
                    "motorway_link",
                }
                is_reverse = oneway_tag == "-1"
                speed_mps = _parse_osm_speed_mps(tags.get("maxspeed"), highway)

                way_geom = el.get("geometry")
                if isinstance(way_geom, list) and len(way_geom) >= 2:
                    seq_geom = list(reversed(way_geom)) if is_reverse else list(way_geom)
                    for i in range(len(seq_geom) - 1):
                        if len(edges) >= max_edges:
                            break
                        pt_u = seq_geom[i]
                        pt_v = seq_geom[i + 1]
                        if not isinstance(pt_u, dict) or not isinstance(pt_v, dict):
                            continue
                        if "lon" not in pt_u or "lat" not in pt_u or "lon" not in pt_v or "lat" not in pt_v:
                            continue
                        u_idx = _intern_coord(float(pt_u["lon"]), float(pt_u["lat"]))
                        v_idx = _intern_coord(float(pt_v["lon"]), float(pt_v["lat"]))
                        if u_idx is None or v_idx is None or u_idx == v_idx:
                            continue
                        edges.append((u_idx, v_idx, highway, is_oneway or is_reverse, speed_mps))
                    continue

                way_node_ids = el.get("nodes") or []
                if len(way_node_ids) < 2:
                    continue
                seq = list(reversed(way_node_ids)) if is_reverse else list(way_node_ids)
                for i in range(len(seq) - 1):
                    if len(edges) >= max_edges:
                        break
                    u_idx = _intern_node(int(seq[i]))
                    v_idx = _intern_node(int(seq[i + 1]))
                    if u_idx is None or v_idx is None or u_idx == v_idx:
                        continue
                    edges.append((u_idx, v_idx, highway, is_oneway or is_reverse, speed_mps))

            result = RoadGraphNetworkResponse(
                bbox=bbox,
                nodes=nodes,
                edges=edges,
                node_count=len(nodes),
                edge_count=len(edges),
                is_degraded=False,
            )
            await self._redis_set_json(cache_key, result.model_dump(), ttl_sec=1800)
            return result
        except Exception:
            cached = await self._redis_get_json(cache_key)
            if cached is not None:
                cached_nodes = [
                    (float(p[0]), float(p[1])) for p in (cached.get("nodes") or []) if len(p) >= 2
                ]
                cached_edges = [
                    (int(e[0]), int(e[1]), str(e[2]), bool(e[3]), float(e[4]))
                    for e in (cached.get("edges") or [])
                    if len(e) >= 5
                ]
                return RoadGraphNetworkResponse(
                    bbox=bbox,
                    nodes=cached_nodes,
                    edges=cached_edges,
                    node_count=len(cached_nodes),
                    edge_count=len(cached_edges),
                    is_degraded=True,
                )
            return RoadGraphNetworkResponse(
                bbox=bbox,
                nodes=[],
                edges=[],
                node_count=0,
                edge_count=0,
                is_degraded=True,
            )
