import { useMemo, useState } from 'react';
import {
  ChevronLeft,
  Cpu,
  Crosshair,
  Flame,
  Package,
  Route,
  Search,
  Truck,
  X,
} from 'lucide-react';
import { COURIER_STATUS_META, ORDER_STATUS_META } from '../../constants/bookmarks';
import { useChronosStore } from '../../store/useChronosStore';
import type { CourierStatus, ExplorerTab, RoutePetalDto } from '../../types/chronos';
import { ChaosPanelBody } from '../chaos/ChaosControlPanel';
import { SolverPanelBody } from '../solver/SolverDrawer';

type FleetFilter = 'ALL' | 'ACTIVE' | 'EN_ROUTE_DROPOFF' | 'EN_ROUTE_PICKUP' | 'IDLE' | 'OFFLINE';

const NAV_ITEMS: { id: Exclude<ExplorerTab, null>; label: string; icon: typeof Truck }[] = [
  { id: 'fleet', label: 'Fleet', icon: Truck },
  { id: 'orders', label: 'Orders', icon: Package },
  { id: 'solver', label: 'Solver', icon: Cpu },
  { id: 'chaos', label: 'Chaos', icon: Flame },
];

function formatMiniSlack(windowEndIso: string, nowMs: number): { text: string; late: boolean; tight: boolean } {
  const diffMin = Math.round((new Date(windowEndIso).getTime() - nowMs) / 60_000);
  if (diffMin < 0) return { text: `${diffMin}m`, late: true, tight: false };
  return { text: `+${diffMin}m`, late: false, tight: diffMin < 15 };
}

export function ExplorerSidebar() {
  const activeNavTab = useChronosStore((s) => s.activeNavTab);
  const setActiveNavTab = useChronosStore((s) => s.setActiveNavTab);
  const couriers = useChronosStore((s) => s.couriers);
  const orders = useChronosStore((s) => s.orders);
  const routes = useChronosStore((s) => s.routes);
  const selectedEntity = useChronosStore((s) => s.selectedEntity);
  const selectEntity = useChronosStore((s) => s.selectEntity);
  const setHoveredEntity = useChronosStore((s) => s.setHoveredEntity);
  const requestCameraFocus = useChronosStore((s) => s.requestCameraFocus);
  const ordersFilterPreset = useChronosStore((s) => s.ordersFilterPreset);
  const setOrdersFilterPreset = useChronosStore((s) => s.setOrdersFilterPreset);

  const [fleetQuery, setFleetQuery] = useState('');
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>('ACTIVE');
  const [orderQuery, setOrderQuery] = useState('');

  const nowMs = Date.now();

  const routeByCourierId = useMemo(
    () => new Map(routes.map((r) => [r.courierId, r])),
    [routes],
  );

  // Map orderId -> { route, stopIndex } so every order immediately displays its parent petal
  const petalByOrderId = useMemo(() => {
    const map = new Map<string, { route: RoutePetalDto; stopIndex: number }>();
    for (const r of routes) {
      r.waypoints.forEach((wp, idx) => {
        map.set(wp.orderId, { route: r, stopIndex: idx });
      });
    }
    return map;
  }, [routes]);

  const filteredCouriers = useMemo(() => {
    const q = fleetQuery.trim().toLowerCase();
    const list = couriers.filter((c) => {
      if (fleetFilter === 'ACTIVE' && (c.status === 'OFFLINE' || c.status === 'IDLE')) return false;
      if (
        fleetFilter !== 'ALL' &&
        fleetFilter !== 'ACTIVE' &&
        c.status !== (fleetFilter as CourierStatus)
      ) {
        return false;
      }
      if (q && !c.name.toLowerCase().includes(q) && !c.courierId.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });

    // Sort active routed vehicles first, then by stop count descending
    return list.sort((a, b) => {
      const aStops = routeByCourierId.get(a.courierId)?.waypoints.length ?? a.activeRouteOrderIds.length;
      const bStops = routeByCourierId.get(b.courierId)?.waypoints.length ?? b.activeRouteOrderIds.length;
      if (bStops !== aStops) return bStops - aStops;
      return b.speedMps - a.speedMps;
    });
  }, [couriers, fleetFilter, fleetQuery, routeByCourierId]);

  const filteredOrders = useMemo(() => {
    const q = orderQuery.trim().toLowerCase();
    const list = orders.filter((o) => {
      const slackMs = new Date(o.windowEnd).getTime() - nowMs;
      if (ordersFilterPreset === 'LATE') {
        if (o.status === 'DELIVERED' || o.status === 'CANCELLED' || slackMs >= 0) return false;
      } else if (ordersFilterPreset === 'ACTIVE') {
        if (o.status !== 'ASSIGNED' && o.status !== 'PICKED_UP' && o.status !== 'IN_TRANSIT') {
          return false;
        }
      } else if (ordersFilterPreset === 'PENDING') {
        if (o.status !== 'PENDING' && o.status !== 'BATCHING') return false;
      } else if (ordersFilterPreset === 'DELIVERED') {
        if (o.status !== 'DELIVERED') return false;
      }

      if (q) {
        const petal = petalByOrderId.get(o.orderId);
        const matchOrder = o.orderId.toLowerCase().includes(q);
        const matchPetal = petal?.route.courierName.toLowerCase().includes(q) ?? false;
        if (!matchOrder && !matchPetal) return false;
      }
      return true;
    });

    // Sort urgent/in-petal orders first
    return list.sort((a, b) => {
      const aDone = a.status === 'DELIVERED' ? 1 : 0;
      const bDone = b.status === 'DELIVERED' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return new Date(a.windowEnd).getTime() - new Date(b.windowEnd).getTime();
    });
  }, [orders, ordersFilterPreset, orderQuery, nowMs, petalByOrderId]);

  const activeCourierCount = useMemo(
    () => couriers.filter((c) => c.status !== 'OFFLINE' && c.status !== 'IDLE').length,
    [couriers],
  );
  const lateOrderCount = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.status !== 'DELIVERED' &&
          o.status !== 'CANCELLED' &&
          new Date(o.windowEnd).getTime() < nowMs,
      ).length,
    [orders, nowMs],
  );

  const selectedCourierId =
    selectedEntity?.type === 'courier'
      ? selectedEntity.id
      : selectedEntity?.type === 'route'
        ? selectedEntity.courierId
        : null;
  const selectedOrderId = selectedEntity?.type === 'order' ? selectedEntity.id : null;

  return (
    <div className="pointer-events-none fixed bottom-3 left-3 top-[64px] z-20 flex items-stretch gap-2">
      {/* Compact Vertical Navigation Icon Rail (48px) */}
      <nav
        aria-label="Workspace navigation"
        className="pointer-events-auto hud-glass flex w-12 flex-col items-center gap-1.5 rounded-2xl py-2"
      >
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const isOpen = activeNavTab === id;
          const badge =
            id === 'fleet'
              ? activeCourierCount
              : id === 'orders' && lateOrderCount > 0
                ? lateOrderCount
                : null;
          return (
            <button
              key={id}
              type="button"
              title={`${label} Explorer`}
              onClick={() => setActiveNavTab(isOpen ? null : id)}
              className={`relative flex h-10 w-10 flex-col items-center justify-center rounded-xl transition-all ${
                isOpen
                  ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-400/50'
                  : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-100'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="mt-0.5 text-[9px] font-medium leading-none">{label}</span>
              {badge !== null && (
                <span
                  className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px] font-bold ${
                    id === 'orders'
                      ? 'bg-rose-500 text-white'
                      : 'bg-cyan-500/90 text-slate-950'
                  }`}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Collapsible Workspace Drawer (332px) */}
      {activeNavTab && (
        <aside className="pointer-events-auto hud-glass flex w-[332px] flex-col overflow-hidden rounded-2xl">
          {/* Drawer Header */}
          <div className="flex items-center justify-between border-b border-slate-800/80 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-100">
                {activeNavTab === 'fleet'
                  ? `Fleet Explorer (${filteredCouriers.length})`
                  : activeNavTab === 'orders'
                    ? `Orders & Petals (${filteredOrders.length})`
                    : activeNavTab === 'solver'
                      ? 'ALNS Solver Telemetry'
                      : 'Chaos & Surge Lab'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveNavTab(null)}
              title="Collapse drawer for fullscreen map"
              className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>

          {/* Tab 1: Fleet Explorer */}
          {activeNavTab === 'fleet' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-2 border-b border-slate-800/70 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={fleetQuery}
                    onChange={(e) => setFleetQuery(e.target.value)}
                    placeholder="Search vehicle callsign or ID…"
                    className="w-full rounded-lg border border-slate-700/80 bg-slate-900/90 py-1.5 pl-8 pr-7 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
                  />
                  {fleetQuery && (
                    <button
                      type="button"
                      onClick={() => setFleetQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      { id: 'ACTIVE', label: 'Active' },
                      { id: 'ALL', label: 'All' },
                      { id: 'EN_ROUTE_DROPOFF', label: 'Dropoff' },
                      { id: 'EN_ROUTE_PICKUP', label: 'Pickup' },
                      { id: 'IDLE', label: 'Idle' },
                      { id: 'OFFLINE', label: 'Offline' },
                    ] as const
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setFleetFilter(chip.id)}
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        fleetFilter === chip.id
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="hud-scrollbar flex-1 space-y-1.5 overflow-y-auto p-2.5">
                {filteredCouriers.slice(0, 120).map((c) => {
                  const route = routeByCourierId.get(c.courierId);
                  const stopCount = route?.waypoints.length ?? c.activeRouteOrderIds.length;
                  const meta = COURIER_STATUS_META[c.status];
                  const isSelected = selectedCourierId === c.courierId;
                  const loadPct = Math.min(
                    100,
                    Math.round((c.currentCapacityKg / Math.max(1, c.maxCapacityKg)) * 100),
                  );

                  return (
                    <div
                      key={c.courierId}
                      onMouseEnter={() => setHoveredEntity({ type: 'courier', id: c.courierId })}
                      onMouseLeave={() => setHoveredEntity(null)}
                      onClick={() => {
                        selectEntity({ type: 'courier', id: c.courierId });
                        if (route && route.pathCoords.length >= 2) {
                          requestCameraFocus(route.pathCoords);
                        } else {
                          requestCameraFocus([[c.lon, c.lat]]);
                        }
                      }}
                      className={`group cursor-pointer rounded-xl border p-2.5 transition-all ${
                        isSelected
                          ? 'border-amber-400/70 bg-amber-500/10 ring-1 ring-amber-400/30'
                          : 'border-slate-800/80 bg-slate-900/55 hover:border-cyan-500/40 hover:bg-slate-800/65'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: meta.hex }}
                          />
                          <span className="truncate text-xs font-semibold text-slate-100">
                            {c.name}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                          {stopCount > 0 && (
                            <span className="flex items-center gap-0.5 rounded bg-cyan-500/15 px-1.5 py-0.5 text-cyan-200">
                              <Route className="h-2.5 w-2.5" />
                              {stopCount}
                            </span>
                          )}
                          <span className="text-slate-300">
                            {(c.speedMps * 3.6).toFixed(0)} km/h
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-slate-400">{meta.label}</span>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400"
                              style={{ width: `${loadPct}%` }}
                            />
                          </div>
                          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                            {c.currentCapacityKg.toFixed(0)}/{c.maxCapacityKg}kg
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredCouriers.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-500">
                    No vehicles match the current filter.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Orders & Petal Membership Explorer */}
          {activeNavTab === 'orders' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="space-y-2 border-b border-slate-800/70 p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={orderQuery}
                    onChange={(e) => setOrderQuery(e.target.value)}
                    placeholder="Search order ID or vehicle petal…"
                    className="w-full rounded-lg border border-slate-700/80 bg-slate-900/90 py-1.5 pl-8 pr-7 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none"
                  />
                  {orderQuery && (
                    <button
                      type="button"
                      onClick={() => setOrderQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1">
                  {(
                    [
                      { id: 'ALL', label: 'All' },
                      { id: 'LATE', label: `Late (${lateOrderCount})` },
                      { id: 'ACTIVE', label: 'In Petal' },
                      { id: 'PENDING', label: 'Pending' },
                      { id: 'DELIVERED', label: 'Delivered' },
                    ] as const
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setOrdersFilterPreset(chip.id)}
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        ordersFilterPreset === chip.id
                          ? chip.id === 'LATE'
                            ? 'border-rose-500/60 bg-rose-500/20 text-rose-200'
                            : 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="hud-scrollbar flex-1 space-y-1.5 overflow-y-auto p-2.5">
                {filteredOrders.slice(0, 120).map((ord) => {
                  const petalInfo = petalByOrderId.get(ord.orderId);
                  const slack = formatMiniSlack(ord.windowEnd, nowMs);
                  const meta = ORDER_STATUS_META[ord.status];
                  const isSelected = selectedOrderId === ord.orderId;

                  return (
                    <div
                      key={ord.orderId}
                      onMouseEnter={() => setHoveredEntity({ type: 'order', id: ord.orderId })}
                      onMouseLeave={() => setHoveredEntity(null)}
                      onClick={() => {
                        selectEntity({ type: 'order', id: ord.orderId });
                        if (petalInfo && petalInfo.route.pathCoords.length >= 2) {
                          requestCameraFocus(petalInfo.route.pathCoords);
                        } else {
                          requestCameraFocus([[ord.dropoffLon, ord.dropoffLat]]);
                        }
                      }}
                      className={`cursor-pointer rounded-xl border p-2.5 transition-all ${
                        isSelected
                          ? 'border-amber-400/70 bg-amber-500/10 ring-1 ring-amber-400/30'
                          : 'border-slate-800/80 bg-slate-900/55 hover:border-cyan-500/40 hover:bg-slate-800/65'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: meta.hex }}
                          />
                          <span className="font-mono text-xs font-semibold text-slate-100">
                            {ord.orderId.slice(0, 8)}
                          </span>
                          <span className="font-mono text-[10px] text-slate-400">
                            {ord.weightKg.toFixed(1)} kg
                          </span>
                        </div>
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums ${
                            ord.status === 'DELIVERED'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : slack.late
                                ? 'bg-rose-500/20 text-rose-300'
                                : slack.tight
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {ord.status === 'DELIVERED' ? 'DONE' : slack.text}
                        </span>
                      </div>

                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
                        {petalInfo ? (
                          <span className="flex min-w-0 items-center gap-1 truncate rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-cyan-200">
                            <Route className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">
                              {petalInfo.route.courierName} · #{petalInfo.stopIndex + 1}/
                              {petalInfo.route.waypoints.length}
                            </span>
                          </span>
                        ) : (
                          <span className="text-slate-500">
                            {ord.status === 'DELIVERED'
                              ? 'Completed delivery'
                              : 'Unassigned — awaiting petal'}
                          </span>
                        )}
                        <Crosshair className="h-3 w-3 shrink-0 text-slate-500" />
                      </div>
                    </div>
                  );
                })}
                {filteredOrders.length === 0 && (
                  <div className="py-8 text-center text-xs text-slate-500">
                    No orders match the current filter.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab 3: Solver Telemetry & Re-Optimization */}
          {activeNavTab === 'solver' && (
            <div className="hud-scrollbar flex-1 overflow-y-auto p-3.5">
              <SolverPanelBody />
            </div>
          )}

          {/* Tab 4: Chaos & Surge Lab */}
          {activeNavTab === 'chaos' && (
            <div className="hud-scrollbar flex-1 overflow-y-auto p-3.5">
              <ChaosPanelBody />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
