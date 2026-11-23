import { useState } from 'react';
import {
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Cpu,
  GitCompareArrows,
  Loader2,
  Play,
  Sparkles,
  Timer,
  TrendingDown,
} from 'lucide-react';
import { useChronosStore } from '../../store/useChronosStore';
import type { SolveTelemetryDto } from '../../types/chronos';

function ObjectiveSparkline({ history }: { history: SolveTelemetryDto[] }) {
  if (history.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-xl border border-slate-800/80 bg-slate-900/50 text-[11px] text-slate-500">
        Awaiting ALNS solve telemetry…
      </div>
    );
  }

  // Use real intra-solve ALNS cooling descent trajectory when available
  const latest = history[history.length - 1];
  const points: number[] =
    latest?.convergenceHistory && latest.convergenceHistory.length >= 2
      ? latest.convergenceHistory
      : history.length >= 2
        ? history.map((h) => h.objectiveCost)
        : (() => {
            const finalCost = history[0].objectiveCost;
            return [
              finalCost * 1.38,
              finalCost * 1.29,
              finalCost * 1.21,
              finalCost * 1.14,
              finalCost * 1.09,
              finalCost * 1.04,
              finalCost * 1.01,
              finalCost,
            ];
          })();

  const width = 288;
  const height = 74;
  const padX = 8;
  const padY = 10;
  const minVal = Math.min(...points);
  const maxVal = Math.max(...points);
  const span = Math.max(1, maxVal - minVal);

  const coords = points.map((val, idx) => {
    const x = padX + (idx / Math.max(1, points.length - 1)) * (width - padX * 2);
    const y = padY + (1 - (val - minVal) / span) * (height - padY * 2);
    return { x, y };
  });

  const polyline = coords.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `M ${coords[0].x.toFixed(1)} ${height - padY} L ${coords
    .map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' L ')} L ${coords[coords.length - 1].x.toFixed(1)} ${height - padY} Z`;
  const last = coords[coords.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-20 w-full overflow-visible rounded-xl border border-slate-800/80 bg-slate-950/60"
    >
      <defs>
        <linearGradient id="alnsCostFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#alnsCostFill)" />
      <polyline
        fill="none"
        stroke="#22d3ee"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={polyline}
      />
      <circle cx={last.x} cy={last.y} r="3.5" fill="#10b981" stroke="#0f172a" strokeWidth="1.5" />
    </svg>
  );
}

function OperatorBar({
  label,
  weight,
  colorClass,
}: {
  label: string;
  weight: number;
  colorClass: string;
}) {
  const pct = Math.min(100, Math.max(4, Math.round(weight * 100)));
  return (
    <div className="space-y-1 tabular-nums">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-slate-400">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full transition-all ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function SolverPanelBody() {
  const latestSolve = useChronosStore((s) => s.latestSolve);
  const solveHistory = useChronosStore((s) => s.solveHistory);
  const operatorWeights = useChronosStore((s) => s.operatorWeights);
  const lastReoptimize = useChronosStore((s) => s.lastReoptimize);
  const isReoptimizing = useChronosStore((s) => s.isReoptimizing);
  const showRouteDiff = useChronosStore((s) => s.showRouteDiff);
  const setShowRouteDiff = useChronosStore((s) => s.setShowRouteDiff);
  const clearRouteDiff = useChronosStore((s) => s.clearRouteDiff);
  const triggerDynamicReoptimize = useChronosStore((s) => s.triggerDynamicReoptimize);
  const weatherSurgeIntensity = useChronosStore((s) => s.weatherSurgeIntensity);
  const systemMetrics = useChronosStore((s) => s.systemMetrics);

  const [batchSize, setBatchSize] = useState(50);

  const solveMs = latestSolve?.solveDurationMs ?? Number(systemMetrics.orchestrator?.lastSolveDurationMs ?? 0);
  const matrixMs =
    latestSolve?.matrixPreprocessMs ?? Number(systemMetrics.orchestrator?.lastMatrixPreprocessMs ?? 0);
  const workers =
    latestSolve?.activeWorkerThreads ?? Number(systemMetrics.orchestrator?.solverWorkers ?? 8);
  const objectiveCost =
    latestSolve?.objectiveCost ?? Number(systemMetrics.orchestrator?.lastObjectiveCost ?? 0);
  const iterations =
    latestSolve?.iterationsCompleted ?? Number(systemMetrics.orchestrator?.lastIterationsCompleted ?? 0);

  const solveBudgetPct = Math.min(100, Math.round((solveMs / 400) * 100));
  const matrixBudgetPct = Math.min(100, Math.round((matrixMs / 15) * 100));

  return (
    <div className="flex flex-col gap-3">
      {/* Status Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/15 ring-1 ring-cyan-400/40">
            <Cpu className="h-4 w-4 text-cyan-300" />
          </div>
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-100">
              C++20 ALNS Solver
            </h2>
            <p className="font-mono text-[10px] text-slate-400">
              {latestSolve?.solverStatus ?? 'READY'} · {iterations.toLocaleString()} iters
            </p>
          </div>
        </div>
        <span className="hud-pill border-indigo-500/40 bg-indigo-500/15 font-mono text-[10px] text-indigo-200 tabular-nums">
          {workers} std::jthread
        </span>
      </div>

      {/* Latency SLA Gauges: <400ms ALNS & <15ms CH Matrix */}
      <div className="grid grid-cols-2 gap-2 tabular-nums">
        <div className="hud-glass-subtle rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3 text-cyan-400" /> ALNS Solve
            </span>
            <span className="font-mono">&lt;400ms</span>
          </div>
          <div
            className={`mt-1 font-mono text-base font-bold ${
              solveMs > 400 ? 'text-rose-400' : solveMs > 320 ? 'text-amber-300' : 'text-emerald-300'
            }`}
          >
            {solveMs} ms
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full ${
                solveMs > 400 ? 'bg-rose-400' : 'bg-emerald-400'
              }`}
              style={{ width: `${solveBudgetPct}%` }}
            />
          </div>
        </div>

        <div className="hud-glass-subtle rounded-xl p-2.5">
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-indigo-400" /> CH Matrix
            </span>
            <span className="font-mono">&lt;15ms</span>
          </div>
          <div
            className={`mt-1 font-mono text-base font-bold ${
              matrixMs > 15 ? 'text-amber-300' : 'text-cyan-300'
            }`}
          >
            {matrixMs} ms
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full ${
                matrixMs > 15 ? 'bg-amber-400' : 'bg-cyan-400'
              }`}
              style={{ width: `${matrixBudgetPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Objective Convergence Sparkline */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs tabular-nums">
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <TrendingDown className="h-3.5 w-3.5 text-cyan-400" />
            Objective Convergence
          </span>
          <span className="font-mono text-xs font-bold text-cyan-300">
            {objectiveCost.toFixed(0)}
          </span>
        </div>
        <ObjectiveSparkline history={solveHistory} />
      </div>

      {/* Adaptive Destroy & Repair Operator Weights */}
      <div className="hud-glass-subtle space-y-3 rounded-xl p-3">
        <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          <span>Adaptive Operator Weights</span>
          <ArrowRightLeft className="h-3.5 w-3.5 text-slate-400" />
        </div>

        <div className="space-y-1.5">
          <div className="font-mono text-[10px] text-slate-400">DESTROY OPERATORS</div>
          <OperatorBar
            label="Shaw Removal"
            weight={operatorWeights.destroy.shaw}
            colorClass="bg-cyan-400"
          />
          <OperatorBar
            label="Worst Removal"
            weight={operatorWeights.destroy.worst}
            colorClass="bg-indigo-400"
          />
          <OperatorBar
            label="Random Removal"
            weight={operatorWeights.destroy.random}
            colorClass="bg-slate-400"
          />
        </div>

        <div className="space-y-1.5 border-t border-slate-800 pt-2">
          <div className="font-mono text-[10px] text-slate-400">REPAIR OPERATORS</div>
          <OperatorBar
            label="Regret-2 Insertion"
            weight={operatorWeights.repair.regret2}
            colorClass="bg-emerald-400"
          />
          <OperatorBar
            label="Greedy Insertion"
            weight={operatorWeights.repair.greedy}
            colorClass="bg-sky-400"
          />
        </div>
      </div>

      {/* Trigger Dynamic Re-Optimization CTA */}
      <div className="hud-glass-subtle space-y-2.5 rounded-xl p-3">
        <div className="flex items-center justify-between text-xs tabular-nums">
          <span className="text-slate-300">Dispatch Batch Size</span>
          <span className="font-mono font-semibold text-cyan-300">{batchSize} orders</span>
        </div>
        <input
          type="range"
          min={10}
          max={150}
          step={10}
          value={batchSize}
          onChange={(e) => setBatchSize(Number(e.target.value))}
          className="chronos-slider w-full"
        />

        <button
          type="button"
          disabled={isReoptimizing}
          onClick={() =>
            void triggerDynamicReoptimize({
              batchSize,
              weatherSeverityScore: weatherSurgeIntensity,
              speedMultiplier: Number(Math.max(0.4, 1 - weatherSurgeIntensity * 0.55).toFixed(2)),
            })
          }
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-sky-500 px-3 py-2.5 text-xs font-bold text-slate-950 shadow-glowCyan transition-all hover:from-cyan-400 hover:to-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isReoptimizing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Running ALNS Re-Optimization…</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 fill-current" />
              <span>Trigger Dynamic Re-Optimization</span>
            </>
          )}
        </button>
      </div>

      {/* Before-vs-After Route Diff Summary */}
      {lastReoptimize && (
        <div className="space-y-2.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-300">
              <GitCompareArrows className="h-3.5 w-3.5" />
              Before vs. After Diff
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowRouteDiff(!showRouteDiff)}
                className="rounded border border-emerald-500/40 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200 hover:bg-emerald-500/20"
              >
                {showRouteDiff ? 'HIDE' : 'SHOW'}
              </button>
              <button
                type="button"
                onClick={clearRouteDiff}
                className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:bg-slate-800"
              >
                CLEAR
              </button>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 text-center tabular-nums">
            <div className="rounded-lg bg-slate-950/60 p-2">
              <div className="font-mono text-xs font-bold text-emerald-300">
                -{(lastReoptimize.distanceSavedMeters / 1000).toFixed(2)} km
              </div>
              <div className="text-[10px] text-slate-400">Saved</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 p-2">
              <div className="font-mono text-xs font-bold text-cyan-300">
                {lastReoptimize.resolvedViolations}
              </div>
              <div className="text-[10px] text-slate-400">TW Fixed</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 p-2">
              <div className="font-mono text-xs font-bold text-amber-300">
                {lastReoptimize.reassignedOrderIds.length}
              </div>
              <div className="text-[10px] text-slate-400">Reassigned</div>
            </div>
          </div>

          <div className="flex items-center justify-between font-mono text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-3 rounded bg-rose-400/80" /> Before
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-3 rounded bg-emerald-400" /> After Re-Opt
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function SolverDrawer() {
  const solverDrawerOpen = useChronosStore((s) => s.solverDrawerOpen);
  const setSolverDrawerOpen = useChronosStore((s) => s.setSolverDrawerOpen);

  if (!solverDrawerOpen) {
    return (
      <button
        type="button"
        onClick={() => setSolverDrawerOpen(true)}
        className="hud-glass fixed right-3 top-[64px] z-20 flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold text-cyan-300 transition-colors hover:border-cyan-400/60 hover:text-cyan-200"
      >
        <ChevronLeft className="h-4 w-4" />
        <span>ALNS Solver</span>
      </button>
    );
  }

  return (
    <aside className="hud-glass hud-scrollbar fixed bottom-3 right-3 top-[64px] z-20 flex w-[340px] flex-col gap-3 overflow-y-auto rounded-2xl p-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setSolverDrawerOpen(false)}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Collapse solver drawer"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <SolverPanelBody />
    </aside>
  );
}
