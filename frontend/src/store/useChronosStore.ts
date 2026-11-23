import { create } from 'zustand';
import {
  BOOKMARK_BY_ID,
  DEFAULT_BOOKMARK_ID,
  MAX_METRICS_HISTORY,
  MAX_SOLVE_HISTORY,
  MAX_TRAIL_POINTS,
} from '../constants/bookmarks';
import {
  applyWeatherSurge,
  fetchRoadGraphNetwork,
  fetchRoadGraphSummary,
  fetchWeatherGrid,
  startGpsBurst,
  toggleFaultInjection,
  triggerReoptimize,
} from '../services/api';
import {
  haversineMeters,
  interpolateBearingDeg,
  precomputePolyline,
  samplePolylineAtDistance,
} from '../services/polylineKinematics';
import {
  buildRoadNetworkFromOverpassDto,
  type RoadNetworkGraph,
  type RoadNetworkSource,
} from '../services/roadNetwork';
import {
  calibrateGraphWithOsrmTable,
  fetchOsrmMultiStopRoute,
  loadCityOsmRoadNetwork,
} from '../services/osmRoadLoader';
import {
  applyOsrmRouteShapeToCourier,
  applySandboxFaultInjection,
  collectUnhydratedOsrmRouteRequests,
  createSandboxState,
  stepSandboxSimulation,
  triggerSandboxReoptimize,
  upgradeSandboxRoadGraph,
  type SandboxState,
} from '../services/sandboxSimulator';
import type {
  AlnsOperatorWeights,
  BookmarkId,
  CameraFocusRequest,
  CircuitBreakerStatus,
  CourierInterpolationState,
  CourierSnapshotDto,
  ExplorerTab,
  GeoJsonFeatureCollection,
  HubSnapshotDto,
  LayerVisibility,
  MetricsHistoryPoint,
  OrderSnapshotDto,
  ReoptimizeResponse,
  RoadGraphResponse,
  RoadGraphStats,
  RoutePetalDto,
  SelectedEntity,
  SimSpeedMultiplier,
  SimulationMode,
  SolveTelemetryDto,
  SystemMetricsResponse,
  TrailPoint,
  UpstreamName,
  WeatherGridCell,
  WeatherGridResponse,
  WsConnectionStatus,
} from '../types/chronos';

const INTERP_DURATION_MS = 1000;
const TELEPORT_SNAP_THRESHOLD_M = 500;

function pushBounded<T>(arr: readonly T[], item: T, maxLen: number): T[] {
  if (arr.length < maxLen) {
    return [...arr, item];
  }
  return [...arr.slice(arr.length - maxLen + 1), item];
}

function defaultCircuitBreakers(): Record<UpstreamName, CircuitBreakerStatus> {
  return {
    open_meteo: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0,
      total_calls: 0,
      total_failures: 0,
      total_short_circuited: 0,
      injected_status: null,
    },
    osrm: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0,
      total_calls: 0,
      total_failures: 0,
      total_short_circuited: 0,
      injected_status: null,
    },
    overpass: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0,
      total_calls: 0,
      total_failures: 0,
      total_short_circuited: 0,
      injected_status: null,
    },
  };
}

function buildInitialCityWeatherCells(bookmarkId: BookmarkId): WeatherGridCell[] {
  const city = BOOKMARK_BY_ID[bookmarkId];
  const cells: WeatherGridCell[] = [];
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      cells.push({
        geohash: `${bookmarkId.slice(0, 2)}${r + 2}${c + 2}`,
        lat: Number((city.lat + r * 0.016).toFixed(5)),
        lon: Number((city.lon + c * 0.022).toFixed(5)),
        precipitation_mm: 0.8,
        wind_speed_kmh: 12.0,
        speed_multiplier: 0.96,
        is_degraded: false,
      });
    }
  }
  return cells;
}

export interface ChronosStoreState {
  // Mode & location
  mode: SimulationMode;
  autoFallbackReason: string | null;
  activeBookmarkId: BookmarkId;
  wsStatus: WsConnectionStatus;

  // Map data
  hubs: HubSnapshotDto[];
  zonesGeoJson: GeoJsonFeatureCollection;
  couriers: CourierSnapshotDto[];
  courierInterp: Record<string, CourierInterpolationState>;
  courierTrails: Record<string, TrailPoint[]>;
  orders: OrderSnapshotDto[];
  routes: RoutePetalDto[];
  weatherCells: WeatherGridCell[];
  liveWeatherBanner: WeatherGridResponse | null;
  liveRoadGraph: RoadGraphResponse | null;
  activeRoadGraph: RoadNetworkGraph | null;
  roadGraphSource: RoadNetworkSource;
  roadGraphStats: RoadGraphStats;

  // Solver & diff state
  latestSolve: SolveTelemetryDto | null;
  solveHistory: SolveTelemetryDto[];
  operatorWeights: AlnsOperatorWeights;
  lastReoptimize: ReoptimizeResponse | null;
  isReoptimizing: boolean;
  showRouteDiff: boolean;

  // System telemetry
  systemMetrics: SystemMetricsResponse;
  metricsHistory: MetricsHistoryPoint[];

  // Chaos controls
  burstRatePerSec: number;
  burstRunning: boolean;
  weatherSurgeIntensity: number;
  faultModes: Record<UpstreamName, 429 | 503 | null>;

  // UI selections, workspace navigation, playback & camera controls
  selectedEntity: SelectedEntity;
  hoveredEntity: SelectedEntity;
  activeNavTab: ExplorerTab;
  ordersFilterPreset: 'ALL' | 'LATE' | 'ACTIVE' | 'PENDING' | 'DELIVERED';
  isolateSelection: boolean;
  followSelectedCourier: boolean;
  isPaused: boolean;
  simSpeedMultiplier: SimSpeedMultiplier;
  cameraFocusRequest: CameraFocusRequest | null;
  layerVisibility: LayerVisibility;
  solverDrawerOpen: boolean;
  chaosPanelOpen: boolean;

  // Actions
  initialize: () => () => void;
  setMode: (mode: SimulationMode) => Promise<void>;
  selectBookmark: (bookmarkId: BookmarkId) => Promise<void>;
  selectEntity: (entity: SelectedEntity) => void;
  setHoveredEntity: (entity: SelectedEntity) => void;
  setActiveNavTab: (tab: ExplorerTab) => void;
  setOrdersFilterPreset: (preset: 'ALL' | 'LATE' | 'ACTIVE' | 'PENDING' | 'DELIVERED') => void;
  setIsolateSelection: (isolate: boolean) => void;
  setFollowSelectedCourier: (follow: boolean) => void;
  togglePaused: () => void;
  setSimSpeedMultiplier: (speed: SimSpeedMultiplier) => void;
  requestCameraFocus: (coords: [number, number][]) => void;
  toggleLayer: (layer: keyof LayerVisibility) => void;
  setSolverDrawerOpen: (open: boolean) => void;
  setChaosPanelOpen: (open: boolean) => void;
  setShowRouteDiff: (show: boolean) => void;
  clearRouteDiff: () => void;
  setBurstRatePerSec: (rate: number) => void;
  triggerBurst: () => Promise<void>;
  setFaultInjection: (upstream: UpstreamName, statusCode: 429 | 503 | null) => Promise<void>;
  setWeatherSurgeIntensity: (intensity: number) => void;
  applyWeatherSurgeNow: () => Promise<void>;
  triggerDynamicReoptimize: (params?: {
    batchSize?: number;
    weatherSeverityScore?: number;
    speedMultiplier?: number;
  }) => Promise<void>;
  applyExtractedRoadGraph: (bookmarkId: BookmarkId, graph: RoadNetworkGraph) => void;
  getInterpolatedCouriers: (nowMs?: number) => CourierSnapshotDto[];
}

// Module-level singleton runtime handles outside Zustand reactivity overhead
let sandboxRuntime: SandboxState = createSandboxState(DEFAULT_BOOKMARK_ID);
const roadGraphCache = new Map<BookmarkId, RoadNetworkGraph>();
let sandboxTickTimer: number | null = null;

function mergeCourierUpdates(
  prevCouriers: CourierSnapshotDto[],
  prevInterp: Record<string, CourierInterpolationState>,
  prevTrails: Record<string, TrailPoint[]>,
  incomingCouriers: CourierSnapshotDto[],
  nowMs: number,
  subpathsByCourierId?: Record<string, [number, number][]>,
  durationMs = INTERP_DURATION_MS,
): {
  couriers: CourierSnapshotDto[];
  courierInterp: Record<string, CourierInterpolationState>;
  courierTrails: Record<string, TrailPoint[]>;
} {
  const existingMap = new Map(prevCouriers.map((c) => [c.courierId, c]));
  const nextInterp: Record<string, CourierInterpolationState> = {};
  const nextTrails: Record<string, TrailPoint[]> = {};

  for (const c of incomingCouriers) {
    const oldInterp = prevInterp[c.courierId];
    const oldCourier = existingMap.get(c.courierId);

    // Compute current visual position so interpolation transitions seamlessly without jumps
    let currentLat = oldCourier?.lat ?? c.lat;
    let currentLon = oldCourier?.lon ?? c.lon;
    let currentHeading = oldCourier?.headingDeg ?? c.headingDeg;
    if (oldInterp) {
      const elapsed = Math.max(0, nowMs - oldInterp.updatedAtMs);
      const t = Math.min(1, elapsed / Math.max(100, oldInterp.durationMs));
      if (oldInterp.subpathCoords && oldInterp.subpathCoords.length >= 2) {
        const poly = precomputePolyline(oldInterp.subpathCoords, oldInterp.headingDeg);
        const sample = samplePolylineAtDistance(poly, poly.totalLengthM * t, oldInterp.headingDeg);
        currentLat = sample.lat;
        currentLon = sample.lon;
        currentHeading = sample.headingDeg;
      } else {
        currentLat = oldInterp.prevLat + (oldInterp.targetLat - oldInterp.prevLat) * t;
        currentLon = oldInterp.prevLon + (oldInterp.targetLon - oldInterp.prevLon) * t;
        currentHeading = interpolateBearingDeg(oldInterp.prevHeadingDeg, oldInterp.headingDeg, t);
      }
    }

    const rawSubpath = subpathsByCourierId?.[c.courierId];
    let subpathCoords: [number, number][] | undefined =
      rawSubpath && rawSubpath.length >= 2 ? rawSubpath : undefined;

    // Teleport guard: if courier jumped >500m with no road subpath (e.g. graph swap/reconnect), snap cleanly
    if (!subpathCoords && haversineMeters(currentLat, currentLon, c.lat, c.lon) > TELEPORT_SNAP_THRESHOLD_M) {
      currentLat = c.lat;
      currentLon = c.lon;
      currentHeading = c.headingDeg;
    }

    nextInterp[c.courierId] = {
      prevLat: currentLat,
      prevLon: currentLon,
      targetLat: c.lat,
      targetLon: c.lon,
      prevHeadingDeg: currentHeading,
      headingDeg: c.headingDeg,
      updatedAtMs: nowMs,
      durationMs,
      subpathCoords,
    };

    const existingTrail = prevTrails[c.courierId] ?? [];
    const lastPt = existingTrail[existingTrail.length - 1];
    const moved =
      !lastPt ||
      Math.abs(lastPt.lat - c.lat) > 0.00001 ||
      Math.abs(lastPt.lon - c.lon) > 0.00001;

    nextTrails[c.courierId] = moved
      ? pushBounded(
          existingTrail,
          { lat: c.lat, lon: c.lon, timestampMs: nowMs, speedMps: c.speedMps },
          MAX_TRAIL_POINTS,
        )
      : existingTrail;
  }

  return {
    couriers: incomingCouriers,
    courierInterp: nextInterp,
    courierTrails: nextTrails,
  };
}

const initialSandboxStep = stepSandboxSimulation(sandboxRuntime);
sandboxRuntime = initialSandboxStep.nextState;

export const useChronosStore = create<ChronosStoreState>((set, get) => {
  const stopTimersAndWs = () => {
    if (sandboxTickTimer !== null) {
      window.clearInterval(sandboxTickTimer);
      sandboxTickTimer = null;
    }
  };

  const queryBookmarkEnvironment = async (bookmarkId: BookmarkId) => {
    const city = BOOKMARK_BY_ID[bookmarkId];
    const [weatherRes, graphRes, netRes] = await Promise.allSettled([
      fetchWeatherGrid(`bm_${bookmarkId}`, city.lat, city.lon),
      fetchRoadGraphSummary(city.lat, city.lon, 0.025),
      fetchRoadGraphNetwork(city.lat, city.lon, 0.032),
    ]);

    if (netRes.status === 'fulfilled') {
      const overpassGraph = buildRoadNetworkFromOverpassDto(bookmarkId, netRes.value);
      if (overpassGraph) {
        get().applyExtractedRoadGraph(bookmarkId, overpassGraph);
      }
    }

    set((prev) => {
      const weatherBanner =
        weatherRes.status === 'fulfilled' ? weatherRes.value : prev.liveWeatherBanner;
      const roadGraph = graphRes.status === 'fulfilled' ? graphRes.value : prev.liveRoadGraph;
      const baseCells = buildInitialCityWeatherCells(bookmarkId);
      const updatedCells = weatherBanner
        ? baseCells.map((cell, idx) => ({
            ...cell,
            precipitation_mm: Number(
              (weatherBanner.precipitation_mm * (0.7 + ((idx % 5) * 0.15))).toFixed(1),
            ),
            wind_speed_kmh: weatherBanner.wind_speed_kmh,
            speed_multiplier: weatherBanner.speed_multiplier,
            is_degraded: weatherBanner.is_degraded,
          }))
        : baseCells;

      return {
        liveWeatherBanner: weatherBanner,
        liveRoadGraph: roadGraph,
        weatherCells: updatedCells,
      };
    });
  };

  const startSandboxLoop = (reason: string | null = null) => {
    stopTimersAndWs();
    const state = get();
    const cachedGraph = roadGraphCache.get(state.activeBookmarkId);
    sandboxRuntime = createSandboxState(
      state.activeBookmarkId,
      Math.min(120, Math.max(24, Math.round(20 + (state.burstRatePerSec / 5000) * 48))),
      state.burstRatePerSec,
      state.weatherSurgeIntensity,
      cachedGraph,
    );

    let lastStepMs = Date.now();
    const runStep = () => {
      const current = get();
      if (current.mode !== 'sandbox') return;
      const nowMs = Date.now();
      if (current.isPaused) {
        lastStepMs = nowMs;
        return;
      }
      const rawDt = Math.max(0.2, Math.min(1.5, (nowMs - lastStepMs) / 1000));
      const dtSec = rawDt * current.simSpeedMultiplier;
      lastStepMs = nowMs;
      const { nextState, snapshot, systemMetrics, subpathsByCourierId } = stepSandboxSimulation(
        sandboxRuntime,
        dtSec,
      );
      sandboxRuntime = nextState;
      const merged = mergeCourierUpdates(
        current.couriers,
        current.courierInterp,
        current.courierTrails,
        snapshot.couriers,
        nowMs,
        subpathsByCourierId,
        INTERP_DURATION_MS,
      );
      const histPoint: MetricsHistoryPoint = {
        timestampMs: nowMs,
        eventsPerSec: systemMetrics.ingestion.events_per_sec,
        queueDepth: systemMetrics.ingestion.queue_depth,
        postgisLatencyMs: Number(systemMetrics.orchestrator.postgisQueryLatencyMs ?? 2.4),
      };

      set((prev) => ({
        hubs: snapshot.hubs,
        zonesGeoJson: snapshot.zonesGeoJson,
        ...merged,
        orders: snapshot.orders,
        routes: snapshot.routes,
        weatherCells: nextState.weatherCells,
        latestSolve: snapshot.latestSolve,
        systemMetrics,
        metricsHistory: pushBounded(prev.metricsHistory, histPoint, MAX_METRICS_HISTORY),
      }));

      // Hydrate any newly auto-dispatched courier routes with exact OSRM /route/v1/driving/ shapes
      void hydrateActiveRoutesWithOsrm();
    };

    set({
      mode: 'sandbox',
      autoFallbackReason: reason,
      wsStatus: 'disconnected',
      activeRoadGraph: sandboxRuntime.roadGraph,
      roadGraphSource: sandboxRuntime.roadGraph.source,
      roadGraphStats: {
        source: sandboxRuntime.roadGraph.source,
        nodeCount: sandboxRuntime.roadGraph.nodes.length,
        edgeCount: sandboxRuntime.roadGraph.edges.length,
        osrmSpeedScale: sandboxRuntime.roadGraph.osrmSpeedScale,
        isCalibrating: false,
      },
      solveHistory: [sandboxRuntime.latestSolve],
      operatorWeights: sandboxRuntime.operatorWeights,
    });
    runStep();
    sandboxTickTimer = window.setInterval(runStep, 1000);
  };

  let isHydratingOsrmRoutes = false;
  let pendingOsrmHydration = false;
  const hydrateActiveRoutesWithOsrm = async () => {
    if (isHydratingOsrmRoutes) {
      pendingOsrmHydration = true;
      return;
    }
    const specs = collectUnhydratedOsrmRouteRequests(sandboxRuntime);
    if (specs.length === 0) return;

    isHydratingOsrmRoutes = true;
    const targetBookmark = sandboxRuntime.bookmarkId;
    try {
      await Promise.all(
        specs.map(async (spec) => {
          const shape = await fetchOsrmMultiStopRoute(spec.waypointsLonLat);
          if (!shape || sandboxRuntime.bookmarkId !== targetBookmark) return;
          sandboxRuntime = applyOsrmRouteShapeToCourier(sandboxRuntime, spec, shape);
          set((prev) => ({
            routes: sandboxRuntime.routes,
            couriers: sandboxRuntime.couriers,
            orders: sandboxRuntime.orders,
            roadGraphSource:
              prev.roadGraphSource === 'fallback-grid' ? 'osrm-calibrated-osm' : prev.roadGraphSource,
            roadGraphStats: {
              ...prev.roadGraphStats,
              source:
                prev.roadGraphStats.source === 'fallback-grid'
                  ? 'osrm-calibrated-osm'
                  : prev.roadGraphStats.source,
            },
          }));
        }),
      );
    } finally {
      isHydratingOsrmRoutes = false;
      if (pendingOsrmHydration) {
        pendingOsrmHydration = false;
        void hydrateActiveRoutesWithOsrm();
      }
    }
  };

  const hydrateCityRoadNetwork = async (bookmarkId: BookmarkId) => {
    set((prev) => ({
      roadGraphStats: {
        ...prev.roadGraphStats,
        isCalibrating: true,
      },
    }));

    // Immediately start hydrating active courier petals with exact OSRM /route/v1/driving/ street polylines
    void hydrateActiveRoutesWithOsrm();

    try {
      const osmGraph = await loadCityOsmRoadNetwork(bookmarkId);
      if (osmGraph) {
        get().applyExtractedRoadGraph(bookmarkId, osmGraph);
        void hydrateActiveRoutesWithOsrm();
        return;
      }
    } catch {
      // Fallback to backend Overpass or MapLibre vector-tile extraction
    }

    await queryBookmarkEnvironment(bookmarkId);
    void hydrateActiveRoutesWithOsrm();
    set((prev) => ({
      roadGraphStats: {
        ...prev.roadGraphStats,
        isCalibrating: false,
      },
    }));
  };

  return {
    mode: 'sandbox',
    autoFallbackReason: null,
    activeBookmarkId: DEFAULT_BOOKMARK_ID,
    wsStatus: 'disconnected',

    hubs: initialSandboxStep.snapshot.hubs,
    zonesGeoJson: initialSandboxStep.snapshot.zonesGeoJson,
    couriers: initialSandboxStep.snapshot.couriers,
    courierInterp: {},
    courierTrails: {},
    orders: initialSandboxStep.snapshot.orders,
    routes: initialSandboxStep.snapshot.routes,
    weatherCells: sandboxRuntime.weatherCells,
    liveWeatherBanner: null,
    liveRoadGraph: null,
    activeRoadGraph: sandboxRuntime.roadGraph,
    roadGraphSource: sandboxRuntime.roadGraph.source,
    roadGraphStats: {
      source: sandboxRuntime.roadGraph.source,
      nodeCount: sandboxRuntime.roadGraph.nodes.length,
      edgeCount: sandboxRuntime.roadGraph.edges.length,
      osrmSpeedScale: sandboxRuntime.roadGraph.osrmSpeedScale,
      isCalibrating: false,
    },

    latestSolve: sandboxRuntime.latestSolve,
    solveHistory: [sandboxRuntime.latestSolve],
    operatorWeights: sandboxRuntime.operatorWeights,
    lastReoptimize: null,
    isReoptimizing: false,
    showRouteDiff: false,

    systemMetrics: {
      ...initialSandboxStep.systemMetrics,
      circuit_breakers: defaultCircuitBreakers(),
    },
    metricsHistory: [],

    burstRatePerSec: 1250,
    burstRunning: false,
    weatherSurgeIntensity: 0.15,
    faultModes: {
      open_meteo: null,
      osrm: null,
      overpass: null,
    },

    selectedEntity: null,
    hoveredEntity: null,
    activeNavTab: 'fleet',
    ordersFilterPreset: 'ALL',
    isolateSelection: true,
    followSelectedCourier: false,
    isPaused: false,
    simSpeedMultiplier: 1,
    cameraFocusRequest: null,
    layerVisibility: {
      zones: false,
      weather: false,
      heatmap: false,
      routes: true,
      routeDiff: true,
      orders: true,
      couriers: true,
      trail: true,
      roadGraph: false,
    },
    solverDrawerOpen: false,
    chaosPanelOpen: false,

    initialize: () => {
      startSandboxLoop(null);
      void hydrateCityRoadNetwork(get().activeBookmarkId);
      return () => {
        stopTimersAndWs();
      };
    },

    setMode: async (_nextMode) => {
      startSandboxLoop(null);
      void hydrateCityRoadNetwork(get().activeBookmarkId);
    },

    selectBookmark: async (bookmarkId) => {
      set({
        activeBookmarkId: bookmarkId,
        selectedEntity: null,
        lastReoptimize: null,
        showRouteDiff: false,
      });

      const cachedGraph = roadGraphCache.get(bookmarkId);
      sandboxRuntime = createSandboxState(
        bookmarkId,
        sandboxRuntime.targetCourierCount,
        get().burstRatePerSec,
        get().weatherSurgeIntensity,
        cachedGraph,
      );
      const step = stepSandboxSimulation(sandboxRuntime, 1.0);
      sandboxRuntime = step.nextState;
      const nowMs = Date.now();
      const merged = mergeCourierUpdates(
        [],
        {},
        {},
        step.snapshot.couriers,
        nowMs,
        step.subpathsByCourierId,
      );
      set({
        hubs: step.snapshot.hubs,
        zonesGeoJson: step.snapshot.zonesGeoJson,
        ...merged,
        orders: step.snapshot.orders,
        routes: step.snapshot.routes,
        weatherCells: sandboxRuntime.weatherCells,
        activeRoadGraph: sandboxRuntime.roadGraph,
        roadGraphSource: sandboxRuntime.roadGraph.source,
        roadGraphStats: {
          source: sandboxRuntime.roadGraph.source,
          nodeCount: sandboxRuntime.roadGraph.nodes.length,
          edgeCount: sandboxRuntime.roadGraph.edges.length,
          osrmSpeedScale: sandboxRuntime.roadGraph.osrmSpeedScale,
          isCalibrating: !cachedGraph,
        },
        followSelectedCourier: false,
        latestSolve: step.snapshot.latestSolve,
        solveHistory: step.snapshot.latestSolve ? [step.snapshot.latestSolve] : [],
        systemMetrics: step.systemMetrics,
      });

      if (!cachedGraph || cachedGraph.source !== 'osrm-calibrated-osm') {
        void hydrateCityRoadNetwork(bookmarkId);
      }
    },

    selectEntity: (entity) =>
      set((prev) => ({
        selectedEntity: entity,
        followSelectedCourier:
          entity === null || entity.type === 'hub' ? false : prev.followSelectedCourier,
      })),

    setHoveredEntity: (entity) => set({ hoveredEntity: entity }),
    setActiveNavTab: (tab) => set({ activeNavTab: tab }),
    setOrdersFilterPreset: (preset) => set({ ordersFilterPreset: preset }),
    setIsolateSelection: (isolate) => set({ isolateSelection: isolate }),
    setFollowSelectedCourier: (follow) => set({ followSelectedCourier: follow }),
    togglePaused: () => set((prev) => ({ isPaused: !prev.isPaused })),
    setSimSpeedMultiplier: (speed) => set({ simSpeedMultiplier: speed }),
    requestCameraFocus: (coords) => {
      if (coords.length === 0) return;
      set((prev) => ({
        cameraFocusRequest: {
          coords,
          nonce: (prev.cameraFocusRequest?.nonce ?? 0) + 1,
        },
      }));
    },

    toggleLayer: (layer) =>
      set((prev) => ({
        layerVisibility: {
          ...prev.layerVisibility,
          [layer]: !prev.layerVisibility[layer],
        },
      })),

    setSolverDrawerOpen: (open) => set({ solverDrawerOpen: open }),
    setChaosPanelOpen: (open) => set({ chaosPanelOpen: open }),
    setShowRouteDiff: (show) => set({ showRouteDiff: show }),
    clearRouteDiff: () => set({ lastReoptimize: null, showRouteDiff: false }),

    setBurstRatePerSec: (rate) => {
      const clamped = Math.min(5000, Math.max(500, Math.round(rate)));
      sandboxRuntime.burstRatePerSec = clamped;
      set({ burstRatePerSec: clamped });
    },

    triggerBurst: async () => {
      const { mode, burstRatePerSec, activeBookmarkId } = get();
      set({ burstRunning: true });
      try {
        if (mode === 'live') {
          await startGpsBurst({
            ratePerSec: burstRatePerSec,
            durationSec: 6,
            bookmarkId: activeBookmarkId,
          });
        } else {
          sandboxRuntime.burstRatePerSec = burstRatePerSec;
          const step = stepSandboxSimulation(sandboxRuntime);
          sandboxRuntime = step.nextState;
          const merged = mergeCourierUpdates(
            get().couriers,
            get().courierInterp,
            get().courierTrails,
            step.snapshot.couriers,
            Date.now(),
          );
          set({
            ...merged,
            systemMetrics: step.systemMetrics,
          });
        }
      } catch {
        // Keep UI responsive even if burst call times out
      } finally {
        window.setTimeout(() => set({ burstRunning: false }), 1200);
      }
    },

    setFaultInjection: async (upstream, statusCode) => {
      set((prev) => ({
        faultModes: {
          ...prev.faultModes,
          [upstream]: statusCode,
        },
      }));

      if (get().mode === 'live') {
        try {
          const res = await toggleFaultInjection({
            upstream,
            statusCode,
            probeNow: true,
          });
          set((prev) => ({
            systemMetrics: {
              ...prev.systemMetrics,
              circuit_breakers: res.circuit_breakers
                ? res.circuit_breakers
                : res.breaker
                  ? { ...prev.systemMetrics.circuit_breakers, [upstream]: res.breaker }
                  : prev.systemMetrics.circuit_breakers,
            },
          }));
        } catch {
          // Ignore transient network failure
        }
      } else {
        sandboxRuntime = applySandboxFaultInjection(sandboxRuntime, upstream, statusCode);
        set((prev) => ({
          systemMetrics: {
            ...prev.systemMetrics,
            circuit_breakers: sandboxRuntime.circuitBreakers,
          },
        }));
      }
    },

    setWeatherSurgeIntensity: (intensity) => {
      const clamped = Math.max(0, Math.min(1, intensity));
      sandboxRuntime.weatherSurgeIntensity = clamped;
      set({ weatherSurgeIntensity: clamped });
    },

    applyWeatherSurgeNow: async () => {
      const { mode, activeBookmarkId, weatherSurgeIntensity } = get();
      const precipMm = Number((weatherSurgeIntensity * 48).toFixed(1));
      const windKmh = Number((12 + weatherSurgeIntensity * 58).toFixed(1));
      const speedMultiplier = Number(
        Math.max(0.38, Math.min(1.0, 1.0 - weatherSurgeIntensity * 0.58)).toFixed(2),
      );

      if (mode === 'live') {
        try {
          const res = await applyWeatherSurge({
            bookmarkId: activeBookmarkId,
            precipitationMm: precipMm,
            windSpeedKmh: windKmh,
            speedMultiplier,
            triggerReoptimize: true,
          });
          const reopt = res.solver_event ?? res.reoptimize ?? null;
          set((prev) => ({
            weatherCells: res.cells && res.cells.length > 0 ? res.cells : prev.weatherCells,
            lastReoptimize: reopt ?? prev.lastReoptimize,
            routes:
              reopt && reopt.afterRoutes.length > 0 ? reopt.afterRoutes : prev.routes,
            showRouteDiff: reopt ? true : prev.showRouteDiff,
            latestSolve: reopt?.solveTelemetry ?? prev.latestSolve,
            solveHistory: reopt?.solveTelemetry
              ? pushBounded(prev.solveHistory, reopt.solveTelemetry, MAX_SOLVE_HISTORY)
              : prev.solveHistory,
          }));
        } catch {
          // Non-fatal fallback
        }
      } else {
        sandboxRuntime.weatherSurgeIntensity = weatherSurgeIntensity;
        const step = stepSandboxSimulation(sandboxRuntime, 1.0);
        sandboxRuntime = step.nextState;
        const reopt = triggerSandboxReoptimize(sandboxRuntime, {
          weatherSeverityScore: weatherSurgeIntensity,
          speedMultiplier,
        });
        sandboxRuntime = reopt.nextState;
        const merged = mergeCourierUpdates(
          get().couriers,
          get().courierInterp,
          get().courierTrails,
          sandboxRuntime.couriers,
          Date.now(),
        );
        set((prev) => ({
          weatherCells: sandboxRuntime.weatherCells,
          layerVisibility: { ...prev.layerVisibility, weather: true },
          routes: reopt.response.afterRoutes,
          orders: sandboxRuntime.orders,
          ...merged,
          lastReoptimize: reopt.response,
          showRouteDiff: true,
          latestSolve: reopt.response.solveTelemetry,
          solveHistory: pushBounded(
            prev.solveHistory,
            reopt.response.solveTelemetry,
            MAX_SOLVE_HISTORY,
          ),
          operatorWeights: reopt.operatorWeights,
        }));
      }
    },

    triggerDynamicReoptimize: async (params) => {
      set({ isReoptimizing: true });
      try {
        if (get().mode === 'live') {
          const res = await triggerReoptimize(params);
          set((prev) => ({
            lastReoptimize: res,
            routes: res.afterRoutes.length > 0 ? res.afterRoutes : prev.routes,
            showRouteDiff: true,
            latestSolve: res.solveTelemetry,
            solveHistory: pushBounded(prev.solveHistory, res.solveTelemetry, MAX_SOLVE_HISTORY),
            operatorWeights: {
              destroy: {
                shaw: Number((0.36 + Math.random() * 0.14).toFixed(2)),
                worst: Number((0.30 + Math.random() * 0.12).toFixed(2)),
                random: 0.22,
              },
              repair: {
                regret2: 0.65,
                greedy: 0.35,
              },
            },
          }));
        } else {
          // Small realistic solver animation delay (~180ms)
          await new Promise((resolve) => window.setTimeout(resolve, 180));
          const reopt = triggerSandboxReoptimize(sandboxRuntime, params);
          sandboxRuntime = reopt.nextState;
          const merged = mergeCourierUpdates(
            get().couriers,
            get().courierInterp,
            get().courierTrails,
            sandboxRuntime.couriers,
            Date.now(),
          );
          set((prev) => ({
            ...merged,
            orders: sandboxRuntime.orders,
            routes: reopt.response.afterRoutes,
            lastReoptimize: reopt.response,
            showRouteDiff: true,
            latestSolve: reopt.response.solveTelemetry,
            solveHistory: pushBounded(
              prev.solveHistory,
              reopt.response.solveTelemetry,
              MAX_SOLVE_HISTORY,
            ),
            operatorWeights: reopt.operatorWeights,
          }));
          void hydrateActiveRoutesWithOsrm();
        }
      } finally {
        set({ isReoptimizing: false });
      }
    },

    applyExtractedRoadGraph: (bookmarkId, graph) => {
      const existing = roadGraphCache.get(bookmarkId);
      const priority: Record<RoadNetworkSource, number> = {
        'fallback-grid': 0,
        'vector-tiles': 1,
        overpass: 2,
        'osrm-calibrated-osm': 3,
      };
      if (
        existing &&
        priority[existing.source] > priority[graph.source]
      ) {
        return;
      }
      if (
        existing &&
        existing.source === graph.source &&
        existing.nodes.length >= graph.nodes.length * 0.95
      ) {
        return;
      }

      roadGraphCache.set(bookmarkId, graph);
      const state = get();
      if (state.activeBookmarkId !== bookmarkId) {
        return;
      }

      if (graph.source === 'vector-tiles' || graph.source === 'overpass') {
        void calibrateGraphWithOsrmTable(graph).then((scale) => {
          if (get().activeBookmarkId === bookmarkId) {
            set((prev) => ({
              roadGraphSource: graph.source,
              roadGraphStats: {
                ...prev.roadGraphStats,
                source: graph.source,
                osrmSpeedScale: scale,
                isCalibrating: false,
              },
            }));
          }
        });
      }

      if (sandboxRuntime.bookmarkId === bookmarkId) {
        sandboxRuntime = upgradeSandboxRoadGraph(sandboxRuntime, graph);
        const nowMs = Date.now();
        const merged = mergeCourierUpdates(
          state.couriers,
          state.courierInterp,
          {},
          sandboxRuntime.couriers,
          nowMs,
        );
        set({
          hubs: sandboxRuntime.hubs,
          zonesGeoJson: sandboxRuntime.zonesGeoJson,
          ...merged,
          orders: sandboxRuntime.orders,
          routes: sandboxRuntime.routes,
          activeRoadGraph: graph,
          roadGraphSource: graph.source,
          roadGraphStats: {
            source: graph.source,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            osrmSpeedScale: graph.osrmSpeedScale,
            isCalibrating: false,
          },
        });
        void hydrateActiveRoutesWithOsrm();
      } else {
        set({
          activeRoadGraph: graph,
          roadGraphSource: graph.source,
          roadGraphStats: {
            source: graph.source,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            osrmSpeedScale: graph.osrmSpeedScale,
            isCalibrating: false,
          },
        });
      }
    },

    getInterpolatedCouriers: (nowMs = Date.now()) => {
      const { couriers, courierInterp } = get();
      return couriers.map((c) => {
        const interp = courierInterp[c.courierId];
        if (!interp) return c;
        const elapsed = Math.max(0, nowMs - interp.updatedAtMs);
        const t = Math.min(1, elapsed / Math.max(100, interp.durationMs));
        if (interp.subpathCoords && interp.subpathCoords.length >= 2) {
          const poly = precomputePolyline(interp.subpathCoords, interp.headingDeg);
          const sample = samplePolylineAtDistance(poly, poly.totalLengthM * t, interp.headingDeg);
          return {
            ...c,
            lat: sample.lat,
            lon: sample.lon,
            headingDeg: Math.round(sample.headingDeg) % 360,
          };
        }
        return {
          ...c,
          lat: interp.prevLat + (interp.targetLat - interp.prevLat) * t,
          lon: interp.prevLon + (interp.targetLon - interp.prevLon) * t,
          headingDeg: Math.round(interpolateBearingDeg(interp.prevHeadingDeg, interp.headingDeg, t)) % 360,
        };
      });
    },
  };
});
