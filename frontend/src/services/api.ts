import type {
  BookmarkId,
  CircuitBreakerStatus,
  EtaCompareResponse,
  OrchestratorMetricsResponse,
  ReoptimizeRequest,
  ReoptimizeResponse,
  RoadGraphNetworkDto,
  RoadGraphResponse,
  SnapshotResponse,
  SystemMetricsResponse,
  UpstreamName,
  WeatherGridCell,
  WeatherGridResponse,
} from '../types/chronos';
import { BOOKMARK_BY_ID } from '../constants/bookmarks';

const DEFAULT_TIMEOUT_MS = 4500;

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} from ${url}${bodyText ? `: ${bodyText.slice(0, 140)}` : ''}`);
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export function generateClientIdempotencyKey(prefix = 'ui'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export async function fetchSnapshot(limit = 250): Promise<SnapshotResponse> {
  return fetchJson<SnapshotResponse>(`/api/v1/snapshot?limit=${encodeURIComponent(limit)}`);
}

export async function fetchSystemMetrics(): Promise<SystemMetricsResponse> {
  return fetchJson<SystemMetricsResponse>('/api/v1/system/metrics', undefined, 2500);
}

export async function fetchOrchestratorMetrics(): Promise<OrchestratorMetricsResponse> {
  return fetchJson<OrchestratorMetricsResponse>('/api/v1/orchestrator/metrics', undefined, 2500);
}

export async function fetchWeatherGrid(
  geohash: string,
  lat: number,
  lon: number,
): Promise<WeatherGridResponse> {
  const params = new URLSearchParams({
    lat: lat.toFixed(4),
    lon: lon.toFixed(4),
  });
  return fetchJson<WeatherGridResponse>(
    `/api/v1/weather/${encodeURIComponent(geohash)}?${params.toString()}`,
  );
}

export async function fetchRoadGraphSummary(
  lat: number,
  lon: number,
  deltaDeg = 0.03,
): Promise<RoadGraphResponse> {
  const params = new URLSearchParams({
    south: (lat - deltaDeg).toFixed(5),
    west: (lon - deltaDeg).toFixed(5),
    north: (lat + deltaDeg).toFixed(5),
    east: (lon + deltaDeg).toFixed(5),
  });
  return fetchJson<RoadGraphResponse>(`/api/v1/graph/bbox?${params.toString()}`, undefined, 6000);
}

export async function fetchRoadGraphNetwork(
  lat: number,
  lon: number,
  deltaDeg = 0.032,
): Promise<RoadGraphNetworkDto> {
  const params = new URLSearchParams({
    south: (lat - deltaDeg).toFixed(5),
    west: (lon - deltaDeg).toFixed(5),
    north: (lat + deltaDeg).toFixed(5),
    east: (lon + deltaDeg).toFixed(5),
  });
  return fetchJson<RoadGraphNetworkDto>(
    `/api/v1/graph/network?${params.toString()}`,
    undefined,
    6000,
  );
}

export async function fetchEtaCompare(params: {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  hourOfDay?: number;
  precipitationMm?: number;
  windSpeedKmh?: number;
}): Promise<EtaCompareResponse> {
  const qs = new URLSearchParams({
    origin_lat: params.originLat.toFixed(6),
    origin_lon: params.originLon.toFixed(6),
    dest_lat: params.destLat.toFixed(6),
    dest_lon: params.destLon.toFixed(6),
    precipitation_mm: (params.precipitationMm ?? 0).toFixed(2),
    wind_speed_kmh: (params.windSpeedKmh ?? 5).toFixed(2),
  });
  if (typeof params.hourOfDay === 'number') {
    qs.set('hour_of_day', String(params.hourOfDay));
  }
  return fetchJson<EtaCompareResponse>(`/api/v1/eta/compare?${qs.toString()}`);
}

export async function triggerReoptimize(
  request: ReoptimizeRequest = {},
): Promise<ReoptimizeResponse> {
  return fetchJson<ReoptimizeResponse>(
    '/api/v1/dispatch/reoptimize',
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': generateClientIdempotencyKey('reopt'),
        'x-trace-id': generateClientIdempotencyKey('trace'),
      },
      body: JSON.stringify(request),
    },
    6000,
  );
}

export async function startGpsBurst(params: {
  ratePerSec: number;
  durationSec?: number;
  bookmarkId: BookmarkId;
}): Promise<{ status: string; rate_per_sec?: number; duration_sec?: number }> {
  const city = BOOKMARK_BY_ID[params.bookmarkId];
  return fetchJson('/api/v1/simulation/burst', {
    method: 'POST',
    body: JSON.stringify({
      rate_per_sec: params.ratePerSec,
      duration_sec: params.durationSec ?? 5,
      center_lat: city.lat,
      center_lon: city.lon,
    }),
  });
}

export async function toggleFaultInjection(params: {
  upstream: UpstreamName;
  statusCode: 429 | 503 | null;
  probeNow?: boolean;
}): Promise<{
  upstream: UpstreamName;
  status_code: number | null;
  breaker?: CircuitBreakerStatus;
  circuit_breakers?: Record<UpstreamName, CircuitBreakerStatus>;
}> {
  return fetchJson('/api/v1/simulation/fault-injection', {
    method: 'POST',
    body: JSON.stringify({
      upstream: params.upstream,
      status_code: params.statusCode,
      probe_now: params.probeNow ?? true,
    }),
  });
}

export async function applyWeatherSurge(params: {
  bookmarkId: BookmarkId;
  precipitationMm: number;
  windSpeedKmh: number;
  speedMultiplier: number;
  triggerReoptimize?: boolean;
}): Promise<{
  cells?: WeatherGridCell[];
  speed_multiplier?: number;
  solver_event?: ReoptimizeResponse | null;
  reoptimize?: ReoptimizeResponse | null;
}> {
  const city = BOOKMARK_BY_ID[params.bookmarkId];
  return fetchJson(
    '/api/v1/simulation/weather-surge',
    {
      method: 'POST',
      body: JSON.stringify({
        center_lat: city.lat,
        center_lon: city.lon,
        precipitation_mm: params.precipitationMm,
        wind_speed_kmh: params.windSpeedKmh,
        speed_multiplier: params.speedMultiplier,
        trigger_reoptimize: params.triggerReoptimize ?? true,
      }),
    },
    6000,
  );
}

/**
 * Deterministic local fallback ETA comparison when running in Sandbox Replay Mode
 * or when `/api/v1/eta/compare` is unreachable.
 */
export function computeFallbackEtaCompare(params: {
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  precipitationMm?: number;
  windSpeedKmh?: number;
}): EtaCompareResponse {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const rEarth = 6_371_000;
  const dLat = toRad(params.destLat - params.originLat);
  const dLon = toRad(params.destLon - params.originLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(params.originLat)) *
      Math.cos(toRad(params.destLat)) *
      Math.sin(dLon / 2) ** 2;
  const straightMeters = 2 * rEarth * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  const roadMeters = Math.max(250, Math.round(straightMeters * 1.32));
  const osrmBaselineSeconds = Math.round((roadMeters / 10.6) * 10) / 10;

  const precip = Math.max(0, params.precipitationMm ?? 0);
  const wind = Math.max(0, params.windSpeedKmh ?? 5);
  const hour = new Date().getUTCHours();
  const peakTrafficFactor =
    (hour >= 7 && hour <= 10) || (hour >= 16 && hour <= 20) ? 0.16 : 0.04;
  const weatherResidual = Math.min(0.42, precip * 0.0085 + Math.max(0, wind - 20) * 0.003);
  const onnxMultiplier = Math.round((1.06 + peakTrafficFactor + weatherResidual) * 1000) / 1000;
  const onnxEtaSeconds = Math.round(osrmBaselineSeconds * onnxMultiplier * 10) / 10;
  const deltaSeconds = Math.round((onnxEtaSeconds - osrmBaselineSeconds) * 10) / 10;

  return {
    distance_meters: roadMeters,
    osrm_baseline_seconds: osrmBaselineSeconds,
    onnx_multiplier: onnxMultiplier,
    onnx_eta_seconds: onnxEtaSeconds,
    delta_seconds: deltaSeconds,
    is_degraded: false,
  };
}
