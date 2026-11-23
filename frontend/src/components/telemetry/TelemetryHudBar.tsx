import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Cpu,
  Database,
  Globe2,
  Loader2,
  MapPin,
  Pause,
  Play,
  Radio,
  Route,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Truck,
} from 'lucide-react';
import { BOOKMARK_BY_ID, LOCATION_BOOKMARKS } from '../../constants/bookmarks';
import { useChronosStore } from '../../store/useChronosStore';
import type {
  BookmarkId,
  CircuitBreakerStatus,
  SimSpeedMultiplier,
  UpstreamName,
} from '../../types/chronos';

const UPSTREAM_LABELS: Record<UpstreamName, string> = {
  open_meteo: 'Open-Meteo',
  osrm: 'OSRM',
  overpass: 'Overpass',
};

const SPEED_OPTIONS: SimSpeedMultiplier[] = [0.5, 1, 2, 4];

function BreakerBadge({
  label,
  breaker,
}: {
  label: string;
  breaker: CircuitBreakerStatus;
}) {
  const errPct = Math.round((breaker.error_rate ?? 0) * 100);
  const state = breaker.state;
  const styleClass =
    state === 'OPEN'
      ? 'border-rose-500/60 bg-rose-500/15 text-rose-300'
      : state === 'HALF_OPEN'
        ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
        : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300';
  const dotClass =
    state === 'OPEN'
      ? 'bg-rose-400 animate-pulse'
      : state === 'HALF_OPEN'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-emerald-400';

  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium tabular-nums ${styleClass}`}
    >
      <span className="flex items-center gap-1.5 text-slate-200">
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        {label}
      </span>
      <span className="font-mono text-[10px] font-semibold">
        {state} · {errPct}%
      </span>
    </div>
  );
}

export function TelemetryHudBar() {
  const activeBookmarkId = useChronosStore((s) => s.activeBookmarkId);
  const selectBookmark = useChronosStore((s) => s.selectBookmark);
  const systemMetrics = useChronosStore((s) => s.systemMetrics);
  const roadGraphStats = useChronosStore((s) => s.roadGraphStats);
  const couriers = useChronosStore((s) => s.couriers);
  const orders = useChronosStore((s) => s.orders);
  const routes = useChronosStore((s) => s.routes);
  const isPaused = useChronosStore((s) => s.isPaused);
  const togglePaused = useChronosStore((s) => s.togglePaused);
  const simSpeedMultiplier = useChronosStore((s) => s.simSpeedMultiplier);
  const setSimSpeedMultiplier = useChronosStore((s) => s.setSimSpeedMultiplier);
  const isReoptimizing = useChronosStore((s) => s.isReoptimizing);
  const triggerDynamicReoptimize = useChronosStore((s) => s.triggerDynamicReoptimize);
  const setActiveNavTab = useChronosStore((s) => s.setActiveNavTab);
  const setOrdersFilterPreset = useChronosStore((s) => s.setOrdersFilterPreset);

  const [cityOpen, setCityOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const cityRef = useRef<HTMLDivElement | null>(null);
  const healthRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (cityRef.current && !cityRef.current.contains(e.target as Node)) {
        setCityOpen(false);
      }
      if (healthRef.current && !healthRef.current.contains(e.target as Node)) {
        setHealthOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const activeCity = BOOKMARK_BY_ID[activeBookmarkId];
  const ingestion = systemMetrics.ingestion;
  const orch = systemMetrics.orchestrator;
  const queuePct = Math.min(
    100,
    Math.round((ingestion.queue_depth / Math.max(1, ingestion.max_queue_size)) * 100),
  );
  const hikariActive = Number(orch?.hikariActiveConnections ?? 0);
  const hikariMax = Math.max(1, Number(orch?.hikariMaxConnections ?? 32));
  const vThreads = Number(orch?.activeVirtualThreads ?? 0);
  const pgLatencyMs = Number(orch?.postgisQueryLatencyMs ?? 0);

  const anyBreakerOpen = Object.values(systemMetrics.circuit_breakers).some(
    (b) => b.state !== 'CLOSED',
  );

  const activeFleetCount = useMemo(
    () => couriers.filter((c) => c.status !== 'OFFLINE' && c.status !== 'IDLE').length,
    [couriers],
  );
  const lateOrderCount = useMemo(() => {
    const now = Date.now();
    return orders.filter(
      (o) =>
        o.status !== 'DELIVERED' &&
        o.status !== 'CANCELLED' &&
        new Date(o.windowEnd).getTime() < now,
    ).length;
  }, [orders]);

  const osrmScale = roadGraphStats.osrmSpeedScale ?? 1.0;
  const roadLabel =
    roadGraphStats.source === 'osrm-calibrated-osm'
      ? `OSRM + OSM (${osrmScale.toFixed(2)}×)`
      : roadGraphStats.source === 'vector-tiles'
        ? 'OSM Live Roads'
        : roadGraphStats.source === 'overpass'
          ? 'Overpass OSM'
          : 'Loading OSM…';
  const roadBadgeClass =
    roadGraphStats.source === 'fallback-grid'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
      : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';

  const cycleSpeed = () => {
    const idx = SPEED_OPTIONS.indexOf(simSpeedMultiplier);
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    setSimSpeedMultiplier(next);
  };

  return (
    <header className="pointer-events-none fixed left-3 right-3 top-2.5 z-30 flex items-center justify-between gap-2">
      {/* Left: Brand + City Switcher + Road Graph Source Pill */}
      <div className="pointer-events-auto hud-glass flex h-[48px] items-center gap-2.5 rounded-2xl px-3">
        <div className="flex items-center gap-2 border-r border-slate-800 pr-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/15 ring-1 ring-cyan-400/40">
            <Radio className="h-4 w-4 text-cyan-300" />
          </div>
          <div className="hidden leading-tight sm:block">
            <div className="text-xs font-bold tracking-wide text-slate-100">
              CHRONOS<span className="text-cyan-400">ROUTE</span>
            </div>
            <div className="font-mono text-[9px] text-slate-400">SPATIAL DISPATCH</div>
          </div>
        </div>

        {/* City Bookmark Switcher */}
        <div ref={cityRef} className="relative">
          <button
            type="button"
            onClick={() => setCityOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/90 px-2.5 py-1 text-left transition-colors hover:border-cyan-500/50 hover:bg-slate-800/90"
          >
            <MapPin className="h-3.5 w-3.5 text-cyan-400" />
            <span className="text-xs font-semibold text-slate-100">{activeCity.name}</span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-slate-400 transition-transform ${
                cityOpen ? 'rotate-180' : ''
              }`}
            />
          </button>

          {cityOpen && (
            <div className="hud-glass absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-xl p-1.5">
              <div className="flex items-center justify-between px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Globe2 className="h-3 w-3 text-cyan-400" />
                  Metropolitan Regions
                </span>
                <span>OSM + Weather</span>
              </div>
              <div className="space-y-1">
                {LOCATION_BOOKMARKS.map((bm) => {
                  const selected = bm.id === activeBookmarkId;
                  return (
                    <button
                      key={bm.id}
                      type="button"
                      onClick={() => {
                        setCityOpen(false);
                        void selectBookmark(bm.id as BookmarkId);
                      }}
                      className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                        selected
                          ? 'bg-cyan-500/15 ring-1 ring-cyan-400/50'
                          : 'hover:bg-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-100">
                        <span>
                          {bm.name}{' '}
                          <span className="font-mono text-[10px] text-slate-400">
                            {bm.countryCode}
                          </span>
                        </span>
                        <span className="font-mono text-[10px] text-cyan-300">
                          {bm.weatherResolutionKm}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-slate-400">{bm.osmCoverage}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Live Road Graph Source Pill */}
        <span
          title={`Active road network: ${roadGraphStats.nodeCount.toLocaleString()} intersections · ${roadGraphStats.edgeCount.toLocaleString()} curved directed edges`}
          className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold md:inline-flex ${roadBadgeClass}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {roadLabel}
        </span>
      </div>

      {/* Center: Compact Interactive KPI Strip + Expandable System Health Popover */}
      <div className="pointer-events-auto hud-glass hidden h-[48px] items-center gap-1.5 rounded-2xl px-2 lg:flex">
        <button
          type="button"
          onClick={() => setActiveNavTab('fleet')}
          className="flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs transition-colors hover:bg-slate-800/80"
          title="Open Fleet Explorer"
        >
          <Truck className="h-3.5 w-3.5 text-cyan-400" />
          <span className="font-mono font-bold text-slate-100 tabular-nums">
            {activeFleetCount}
            <span className="font-normal text-slate-400">/{couriers.length}</span>
          </span>
          <span className="text-[10px] text-slate-400">Active</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveNavTab('fleet')}
          className="flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs transition-colors hover:bg-slate-800/80"
          title="Active route petals"
        >
          <Route className="h-3.5 w-3.5 text-sky-400" />
          <span className="font-mono font-bold text-slate-100 tabular-nums">{routes.length}</span>
          <span className="text-[10px] text-slate-400">Petals</span>
        </button>

        {lateOrderCount > 0 && (
          <button
            type="button"
            onClick={() => {
              setOrdersFilterPreset('LATE');
              setActiveNavTab('orders');
            }}
            className="flex items-center gap-1 rounded-xl border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-500/25"
            title="Jump to late time-window orders"
          >
            <AlertTriangle className="h-3 w-3 text-rose-400" />
            <span className="font-mono tabular-nums">{lateOrderCount}</span>
            <span className="text-[10px]">Late</span>
          </button>
        )}

        <div className="mx-1 h-5 w-px bg-slate-800" />

        {/* System Health & Telemetry Popover */}
        <div ref={healthRef} className="relative">
          <button
            type="button"
            onClick={() => setHealthOpen((v) => !v)}
            className="flex items-center gap-2 rounded-xl px-2.5 py-1 text-xs transition-colors hover:bg-slate-800/80"
          >
            {anyBreakerOpen ? (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            )}
            <span className="font-mono text-[11px] font-semibold text-slate-200 tabular-nums">
              {Math.round(ingestion.events_per_sec).toLocaleString()} ev/s
            </span>
            <ChevronDown className="h-3 w-3 text-slate-400" />
          </button>

          {healthOpen && (
            <div className="hud-glass absolute right-0 top-full z-50 mt-2 w-80 space-y-3 rounded-2xl p-3.5">
              <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-cyan-400" />
                  Polyglot System Telemetry
                </span>
                <span className="font-mono text-cyan-300">
                  {roadGraphStats.nodeCount.toLocaleString()}n / {roadGraphStats.edgeCount.toLocaleString()}e
                </span>
              </div>

              <div className="hud-glass-subtle space-y-1.5 rounded-xl p-2.5 text-xs tabular-nums">
                <div className="flex justify-between">
                  <span className="text-slate-400">Ingestion Queue</span>
                  <span className="font-mono text-slate-200">
                    {ingestion.queue_depth.toLocaleString()} / {ingestion.max_queue_size.toLocaleString()}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={`h-full ${queuePct > 80 ? 'bg-rose-400' : 'bg-cyan-400'}`}
                    style={{ width: `${queuePct}%` }}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                {(['open_meteo', 'osrm', 'overpass'] as UpstreamName[]).map((u) => (
                  <BreakerBadge
                    key={u}
                    label={UPSTREAM_LABELS[u]}
                    breaker={systemMetrics.circuit_breakers[u]}
                  />
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] tabular-nums">
                <div className="hud-glass-subtle rounded-xl p-2">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <Cpu className="h-3 w-3 text-indigo-400" /> Virtual Threads
                  </div>
                  <div className="mt-0.5 font-mono font-bold text-slate-100">{vThreads} active</div>
                </div>
                <div className="hud-glass-subtle rounded-xl p-2">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <Database className="h-3 w-3 text-emerald-400" /> Hikari / PostGIS
                  </div>
                  <div className="mt-0.5 font-mono font-bold text-slate-100">
                    {hikariActive}/{hikariMax} · {pgLatencyMs.toFixed(1)}ms
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right: Playback Speed + Quick Re-Opt */}
      <div className="pointer-events-auto hud-glass flex h-[48px] items-center gap-1.5 rounded-2xl px-2">
        <div className="flex items-center gap-1 border-r border-slate-800 pr-1.5">
          <button
            type="button"
            onClick={togglePaused}
            title={isPaused ? 'Resume simulation (Space)' : 'Pause simulation (Space)'}
            className={`flex h-8 w-8 items-center justify-center rounded-xl border transition-colors ${
              isPaused
                ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
                : 'border-slate-700/70 bg-slate-900/80 text-slate-200 hover:border-cyan-500/50'
            }`}
          >
            {isPaused ? <Play className="h-3.5 w-3.5 fill-current" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={cycleSpeed}
            title="Cycle simulation playback speed"
            className="h-8 rounded-xl border border-slate-700/70 bg-slate-900/80 px-2 font-mono text-[11px] font-bold text-cyan-300 tabular-nums transition-colors hover:border-cyan-500/50"
          >
            {simSpeedMultiplier}×
          </button>
        </div>

        <button
          type="button"
          disabled={isReoptimizing}
          onClick={() => void triggerDynamicReoptimize({ batchSize: 50 })}
          title="Run ALNS Multi-Stop Re-Optimization"
          className="flex h-8 items-center gap-1.5 rounded-xl bg-cyan-500/15 px-3 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-400/40 transition-colors hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {isReoptimizing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Re-Opt</span>
        </button>
      </div>
    </header>
  );
}
