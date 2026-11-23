/**
 * Hybrid Real OSM Road Network Graph & A* Router.
 *
 * Supports three tiers of road topology:
 * 1. MapLibre Vector Tiles (OpenMapTiles `transportation` layer — zero external API calls,
 *    pixel-aligned with the rendered dark-matter basemap roads).
 * 2. Backend Overpass OSM road graph (`GET /api/v1/graph/network`, Redis-cached).
 * 3. Deterministic land-safe urban arterial + street-grid fallback (offline / cold-boot).
 *
 * Topology guarantees:
 * - Quantized spatial vertex merging stitches tile-clipped segments and crossing ways.
 * - Degree-2 chain compaction keeps curved road geometries intact while minimizing A* nodes.
 * - Tarjan's Strongly Connected Components (SCC) eliminates dead-end one-way traps and islands.
 */

import type maplibregl from 'maplibre-gl';
import { BOOKMARK_BY_ID } from '../constants/bookmarks.ts';
import type { BookmarkId, RoadGraphNetworkDto, RoadNetworkSource } from '../types/chronos';
import {
  deduplicateCoords,
  haversineMeters,
  metersToLatDeg,
  metersToLonDeg,
} from './polylineKinematics.ts';

export type { RoadNetworkSource };

export type RoadClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'minor'
  | 'service';

export interface SerializedRoadGraph {
  version: 2;
  bookmarkId: BookmarkId;
  source: RoadNetworkSource;
  osrmSpeedScale: number;
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export interface RoadNode {
  id: number;
  lat: number;
  lon: number;
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  distanceM: number;
  speedLimitMps: number;
  baseDurationSec: number;
  roadClass: RoadClass;
  /** Ordered `[lon, lat]` coordinates from `from` node to `to` node preserving curves. */
  geometry: [number, number][];
}

export interface RawRoadSegment {
  coords: [number, number][];
  roadClass: RoadClass;
  oneway: boolean;
  speedLimitMps?: number;
  /** True when feature is an elevated bridge/tunnel that should not node with crossing surface roads. */
  isGradeSeparated?: boolean;
}

export interface RoadPathResult {
  nodeIds: number[];
  pathCoords: [number, number][];
  totalDistanceM: number;
  totalDurationSec: number;
  averageSpeedMps: number;
  reachable: boolean;
}

export const ROAD_CLASS_SPEED_MPS: Record<RoadClass, number> = {
  motorway: 22.0,
  trunk: 17.0,
  primary: 13.5,
  secondary: 11.5,
  tertiary: 9.5,
  minor: 7.5,
  service: 5.5,
};

const MAX_GRAPH_SPEED_MPS = 24.0;
const PATH_CACHE_MAX_ENTRIES = 4000;

const DRIVABLE_CLASS_MAP: Record<string, RoadClass> = {
  motorway: 'motorway',
  motorway_link: 'trunk',
  trunk: 'trunk',
  trunk_link: 'primary',
  primary: 'primary',
  primary_link: 'secondary',
  secondary: 'secondary',
  secondary_link: 'tertiary',
  tertiary: 'tertiary',
  tertiary_link: 'minor',
  minor: 'minor',
  unclassified: 'minor',
  residential: 'minor',
  living_street: 'service',
  street: 'minor',
  street_limited: 'service',
  service: 'service',
};

const EXCLUDED_ROAD_CLASSES = new Set([
  'rail',
  'transit',
  'ferry',
  'path',
  'footway',
  'cycleway',
  'bridleway',
  'steps',
  'pedestrian',
  'track',
  'raceway',
  'aeroway',
  'bus_guideway',
]);

export function normalizeRoadClass(raw: unknown): RoadClass | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (EXCLUDED_ROAD_CLASSES.has(key)) return null;
  return DRIVABLE_CLASS_MAP[key] ?? null;
}

/** Compact binary min-heap for fast A* priority queue operations. */
class MinHeap<T> {
  private items: { key: number; value: T }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, value: T): void {
    this.items.push({ key, value });
    this.siftUp(this.items.length - 1);
  }

  pop(): { key: number; value: T } | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (n > 1) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(idx: number): void {
    let i = idx;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.items[i].key >= this.items[parent].key) break;
      const tmp = this.items[i];
      this.items[i] = this.items[parent];
      this.items[parent] = tmp;
      i = parent;
    }
  }

  private siftDown(idx: number): void {
    let i = idx;
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const l = (i << 1) + 1;
      const r = l + 1;
      if (l < n && this.items[l].key < this.items[smallest].key) smallest = l;
      if (r < n && this.items[r].key < this.items[smallest].key) smallest = r;
      if (smallest === i) break;
      const tmp = this.items[i];
      this.items[i] = this.items[smallest];
      this.items[smallest] = tmp;
      i = smallest;
    }
  }
}

export class RoadNetworkGraph {
  public source: RoadNetworkSource;
  public readonly bookmarkId: BookmarkId;
  public readonly nodes: RoadNode[];
  public readonly edges: RoadEdge[];
  public readonly outgoing: RoadEdge[][];
  public osrmSpeedScale = 1.0;

  private readonly cellDegLat = 0.0022; // ~245m
  private readonly cellDegLon: number;
  private readonly spatialGrid = new Map<string, number[]>();
  private readonly pathCache = new Map<string, RoadPathResult>();

  constructor(
    bookmarkId: BookmarkId,
    source: RoadNetworkSource,
    nodes: RoadNode[],
    edges: RoadEdge[],
    osrmSpeedScale = 1.0,
  ) {
    this.bookmarkId = bookmarkId;
    this.source = source;
    this.nodes = nodes;
    this.edges = edges;
    this.osrmSpeedScale = osrmSpeedScale;
    this.outgoing = Array.from({ length: nodes.length }, () => []);

    const refLat = nodes.length > 0 ? nodes[0].lat : BOOKMARK_BY_ID[bookmarkId].lat;
    const cosLat = Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
    this.cellDegLon = this.cellDegLat / cosLat;

    for (const edge of edges) {
      if (edge.from >= 0 && edge.from < nodes.length) {
        this.outgoing[edge.from].push(edge);
      }
    }

    for (const node of nodes) {
      const key = this.gridKey(node.lat, node.lon);
      let bucket = this.spatialGrid.get(key);
      if (!bucket) {
        bucket = [];
        this.spatialGrid.set(key, bucket);
      }
      bucket.push(node.id);
    }
  }

  private gridKey(lat: number, lon: number): string {
    const r = Math.floor(lat / this.cellDegLat);
    const c = Math.floor(lon / this.cellDegLon);
    return `${r}:${c}`;
  }

  /** Fast spatial-grid lookup of nearest road node to `(lat, lon)`. */
  public findNearestNode(lat: number, lon: number): number {
    if (this.nodes.length === 0) return -1;
    const baseR = Math.floor(lat / this.cellDegLat);
    const baseC = Math.floor(lon / this.cellDegLon);

    let bestId = -1;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let ring = 0; ring <= 8; ring += 1) {
      let foundInRing = false;
      for (let dr = -ring; dr <= ring; dr += 1) {
        for (let dc = -ring; dc <= ring; dc += 1) {
          if (ring > 0 && Math.abs(dr) < ring && Math.abs(dc) < ring) continue;
          const bucket = this.spatialGrid.get(`${baseR + dr}:${baseC + dc}`);
          if (!bucket) continue;
          for (const nodeId of bucket) {
            const node = this.nodes[nodeId];
            const d = haversineMeters(lat, lon, node.lat, node.lon);
            if (d < bestDist) {
              bestDist = d;
              bestId = nodeId;
              foundInRing = true;
            }
          }
        }
      }
      if (foundInRing && ring >= 1) {
        return bestId;
      }
    }

    // Linear fallback if coordinate is far outside the loaded bbox
    if (bestId === -1) {
      for (const node of this.nodes) {
        const d = haversineMeters(lat, lon, node.lat, node.lon);
        if (d < bestDist) {
          bestDist = d;
          bestId = node.id;
        }
      }
    }
    return bestId;
  }

  /** Return all road node IDs within `[minDistM, maxDistM]` of `(lat, lon)`. */
  public collectNodesInAnnulus(
    lat: number,
    lon: number,
    minDistM: number,
    maxDistM: number,
  ): number[] {
    const out: number[] = [];
    for (const node of this.nodes) {
      const d = haversineMeters(lat, lon, node.lat, node.lon);
      if (d >= minDistM && d <= maxDistM) {
        out.push(node.id);
      }
    }
    return out;
  }

  /**
   * Find fastest road path between `startNodeId` and `goalNodeId` via A*.
   * Optionally accepts `edgeSpeedMultiplier(midLat, midLon)` for weather-aware rerouting.
   */
  public findRoadPath(
    startNodeId: number,
    goalNodeId: number,
    edgeSpeedMultiplier?: (lat: number, lon: number) => number,
  ): RoadPathResult {
    if (
      startNodeId < 0 ||
      goalNodeId < 0 ||
      startNodeId >= this.nodes.length ||
      goalNodeId >= this.nodes.length
    ) {
      return {
        nodeIds: [],
        pathCoords: [],
        totalDistanceM: 0,
        totalDurationSec: 0,
        averageSpeedMps: 10,
        reachable: false,
      };
    }

    if (startNodeId === goalNodeId) {
      const n = this.nodes[startNodeId];
      return {
        nodeIds: [startNodeId],
        pathCoords: [[n.lon, n.lat]],
        totalDistanceM: 0,
        totalDurationSec: 0,
        averageSpeedMps: 10,
        reachable: true,
      };
    }

    const useCache = !edgeSpeedMultiplier;
    const cacheKey = `${startNodeId}->${goalNodeId}`;
    if (useCache) {
      const cached = this.pathCache.get(cacheKey);
      if (cached) return cached;
    }

    const nCount = this.nodes.length;
    const goal = this.nodes[goalNodeId];
    const gScore = new Float64Array(nCount);
    gScore.fill(Number.POSITIVE_INFINITY);
    const parentNode = new Int32Array(nCount);
    parentNode.fill(-1);
    const parentEdgeIdx = new Int32Array(nCount);
    parentEdgeIdx.fill(-1);
    const closed = new Uint8Array(nCount);

    const open = new MinHeap<number>();
    gScore[startNodeId] = 0;
    const h0 =
      haversineMeters(this.nodes[startNodeId].lat, this.nodes[startNodeId].lon, goal.lat, goal.lon) /
      MAX_GRAPH_SPEED_MPS;
    open.push(h0, startNodeId);

    let found = false;
    while (open.size > 0) {
      const top = open.pop()!;
      const u = top.value;
      if (closed[u]) continue;
      closed[u] = 1;
      if (u === goalNodeId) {
        found = true;
        break;
      }

      const adj = this.outgoing[u];
      const curG = gScore[u];
      for (let i = 0; i < adj.length; i += 1) {
        const edge = adj[i];
        const v = edge.to;
        if (closed[v]) continue;
        let durSec = edge.baseDurationSec;
        if (edgeSpeedMultiplier) {
          const midPt = edge.geometry[edge.geometry.length >>> 1];
          const mult = Math.max(0.25, Math.min(1.5, edgeSpeedMultiplier(midPt[1], midPt[0])));
          durSec = edge.baseDurationSec / mult;
        }
        const candG = curG + durSec;
        if (candG < gScore[v]) {
          gScore[v] = candG;
          parentNode[v] = u;
          parentEdgeIdx[v] = edge.id;
          const vNode = this.nodes[v];
          const h = haversineMeters(vNode.lat, vNode.lon, goal.lat, goal.lon) / MAX_GRAPH_SPEED_MPS;
          open.push(candG + h, v);
        }
      }
    }

    if (!found) {
      return {
        nodeIds: [],
        pathCoords: [],
        totalDistanceM: 0,
        totalDurationSec: 0,
        averageSpeedMps: 10,
        reachable: false,
      };
    }

    // Reconstruct traversed edges and curved road geometry
    const revEdges: RoadEdge[] = [];
    const revNodes: number[] = [goalNodeId];
    let cur = goalNodeId;
    while (cur !== startNodeId) {
      const pNode = parentNode[cur];
      const eId = parentEdgeIdx[cur];
      if (pNode < 0 || eId < 0) break;
      revEdges.push(this.edges[eId]);
      revNodes.push(pNode);
      cur = pNode;
    }
    revEdges.reverse();
    revNodes.reverse();

    const coords: [number, number][] = [];
    let totalDistM = 0;
    let totalDurSec = 0;
    for (let i = 0; i < revEdges.length; i += 1) {
      const e = revEdges[i];
      totalDistM += e.distanceM;
      totalDurSec += e.baseDurationSec;
      const geom = e.geometry;
      const startOffset = i === 0 ? 0 : 1;
      for (let g = startOffset; g < geom.length; g += 1) {
        coords.push([geom[g][0], geom[g][1]]);
      }
    }

    const cleanedCoords = deduplicateCoords(coords);
    const result: RoadPathResult = {
      nodeIds: revNodes,
      pathCoords: cleanedCoords,
      totalDistanceM: totalDistM,
      totalDurationSec: Math.max(1, totalDurSec),
      averageSpeedMps: totalDurSec > 0 ? totalDistM / totalDurSec : 10,
      reachable: true,
    };

    if (useCache) {
      if (this.pathCache.size >= PATH_CACHE_MAX_ENTRIES) {
        this.pathCache.clear();
      }
      this.pathCache.set(cacheKey, result);
    }
    return result;
  }

  /**
   * Calibrate all road edge speeds and base travel durations using the regional OSRM
   * `/table/v1/driving/` travel-time ratio for this fixed city location.
   */
  public applyOsrmSpeedCalibration(scale: number, upgradeSource = true): void {
    const clamped = Math.max(0.45, Math.min(1.65, Number(scale.toFixed(4))));
    if (Math.abs(clamped - this.osrmSpeedScale) < 1e-4 && (!upgradeSource || this.source === 'osrm-calibrated-osm')) {
      return;
    }
    const relFactor = clamped / this.osrmSpeedScale;
    this.osrmSpeedScale = clamped;
    for (const edge of this.edges) {
      edge.speedLimitMps = Math.max(3.5, Math.min(28.0, edge.speedLimitMps * relFactor));
      edge.baseDurationSec = Math.max(0.2, edge.distanceM / edge.speedLimitMps);
    }
    if (upgradeSource && (this.source === 'overpass' || this.source === 'vector-tiles')) {
      this.source = 'osrm-calibrated-osm';
    }
    this.pathCache.clear();
  }

  /**
   * Compute full KxK asymmetric road-network travel-time (`durationsSec`) and distance (`distancesM`)
   * matrices across `nodeIds` using early-terminating multi-target Dijkstra per unique origin node.
   */
  public computeDistanceDurationMatrix(
    nodeIds: readonly number[],
    edgeSpeedMultiplier?: (lat: number, lon: number) => number,
  ): { durationsSec: Float64Array; distancesM: Float64Array; dim: number } {
    const dim = nodeIds.length;
    const durationsSec = new Float64Array(dim * dim);
    const distancesM = new Float64Array(dim * dim);
    if (dim === 0 || this.nodes.length === 0) {
      return { durationsSec, distancesM, dim };
    }

    const nCount = this.nodes.length;
    // Group matrix indices by valid road node ID so duplicate node coordinates run Dijkstra only once
    const uniqueSources = new Map<number, number[]>();
    const targetNodeSet = new Set<number>();
    for (let i = 0; i < dim; i += 1) {
      const nid = nodeIds[i];
      if (nid >= 0 && nid < nCount) {
        let list = uniqueSources.get(nid);
        if (!list) {
          list = [];
          uniqueSources.set(nid, list);
        }
        list.push(i);
        targetNodeSet.add(nid);
      }
    }

    const distDur = new Float64Array(nCount);
    const distMeters = new Float64Array(nCount);
    const settled = new Uint8Array(nCount);
    const heap = new MinHeap<number>();

    for (const [srcNode, rowIndices] of uniqueSources.entries()) {
      distDur.fill(Number.POSITIVE_INFINITY);
      distMeters.fill(0);
      settled.fill(0);
      while (heap.size > 0) heap.pop();

      distDur[srcNode] = 0;
      distMeters[srcNode] = 0;
      heap.push(0, srcNode);

      let remainingTargets = targetNodeSet.size;
      while (heap.size > 0 && remainingTargets > 0) {
        const top = heap.pop()!;
        const u = top.value;
        if (settled[u]) continue;
        settled[u] = 1;
        if (targetNodeSet.has(u)) {
          remainingTargets -= 1;
          if (remainingTargets === 0) break;
        }

        const adj = this.outgoing[u];
        const curDur = distDur[u];
        const curDist = distMeters[u];
        for (let i = 0; i < adj.length; i += 1) {
          const edge = adj[i];
          const v = edge.to;
          if (settled[v]) continue;
          let edgeDur = edge.baseDurationSec;
          if (edgeSpeedMultiplier) {
            const midPt = edge.geometry[edge.geometry.length >>> 1];
            const mult = Math.max(0.25, Math.min(1.5, edgeSpeedMultiplier(midPt[1], midPt[0])));
            edgeDur = edge.baseDurationSec / mult;
          }
          const candDur = curDur + edgeDur;
          if (candDur < distDur[v]) {
            distDur[v] = candDur;
            distMeters[v] = curDist + edge.distanceM;
            heap.push(candDur, v);
          }
        }
      }

      const srcPt = this.nodes[srcNode];
      for (let col = 0; col < dim; col += 1) {
        const dstNode = nodeIds[col];
        let dur = 0;
        let dM = 0;
        if (dstNode !== srcNode) {
          if (dstNode >= 0 && dstNode < nCount && Number.isFinite(distDur[dstNode])) {
            dur = distDur[dstNode];
            dM = distMeters[dstNode];
          } else if (dstNode >= 0 && dstNode < nCount) {
            const dstPt = this.nodes[dstNode];
            dM = haversineMeters(srcPt.lat, srcPt.lon, dstPt.lat, dstPt.lon) * 1.3;
            dur = dM / 10.5;
          }
        }
        for (const r of rowIndices) {
          const cell = r * dim + col;
          durationsSec[cell] = dur;
          distancesM[cell] = dM;
        }
      }
    }

    return { durationsSec, distancesM, dim };
  }

  public toSerialized(): SerializedRoadGraph {
    return {
      version: 2,
      bookmarkId: this.bookmarkId,
      source: this.source,
      osrmSpeedScale: this.osrmSpeedScale,
      nodes: this.nodes,
      edges: this.edges,
    };
  }

  public static fromSerialized(data: SerializedRoadGraph): RoadNetworkGraph | null {
    if (
      !data ||
      data.version !== 2 ||
      !Array.isArray(data.nodes) ||
      !Array.isArray(data.edges) ||
      data.nodes.length < 20 ||
      data.edges.length < 30
    ) {
      return null;
    }
    return new RoadNetworkGraph(
      data.bookmarkId,
      data.source,
      data.nodes,
      data.edges,
      typeof data.osrmSpeedScale === 'number' ? data.osrmSpeedScale : 1.0,
    );
  }

  /** Export edge polylines for optional map debug overlay (bounded to keep GPU frames fast). */
  public getDebugEdgePaths(maxEdges = 2500): { path: [number, number][]; roadClass: RoadClass }[] {
    const seen = new Set<string>();
    const result: { path: [number, number][]; roadClass: RoadClass }[] = [];
    for (const e of this.edges) {
      const pairKey = e.from < e.to ? `${e.from}:${e.to}` : `${e.to}:${e.from}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      result.push({ path: e.geometry, roadClass: e.roadClass });
      if (result.length >= maxEdges) break;
    }
    return result;
  }
}

/** Iterative Tarjan's Strongly Connected Components returning the largest SCC node set. */
function findLargestScc(numNodes: number, adj: number[][]): Set<number> {
  const index = new Int32Array(numNodes).fill(-1);
  const lowlink = new Int32Array(numNodes);
  const onStack = new Uint8Array(numNodes);
  const stack: number[] = [];
  let currentIndex = 0;
  let bestScc: number[] = [];

  for (let start = 0; start < numNodes; start += 1) {
    if (index[start] !== -1) continue;

    // Iterative DFS frame: [node, nextNeighborIdx]
    const callStack: [number, number][] = [[start, 0]];
    index[start] = currentIndex;
    lowlink[start] = currentIndex;
    currentIndex += 1;
    stack.push(start);
    onStack[start] = 1;

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const v = frame[0];
      const neighbors = adj[v];

      if (frame[1] < neighbors.length) {
        const w = neighbors[frame[1]];
        frame[1] += 1;
        if (index[w] === -1) {
          index[w] = currentIndex;
          lowlink[w] = currentIndex;
          currentIndex += 1;
          stack.push(w);
          onStack[w] = 1;
          callStack.push([w, 0]);
        } else if (onStack[w]) {
          if (index[w] < lowlink[v]) lowlink[v] = index[w];
        }
      } else {
        callStack.pop();
        if (lowlink[v] === index[v]) {
          const component: number[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack[w] = 0;
            component.push(w);
            if (w === v) break;
          }
          if (component.length > bestScc.length) {
            bestScc = component;
          }
        }
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1][0];
          if (lowlink[v] < lowlink[parent]) lowlink[parent] = lowlink[v];
        }
      }
    }
  }

  return new Set(bestScc);
}

/**
 * Detect 2D segment crossings among surface road segments (using a ~200m spatial cell index)
 * and split both segments at the intersection point. This ensures simplified OpenMapTiles
 * vector-tile streets at zoom 12 connect cleanly at crossings even when they omit shared vertices.
 */
function nodeCrossingSegments(
  segments: readonly RawRoadSegment[],
  refLat: number,
  maxSurfaceEdges = 18000,
): RawRoadSegment[] {
  interface AtomicSeg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
    roadClass: RoadClass;
    oneway: boolean;
    speedLimitMps?: number;
    gradeSep: boolean;
    splits: number[]; // parametric t in (0, 1)
  }

  const atomic: AtomicSeg[] = [];
  for (const seg of segments) {
    if (seg.coords.length < 2) continue;
    for (let i = 0; i < seg.coords.length - 1; i += 1) {
      const a = seg.coords[i];
      const b = seg.coords[i + 1];
      if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) continue;
      atomic.push({
        ax: a[0],
        ay: a[1],
        bx: b[0],
        by: b[1],
        roadClass: seg.roadClass,
        oneway: seg.oneway,
        speedLimitMps: seg.speedLimitMps,
        gradeSep: Boolean(seg.isGradeSeparated),
        splits: [],
      });
    }
  }

  const cosLat = Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  const cellLat = 0.002; // ~220m
  const cellLon = cellLat / cosLat;
  const grid = new Map<string, number[]>();

  const surfaceLimit = Math.min(atomic.length, maxSurfaceEdges);
  for (let idx = 0; idx < surfaceLimit; idx += 1) {
    const s = atomic[idx];
    if (s.gradeSep) continue;
    const minR = Math.floor(Math.min(s.ay, s.by) / cellLat);
    const maxR = Math.floor(Math.max(s.ay, s.by) / cellLat);
    const minC = Math.floor(Math.min(s.ax, s.bx) / cellLon);
    const maxC = Math.floor(Math.max(s.ax, s.bx) / cellLon);
    // Guard against huge anomalous edges spanning too many cells
    if ((maxR - minR + 1) * (maxC - minC + 1) > 36) continue;
    for (let r = minR; r <= maxR; r += 1) {
      for (let c = minC; c <= maxC; c += 1) {
        const key = `${r}:${c}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(idx);
      }
    }
  }

  const checkedPairs = new Set<number>();
  for (const bucket of grid.values()) {
    const len = Math.min(bucket.length, 48);
    for (let i = 0; i < len; i += 1) {
      const idx1 = bucket[i];
      const s1 = atomic[idx1];
      const r1x = s1.bx - s1.ax;
      const r1y = s1.by - s1.ay;
      for (let j = i + 1; j < len; j += 1) {
        const idx2 = bucket[j];
        const pairKey = idx1 < idx2 ? idx1 * 100_000 + idx2 : idx2 * 100_000 + idx1;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        const s2 = atomic[idx2];
        // Quick AABB rejection
        if (
          Math.max(s1.ax, s1.bx) < Math.min(s2.ax, s2.bx) ||
          Math.min(s1.ax, s1.bx) > Math.max(s2.ax, s2.bx) ||
          Math.max(s1.ay, s1.by) < Math.min(s2.ay, s2.by) ||
          Math.min(s1.ay, s1.by) > Math.max(s2.ay, s2.by)
        ) {
          continue;
        }

        const r2x = s2.bx - s2.ax;
        const r2y = s2.by - s2.ay;
        const denom = r1x * r2y - r1y * r2x;
        if (Math.abs(denom) < 1e-12) continue;

        const qpx = s2.ax - s1.ax;
        const qpy = s2.ay - s1.ay;
        const t = (qpx * r2y - qpy * r2x) / denom;
        const u = (qpx * r1y - qpy * r1x) / denom;

        if (t > 0.03 && t < 0.97 && u > 0.03 && u < 0.97) {
          s1.splits.push(t);
          s2.splits.push(u);
        }
      }
    }
  }

  const out: RawRoadSegment[] = [];
  for (const s of atomic) {
    if (s.splits.length === 0) {
      out.push({
        coords: [
          [s.ax, s.ay],
          [s.bx, s.by],
        ],
        roadClass: s.roadClass,
        oneway: s.oneway,
        speedLimitMps: s.speedLimitMps,
      });
      continue;
    }
    s.splits.sort((a, b) => a - b);
    const pts: [number, number][] = [[s.ax, s.ay]];
    let prevT = 0;
    for (const t of s.splits) {
      if (t - prevT < 0.02) continue;
      pts.push([
        Number((s.ax + (s.bx - s.ax) * t).toFixed(6)),
        Number((s.ay + (s.by - s.ay) * t).toFixed(6)),
      ]);
      prevT = t;
    }
    pts.push([s.bx, s.by]);
    out.push({
      coords: pts,
      roadClass: s.roadClass,
      oneway: s.oneway,
      speedLimitMps: s.speedLimitMps,
    });
  }
  return out;
}

/**
 * Build a clean, strongly connected, degree-2-compacted `RoadNetworkGraph`
 * from raw polylines (extracted from MapLibre tiles, Overpass, or curved fallback).
 *
 * Uses 3x3 true-radius spatial clustering (eliminating bucket-boundary splits) and
 * 2D crossing-segment noding so real OSM vector tiles fuse into a dense connected graph.
 */
export function buildRoadNetworkGraph(
  bookmarkId: BookmarkId,
  source: RoadNetworkSource,
  segments: readonly RawRoadSegment[],
  snapMeters = 12,
): RoadNetworkGraph {
  if (segments.length === 0) {
    return new RoadNetworkGraph(bookmarkId, source, [], []);
  }

  const city = BOOKMARK_BY_ID[bookmarkId];
  const nodedSegments =
    source === 'vector-tiles'
      ? nodeCrossingSegments(segments, city.lat)
      : segments;

  const cosLat = Math.max(0.2, Math.cos((city.lat * Math.PI) / 180));
  const cellLatDeg = Math.max(2, snapMeters) / 111_320;
  const cellLonDeg = Math.max(2, snapMeters) / (111_320 * cosLat);

  // 1. True-radius spatial clustering checking all 3x3 neighbor cells (zero boundary splits!)
  const spatialBuckets = new Map<string, number[]>();
  const rawLatSum: number[] = [];
  const rawLonSum: number[] = [];
  const rawCount: number[] = [];

  const getOrCreateRawNode = (lon: number, lat: number, searchRadiusM = snapMeters): number => {
    const r = Math.floor(lat / cellLatDeg);
    const c = Math.floor(lon / cellLonDeg);
    let bestId = -1;
    let bestDist = searchRadiusM;

    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const bucket = spatialBuckets.get(`${r + dr}:${c + dc}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const nid = bucket[i];
          const nLat = rawLatSum[nid] / rawCount[nid];
          const nLon = rawLonSum[nid] / rawCount[nid];
          const d = haversineMeters(lat, lon, nLat, nLon);
          if (d <= bestDist) {
            bestDist = d;
            bestId = nid;
          }
        }
      }
    }

    if (bestId !== -1) {
      // Pin first coordinate rather than drifting centroid so road geometry stays pixel-aligned with basemap
      return bestId;
    }

    const id = rawLatSum.length;
    rawLatSum.push(lat);
    rawLonSum.push(lon);
    rawCount.push(1);
    const key = `${r}:${c}`;
    let bucket = spatialBuckets.get(key);
    if (!bucket) {
      bucket = [];
      spatialBuckets.set(key, bucket);
    }
    bucket.push(id);
    return id;
  };

  interface RawDirEdge {
    u: number;
    v: number;
    roadClass: RoadClass;
    speedLimitMps: number;
  }

  const rawDirEdges: RawDirEdge[] = [];
  const dedupEdgeSet = new Set<string>();

  const pushDirEdge = (u: number, v: number, roadClass: RoadClass, speedLimitMps: number) => {
    if (u === v) return;
    const key = `${u}->${v}`;
    if (dedupEdgeSet.has(key)) return;
    dedupEdgeSet.add(key);
    rawDirEdges.push({ u, v, roadClass, speedLimitMps });
  };

  // Use tighter snap radius (1.5m) for intermediate curve vertices so closely-spaced
  // road bends are never collapsed into straight lines, while endpoints snap within `snapMeters`.
  const intermediateSnapM = Math.min(1.5, snapMeters);
  for (const seg of nodedSegments) {
    const coords = seg.coords;
    if (coords.length < 2) continue;
    const speedMps = seg.speedLimitMps ?? ROAD_CLASS_SPEED_MPS[seg.roadClass];
    let prevId = getOrCreateRawNode(coords[0][0], coords[0][1], snapMeters);
    for (let i = 1; i < coords.length; i += 1) {
      const isEndpoint = i === coords.length - 1;
      const radius = isEndpoint ? snapMeters : intermediateSnapM;
      const curId = getOrCreateRawNode(coords[i][0], coords[i][1], radius);
      if (curId !== prevId) {
        pushDirEdge(prevId, curId, seg.roadClass, speedMps);
        if (!seg.oneway) {
          pushDirEdge(curId, prevId, seg.roadClass, speedMps);
        }
        prevId = curId;
      }
    }
  }

  const rawNodeCount = rawLatSum.length;
  if (rawNodeCount === 0 || rawDirEdges.length === 0) {
    return new RoadNetworkGraph(bookmarkId, source, [], []);
  }

  const rawCoords: [number, number][] = new Array(rawNodeCount);
  for (let i = 0; i < rawNodeCount; i += 1) {
    rawCoords[i] = [
      Number((rawLonSum[i] / rawCount[i]).toFixed(6)),
      Number((rawLatSum[i] / rawCount[i]).toFixed(6)),
    ];
  }

  // 2. Compute largest Strongly Connected Component (SCC) so every pair of nodes is reachable
  let adjIds: number[][] = Array.from({ length: rawNodeCount }, () => []);
  for (const e of rawDirEdges) {
    adjIds[e.u].push(e.v);
  }
  let keepSet = findLargestScc(rawNodeCount, adjIds);

  // If clipped one-ways shrink the directed SCC too aggressively, add reverse edges at reduced speed
  if (keepSet.size < Math.min(60, Math.floor(rawNodeCount * 0.25))) {
    const augmented = [...rawDirEdges];
    for (const e of rawDirEdges) {
      const revKey = `${e.v}->${e.u}`;
      if (!dedupEdgeSet.has(revKey)) {
        dedupEdgeSet.add(revKey);
        augmented.push({
          u: e.v,
          v: e.u,
          roadClass: e.roadClass,
          speedLimitMps: Math.max(4.5, e.speedLimitMps * 0.7),
        });
      }
    }
    rawDirEdges.length = 0;
    rawDirEdges.push(...augmented);
    adjIds = Array.from({ length: rawNodeCount }, () => []);
    for (const e of rawDirEdges) {
      adjIds[e.u].push(e.v);
    }
    keepSet = findLargestScc(rawNodeCount, adjIds);
  }

  // Filter edges to largest SCC
  const sccEdges = rawDirEdges.filter((e) => keepSet.has(e.u) && keepSet.has(e.v));

  // 3. Compact pure pass-through vertices (in-degree + out-degree topology) into curved RoadEdges
  const outMap = new Map<number, RawDirEdge[]>();
  const inMap = new Map<number, RawDirEdge[]>();
  const neighborSet = new Map<number, Set<number>>();

  for (const e of sccEdges) {
    let o = outMap.get(e.u);
    if (!o) {
      o = [];
      outMap.set(e.u, o);
    }
    o.push(e);

    let inc = inMap.get(e.v);
    if (!inc) {
      inc = [];
      inMap.set(e.v, inc);
    }
    inc.push(e);

    let nu = neighborSet.get(e.u);
    if (!nu) {
      nu = new Set();
      neighborSet.set(e.u, nu);
    }
    nu.add(e.v);
    let nv = neighborSet.get(e.v);
    if (!nv) {
      nv = new Set();
      neighborSet.set(e.v, nv);
    }
    nv.add(e.u);
  }

  // A node is kept as a graph intersection if it has != 2 distinct undirected neighbors,
  // or if incoming/outgoing road classes differ.
  const isIntersection = new Set<number>();
  for (const u of keepSet) {
    const nbrs = neighborSet.get(u);
    const outs = outMap.get(u) ?? [];
    const ins = inMap.get(u) ?? [];
    if (!nbrs || nbrs.size !== 2) {
      isIntersection.add(u);
      continue;
    }
    // Check consistent pass-through (either 1-in/1-out oneway or 2-in/2-out bidirectional)
    const isCleanOneWay = outs.length === 1 && ins.length === 1 && outs[0].v !== ins[0].u;
    const isCleanTwoWay = outs.length === 2 && ins.length === 2;
    if (!isCleanOneWay && !isCleanTwoWay) {
      isIntersection.add(u);
      continue;
    }
    const firstClass = outs[0].roadClass;
    if (
      outs.some((e) => e.roadClass !== firstClass) ||
      ins.some((e) => e.roadClass !== firstClass)
    ) {
      isIntersection.add(u);
    }
  }

  // Ensure pure cycle loops still have at least 2 anchor intersections
  if (isIntersection.size < 2) {
    for (const u of keepSet) {
      isIntersection.add(u);
    }
  }

  // Remap kept intersections to dense [0..N-1] IDs
  const oldToNew = new Map<number, number>();
  const finalNodes: RoadNode[] = [];
  for (const oldId of isIntersection) {
    const newId = finalNodes.length;
    oldToNew.set(oldId, newId);
    const [lon, lat] = rawCoords[oldId];
    finalNodes.push({ id: newId, lat, lon });
  }

  const finalEdges: RoadEdge[] = [];
  const visitedStartEdges = new Set<string>();

  for (const startOld of isIntersection) {
    const outs = outMap.get(startOld) ?? [];
    for (const firstEdge of outs) {
      const startKey = `${firstEdge.u}->${firstEdge.v}`;
      if (visitedStartEdges.has(startKey)) continue;
      visitedStartEdges.add(startKey);

      const geom: [number, number][] = [rawCoords[firstEdge.u]];
      let curEdge = firstEdge;
      let prevOld = firstEdge.u;
      let curOld = firstEdge.v;
      let totalDistM = haversineMeters(
        rawCoords[prevOld][1],
        rawCoords[prevOld][0],
        rawCoords[curOld][1],
        rawCoords[curOld][0],
      );
      let weightedSpeedSum = totalDistM * curEdge.speedLimitMps;
      let guard = 0;

      while (!isIntersection.has(curOld) && guard < 256) {
        guard += 1;
        geom.push(rawCoords[curOld]);
        const nextCandidates = (outMap.get(curOld) ?? []).filter((e) => e.v !== prevOld);
        if (nextCandidates.length !== 1) break;
        const nextEdge = nextCandidates[0];
        prevOld = curOld;
        curOld = nextEdge.v;
        curEdge = nextEdge;
        const segM = haversineMeters(
          rawCoords[prevOld][1],
          rawCoords[prevOld][0],
          rawCoords[curOld][1],
          rawCoords[curOld][0],
        );
        totalDistM += segM;
        weightedSpeedSum += segM * curEdge.speedLimitMps;
      }
      geom.push(rawCoords[curOld]);

      const fromNew = oldToNew.get(startOld);
      const toNew = oldToNew.get(curOld);
      if (fromNew === undefined || toNew === undefined || fromNew === toNew) continue;

      const safeDistM = Math.max(5, totalDistM);
      const avgSpeedMps = Math.max(4.5, weightedSpeedSum / Math.max(1, totalDistM));
      finalEdges.push({
        id: finalEdges.length,
        from: fromNew,
        to: toNew,
        distanceM: safeDistM,
        speedLimitMps: avgSpeedMps,
        baseDurationSec: safeDistM / avgSpeedMps,
        roadClass: firstEdge.roadClass,
        geometry: deduplicateCoords(geom),
      });
    }
  }

  return new RoadNetworkGraph(bookmarkId, source, finalNodes, finalEdges);
}

/**
 * Tier 1: Extract real OSM drivable road segments directly from loaded MapLibre vector tiles.
 */
export function extractRoadNetworkFromMapLibre(
  map: maplibregl.Map,
  bookmarkId: BookmarkId,
  radiusMeters = 6800,
): RoadNetworkGraph | null {
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return null;

  const city = BOOKMARK_BY_ID[bookmarkId];
  const sourceLayerPairs = new Map<string, Set<string>>();

  for (const layer of style.layers) {
    if (layer.type !== 'line') continue;
    const src = 'source' in layer ? layer.source : undefined;
    const srcLayer = 'source-layer' in layer ? layer['source-layer'] : undefined;
    if (typeof src !== 'string' || typeof srcLayer !== 'string') continue;
    const lowerLayer = srcLayer.toLowerCase();
    if (
      lowerLayer === 'transportation' ||
      lowerLayer === 'road' ||
      lowerLayer.includes('road') ||
      lowerLayer.includes('transport')
    ) {
      let set = sourceLayerPairs.get(src);
      if (!set) {
        set = new Set();
        sourceLayerPairs.set(src, set);
      }
      set.add(srcLayer);
    }
  }

  if (sourceLayerPairs.size === 0) return null;

  const rawSegments: RawRoadSegment[] = [];
  const maxLatDelta = metersToLatDeg(radiusMeters);
  const maxLonDelta = metersToLonDeg(radiusMeters, city.lat);
  const minLat = city.lat - maxLatDelta;
  const maxLat = city.lat + maxLatDelta;
  const minLon = city.lon - maxLonDelta;
  const maxLon = city.lon + maxLonDelta;

  for (const [sourceId, layers] of sourceLayerPairs.entries()) {
    for (const sourceLayer of layers) {
      let features: ReturnType<maplibregl.Map['querySourceFeatures']> = [];
      try {
        features = map.querySourceFeatures(sourceId, { sourceLayer });
      } catch {
        continue;
      }

      for (const feat of features) {
        const props = (feat.properties ?? {}) as Record<string, unknown>;
        const roadClass =
          normalizeRoadClass(props.class) ??
          normalizeRoadClass(props.subclass) ??
          normalizeRoadClass(props.highway);
        if (!roadClass) continue;

        // Skip ferry routes; mark bridges/tunnels as grade-separated for crossing noding
        if (props.brunnel === 'ferry') continue;
        const isGradeSeparated = props.brunnel === 'bridge' || props.brunnel === 'tunnel';
        const oneway = props.oneway === 1 || props.oneway === '1' || props.oneway === 'yes';

        const geom = feat.geometry;
        const lines: [number, number][][] = [];
        if (geom.type === 'LineString') {
          lines.push(geom.coordinates as [number, number][]);
        } else if (geom.type === 'MultiLineString') {
          for (const line of geom.coordinates) {
            lines.push(line as [number, number][]);
          }
        }

        for (const line of lines) {
          if (line.length < 2) continue;
          // Quick bounding-box relevance check
          let inBounds = false;
          for (let i = 0; i < line.length; i += 1) {
            const [lon, lat] = line[i];
            if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
              inBounds = true;
              break;
            }
          }
          if (!inBounds) continue;

          rawSegments.push({
            coords: line.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
            roadClass,
            oneway,
            isGradeSeparated,
          });
        }
      }
    }
  }

  if (rawSegments.length < 12) return null;
  const graph = buildRoadNetworkGraph(bookmarkId, 'vector-tiles', rawSegments, 10);
  if (graph.nodes.length < 12 || graph.edges.length < 20) {
    return null;
  }
  return graph;
}

/**
 * Tier 2: Build a `RoadNetworkGraph` from the backend Overpass `/api/v1/graph/network` DTO.
 */
export function buildRoadNetworkFromOverpassDto(
  bookmarkId: BookmarkId,
  dto: RoadGraphNetworkDto,
): RoadNetworkGraph | null {
  if (dto.is_degraded || dto.nodes.length < 20 || dto.edges.length < 25) {
    return null;
  }

  const rawSegments: RawRoadSegment[] = [];
  for (const edge of dto.edges) {
    const [uIdx, vIdx, rawClass, oneway, speedMps] = edge;
    const fromPt = dto.nodes[uIdx];
    const toPt = dto.nodes[vIdx];
    if (!fromPt || !toPt) continue;
    const roadClass = normalizeRoadClass(rawClass) ?? 'minor';
    rawSegments.push({
      coords: [
        [fromPt[0], fromPt[1]],
        [toPt[0], toPt[1]],
      ],
      roadClass,
      oneway: Boolean(oneway),
      speedLimitMps: typeof speedMps === 'number' && speedMps > 2 ? speedMps : undefined,
    });
  }

  if (rawSegments.length < 20) return null;
  const graph = buildRoadNetworkGraph(bookmarkId, 'overpass', rawSegments, 3);
  if (graph.nodes.length < 12 || graph.edges.length < 20) {
    return null;
  }
  return graph;
}

/**
 * Tier 3: Deterministic Hub-Connected Street Grid Fallback (Zero Bezier Curves).
 *
 * Used only during initial cold-boot milliseconds before IndexedDB / Overpass / MapLibre
 * road network hydration completes, or in offline headless unit tests.
 */
export function createFallbackUrbanRoadGraph(bookmarkId: BookmarkId): RoadNetworkGraph {
  const city = BOOKMARK_BY_ID[bookmarkId];
  const hubs = city.hubCoords;

  const centerLat =
    hubs.reduce((acc, h) => acc + h.lat, 0) / Math.max(1, hubs.length);
  const centerLon =
    hubs.reduce((acc, h) => acc + h.lon, 0) / Math.max(1, hubs.length);

  let maxHubDistM = 2800;
  for (const h of hubs) {
    const d = haversineMeters(centerLat, centerLon, h.lat, h.lon);
    if (d > maxHubDistM) maxHubDistM = d;
  }
  const extentM = Math.max(3200, Math.min(5400, maxHubDistM * 1.15));
  const gridSteps = 8; // 9x9 intersection grid

  const gridNodes: [number, number][][] = [];
  for (let r = 0; r <= gridSteps; r += 1) {
    const row: [number, number][] = [];
    const fracLat = (r / gridSteps) * 2 - 1;
    const lat = Number((centerLat + metersToLatDeg(fracLat * extentM)).toFixed(6));
    for (let c = 0; c <= gridSteps; c += 1) {
      const fracLon = (c / gridSteps) * 2 - 1;
      const lon = Number((centerLon + metersToLonDeg(fracLon * extentM, centerLat)).toFixed(6));
      row.push([lon, lat]);
    }
    gridNodes.push(row);
  }

  const rawSegments: RawRoadSegment[] = [];

  for (let r = 0; r <= gridSteps; r += 1) {
    const roadClass: RoadClass = r % 4 === 0 ? 'primary' : r % 2 === 0 ? 'secondary' : 'tertiary';
    for (let c = 0; c < gridSteps; c += 1) {
      rawSegments.push({
        coords: [gridNodes[r][c], gridNodes[r][c + 1]],
        roadClass,
        oneway: false,
      });
    }
  }

  for (let c = 0; c <= gridSteps; c += 1) {
    const roadClass: RoadClass = c % 4 === 0 ? 'primary' : c % 2 === 0 ? 'secondary' : 'tertiary';
    for (let r = 0; r < gridSteps; r += 1) {
      rawSegments.push({
        coords: [gridNodes[r][c], gridNodes[r + 1][c]],
        roadClass,
        oneway: false,
      });
    }
  }

  const allAnchors = gridNodes.flat();
  for (const h of hubs) {
    const hubPt: [number, number] = [Number(h.lon.toFixed(6)), Number(h.lat.toFixed(6))];
    const sorted = [...allAnchors].sort(
      (p1, p2) =>
        haversineMeters(h.lat, h.lon, p1[1], p1[0]) -
        haversineMeters(h.lat, h.lon, p2[1], p2[0]),
    );
    for (let k = 0; k < Math.min(2, sorted.length); k += 1) {
      rawSegments.push({
        coords: [hubPt, sorted[k]],
        roadClass: 'primary',
        oneway: false,
      });
    }
  }

  return buildRoadNetworkGraph(bookmarkId, 'fallback-grid', rawSegments, 10);
}
