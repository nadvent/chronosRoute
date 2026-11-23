/**
 * Canonical ChronosRoute domain types matching Tier 1 (FastAPI) & Tier 2 (Spring Boot) contracts.
 */

export type CourierStatus =
  | 'OFFLINE'
  | 'IDLE'
  | 'ASSIGNED'
  | 'EN_ROUTE_PICKUP'
  | 'EN_ROUTE_DROPOFF';

export type OrderStatus =
  | 'PENDING'
  | 'BATCHING'
  | 'ASSIGNED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'FAILED'
  | 'CANCELLED';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type UpstreamName = 'open_meteo' | 'osrm' | 'overpass';

export type SimulationMode = 'live' | 'sandbox';

export type BookmarkId =
  | 'london'
  | 'kl'
  | 'singapore'
  | 'berlin'
  | 'sf'
  | 'tokyo';

export interface HubCoordSpec {
  name: string;
  lat: number;
  lon: number;
}

export interface LocationBookmark {
  id: BookmarkId;
  name: string;
  countryCode: string;
  metroArea: string;
  lat: number;
  lon: number;
  zoom: number;
  isDefault?: boolean;
  weatherModel: string;
  weatherResolutionKm: string;
  osmCoverage: string;
  hubNames: string[];
  hubCoords: HubCoordSpec[];
  description: string;
}

export interface GeoCoordDto {
  lat: number;
  lon: number;
}

export interface HubSnapshotDto {
  hubId: string;
  name: string;
  lat: number;
  lon: number;
  capacityOrdersPerHour: number;
}

export interface CourierSnapshotDto {
  courierId: string;
  name: string;
  status: CourierStatus;
  lat: number;
  lon: number;
  headingDeg: number;
  speedMps: number;
  batteryPct: number;
  currentCapacityKg: number;
  maxCapacityKg: number;
  lastPingAt: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  activeRouteOrderIds: string[];
}

export interface OrderSnapshotDto {
  orderId: string;
  hubId: string;
  courierId: string | null;
  status: OrderStatus;
  weightKg: number;
  pickupLat: number;
  pickupLon: number;
  dropoffLat: number;
  dropoffLon: number;
  windowStart: string;
  windowEnd: string;
  serviceDurationSeconds: number;
  version: number;
}

export interface RouteWaypointDto {
  orderId: string;
  lat: number;
  lon: number;
  arrivalUnix: number;
  departureUnix: number;
  slackSeconds: number;
  accumulatedLoadKg: number;
  weightKg: number;
  windowStartUnix: number;
  windowEndUnix: number;
}

export interface RoutePetalDto {
  courierId: string;
  hubId: string;
  courierName: string;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  capacityUsedKg: number;
  maxCapacityKg: number;
  encodedPolyline: string;
  waypoints: RouteWaypointDto[];
  /** `[lon, lat]` coordinate sequence for deck.gl PathLayer */
  pathCoords: [number, number][];
}

export type RoadNetworkSource = 'osrm-calibrated-osm' | 'vector-tiles' | 'overpass' | 'fallback-grid';

export interface SolveTelemetryDto {
  requestId: string;
  solverStatus: string;
  solveDurationMs: number;
  matrixPreprocessMs: number;
  activeWorkerThreads: number;
  objectiveCost: number;
  iterationsCompleted: number;
  timestamp: string;
  convergenceHistory?: number[];
}

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | 'Point' | 'LineString';
    coordinates: unknown;
  };
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

export interface SnapshotResponse {
  generatedAt: string;
  regionCenter: GeoCoordDto;
  hubs: HubSnapshotDto[];
  zonesGeoJson: GeoJsonFeatureCollection;
  couriers: CourierSnapshotDto[];
  orders: OrderSnapshotDto[];
  routes: RoutePetalDto[];
  latestSolve: SolveTelemetryDto | null;
}

export interface RouteAssignmentDto {
  courierId: string;
  assignedOrderIds: string[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  encodedPolyline: string;
}

export interface DispatchBatchResult {
  requestId: string;
  traceId: string;
  dispatchOutcome: string;
  claimedOrderCount: number;
  assignedOrderIds: string[];
  unassignedOrderIds: string[];
  routes: RouteAssignmentDto[];
  retainedExistingRoutesCount: number;
  degradedFallback: boolean;
  replayedFromIdempotency: boolean;
  solverDurationMs: number;
}

export interface ReoptimizeRequest {
  hubId?: string;
  batchSize?: number;
  weatherSeverityScore?: number;
  speedMultiplier?: number;
}

export interface ReoptimizeResponse {
  batchResult: DispatchBatchResult;
  beforeRoutes: RoutePetalDto[];
  afterRoutes: RoutePetalDto[];
  distanceSavedMeters: number;
  resolvedViolations: number;
  reassignedOrderIds: string[];
  solveTelemetry: SolveTelemetryDto;
}

export interface OrchestratorMetricsResponse {
  status: string;
  virtualThreadsEnabled: boolean;
  activeVirtualThreads: number;
  bulkheadMaxPermits: number;
  bulkheadAvailablePermits: number;
  bulkheadTotalAcquisitions: number;
  peakConcurrentBatchHolders: number;
  hikariActiveConnections: number;
  hikariIdleConnections: number;
  hikariMaxConnections: number;
  postgisQueryLatencyMs: number;
  solverDeadlineMs: number;
  lastSolveDurationMs: number;
  lastMatrixPreprocessMs: number;
  lastObjectiveCost: number;
  lastIterationsCompleted: number;
  solverWorkers: number;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failure_count: number;
  error_rate: number;
  total_calls: number;
  total_failures?: number;
  total_short_circuited: number;
  injected_status: number | null;
}

export interface IngestionMetrics {
  events_per_sec: number;
  total_enqueued: number;
  total_flushed: number;
  queue_depth: number;
  max_queue_size: number;
}

export interface SystemMetricsResponse {
  timestamp: string;
  ingestion: IngestionMetrics;
  circuit_breakers: Record<UpstreamName, CircuitBreakerStatus>;
  orchestrator: Partial<OrchestratorMetricsResponse> & { status?: string };
}

export interface EtaCompareResponse {
  distance_meters: number;
  osrm_baseline_seconds: number;
  onnx_multiplier: number;
  onnx_eta_seconds: number;
  delta_seconds: number;
  is_degraded: boolean;
}

export interface WeatherGridResponse {
  geohash: string;
  precipitation_mm: number;
  wind_speed_kmh: number;
  speed_multiplier: number;
  is_degraded: boolean;
}

export interface WeatherGridCell {
  geohash: string;
  lat: number;
  lon: number;
  precipitation_mm: number;
  wind_speed_kmh: number;
  speed_multiplier: number;
  severity_score?: number;
  is_degraded?: boolean;
}

export interface RoadGraphResponse {
  bbox: [number, number, number, number];
  node_count: number;
  edge_count: number;
  is_degraded: boolean;
}

export interface RoadGraphNetworkDto {
  bbox: [number, number, number, number];
  /** `[lon, lat]` coordinates indexed by node ID. */
  nodes: [number, number][];
  /** `[uIdx, vIdx, roadClass, oneway, speedMps]` compact edge tuples. */
  edges: [number, number, string, boolean, number][];
  node_count: number;
  edge_count: number;
  is_degraded: boolean;
}

export interface TrailPoint {
  lat: number;
  lon: number;
  timestampMs: number;
  speedMps: number;
}

export interface MetricsHistoryPoint {
  timestampMs: number;
  eventsPerSec: number;
  queueDepth: number;
  postgisLatencyMs: number;
}

export interface AlnsOperatorWeights {
  destroy: {
    shaw: number;
    worst: number;
    random: number;
  };
  repair: {
    regret2: number;
    greedy: number;
  };
}

export interface LayerVisibility {
  zones: boolean;
  weather: boolean;
  heatmap: boolean;
  routes: boolean;
  routeDiff: boolean;
  orders: boolean;
  couriers: boolean;
  trail: boolean;
  roadGraph: boolean;
}

export type SelectedEntity =
  | { type: 'courier'; id: string }
  | { type: 'order'; id: string }
  | { type: 'route'; courierId: string }
  | { type: 'hub'; id: string }
  | null;

export type ExplorerTab = 'fleet' | 'orders' | 'solver' | 'chaos' | null;

export type SimSpeedMultiplier = 0.5 | 1 | 2 | 4;

export interface CameraFocusRequest {
  /** `[lon, lat]` coordinates to frame or fly to. */
  coords: [number, number][];
  /** Monotonic nonce so repeated clicks on the same target still trigger camera fit. */
  nonce: number;
}

export interface RoadGraphStats {
  source: RoadNetworkSource;
  nodeCount: number;
  edgeCount: number;
  osrmSpeedScale?: number;
  isCalibrating?: boolean;
}

export interface TelemetryPingFrame {
  courier_id: string;
  lat: number;
  lon: number;
  speed_mps: number;
  heading_deg: number;
  battery_pct: number;
  recorded_at?: string;
}

export type WsConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type WsInboundEvent =
  | {
      type: 'system_status';
      timestamp?: string;
      data?: {
        events_per_sec?: number;
        queue_depth?: number;
        circuit_breakers?: Record<UpstreamName, CircuitBreakerStatus>;
      };
    }
  | {
      type: 'telemetry_batch' | 'telemetry';
      timestamp?: string;
      data?: {
        pings?: TelemetryPingFrame[];
        events_per_sec?: number;
        queue_depth?: number;
      };
      pings?: TelemetryPingFrame[];
      events_per_sec?: number;
      queue_depth?: number;
    }
  | {
      type: 'circuit_breaker';
      timestamp?: string;
      data?: {
        upstream?: UpstreamName;
        status?: CircuitBreakerStatus;
        breaker?: CircuitBreakerStatus;
        circuit_breakers?: Record<UpstreamName, CircuitBreakerStatus>;
      };
      upstream?: UpstreamName;
      status?: CircuitBreakerStatus;
      circuit_breakers?: Record<UpstreamName, CircuitBreakerStatus>;
    }
  | {
      type: 'weather_surge';
      timestamp?: string;
      data?: {
        cells?: WeatherGridCell[];
        speed_multiplier?: number;
        precipitation_mm?: number;
      };
      cells?: WeatherGridCell[];
      speed_multiplier?: number;
      precipitation_mm?: number;
    }
  | {
      type: 'solver_event';
      timestamp?: string;
      data?: ReoptimizeResponse & {
        reoptimize?: ReoptimizeResponse;
        solveTelemetry?: SolveTelemetryDto;
      };
      reoptimize?: ReoptimizeResponse;
      solveTelemetry?: SolveTelemetryDto;
    }
  | {
      type: 'metrics';
      timestamp?: string;
      data?: Partial<SystemMetricsResponse>;
      payload?: Partial<SystemMetricsResponse>;
      events_per_sec?: number;
      queue_depth?: number;
    };

export interface CourierInterpolationState {
  prevLat: number;
  prevLon: number;
  targetLat: number;
  targetLon: number;
  prevHeadingDeg: number;
  headingDeg: number;
  updatedAtMs: number;
  durationMs: number;
  /** Exact road vertices `[lon, lat][]` traversed during the latest tick for corner-following 60 FPS motion. */
  subpathCoords?: [number, number][];
}
