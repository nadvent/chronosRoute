/**
 * Real OSM Road Network Fetcher, OSRM Multi-Stop Route Geometry Hydrator & IndexedDB Cache.
 *
 * Combines two complementary layers for 100% faithful road-contour rendering and local solving:
 * 1. Fast Area Road Network (`loadCityOsmRoadNetwork`):
 *    - Fetches drivable OpenStreetMap highway geometries (`out geom qt;`) around the city's
 *      curated depot hubs and calibrates travel speeds via a single OSRM `/table/v1/driving/`
 *      matrix call.
 *    - Cached in IndexedDB (`chronos_osm_road_cache_v3`) so our local multi-vehicle ALNS CVRPTW
 *      solver can compute road distance/time matrices and optimize stop assignments instantaneously.
 * 2. Exact OSRM Multi-Stop Route Shape Hydrator (`fetchOsrmMultiStopRoute`):
 *    - Given a vehicle's ALNS-optimized stop sequence `[start, ...(pickup), stop_1, ..., stop_k, hub]`,
 *      queries OSRM `/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true`
 *      (with automatic failover across `routing.openstreetmap.de` and `router.project-osrm.org`,
 *      bounded concurrency, and IndexedDB caching) to return the exact street-by-street GeoJSON
 *      polyline for the entire route petal and every individual stop-to-stop leg.
 */

import { BOOKMARK_BY_ID } from '../constants/bookmarks.ts';
import type { BookmarkId } from '../types/chronos';
import { deduplicateCoords, haversineMeters } from './polylineKinematics.ts';
import {
  buildRoadNetworkGraph,
  normalizeRoadClass,
  ROAD_CLASS_SPEED_MPS,
  RoadNetworkGraph,
  type RawRoadSegment,
  type RoadClass,
  type SerializedRoadGraph,
} from './roadNetwork.ts';

const IDB_NAME = 'chronos_osm_road_cache_v3';
const IDB_GRAPH_STORE = 'city_graphs';
const IDB_ROUTE_STORE = 'osrm_routes';
const IDB_VERSION = 1;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const OSRM_BASE_ENDPOINTS = [
  'https://routing.openstreetmap.de/routed-car',
  'https://router.project-osrm.org',
];

export interface OsrmLegShape {
  coords: [number, number][];
  distanceM: number;
  durationSec: number;
  avgSpeedMps: number;
}

export interface OsrmMultiStopRouteShape {
  cacheKey: string;
  fullCoords: [number, number][];
  legs: OsrmLegShape[];
  snappedWaypoints: [number, number][];
  totalDistanceM: number;
  totalDurationSec: number;
}

const inFlightGraphLoads = new Map<BookmarkId, Promise<RoadNetworkGraph | null>>();
const memoryRouteCache = new Map<string, OsrmMultiStopRouteShape>();
const inFlightRouteLoads = new Map<string, Promise<OsrmMultiStopRouteShape | null>>();

// Bounded concurrency queue for OSRM route geometry requests
const MAX_CONCURRENT_OSRM = 4;
let activeOsrmCount = 0;
const osrmWaitQueue: (() => void)[] = [];
let osrmServerRobin = 0;

async function acquireOsrmSlot(): Promise<void> {
  if (activeOsrmCount < MAX_CONCURRENT_OSRM) {
    activeOsrmCount += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    osrmWaitQueue.push(resolve);
  });
  activeOsrmCount += 1;
}

function releaseOsrmSlot(): void {
  activeOsrmCount = Math.max(0, activeOsrmCount - 1);
  const next = osrmWaitQueue.shift();
  if (next) next();
}

function parseMaxspeedMps(raw: unknown, roadClass: RoadClass): number {
  const fallback = ROAD_CLASS_SPEED_MPS[roadClass];
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim().toLowerCase();
  if (!text) return fallback;
  const num = Number.parseFloat(text);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  const mps = text.includes('mph') ? num * 0.44704 : num / 3.6;
  return Math.max(4.0, Math.min(28.0, Number(mps.toFixed(2))));
}

function openRoadCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_GRAPH_STORE)) {
          db.createObjectStore(IDB_GRAPH_STORE, { keyPath: 'bookmarkId' });
        }
        if (!db.objectStoreNames.contains(IDB_ROUTE_STORE)) {
          db.createObjectStore(IDB_ROUTE_STORE, { keyPath: 'cacheKey' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readGraphFromIndexedDb(bookmarkId: BookmarkId): Promise<RoadNetworkGraph | null> {
  const db = await openRoadCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_GRAPH_STORE, 'readonly');
      const store = tx.objectStore(IDB_GRAPH_STORE);
      const getReq = store.get(bookmarkId);
      getReq.onsuccess = () => {
        const raw = getReq.result as SerializedRoadGraph | undefined;
        resolve(raw ? RoadNetworkGraph.fromSerialized(raw) : null);
      };
      getReq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeGraphToIndexedDb(graph: RoadNetworkGraph): Promise<void> {
  const db = await openRoadCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_GRAPH_STORE, 'readwrite');
      const store = tx.objectStore(IDB_GRAPH_STORE);
      store.put(graph.toSerialized());
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function readRouteFromIndexedDb(cacheKey: string): Promise<OsrmMultiStopRouteShape | null> {
  const mem = memoryRouteCache.get(cacheKey);
  if (mem) return mem;
  const db = await openRoadCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_ROUTE_STORE, 'readonly');
      const store = tx.objectStore(IDB_ROUTE_STORE);
      const getReq = store.get(cacheKey);
      getReq.onsuccess = () => {
        const raw = getReq.result as OsrmMultiStopRouteShape | undefined;
        if (raw && Array.isArray(raw.fullCoords) && raw.fullCoords.length >= 2) {
          memoryRouteCache.set(cacheKey, raw);
          resolve(raw);
        } else {
          resolve(null);
        }
      };
      getReq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeRouteToIndexedDb(shape: OsrmMultiStopRouteShape): Promise<void> {
  memoryRouteCache.set(shape.cacheKey, shape);
  const db = await openRoadCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_ROUTE_STORE, 'readwrite');
      const store = tx.objectStore(IDB_ROUTE_STORE);
      store.put(shape);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Compute compact bounding box around a city's curated hubs so Overpass responds in <1s. */
function computeCityHubBbox(bookmarkId: BookmarkId): [number, number, number, number] {
  const city = BOOKMARK_BY_ID[bookmarkId];
  let south = city.lat;
  let north = city.lat;
  let west = city.lon;
  let east = city.lon;

  for (const h of city.hubCoords) {
    if (h.lat < south) south = h.lat;
    if (h.lat > north) north = h.lat;
    if (h.lon < west) west = h.lon;
    if (h.lon > east) east = h.lon;
  }

  const padLat = 0.0085; // ~950m padding beyond outer hubs
  const padLon = 0.011;
  return [
    Number((south - padLat).toFixed(4)),
    Number((west - padLon).toFixed(4)),
    Number((north + padLat).toFixed(4)),
    Number((east + padLon).toFixed(4)),
  ];
}

interface OverpassGeomPt {
  lat: number;
  lon: number;
}

interface OverpassWayElement {
  type: string;
  id?: number;
  tags?: Record<string, string>;
  geometry?: OverpassGeomPt[];
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * Fetch exact drivable OSM road segments for `bookmarkId` from Overpass API using `out geom qt;`.
 * Queries motorway, trunk, primary, secondary, and tertiary networks (~300 KB response, <1s).
 */
async function fetchOverpassRoadSegments(bookmarkId: BookmarkId): Promise<RawRoadSegment[] | null> {
  if (typeof fetch === 'undefined') return null;
  const [south, west, north, east] = computeCityHubBbox(bookmarkId);
  const query =
    `[out:json][timeout:10];` +
    `way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link)$"]` +
    `(${south},${west},${north},${east});` +
    `out geom qt;`;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const resp = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: `data=${encodeURIComponent(query)}`,
        },
        8500,
      );
      if (!resp.ok) continue;
      const body = (await resp.json()) as { elements?: OverpassWayElement[] };
      const elements = body.elements ?? [];
      const segments: RawRoadSegment[] = [];

      for (const el of elements) {
        if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) {
          continue;
        }
        const tags = el.tags ?? {};
        const roadClass = normalizeRoadClass(tags.highway);
        if (!roadClass) continue;

        const onewayRaw = (tags.oneway ?? '').trim().toLowerCase();
        const isReverse = onewayRaw === '-1';
        const isOneway =
          isReverse ||
          onewayRaw === 'yes' ||
          onewayRaw === '1' ||
          onewayRaw === 'true' ||
          tags.junction === 'roundabout' ||
          tags.highway === 'motorway' ||
          tags.highway === 'motorway_link';

        const geomPts = isReverse ? [...el.geometry].reverse() : el.geometry;
        const coords: [number, number][] = [];
        for (const pt of geomPts) {
          if (typeof pt.lon === 'number' && typeof pt.lat === 'number') {
            coords.push([Number(pt.lon.toFixed(6)), Number(pt.lat.toFixed(6))]);
          }
        }
        if (coords.length < 2) continue;

        segments.push({
          coords,
          roadClass,
          oneway: isOneway,
          speedLimitMps: parseMaxspeedMps(tags.maxspeed, roadClass),
          isGradeSeparated: tags.bridge === 'yes' || tags.tunnel === 'yes',
        });
      }

      if (segments.length >= 25) {
        return segments;
      }
    } catch {
      // Try next Overpass mirror
    }
  }
  return null;
}

/**
 * Calibrate a `RoadNetworkGraph`'s travel durations against real OSRM driving durations
 * for the metropolitan area using a SINGLE `/table/v1/driving/` request.
 */
export async function calibrateGraphWithOsrmTable(graph: RoadNetworkGraph): Promise<number> {
  if (typeof fetch === 'undefined' || graph.nodes.length < 8) {
    return graph.osrmSpeedScale;
  }

  const city = BOOKMARK_BY_ID[graph.bookmarkId];
  const anchorNodeIds: number[] = [];
  const seen = new Set<number>();

  for (const h of city.hubCoords) {
    const nid = graph.findNearestNode(h.lat, h.lon);
    if (nid >= 0 && !seen.has(nid)) {
      seen.add(nid);
      anchorNodeIds.push(nid);
    }
  }

  const targetAnchors = 10;
  const step = Math.max(1, Math.floor(graph.nodes.length / targetAnchors));
  for (let idx = 0; idx < graph.nodes.length && anchorNodeIds.length < targetAnchors; idx += step) {
    const nid = graph.nodes[idx].id;
    if (!seen.has(nid)) {
      seen.add(nid);
      anchorNodeIds.push(nid);
    }
  }

  if (anchorNodeIds.length < 3) {
    return graph.osrmSpeedScale;
  }

  const coordStr = anchorNodeIds
    .map((nid) => {
      const n = graph.nodes[nid];
      return `${n.lon.toFixed(6)},${n.lat.toFixed(6)}`;
    })
    .join(';');

  for (const baseUrl of OSRM_BASE_ENDPOINTS) {
    try {
      const url = `${baseUrl}/table/v1/driving/${coordStr}?annotations=duration`;
      const resp = await fetchWithTimeout(url, { method: 'GET' }, 5000);
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        code?: string;
        durations?: (number | null)[][];
      };
      if (data.code !== 'Ok' || !Array.isArray(data.durations)) continue;

      const localMat = graph.computeDistanceDurationMatrix(anchorNodeIds);
      const k = anchorNodeIds.length;
      let osrmSumSec = 0;
      let graphSumSec = 0;
      let validPairs = 0;

      for (let r = 0; r < k; r += 1) {
        const row = data.durations[r];
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < k; c += 1) {
          if (r === c) continue;
          const osrmDur = row[c];
          const graphDur = localMat.durationsSec[r * k + c];
          if (
            typeof osrmDur === 'number' &&
            osrmDur > 15 &&
            osrmDur < 7200 &&
            graphDur > 15 &&
            graphDur < 7200
          ) {
            osrmSumSec += osrmDur;
            graphSumSec += graphDur;
            validPairs += 1;
          }
        }
      }

      if (validPairs >= 4 && osrmSumSec > 0) {
        const rawScale = (graphSumSec / osrmSumSec) * graph.osrmSpeedScale;
        const calibratedScale = Math.max(0.45, Math.min(1.65, Number(rawScale.toFixed(3))));
        graph.applyOsrmSpeedCalibration(calibratedScale, true);
        await writeGraphToIndexedDb(graph);
        return calibratedScale;
      }
    } catch {
      // Fail over to secondary OSRM table endpoint
    }
  }

  return graph.osrmSpeedScale;
}

/**
 * Load or build the real OpenStreetMap `RoadNetworkGraph` for `bookmarkId`,
 * calibrated with OSRM Table API driving speeds and cached in IndexedDB.
 */
export async function loadCityOsmRoadNetwork(
  bookmarkId: BookmarkId,
): Promise<RoadNetworkGraph | null> {
  const existingPromise = inFlightGraphLoads.get(bookmarkId);
  if (existingPromise) {
    return existingPromise;
  }

  const task = (async (): Promise<RoadNetworkGraph | null> => {
    const cachedGraph = await readGraphFromIndexedDb(bookmarkId);
    if (cachedGraph && cachedGraph.nodes.length >= 20 && cachedGraph.edges.length >= 30) {
      if (cachedGraph.source !== 'osrm-calibrated-osm') {
        void calibrateGraphWithOsrmTable(cachedGraph);
      }
      return cachedGraph;
    }

    const segments = await fetchOverpassRoadSegments(bookmarkId);
    if (!segments || segments.length < 25) {
      return null;
    }

    // Use 3m endpoint snap so OSM intersections fuse while preserving every curve vertex
    const graph = buildRoadNetworkGraph(bookmarkId, 'overpass', segments, 3);
    if (graph.nodes.length < 15 || graph.edges.length < 25) {
      return null;
    }

    await calibrateGraphWithOsrmTable(graph);
    await writeGraphToIndexedDb(graph);
    return graph;
  })();

  inFlightGraphLoads.set(bookmarkId, task);
  try {
    return await task;
  } finally {
    inFlightGraphLoads.delete(bookmarkId);
  }
}

interface OsrmApiStep {
  geometry?: {
    coordinates?: [number, number][];
  };
}

interface OsrmApiLeg {
  distance?: number;
  duration?: number;
  steps?: OsrmApiStep[];
}

interface OsrmApiRouteResponse {
  code?: string;
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: {
      coordinates?: [number, number][];
    };
    legs?: OsrmApiLeg[];
  }[];
  waypoints?: {
    location?: [number, number];
  }[];
}

/**
 * Fetch exact street-by-street OSRM `/route/v1/driving/` geometry for a multi-stop waypoint sequence
 * `waypointsLonLat` (`[[lon, lat], ...]`).
 *
 * Returns both the full contiguous road polyline and the individual leg-by-leg street polylines
 * (extracted from `legs[i].steps[].geometry.coordinates`), cached in IndexedDB.
 */
export async function fetchOsrmMultiStopRoute(
  waypointsLonLat: readonly [number, number][],
): Promise<OsrmMultiStopRouteShape | null> {
  if (typeof fetch === 'undefined' || waypointsLonLat.length < 2) {
    return null;
  }

  const cacheKey = waypointsLonLat
    .map(([lon, lat]) => `${lon.toFixed(4)},${lat.toFixed(4)}`)
    .join(';');

  const cached = await readRouteFromIndexedDb(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightRouteLoads.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<OsrmMultiStopRouteShape | null> => {
    await acquireOsrmSlot();
    try {
      const coordQuery = waypointsLonLat
        .map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`)
        .join(';');

      const startIdx = osrmServerRobin % OSRM_BASE_ENDPOINTS.length;
      osrmServerRobin += 1;

      for (let attempt = 0; attempt < OSRM_BASE_ENDPOINTS.length; attempt += 1) {
        const baseUrl = OSRM_BASE_ENDPOINTS[(startIdx + attempt) % OSRM_BASE_ENDPOINTS.length];
        try {
          const url = `${baseUrl}/route/v1/driving/${coordQuery}?overview=full&geometries=geojson&steps=true`;
          const resp = await fetchWithTimeout(url, { method: 'GET' }, 5500);
          if (!resp.ok) continue;

          const body = (await resp.json()) as OsrmApiRouteResponse;
          if (body.code !== 'Ok' || !Array.isArray(body.routes) || body.routes.length === 0) {
            continue;
          }

          const route = body.routes[0];
          const rawFull = route.geometry?.coordinates ?? [];
          if (rawFull.length < 2) continue;

          const fullCoords: [number, number][] = deduplicateCoords(
            rawFull.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
          );

          const legs: OsrmLegShape[] = [];
          const apiLegs = route.legs ?? [];
          for (let i = 0; i < apiLegs.length; i += 1) {
            const leg = apiLegs[i];
            const stepCoords: [number, number][] = [];
            for (const step of leg.steps ?? []) {
              for (const pt of step.geometry?.coordinates ?? []) {
                if (Array.isArray(pt) && pt.length >= 2) {
                  stepCoords.push([Number(pt[0].toFixed(6)), Number(pt[1].toFixed(6))]);
                }
              }
            }

            const cleanedLegCoords =
              stepCoords.length >= 2
                ? deduplicateCoords(stepCoords)
                : [waypointsLonLat[i], waypointsLonLat[Math.min(i + 1, waypointsLonLat.length - 1)]];

            const distM =
              typeof leg.distance === 'number' && leg.distance > 1
                ? leg.distance
                : Math.max(
                    10,
                    haversineMeters(
                      cleanedLegCoords[0][1],
                      cleanedLegCoords[0][0],
                      cleanedLegCoords[cleanedLegCoords.length - 1][1],
                      cleanedLegCoords[cleanedLegCoords.length - 1][0],
                    ),
                  );
            const durSec =
              typeof leg.duration === 'number' && leg.duration > 1
                ? leg.duration
                : Math.max(1, distM / 10.5);

            legs.push({
              coords: cleanedLegCoords,
              distanceM: Math.round(distM),
              durationSec: Math.round(durSec),
              avgSpeedMps: Math.max(4.5, Math.min(24.0, distM / Math.max(1, durSec))),
            });
          }

          const snappedWaypoints: [number, number][] =
            Array.isArray(body.waypoints) && body.waypoints.length === waypointsLonLat.length
              ? body.waypoints.map((wp, idx) =>
                  Array.isArray(wp.location) && wp.location.length >= 2
                    ? [Number(wp.location[0].toFixed(6)), Number(wp.location[1].toFixed(6))]
                    : waypointsLonLat[idx],
                )
              : [...waypointsLonLat];

          const result: OsrmMultiStopRouteShape = {
            cacheKey,
            fullCoords,
            legs,
            snappedWaypoints,
            totalDistanceM: Math.round(route.distance ?? legs.reduce((a, l) => a + l.distanceM, 0)),
            totalDurationSec: Math.round(route.duration ?? legs.reduce((a, l) => a + l.durationSec, 0)),
          };

          await writeRouteToIndexedDb(result);
          return result;
        } catch {
          // Try next OSRM endpoint
        }
      }
      return null;
    } finally {
      releaseOsrmSlot();
    }
  })();

  inFlightRouteLoads.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightRouteLoads.delete(cacheKey);
  }
}
