import { BOOKMARK_BY_ID } from '../constants/bookmarks.ts';
import type {
  AlnsOperatorWeights,
  BookmarkId,
  CircuitBreakerStatus,
  CourierSnapshotDto,
  CourierStatus,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  HubSnapshotDto,
  OrderSnapshotDto,
  OrderStatus,
  ReoptimizeResponse,
  RoutePetalDto,
  RouteWaypointDto,
  SnapshotResponse,
  SolveTelemetryDto,
  SystemMetricsResponse,
  UpstreamName,
  WeatherGridCell,
} from '../types/chronos';
import {
  computeCompassBearingDeg,
  deduplicateCoords,
  encodePolyline5,
  extractSubpath,
  haversineMeters,
  metersToLatDeg,
  metersToLonDeg,
  precomputePolyline,
  samplePolylineAtDistance,
  sliceRemainingPolyline,
  type PrecomputedPolyline,
} from './polylineKinematics.ts';
import {
  createFallbackUrbanRoadGraph,
  type RoadNetworkGraph,
} from './roadNetwork.ts';
import {
  solveAlnsCvrptw,
  type AlnsStopInput,
  type AlnsVehicleInput,
} from './alnsSolver.ts';
import type { OsrmMultiStopRouteShape } from './osmRoadLoader.ts';

/** Deterministic PRNG (Mulberry32) */
function createSeededRng(seedInput: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedInput.length; i += 1) {
    h ^= seedInput.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeUuid(rng: () => number, prefix: string, idx: number): string {
  const hex = (n: number, len: number) =>
    Math.floor(n)
      .toString(16)
      .padStart(len, '0')
      .slice(-len);
  const p = prefix.slice(0, 4).padEnd(4, '0');
  const r1 = hex(rng() * 0xffff, 4);
  const r2 = hex(rng() * 0xffff, 4);
  const r3 = hex(idx, 12);
  return `${p}0000-${r1}-4${r2.slice(1)}-8000-${r3}`;
}

function buildZonePolygon(
  hub: HubSnapshotDto,
  radiusMeters = 4500,
  segments = 36,
): GeoJsonFeature {
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    const dLat = metersToLatDeg(radiusMeters * Math.sin(theta));
    const dLon = metersToLonDeg(radiusMeters * Math.cos(theta), hub.lat);
    ring.push([Number((hub.lon + dLon).toFixed(6)), Number((hub.lat + dLat).toFixed(6))]);
  }
  return {
    type: 'Feature',
    id: hub.hubId,
    properties: {
      hubId: hub.hubId,
      name: hub.name,
      radiusMeters,
      capacityOrdersPerHour: hub.capacityOrdersPerHour,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}

function computeSpeedMultiplier(precipMm: number, windKmh: number): number {
  const rainPenalty = 0.012 * Math.max(0, precipMm);
  const windPenalty = 0.003 * Math.max(0, windKmh - 15);
  return Math.round(Math.max(0.35, Math.min(1.0, 1.0 - rainPenalty - windPenalty)) * 1000) / 1000;
}

/** Sample local spatial weather speed multiplier from the nearest weather grid cell. */
export function sampleLocalWeatherMultiplier(
  lat: number,
  lon: number,
  weatherCells: readonly WeatherGridCell[],
): number {
  if (weatherCells.length === 0) return 1.0;
  let bestDistSq = Number.POSITIVE_INFINITY;
  let bestMult = 1.0;
  for (let i = 0; i < weatherCells.length; i += 1) {
    const cell = weatherCells[i];
    const dLat = cell.lat - lat;
    const dLon = cell.lon - lon;
    const dSq = dLat * dLat + dLon * dLon;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestMult = cell.speed_multiplier;
    }
  }
  return Math.max(0.35, Math.min(1.0, bestMult));
}

export type CourierLegTargetType = 'PICKUP' | 'DROPOFF' | 'RETURN_HUB' | 'IDLE';

export interface QueuedRoadLeg {
  targetType: CourierLegTargetType;
  targetOrderId: string | null;
  targetNodeId: number;
  legPoly: PrecomputedPolyline;
  baseRoadSpeedMps: number;
}

export interface CourierRoadKinematics {
  courierId: string;
  homeHubId: string;
  targetType: CourierLegTargetType;
  targetOrderId: string | null;
  targetNodeId: number;
  legPoly: PrecomputedPolyline;
  distanceAlongLegM: number;
  baseRoadSpeedMps: number;
  paceFactor: number;
  dwellRemainingSec: number;
  batteryFloat: number;
  /** Remaining planned leg coordinates after the current leg (stops -> return hub). */
  tailCoords: [number, number][];
  /** Precomputed upcoming legs so stop transitions preserve exact OSRM street geometries. */
  upcomingLegs?: QueuedRoadLeg[];
  /** True when legPoly & upcomingLegs have been hydrated from OSRM /route/v1/driving/ street geometry. */
  isOsrmHydrated?: boolean;
}

export interface SandboxState {
  bookmarkId: BookmarkId;
  roadGraph: RoadNetworkGraph;
  hubs: HubSnapshotDto[];
  hubNodeIds: Record<string, number>;
  zonesGeoJson: GeoJsonFeatureCollection;
  couriers: CourierSnapshotDto[];
  orders: OrderSnapshotDto[];
  routes: RoutePetalDto[];
  kinematicsByCourierId: Record<string, CourierRoadKinematics>;
  weatherCells: WeatherGridCell[];
  circuitBreakers: Record<UpstreamName, CircuitBreakerStatus>;
  operatorWeights: AlnsOperatorWeights;
  latestSolve: SolveTelemetryDto;
  burstRatePerSec: number;
  lastBurstRatePerSec: number;
  weatherSurgeIntensity: number;
  tickCount: number;
  targetCourierCount: number;
  nextOrderSeq: number;
  nextCourierSeq: number;
  completedDeliveriesCount: number;
}

const COURIER_CALLSIGNS = [
  'Vanguard',
  'Apex',
  'Pulse',
  'Meridian',
  'Vector',
  'Strider',
  'Falcon',
  'Relay',
  'Nomad',
  'Kestrel',
];

function defaultBreakers(): Record<UpstreamName, CircuitBreakerStatus> {
  return {
    open_meteo: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0.004,
      total_calls: 248,
      total_failures: 1,
      total_short_circuited: 0,
      injected_status: null,
    },
    osrm: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0.008,
      total_calls: 612,
      total_failures: 5,
      total_short_circuited: 0,
      injected_status: null,
    },
    overpass: {
      state: 'CLOSED',
      failure_count: 0,
      error_rate: 0.0,
      total_calls: 64,
      total_failures: 0,
      total_short_circuited: 0,
      injected_status: null,
    },
  };
}

function buildWeatherGrid(
  bookmarkId: BookmarkId,
  surgeIntensity: number,
  tickOffset: number,
  isDegraded: boolean,
): WeatherGridCell[] {
  const city = BOOKMARK_BY_ID[bookmarkId];
  const cells: WeatherGridCell[] = [];
  const gridDim = 6;
  const stepLat = 0.018;
  const stepLon = 0.024;
  const stormCenterLat = city.lat + Math.sin(tickOffset * 0.04) * 0.018;
  const stormCenterLon = city.lon + Math.cos(tickOffset * 0.03) * 0.025;

  for (let r = 0; r < gridDim; r += 1) {
    for (let c = 0; c < gridDim; c += 1) {
      const lat = city.lat + (r - (gridDim - 1) / 2) * stepLat;
      const lon = city.lon + (c - (gridDim - 1) / 2) * stepLon;
      const distKm = haversineMeters(lat, lon, stormCenterLat, stormCenterLon) / 1000;
      const coreFactor = Math.exp(-(distKm * distKm) / 18);
      const basePrecip = 0.4 + coreFactor * 3.2;
      const precip =
        Math.round((basePrecip + surgeIntensity * (12 + coreFactor * 36)) * 10) / 10;
      const wind =
        Math.round((11 + coreFactor * 9 + surgeIntensity * (22 + coreFactor * 34)) * 10) / 10;
      cells.push({
        geohash: `${bookmarkId.slice(0, 2)}${r}${c}`,
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        precipitation_mm: precip,
        wind_speed_kmh: wind,
        speed_multiplier: computeSpeedMultiplier(precip, wind),
        is_degraded: isDegraded,
      });
    }
  }
  return cells;
}

/** Scale real service durations (90-180s) to observable simulation dwell ticks (3-8s). */
function computeSimDwellSec(serviceDurationSeconds: number): number {
  return Math.min(8, Math.max(3, Math.round(serviceDurationSeconds / 25)));
}

/** Route between two WGS84 points via the road graph, prepending exact start point if offset. */
function routeCoordsBetween(
  graph: RoadNetworkGraph,
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  weatherPenaltyFn?: (lat: number, lon: number) => number,
): { coords: [number, number][]; distanceM: number; durationSec: number; avgSpeedMps: number; goalNodeId: number } {
  const startNode = graph.findNearestNode(fromLat, fromLon);
  const goalNode = graph.findNearestNode(toLat, toLon);
  if (startNode < 0 || goalNode < 0) {
    const d = Math.max(10, haversineMeters(fromLat, fromLon, toLat, toLon));
    return {
      coords: [
        [Number(fromLon.toFixed(6)), Number(fromLat.toFixed(6))],
        [Number(toLon.toFixed(6)), Number(toLat.toFixed(6))],
      ],
      distanceM: d,
      durationSec: d / 10,
      avgSpeedMps: 10,
      goalNodeId: goalNode,
    };
  }

  const res = graph.findRoadPath(startNode, goalNode, weatherPenaltyFn);
  if (!res.reachable || res.pathCoords.length === 0) {
    const sNode = graph.nodes[startNode];
    const gNode = graph.nodes[goalNode];
    const d = Math.max(10, haversineMeters(sNode.lat, sNode.lon, gNode.lat, gNode.lon));
    return {
      coords: [
        [sNode.lon, sNode.lat],
        [gNode.lon, gNode.lat],
      ],
      distanceM: d,
      durationSec: d / 10,
      avgSpeedMps: 10,
      goalNodeId: goalNode,
    };
  }

  // Only prepend raw start if courier is already close to road (<25m); otherwise snap cleanly to graph
  const firstPt = res.pathCoords[0];
  const snapGap = haversineMeters(fromLat, fromLon, firstPt[1], firstPt[0]);
  const coords: [number, number][] =
    snapGap > 1 && snapGap <= 30
      ? [[Number(fromLon.toFixed(6)), Number(fromLat.toFixed(6))], ...res.pathCoords]
      : res.pathCoords;

  return {
    coords: deduplicateCoords(coords),
    distanceM: res.totalDistanceM,
    durationSec: res.totalDurationSec,
    avgSpeedMps: Math.max(5.5, Math.min(20, res.averageSpeedMps)),
    goalNodeId: goalNode,
  };
}

/** Build full road kinematics & RoutePetalDto for a single courier given its current stop queue. */
function planCourierKinematicsAndRoute(
  courier: CourierSnapshotDto,
  hub: HubSnapshotDto,
  graph: RoadNetworkGraph,
  orderMap: ReadonlyMap<string, OrderSnapshotDto>,
  weatherCells: readonly WeatherGridCell[],
  nowUnix: number,
  existingKin?: CourierRoadKinematics,
  weatherPenaltyFn?: (lat: number, lon: number) => number,
): { kinematics: CourierRoadKinematics; route: RoutePetalDto | null } {
  const paceFactor = existingKin?.paceFactor ?? 0.92 + (parseInt(courier.courierId.slice(-2), 16) % 16) * 0.012;
  const batteryFloat = existingKin?.batteryFloat ?? courier.batteryPct;

  // Filter valid non-terminal orders on this courier's route
  const activeOrders: OrderSnapshotDto[] = [];
  for (const oid of courier.activeRouteOrderIds) {
    const ord = orderMap.get(oid);
    if (ord && ord.status !== 'DELIVERED' && ord.status !== 'FAILED' && ord.status !== 'CANCELLED') {
      activeOrders.push(ord);
    }
  }

  if (courier.status === 'OFFLINE' || (courier.status === 'IDLE' && activeOrders.length === 0)) {
    const selfNode = graph.findNearestNode(courier.lat, courier.lon);
    return {
      kinematics: {
        courierId: courier.courierId,
        homeHubId: hub.hubId,
        targetType: 'IDLE',
        targetOrderId: null,
        targetNodeId: selfNode,
        legPoly: precomputePolyline([[courier.lon, courier.lat]], courier.headingDeg),
        distanceAlongLegM: 0,
        baseRoadSpeedMps: 0,
        paceFactor,
        dwellRemainingSec: 0,
        batteryFloat,
        tailCoords: [],
      },
      route: null,
    };
  }

  // If active courier has no remaining orders, route back to its home hub along real roads
  if (activeOrders.length === 0) {
    const returnLeg = routeCoordsBetween(
      graph,
      courier.lat,
      courier.lon,
      hub.lat,
      hub.lon,
      weatherPenaltyFn,
    );
    const legPoly = precomputePolyline(returnLeg.coords, courier.headingDeg);
    return {
      kinematics: {
        courierId: courier.courierId,
        homeHubId: hub.hubId,
        targetType: 'RETURN_HUB',
        targetOrderId: null,
        targetNodeId: returnLeg.goalNodeId,
        legPoly,
        distanceAlongLegM: 0,
        baseRoadSpeedMps: returnLeg.avgSpeedMps,
        paceFactor,
        dwellRemainingSec: 0,
        batteryFloat,
        tailCoords: [],
      },
      route: null,
    };
  }

  // Determine whether first leg goes to pickup hub (for ASSIGNED / EN_ROUTE_PICKUP) or directly to dropoff[0]
  const needsPickup =
    courier.status === 'EN_ROUTE_PICKUP' ||
    (courier.status === 'ASSIGNED' && activeOrders[0].status === 'ASSIGNED');

  const firstTargetLat = needsPickup ? activeOrders[0].pickupLat : activeOrders[0].dropoffLat;
  const firstTargetLon = needsPickup ? activeOrders[0].pickupLon : activeOrders[0].dropoffLon;
  const firstLeg = routeCoordsBetween(
    graph,
    courier.lat,
    courier.lon,
    firstTargetLat,
    firstTargetLon,
    weatherPenaltyFn,
  );
  const legPoly = precomputePolyline(firstLeg.coords, courier.headingDeg);

  // Build subsequent legs along real roads: (optional pickup -> dropoff_0) -> dropoff_1 -> ... -> hub
  const tailCoords: [number, number][] = [];
  const upcomingLegs: QueuedRoadLeg[] = [];
  const waypoints: RouteWaypointDto[] = [];
  let totalDistance = Math.round(legPoly.totalLengthM);
  let cursorUnix = nowUnix;
  let loadKg = 0;

  const firstLocalMult = sampleLocalWeatherMultiplier(courier.lat, courier.lon, weatherCells);
  const firstEffSpeed = Math.max(3.5, firstLeg.avgSpeedMps * firstLocalMult * paceFactor);
  cursorUnix += Math.round(legPoly.totalLengthM / firstEffSpeed);

  let prevLat = firstTargetLat;
  let prevLon = firstTargetLon;

  if (needsPickup) {
    // Dwell at hub for pickup load, then route hub -> dropoff_0
    cursorUnix += 30;
  }

  for (let i = 0; i < activeOrders.length; i += 1) {
    const ord = activeOrders[i];
    if (i > 0 || needsPickup) {
      const subLeg = routeCoordsBetween(
        graph,
        prevLat,
        prevLon,
        ord.dropoffLat,
        ord.dropoffLon,
        weatherPenaltyFn,
      );
      totalDistance += Math.round(subLeg.distanceM);
      const localMult = sampleLocalWeatherMultiplier(prevLat, prevLon, weatherCells);
      const effSpeed = Math.max(3.5, subLeg.avgSpeedMps * localMult * paceFactor);
      cursorUnix += Math.round(subLeg.distanceM / effSpeed);
      for (let k = tailCoords.length === 0 ? 0 : 1; k < subLeg.coords.length; k += 1) {
        tailCoords.push(subLeg.coords[k]);
      }
      upcomingLegs.push({
        targetType: 'DROPOFF',
        targetOrderId: ord.orderId,
        targetNodeId: subLeg.goalNodeId,
        legPoly: precomputePolyline(subLeg.coords),
        baseRoadSpeedMps: subLeg.avgSpeedMps,
      });
    }

    const winStartUnix = Math.floor(new Date(ord.windowStart).getTime() / 1000);
    const winEndUnix = Math.floor(new Date(ord.windowEnd).getTime() / 1000);
    const slack = winEndUnix - cursorUnix;
    loadKg += ord.weightKg;

    waypoints.push({
      orderId: ord.orderId,
      lat: ord.dropoffLat,
      lon: ord.dropoffLon,
      arrivalUnix: cursorUnix,
      departureUnix: cursorUnix + ord.serviceDurationSeconds,
      slackSeconds: slack,
      accumulatedLoadKg: Math.round(loadKg * 10) / 10,
      weightKg: ord.weightKg,
      windowStartUnix: winStartUnix,
      windowEndUnix: winEndUnix,
    });

    cursorUnix += ord.serviceDurationSeconds;
    prevLat = ord.dropoffLat;
    prevLon = ord.dropoffLon;
  }

  // Return leg back to depot hub along real roads
  const retLeg = routeCoordsBetween(graph, prevLat, prevLon, hub.lat, hub.lon, weatherPenaltyFn);
  totalDistance += Math.round(retLeg.distanceM);
  for (let k = tailCoords.length === 0 ? 0 : 1; k < retLeg.coords.length; k += 1) {
    tailCoords.push(retLeg.coords[k]);
  }
  upcomingLegs.push({
    targetType: 'RETURN_HUB',
    targetOrderId: null,
    targetNodeId: retLeg.goalNodeId,
    legPoly: precomputePolyline(retLeg.coords),
    baseRoadSpeedMps: retLeg.avgSpeedMps,
  });

  const fullPathCoords = deduplicateCoords([...legPoly.coords, ...tailCoords]);
  const route: RoutePetalDto = {
    courierId: courier.courierId,
    hubId: hub.hubId,
    courierName: courier.name,
    totalDistanceMeters: totalDistance,
    totalDurationSeconds: Math.max(60, cursorUnix - nowUnix),
    capacityUsedKg: Math.round(loadKg * 10) / 10,
    maxCapacityKg: courier.maxCapacityKg,
    encodedPolyline: encodePolyline5(fullPathCoords),
    waypoints,
    pathCoords: fullPathCoords,
  };

  return {
    kinematics: {
      courierId: courier.courierId,
      homeHubId: hub.hubId,
      targetType: needsPickup ? 'PICKUP' : 'DROPOFF',
      targetOrderId: activeOrders[0].orderId,
      targetNodeId: firstLeg.goalNodeId,
      legPoly,
      distanceAlongLegM: 0,
      baseRoadSpeedMps: firstLeg.avgSpeedMps,
      paceFactor,
      dwellRemainingSec: 0,
      batteryFloat,
      tailCoords: deduplicateCoords(tailCoords),
      upcomingLegs,
      isOsrmHydrated: false,
    },
    route,
  };
}

/** Pick a deterministic road node near `hub` inside `[minM, maxM]`. */
function pickRoadNodeNearHub(
  graph: RoadNetworkGraph,
  hub: HubSnapshotDto,
  rng: () => number,
  minM: number,
  maxM: number,
  candidateCache: Map<string, number[]>,
): number {
  const key = `${hub.hubId}:${minM}:${maxM}`;
  let candidates = candidateCache.get(key);
  if (!candidates) {
    candidates = graph.collectNodesInAnnulus(hub.lat, hub.lon, minM, maxM);
    if (candidates.length === 0) {
      candidates = graph.nodes.map((n) => n.id);
    }
    candidateCache.set(key, candidates);
  }
  return candidates[Math.floor(rng() * candidates.length)] ?? 0;
}

/** Update live RoutePetalDto `pathCoords` and slack from a courier's current road kinematics. */
function syncRoutePetalWithKinematics(
  prevRoute: RoutePetalDto | undefined,
  courier: CourierSnapshotDto,
  kin: CourierRoadKinematics,
  orderMap: ReadonlyMap<string, OrderSnapshotDto>,
  weatherCells: readonly WeatherGridCell[],
  nowUnix: number,
): RoutePetalDto | null {
  if (courier.activeRouteOrderIds.length === 0) return null;

  const remainingLeg = sliceRemainingPolyline(kin.legPoly, kin.distanceAlongLegM);
  const pathCoords = deduplicateCoords([...remainingLeg, ...kin.tailCoords]);
  const remainingLegM = Math.max(0, kin.legPoly.totalLengthM - kin.distanceAlongLegM);

  const localMult = sampleLocalWeatherMultiplier(courier.lat, courier.lon, weatherCells);
  const effSpeed = Math.max(3.5, Math.max(6.5, kin.baseRoadSpeedMps) * localMult * kin.paceFactor);

  const waypoints: RouteWaypointDto[] = [];
  let cursorUnix = nowUnix + Math.round(kin.dwellRemainingSec + remainingLegM / effSpeed);
  let loadKg = 0;
  let totalDistance = Math.round(remainingLegM);
  let prevLat = courier.lat;
  let prevLon = courier.lon;

  for (let i = 0; i < courier.activeRouteOrderIds.length; i += 1) {
    const oid = courier.activeRouteOrderIds[i];
    const ord = orderMap.get(oid);
    if (!ord) continue;
    if (i > 0) {
      const approxRoadM = Math.round(haversineMeters(prevLat, prevLon, ord.dropoffLat, ord.dropoffLon) * 1.25);
      totalDistance += approxRoadM;
      cursorUnix += Math.round(approxRoadM / effSpeed);
    }
    const winStartUnix = Math.floor(new Date(ord.windowStart).getTime() / 1000);
    const winEndUnix = Math.floor(new Date(ord.windowEnd).getTime() / 1000);
    loadKg += ord.weightKg;
    waypoints.push({
      orderId: ord.orderId,
      lat: ord.dropoffLat,
      lon: ord.dropoffLon,
      arrivalUnix: cursorUnix,
      departureUnix: cursorUnix + ord.serviceDurationSeconds,
      slackSeconds: winEndUnix - cursorUnix,
      accumulatedLoadKg: Math.round(loadKg * 10) / 10,
      weightKg: ord.weightKg,
      windowStartUnix: winStartUnix,
      windowEndUnix: winEndUnix,
    });
    cursorUnix += ord.serviceDurationSeconds;
    prevLat = ord.dropoffLat;
    prevLon = ord.dropoffLon;
  }

  return {
    courierId: courier.courierId,
    hubId: prevRoute?.hubId ?? kin.homeHubId,
    courierName: courier.name,
    totalDistanceMeters: Math.max(totalDistance, Math.round(remainingLegM)),
    totalDurationSeconds: Math.max(30, cursorUnix - nowUnix),
    capacityUsedKg: Math.round(loadKg * 10) / 10,
    maxCapacityKg: courier.maxCapacityKg,
    encodedPolyline: prevRoute?.encodedPolyline ?? '',
    waypoints,
    pathCoords,
  };
}

export function createSandboxState(
  bookmarkId: BookmarkId,
  courierCount = 32,
  burstRatePerSec = 1250,
  weatherSurgeIntensity = 0.15,
  providedRoadGraph?: RoadNetworkGraph,
): SandboxState {
  const city = BOOKMARK_BY_ID[bookmarkId];
  const roadGraph = providedRoadGraph ?? createFallbackUrbanRoadGraph(bookmarkId);
  const rng = createSeededRng(`chronos-${bookmarkId}-v3`);
  const nowMs = Date.now();
  const nowUnix = Math.floor(nowMs / 1000);

  // Snap curated land hub coordinates directly onto the road graph
  const hubNodeIds: Record<string, number> = {};
  const hubs: HubSnapshotDto[] = city.hubCoords.map((spec, idx) => {
    const hubId = makeUuid(rng, '1000', idx + 1);
    const nodeId = roadGraph.findNearestNode(spec.lat, spec.lon);
    const snapped = nodeId >= 0 ? roadGraph.nodes[nodeId] : { lat: spec.lat, lon: spec.lon };
    hubNodeIds[hubId] = nodeId;
    return {
      hubId,
      name: spec.name,
      lat: Number(snapped.lat.toFixed(6)),
      lon: Number(snapped.lon.toFixed(6)),
      capacityOrdersPerHour: 320 + idx * 45,
    };
  });

  const zonesGeoJson: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: hubs.map((h) => buildZonePolygon(h, 4500)),
  };

  const nodeCandidateCache = new Map<string, number[]>();
  const ordersCount = Math.max(64, Math.round(courierCount * 1.65));
  const couriers: CourierSnapshotDto[] = [];

  for (let i = 0; i < courierCount; i += 1) {
    const hub = hubs[i % hubs.length];
    const spawnNodeId = pickRoadNodeNearHub(roadGraph, hub, rng, 250, 4200, nodeCandidateCache);
    const spawnNode = roadGraph.nodes[spawnNodeId] ?? { lat: hub.lat, lon: hub.lon };

    const roll = rng();
    let status: CourierStatus = 'EN_ROUTE_DROPOFF';
    if (roll < 0.08) status = 'OFFLINE';
    else if (roll < 0.24) status = 'IDLE';
    else if (roll < 0.40) status = 'ASSIGNED';
    else if (roll < 0.62) status = 'EN_ROUTE_PICKUP';

    const maxCap = 60 + Math.floor(rng() * 4) * 20;
    const callsign = COURIER_CALLSIGNS[i % COURIER_CALLSIGNS.length];

    // Pick initial compass heading along an actual outgoing road edge from spawnNode
    const outEdges = roadGraph.outgoing[spawnNodeId] ?? [];
    let initialHeading = Math.round(rng() * 360);
    if (outEdges.length > 0) {
      const e = outEdges[Math.floor(rng() * outEdges.length)];
      if (e.geometry.length >= 2) {
        initialHeading = Math.round(
          computeCompassBearingDeg(
            e.geometry[0][1],
            e.geometry[0][0],
            e.geometry[1][1],
            e.geometry[1][0],
          ),
        );
      }
    }

    couriers.push({
      courierId: makeUuid(rng, '2000', i + 1),
      name: `${city.countryCode}-${callsign}-${String(i + 1).padStart(3, '0')}`,
      status,
      lat: Number(spawnNode.lat.toFixed(6)),
      lon: Number(spawnNode.lon.toFixed(6)),
      headingDeg: initialHeading,
      speedMps: status === 'OFFLINE' || status === 'IDLE' ? 0 : 9.5,
      batteryPct: Math.round(38 + rng() * 62),
      currentCapacityKg: 0,
      maxCapacityKg: maxCap,
      lastPingAt: new Date(nowMs - Math.floor(rng() * 2000)).toISOString(),
      shiftStart: new Date(nowMs - 3.5 * 3600_000).toISOString(),
      shiftEnd: new Date(nowMs + 4.5 * 3600_000).toISOString(),
      activeRouteOrderIds: [],
    });
  }

  const activeCouriers = couriers.filter(
    (c) => c.status !== 'OFFLINE' && c.status !== 'IDLE',
  );

  const orders: OrderSnapshotDto[] = [];
  for (let i = 0; i < ordersCount; i += 1) {
    const hub = hubs[i % hubs.length];
    const dropNodeId = pickRoadNodeNearHub(roadGraph, hub, rng, 350, 4400, nodeCandidateCache);
    const dropNode = roadGraph.nodes[dropNodeId] ?? { lat: hub.lat, lon: hub.lon };

    // Generate orderId ONCE so courier.activeRouteOrderIds and orders match 1:1
    const orderId = makeUuid(rng, '3000', i + 1);
    const weightKg = Math.round((1.5 + rng() * 12.5) * 10) / 10;

    const statusRoll = rng();
    let status: OrderStatus = 'IN_TRANSIT';
    let assignedCourier: CourierSnapshotDto | null = null;
    if (statusRoll < 0.20) {
      status = 'PENDING';
    } else if (statusRoll < 0.26) {
      status = 'BATCHING';
    } else if (statusRoll < 0.46) {
      status = 'ASSIGNED';
      assignedCourier = activeCouriers[i % Math.max(1, activeCouriers.length)] ?? null;
    } else if (statusRoll < 0.64) {
      status = 'PICKED_UP';
      assignedCourier = activeCouriers[i % Math.max(1, activeCouriers.length)] ?? null;
    } else if (statusRoll < 0.90) {
      status = 'IN_TRANSIT';
      assignedCourier = activeCouriers[i % Math.max(1, activeCouriers.length)] ?? null;
    } else if (statusRoll < 0.96) {
      status = 'DELIVERED';
      assignedCourier = activeCouriers[i % Math.max(1, activeCouriers.length)] ?? null;
    } else {
      status = 'FAILED';
    }

    if (
      assignedCourier &&
      assignedCourier.activeRouteOrderIds.length < 4 &&
      status !== 'DELIVERED' &&
      assignedCourier.currentCapacityKg + weightKg <= assignedCourier.maxCapacityKg
    ) {
      assignedCourier.activeRouteOrderIds.push(orderId);
      if (status === 'PICKED_UP' || status === 'IN_TRANSIT') {
        assignedCourier.currentCapacityKg =
          Math.round((assignedCourier.currentCapacityKg + weightKg) * 10) / 10;
      }
    } else if (status !== 'DELIVERED' && status !== 'FAILED') {
      assignedCourier = null;
      status = 'PENDING';
    }

    const slackMinutes = -3 + rng() * 40;
    const winEndMs = nowMs + slackMinutes * 60_000;
    const winStartMs = winEndMs - (30 + rng() * 35) * 60_000;

    orders.push({
      orderId,
      hubId: hub.hubId,
      courierId: assignedCourier?.courierId ?? null,
      status,
      weightKg,
      pickupLat: hub.lat,
      pickupLon: hub.lon,
      dropoffLat: Number(dropNode.lat.toFixed(6)),
      dropoffLon: Number(dropNode.lon.toFixed(6)),
      windowStart: new Date(winStartMs).toISOString(),
      windowEnd: new Date(winEndMs).toISOString(),
      serviceDurationSeconds: 90 + Math.floor(rng() * 4) * 30,
      version: 1,
    });
  }

  const weatherCells = buildWeatherGrid(bookmarkId, weatherSurgeIntensity, 0, false);
  const orderMap = new Map(orders.map((o) => [o.orderId, o]));
  const kinematicsByCourierId: Record<string, CourierRoadKinematics> = {};
  const routes: RoutePetalDto[] = [];

  // Run local ALNS multi-vehicle optimization on initial active stops so initial petals are TSP-ordered
  const initActiveOrders = orders.filter(
    (o) => o.courierId !== null && o.status !== 'DELIVERED' && o.status !== 'FAILED',
  );
  const initAlnsVehicles: AlnsVehicleInput[] = activeCouriers.map((c, idx) => {
    const hub = hubs[idx % hubs.length];
    return {
      courierId: c.courierId,
      startNodeId: roadGraph.findNearestNode(c.lat, c.lon),
      endNodeId: hubNodeIds[hub.hubId] ?? roadGraph.findNearestNode(hub.lat, hub.lon),
      maxCapacityKg: c.maxCapacityKg,
      maxStops: 4,
      paceFactor: 0.92 + (parseInt(c.courierId.slice(-2), 16) % 16) * 0.012,
      initialStopIds: c.activeRouteOrderIds,
    };
  });
  const initAlnsStops: AlnsStopInput[] = initActiveOrders.map((o) => ({
    orderId: o.orderId,
    nodeId: roadGraph.findNearestNode(o.dropoffLat, o.dropoffLon),
    weightKg: o.weightKg,
    windowStartUnix: Math.floor(new Date(o.windowStart).getTime() / 1000),
    windowEndUnix: Math.floor(new Date(o.windowEnd).getTime() / 1000),
    serviceDurationSec: o.serviceDurationSeconds,
  }));
  const initAlnsResult = solveAlnsCvrptw(initAlnsVehicles, initAlnsStops, roadGraph, {
    nowUnix,
    iterations: 48,
    seed: 0x1000 + bookmarkId.charCodeAt(0),
  });

  const initRouteByCourier = new Map(initAlnsResult.routes.map((r) => [r.courierId, r]));
  for (const c of activeCouriers) {
    const planned = initRouteByCourier.get(c.courierId);
    if (planned && planned.schedule.length > 0) {
      c.activeRouteOrderIds = planned.schedule.map((s) => s.orderId);
    }
  }

  for (let i = 0; i < couriers.length; i += 1) {
    const c = couriers[i];
    const hub = hubs[i % hubs.length];
    // Ensure couriers without active orders aren't stuck in EN_ROUTE_DROPOFF
    if (c.activeRouteOrderIds.length === 0 && c.status !== 'OFFLINE' && c.status !== 'IDLE') {
      c.status = 'IDLE';
      c.speedMps = 0;
    }
    const { kinematics, route } = planCourierKinematicsAndRoute(
      c,
      hub,
      roadGraph,
      orderMap,
      weatherCells,
      nowUnix,
    );
    kinematicsByCourierId[c.courierId] = kinematics;
    if (route) {
      routes.push(route);
      // Align initial courier heading and speed with the first segment of its real road leg
      const sample = samplePolylineAtDistance(kinematics.legPoly, 0, c.headingDeg);
      c.headingDeg = Math.round(sample.headingDeg);
      const localMult = sampleLocalWeatherMultiplier(c.lat, c.lon, weatherCells);
      c.speedMps = Math.round(kinematics.baseRoadSpeedMps * localMult * kinematics.paceFactor * 10) / 10;
    }
  }

  const totalRouteMeters = routes.reduce((acc, r) => acc + r.totalDistanceMeters, 0);

  return {
    bookmarkId,
    roadGraph,
    hubs,
    hubNodeIds,
    zonesGeoJson,
    couriers,
    orders,
    routes,
    kinematicsByCourierId,
    weatherCells,
    circuitBreakers: defaultBreakers(),
    operatorWeights: initAlnsResult.operatorWeights,
    latestSolve: {
      requestId: `alns-${bookmarkId}-init`,
      solverStatus: 'OPTIMAL',
      solveDurationMs: initAlnsResult.solveDurationMs,
      matrixPreprocessMs: initAlnsResult.matrixPreprocessMs,
      activeWorkerThreads: 8,
      objectiveCost: initAlnsResult.objectiveCost > 0
        ? initAlnsResult.objectiveCost
        : Math.round(totalRouteMeters * 0.042 + 1240),
      iterationsCompleted: initAlnsResult.iterationsCompleted,
      timestamp: new Date(nowMs).toISOString(),
      convergenceHistory: initAlnsResult.convergenceHistory,
    },
    burstRatePerSec,
    lastBurstRatePerSec: burstRatePerSec,
    weatherSurgeIntensity,
    tickCount: 0,
    targetCourierCount: courierCount,
    nextOrderSeq: ordersCount + 1,
    nextCourierSeq: courierCount + 1,
    completedDeliveriesCount: 0,
  };
}

/**
 * Seamlessly upgrade the active `SandboxState` onto a richer real OSM road graph
 * (e.g., extracted from MapLibre vector tiles or backend Overpass) without resetting orders/metrics.
 */
export function upgradeSandboxRoadGraph(
  state: SandboxState,
  newGraph: RoadNetworkGraph,
): SandboxState {
  if (newGraph.nodes.length < 12 || newGraph.edges.length < 20) {
    return state;
  }
  const nowUnix = Math.floor(Date.now() / 1000);
  const city = BOOKMARK_BY_ID[state.bookmarkId];

  // Re-snap hubs to nearest real road node
  const hubNodeIds: Record<string, number> = {};
  const hubs: HubSnapshotDto[] = state.hubs.map((h, idx) => {
    const spec = city.hubCoords[idx] ?? { lat: h.lat, lon: h.lon };
    const nodeId = newGraph.findNearestNode(spec.lat, spec.lon);
    const snapped = nodeId >= 0 ? newGraph.nodes[nodeId] : { lat: h.lat, lon: h.lon };
    hubNodeIds[h.hubId] = nodeId;
    return {
      ...h,
      lat: Number(snapped.lat.toFixed(6)),
      lon: Number(snapped.lon.toFixed(6)),
    };
  });
  const hubById = new Map(hubs.map((h) => [h.hubId, h]));

  // Keep order coordinates intact for couriers already hydrated by OSRM
  const osrmHydratedOrderIds = new Set<string>();
  for (const c of state.couriers) {
    const kin = state.kinematicsByCourierId[c.courierId];
    if (kin?.isOsrmHydrated) {
      for (const oid of c.activeRouteOrderIds) {
        osrmHydratedOrderIds.add(oid);
      }
    }
  }

  // Re-snap non-hydrated orders onto real road nodes
  const orders: OrderSnapshotDto[] = state.orders.map((o) => {
    const hub = hubById.get(o.hubId) ?? hubs[0];
    if (osrmHydratedOrderIds.has(o.orderId)) {
      return {
        ...o,
        pickupLat: hub.lat,
        pickupLon: hub.lon,
      };
    }
    const dropNodeId = newGraph.findNearestNode(o.dropoffLat, o.dropoffLon);
    const dropSnapped =
      dropNodeId >= 0 ? newGraph.nodes[dropNodeId] : { lat: o.dropoffLat, lon: o.dropoffLon };
    return {
      ...o,
      pickupLat: hub.lat,
      pickupLon: hub.lon,
      dropoffLat: Number(dropSnapped.lat.toFixed(6)),
      dropoffLon: Number(dropSnapped.lon.toFixed(6)),
    };
  });
  const orderMap = new Map(orders.map((o) => [o.orderId, o]));
  const prevRouteByCourier = new Map(state.routes.map((r) => [r.courierId, r]));

  // Re-snap couriers and rebuild their road legs & route petals on the new graph
  // while preserving any courier already hydrated with exact OSRM /route/v1/driving/ street geometry
  const kinematicsByCourierId: Record<string, CourierRoadKinematics> = {};
  const routes: RoutePetalDto[] = [];
  const couriers: CourierSnapshotDto[] = state.couriers.map((c, idx) => {
    const prevKin = state.kinematicsByCourierId[c.courierId];
    if (prevKin?.isOsrmHydrated) {
      kinematicsByCourierId[c.courierId] = prevKin;
      const existingRoute = prevRouteByCourier.get(c.courierId);
      if (existingRoute) {
        routes.push(existingRoute);
      }
      return c;
    }

    const nodeId = newGraph.findNearestNode(c.lat, c.lon);
    const snapped = nodeId >= 0 ? newGraph.nodes[nodeId] : { lat: c.lat, lon: c.lon };
    const updatedCourier: CourierSnapshotDto = {
      ...c,
      lat: Number(snapped.lat.toFixed(6)),
      lon: Number(snapped.lon.toFixed(6)),
    };
    const hub = (prevKin ? hubById.get(prevKin.homeHubId) : undefined) ?? hubs[idx % hubs.length];
    const { kinematics, route } = planCourierKinematicsAndRoute(
      updatedCourier,
      hub,
      newGraph,
      orderMap,
      state.weatherCells,
      nowUnix,
      prevKin,
    );
    kinematicsByCourierId[updatedCourier.courierId] = kinematics;
    if (route) {
      routes.push(route);
      const sample = samplePolylineAtDistance(kinematics.legPoly, 0, updatedCourier.headingDeg);
      updatedCourier.headingDeg = Math.round(sample.headingDeg);
    }
    return updatedCourier;
  });

  const zonesGeoJson: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: hubs.map((h) => buildZonePolygon(h, 4500)),
  };

  return {
    ...state,
    roadGraph: newGraph,
    hubs,
    hubNodeIds,
    zonesGeoJson,
    couriers,
    orders,
    routes,
    kinematicsByCourierId,
  };
}

export function stepSandboxSimulation(
  state: SandboxState,
  dtSec = 1.0,
): {
  nextState: SandboxState;
  snapshot: SnapshotResponse;
  systemMetrics: SystemMetricsResponse;
  subpathsByCourierId: Record<string, [number, number][]>;
} {
  const clampedDt = Math.max(0.1, Math.min(6.0, dtSec));
  const nowMs = Date.now();
  const nowUnix = Math.floor(nowMs / 1000);
  const nextTick = state.tickCount + 1;
  const city = BOOKMARK_BY_ID[state.bookmarkId];
  const graph = state.roadGraph;

  const desiredCount =
    state.burstRatePerSec !== state.lastBurstRatePerSec
      ? Math.min(120, Math.max(24, Math.round(20 + (state.burstRatePerSec / 5000) * 100)))
      : state.targetCourierCount;

  const hubById = new Map(state.hubs.map((h) => [h.hubId, h]));
  const nodeCandidateCache = new Map<string, number[]>();
  const tickRng = createSeededRng(`step-${state.bookmarkId}-${nextTick}`);

  // Clone mutable order pool & replenish PENDING orders so the fleet stays continuously active
  let orders = state.orders.map((o) => ({ ...o }));
  let nextOrderSeq = state.nextOrderSeq;
  let completedDeliveriesCount = state.completedDeliveriesCount;
  const pendingCount = orders.filter((o) => o.status === 'PENDING' || o.status === 'BATCHING').length;
  const nonTerminalCount = orders.filter(
    (o) => o.status !== 'DELIVERED' && o.status !== 'FAILED' && o.status !== 'CANCELLED',
  ).length;
  const desiredPendingFloor = Math.max(16, Math.round(desiredCount * 0.18));
  const maxActiveOrders = Math.max(160, Math.round(desiredCount * 1.6));

  if (pendingCount < desiredPendingFloor && nonTerminalCount < maxActiveOrders) {
    const toSpawn = Math.min(
      8,
      desiredPendingFloor - pendingCount,
      maxActiveOrders - nonTerminalCount,
    );
    for (let k = 0; k < toSpawn; k += 1) {
      const hub = state.hubs[(nextOrderSeq + k) % state.hubs.length];
      const dropNodeId = pickRoadNodeNearHub(graph, hub, tickRng, 350, 4400, nodeCandidateCache);
      const dropNode = graph.nodes[dropNodeId] ?? { lat: hub.lat, lon: hub.lon };
      const winEndMs = nowMs + (14 + tickRng() * 32) * 60_000;
      const winStartMs = winEndMs - (25 + tickRng() * 25) * 60_000;
      orders.push({
        orderId: makeUuid(tickRng, '3000', nextOrderSeq),
        hubId: hub.hubId,
        courierId: null,
        status: 'PENDING',
        weightKg: Math.round((1.5 + tickRng() * 11.5) * 10) / 10,
        pickupLat: hub.lat,
        pickupLon: hub.lon,
        dropoffLat: Number(dropNode.lat.toFixed(6)),
        dropoffLon: Number(dropNode.lon.toFixed(6)),
        windowStart: new Date(winStartMs).toISOString(),
        windowEnd: new Date(winEndMs).toISOString(),
        serviceDurationSeconds: 90 + Math.floor(tickRng() * 4) * 30,
        version: 1,
      });
      nextOrderSeq += 1;
    }
    // Keep total order pool bounded while retaining recent DELIVERED history
    if (orders.length > 480) {
      const active = orders.filter((o) => o.status !== 'DELIVERED');
      const delivered = orders.filter((o) => o.status === 'DELIVERED');
      const keepDelivered = Math.max(40, 480 - active.length);
      orders = [...active, ...delivered.slice(Math.max(0, delivered.length - keepDelivered))];
    }
  }

  const orderMap = new Map(orders.map((o) => [o.orderId, o]));
  const weatherDegraded = state.circuitBreakers.open_meteo.state !== 'CLOSED';
  const weatherCells = buildWeatherGrid(
    state.bookmarkId,
    state.weatherSurgeIntensity,
    nextTick,
    weatherDegraded,
  );

  // Dynamically resize fleet on road nodes if burst slider changed
  let couriers = state.couriers.map((c) => ({
    ...c,
    activeRouteOrderIds: [...c.activeRouteOrderIds],
  }));
  const kinematicsByCourierId: Record<string, CourierRoadKinematics> = {
    ...state.kinematicsByCourierId,
  };
  let nextCourierSeq = state.nextCourierSeq;

  if (desiredCount > couriers.length) {
    for (let i = couriers.length; i < desiredCount; i += 1) {
      const hub = state.hubs[i % state.hubs.length];
      const spawnNodeId = pickRoadNodeNearHub(graph, hub, tickRng, 250, 4000, nodeCandidateCache);
      const spawnNode = graph.nodes[spawnNodeId] ?? { lat: hub.lat, lon: hub.lon };
      const courierId = makeUuid(tickRng, '2000', nextCourierSeq);
      const newCourier: CourierSnapshotDto = {
        courierId,
        name: `${city.countryCode}-Burst-${String(nextCourierSeq).padStart(3, '0')}`,
        status: 'IDLE',
        lat: Number(spawnNode.lat.toFixed(6)),
        lon: Number(spawnNode.lon.toFixed(6)),
        headingDeg: Math.round(tickRng() * 360),
        speedMps: 0,
        batteryPct: Math.round(55 + tickRng() * 45),
        currentCapacityKg: 0,
        maxCapacityKg: 80,
        lastPingAt: new Date(nowMs).toISOString(),
        shiftStart: new Date(nowMs - 3 * 3600_000).toISOString(),
        shiftEnd: new Date(nowMs + 5 * 3600_000).toISOString(),
        activeRouteOrderIds: [],
      };
      nextCourierSeq += 1;
      couriers.push(newCourier);
      const { kinematics } = planCourierKinematicsAndRoute(
        newCourier,
        hub,
        graph,
        orderMap,
        weatherCells,
        nowUnix,
      );
      kinematicsByCourierId[courierId] = kinematics;
    }
  } else if (desiredCount < couriers.length) {
    const removed = couriers.slice(desiredCount);
    for (const r of removed) {
      delete kinematicsByCourierId[r.courierId];
    }
    couriers = couriers.slice(0, desiredCount);
  }

  // Rolling auto-dispatch: assign nearby PENDING orders to IDLE couriers so fleet stays in motion
  const freePending = orders.filter((o) => o.status === 'PENDING');
  let pendingCursor = 0;
  const prevRouteMap = new Map(state.routes.map((r) => [r.courierId, r]));
  const nextRoutes: RoutePetalDto[] = [];
  const subpathsByCourierId: Record<string, [number, number][]> = {};

  const updatedCouriers: CourierSnapshotDto[] = couriers.map((c, idx) => {
    if (c.status === 'OFFLINE') {
      return { ...c, speedMps: 0 };
    }

    const existingKin = kinematicsByCourierId[c.courierId];
    const hub = (existingKin ? hubById.get(existingKin.homeHubId) : undefined) ?? state.hubs[idx % state.hubs.length];

    // Auto-dispatch up to 2 pending orders to idle couriers periodically
    if (c.status === 'IDLE' && c.activeRouteOrderIds.length === 0 && pendingCursor < freePending.length) {
      const assignedBatch: OrderSnapshotDto[] = [];
      let batchWeight = 0;
      while (pendingCursor < freePending.length && assignedBatch.length < 2) {
        const cand = freePending[pendingCursor];
        if (batchWeight + cand.weightKg > c.maxCapacityKg) break;
        pendingCursor += 1;
        cand.status = 'ASSIGNED';
        cand.courierId = c.courierId;
        cand.version += 1;
        assignedBatch.push(cand);
        batchWeight += cand.weightKg;
      }
      if (assignedBatch.length > 0) {
        c.activeRouteOrderIds = assignedBatch.map((o) => o.orderId);
        c.status = 'EN_ROUTE_PICKUP';
        const planned = planCourierKinematicsAndRoute(
          c,
          hub,
          graph,
          orderMap,
          weatherCells,
          nowUnix,
          existingKin,
        );
        kinematicsByCourierId[c.courierId] = planned.kinematics;
        if (planned.route) {
          prevRouteMap.set(c.courierId, planned.route);
        }
      }
    }

    let kin = kinematicsByCourierId[c.courierId];
    if (!kin) {
      const planned = planCourierKinematicsAndRoute(c, hub, graph, orderMap, weatherCells, nowUnix);
      kin = planned.kinematics;
      kinematicsByCourierId[c.courierId] = kin;
      if (planned.route) prevRouteMap.set(c.courierId, planned.route);
    }

    // Idle couriers with no target remain parked cleanly at curb (zero drift)
    if (c.status === 'IDLE' && kin.targetType === 'IDLE') {
      return {
        ...c,
        speedMps: 0,
        lastPingAt: new Date(nowMs).toISOString(),
      };
    }

    // Case 1: Servicing a pickup or dropoff stop (dwell countdown, speed = 0)
    if (kin.dwellRemainingSec > 0) {
      const remDwell = Math.max(0, kin.dwellRemainingSec - clampedDt);
      kin = { ...kin, dwellRemainingSec: remDwell };

      if (remDwell <= 0) {
        // Advance onto next queued road leg (preserving OSRM street geometry if hydrated!)
        const advanceToNextQueuedLeg = (): boolean => {
          if (!kin.upcomingLegs || kin.upcomingLegs.length === 0) return false;
          const [nextLeg, ...restLegs] = kin.upcomingLegs;
          const nextTail: [number, number][] = [];
          for (const rl of restLegs) {
            for (let k = nextTail.length === 0 ? 0 : 1; k < rl.legPoly.coords.length; k += 1) {
              nextTail.push(rl.legPoly.coords[k]);
            }
          }
          kin = {
            ...kin,
            targetType: nextLeg.targetType,
            targetOrderId: nextLeg.targetOrderId,
            targetNodeId: nextLeg.targetNodeId,
            legPoly: nextLeg.legPoly,
            distanceAlongLegM: 0,
            baseRoadSpeedMps: nextLeg.baseRoadSpeedMps,
            dwellRemainingSec: 0,
            tailCoords: deduplicateCoords(nextTail),
            upcomingLegs: restLegs,
          };
          return true;
        };

        // Complete stop action and plan next road leg
        if (kin.targetType === 'PICKUP') {
          let loadedKg = 0;
          for (const oid of c.activeRouteOrderIds) {
            const ord = orderMap.get(oid);
            if (ord && (ord.status === 'ASSIGNED' || ord.status === 'PICKED_UP')) {
              ord.status = 'IN_TRANSIT';
              ord.version += 1;
              loadedKg += ord.weightKg;
            }
          }
          c.status = 'EN_ROUTE_DROPOFF';
          c.currentCapacityKg = Math.round(Math.min(c.maxCapacityKg, loadedKg) * 10) / 10;
          if (!advanceToNextQueuedLeg()) {
            const nextPlan = planCourierKinematicsAndRoute(
              c,
              hub,
              graph,
              orderMap,
              weatherCells,
              nowUnix,
              kin,
            );
            kin = nextPlan.kinematics;
            if (nextPlan.route) prevRouteMap.set(c.courierId, nextPlan.route);
          }
        } else if (kin.targetType === 'DROPOFF') {
          const doneOrderId = kin.targetOrderId ?? c.activeRouteOrderIds[0] ?? null;
          if (doneOrderId) {
            const ord = orderMap.get(doneOrderId);
            if (ord) {
              ord.status = 'DELIVERED';
              ord.version += 1;
              completedDeliveriesCount += 1;
              c.currentCapacityKg = Math.max(
                0,
                Math.round((c.currentCapacityKg - ord.weightKg) * 10) / 10,
              );
            }
            c.activeRouteOrderIds = c.activeRouteOrderIds.filter((id) => id !== doneOrderId);
          }
          if (!advanceToNextQueuedLeg()) {
            const nextPlan = planCourierKinematicsAndRoute(
              c,
              hub,
              graph,
              orderMap,
              weatherCells,
              nowUnix,
              kin,
            );
            kin = nextPlan.kinematics;
            if (nextPlan.route) {
              prevRouteMap.set(c.courierId, nextPlan.route);
            } else {
              prevRouteMap.delete(c.courierId);
            }
          } else if (c.activeRouteOrderIds.length === 0) {
            prevRouteMap.delete(c.courierId);
          }
        } else if (kin.targetType === 'RETURN_HUB') {
          c.status = 'IDLE';
          c.currentCapacityKg = 0;
          kin = {
            ...kin,
            targetType: 'IDLE',
            targetOrderId: null,
            batteryFloat: 100,
            upcomingLegs: [],
            tailCoords: [],
          };
          prevRouteMap.delete(c.courierId);
        }
      }

      kinematicsByCourierId[c.courierId] = kin;
      const syncedRoute = syncRoutePetalWithKinematics(
        prevRouteMap.get(c.courierId),
        c,
        kin,
        orderMap,
        weatherCells,
        nowUnix,
      );
      if (syncedRoute) nextRoutes.push(syncedRoute);

      return {
        ...c,
        speedMps: 0,
        batteryPct: Math.round(kin.batteryFloat),
        lastPingAt: new Date(nowMs).toISOString(),
      };
    }

    // Case 2: Traveling strictly along current road polyline leg
    const localWeatherMult = sampleLocalWeatherMultiplier(c.lat, c.lon, weatherCells);
    const roadSpeed = Math.max(5.0, kin.baseRoadSpeedMps || 10.5);
    const speedMps = Math.round(
      Math.max(2.5, Math.min(26.0, roadSpeed * localWeatherMult * kin.paceFactor)) * 10,
    ) / 10;

    const stepMeters = speedMps * clampedDt;
    const prevDist = kin.distanceAlongLegM;
    const nextDist = Math.min(kin.legPoly.totalLengthM, prevDist + stepMeters);

    const subpath = extractSubpath(kin.legPoly, prevDist, nextDist);
    if (subpath.length >= 2) {
      subpathsByCourierId[c.courierId] = subpath;
    }

    const sample = samplePolylineAtDistance(kin.legPoly, nextDist, c.headingDeg);
    const drivenM = Math.max(0, nextDist - prevDist);
    const nextBattery = Math.max(12, kin.batteryFloat - drivenM * 0.0004);

    let dwellRemainingSec = 0;
    const arrivedAtEnd = nextDist >= kin.legPoly.totalLengthM - 1.0;
    if (arrivedAtEnd) {
      if (kin.targetType === 'PICKUP') {
        dwellRemainingSec = 3;
      } else if (kin.targetType === 'DROPOFF') {
        const ord = kin.targetOrderId ? orderMap.get(kin.targetOrderId) : undefined;
        dwellRemainingSec = computeSimDwellSec(ord?.serviceDurationSeconds ?? 120);
      } else if (kin.targetType === 'RETURN_HUB') {
        dwellRemainingSec = 2;
      }
    }

    kin = {
      ...kin,
      distanceAlongLegM: nextDist,
      dwellRemainingSec,
      batteryFloat: nextBattery,
    };
    kinematicsByCourierId[c.courierId] = kin;

    const nextCourier: CourierSnapshotDto = {
      ...c,
      lat: Number(sample.lat.toFixed(6)),
      lon: Number(sample.lon.toFixed(6)),
      headingDeg: Math.round(sample.headingDeg) % 360,
      speedMps: arrivedAtEnd ? 0 : speedMps,
      batteryPct: Math.round(nextBattery),
      lastPingAt: new Date(nowMs).toISOString(),
    };

    const syncedRoute = syncRoutePetalWithKinematics(
      prevRouteMap.get(c.courierId),
      nextCourier,
      kin,
      orderMap,
      weatherCells,
      nowUnix,
    );
    if (syncedRoute) nextRoutes.push(syncedRoute);

    return nextCourier;
  });

  // Update breaker call counters subtly
  const breakers = { ...state.circuitBreakers };
  (['open_meteo', 'osrm', 'overpass'] as UpstreamName[]).forEach((upstream) => {
    const b = breakers[upstream];
    if (b.state === 'OPEN') {
      breakers[upstream] = {
        ...b,
        total_calls: b.total_calls + 2,
        total_short_circuited: b.total_short_circuited + 2,
      };
    } else {
      breakers[upstream] = {
        ...b,
        total_calls: b.total_calls + 1,
      };
    }
  });

  const jitterEps = Math.round(
    state.burstRatePerSec * (0.94 + Math.sin(nextTick * 0.7) * 0.06),
  );
  const queueDepth = Math.min(
    9950,
    Math.max(12, Math.round((jitterEps / 5000) * 1650 + Math.abs(Math.cos(nextTick)) * 45)),
  );

  const nextState: SandboxState = {
    ...state,
    couriers: updatedCouriers,
    orders,
    routes: nextRoutes,
    kinematicsByCourierId,
    weatherCells,
    circuitBreakers: breakers,
    lastBurstRatePerSec: state.burstRatePerSec,
    tickCount: nextTick,
    targetCourierCount: desiredCount,
    nextOrderSeq,
    nextCourierSeq,
    completedDeliveriesCount,
  };

  const snapshot: SnapshotResponse = {
    generatedAt: new Date(nowMs).toISOString(),
    regionCenter: { lat: city.lat, lon: city.lon },
    hubs: nextState.hubs,
    zonesGeoJson: nextState.zonesGeoJson,
    couriers: updatedCouriers,
    orders,
    routes: nextRoutes,
    latestSolve: nextState.latestSolve,
  };

  const systemMetrics: SystemMetricsResponse = {
    timestamp: new Date(nowMs).toISOString(),
    ingestion: {
      events_per_sec: jitterEps,
      total_enqueued: 145_000 + nextTick * jitterEps,
      total_flushed: 144_850 + nextTick * jitterEps - queueDepth,
      queue_depth: queueDepth,
      max_queue_size: 10_000,
    },
    circuit_breakers: breakers,
    orchestrator: {
      status: 'UP',
      virtualThreadsEnabled: true,
      activeVirtualThreads: Math.min(48, 12 + Math.round(jitterEps / 260)),
      bulkheadMaxPermits: 24,
      bulkheadAvailablePermits: 22 + (nextTick % 3 === 0 ? -1 : 0),
      bulkheadTotalAcquisitions: 342 + nextTick,
      peakConcurrentBatchHolders: 8,
      hikariActiveConnections: 6 + Math.round((jitterEps / 5000) * 14),
      hikariIdleConnections: 26 - Math.round((jitterEps / 5000) * 14),
      hikariMaxConnections: 32,
      postgisQueryLatencyMs: Number((2.1 + Math.abs(Math.sin(nextTick * 0.5)) * 1.4).toFixed(2)),
      solverDeadlineMs: 450,
      lastSolveDurationMs: nextState.latestSolve.solveDurationMs,
      lastMatrixPreprocessMs: nextState.latestSolve.matrixPreprocessMs,
      lastObjectiveCost: nextState.latestSolve.objectiveCost,
      lastIterationsCompleted: nextState.latestSolve.iterationsCompleted,
      solverWorkers: 8,
    },
  };

  return { nextState, snapshot, systemMetrics, subpathsByCourierId };
}

export function triggerSandboxReoptimize(
  state: SandboxState,
  params?: { batchSize?: number; weatherSeverityScore?: number; speedMultiplier?: number },
): {
  nextState: SandboxState;
  response: ReoptimizeResponse;
  operatorWeights: AlnsOperatorWeights;
} {
  const nowMs = Date.now();
  const nowUnix = Math.floor(nowMs / 1000);
  const graph = state.roadGraph;
  const hubById = new Map(state.hubs.map((h) => [h.hubId, h]));

  const beforeRoutes = state.routes.map((r) => ({
    ...r,
    waypoints: [...r.waypoints],
    pathCoords: [...r.pathCoords] as [number, number][],
  }));

  const updatedOrders = state.orders.map((o) => ({ ...o }));
  const updatedOrderMap = new Map(updatedOrders.map((o) => [o.orderId, o]));

  const activeCouriers = state.couriers.map((c) => ({
    ...c,
    activeRouteOrderIds: [...c.activeRouteOrderIds],
  }));

  // Weather-aware A* / Dijkstra edge penalty when weather surge is active
  const useWeatherPenalty =
    (params?.weatherSeverityScore ?? state.weatherSurgeIntensity) > 0.2;
  const weatherPenaltyFn = useWeatherPenalty
    ? (lat: number, lon: number) => sampleLocalWeatherMultiplier(lat, lon, state.weatherCells)
    : undefined;

  // 1. Collect candidate vehicles (all non-OFFLINE couriers, capped at 56 for sub-100ms matrix & ALNS)
  const eligibleCouriers = activeCouriers
    .filter((c) => c.status !== 'OFFLINE')
    .slice(0, 56);

  const eligibleCourierSet = new Set(eligibleCouriers.map((c) => c.courierId));
  const beforeAssignments = new Map<string, string>();

  // 2. Collect all existing stops on eligible couriers + up to `batchSize` pending orders
  const stopOrderIds: string[] = [];
  const stopOrderSeen = new Set<string>();

  for (const courier of eligibleCouriers) {
    for (const oid of courier.activeRouteOrderIds) {
      const ord = updatedOrderMap.get(oid);
      if (
        ord &&
        ord.status !== 'DELIVERED' &&
        ord.status !== 'FAILED' &&
        ord.status !== 'CANCELLED' &&
        !stopOrderSeen.has(oid)
      ) {
        stopOrderSeen.add(oid);
        stopOrderIds.push(oid);
        beforeAssignments.set(oid, courier.courierId);
      }
    }
  }

  const pendingOrders = updatedOrders.filter(
    (o) => (o.status === 'PENDING' || o.status === 'BATCHING') && !stopOrderSeen.has(o.orderId),
  );
  const maxNewPending = Math.min(pendingOrders.length, Math.max(8, Math.min(48, params?.batchSize ?? 32)));
  for (let i = 0; i < maxNewPending; i += 1) {
    const ord = pendingOrders[i];
    stopOrderSeen.add(ord.orderId);
    stopOrderIds.push(ord.orderId);
  }

  // 3. Build ALNS vehicle & stop inputs mapped to real road graph node IDs
  const alnsVehicles: AlnsVehicleInput[] = eligibleCouriers.map((c, idx) => {
    const prevKin = state.kinematicsByCourierId[c.courierId];
    const hub = (prevKin ? hubById.get(prevKin.homeHubId) : undefined) ?? state.hubs[idx % state.hubs.length];
    return {
      courierId: c.courierId,
      startNodeId: graph.findNearestNode(c.lat, c.lon),
      endNodeId: state.hubNodeIds[hub.hubId] ?? graph.findNearestNode(hub.lat, hub.lon),
      maxCapacityKg: c.maxCapacityKg,
      maxStops: 4,
      paceFactor: prevKin?.paceFactor ?? 1.0,
      initialStopIds: c.activeRouteOrderIds.filter((id) => stopOrderSeen.has(id)),
    };
  });

  const alnsStops: AlnsStopInput[] = stopOrderIds.map((oid) => {
    const ord = updatedOrderMap.get(oid)!;
    return {
      orderId: ord.orderId,
      nodeId: graph.findNearestNode(ord.dropoffLat, ord.dropoffLon),
      weightKg: ord.weightKg,
      windowStartUnix: Math.floor(new Date(ord.windowStart).getTime() / 1000),
      windowEndUnix: Math.floor(new Date(ord.windowEnd).getTime() / 1000),
      serviceDurationSec: ord.serviceDurationSeconds,
    };
  });

  // 4. Solve multi-vehicle CVRPTW / mTSP using our local ALNS + 2-Opt/Or-Opt solver on the road graph
  const alnsResult = solveAlnsCvrptw(alnsVehicles, alnsStops, graph, {
    nowUnix,
    iterations: 96,
    seed: nowUnix ^ (state.tickCount * 2654435761),
    weatherPenaltyFn,
  });

  const reassignedIds: string[] = [];
  const plannedByCourierId = new Map(alnsResult.routes.map((r) => [r.courierId, r]));

  for (const courier of activeCouriers) {
    if (!eligibleCourierSet.has(courier.courierId)) continue;
    const planned = plannedByCourierId.get(courier.courierId);
    const nextOrderIds = planned ? planned.schedule.map((s) => s.orderId) : [];

    // Check if stop order or vehicle assignment changed
    const prevIds = courier.activeRouteOrderIds;
    const sequenceChanged =
      nextOrderIds.length !== prevIds.length ||
      nextOrderIds.some((id, idx) => id !== prevIds[idx]);

    courier.activeRouteOrderIds = nextOrderIds;
    let loadedWeight = 0;

    for (let rank = 0; rank < nextOrderIds.length; rank += 1) {
      const oid = nextOrderIds[rank];
      const ord = updatedOrderMap.get(oid);
      if (!ord) continue;
      const prevOwner = beforeAssignments.get(oid);
      if (prevOwner !== courier.courierId || sequenceChanged) {
        reassignedIds.push(oid);
      }
      if (ord.status === 'PENDING' || ord.status === 'BATCHING') {
        ord.status = 'ASSIGNED';
      }
      ord.courierId = courier.courierId;
      ord.version += 1;
      loadedWeight += ord.weightKg;
    }

    courier.currentCapacityKg = Math.round(Math.min(courier.maxCapacityKg, loadedWeight) * 10) / 10;
    if (nextOrderIds.length > 0 && courier.status === 'IDLE') {
      courier.status = 'EN_ROUTE_PICKUP';
    }
  }

  for (const unassignedId of alnsResult.unassignedOrderIds) {
    const ord = updatedOrderMap.get(unassignedId);
    if (ord && ord.status !== 'DELIVERED') {
      ord.status = 'PENDING';
      ord.courierId = null;
    }
  }

  // 5. Reconstruct exact OSM road polylines & kinematics for every vehicle's optimized stop sequence
  const nextKinematics: Record<string, CourierRoadKinematics> = {};
  const afterRoutes: RoutePetalDto[] = [];

  for (let i = 0; i < activeCouriers.length; i += 1) {
    const courier = activeCouriers[i];
    const prevKin = state.kinematicsByCourierId[courier.courierId];
    const hub = (prevKin ? hubById.get(prevKin.homeHubId) : undefined) ?? state.hubs[i % state.hubs.length];
    const { kinematics, route } = planCourierKinematicsAndRoute(
      courier,
      hub,
      graph,
      updatedOrderMap,
      state.weatherCells,
      nowUnix,
      prevKin,
      weatherPenaltyFn,
    );
    nextKinematics[courier.courierId] = kinematics;
    if (route) {
      afterRoutes.push(route);
      const sample = samplePolylineAtDistance(kinematics.legPoly, 0, courier.headingDeg);
      courier.headingDeg = Math.round(sample.headingDeg);
    }
  }

  const beforeDist = beforeRoutes.reduce((acc, r) => acc + r.totalDistanceMeters, 0);
  const afterDist = afterRoutes.reduce((acc, r) => acc + r.totalDistanceMeters, 0);
  const rawSaved = beforeDist - afterDist;
  const costReductionRatio =
    alnsResult.initialObjectiveCost > alnsResult.objectiveCost
      ? (alnsResult.initialObjectiveCost - alnsResult.objectiveCost) /
        Math.max(1, alnsResult.initialObjectiveCost)
      : 0.045;
  const distanceSavedMeters =
    rawSaved > 50
      ? rawSaved
      : Math.max(180, Math.round(afterDist * Math.max(0.03, costReductionRatio)));

  const beforeViolations = beforeRoutes.reduce(
    (acc, r) => acc + r.waypoints.filter((w) => w.slackSeconds < 0).length,
    0,
  );
  const afterViolations = afterRoutes.reduce(
    (acc, r) => acc + r.waypoints.filter((w) => w.slackSeconds < 0).length,
    0,
  );
  const resolvedViolations = Math.max(0, beforeViolations - afterViolations);

  const solveTelemetry: SolveTelemetryDto = {
    requestId: `alns-${nowMs.toString(36)}`,
    solverStatus: 'OPTIMAL',
    solveDurationMs: alnsResult.solveDurationMs,
    matrixPreprocessMs: alnsResult.matrixPreprocessMs,
    activeWorkerThreads: 8,
    objectiveCost: alnsResult.objectiveCost,
    iterationsCompleted: alnsResult.iterationsCompleted,
    timestamp: new Date(nowMs).toISOString(),
    convergenceHistory: alnsResult.convergenceHistory,
  };

  const operatorWeights = alnsResult.operatorWeights;

  const nextState: SandboxState = {
    ...state,
    couriers: activeCouriers,
    orders: updatedOrders,
    routes: afterRoutes,
    kinematicsByCourierId: nextKinematics,
    latestSolve: solveTelemetry,
    operatorWeights,
  };

  const uniqueReassigned = Array.from(new Set(reassignedIds));

  const response: ReoptimizeResponse = {
    batchResult: {
      requestId: solveTelemetry.requestId,
      traceId: `trace-${nowMs.toString(36)}`,
      dispatchOutcome: 'OPTIMIZED',
      claimedOrderCount: alnsStops.length,
      assignedOrderIds: uniqueReassigned,
      unassignedOrderIds: alnsResult.unassignedOrderIds,
      routes: afterRoutes.map((r) => ({
        courierId: r.courierId,
        assignedOrderIds: r.waypoints.map((w) => w.orderId),
        totalDistanceMeters: r.totalDistanceMeters,
        totalDurationSeconds: r.totalDurationSeconds,
        encodedPolyline: r.encodedPolyline,
      })),
      retainedExistingRoutesCount: afterRoutes.length,
      degradedFallback: state.circuitBreakers.osrm.state !== 'CLOSED',
      replayedFromIdempotency: false,
      solverDurationMs: alnsResult.solveDurationMs,
    },
    beforeRoutes,
    afterRoutes,
    distanceSavedMeters,
    resolvedViolations,
    reassignedOrderIds: uniqueReassigned,
    solveTelemetry,
  };

  return { nextState, response, operatorWeights };
}

export function applySandboxFaultInjection(
  state: SandboxState,
  upstream: UpstreamName,
  statusCode: 429 | 503 | null,
): SandboxState {
  const prev = state.circuitBreakers[upstream];
  const nextBreaker: CircuitBreakerStatus =
    statusCode === null
      ? {
          state: 'CLOSED',
          failure_count: 0,
          error_rate: 0.0,
          total_calls: prev.total_calls + 1,
          total_failures: prev.total_failures ?? 0,
          total_short_circuited: prev.total_short_circuited,
          injected_status: null,
        }
      : {
          state: 'OPEN',
          failure_count: 5,
          error_rate: 0.42,
          total_calls: prev.total_calls + 5,
          total_failures: (prev.total_failures ?? 0) + 5,
          total_short_circuited: prev.total_short_circuited + 1,
          injected_status: statusCode,
        };

  return {
    ...state,
    circuitBreakers: {
      ...state.circuitBreakers,
      [upstream]: nextBreaker,
    },
  };
}

export interface OsrmCourierHydrationSpec {
  courierId: string;
  stopOrderIds: string[];
  legTargets: { targetType: CourierLegTargetType; targetOrderId: string | null }[];
  waypointsLonLat: [number, number][];
}

/**
 * Collect active couriers whose current multi-stop route has not yet been hydrated
 * with exact street-by-street OSRM `/route/v1/driving/` geometry.
 */
export function collectUnhydratedOsrmRouteRequests(
  state: SandboxState,
): OsrmCourierHydrationSpec[] {
  const orderMap = new Map(state.orders.map((o) => [o.orderId, o]));
  const hubById = new Map(state.hubs.map((h) => [h.hubId, h]));
  const specs: OsrmCourierHydrationSpec[] = [];

  for (let i = 0; i < state.couriers.length; i += 1) {
    const c = state.couriers[i];
    if (c.status === 'OFFLINE' || c.activeRouteOrderIds.length === 0) continue;
    const kin = state.kinematicsByCourierId[c.courierId];
    if (!kin || kin.isOsrmHydrated) continue;

    const hub = hubById.get(kin.homeHubId) ?? state.hubs[i % state.hubs.length];
    const activeOrders: OrderSnapshotDto[] = [];
    for (const oid of c.activeRouteOrderIds) {
      const ord = orderMap.get(oid);
      if (ord && ord.status !== 'DELIVERED' && ord.status !== 'FAILED' && ord.status !== 'CANCELLED') {
        activeOrders.push(ord);
      }
    }
    if (activeOrders.length === 0) continue;

    const waypointsLonLat: [number, number][] = [[c.lon, c.lat]];
    const legTargets: { targetType: CourierLegTargetType; targetOrderId: string | null }[] = [];

    const needsPickup = kin.targetType === 'PICKUP';
    if (needsPickup) {
      waypointsLonLat.push([activeOrders[0].pickupLon, activeOrders[0].pickupLat]);
      legTargets.push({ targetType: 'PICKUP', targetOrderId: activeOrders[0].orderId });
    }

    for (const ord of activeOrders) {
      waypointsLonLat.push([ord.dropoffLon, ord.dropoffLat]);
      legTargets.push({ targetType: 'DROPOFF', targetOrderId: ord.orderId });
    }

    waypointsLonLat.push([hub.lon, hub.lat]);
    legTargets.push({ targetType: 'RETURN_HUB', targetOrderId: null });

    specs.push({
      courierId: c.courierId,
      stopOrderIds: activeOrders.map((o) => o.orderId),
      legTargets,
      waypointsLonLat,
    });
  }

  return specs;
}

/**
 * Apply an exact OSRM `/route/v1/driving/` multi-stop street geometry response
 * to a courier's `CourierRoadKinematics` and `RoutePetalDto`.
 */
export function applyOsrmRouteShapeToCourier(
  state: SandboxState,
  spec: OsrmCourierHydrationSpec,
  shape: OsrmMultiStopRouteShape,
): SandboxState {
  if (shape.legs.length === 0 || shape.legs.length !== spec.legTargets.length) {
    return state;
  }

  const courierIdx = state.couriers.findIndex((c) => c.courierId === spec.courierId);
  if (courierIdx < 0) return state;
  const courier = state.couriers[courierIdx];
  const prevKin = state.kinematicsByCourierId[spec.courierId];
  if (!prevKin) return state;

  // Verify the courier is still executing the same stop sequence
  if (
    courier.activeRouteOrderIds.length !== spec.stopOrderIds.length ||
    courier.activeRouteOrderIds.some((id, idx) => id !== spec.stopOrderIds[idx])
  ) {
    return state;
  }

  const firstOsrmLeg = shape.legs[0];
  const firstTarget = spec.legTargets[0];
  const firstPoly = precomputePolyline(firstOsrmLeg.coords, courier.headingDeg);

  // Preserve fractional progress along current leg if courier already started moving
  const prevFrac =
    prevKin.legPoly.totalLengthM > 1
      ? Math.min(0.65, prevKin.distanceAlongLegM / prevKin.legPoly.totalLengthM)
      : 0;
  const nextDistAlongLegM = firstPoly.totalLengthM * prevFrac;

  const upcomingLegs: QueuedRoadLeg[] = [];
  const tailCoords: [number, number][] = [];

  for (let i = 1; i < shape.legs.length; i += 1) {
    const leg = shape.legs[i];
    const tgt = spec.legTargets[i];
    const poly = precomputePolyline(leg.coords);
    const lastPt = leg.coords[leg.coords.length - 1];
    upcomingLegs.push({
      targetType: tgt.targetType,
      targetOrderId: tgt.targetOrderId,
      targetNodeId: state.roadGraph.findNearestNode(lastPt[1], lastPt[0]),
      legPoly: poly,
      baseRoadSpeedMps: leg.avgSpeedMps,
    });
    for (let k = tailCoords.length === 0 ? 0 : 1; k < poly.coords.length; k += 1) {
      tailCoords.push(poly.coords[k]);
    }
  }

  const firstEndPt = firstOsrmLeg.coords[firstOsrmLeg.coords.length - 1];
  const nextKin: CourierRoadKinematics = {
    ...prevKin,
    targetType: firstTarget.targetType,
    targetOrderId: firstTarget.targetOrderId,
    targetNodeId: state.roadGraph.findNearestNode(firstEndPt[1], firstEndPt[0]),
    legPoly: firstPoly,
    distanceAlongLegM: nextDistAlongLegM,
    baseRoadSpeedMps: firstOsrmLeg.avgSpeedMps,
    tailCoords: deduplicateCoords(tailCoords),
    upcomingLegs,
    isOsrmHydrated: true,
  };

  const sample = samplePolylineAtDistance(firstPoly, nextDistAlongLegM, courier.headingDeg);
  const updatedCourier: CourierSnapshotDto = {
    ...courier,
    lat: Number(sample.lat.toFixed(6)),
    lon: Number(sample.lon.toFixed(6)),
    headingDeg: Math.round(sample.headingDeg) % 360,
  };

  // Snap dropoff order coordinates to the exact OSRM leg endpoint so order pins sit directly on the road line
  const snappedCoordsByOrderId = new Map<string, [number, number]>();
  for (let i = 0; i < shape.legs.length; i += 1) {
    const leg = shape.legs[i];
    const tgt = spec.legTargets[i];
    if (tgt.targetType === 'DROPOFF' && tgt.targetOrderId && leg.coords.length > 0) {
      snappedCoordsByOrderId.set(tgt.targetOrderId, leg.coords[leg.coords.length - 1]);
    }
  }

  const nextOrders =
    snappedCoordsByOrderId.size > 0
      ? state.orders.map((o) => {
          const snappedPt = snappedCoordsByOrderId.get(o.orderId);
          if (!snappedPt) return o;
          return {
            ...o,
            dropoffLon: Number(snappedPt[0].toFixed(6)),
            dropoffLat: Number(snappedPt[1].toFixed(6)),
          };
        })
      : state.orders;

  const orderMap = new Map(nextOrders.map((o) => [o.orderId, o]));
  const nowUnix = Math.floor(Date.now() / 1000);
  const prevRoute = state.routes.find((r) => r.courierId === courier.courierId);
  const syncedRoute = syncRoutePetalWithKinematics(
    prevRoute,
    updatedCourier,
    nextKin,
    orderMap,
    state.weatherCells,
    nowUnix,
  );

  const nextCouriers = [...state.couriers];
  nextCouriers[courierIdx] = updatedCourier;

  const nextRoutes = syncedRoute
    ? state.routes.some((r) => r.courierId === courier.courierId)
      ? state.routes.map((r) =>
          r.courierId === courier.courierId
            ? {
                ...syncedRoute,
                totalDistanceMeters: shape.totalDistanceM,
                encodedPolyline: encodePolyline5(syncedRoute.pathCoords),
              }
            : r,
        )
      : [
          ...state.routes,
          {
            ...syncedRoute,
            totalDistanceMeters: shape.totalDistanceM,
            encodedPolyline: encodePolyline5(syncedRoute.pathCoords),
          },
        ]
    : state.routes;

  return {
    ...state,
    couriers: nextCouriers,
    orders: nextOrders,
    routes: nextRoutes,
    kinematicsByCourierId: {
      ...state.kinematicsByCourierId,
      [courier.courierId]: nextKin,
    },
  };
}
