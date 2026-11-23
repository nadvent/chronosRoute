/**
 * Pure geodesic & polyline kinematics utilities for road-aligned vehicle travel.
 *
 * Coordinate convention:
 * - Path arrays use deck.gl / GeoJSON `[lon, lat]` tuples.
 * - Compass bearings use clockwise degrees from true North: 0 = N, 90 = E, 180 = S, 270 = W.
 */

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function metersToLatDeg(meters: number): number {
  return meters / 111_320;
}

export function metersToLonDeg(meters: number, latDeg: number): number {
  const cosLat = Math.max(0.15, Math.cos(latDeg * DEG_TO_RAD));
  return meters / (111_320 * cosLat);
}

/** Great-circle distance in meters between two WGS84 points. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat + Math.cos(phi1) * Math.cos(phi2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Forward spherical compass bearing in `[0, 360)` degrees clockwise from North.
 * Properly accounts for `cos(lat)` meridian convergence at any latitude.
 */
export function computeCompassBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  fallbackDeg = 0,
): number {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  if (Math.abs(dLat) < 1e-11 && Math.abs(dLon) < 1e-11) {
    return ((fallbackDeg % 360) + 360) % 360;
  }
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const lambda = dLon * DEG_TO_RAD;
  const y = Math.sin(lambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda);
  const brng = Math.atan2(y, x) * RAD_TO_DEG;
  return (brng + 360) % 360;
}

/** Shortest-arc angular interpolation between two compass bearings `[0, 360)`. */
export function interpolateBearingDeg(fromDeg: number, toDeg: number, t: number): number {
  const a = ((fromDeg % 360) + 360) % 360;
  const b = ((toDeg % 360) + 360) % 360;
  let diff = b - a;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return (((a + diff * t) % 360) + 360) % 360;
}

/** Decode Google Encoded Polyline (precision 1e5) into `[lon, lat][]`. */
export function decodePolyline5(encoded: string): [number, number][] {
  if (!encoded) return [];
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;
    do {
      if (index >= encoded.length) return coords;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      if (index >= encoded.length) return coords;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

    coords.push([Number((lon / 1e5).toFixed(6)), Number((lat / 1e5).toFixed(6))]);
  }
  return coords;
}

function encodeSignedInt(value: number): string {
  let sgn = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

/** Encode `[lon, lat][]` coordinates into Google Encoded Polyline (precision 1e5). */
export function encodePolyline5(coords: readonly [number, number][]): string {
  if (coords.length === 0) return '';
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lonE5 = Math.round(lon * 1e5);
    out += encodeSignedInt(latE5 - prevLat);
    out += encodeSignedInt(lonE5 - prevLon);
    prevLat = latE5;
    prevLon = lonE5;
  }
  return out;
}

/** Remove consecutive near-duplicate vertices (< 0.5m apart). */
export function deduplicateCoords(coords: readonly [number, number][]): [number, number][] {
  if (coords.length <= 1) return coords.map(([lon, lat]) => [lon, lat]);
  const cleaned: [number, number][] = [[coords[0][0], coords[0][1]]];
  for (let i = 1; i < coords.length; i += 1) {
    const [lon, lat] = coords[i];
    const [pLon, pLat] = cleaned[cleaned.length - 1];
    if (Math.abs(lon - pLon) > 1e-7 || Math.abs(lat - pLat) > 1e-7) {
      cleaned.push([lon, lat]);
    }
  }
  return cleaned;
}

export interface PrecomputedPolyline {
  /** Cleaned `[lon, lat]` vertices. */
  coords: [number, number][];
  /** Length in meters of each segment `i -> i+1`. */
  segmentLengthsM: number[];
  /** Cumulative distance in meters at each vertex `i` (`cumulativeDistM[0] === 0`). */
  cumulativeDistM: number[];
  /** Compass bearing in degrees for each segment `i -> i+1`. */
  segmentBearingsDeg: number[];
  /** Total arc length in meters. */
  totalLengthM: number;
}

export interface PolylineSample {
  lat: number;
  lon: number;
  headingDeg: number;
  segmentIndex: number;
  clampedDistM: number;
}

export function precomputePolyline(
  rawCoords: readonly [number, number][],
  fallbackHeadingDeg = 0,
): PrecomputedPolyline {
  const coords = deduplicateCoords(rawCoords);
  const n = coords.length;
  if (n === 0) {
    return {
      coords: [],
      segmentLengthsM: [],
      cumulativeDistM: [],
      segmentBearingsDeg: [],
      totalLengthM: 0,
    };
  }
  if (n === 1) {
    return {
      coords,
      segmentLengthsM: [],
      cumulativeDistM: [0],
      segmentBearingsDeg: [],
      totalLengthM: 0,
    };
  }

  const segmentLengthsM = new Array<number>(n - 1);
  const cumulativeDistM = new Array<number>(n);
  const segmentBearingsDeg = new Array<number>(n - 1);
  cumulativeDistM[0] = 0;

  let acc = 0;
  let lastBearing = fallbackHeadingDeg;
  for (let i = 0; i < n - 1; i += 1) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const len = haversineMeters(lat1, lon1, lat2, lon2);
    const brng = computeCompassBearingDeg(lat1, lon1, lat2, lon2, lastBearing);
    segmentLengthsM[i] = len;
    segmentBearingsDeg[i] = brng;
    lastBearing = brng;
    acc += len;
    cumulativeDistM[i + 1] = acc;
  }

  return {
    coords,
    segmentLengthsM,
    cumulativeDistM,
    segmentBearingsDeg,
    totalLengthM: acc,
  };
}

/** Find segment index `i` such that `cumulativeDistM[i] <= distM <= cumulativeDistM[i+1]`. */
function findSegmentIndex(cumulativeDistM: readonly number[], distM: number): number {
  const segCount = cumulativeDistM.length - 1;
  if (segCount <= 1) return 0;
  let lo = 0;
  let hi = segCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (cumulativeDistM[mid] <= distM) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** Sample exact WGS84 position and road-aligned compass bearing at arc-length `distM`. */
export function samplePolylineAtDistance(
  poly: PrecomputedPolyline,
  distM: number,
  fallbackHeadingDeg = 0,
): PolylineSample {
  const { coords, segmentLengthsM, cumulativeDistM, segmentBearingsDeg, totalLengthM } = poly;
  if (coords.length === 0) {
    return { lat: 0, lon: 0, headingDeg: fallbackHeadingDeg, segmentIndex: 0, clampedDistM: 0 };
  }
  if (coords.length === 1 || totalLengthM <= 1e-6) {
    const [lon, lat] = coords[0];
    return {
      lat,
      lon,
      headingDeg: segmentBearingsDeg[0] ?? fallbackHeadingDeg,
      segmentIndex: 0,
      clampedDistM: 0,
    };
  }

  const clamped = Math.max(0, Math.min(totalLengthM, distM));
  const segIdx = findSegmentIndex(cumulativeDistM, clamped);
  const segLen = segmentLengthsM[segIdx];
  const segStart = cumulativeDistM[segIdx];
  const frac = segLen > 1e-6 ? Math.max(0, Math.min(1, (clamped - segStart) / segLen)) : 0;

  const [lon1, lat1] = coords[segIdx];
  const [lon2, lat2] = coords[segIdx + 1];
  const lon = lon1 + (lon2 - lon1) * frac;
  const lat = lat1 + (lat2 - lat1) * frac;

  return {
    lat,
    lon,
    headingDeg: segmentBearingsDeg[segIdx],
    segmentIndex: segIdx,
    clampedDistM: clamped,
  };
}

/**
 * Extract the exact road vertex chain between `[startDistM, endDistM]`.
 * Preserves intermediate corner vertices so 60 FPS interpolation follows turns on-road.
 */
export function extractSubpath(
  poly: PrecomputedPolyline,
  startDistM: number,
  endDistM: number,
): [number, number][] {
  if (poly.coords.length === 0) return [];
  if (poly.coords.length === 1 || poly.totalLengthM <= 1e-6) {
    return [[poly.coords[0][0], poly.coords[0][1]]];
  }

  const d0 = Math.max(0, Math.min(poly.totalLengthM, Math.min(startDistM, endDistM)));
  const d1 = Math.max(0, Math.min(poly.totalLengthM, Math.max(startDistM, endDistM)));
  const s0 = samplePolylineAtDistance(poly, d0);
  const s1 = samplePolylineAtDistance(poly, d1);

  const out: [number, number][] = [[s0.lon, s0.lat]];
  for (let i = s0.segmentIndex + 1; i <= s1.segmentIndex; i += 1) {
    const pt = poly.coords[i];
    if (pt) {
      out.push([pt[0], pt[1]]);
    }
  }
  out.push([s1.lon, s1.lat]);
  return deduplicateCoords(out);
}

/**
 * Return the remaining portion of `poly` starting at `distM` through its final vertex.
 */
export function sliceRemainingPolyline(
  poly: PrecomputedPolyline,
  distM: number,
): [number, number][] {
  if (poly.coords.length === 0) return [];
  if (poly.coords.length === 1 || poly.totalLengthM <= 1e-6) {
    return [[poly.coords[0][0], poly.coords[0][1]]];
  }
  const clamped = Math.max(0, Math.min(poly.totalLengthM, distM));
  const sample = samplePolylineAtDistance(poly, clamped);
  const remaining: [number, number][] = [
    [Number(sample.lon.toFixed(6)), Number(sample.lat.toFixed(6))],
  ];
  for (let i = sample.segmentIndex + 1; i < poly.coords.length; i += 1) {
    remaining.push([poly.coords[i][0], poly.coords[i][1]]);
  }
  return deduplicateCoords(remaining);
}

/**
 * Minimum distance in meters from a point `(lat, lon)` to any segment of a polyline.
 * Useful for road-adherence verification and map matching.
 */
export function pointToPolylineDistanceMeters(
  lat: number,
  lon: number,
  coords: readonly [number, number][],
): number {
  if (coords.length === 0) return Number.POSITIVE_INFINITY;
  if (coords.length === 1) {
    return haversineMeters(lat, lon, coords[0][1], coords[0][0]);
  }
  const cosLat = Math.max(0.15, Math.cos(lat * DEG_TO_RAD));
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * cosLat;

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [axLon, axLat] = coords[i];
    const [bxLon, bxLat] = coords[i + 1];
    const ax = (axLon - lon) * mPerDegLon;
    const ay = (axLat - lat) * mPerDegLat;
    const bx = (bxLon - lon) * mPerDegLon;
    const by = (bxLat - lat) * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 1e-6) {
      t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
    }
    const px = ax + t * dx;
    const py = ay + t * dy;
    const dist = Math.hypot(px, py);
    if (dist < best) best = dist;
  }
  return best;
}

/** Sample a quadratic Bezier curve from `p0` through control point `ctrl` to `p2`. */
export function sampleQuadraticBezier(
  p0: readonly [number, number],
  ctrl: readonly [number, number],
  p2: readonly [number, number],
  segments = 5,
): [number, number][] {
  const steps = Math.max(2, Math.round(segments));
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    const lon = u * u * p0[0] + 2 * u * t * ctrl[0] + t * t * p2[0];
    const lat = u * u * p0[1] + 2 * u * t * ctrl[1] + t * t * p2[1];
    out.push([Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
  }
  return out;
}

/**
 * Return cleaned road polyline vertices preserving exact OpenStreetMap intersection geometry
 * without synthetic Bezier curve distortion.
 */
export function smoothPathCorners(
  rawCoords: readonly [number, number][],
  _filletMeters = 0,
  _arcSteps = 0,
): [number, number][] {
  return deduplicateCoords(rawCoords);
}
