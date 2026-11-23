import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { MapLibreOverlay } from '@deck.gl/maplibre';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import {
  GeoJsonLayer,
  GridCellLayer,
  IconLayer,
  PathLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';
import type { GeoJsonLayerProps } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import {
  CloudRain,
  Crosshair,
  Eye,
  EyeOff,
  Flame,
  GitCompareArrows,
  Layers,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Navigation,
  Package,
  Route,
  Shield,
  X,
} from 'lucide-react';
import {
  BOOKMARK_BY_ID,
  CARTO_DARK_MATTER_STYLE,
  COURIER_STATUS_META,
  DEFAULT_BOOKMARK_ID,
} from '../../constants/bookmarks';
import { extractRoadNetworkFromMapLibre } from '../../services/roadNetwork';
import { useChronosStore } from '../../store/useChronosStore';
import type {
  CourierSnapshotDto,
  CourierStatus,
  HubSnapshotDto,
  LayerVisibility,
  OrderSnapshotDto,
  RoutePetalDto,
  WeatherGridCell,
} from '../../types/chronos';

interface HoverState {
  x: number;
  y: number;
  title: string;
  subtitle: string;
}

interface NumberedStopBadge {
  orderId: string;
  stopNumber: string;
  lon: number;
  lat: number;
  isSelectedOrder: boolean;
}

// Crisp North-pointing vehicle navigation chevron SVG (masked so IconLayer tints by courier status)
const VEHICLE_CHEVRON_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
    '<path d="M32 6 L54 54 L32 42 L10 54 Z" fill="#ffffff" stroke="#0f172a" stroke-width="3" stroke-linejoin="round"/>' +
    '</svg>',
)}`;

const LAYER_CONTROLS: {
  key: keyof LayerVisibility;
  label: string;
  icon: typeof Layers;
}[] = [
  { key: 'routes', label: 'Petals', icon: Route },
  { key: 'couriers', label: 'Fleet', icon: Navigation },
  { key: 'orders', label: 'Orders', icon: Package },
  { key: 'trail', label: 'Trail', icon: MapPin },
  { key: 'roadGraph', label: 'Roads', icon: MapIcon },
  { key: 'weather', label: 'Weather', icon: CloudRain },
  { key: 'zones', label: 'Zones', icon: Shield },
  { key: 'heatmap', label: 'Heatmap', icon: Flame },
  { key: 'routeDiff', label: 'Diff', icon: GitCompareArrows },
];

const STATUS_LEGEND_ORDER: CourierStatus[] = [
  'EN_ROUTE_DROPOFF',
  'EN_ROUTE_PICKUP',
  'ASSIGNED',
  'IDLE',
  'OFFLINE',
];

function weatherCellColor(cell: WeatherGridCell): [number, number, number, number] {
  const severity = Math.max(0, Math.min(1, (1 - cell.speed_multiplier) / 0.62));
  if (severity < 0.15) return [56, 189, 248, 28];
  if (severity < 0.45) return [59, 130, 246, 65];
  if (severity < 0.72) return [245, 158, 11, 95];
  return [239, 68, 68, 125];
}

function orderUrgencyColors(
  order: OrderSnapshotDto,
  nowMs: number,
  alphaScale = 1.0,
): { fill: [number, number, number, number]; line: [number, number, number, number] } {
  const scale = (a: number) => Math.max(12, Math.round(a * alphaScale));
  if (order.status === 'DELIVERED') {
    return { fill: [16, 185, 129, scale(75)], line: [16, 185, 129, scale(175)] };
  }
  if (order.status === 'FAILED' || order.status === 'CANCELLED') {
    return { fill: [239, 68, 68, scale(70)], line: [239, 68, 68, scale(180)] };
  }
  const slackSec = (new Date(order.windowEnd).getTime() - nowMs) / 1000;
  if (slackSec <= 0) {
    return { fill: [244, 63, 94, scale(155)], line: [251, 113, 133, scale(245)] };
  }
  if (slackSec < 900) {
    return { fill: [245, 158, 11, scale(135)], line: [251, 191, 36, scale(240)] };
  }
  return { fill: [16, 185, 129, scale(100)], line: [52, 211, 153, scale(215)] };
}

export function FleetMapCanvas() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);

  const activeBookmarkId = useChronosStore((s) => s.activeBookmarkId);
  const hubs = useChronosStore((s) => s.hubs);
  const zonesGeoJson = useChronosStore((s) => s.zonesGeoJson);
  const couriers = useChronosStore((s) => s.couriers);
  const courierTrails = useChronosStore((s) => s.courierTrails);
  const orders = useChronosStore((s) => s.orders);
  const routes = useChronosStore((s) => s.routes);
  const weatherCells = useChronosStore((s) => s.weatherCells);
  const lastReoptimize = useChronosStore((s) => s.lastReoptimize);
  const showRouteDiff = useChronosStore((s) => s.showRouteDiff);
  const selectedEntity = useChronosStore((s) => s.selectedEntity);
  const hoveredEntity = useChronosStore((s) => s.hoveredEntity);
  const selectEntity = useChronosStore((s) => s.selectEntity);
  const isolateSelection = useChronosStore((s) => s.isolateSelection);
  const setIsolateSelection = useChronosStore((s) => s.setIsolateSelection);
  const followSelectedCourier = useChronosStore((s) => s.followSelectedCourier);
  const setFollowSelectedCourier = useChronosStore((s) => s.setFollowSelectedCourier);
  const activeNavTab = useChronosStore((s) => s.activeNavTab);
  const cameraFocusRequest = useChronosStore((s) => s.cameraFocusRequest);
  const requestCameraFocus = useChronosStore((s) => s.requestCameraFocus);
  const layerVisibility = useChronosStore((s) => s.layerVisibility);
  const toggleLayer = useChronosStore((s) => s.toggleLayer);
  const activeRoadGraph = useChronosStore((s) => s.activeRoadGraph);
  const applyExtractedRoadGraph = useChronosStore((s) => s.applyExtractedRoadGraph);
  const getInterpolatedCouriers = useChronosStore((s) => s.getInterpolatedCouriers);

  const activeBookmarkRef = useRef(activeBookmarkId);
  activeBookmarkRef.current = activeBookmarkId;

  const [hoverInfo, setHoverInfo] = useState<HoverState | null>(null);
  const [animFrameTick, setAnimFrameTick] = useState(0);
  const [layersBarExpanded, setLayersBarExpanded] = useState(false);

  const debugRoadPaths = useMemo(
    () => (activeRoadGraph ? activeRoadGraph.getDebugEdgePaths(2600) : []),
    [activeRoadGraph],
  );

  // Initialize MapLibre GL + Deck.gl MapLibreOverlay once
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    const initialCity = BOOKMARK_BY_ID[DEFAULT_BOOKMARK_ID];
    const map = new maplibregl.Map({
      container,
      style: CARTO_DARK_MATTER_STYLE,
      center: [initialCity.lon, initialCity.lat],
      zoom: initialCity.zoom,
      pitch: 28,
      bearing: -6,
      attributionControl: { compact: true },
    });

    const overlay = new MapLibreOverlay({
      interleaved: false,
      layers: [],
      onClick: (info: PickingInfo) => {
        // Clicking empty map clears selection cleanly
        if (!info.object) {
          selectEntity(null);
        }
      },
    });

    map.addControl(overlay);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

    // Automatically stop following camera when user drags the map manually
    const onDragStart = () => {
      if (useChronosStore.getState().followSelectedCourier) {
        useChronosStore.getState().setFollowSelectedCourier(false);
      }
    };
    map.on('dragstart', onDragStart);

    mapRef.current = map;
    overlayRef.current = overlay;

    // Extract real OSM road graph from loaded MapLibre vector tiles
    let extractTimer: number | null = null;
    const scheduleRoadExtract = () => {
      if (extractTimer !== null) {
        window.clearTimeout(extractTimer);
      }
      extractTimer = window.setTimeout(() => {
        if (!mapRef.current || !mapRef.current.isStyleLoaded()) return;
        const bmId = activeBookmarkRef.current;
        const extracted = extractRoadNetworkFromMapLibre(mapRef.current, bmId, 6800);
        if (extracted) {
          applyExtractedRoadGraph(bmId, extracted);
        }
      }, 320);
    };

    map.on('idle', scheduleRoadExtract);
    map.on('load', scheduleRoadExtract);
    map.on('moveend', scheduleRoadExtract);

    return () => {
      if (extractTimer !== null) window.clearTimeout(extractTimer);
      map.off('dragstart', onDragStart);
      map.off('idle', scheduleRoadExtract);
      map.off('load', scheduleRoadExtract);
      map.off('moveend', scheduleRoadExtract);
      try {
        map.removeControl(overlay);
      } catch {
        // Ignore teardown race if style failed
      }
      overlay.finalize();
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, [applyExtractedRoadGraph, selectEntity]);

  // Smooth flyTo transition when city bookmark changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const target = BOOKMARK_BY_ID[activeBookmarkId];
    map.flyTo({
      center: [target.lon, target.lat],
      zoom: target.zoom,
      pitch: 28,
      bearing: -6,
      duration: 1350,
      essential: true,
    });
  }, [activeBookmarkId]);

  // Smooth camera focus / fitBounds reacting to Fit Route, Locate Order, Fit Hub Petals
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cameraFocusRequest || cameraFocusRequest.coords.length === 0) return;

    const padLeft = activeNavTab ? 405 : 75;
    const padRight = selectedEntity ? 375 : 48;

    if (cameraFocusRequest.coords.length === 1) {
      const [lon, lat] = cameraFocusRequest.coords[0];
      map.flyTo({
        center: [lon, lat],
        zoom: Math.max(map.getZoom(), 14.2),
        padding: { top: 80, bottom: 90, left: padLeft, right: padRight },
        duration: 850,
        essential: true,
      });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    for (const [lon, lat] of cameraFocusRequest.coords) {
      bounds.extend([lon, lat]);
    }
    map.fitBounds(bounds, {
      padding: { top: 90, bottom: 105, left: padLeft, right: padRight },
      maxZoom: 15.2,
      duration: 850,
      essential: true,
    });
  }, [cameraFocusRequest, activeNavTab, selectedEntity]);

  // 60 FPS smooth courier marker interpolation loop (~30-60 FPS throttled state trigger)
  useEffect(() => {
    if (!layerVisibility.couriers && !layerVisibility.heatmap) return;
    let rafId = 0;
    let lastDraw = 0;

    const tick = (ts: number) => {
      if (ts - lastDraw >= 32) {
        lastDraw = ts;
        setAnimFrameTick((n) => (n + 1) % 1_000_000);
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [layerVisibility.couriers, layerVisibility.heatmap]);

  const interpolatedCouriers = useMemo(() => {
    void animFrameTick;
    return getInterpolatedCouriers(Date.now());
  }, [animFrameTick, couriers, getInterpolatedCouriers]);

  // Resolve full focused relationships for selection (or sidebar hover preview)
  const focusContext = useMemo(() => {
    const primary = selectedEntity ?? hoveredEntity;
    if (!primary) {
      return {
        hasFocus: false,
        focusedCourierIds: new Set<string>(),
        focusedOrderIds: new Set<string>(),
        focusedHubId: null as string | null,
        primaryCourierId: null as string | null,
        primaryOrderId: null as string | null,
        focusedRoutes: [] as RoutePetalDto[],
        stopBadges: [] as NumberedStopBadge[],
      };
    }

    const focusedCourierIds = new Set<string>();
    const focusedOrderIds = new Set<string>();
    let focusedHubId: string | null = null;
    let primaryCourierId: string | null = null;
    let primaryOrderId: string | null = null;
    let focusedRoutes: RoutePetalDto[] = [];

    if (primary.type === 'courier' || primary.type === 'route') {
      const cid = primary.type === 'courier' ? primary.id : primary.courierId;
      primaryCourierId = cid;
      focusedCourierIds.add(cid);
      const r = routes.find((rt) => rt.courierId === cid);
      if (r) {
        focusedRoutes = [r];
        focusedHubId = r.hubId;
        for (const wp of r.waypoints) focusedOrderIds.add(wp.orderId);
      }
    } else if (primary.type === 'order') {
      primaryOrderId = primary.id;
      focusedOrderIds.add(primary.id);
      const ord = orders.find((o) => o.orderId === primary.id);
      const parentRoute =
        routes.find((rt) => rt.waypoints.some((w) => w.orderId === primary.id)) ??
        (ord?.courierId ? routes.find((rt) => rt.courierId === ord.courierId) : undefined);

      if (parentRoute) {
        focusedRoutes = [parentRoute];
        primaryCourierId = parentRoute.courierId;
        focusedCourierIds.add(parentRoute.courierId);
        focusedHubId = parentRoute.hubId;
        for (const wp of parentRoute.waypoints) focusedOrderIds.add(wp.orderId);
      } else if (ord) {
        focusedHubId = ord.hubId;
        if (ord.courierId) {
          primaryCourierId = ord.courierId;
          focusedCourierIds.add(ord.courierId);
        }
      }
    } else if (primary.type === 'hub') {
      focusedHubId = primary.id;
      focusedRoutes = routes.filter((rt) => rt.hubId === primary.id);
      for (const r of focusedRoutes) {
        focusedCourierIds.add(r.courierId);
        for (const wp of r.waypoints) focusedOrderIds.add(wp.orderId);
      }
    }

    const stopBadges: NumberedStopBadge[] = [];
    if (focusedRoutes.length === 1) {
      focusedRoutes[0].waypoints.forEach((wp, idx) => {
        stopBadges.push({
          orderId: wp.orderId,
          stopNumber: String(idx + 1),
          lon: wp.lon,
          lat: wp.lat,
          isSelectedOrder: wp.orderId === primaryOrderId,
        });
      });
    }

    return {
      hasFocus: true,
      focusedCourierIds,
      focusedOrderIds,
      focusedHubId,
      primaryCourierId,
      primaryOrderId,
      focusedRoutes,
      stopBadges,
    };
  }, [selectedEntity, hoveredEntity, routes, orders]);

  // Smoothly track followed courier as it moves along curved roads
  const lastFollowEaseMsRef = useRef(0);
  useEffect(() => {
    if (!followSelectedCourier || !focusContext.primaryCourierId) return;
    const now = performance.now();
    if (now - lastFollowEaseMsRef.current < 160) return;
    lastFollowEaseMsRef.current = now;

    const target = interpolatedCouriers.find((c) => c.courierId === focusContext.primaryCourierId);
    const map = mapRef.current;
    if (!target || !map) return;

    map.easeTo({
      center: [target.lon, target.lat],
      duration: 240,
      easing: (t) => t,
    });
  }, [followSelectedCourier, focusContext.primaryCourierId, interpolatedCouriers]);

  // Build and push deck.gl layers to MapLibreOverlay
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const nowMs = Date.now();
    const layers: Layer[] = [];
    const dimOthers = focusContext.hasFocus && isolateSelection;

    if (layerVisibility.zones && zonesGeoJson.features.length > 0) {
      layers.push(
        new GeoJsonLayer({
          id: 'hub-zones-geojson',
          data: zonesGeoJson as unknown as GeoJsonLayerProps['data'],
          pickable: false,
          stroked: true,
          filled: true,
          lineWidthMinPixels: 1.2,
          getFillColor: [14, 165, 233, dimOthers ? 8 : 16],
          getLineColor: [56, 189, 248, dimOthers ? 35 : 85],
          getLineWidth: 1.5,
        }),
      );
    }

    if (layerVisibility.roadGraph && debugRoadPaths.length > 0) {
      layers.push(
        new PathLayer<{ path: [number, number][]; roadClass: string }>({
          id: 'extracted-osm-road-graph',
          data: debugRoadPaths,
          pickable: false,
          widthUnits: 'pixels',
          getPath: (d) => d.path,
          getColor: (d) =>
            d.roadClass === 'motorway' || d.roadClass === 'trunk'
              ? [56, 189, 248, 125]
              : d.roadClass === 'primary' || d.roadClass === 'secondary'
                ? [34, 211, 238, 82]
                : [148, 163, 184, 52],
          getWidth: (d) =>
            d.roadClass === 'motorway' || d.roadClass === 'trunk' ? 2.2 : 1.25,
          capRounded: true,
          jointRounded: true,
        }),
      );
    }

    if (layerVisibility.weather && weatherCells.length > 0) {
      layers.push(
        new GridCellLayer<WeatherGridCell>({
          id: 'open-meteo-weather-grid',
          data: weatherCells,
          pickable: true,
          extruded: true,
          cellSize: 1650,
          elevationScale: 8,
          getPosition: (d) => [d.lon, d.lat],
          getElevation: (d) => Math.max(2, d.precipitation_mm * 14),
          getFillColor: (d) => weatherCellColor(d),
          onHover: (info: PickingInfo<WeatherGridCell>) => {
            if (info.object) {
              setHoverInfo({
                x: info.x,
                y: info.y,
                title: `Weather Cell ${info.object.geohash}`,
                subtitle: `${info.object.precipitation_mm.toFixed(1)} mm/h · ${info.object.speed_multiplier.toFixed(2)}× speed${info.object.is_degraded ? ' (CACHED)' : ''}`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        }),
      );
    }

    if (layerVisibility.heatmap && interpolatedCouriers.length > 0) {
      layers.push(
        new HeatmapLayer<CourierSnapshotDto>({
          id: 'telemetry-density-heatmap',
          data: interpolatedCouriers,
          getPosition: (d) => [d.lon, d.lat],
          getWeight: (d) => (d.status === 'OFFLINE' ? 0.2 : 1 + d.speedMps * 0.12),
          radiusPixels: 44,
          intensity: 1.15,
          threshold: 0.06,
        }),
      );
    }

    // Before-optimization comparison routes
    if (
      layerVisibility.routes &&
      layerVisibility.routeDiff &&
      showRouteDiff &&
      lastReoptimize &&
      lastReoptimize.beforeRoutes.length > 0
    ) {
      layers.push(
        new PathLayer<RoutePetalDto>({
          id: 'routes-before-diff',
          data: lastReoptimize.beforeRoutes,
          pickable: false,
          widthUnits: 'pixels',
          getPath: (d) => d.pathCoords,
          getColor: [244, 63, 94, dimOthers ? 35 : 130],
          getWidth: 2.2,
          capRounded: true,
          jointRounded: true,
        }),
      );
    }

    // Background (non-focused) curved route petals — subtle to prevent spaghetti clutter
    if (layerVisibility.routes && routes.length > 0) {
      const diffActive = layerVisibility.routeDiff && showRouteDiff && Boolean(lastReoptimize);
      const reassignedSet = new Set(lastReoptimize?.reassignedOrderIds ?? []);
      const focusedSet = new Set(focusContext.focusedRoutes.map((r) => r.courierId));
      const bgRoutes = routes.filter((r) => !focusedSet.has(r.courierId));

      if (bgRoutes.length > 0) {
        layers.push(
          new PathLayer<RoutePetalDto>({
            id: 'routes-background-petals',
            data: bgRoutes,
            pickable: true,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            getPath: (d) => d.pathCoords,
            getColor: (d) => {
              if (dimOthers) return [56, 189, 248, 22];
              if (diffActive) {
                const touched = d.waypoints.some((w) => reassignedSet.has(w.orderId));
                return touched ? [16, 185, 129, 210] : [34, 211, 238, 80];
              }
              return [56, 189, 248, 82];
            },
            getWidth: (d) => {
              if (dimOthers) return 1.5;
              if (diffActive && d.waypoints.some((w) => reassignedSet.has(w.orderId))) return 3.2;
              return 2.0;
            },
            onClick: (info: PickingInfo<RoutePetalDto>) => {
              if (info.object) {
                selectEntity({ type: 'route', courierId: info.object.courierId });
              }
            },
            onHover: (info: PickingInfo<RoutePetalDto>) => {
              if (info.object) {
                setHoverInfo({
                  x: info.x,
                  y: info.y,
                  title: `Petal · ${info.object.courierName}`,
                  subtitle: `${info.object.waypoints.length} stops · ${(info.object.totalDistanceMeters / 1000).toFixed(1)} km`,
                });
              } else {
                setHoverInfo(null);
              }
            },
          }),
        );
      }

      // Focused petal(s): glowing dual-layer curved path (soft outer halo + crisp bright core)
      if (focusContext.focusedRoutes.length > 0) {
        layers.push(
          new PathLayer<RoutePetalDto>({
            id: 'routes-focused-halo',
            data: focusContext.focusedRoutes,
            pickable: false,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            getPath: (d) => d.pathCoords,
            getColor: [250, 204, 21, 78],
            getWidth: 10,
          }),
          new PathLayer<RoutePetalDto>({
            id: 'routes-focused-core',
            data: focusContext.focusedRoutes,
            pickable: true,
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            getPath: (d) => d.pathCoords,
            getColor: [250, 204, 21, 250],
            getWidth: 3.8,
            onClick: (info: PickingInfo<RoutePetalDto>) => {
              if (info.object) {
                selectEntity({ type: 'route', courierId: info.object.courierId });
              }
            },
          }),
        );
      }
    }

    // Selected courier breadcrumb trail
    if (layerVisibility.trail && focusContext.primaryCourierId) {
      const pts = courierTrails[focusContext.primaryCourierId] ?? [];
      if (pts.length >= 2) {
        layers.push(
          new PathLayer<{ path: [number, number][] }>({
            id: 'selected-courier-trail',
            data: [{ path: pts.map((p) => [p.lon, p.lat]) }],
            widthUnits: 'pixels',
            capRounded: true,
            jointRounded: true,
            getPath: (d) => d.path,
            getColor: [34, 211, 238, 220],
            getWidth: 3,
          }),
        );
      }
    }

    // Depot Hub Beacons (clickable to inspect all petals radiating from that hub!)
    if (hubs.length > 0) {
      layers.push(
        new ScatterplotLayer<HubSnapshotDto>({
          id: 'depot-hub-beacons',
          data: hubs,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          lineWidthMinPixels: 2,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => (d.hubId === focusContext.focusedHubId ? 13 : 8.5),
          getFillColor: (d) =>
            d.hubId === focusContext.focusedHubId
              ? [56, 189, 248, 245]
              : [14, 165, 233, dimOthers ? 90 : 205],
          getLineColor: (d) =>
            d.hubId === focusContext.focusedHubId
              ? [250, 204, 21, 255]
              : [224, 242, 254, dimOthers ? 100 : 240],
          onClick: (info: PickingInfo<HubSnapshotDto>) => {
            if (info.object) {
              selectEntity({ type: 'hub', id: info.object.hubId });
            }
          },
          onHover: (info: PickingInfo<HubSnapshotDto>) => {
            if (info.object) {
              const count = routes.filter((r) => r.hubId === info.object!.hubId).length;
              setHoverInfo({
                x: info.x,
                y: info.y,
                title: info.object.name,
                subtitle: `Hub · ${count} active petals · Click to inspect`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        }),
      );
    }

    // Order Dropoff Markers (dim unrelated orders when focused; highlight focused petal's orders)
    if (layerVisibility.orders && orders.length > 0) {
      layers.push(
        new ScatterplotLayer<OrderSnapshotDto>({
          id: 'orders-urgency-rings',
          data: orders,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          lineWidthMinPixels: 1.5,
          getPosition: (d) => [d.dropoffLon, d.dropoffLat],
          getRadius: (d) => {
            if (d.orderId === focusContext.primaryOrderId) return 10;
            if (focusContext.focusedOrderIds.has(d.orderId)) return 7;
            return 4.2;
          },
          getFillColor: (d) => {
            const isFocused = focusContext.focusedOrderIds.has(d.orderId);
            return orderUrgencyColors(d, nowMs, dimOthers && !isFocused ? 0.22 : 1.0).fill;
          },
          getLineColor: (d) => {
            if (d.orderId === focusContext.primaryOrderId) return [255, 255, 255, 255];
            const isFocused = focusContext.focusedOrderIds.has(d.orderId);
            return orderUrgencyColors(d, nowMs, dimOthers && !isFocused ? 0.25 : 1.0).line;
          },
          onClick: (info: PickingInfo<OrderSnapshotDto>) => {
            if (info.object) {
              selectEntity({ type: 'order', id: info.object.orderId });
            }
          },
          onHover: (info: PickingInfo<OrderSnapshotDto>) => {
            if (info.object) {
              const slackMin = Math.round(
                (new Date(info.object.windowEnd).getTime() - nowMs) / 60_000,
              );
              const parent = routes.find((r) =>
                r.waypoints.some((w) => w.orderId === info.object!.orderId),
              );
              setHoverInfo({
                x: info.x,
                y: info.y,
                title: `Order ${info.object.orderId.slice(0, 8)} (${info.object.status})`,
                subtitle: `${parent ? `Petal: ${parent.courierName} · ` : ''}${info.object.weightKg.toFixed(1)} kg · TW ${slackMin >= 0 ? '+' : ''}${slackMin}m`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        }),
      );
    }

    // Numbered Stop Sequence Badges (1, 2, 3...) along the focused route petal!
    if (focusContext.stopBadges.length > 0) {
      layers.push(
        new ScatterplotLayer<NumberedStopBadge>({
          id: 'focused-stop-pin-circles',
          data: focusContext.stopBadges,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: 'pixels',
          lineWidthMinPixels: 2,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => (d.isSelectedOrder ? 13 : 10),
          getFillColor: (d) => (d.isSelectedOrder ? [245, 158, 11, 255] : [15, 23, 42, 240]),
          getLineColor: (d) => (d.isSelectedOrder ? [255, 255, 255, 255] : [250, 204, 21, 255]),
          onClick: (info: PickingInfo<NumberedStopBadge>) => {
            if (info.object) {
              selectEntity({ type: 'order', id: info.object.orderId });
            }
          },
        }),
        new TextLayer<NumberedStopBadge>({
          id: 'focused-stop-pin-numbers',
          data: focusContext.stopBadges,
          pickable: false,
          getPosition: (d) => [d.lon, d.lat],
          getText: (d) => d.stopNumber,
          getSize: (d) => (d.isSelectedOrder ? 13 : 11),
          getColor: (d) => (d.isSelectedOrder ? [15, 23, 42, 255] : [250, 204, 21, 255]),
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontWeight: 'bold',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
        }),
      );
    }

    // Couriers 60 FPS animated directional chevrons aligned to curved road heading
    if (layerVisibility.couriers && interpolatedCouriers.length > 0) {
      const focusedCouriers = focusContext.primaryCourierId
        ? interpolatedCouriers.filter((c) => c.courierId === focusContext.primaryCourierId)
        : [];

      if (focusedCouriers.length > 0) {
        layers.push(
          new ScatterplotLayer<CourierSnapshotDto>({
            id: 'selected-courier-halo',
            data: focusedCouriers,
            pickable: false,
            stroked: true,
            filled: true,
            radiusUnits: 'pixels',
            lineWidthMinPixels: 2.2,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 16,
            getFillColor: [250, 204, 21, 55],
            getLineColor: [250, 204, 21, 245],
          }),
        );
      }

      layers.push(
        new IconLayer<CourierSnapshotDto>({
          id: 'couriers-live-fleet',
          data: interpolatedCouriers,
          pickable: true,
          billboard: false,
          sizeUnits: 'pixels',
          getPosition: (d) => [d.lon, d.lat],
          getIcon: () => ({
            url: VEHICLE_CHEVRON_SVG,
            width: 64,
            height: 64,
            anchorX: 32,
            anchorY: 32,
            mask: true,
          }),
          getSize: (d) =>
            d.courierId === focusContext.primaryCourierId
              ? 24
              : focusContext.focusedCourierIds.has(d.courierId)
                ? 20
                : 15,
          getAngle: (d) => -d.headingDeg,
          getColor: (d) => {
            const base = COURIER_STATUS_META[d.status].rgba;
            if (dimOthers && !focusContext.focusedCourierIds.has(d.courierId)) {
              return [base[0], base[1], base[2], 70];
            }
            return base;
          },
          onClick: (info: PickingInfo<CourierSnapshotDto>) => {
            if (info.object) {
              selectEntity({ type: 'courier', id: info.object.courierId });
            }
          },
          onHover: (info: PickingInfo<CourierSnapshotDto>) => {
            if (info.object) {
              setHoverInfo({
                x: info.x,
                y: info.y,
                title: `${info.object.name} (${info.object.status})`,
                subtitle: `${(info.object.speedMps * 3.6).toFixed(0)} km/h · ${Math.round(info.object.headingDeg)}° · ${info.object.currentCapacityKg.toFixed(1)}/${info.object.maxCapacityKg} kg`,
              });
            } else {
              setHoverInfo(null);
            }
          },
        }),
      );
    }

    overlay.setProps({ layers });
  }, [
    courierTrails,
    debugRoadPaths,
    focusContext,
    hubs,
    interpolatedCouriers,
    isolateSelection,
    lastReoptimize,
    layerVisibility,
    orders,
    routes,
    selectEntity,
    showRouteDiff,
    weatherCells,
    zonesGeoJson,
  ]);

  // Active selection breadcrumb label for bottom-center quick control bar
  const selectionSummary = useMemo(() => {
    if (!selectedEntity) return null;
    if (selectedEntity.type === 'courier' || selectedEntity.type === 'route') {
      const cid = selectedEntity.type === 'courier' ? selectedEntity.id : selectedEntity.courierId;
      const c = couriers.find((x) => x.courierId === cid);
      const r = routes.find((x) => x.courierId === cid);
      if (!c) return null;
      return {
        label: `${c.name}${r ? ` · ${r.waypoints.length} stops` : ''}`,
        fitCoords: r && r.pathCoords.length >= 2 ? r.pathCoords : ([[c.lon, c.lat]] as [number, number][]),
        canFollow: true,
      };
    }
    if (selectedEntity.type === 'order') {
      const o = orders.find((x) => x.orderId === selectedEntity.id);
      const r = routes.find((x) => x.waypoints.some((w) => w.orderId === selectedEntity.id));
      if (!o) return null;
      return {
        label: `Order ${o.orderId.slice(0, 8)}${r ? ` in ${r.courierName}` : ' (Unassigned)'}`,
        fitCoords:
          r && r.pathCoords.length >= 2
            ? r.pathCoords
            : ([[o.dropoffLon, o.dropoffLat]] as [number, number][]),
        canFollow: Boolean(r),
      };
    }
    if (selectedEntity.type === 'hub') {
      const h = hubs.find((x) => x.hubId === selectedEntity.id);
      if (!h) return null;
      const hubPts = routes.filter((r) => r.hubId === h.hubId).flatMap((r) => r.pathCoords);
      return {
        label: `Hub · ${h.name}`,
        fitCoords: hubPts.length >= 2 ? hubPts : ([[h.lon, h.lat]] as [number, number][]),
        canFollow: false,
      };
    }
    return null;
  }, [selectedEntity, couriers, routes, orders, hubs]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#05080f]">
      {/* Full-viewport MapLibre + deck.gl canvas */}
      <div ref={mapContainerRef} className="h-full w-full" />

      {/* Hover Tooltip */}
      {hoverInfo && (
        <div
          className="hud-glass pointer-events-none fixed z-40 rounded-lg px-2.5 py-1.5 text-xs shadow-lg"
          style={{
            left: Math.min(window.innerWidth - 260, hoverInfo.x + 14),
            top: Math.min(window.innerHeight - 72, hoverInfo.y + 14),
          }}
        >
          <div className="font-semibold text-slate-100">{hoverInfo.title}</div>
          <div className="font-mono text-[10px] text-slate-300 tabular-nums">
            {hoverInfo.subtitle}
          </div>
        </div>
      )}

      {/* Bottom-center Contextual Selection Pill & Compact Layers Switcher */}
      <div className="pointer-events-none fixed bottom-3 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-1.5">
        {selectionSummary && (
          <div className="pointer-events-auto hud-glass flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px]">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span className="max-w-[220px] truncate font-semibold text-slate-100">
              {selectionSummary.label}
            </span>
            <div className="mx-1 h-3.5 w-px bg-slate-700" />
            {selectionSummary.canFollow && (
              <button
                type="button"
                onClick={() => setFollowSelectedCourier(!followSelectedCourier)}
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold transition-colors ${
                  followSelectedCourier
                    ? 'bg-cyan-500/25 text-cyan-200'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
                title="Toggle camera follow (F)"
              >
                <Crosshair className="h-3 w-3" />
                <span>{followSelectedCourier ? 'Following' : 'Follow'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => requestCameraFocus(selectionSummary.fitCoords)}
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-slate-300 hover:bg-slate-800 hover:text-cyan-200"
              title="Fit route in view"
            >
              <Maximize2 className="h-3 w-3" />
              <span>Fit</span>
            </button>
            <button
              type="button"
              onClick={() => setIsolateSelection(!isolateSelection)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors ${
                isolateSelection
                  ? 'bg-amber-500/20 text-amber-200'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
              title="Dim unrelated routes"
            >
              {isolateSelection ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => selectEntity(null)}
              className="rounded-full p-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              title="Clear selection (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {layersBarExpanded && (
          <div className="pointer-events-auto hud-glass flex flex-wrap items-center justify-center gap-1 rounded-xl px-2 py-1.5">
            {LAYER_CONTROLS.map(({ key, label, icon: Icon }) => {
              const active = layerVisibility[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleLayer(key)}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="pointer-events-auto hud-glass-subtle flex items-center gap-2.5 rounded-full px-3 py-1 text-[10px] text-slate-300">
          <button
            type="button"
            onClick={() => setLayersBarExpanded((v) => !v)}
            className="flex items-center gap-1 border-r border-slate-700/80 pr-2 font-semibold text-cyan-300 hover:text-cyan-200"
          >
            <Layers className="h-3 w-3" />
            <span>Layers</span>
          </button>
          <div className="hidden flex-wrap items-center gap-2.5 sm:flex">
            {STATUS_LEGEND_ORDER.map((status) => {
              const meta = COURIER_STATUS_META[status];
              return (
                <span key={status} className="flex items-center gap-1 font-mono text-[10px]">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: meta.hex }}
                  />
                  <span>{meta.label}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
