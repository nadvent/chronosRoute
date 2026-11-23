import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BatteryCharging,
  Building2,
  Clock,
  Compass,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Maximize2,
  Navigation,
  Package,
  Route,
  Sparkles,
  Truck,
  X,
} from 'lucide-react';
import { COURIER_STATUS_META, MAX_TRAIL_POINTS, ORDER_STATUS_META } from '../../constants/bookmarks';
import { computeFallbackEtaCompare, fetchEtaCompare } from '../../services/api';
import { useChronosStore } from '../../store/useChronosStore';
import type { EtaCompareResponse } from '../../types/chronos';

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSlack(
  windowEndIso: string,
  nowMs: number,
): { text: string; late: boolean; tight: boolean } {
  const diffSec = Math.round((new Date(windowEndIso).getTime() - nowMs) / 1000);
  const absSec = Math.abs(diffSec);
  const mins = Math.floor(absSec / 60);
  const secs = absSec % 60;
  const formatted = `${mins}m ${String(secs).padStart(2, '0')}s`;
  if (diffSec < 0) {
    return { text: `-${formatted} LATE`, late: true, tight: false };
  }
  return {
    text: `+${formatted}`,
    late: false,
    tight: diffSec < 900,
  };
}

export function EntityInspectorDrawer() {
  const mode = useChronosStore((s) => s.mode);
  const selectedEntity = useChronosStore((s) => s.selectedEntity);
  const selectEntity = useChronosStore((s) => s.selectEntity);
  const couriers = useChronosStore((s) => s.couriers);
  const hubs = useChronosStore((s) => s.hubs);
  const orders = useChronosStore((s) => s.orders);
  const routes = useChronosStore((s) => s.routes);
  const courierTrails = useChronosStore((s) => s.courierTrails);
  const weatherCells = useChronosStore((s) => s.weatherCells);
  const isolateSelection = useChronosStore((s) => s.isolateSelection);
  const setIsolateSelection = useChronosStore((s) => s.setIsolateSelection);
  const followSelectedCourier = useChronosStore((s) => s.followSelectedCourier);
  const setFollowSelectedCourier = useChronosStore((s) => s.setFollowSelectedCourier);
  const requestCameraFocus = useChronosStore((s) => s.requestCameraFocus);
  const triggerDynamicReoptimize = useChronosStore((s) => s.triggerDynamicReoptimize);
  const isReoptimizing = useChronosStore((s) => s.isReoptimizing);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [etaCompare, setEtaCompare] = useState<EtaCompareResponse | null>(null);
  const [etaLoading, setEtaLoading] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const selectedOrder =
    selectedEntity?.type === 'order'
      ? orders.find((o) => o.orderId === selectedEntity.id) ?? null
      : null;

  const selectedCourier =
    selectedEntity?.type === 'courier'
      ? couriers.find((c) => c.courierId === selectedEntity.id) ?? null
      : selectedEntity?.type === 'route'
        ? couriers.find((c) => c.courierId === selectedEntity.courierId) ?? null
        : null;

  const selectedHub =
    selectedEntity?.type === 'hub'
      ? hubs.find((h) => h.hubId === selectedEntity.id) ?? null
      : null;

  // Parent route petal for selected Order (answers "which petal is this order in?")
  const parentRouteForOrder = selectedOrder
    ? routes.find((r) => r.waypoints.some((w) => w.orderId === selectedOrder.orderId)) ??
      (selectedOrder.courierId
        ? routes.find((r) => r.courierId === selectedOrder.courierId) ?? null
        : null)
    : null;

  const parentStopIndex =
    selectedOrder && parentRouteForOrder
      ? parentRouteForOrder.waypoints.findIndex((w) => w.orderId === selectedOrder.orderId)
      : -1;

  const parentCourierForOrder =
    selectedOrder && (parentRouteForOrder?.courierId ?? selectedOrder.courierId)
      ? couriers.find(
          (c) => c.courierId === (parentRouteForOrder?.courierId ?? selectedOrder.courierId),
        ) ?? null
      : null;

  useEffect(() => {
    if (!selectedOrder) {
      setEtaCompare(null);
      return;
    }

    const avgPrecip =
      weatherCells.length > 0
        ? weatherCells.reduce((acc, c) => acc + c.precipitation_mm, 0) / weatherCells.length
        : 0;
    const avgWind =
      weatherCells.length > 0
        ? weatherCells.reduce((acc, c) => acc + c.wind_speed_kmh, 0) / weatherCells.length
        : 5;

    let cancelled = false;
    const loadEta = async () => {
      if (mode === 'sandbox') {
        setEtaCompare(
          computeFallbackEtaCompare({
            originLat: selectedOrder.pickupLat,
            originLon: selectedOrder.pickupLon,
            destLat: selectedOrder.dropoffLat,
            destLon: selectedOrder.dropoffLon,
            precipitationMm: avgPrecip,
            windSpeedKmh: avgWind,
          }),
        );
        return;
      }

      setEtaLoading(true);
      try {
        const res = await fetchEtaCompare({
          originLat: selectedOrder.pickupLat,
          originLon: selectedOrder.pickupLon,
          destLat: selectedOrder.dropoffLat,
          destLon: selectedOrder.dropoffLon,
          precipitationMm: avgPrecip,
          windSpeedKmh: avgWind,
        });
        if (!cancelled) setEtaCompare(res);
      } catch {
        if (!cancelled) {
          setEtaCompare(
            computeFallbackEtaCompare({
              originLat: selectedOrder.pickupLat,
              originLon: selectedOrder.pickupLon,
              destLat: selectedOrder.dropoffLat,
              destLon: selectedOrder.dropoffLon,
              precipitationMm: avgPrecip,
              windSpeedKmh: avgWind,
            }),
          );
        }
      } finally {
        if (!cancelled) setEtaLoading(false);
      }
    };

    void loadEta();
    return () => {
      cancelled = true;
    };
  }, [mode, selectedOrder, weatherCells]);

  if (!selectedCourier && !selectedOrder && !selectedHub) {
    return null;
  }

  return (
    <aside className="hud-glass hud-scrollbar fixed right-3 top-[64px] z-30 max-h-[calc(100vh-80px)] w-[352px] overflow-y-auto rounded-2xl p-4">
      {/* ==================== VEHICLE / ROUTE PETAL INSPECTOR ==================== */}
      {selectedCourier && (() => {
        const courierRoute = routes.find((r) => r.courierId === selectedCourier.courierId);
        const hub = courierRoute
          ? hubs.find((h) => h.hubId === courierRoute.hubId) ?? hubs[0]
          : hubs[0];
        const stopIds =
          courierRoute?.waypoints.map((w) => w.orderId) ?? selectedCourier.activeRouteOrderIds;

        return (
          <div className="space-y-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/15 ring-1 ring-amber-400/40">
                  <Truck className="h-4 w-4 text-amber-300" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-100">{selectedCourier.name}</h2>
                  <p className="font-mono text-[10px] text-slate-400">
                    {selectedCourier.courierId.slice(0, 18)}…
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => selectEntity(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                aria-label="Close inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Quick Map Actions: Follow / Fit Path / Isolate */}
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setFollowSelectedCourier(!followSelectedCourier)}
                className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                  followSelectedCourier
                    ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
                    : 'border-slate-700/80 bg-slate-900/70 text-slate-300 hover:border-cyan-500/40'
                }`}
              >
                <Crosshair className="h-3 w-3" />
                <span>{followSelectedCourier ? 'Following' : 'Follow'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (courierRoute && courierRoute.pathCoords.length >= 2) {
                    requestCameraFocus(courierRoute.pathCoords);
                  } else {
                    requestCameraFocus([[selectedCourier.lon, selectedCourier.lat]]);
                  }
                }}
                className="flex items-center justify-center gap-1 rounded-lg border border-slate-700/80 bg-slate-900/70 px-2 py-1.5 text-[11px] font-semibold text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-200"
              >
                <Maximize2 className="h-3 w-3" />
                <span>Fit Path</span>
              </button>
              <button
                type="button"
                onClick={() => setIsolateSelection(!isolateSelection)}
                className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                  isolateSelection
                    ? 'border-amber-400/60 bg-amber-500/15 text-amber-200'
                    : 'border-slate-700/80 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                }`}
              >
                {isolateSelection ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                <span>Isolate</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                  COURIER_STATUS_META[selectedCourier.status].badgeClass
                }`}
              >
                {selectedCourier.status}
              </span>
              <span className="hud-pill font-mono text-slate-300 tabular-nums">
                <Clock className="h-3 w-3 text-slate-400" />
                {formatClock(selectedCourier.shiftStart)}–{formatClock(selectedCourier.shiftEnd)}
              </span>
            </div>

            {/* Telemetry grid */}
            <div className="grid grid-cols-3 gap-2 tabular-nums">
              <div className="hud-glass-subtle rounded-xl p-2.5">
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <Gauge className="h-3 w-3 text-cyan-400" /> Speed
                </div>
                <div className="mt-1 font-mono text-xs font-bold text-slate-100">
                  {(selectedCourier.speedMps * 3.6).toFixed(0)} km/h
                </div>
                <div className="font-mono text-[10px] text-slate-400">
                  {selectedCourier.speedMps.toFixed(1)} m/s
                </div>
              </div>

              <div className="hud-glass-subtle rounded-xl p-2.5">
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <Compass className="h-3 w-3 text-indigo-400" /> Bearing
                </div>
                <div className="mt-1 font-mono text-xs font-bold text-slate-100">
                  {Math.round(selectedCourier.headingDeg)}°
                </div>
                <div className="font-mono text-[10px] text-slate-400">
                  {selectedCourier.lat.toFixed(3)}, {selectedCourier.lon.toFixed(3)}
                </div>
              </div>

              <div className="hud-glass-subtle rounded-xl p-2.5">
                <div className="flex items-center gap-1 text-[10px] text-slate-400">
                  <BatteryCharging className="h-3 w-3 text-emerald-400" /> Battery
                </div>
                <div className="mt-1 font-mono text-xs font-bold text-slate-100">
                  {selectedCourier.batteryPct}%
                </div>
                <div className="font-mono text-[10px] text-slate-400">
                  Trail {courierTrails[selectedCourier.courierId]?.length ?? 0}/{MAX_TRAIL_POINTS}
                </div>
              </div>
            </div>

            {/* Payload Utilization */}
            <div className="hud-glass-subtle rounded-xl p-3 tabular-nums">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Payload Utilization</span>
                <span className="font-mono font-semibold text-slate-100">
                  {selectedCourier.currentCapacityKg.toFixed(1)} /{' '}
                  {selectedCourier.maxCapacityKg.toFixed(0)} kg
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400 transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (selectedCourier.currentCapacityKg /
                          Math.max(1, selectedCourier.maxCapacityKg)) *
                          100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>

            {/* Visual Route Petal Stop Timeline */}
            <div className="hud-glass-subtle rounded-xl p-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                <span className="flex items-center gap-1.5">
                  <Route className="h-3.5 w-3.5 text-amber-300" />
                  Route Petal ({stopIds.length} stops)
                </span>
                {courierRoute && (
                  <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                    {(courierRoute.totalDistanceMeters / 1000).toFixed(1)} km ·{' '}
                    {Math.round(courierRoute.totalDurationSeconds / 60)}m
                  </span>
                )}
              </div>

              {stopIds.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  No active stops — vehicle ready in dispatch pool.
                </p>
              ) : (
                <div className="mt-2.5 space-y-1.5">
                  {hub && (
                    <button
                      type="button"
                      onClick={() => selectEntity({ type: 'hub', id: hub.hubId })}
                      className="flex w-full items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-left text-[11px] text-sky-200 hover:bg-sky-500/20"
                    >
                      <Building2 className="h-3.5 w-3.5 shrink-0 text-sky-400" />
                      <span className="truncate font-medium">Depot: {hub.name}</span>
                    </button>
                  )}

                  {stopIds.map((oid, idx) => {
                    const wp = courierRoute?.waypoints.find((w) => w.orderId === oid);
                    return (
                      <button
                        key={oid}
                        type="button"
                        onClick={() => selectEntity({ type: 'order', id: oid })}
                        className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/75 px-2.5 py-1.5 text-left text-xs transition-colors hover:border-amber-400/50"
                      >
                        <span className="flex items-center gap-2">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 font-mono text-[10px] font-bold text-slate-950">
                            {idx + 1}
                          </span>
                          <span className="font-mono text-[11px] text-slate-200">
                            Order {oid.slice(0, 8)}
                          </span>
                        </span>
                        {wp ? (
                          <span
                            className={`font-mono text-[10px] tabular-nums ${
                              wp.slackSeconds < 0
                                ? 'text-rose-400'
                                : wp.slackSeconds < 600
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                            }`}
                          >
                            {wp.slackSeconds >= 0 ? '+' : ''}
                            {Math.round(wp.slackSeconds / 60)}m
                          </span>
                        ) : (
                          <span className="text-[10px] text-cyan-300">Inspect →</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ==================== ORDER + PARENT PETAL INSPECTOR ==================== */}
      {selectedOrder && (
        <div className="space-y-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/15 ring-1 ring-amber-400/40">
                <Package className="h-4 w-4 text-amber-300" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-100">
                  Order {selectedOrder.orderId.slice(0, 8)}
                </h2>
                <p className="font-mono text-[10px] text-slate-400">
                  v{selectedOrder.version} · {selectedOrder.weightKg.toFixed(1)} kg
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  requestCameraFocus(
                    parentRouteForOrder && parentRouteForOrder.pathCoords.length >= 2
                      ? parentRouteForOrder.pathCoords
                      : [[selectedOrder.dropoffLon, selectedOrder.dropoffLat]],
                  )
                }
                title="Frame order and its route petal on map"
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-cyan-300"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => selectEntity(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                aria-label="Close inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {(() => {
            const slack = formatSlack(selectedOrder.windowEnd, nowMs);
            return (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                    ORDER_STATUS_META[selectedOrder.status].badgeClass
                  }`}
                >
                  {selectedOrder.status}
                </span>
                <span
                  className={`hud-pill font-mono tabular-nums ${
                    slack.late
                      ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                      : slack.tight
                        ? 'border-amber-500/50 bg-amber-500/15 text-amber-300'
                        : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  }`}
                >
                  {slack.text}
                </span>
              </div>
            );
          })()}

          {/* Prominent Parent Route Petal Membership Card */}
          <div className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-bold text-cyan-200">
                <Route className="h-3.5 w-3.5 text-cyan-400" />
                Route Petal Membership
              </span>
              {parentRouteForOrder && parentStopIndex >= 0 && (
                <span className="rounded-full bg-amber-400 px-2 py-0.5 font-mono text-[10px] font-bold text-slate-950">
                  Stop #{parentStopIndex + 1} of {parentRouteForOrder.waypoints.length}
                </span>
              )}
            </div>

            {parentRouteForOrder ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      selectEntity({ type: 'courier', id: parentRouteForOrder.courierId })
                    }
                    className="flex items-center gap-1.5 font-semibold text-slate-100 hover:text-cyan-300"
                  >
                    <Truck className="h-3.5 w-3.5 text-amber-300" />
                    <span>{parentRouteForOrder.courierName}</span>
                  </button>
                  <span className="font-mono text-[10px] text-slate-300 tabular-nums">
                    {(parentRouteForOrder.totalDistanceMeters / 1000).toFixed(1)} km ·{' '}
                    {Math.round(parentRouteForOrder.totalDurationSeconds / 60)}m
                  </span>
                </div>

                {/* Sibling-Stop Stepper inside this Petal */}
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                    Hub
                  </span>
                  {parentRouteForOrder.waypoints.map((wp, idx) => {
                    const isThis = wp.orderId === selectedOrder.orderId;
                    return (
                      <div key={wp.orderId} className="flex items-center gap-1">
                        <span className="text-slate-600">→</span>
                        <button
                          type="button"
                          onClick={() => selectEntity({ type: 'order', id: wp.orderId })}
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold transition-colors ${
                            isThis
                              ? 'bg-amber-400 text-slate-950 ring-2 ring-amber-300/60'
                              : 'bg-slate-800/90 text-slate-300 hover:bg-slate-700'
                          }`}
                        >
                          #{idx + 1}
                        </button>
                      </div>
                    );
                  })}
                  <span className="text-slate-600">→</span>
                  <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                    Hub
                  </span>
                </div>

                <div className="flex gap-1.5 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      selectEntity({ type: 'courier', id: parentRouteForOrder.courierId });
                      setFollowSelectedCourier(true);
                    }}
                    className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-cyan-500/20 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/30"
                  >
                    <Navigation className="h-3 w-3" />
                    <span>Inspect &amp; Follow Vehicle</span>
                  </button>
                </div>
              </>
            ) : parentCourierForOrder ? (
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span>Assigned to {parentCourierForOrder.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    selectEntity({ type: 'courier', id: parentCourierForOrder.courierId })
                  }
                  className="font-semibold text-cyan-300 hover:underline"
                >
                  View Vehicle →
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-300">
                  {selectedOrder.status === 'DELIVERED'
                    ? 'Order has already been delivered.'
                    : 'Not yet assigned to a vehicle petal — awaiting next ALNS batch.'}
                </p>
                {(selectedOrder.status === 'PENDING' || selectedOrder.status === 'BATCHING') && (
                  <button
                    type="button"
                    disabled={isReoptimizing}
                    onClick={() => void triggerDynamicReoptimize({ batchSize: 50 })}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-cyan-500 px-2.5 py-1.5 text-[11px] font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-60"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Dispatch Now with ALNS</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Time Window Details */}
          <div className="hud-glass-subtle space-y-1.5 rounded-xl p-3 text-xs tabular-nums">
            <div className="flex items-center justify-between text-slate-400">
              <span>Time Window</span>
              <span className="font-mono text-slate-100">
                [{formatClock(selectedOrder.windowStart)} – {formatClock(selectedOrder.windowEnd)}]
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Service Duration</span>
              <span className="font-mono text-slate-200">
                {selectedOrder.serviceDurationSeconds}s
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Dropoff Coord</span>
              <span className="font-mono text-[11px] text-slate-300">
                {selectedOrder.dropoffLat.toFixed(4)}, {selectedOrder.dropoffLon.toFixed(4)}
              </span>
            </div>
          </div>

          {/* ONNX Residual ETA vs OSRM Baseline Comparison */}
          <div className="hud-glass-subtle rounded-xl p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                ONNX Residual vs OSRM
              </span>
              {etaCompare?.is_degraded && (
                <span className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-300">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  DEGRADED
                </span>
              )}
            </div>

            {etaLoading && !etaCompare ? (
              <div className="mt-3 text-xs text-slate-400">Scoring ONNX residual model…</div>
            ) : etaCompare ? (
              <div className="mt-2.5 space-y-2.5 tabular-nums">
                {(() => {
                  const maxSecs = Math.max(
                    1,
                    etaCompare.osrm_baseline_seconds,
                    etaCompare.onnx_eta_seconds,
                  );
                  const osrmPct = Math.round((etaCompare.osrm_baseline_seconds / maxSecs) * 100);
                  const onnxPct = Math.round((etaCompare.onnx_eta_seconds / maxSecs) * 100);
                  return (
                    <>
                      <div>
                        <div className="mb-1 flex justify-between text-[11px]">
                          <span className="text-slate-400">Raw OSRM Baseline</span>
                          <span className="font-mono text-slate-200">
                            {(etaCompare.osrm_baseline_seconds / 60).toFixed(1)} min
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-slate-400"
                            style={{ width: `${osrmPct}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="mb-1 flex justify-between text-[11px]">
                          <span className="text-cyan-300">
                            ONNX Residual ({etaCompare.onnx_multiplier.toFixed(2)}×)
                          </span>
                          <span className="font-mono font-semibold text-cyan-200">
                            {(etaCompare.onnx_eta_seconds / 60).toFixed(1)} min
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-amber-400"
                            style={{ width: `${onnxPct}%` }}
                          />
                        </div>
                      </div>
                    </>
                  );
                })()}

                <div className="flex items-center justify-between border-t border-slate-800 pt-2 font-mono text-[11px] text-slate-400">
                  <span>Leg: {(etaCompare.distance_meters / 1000).toFixed(2)} km</span>
                  <span
                    className={
                      etaCompare.delta_seconds >= 0 ? 'text-amber-300' : 'text-emerald-300'
                    }
                  >
                    Δ {etaCompare.delta_seconds >= 0 ? '+' : ''}
                    {Math.round(etaCompare.delta_seconds)}s
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* ==================== DEPOT HUB INSPECTOR ==================== */}
      {selectedHub && (() => {
        const hubPetals = routes.filter((r) => r.hubId === selectedHub.hubId);
        const hubOrders = orders.filter((o) => o.hubId === selectedHub.hubId);
        const pendingAtHub = hubOrders.filter(
          (o) => o.status === 'PENDING' || o.status === 'BATCHING',
        ).length;

        return (
          <div className="space-y-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-500/15 ring-1 ring-sky-400/40">
                  <Building2 className="h-4 w-4 text-sky-300" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-100">{selectedHub.name}</h2>
                  <p className="font-mono text-[10px] text-slate-400">
                    Depot Hub · {selectedHub.capacityOrdersPerHour} orders/hr
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => selectEntity(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                aria-label="Close inspector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-center tabular-nums">
              <div className="hud-glass-subtle rounded-xl p-2.5">
                <div className="font-mono text-base font-bold text-cyan-300">{hubPetals.length}</div>
                <div className="text-[10px] text-slate-400">Active Petals</div>
              </div>
              <div className="hud-glass-subtle rounded-xl p-2.5">
                <div className="font-mono text-base font-bold text-amber-300">{pendingAtHub}</div>
                <div className="text-[10px] text-slate-400">Pending Queue</div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                const allPts = hubPetals.flatMap((p) => p.pathCoords);
                requestCameraFocus(
                  allPts.length >= 2 ? allPts : [[selectedHub.lon, selectedHub.lat]],
                );
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-sky-500/40 bg-sky-500/15 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-500/25"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span>Fit All Hub Petals</span>
            </button>

            <div className="hud-glass-subtle space-y-1.5 rounded-xl p-3">
              <div className="text-xs font-semibold text-slate-200">
                Outgoing Route Petals ({hubPetals.length})
              </div>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {hubPetals.map((p) => (
                  <button
                    key={p.courierId}
                    type="button"
                    onClick={() => {
                      selectEntity({ type: 'courier', id: p.courierId });
                      requestCameraFocus(p.pathCoords);
                    }}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/75 px-2.5 py-1.5 text-left text-xs hover:border-cyan-500/50"
                  >
                    <span className="truncate font-semibold text-slate-200">{p.courierName}</span>
                    <span className="shrink-0 font-mono text-[10px] text-cyan-300 tabular-nums">
                      {p.waypoints.length} stops · {(p.totalDistanceMeters / 1000).toFixed(1)} km
                    </span>
                  </button>
                ))}
                {hubPetals.length === 0 && (
                  <p className="text-xs text-slate-500">No active petals currently radiating from this hub.</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </aside>
  );
}
