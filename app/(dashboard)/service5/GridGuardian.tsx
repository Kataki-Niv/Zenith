"use client";

import { Cpu } from "lucide-react";
import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

const initialMetrics = {
  shared: 1873,
  savings: 3500,
  efficiency: 78,
  beforeCost: 3820,
  afterCost: 2420,
};

type OptimizationFlow = {
  from: string;
  to: string;
  amount: number;
};

type HistoryEntry = {
  title: string;
  time: string;
  active?: boolean;
};

type NetworkConnection = {
  key: string;
  from: string;
  to: string;
  path: string;
  color: "cyan" | "amber" | "green";
  dot: { cx: number; cy: number; path: string };
};

const networkConnections: NetworkConnection[] = [
  {
    key: "home1-home2-top",
    from: "Home1",
    to: "Home2",
    path: "M15 30 C22 28, 32 24, 42 18",
    color: "cyan",
    dot: { cx: 21, cy: 33, path: "M0 0 C7 -2, 17 -6, 27 -12" },
  },
  {
    key: "home1-home2-bottom",
    from: "Home1",
    to: "Home2B",
    path: "M15 30 C22 38, 27 50, 24 66",
    color: "cyan",
    dot: { cx: 22, cy: 62, path: "M0 0 C9 -8, 12 -18, 20 -42" },
  },
  {
    key: "home1-hub",
    from: "Home1",
    to: "Hub",
    path: "M15 30 C28 34, 40 44, 50 53",
    color: "cyan",
    dot: { cx: 18, cy: 31, path: "M0 0 C14 4, 26 14, 36 22" },
  },
  {
    key: "home2b-home2",
    from: "Home2B",
    to: "Home2",
    path: "M24 66 C30 58, 34 44, 42 18",
    color: "cyan",
    dot: { cx: 27, cy: 61, path: "M0 0 C7 -8, 11 -19, 18 -43" },
  },
  {
    key: "home2b-hub",
    from: "Home2B",
    to: "Hub",
    path: "M24 66 C32 68, 40 63, 50 53",
    color: "cyan",
    dot: { cx: 28, cy: 65, path: "M0 0 C8 2, 16 -3, 26 -13" },
  },
  {
    key: "home2-home3",
    from: "Home2",
    to: "Home3",
    path: "M42 18 C53 18, 65 20, 80 31",
    color: "amber",
    dot: { cx: 45, cy: 21, path: "M0 0 C11 0, 23 2, 38 13" },
  },
  {
    key: "home2-hub",
    from: "Home2",
    to: "Hub",
    path: "M42 18 C45 28, 46 40, 50 53",
    color: "amber",
    dot: { cx: 43, cy: 21, path: "M0 0 C3 10, 4 21, 8 34" },
  },
  {
    key: "home2-home4",
    from: "Home2",
    to: "Home4",
    path: "M42 18 C58 28, 67 42, 80 69",
    color: "amber",
    dot: { cx: 45, cy: 21, path: "M0 0 C16 10, 25 24, 38 48" },
  },
  {
    key: "hub-home3",
    from: "Hub",
    to: "Home3",
    path: "M50 53 C58 48, 69 38, 80 31",
    color: "green",
    dot: { cx: 53, cy: 51, path: "M0 0 C8 -5, 19 -15, 30 -20" },
  },
  {
    key: "hub-home4",
    from: "Hub",
    to: "Home4",
    path: "M50 53 C60 62, 68 67, 80 69",
    color: "amber",
    dot: { cx: 51, cy: 55, path: "M0 0 C9 7, 17 12, 28 14" },
  },
];

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6 },
  },
};

const staggerContainer = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.15,
    },
  },
};

export default function GridGuardian() {
  const [metrics, setMetrics] = useState(initialMetrics);
  const [displayMetrics, setDisplayMetrics] = useState(initialMetrics);
  const [flows, setFlows] = useState<OptimizationFlow[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([
    { title: "Algorithmic improvement", time: "2h ago" },
    { title: "Algorithmic improvement", time: "1h ago" },
    { title: "Algorithmic improvement", time: "1h ago" },
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [pulse, setPulse] = useState(false);

  const activeFlowMap = new Map(
    flows.map((flow) => [`${flow.from}-${flow.to}`, flow.amount])
  );

  useEffect(() => {
    const duration = 700;
    const steps = 20;
    const stepMs = duration / steps;
    const startMetrics = displayMetrics;
    let currentStep = 0;

    const interval = window.setInterval(() => {
      currentStep += 1;
      const progress = currentStep / steps;

      setDisplayMetrics({
        shared: Math.round(
          startMetrics.shared + (metrics.shared - startMetrics.shared) * progress
        ),
        savings: Math.round(
          startMetrics.savings + (metrics.savings - startMetrics.savings) * progress
        ),
        efficiency: Math.round(
          startMetrics.efficiency +
            (metrics.efficiency - startMetrics.efficiency) * progress
        ),
        beforeCost: Math.round(
          startMetrics.beforeCost +
            (metrics.beforeCost - startMetrics.beforeCost) * progress
        ),
        afterCost: Math.round(
          startMetrics.afterCost +
            (metrics.afterCost - startMetrics.afterCost) * progress
        ),
      });

      if (currentStep >= steps) {
        window.clearInterval(interval);
      }
    }, stepMs);

    return () => window.clearInterval(interval);
  }, [metrics]);

  useEffect(() => {
    if (!pulse) {
      return;
    }

    const timer = window.setTimeout(() => setPulse(false), 850);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  const handleOptimization = async () => {
    if (isRunning) {
      return;
    }

    setIsRunning(true);
    setIsComplete(false);
    setPulse(false);
    try {
      const response = await fetch("/api/optimize");
      const result = await response.json();

      if (!response.ok) {
        throw new Error("Optimization request failed.");
      }

      setFlows(Array.isArray(result.flows) ? result.flows : []);
      setMetrics((prev) => ({
        ...prev,
        savings:
          typeof result.savings === "number" ? result.savings : prev.savings,
        efficiency:
          typeof result.efficiency === "number"
            ? Math.min(result.efficiency, 100)
            : prev.efficiency,
        beforeCost:
          typeof result.beforeCost === "number" ? result.beforeCost : prev.beforeCost,
        afterCost:
          typeof result.afterCost === "number"
            ? Math.min(
                result.afterCost,
                typeof result.beforeCost === "number"
                  ? result.beforeCost - 1
                  : prev.beforeCost - 1
              )
            : prev.afterCost,
      }));
      setHistoryEntries((prev) => [
        { title: "Optimization Complete", time: "Just now", active: true },
        ...prev.map((entry) => ({ ...entry, active: false })),
      ]);
      setIsRunning(false);
      setIsComplete(true);
      setPulse(true);
    } catch (error) {
      console.error("Optimization request failed:", error);
      setIsRunning(false);
    }
  };

  return (
    <section className="w-full bg-[#030908] px-4 py-5 text-white md:px-6">
      <motion.div
        initial="hidden"
        animate="show"
        variants={staggerContainer}
        className="mx-auto max-w-[1180px]"
      >
        <motion.div variants={fadeUp} className="mb-5">
          <div className="flex">
            <div className="flex items-center gap-2 rounded-full bg-slate-800/50 px-3 py-1.5 backdrop-blur-md shadow-lg border border-slate-700/50">
              <Cpu className="h-4 w-4 text-emerald-400" />
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Zenith Enterprise OS v6.0
              </span>
            </div>
          </div>
          <h2 className="mt-4 text-[clamp(28px,4vw,46px)] font-black tracking-tighter leading-tight text-[#F3F4F4]">
            Next-Gen{" "}
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400">
              Grid Intelligence
            </span>
          </h2>
          <p className="mt-4 text-sm md:text-base text-[#F3F4F4] max-w-2xl">
            Autonomous Microgrid Control for Decentralized Neighborhood Energy Sharing
          </p>
        </motion.div>

        <div className="rounded-[22px] border border-white/8 bg-[#040b0a] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.03),0_20px_60px_rgba(0,0,0,0.35)] md:p-5">
        <motion.div
          variants={fadeUp}
          className="flex flex-col gap-4 border-b border-white/6 pb-4 md:flex-row md:items-start md:justify-between"
        >
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
                  <path d="M12 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M12 17v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M3 12h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M17 12h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </span>
              <h1 className="text-2xl font-black tracking-tight text-white">
                GridGuardian
              </h1>
            </div>
            <p className="mt-3 text-[15px] text-emerald-100/55">
              Smart Grid Control Center
            </p>
            <p className="mt-1 text-sm text-slate-400">
              Control Center for a Connected Microgrid of Multiple Homes
            </p>
          </div>

          <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-500/8 px-5 py-2.5 text-sm text-emerald-200 shadow-[0_0_24px_rgba(16,185,129,0.14)]">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(74,222,128,0.95)]" />
            Optimization Engine: Active &amp; Learning
          </div>
        </motion.div>

        <div className="mt-5 space-y-4">
          <motion.div variants={fadeUp} className="grid grid-cols-4 gap-3">
              <KpiCard label="Total Energy Shared (kWh)" value="1,873 kWh" icon="share" highlight={pulse}>
                <p className="mt-3 text-[11px] text-cyan-200/70">Across the full connected microgrid</p>
              </KpiCard>

              <KpiCard label="Monthly Savings (Rs)" value={`Rs ${displayMetrics.savings.toLocaleString("en-IN")}`} icon="money" highlight={pulse}>
                <svg viewBox="0 0 120 32" className="mt-3 h-8 w-full">
                  <path d="M2 24 C16 24, 18 14, 32 14 S50 26, 64 20 S82 6, 92 10 S106 18, 118 6" fill="none" stroke="rgba(74,222,128,0.9)" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <p className="mt-2 text-[11px] text-emerald-200/70">Estimated for all participating homes</p>
              </KpiCard>

              <KpiCard label="Optimization Efficiency (%)" value={`${displayMetrics.efficiency}%`} icon="efficiency" highlight={pulse}>
                <div className="mt-4 flex items-center gap-3">
                  <div className="relative h-10 w-20 overflow-hidden">
                    <div className="absolute inset-x-0 bottom-0 h-20 rounded-t-full border-[6px] border-b-0 border-teal-300/55" />
                    <div
                      className="absolute bottom-1 left-1/2 h-8 w-[2px] origin-bottom bg-teal-200 shadow-[0_0_8px_rgba(94,234,212,0.8)]"
                      style={{ transform: `translateX(-50%) rotate(${displayMetrics.efficiency - 90}deg)` }}
                    />
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-teal-200/70">Measured at the microgrid level</p>
              </KpiCard>

              <button
                type="button"
                onClick={handleOptimization}
                disabled={isRunning}
                className={`group relative min-h-[116px] overflow-hidden rounded-2xl border px-5 py-4 text-left transition-all duration-300 ${
                  isRunning
                    ? "cursor-wait border-emerald-300/30 bg-[linear-gradient(135deg,rgba(18,111,91,0.98),rgba(7,42,35,0.98))] shadow-[0_0_20px_rgba(16,185,129,0.6)]"
                    : isComplete
                      ? "border-emerald-300/35 bg-[linear-gradient(135deg,rgba(19,121,85,0.98),rgba(7,48,34,0.98))] shadow-[0_0_20px_rgba(16,185,129,0.6)]"
                      : "border-cyan-400/20 bg-[linear-gradient(135deg,rgba(11,68,62,0.98),rgba(7,38,38,0.98))] shadow-[0_0_20px_rgba(34,211,238,0.22)] hover:scale-[1.05] hover:border-cyan-300/35 hover:shadow-[0_0_28px_rgba(34,211,238,0.35)]"
                } ${isRunning ? "animate-pulse" : ""}`}
              >
                <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <span className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(45,212,191,0.14),_transparent_48%)]" />

                <span className="relative flex h-full flex-col justify-center gap-3">
                  <span
                    className={`inline-flex h-11 w-11 items-center justify-center rounded-full border ${
                      isRunning
                        ? "border-emerald-200/30 bg-emerald-400/10 text-emerald-100"
                        : isComplete
                          ? "border-emerald-300/35 bg-emerald-400/15 text-emerald-100"
                          : "border-emerald-400/24 bg-emerald-500/10 text-emerald-200"
                    }`}
                  >
                    {isRunning ? (
                      <span className="h-5 w-5 rounded-full border-2 border-emerald-200/25 border-t-emerald-200 animate-spin" />
                    ) : isComplete ? (
                      <svg
                        viewBox="0 0 20 20"
                        className="h-5 w-5"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M4.5 10.5 8 14l7.5-8"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 20 20"
                        className="h-5 w-5"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M11 1.5 4.8 10h3.7L7.9 18.5 15.2 9H11V1.5Z"
                          fill="currentColor"
                          stroke="currentColor"
                          strokeWidth="0.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>

                  <span className="flex flex-col gap-1">
                    <span className="text-[18px] font-bold leading-tight text-white">
                      {isRunning
                        ? "Optimizing..."
                        : isComplete
                          ? "Optimization Complete"
                          : "Run Optimization"}
                    </span>
                    <span className="text-xs leading-relaxed text-emerald-100/60">
                      {isRunning
                        ? "AI is computing energy distribution"
                        : isComplete
                          ? "Grid Balanced Successfully"
                          : "Balance energy across homes"}
                    </span>
                    {isComplete ? (
                      <span className="text-[11px] font-medium text-emerald-200 animate-pulse">
                        +Rs 700 additional savings achieved
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
          </motion.div>

          <motion.div
            variants={fadeUp}
            className="rounded-[22px] border border-white/6 bg-[linear-gradient(180deg,rgba(8,18,16,0.96),rgba(5,13,11,0.98))] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
          >
              <p className="mb-3 text-sm font-medium text-slate-300">
                Live Energy Flow Across 5 Connected Homes
              </p>
              <div className="mb-4 flex flex-wrap gap-3">
                <StatusBadge label="Solar Surplus Detected" tone="emerald" />
                <StatusBadge label="Demand Spike Handled" tone="amber" pulse={isRunning} />
              </div>

              <div className="relative h-[360px] overflow-hidden rounded-[20px] border border-white/6 bg-[radial-gradient(circle_at_40%_40%,_rgba(20,184,166,0.08),_transparent_42%),linear-gradient(180deg,_rgba(5,13,11,0.95),_rgba(3,10,9,0.98))]">
                {isRunning ? (
                  <div className="absolute left-1/2 top-5 z-20 -translate-x-1/2 rounded-full border border-emerald-300/20 bg-[#071815]/90 px-4 py-2 text-center shadow-[0_0_18px_rgba(16,185,129,0.22)]">
                    <p className="text-sm font-semibold text-emerald-200">
                      AI optimizing energy flow...
                    </p>
                    <p className="text-xs text-emerald-100/55">
                      Balancing demand and supply...
                    </p>
                  </div>
                ) : null}
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <filter id="glow-cyan">
                      <feGaussianBlur stdDeviation="1.2" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <filter id="glow-amber">
                      <feGaussianBlur stdDeviation="1.1" result="blur" />
                      <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                  </defs>

                  {networkConnections.map((connection) => {
                    const amount =
                      activeFlowMap.get(`${connection.from}-${connection.to}`) ?? 0;
                    const isActive = amount > 0;
                    const palette =
                      connection.color === "amber"
                        ? {
                            stroke: "rgba(250,204,21,0.88)",
                            dot: "rgba(250,204,21,0.98)",
                            filter: "url(#glow-amber)",
                          }
                        : connection.color === "green"
                          ? {
                              stroke: "rgba(161,255,192,0.82)",
                              dot: "rgba(161,255,192,0.98)",
                              filter: undefined,
                            }
                          : {
                              stroke: "rgba(52,211,235,0.9)",
                              dot: "rgba(52,211,235,0.98)",
                              filter: "url(#glow-cyan)",
                            };

                    return (
                      <g key={connection.key}>
                        <path
                          d={connection.path}
                          stroke={palette.stroke}
                          strokeWidth={isActive ? Math.max(amount * 0.22, 1) : 0.75}
                          strokeOpacity={isActive ? 1 : 0.2}
                          fill="none"
                          filter={isActive ? palette.filter : undefined}
                        />
                        <circle
                          cx={connection.dot.cx}
                          cy={connection.dot.cy}
                          r={isActive ? 0.9 : 0}
                          fill={palette.dot}
                        >
                          {isActive ? (
                            <animateMotion
                              dur={`${Math.max(2.2, 4.2 - amount * 0.18)}s`}
                              repeatCount="indefinite"
                              path={connection.dot.path}
                            />
                          ) : null}
                        </circle>
                      </g>
                    );
                  })}
                </svg>

                <Node className="left-[10%] top-[22%]" title="Home 1" subtitle="Surplus" ring="cyan" icon="sun" pulse />
                <Node className="left-[26%] top-[70%]" title="Home 2" subtitle="Generating" ring="sky" icon="home" />
                <Node className="left-[44%] top-[15%]" title="Your Home" subtitle="Generating" ring="teal-highlight" icon="home" />
                <Node className="left-[50%] top-[53%]" title="Microgrid Hub" subtitle="Routing" ring="teal" icon="hub" />
                <Node className="left-[80%] top-[28%]" title="Home 3" subtitle="Consuming" ring="rose" icon="home" />
                <Node className="left-[82%] top-[72%]" title="Home 4" subtitle="Demand Spike" ring="amber" icon="bolt" pulse={pulse} />
              </div>
          </motion.div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <motion.div
              variants={fadeUp}
              className={`rounded-[22px] border border-white/6 bg-[linear-gradient(180deg,rgba(18,27,24,0.94),rgba(9,17,15,0.98))] p-3 transition-all duration-300 ${pulse ? "shadow-[0_0_20px_rgba(16,185,129,0.14)]" : ""}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[15px] text-emerald-100/55">Before vs After Cost</p>
                  <h2 className="mt-1 text-[22px] font-bold leading-tight text-white">Cost Comparison</h2>
                </div>
                <span className="rounded-full border border-emerald-400/18 bg-emerald-500/10 px-4 py-1 text-sm text-emerald-200">
                  {isComplete ? "Updated" : "Live"}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <CostColumn label="Before" value={displayMetrics.beforeCost} maxValue={displayMetrics.beforeCost} fill="bg-slate-300/70" />
                <CostColumn label="After" value={displayMetrics.afterCost} maxValue={displayMetrics.beforeCost} fill="bg-gradient-to-t from-emerald-500 to-teal-300" />
              </div>
            </motion.div>

            <motion.div
              variants={fadeUp}
              className="rounded-[22px] border border-white/6 bg-[linear-gradient(180deg,rgba(18,27,24,0.94),rgba(9,17,15,0.98))] p-3"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[15px] text-emerald-100/55">Optimization History</p>
                  <h2 className="mt-1 text-[22px] font-bold leading-tight text-white">Recent Events</h2>
                </div>
                <span className="text-emerald-200/45">O</span>
              </div>

              <div className="mt-3 space-y-2">
                {historyEntries.map((entry, index) => (
                  <HistoryRow
                    key={`${entry.title}-${entry.time}-${index}`}
                    title={entry.title}
                    time={entry.time}
                    active={entry.active}
                  />
                ))}
              </div>
            </motion.div>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-emerald-100/35">
          2026 Zenith Energy Systems. All rights reserved.
        </p>
        </div>
      </motion.div>
    </section>
  );
}

function KpiCard({
  label,
  value,
  icon,
  highlight = false,
  children,
}: {
  label: string;
  value: string;
  icon: "share" | "money" | "efficiency";
  highlight?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`relative min-w-0 overflow-hidden rounded-[22px] border p-4 transition-all duration-300 ${highlight ? "border-slate-600 bg-slate-800/80 shadow-lg shadow-slate-950/50" : "border-slate-800 bg-slate-900/40 hover:bg-slate-800/50"}`}>
      <div className="absolute left-1/2 top-0 h-[3px] w-full -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400" />
      <div className="relative">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="max-w-[11ch] text-[13px] leading-[1.35] text-[#F3F4F4]/58">{label}</p>
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-950 text-slate-300 shadow-inner">
            <KpiIcon type={icon} />
          </span>
        </div>
        <p className="mt-1 text-[24px] font-black leading-[1.05] text-white">{value}</p>
        {children}
      </div>
    </div>
  );
}

function KpiIcon({ type }: { type: "share" | "money" | "efficiency" }) {
  if (type === "money") {
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
        <path d="M4 5h12v10H4z" stroke="currentColor" strokeWidth="1.6" rx="2" />
        <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }

  if (type === "efficiency") {
    return (
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
        <path d="M4 13a6 6 0 1 1 12 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M10 10l3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M6 6h8M6 10h5M6 14h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function StatusBadge({
  label,
  tone,
  pulse = false,
}: {
  label: string;
  tone: "emerald" | "amber";
  pulse?: boolean;
}) {
  const style =
    tone === "emerald"
      ? "border-emerald-400/22 bg-emerald-500/10 text-emerald-200"
      : "border-amber-400/20 bg-amber-500/10 text-amber-200";

  return (
    <div className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm transition-all duration-500 ${style} ${pulse ? "animate-pulse shadow-[0_0_18px_rgba(250,204,21,0.22)]" : ""}`}>
      <span className="h-2.5 w-2.5 rounded-full bg-current" />
      {label}
    </div>
  );
}

function Node({
  className,
  title,
  subtitle,
  icon,
  ring,
  pulse = false,
}: {
  className: string;
  title: string;
  subtitle: string;
  icon: "sun" | "home" | "hub" | "bolt";
  ring: "cyan" | "sky" | "emerald" | "teal" | "teal-highlight" | "rose" | "amber";
  pulse?: boolean;
}) {
  const styles = {
    cyan: "border-cyan-300/45 bg-cyan-400/10 text-cyan-100 shadow-[0_0_38px_rgba(34,211,238,0.22)]",
    sky: "border-sky-300/45 bg-sky-400/12 text-sky-100 shadow-[0_0_34px_rgba(96,165,250,0.18)]",
    emerald: "border-emerald-300/45 bg-emerald-400/12 text-emerald-100 shadow-[0_0_38px_rgba(74,222,128,0.22)]",
    teal: "border-teal-300/45 bg-teal-400/12 text-teal-100 shadow-[0_0_34px_rgba(45,212,191,0.18)]",
    "teal-highlight": "border-teal-200/70 bg-teal-400/18 text-teal-50 shadow-[0_0_44px_rgba(45,212,191,0.35)]",
    rose: "border-rose-300/40 bg-rose-400/12 text-rose-100 shadow-[0_0_34px_rgba(251,113,133,0.16)]",
    amber: "border-amber-300/45 bg-amber-400/14 text-amber-100 shadow-[0_0_40px_rgba(250,204,21,0.2)]",
  };

  return (
    <div className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-center ${className}`}>
      <div className={`flex items-center justify-center rounded-full border ${ring === "teal-highlight" ? "h-[86px] w-[86px]" : "h-[74px] w-[74px]"} ${styles[ring]} ${pulse ? "scale-105" : ""}`}>
        <NodeIcon type={icon} />
      </div>
      <p className={`mt-2 font-bold leading-none text-white ${ring === "teal-highlight" ? "text-[19px]" : "text-[18px]"}`}>{title}</p>
      <p className={`mt-1 leading-none text-emerald-100/62 ${ring === "teal-highlight" ? "text-[13px]" : "text-[13px]"}`}>({subtitle})</p>
    </div>
  );
}

function NodeIcon({ type }: { type: "sun" | "home" | "hub" | "bolt" }) {
  if (type === "sun") {
    return (
      <svg viewBox="0 0 48 48" className="h-9 w-9 text-[#ffd54a]" aria-hidden="true">
        <circle cx="24" cy="24" r="7" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
          <path d="M24 6v6" />
          <path d="M24 36v6" />
          <path d="M6 24h6" />
          <path d="M36 24h6" />
          <path d="M11.5 11.5l4.2 4.2" />
          <path d="M32.3 32.3l4.2 4.2" />
          <path d="M36.5 11.5l-4.2 4.2" />
          <path d="M15.7 32.3l-4.2 4.2" />
        </g>
      </svg>
    );
  }

  if (type === "bolt") {
    return (
      <svg viewBox="0 0 48 48" className="h-9 w-9 text-[#ffd54a]" aria-hidden="true">
        <path
          d="M26 5 14 26h8l-2 17 14-23h-8l0-15Z"
          fill="currentColor"
          stroke="rgba(255,245,180,0.45)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (type === "hub") {
    return (
      <svg viewBox="0 0 48 48" className="h-9 w-9 text-[#63f0b4]" aria-hidden="true">
        <circle cx="24" cy="24" r="7" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <circle cx="24" cy="11" r="2.4" fill="currentColor" />
        <circle cx="35.3" cy="17.5" r="2.4" fill="currentColor" />
        <circle cx="35.3" cy="30.5" r="2.4" fill="currentColor" />
        <circle cx="24" cy="37" r="2.4" fill="currentColor" />
        <circle cx="12.7" cy="30.5" r="2.4" fill="currentColor" />
        <circle cx="12.7" cy="17.5" r="2.4" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M24 14v5" />
          <path d="M30 20.5l-4.2 2.4" />
          <path d="M30 27.5l-4.2-2.4" />
          <path d="M24 34v-5" />
          <path d="M18 27.5l4.2-2.4" />
          <path d="M18 20.5l4.2 2.4" />
        </g>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" className="h-9 w-9 text-white/95" aria-hidden="true">
      <path
        d="M10 22.5 24 11l14 11.5V38a2 2 0 0 1-2 2h-7V29h-10v11h-7a2 2 0 0 1-2-2V22.5Z"
        fill="currentColor"
      />
      <path d="M7.5 24.5 24 10.5l16.5 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CostColumn({
  label,
  value,
  maxValue,
  fill,
}: {
  label: string;
  value: number;
  maxValue: number;
  fill: string;
}) {
  const barHeight = Math.max((value / Math.max(maxValue, 1)) * 112, 28);

  return (
    <div className="rounded-[18px] border border-white/5 bg-[#071311] p-3">
      <div className="flex h-[122px] items-end justify-center rounded-[16px] bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] pb-2">
        <div
          className={`w-[58px] rounded-t-[18px] transition-all duration-700 ${fill}`}
          style={{ height: `${barHeight}px` }}
        />
      </div>
      <p className="mt-2 text-xs text-emerald-100/58">{label}</p>
      <p className="mt-1 text-[18px] font-black text-white">Rs {value.toLocaleString("en-IN")}</p>
    </div>
  );
}

function HistoryRow({
  title,
  time,
  active = false,
}: {
  title: string;
  time: string;
  active?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <div className="flex gap-3">
        <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${active ? "bg-emerald-300 shadow-[0_0_12px_rgba(74,222,128,0.95)]" : "bg-emerald-500/70"}`} />
        <div>
          <p className="text-[13px] font-semibold text-white">{title}</p>
          <p className="text-[11px] text-emerald-100/38">Algorithm improvement</p>
        </div>
      </div>
      <span className="text-[11px] text-emerald-100/36">{time}</span>
    </div>
  );
}
