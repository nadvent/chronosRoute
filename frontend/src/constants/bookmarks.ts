import type { BookmarkId, CourierStatus, LocationBookmark, OrderStatus } from '../types/chronos';

/**
 * Curated global logistics command bookmarks.
 * Default region is London (51.5074, -0.1278), synchronized with `seed_generator.py` and `solver-cpp`.
 */
export const LOCATION_BOOKMARKS: readonly LocationBookmark[] = [
  {
    id: 'london',
    name: 'London',
    countryCode: 'UK',
    metroArea: 'Greater London',
    lat: 51.5074,
    lon: -0.1278,
    zoom: 12.3,
    isDefault: true,
    weatherModel: 'UKMO / ICON-EU',
    weatherResolutionKm: '2.2 km',
    osmCoverage: 'Dense TfL & Central London Arterial OSM',
    hubNames: ['Canary Wharf Hub', 'Soho West Depot', 'Stratford East', 'Vauxhall South'],
    hubCoords: [
      { name: 'Canary Wharf Hub', lat: 51.5068, lon: -0.0680 },
      { name: 'Soho West Depot', lat: 51.5142, lon: -0.1365 },
      { name: 'Stratford East', lat: 51.5270, lon: -0.0785 },
      { name: 'Vauxhall South', lat: 51.4875, lon: -0.1235 },
    ],
    description: 'UKMO & ICON-EU mesoscale weather + dense Central London OSM road graph.',
  },
  {
    id: 'kl',
    name: 'Kuala Lumpur',
    countryCode: 'MY',
    metroArea: 'Klang Valley Metro',
    lat: 3.1390,
    lon: 101.6869,
    zoom: 12.3,
    weatherModel: 'ECMWF IFS',
    weatherResolutionKm: '9.0 km',
    osmCoverage: 'Klang Valley Expressways & Dense Urban OSM',
    hubNames: ['KLCC Central Hub', 'Bangsar South', 'Petaling Jaya', 'Cheras Depot'],
    hubCoords: [
      { name: 'KLCC Central Hub', lat: 3.1569, lon: 101.7115 },
      { name: 'Bangsar South', lat: 3.1185, lon: 101.6710 },
      { name: 'Petaling Jaya', lat: 3.1495, lon: 101.6535 },
      { name: 'Cheras Depot', lat: 3.1170, lon: 101.7185 },
    ],
    description: 'Tropical monsoon convective storm cells (ECMWF 9 km) + Klang Valley highway graph.',
  },
  {
    id: 'singapore',
    name: 'Singapore',
    countryCode: 'SG',
    metroArea: 'Singapore Island',
    lat: 1.3521,
    lon: 103.8198,
    zoom: 12.2,
    weatherModel: 'ECMWF / GFS Tropical',
    weatherResolutionKm: '9.0 km',
    osmCoverage: 'Island-Wide Expressway & HDB Micro-Grid',
    hubNames: ['Marina Bay Hub', 'Jurong East', 'Changi Logistics', 'Woodlands North'],
    hubCoords: [
      { name: 'Marina Bay Hub', lat: 1.3205, lon: 103.8440 },
      { name: 'Jurong East', lat: 1.3485, lon: 103.7765 },
      { name: 'Changi Logistics', lat: 1.3510, lon: 103.8725 },
      { name: 'Woodlands North', lat: 1.3845, lon: 103.8290 },
    ],
    description: 'High-density island logistics network with tropical squall simulation.',
  },
  {
    id: 'berlin',
    name: 'Berlin',
    countryCode: 'DE',
    metroArea: 'Berlin-Brandenburg',
    lat: 52.5200,
    lon: 13.4050,
    zoom: 12.2,
    weatherModel: 'DWD ICON-D2',
    weatherResolutionKm: '2.2 km',
    osmCoverage: 'High-Precision Berlin Ring & Arterial OSM',
    hubNames: ['Mitte Alexanderplatz', 'Kreuzberg South', 'Charlottenburg', 'Lichtenberg'],
    hubCoords: [
      { name: 'Mitte Alexanderplatz', lat: 52.5219, lon: 13.4132 },
      { name: 'Kreuzberg South', lat: 52.4986, lon: 13.4033 },
      { name: 'Charlottenburg', lat: 52.5150, lon: 13.3380 },
      { name: 'Lichtenberg', lat: 52.5180, lon: 13.4680 },
    ],
    description: 'DWD ICON-D2 2.2 km convective grid + symmetric European street network.',
  },
  {
    id: 'sf',
    name: 'San Francisco',
    countryCode: 'US',
    metroArea: 'SF Bay Area',
    lat: 37.7749,
    lon: -122.4194,
    zoom: 12.4,
    weatherModel: 'NOAA HRRR',
    weatherResolutionKm: '3.0 km',
    osmCoverage: 'SF Peninsula Steep-Grade & Bay Bridge OSM',
    hubNames: ['SoMa Micro-Hub', 'Mission District', 'Presidio North', 'Dogpatch Pier'],
    hubCoords: [
      { name: 'SoMa Micro-Hub', lat: 37.7785, lon: -122.4056 },
      { name: 'Mission District', lat: 37.7599, lon: -122.4148 },
      { name: 'Presidio North', lat: 37.7895, lon: -122.4480 },
      { name: 'Dogpatch Pier', lat: 37.7585, lon: -122.3905 },
    ],
    description: 'NOAA HRRR 3 km marine layer telemetry + steep-grade SF street topology.',
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    countryCode: 'JP',
    metroArea: '23-Ward Metro',
    lat: 35.6762,
    lon: 139.6503,
    zoom: 12.2,
    weatherModel: 'JMA MSM',
    weatherResolutionKm: '5.0 km',
    osmCoverage: 'Shuto Expressway & Tokyo 23-Ward OSM',
    hubNames: ['Tokyo Station Hub', 'Shibuya West', 'Shinagawa Port', 'Ueno North'],
    hubCoords: [
      { name: 'Tokyo Station Hub', lat: 35.6895, lon: 139.6917 },
      { name: 'Shibuya West', lat: 35.6595, lon: 139.6980 },
      { name: 'Shinagawa Port', lat: 35.6435, lon: 139.6695 },
      { name: 'Ueno North', lat: 35.7060, lon: 139.6495 },
    ],
    description: 'JMA MSM 5 km coastal weather model + hyper-dense multi-tier road network.',
  },
];

export const DEFAULT_BOOKMARK_ID: BookmarkId = 'london';

export const BOOKMARK_BY_ID: Record<BookmarkId, LocationBookmark> = Object.fromEntries(
  LOCATION_BOOKMARKS.map((bookmark) => [bookmark.id, bookmark]),
) as Record<BookmarkId, LocationBookmark>;

export const MAX_TRAIL_POINTS = 40;
export const MAX_METRICS_HISTORY = 60;
export const MAX_SOLVE_HISTORY = 30;

/**
 * Exact RGBA color mapping for canonical backend CourierStatus enum.
 */
export const COURIER_STATUS_META: Record<
  CourierStatus,
  {
    label: string;
    rgba: [number, number, number, number];
    hex: string;
    badgeClass: string;
  }
> = {
  OFFLINE: {
    label: 'Offline',
    rgba: [100, 116, 139, 170],
    hex: '#64748b',
    badgeClass: 'border-slate-600/60 bg-slate-800/70 text-slate-300',
  },
  IDLE: {
    label: 'Idle Ready',
    rgba: [16, 185, 129, 235],
    hex: '#10b981',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  },
  ASSIGNED: {
    label: 'Assigned',
    rgba: [56, 189, 248, 240],
    hex: '#38bdf8',
    badgeClass: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  },
  EN_ROUTE_PICKUP: {
    label: 'En Route Pickup',
    rgba: [245, 158, 11, 245],
    hex: '#f59e0b',
    badgeClass: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  },
  EN_ROUTE_DROPOFF: {
    label: 'En Route Dropoff',
    rgba: [34, 211, 238, 250],
    hex: '#22d3ee',
    badgeClass: 'border-cyan-400/50 bg-cyan-500/20 text-cyan-200',
  },
};

/**
 * Exact metadata for canonical backend OrderStatus enum.
 */
export const ORDER_STATUS_META: Record<
  OrderStatus,
  { label: string; hex: string; badgeClass: string }
> = {
  PENDING: {
    label: 'Pending',
    hex: '#fbbf24',
    badgeClass: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  },
  BATCHING: {
    label: 'Batching',
    hex: '#a78bfa',
    badgeClass: 'border-violet-500/40 bg-violet-500/15 text-violet-300',
  },
  ASSIGNED: {
    label: 'Assigned',
    hex: '#38bdf8',
    badgeClass: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
  },
  PICKED_UP: {
    label: 'Picked Up',
    hex: '#22d3ee',
    badgeClass: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300',
  },
  IN_TRANSIT: {
    label: 'In Transit',
    hex: '#818cf8',
    badgeClass: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300',
  },
  DELIVERED: {
    label: 'Delivered',
    hex: '#10b981',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  },
  FAILED: {
    label: 'Failed',
    hex: '#ef4444',
    badgeClass: 'border-rose-500/50 bg-rose-500/20 text-rose-300',
  },
  CANCELLED: {
    label: 'Cancelled',
    hex: '#64748b',
    badgeClass: 'border-slate-600/50 bg-slate-800/70 text-slate-400',
  },
};

export const CARTO_DARK_MATTER_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
