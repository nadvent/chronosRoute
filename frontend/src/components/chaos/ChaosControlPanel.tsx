import {
  ChevronDown,
  ChevronUp,
  CloudLightning,
  Flame,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import { useChronosStore } from '../../store/useChronosStore';
import type { UpstreamName } from '../../types/chronos';

const FAULT_TARGETS: { upstream: UpstreamName; label: string }[] = [
  { upstream: 'osrm', label: 'OSRM Router' },
  { upstream: 'open_meteo', label: 'Open-Meteo' },
  { upstream: 'overpass', label: 'Overpass OSM' },
];

export function ChaosPanelBody() {
  const burstRatePerSec = useChronosStore((s) => s.burstRatePerSec);
  const setBurstRatePerSec = useChronosStore((s) => s.setBurstRatePerSec);
  const burstRunning = useChronosStore((s) => s.burstRunning);
  const triggerBurst = useChronosStore((s) => s.triggerBurst);
  const faultModes = useChronosStore((s) => s.faultModes);
  const setFaultInjection = useChronosStore((s) => s.setFaultInjection);
  const weatherSurgeIntensity = useChronosStore((s) => s.weatherSurgeIntensity);
  const setWeatherSurgeIntensity = useChronosStore((s) => s.setWeatherSurgeIntensity);
  const applyWeatherSurgeNow = useChronosStore((s) => s.applyWeatherSurgeNow);

  const surgePct = Math.round(weatherSurgeIntensity * 100);
  const speedMult = Math.max(0.4, 1 - weatherSurgeIntensity * 0.55);

  return (
    <div className="space-y-3.5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/15 ring-1 ring-amber-400/40">
          <Flame className="h-4 w-4 text-amber-300" />
        </div>
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-100">
            Chaos &amp; Surge Controls
          </h2>
          <p className="font-mono text-[10px] text-slate-400">
            OSRM + OSM Road Simulation Engine
          </p>
        </div>
      </div>

      {/* GPS Burst Rate Slider */}
      <div className="hud-glass-subtle space-y-2 rounded-xl p-3 tabular-nums">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-300">GPS Telemetry Burst</span>
          <span className="font-mono font-semibold text-cyan-300">
            {burstRatePerSec.toLocaleString()} ev/s
          </span>
        </div>
        <input
          type="range"
          min={500}
          max={5000}
          step={250}
          value={burstRatePerSec}
          onChange={(e) => setBurstRatePerSec(Number(e.target.value))}
          className="chronos-slider w-full"
        />
        <button
          type="button"
          onClick={() => void triggerBurst()}
          className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
            burstRunning
              ? 'border-cyan-400 bg-cyan-500/25 text-cyan-100'
              : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
          }`}
        >
          <Zap className="h-3 w-3" />
          <span>{burstRunning ? 'Streaming Burst…' : 'Fire GPS Ping Burst'}</span>
        </button>
      </div>

      {/* Upstream Fault Injection Toggles */}
      <div className="hud-glass-subtle space-y-2 rounded-xl p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
          <ShieldAlert className="h-3.5 w-3.5 text-rose-400" />
          <span>Circuit Breaker Fault Injection</span>
        </div>
        <div className="space-y-1.5">
          {FAULT_TARGETS.map(({ upstream, label }) => {
            const current = faultModes[upstream];
            return (
              <div
                key={upstream}
                className="flex items-center justify-between rounded-lg border border-slate-800/90 bg-slate-900/65 px-2.5 py-1.5"
              >
                <span className="text-[11px] text-slate-300">{label}</span>
                <div className="flex items-center gap-1 font-mono text-[10px]">
                  {(
                    [
                      { val: null, text: 'OK' },
                      { val: 429, text: '429' },
                      { val: 503, text: '503' },
                    ] as const
                  ).map((opt) => {
                    const active = current === opt.val;
                    const activeStyle =
                      opt.val === null
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                        : 'bg-rose-500/25 text-rose-300 border-rose-500/50';
                    return (
                      <button
                        key={opt.text}
                        type="button"
                        onClick={() => void setFaultInjection(upstream, opt.val)}
                        className={`rounded border px-1.5 py-0.5 transition-colors ${
                          active
                            ? activeStyle
                            : 'border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                        }`}
                      >
                        {opt.text}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Monsoon Weather Surge Slider */}
      <div className="hud-glass-subtle space-y-2 rounded-xl p-3 tabular-nums">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1 text-slate-300">
            <CloudLightning className="h-3.5 w-3.5 text-amber-400" />
            Monsoon Weather Surge
          </span>
          <span className="font-mono text-[11px] text-amber-300">
            {surgePct}% ({speedMult.toFixed(2)}×)
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={weatherSurgeIntensity}
          onChange={(e) => setWeatherSurgeIntensity(Number(e.target.value))}
          className="chronos-slider w-full"
        />
        <button
          type="button"
          onClick={() => void applyWeatherSurgeNow()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-500/45 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 transition-colors hover:bg-amber-500/25"
        >
          <CloudLightning className="h-3 w-3" />
          <span>Apply Surge &amp; Re-Route Fleet</span>
        </button>
      </div>
    </div>
  );
}

export function ChaosControlPanel() {
  const chaosPanelOpen = useChronosStore((s) => s.chaosPanelOpen);
  const setChaosPanelOpen = useChronosStore((s) => s.setChaosPanelOpen);

  return (
    <section className="hud-glass fixed bottom-3 left-3 z-20 w-[320px] overflow-hidden rounded-2xl">
      <button
        type="button"
        onClick={() => setChaosPanelOpen(!chaosPanelOpen)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-slate-900/60"
      >
        <span className="text-xs font-bold uppercase tracking-wider text-slate-100">
          Chaos &amp; Surge Controls
        </span>
        {chaosPanelOpen ? (
          <ChevronDown className="h-4 w-4 text-slate-400" />
        ) : (
          <ChevronUp className="h-4 w-4 text-slate-400" />
        )}
      </button>
      {chaosPanelOpen && (
        <div className="border-t border-slate-800/80 px-3.5 pb-3.5 pt-3">
          <ChaosPanelBody />
        </div>
      )}
    </section>
  );
}
