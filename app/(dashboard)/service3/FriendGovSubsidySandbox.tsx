"use client";

import { Cpu } from "lucide-react";
import React, { useState, useEffect, useMemo, useRef, useCallback, useId } from "react";
import { motion } from "framer-motion";

/**
 * GovSubsidyPage.jsx (GOD-TIER EDITION V2.0 - TITAN UPGRADE)
 * * CORE ASSUMPTIONS & UNITS:
 * - Irradiance (loc.irradiance): Peak Sun Hours (kWh/m²/day), ~4.6–6.1 range for India
 * - Tariff (loc.tariff): Retail electricity tariff in ₹/kWh (varies by state/DISCOM)
 * - Performance Ratio: 0.75 (75%) accounts for inverter losses, wiring, soiling, etc.
 * - Annual degradation: 0.7% per year (standard PV panel spec)
 * - Energy inflation: 4% per year (conservative estimate)
 * - Interest rate: Default 9.5% PA, configurable via UI
 * * V2 ADDITIONS:
 * - Battery Energy Storage System (BESS) Integration
 * - Commercial Accelerated Depreciation (AD) Tax Shield (40% WDV)
 * - Dynamic Roof Space Matrix Visualizer (Custom SVG)
 * - Live Telemetry Simulator (Command Center UI)
 * - 25-Year Granular Financial Ledger Data Grid
 */

/* ======================
   SYSTEM CONSTANTS
   ====================== */
const PERFORMANCE_RATIO = 0.75;
const ANNUAL_DEGRADATION = 0.007; 
const INFLATION_RATE = 0.04; 
const DEFAULT_INTEREST_RATE_PCT = 9.5;
const CORPORATE_TAX_RATE = 0.25; // 25% base corporate tax
const ACCELERATED_DEPRECIATION_RATE = 0.40; // 40% WDV for Solar in India
const PANEL_AREA_SQM_PER_KW = 5.5; // ~5.5 sq meters per 1 kW of modern mono-perc panels


// Environmental equivalencies
const ENV_CONSTANTS = {
  CO2_PER_KWH: 0.82, 
  TREES_PER_KG_CO2: 1 / 21.77, 
  COAL_PER_KWH: 0.4, 
  CAR_EMISSIONS_ANNUAL_TONS: 4.6, 
};

/* ======================
   THEME (Expanded)
   ====================== */
const THEME = {
  palette: {
    void: "#030406",
    surface: {
      glassBase: "rgba(10, 15, 20, 0.4)",
      glassHighlight: "rgba(255, 255, 255, 0.03)",
      border: "rgba(255, 255, 255, 0.08)",
      borderGlow: "rgba(16, 185, 129, 0.3)"
    },
    text: { primary: "#FFFFFF", secondary: "#A1A1AA", muted: "#52525B", intense: "#E4E4E7" },
    gold: { base: "#D4AF37", bright: "#FDE047", glow: "rgba(212, 175, 55, 0.2)" },
    accent: { teal: "#10B981", cyan: "#06B6D4", emerald: "#047857", red: "#EF4444", purple: "#8B5CF6" },
  },
  easing: {
    spring: "cubic-bezier(0.175, 0.885, 0.32, 1.275)",
    smooth: "cubic-bezier(0.25, 1, 0.5, 1)",
    glitch: "cubic-bezier(0.86, 0, 0.07, 1)",
  },
  typography: { mono: "'JetBrains Mono', monospace", sans: "'Inter', system-ui, sans-serif" }
};

/* ============================
   Math & Spline Engine
   ============================ */
const MathCore = {
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  clamp: (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v)),
  formatINR: (n: number | null | undefined) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n || 0),
  formatNum: (n: number, decimals = 1) => new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n),
  easeOutExpo: (t: number) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  
  svgSmoothPath: (points: Array<{ x: number; y: number }>, tension = 0.2) => {
    if (points.length < 2) return "";
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = i > 0 ? points[i - 1] : points[0];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i !== points.length - 2 ? points[i + 2] : p2;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }
};

/* ====================================================
   EXTENDED JURISDICTION REGISTRY
   ==================================================== */
interface JurisdictionData { state: string; irradiance: number; tariff: number; meta: string; rule: (kw: number) => number; }

const JURISDICTION_REGISTRY: Record<string, JurisdictionData> = {
  "Delhi (NCT)": { state: "Delhi", irradiance: 5.1, tariff: 8.5, meta: "Capital EV/Solar Bonus", rule: (kw) => Math.min(kw * 2000, 10000) },
  "Mumbai": { state: "Maharashtra", irradiance: 5.3, tariff: 10.2, meta: "Highest Tariff Region", rule: () => 0 },
  "Bengaluru": { state: "Karnataka", irradiance: 5.4, tariff: 8.15, meta: "BESCOM Net Metering", rule: () => 0 },
  "Chennai": { state: "Tamil Nadu", irradiance: 5.5, tariff: 7.8, meta: "High Solar Potential", rule: (kw) => kw * 1000 },
  "Bhubaneswar": { state: "Odisha", irradiance: 5.4, tariff: 6.2, meta: "NRSE Incentive Zone", rule: (kw) => kw <= 3 ? kw * 2000 : 6000 },
  "Lucknow": { state: "Uttar Pradesh", irradiance: 5.1, tariff: 6.8, meta: "UPNEDA Scheme", rule: (kw) => kw <= 3 ? kw * 1500 : 4500 },
  "Other / Generic": { state: "Other", irradiance: 4.8, tariff: 7.5, meta: "National Baseline", rule: () => 0 }
};

const CENTRAL_SUBSIDY = { 1: 30000, 2: 60000, 3: 78000 };
function getCentralSubsidy(kw: number): number {
  if (kw <= 1) return CENTRAL_SUBSIDY[1];
  if (kw <= 2) return CENTRAL_SUBSIDY[2];
  if (kw <= 10) return CENTRAL_SUBSIDY[3];
  return 78000;
}

/* ==========================
   Hooks
   ========================== */
const useAnimatedNumber = (target = 0, duration = 1200) => {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);
  const fromRef = useRef(0);

  useEffect(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    fromRef.current = value;

    const step = (ts: number) => {
      const elapsed = ts - start;
      const t = MathCore.clamp(elapsed / duration, 0, 1);
      setValue(Math.round(MathCore.lerp(fromRef.current, target, MathCore.easeOutExpo(t))));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [target, duration]);
  return value;
};

// Simulation Hook for Telemetry
const useTelemetry = (isActive: boolean) => {
  const [data, setData] = useState({ hz: 50.01, temp: 42.4, voltage: 230, efficiency: 98.2 });
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      setData({
        hz: 50 + (Math.random() * 0.08 - 0.04),
        temp: 42 + (Math.random() * 2.5),
        voltage: 230 + (Math.random() * 4 - 2),
        efficiency: 98.0 + (Math.random() * 0.6)
      });
    }, 800);
    return () => clearInterval(interval);
  }, [isActive]);
  return data;
};

/* ================================
   Engine core
   ================================ */
function calculateSystemData(kw: number, jurisdictionKey: string, isCommercial: boolean, dpPercent: number, loanYears: number, batteryKwh: number =0) {
  kw = Math.max(0.1, +kw);
  dpPercent = MathCore.clamp(dpPercent, 0, 100);
  loanYears = Math.max(0, Math.floor(loanYears));
  
  const loc = JURISDICTION_REGISTRY[jurisdictionKey] || JURISDICTION_REGISTRY["Other / Generic"];
  
  // Base Costs
  const baseRate = isCommercial ? 58000 : 65000;
  const pvCost = kw * baseRate;
  const batteryCost = batteryKwh * 18000; // ₹18,000 per kWh of Li-Ion storage
  const totalCost = pvCost + batteryCost;
  
  // Subsidies (No subsidies for commercial or battery usually)
  const central = isCommercial ? 0 : getCentralSubsidy(kw);
  const state = isCommercial ? 0 : loc.rule(kw);
  const totalSubsidy = Math.max(0, central + state);
  const netCost = Math.max(0, totalCost - totalSubsidy);



  // Energy & Savings
  const dailyGen = kw * loc.irradiance * PERFORMANCE_RATIO;
  const annualGen = dailyGen * 365;
  const baseAnnualSavings = annualGen * loc.tariff;
  

  // 25-Year Matrix with Commercial Tax Shield (Accelerated Depreciation)
  const projectionData = [];
  let cumulativeCashflow = -netCost; 
  let yearlyGen = annualGen;
  let yearlyTariff = loc.tariff;
  let currentBookValue = netCost; // For AD calculation
  let totalTaxShield = 0;

  for (let year = 1; year <= 25; year++) {
    const yearSavings = yearlyGen * yearlyTariff;
    const loanPayment = 0;
    
    // Tax Shield Logic (Commercial Only)
    let taxShield = 0;
    if (isCommercial && currentBookValue > 0) {
      const depreciationAllowable = currentBookValue * ACCELERATED_DEPRECIATION_RATE;
      taxShield = depreciationAllowable * CORPORATE_TAX_RATE;
      currentBookValue -= depreciationAllowable;
      totalTaxShield += taxShield;
    }

    const netCashThisYear = yearSavings + taxShield - loanPayment;
    cumulativeCashflow += netCashThisYear;
    
    projectionData.push({
      year,
      generation: yearlyGen,
      tariff: yearlyTariff,
      yearlySavings: yearSavings,
      loanPayment,
      taxShield,
      netCashThisYear,
      cumulative: cumulativeCashflow,
      isProfitable: cumulativeCashflow > 0
    });

    yearlyGen *= (1 - ANNUAL_DEGRADATION);
    yearlyTariff *= (1 + INFLATION_RATE);
  }

  const payback = +(netCost / (projectionData[0].yearlySavings + projectionData[0].taxShield)).toFixed(2);

  // Envs
  const annualCO2kg = annualGen * ENV_CONSTANTS.CO2_PER_KWH;
  return {
    pvCost, batteryCost, totalCost, central, state, totalSubsidy, netCost,
    annualGen, annualSavings: baseAnnualSavings, payback, totalTaxShield,
    projectionData,
    annualCO2kg, 
    treesEquivalent: Math.round(annualCO2kg * ENV_CONSTANTS.TREES_PER_KG_CO2), 
    coalSaved: Math.round(annualGen * ENV_CONSTANTS.COAL_PER_KWH), 
    carsOffRoad: (annualCO2kg / (ENV_CONSTANTS.CAR_EMISSIONS_ANNUAL_TONS * 1000)).toFixed(1),
    locMeta: loc.meta
  };
}

/* ===========================
   UI COMPONENTS
   =========================== */

const SubsidyGauge = ({ percent = 0 }) => {
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - MathCore.clamp(percent / 100, 0, 1));
  const baseId = useId();
  return (
    <div className="gauge-container">
      <svg width="140" height="140" viewBox="0 0 140 140" className="gauge-svg">
        <defs>
          <linearGradient id={`${baseId}-grad`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor={THEME.palette.accent.teal} />
            <stop offset="50%" stopColor={THEME.palette.accent.cyan} />
            <stop offset="100%" stopColor={THEME.palette.gold.base} />
          </linearGradient>
          <filter id={`${baseId}-glow`}><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <circle cx="70" cy="70" r={r} stroke={THEME.palette.surface.border} strokeWidth="12" fill="none" />
        <circle cx="70" cy="70" r={r} stroke={`url(#${baseId}-grad)`} strokeWidth="12" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={offset} style={{ transition: "stroke-dashoffset 1.5s cubic-bezier(0.25, 1, 0.5, 1)" }} filter={`url(#${baseId}-glow)`} transform="rotate(-90 70 70)" />
      </svg>
      <div className="gauge-center">
        <div className="g-val">{Math.round(percent)}%</div>
        <div className="g-lbl">SUBSIDY COVERAGE</div>
      </div>
    </div>
  );
};

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6 }
  }
};
/* ===========================================
   MAIN COMPONENT
   =========================================== */
export default function GovSubsidyPage() {
  const userInteracted = useRef(false);
  const [jurisdiction, setJurisdiction] = useState("Delhi (NCT)");
  const [kw, setKw] = useState(10);
  const [isCommercial, setIsCommercial] = useState(false);
  const [dpPercent, setDpPercent] = useState(20);
  const [loanYears, setLoanYears] = useState(5);
  const [aiExplanation, setAiExplanation] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [displayedText, setDisplayedText] = useState("");
  const [batteryKwh, setBatteryKwh] = useState(0);

  const [locked, setLocked] = useState(false);
  const [lockAnim, setLockAnim] = useState(0); 
  const aiTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const firstRender = useRef(true);

  const timeoutRefs = useRef<{ t1: NodeJS.Timeout | null; t2: NodeJS.Timeout | null }>({ t1: null, t2: null });
  useEffect(() => () => { if (timeoutRefs.current.t1) clearTimeout(timeoutRefs.current.t1); if (timeoutRefs.current.t2) clearTimeout(timeoutRefs.current.t2); }, []);

  const calc = useMemo(
  () =>
    calculateSystemData(
      kw,
      jurisdiction,
      isCommercial,
      dpPercent,
      loanYears,
      batteryKwh
    ),
  [kw, jurisdiction, isCommercial, dpPercent, loanYears, batteryKwh]
);

  const subsidyPct = calc.totalCost ? (calc.totalSubsidy / calc.totalCost) * 100 : 0;
  const animSubsidy = useAnimatedNumber(calc.totalSubsidy);
  const animNetCost = useAnimatedNumber(calc.netCost);
  const animCentral = useAnimatedNumber(calc.central);
const animState = useAnimatedNumber(calc.state);
const animTotalSubsidy = useAnimatedNumber(calc.totalSubsidy);
  const anim25Yr = useAnimatedNumber(calc.projectionData[24]?.cumulative || 0);


const typeText = (text: string) => {
  setDisplayedText("");

  let i = 0;

  const interval = setInterval(() => {
    setDisplayedText(text.slice(0, i + 1));
    i++;

    if (i >= text.length) {
      clearInterval(interval);
    }
  }, 20);
};

  const generateAIExplanation = async () => {
  try {
    setAiLoading(true);

    const res = await fetch("/api/gemini-explanation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
body: JSON.stringify({
  location: jurisdiction,
  systemSizeKW: kw,
  monthlyBill: Math.round(calc.annualSavings / 12),

  paybackYears: calc.payback,
  centralSubsidy: calc.central,
  stateSubsidy: calc.state,
  totalSubsidy: calc.totalSubsidy,
  netSystemCost: calc.netCost,
  subsidyCoverage: subsidyPct
}),
    });

    const data = await res.json();
    setAiExplanation(data.text);
typeText((data.text || "Unable to generate explanation at the moment.").trim());

  } catch (error) {
    console.error("AI error:", error);
  } finally {
    setAiLoading(false);
  }
};

useEffect(() => {
  // Skip AI generation on first page load
  if (firstRender.current) {
    firstRender.current = false;
    return;
  }

  if (aiTimeoutRef.current) {
    clearTimeout(aiTimeoutRef.current);
  }

  aiTimeoutRef.current = setTimeout(() => {
    generateAIExplanation();
  }, 2000);

  return () => {
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
  };
}, [kw, batteryKwh, jurisdiction]);

  const handleLock = () => {
    if (locked || lockAnim !== 0) return;
    setLockAnim(1);
    if (timeoutRefs.current.t1) clearTimeout(timeoutRefs.current.t1);
    if (timeoutRefs.current.t2) clearTimeout(timeoutRefs.current.t2);
    timeoutRefs.current.t1 = setTimeout(() => setLockAnim(2), 1500);
    timeoutRefs.current.t2 = setTimeout(() => { setLocked(true); setLockAnim(0); }, 2200);
  };

  const unlockIfNeeded = () => {
  if (locked) {
    setLocked(false);
    setLockAnim(0);
  }
};

  const handleToggleMode = (isComm: boolean) => {
    setIsCommercial(isComm);
    setKw(isComm ? Math.max(kw, 20) : Math.min(kw, 20));
  };

  return (
    <div className="zenith-root">
   
      
      <div className="zenith-container">
<motion.div
  style={{ marginBottom: "18px" }}
  initial="hidden"
  animate="show"
  variants={fadeUp}
>

<div className="flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full bg-slate-800/50 border border-slate-700/50 backdrop-blur-md shadow-lg w-max">
  <Cpu className="w-4 h-4 text-emerald-400" />
  <span className="text-xs font-semibold tracking-wider uppercase text-slate-300">
    Zenith Enterprise OS v6.0
  </span>
</div>

  <h1 style={{
    fontSize:"46px",
    fontWeight:"900",
    margin:"0"
  }}>
    Subsidy <span style={{
      background:"linear-gradient(90deg,#10B981,#06B6D4,#6366f1)",
      WebkitBackgroundClip:"text",
      WebkitTextFillColor:"transparent"
    }}>Intelligence</span>
  </h1>

  <p style={{
    marginTop:"8px",
    color:"#9ca3af"
  }}>
    Discover central and state incentives that reduce solar system cost.
  </p>
  </motion.div>

        {/* HEADER */}
        <header className="z-header">
          <div className="z-brand">
            <div className="z-logo"><div className="glow-orb"></div>⚡</div>
            <div>
              <h1 className="z-title">Zenith OS</h1>
              <p className="z-subtitle">Grid Intelligence & BESS Forecaster v2.0</p>
            </div>
          </div>
          <div className="z-controls">
            <div className="toggle-pill">
              <button className={!isCommercial ? "active" : ""} onClick={() => handleToggleMode(false)}>Residential</button>
              <button className={isCommercial ? "active" : ""} onClick={() => handleToggleMode(true)}>C&I Enterprise</button>
            </div>
          </div>
        </header>

        <main className="z-grid">
          
          {/* LEFT PANEL: Inputs */}
          <aside className="z-panel input-panel">
            <div className="panel-glow-border"></div>
            <div className="panel-content scroll-y">
              <h3 className="panel-title">System Architecture</h3>
              
              <div className="input-group">
                <label>Region / Dispatch Center</label>
<select value={jurisdiction} onChange={(e) => {
  userInteracted.current = true;
  unlockIfNeeded();
  setJurisdiction(e.target.value);
}} className="z-select">
                  {Object.keys(JURISDICTION_REGISTRY).map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <div className="meta-tag">{calc.locMeta}</div>
              </div>

              <div className="input-group">
                <label>PV Array Capacity: <span className="hl">{kw} kWp</span></label>
                <input
  type="range"
  min={isCommercial ? 20 : 1}
  max={isCommercial ? 1000 : 20}
  step="0.1"
  value={kw}
  onChange={(e) => {
  userInteracted.current = true;
  unlockIfNeeded();
  setKw(parseFloat(e.target.value));
}}
  className="z-slider"
/>
              </div>

              <div className="divider"></div>
              <div className="input-group">
  <label>
    Battery Storage Capacity
    <span className="hl">{batteryKwh} kWh</span>
  </label>

  <input
    type="range"
    min="0"
    max="40"
    step="1"
    value={batteryKwh}
onChange={(e) => {
  userInteracted.current = true;
  unlockIfNeeded();
  setBatteryKwh(Number(e.target.value));
}}
    className="z-slider purp"
  />
</div>

              <div className="mini-stats">
                <div className="ms-box">
                  <div className="ms-lbl">Gross CapEx</div>
                  <div className={`ms-val ${locked ? "strike" : ""}`}>{MathCore.formatINR(calc.totalCost)}</div>
                </div>
                <div className="ms-box highlight">
                  <div className="ms-lbl">Incentives</div>
                  <div className="ms-val green">-{MathCore.formatINR(animSubsidy)}</div>
                </div>
              </div>

              <button className={`z-btn massive ${locked ? "locked" : lockAnim === 1 ? "loading" : ""}`} onClick={handleLock}>
                <span className="icon">{locked ? "✓" : lockAnim === 1 ? "⟳" : "⚡"}</span>
                <span className="text">{locked ? "Allocation Secured" : lockAnim === 1 ? "Connecting Grid..." : "Lock Final Configuration"}</span>
              </button>
            </div>
          </aside>

          {/* CENTER/RIGHT PANEL: Intelligence Board */}
          <section className="z-board">


            <div className="z-board-content scroll-y">
              
              {/* TAB: OVERVIEW */}
              {(
                <div className="tab-pane fade-in">
<div className="hero-stats">

  {/* ROW 1 */}
  <div className="hs-row">

    <div className="hs-gauge">
      <SubsidyGauge percent={subsidyPct} />
    </div>

    <div className="hs-card main">
      <div className="lbl">Net Cost After Subsidy</div>
      <div className="val">{MathCore.formatINR(animNetCost)}</div>
      <div className="sub">After applicable subsidies</div>
    </div>

    <div className="hs-card">
      <div className="lbl">Central Govt. Subsidy</div>
      <div className="val gold">{MathCore.formatINR(animCentral)}</div>
    </div>

  </div>

  {/* ROW 2 */}
  <div className="hs-row">

    <div className="hs-card">
      <div className="lbl">State Govt Subsidy</div>
      <div className="val green">+{MathCore.formatINR(animState)}</div>
    </div>

    <div className="hs-card">
      <div className="lbl">Total Subsidy</div>
      <div className="val green">
        {MathCore.formatINR(animTotalSubsidy)}
      </div>
      <div className="sub">Central + State incentives</div>
    </div>

<div className="hs-card">
  <div className="lbl">Estimated Payback</div>
  <div className="val">
    {calc.payback} <span className="sm">yrs</span>
  </div>
  <div className="sub">Time to recover system cost</div>
</div>

  </div>

</div>
                  
                  
                  <div className="feature-split">
                    <div className="chart-section" style={{ flex: 1 }}>
                      <h3 className="section-head">AI Subsidy Intelligence</h3>
                     <div className="ai-insight-card">
  <div className="ai-badge">AI POLICY INSIGHT</div>

<p className="ai-text">
  {aiLoading ? "Zenith AI analyzing subsidy structure..." : displayedText}
</p>

<ul className="ai-reasons">
  <li>• Central MNRE subsidy caps are fully utilized at this capacity</li>
  <li>• State incentives apply without tapering in this range</li>
  <li>• Larger systems offer lower marginal subsidy benefit per kW</li>
</ul>

  <p className="ai-sub">
    ⚠️ Subsidy rules change frequently. Zenith AI continuously tracks policy
    updates and alerts users if higher incentives become available.
  </p>
</div>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </section>
        </main>
      </div>
      
      {/* ===================== CSS STYLES (God-Tier V2) ===================== */}
      <style>{`
        .zenith-root { min-height: 100vh; background-color: ${THEME.palette.void}; color: ${THEME.palette.text.primary}; font-family: ${THEME.typography.sans}; position: relative; overflow: hidden; padding: 20px 20px 40px; display: flex; align-items: center; justify-content: center; }
        * { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: ${THEME.palette.surface.border} transparent; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-thumb { background: ${THEME.palette.surface.border}; border-radius: 4px; }
        
        /* Background Effects */
        .aurora { position: absolute; border-radius: 50%; filter: blur(140px); z-index: 0; opacity: 0.35; pointer-events: none; }
        .aurora-1 { top: -10%; left: -10%; width: 60vw; height: 60vw; background: radial-gradient(circle, ${THEME.palette.accent.teal} 0%, transparent 60%); animation: float 20s infinite ease-in-out alternate; }
        .aurora-2 { bottom: -20%; right: -10%; width: 70vw; height: 70vw; background: radial-gradient(circle, ${THEME.palette.accent.purple} 0%, ${THEME.palette.accent.cyan} 40%, transparent 70%); animation: float 25s infinite ease-in-out alternate-reverse; }
        @keyframes float { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(40px, 40px) scale(1.05); } }

        .zenith-container {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 1380px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

        /* Header */
        .z-header { display: flex; justify-content: space-between; align-items: center; background: ${THEME.palette.surface.glassBase}; border: 1px solid ${THEME.palette.surface.border}; backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); padding: 20px 32px; border-radius: 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); flex-shrink: 0; }
        .z-brand { display: flex; align-items: center; gap: 16px; }
        .z-logo { width: 52px; height: 52px; border-radius: 16px; background: rgba(255,255,255,0.03); display: flex; align-items: center; justify-content: center; font-size: 26px; position: relative; border: 1px solid rgba(255,255,255,0.1); box-shadow: inset 0 0 20px rgba(0,0,0,0.5); }
        .glow-orb { position: absolute; inset: 0; border-radius: 16px; box-shadow: 0 0 25px ${THEME.palette.accent.teal}; opacity: 0.4; }
        .z-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; margin: 0; background: linear-gradient(90deg, #fff, #a1a1aa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .z-subtitle { font-size: 11px; color: ${THEME.palette.accent.cyan}; margin: 4px 0 0 0; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; }

        .toggle-pill { display: flex; background: rgba(0,0,0,0.6); border-radius: 100px; padding: 5px; border: 1px solid rgba(255,255,255,0.08); box-shadow: inset 0 2px 10px rgba(0,0,0,0.5); }
        .toggle-pill button { background: transparent; border: none; color: ${THEME.palette.text.secondary}; padding: 10px 20px; border-radius: 100px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.3s ${THEME.easing.spring}; }
        .toggle-pill button.active { background: ${THEME.palette.surface.glassHighlight}; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); }

        /* Grid */
        .z-grid { display: flex; gap: 24px; height: calc(100% - 100px); min-height: 0; }
        .z-panel { width: 360px; flex-shrink: 0; }
        .z-board { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .z-panel, .z-board { background: ${THEME.palette.surface.glassBase}; border: 1px solid ${THEME.palette.surface.border}; backdrop-filter: blur(24px); border-radius: 24px; position: relative; overflow: hidden; box-shadow: 0 16px 40px rgba(0,0,0,0.5); }
        .panel-glow-border { position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, ${THEME.palette.surface.borderGlow}, transparent); opacity: 0.5; }
        
        .panel-content, .z-board-content { padding: 32px; overflow-y: auto; }
        .panel-title { font-size: 16px; font-weight: 700; margin: 0 0 24px 0; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; color: ${THEME.palette.text.intense}; }

        /* Form Controls */
        .input-group { margin-bottom: 24px; }
        .input-group label { display: flex; justify-content: space-between; font-size: 13px; color: ${THEME.palette.text.secondary}; font-weight: 600; margin-bottom: 12px; }
        .input-group label .hl { color: #fff; font-family: ${THEME.typography.mono}; font-weight: 700; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; }
        .z-select { width: 100%; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 14px 16px; border-radius: 12px; font-size: 14px; outline: none; cursor: pointer; appearance: none; transition: border-color 0.2s; }
        .z-select:focus { border-color: ${THEME.palette.accent.teal}; box-shadow: 0 0 0 2px rgba(16,185,129,0.2); }
        .meta-tag { font-size: 10px; color: ${THEME.palette.accent.cyan}; margin-top: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        
        .z-slider { width: 100%; -webkit-appearance: none; background: transparent; height: 6px; border-radius: 3px; outline: none; margin-top: 8px; }
        .z-slider::-webkit-slider-runnable-track { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; }
        .z-slider::-webkit-slider-thumb { -webkit-appearance: none; height: 20px; width: 20px; border-radius: 50%; background: #fff; margin-top: -7px; box-shadow: 0 0 12px rgba(255,255,255,0.6); cursor: grab; transition: transform 0.2s; border: 2px solid ${THEME.palette.accent.teal}; }
        .z-slider.purp::-webkit-slider-thumb { border-color: ${THEME.palette.accent.purple}; box-shadow: 0 0 12px rgba(139,92,246,0.6); }
        .z-slider::-webkit-slider-thumb:active { transform: scale(1.2); cursor: grabbing; }

        .divider { height: 1px; background: rgba(255,255,255,0.05); margin: 8px 0 24px 0; }

        /* Stats Blocks */
        .mini-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 32px; }
        .ms-box { background: rgba(0,0,0,0.3); padding: 16px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.03); }
        .ms-box.highlight { background: linear-gradient(180deg, rgba(16,185,129,0.08), rgba(0,0,0,0.3)); border-color: rgba(16,185,129,0.2); }
        .ms-lbl { font-size: 11px; color: ${THEME.palette.text.secondary}; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; margin-bottom: 6px; }
        .ms-val { font-size: 16px; font-weight: 800; font-family: ${THEME.typography.mono}; }
        .ms-val.strike { text-decoration: line-through; color: ${THEME.palette.text.muted}; }
        .ms-val.green { color: ${THEME.palette.accent.teal}; }

        /* Button */
        .z-btn.massive { width: 100%; padding: 20px; border-radius: 16px; background: linear-gradient(90deg, ${THEME.palette.accent.emerald}, ${THEME.palette.accent.teal}); border: none; color: #fff; font-weight: 800; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 12px; transition: all 0.3s ${THEME.easing.spring}; box-shadow: 0 8px 24px rgba(16,185,129,0.25); border: 1px solid rgba(255,255,255,0.1); }
        .z-btn.massive:hover { transform: translateY(-3px); box-shadow: 0 12px 32px rgba(16,185,129,0.4); }
        .z-btn.massive:active { transform: translateY(1px); }
        .z-btn.loading { background: ${THEME.palette.surface.border}; color: ${THEME.palette.text.muted}; pointer-events: none; box-shadow: none; border-color: transparent; }
        .z-btn.loading .icon { animation: spin 1s linear infinite; }
        .z-btn.locked { background: linear-gradient(90deg, rgba(212,175,55,0.15), rgba(212,175,55,0.05)); color: ${THEME.palette.gold.bright}; border: 1px solid ${THEME.palette.gold.glow}; box-shadow: inset 0 0 20px ${THEME.palette.gold.glow}; pointer-events: none; }
        @keyframes spin { 100% { transform: rotate(360deg); } }

        /* Tabs */
        .z-tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.3); flex-shrink: 0; }
        .tab { flex: 1; padding: 20px; background: none; border: none; color: ${THEME.palette.text.secondary}; font-weight: 700; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
        .tab:hover { color: #fff; background: rgba(255,255,255,0.02); }
        .tab.active { color: ${THEME.palette.accent.cyan}; border-bottom-color: ${THEME.palette.accent.cyan}; background: linear-gradient(0deg, rgba(6,182,212,0.05), transparent); text-shadow: 0 0 10px rgba(6,182,212,0.3); }

        .fade-in { animation: fadeIn 0.4s cubic-bezier(0.25, 1, 0.5, 1) forwards; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        /* Overview Tab */
        .hero-stats {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 32px;
  width: 100%;
}

.hs-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.hs-gauge {
  display: flex;
  align-items: center;
  justify-content: center;
}
        .gauge-container { position: relative; width: 140px; height: 140px; flex-shrink: 0; filter: drop-shadow(0 0 16px rgba(16,185,129,0.15)); }
        .gauge-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .g-val { font-size: 32px; font-weight: 800; font-family: ${THEME.typography.mono}; line-height: 1; text-shadow: 0 2px 10px rgba(0,0,0,0.5); }
        .g-lbl { font-size: 9px; letter-spacing: 2px; color: ${THEME.palette.text.secondary}; margin-top: 6px; font-weight: 700; }

        
        .hs-card { flex: 1; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 20px; padding: 24px; transition: transform 0.3s, border-color 0.3s; }
        .hs-card:hover { transform: translateY(-4px); border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); }
        .hs-card.main { background: linear-gradient(135deg, rgba(255,255,255,0.05), rgba(0,0,0,0.4)); border: 1px solid rgba(255,255,255,0.15); box-shadow: inset 0 0 20px rgba(0,0,0,0.5); }
        .hs-card .lbl { font-size: 11px; color: ${THEME.palette.text.secondary}; font-weight: 700; text-transform: uppercase; margin-bottom: 12px; letter-spacing: 0.5px; }
        .hs-card .val { font-size: 26px; font-weight: 800; font-family: ${THEME.typography.mono}; }
        .hs-card .val.gold { color: ${THEME.palette.gold.bright}; text-shadow: 0 0 12px rgba(212,175,55,0.3); }
        .hs-card .val.green { color: ${THEME.palette.accent.teal}; text-shadow: 0 0 12px rgba(16,185,129,0.3); }
        .hs-card .val .sm { font-size: 14px; font-weight: 600; font-family: ${THEME.typography.sans}; color: ${THEME.palette.text.secondary}; text-shadow: none; }
        .hs-card .sub { font-size: 11px; color: ${THEME.palette.text.muted}; margin-top: 8px; font-weight: 600; }

        .feature-split { display: flex; gap: 24px; }
        .chart-section { background: rgba(0,0,0,0.3); border-radius: 20px; padding: 24px; border: 1px solid rgba(255,255,255,0.03); position: relative; display: flex; flex-direction: column; }
        
        .spline-wrapper { width: 100%; height: 100%; min-height: 180px; position: relative; }
        .spline-svg { width: 100%; height: 100%; overflow: visible; }
        .spline-overlay-text { position: absolute; top: 0; left: 0; font-size: 11px; font-weight: 700; color: ${THEME.palette.text.secondary}; text-transform: uppercase; letter-spacing: 1px; }

        .roof-visualizer { width: 100%; height: 100%; display: flex; flex-direction: column; }
        .roof-meta { margin-bottom: 16px; display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: ${THEME.palette.text.secondary}; text-transform: uppercase; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 8px; }
        .roof-meta .rm-val { color: ${THEME.palette.accent.cyan}; font-family: ${THEME.typography.mono}; }
        .roof-svg-wrapper { flex: 1; display: flex; align-items: center; justify-content: center; }
        .pv-panel { fill: rgba(6,182,212,0.1); stroke: ${THEME.palette.accent.cyan}; stroke-width: 1; animation: panelPulse 3s infinite alternate; transition: all 0.3s; cursor: crosshair; }
        .pv-panel:hover { fill: rgba(16,185,129,0.4); stroke: ${THEME.palette.accent.teal}; transform: translateY(-2px); }
        @keyframes panelPulse { 0% { fill-opacity: 0.1; } 100% { fill-opacity: 0.3; } }

        /* Finance */
        .finance-layout { display: flex; gap: 32px; }
        .fin-inputs { flex: 1.2; }
        .section-head { font-size: 18px; font-weight: 800; margin: 0 0 24px 0; color: ${THEME.palette.text.intense}; }
        .section-head.flex-between { display: flex; justify-content: space-between; align-items: center; }
        .export-btn { font-size: 12px; font-weight: 600; color: ${THEME.palette.accent.cyan}; cursor: pointer; padding: 6px 12px; background: rgba(6,182,212,0.1); border-radius: 6px; transition: 0.2s; }
        .export-btn:hover { background: rgba(6,182,212,0.2); }
        .tax-shield-notice { background: rgba(139,92,246,0.1); border: 1px solid rgba(139,92,246,0.2); border-radius: 12px; padding: 16px; display: flex; gap: 16px; align-items: center; margin-top: 24px; }
        .ts-icon { font-size: 24px; filter: drop-shadow(0 0 8px rgba(139,92,246,0.5)); }
        .ts-text { font-size: 13px; color: ${THEME.palette.text.secondary}; line-height: 1.5; }
        .ts-text strong { color: ${THEME.palette.text.primary}; }
        
        .fin-results { flex: 1; }
        .receipt-card { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.05); border-radius: 20px; padding: 24px; box-shadow: inset 0 0 30px rgba(0,0,0,0.5); }
        .r-row { display: flex; justify-content: space-between; margin-bottom: 14px; font-size: 13px; font-weight: 500; }
        .r-row.bold { font-weight: 700; font-size: 15px; margin-bottom: 24px; color: ${THEME.palette.text.intense}; }
        .r-row.sm { font-size: 12px; margin-bottom: 8px; }
        .r-row.mt { margin-top: 24px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 16px; }
        .r-lbl { color: ${THEME.palette.text.secondary}; }
        .r-val { font-family: ${THEME.typography.mono}; }
        .r-val.green { color: ${THEME.palette.accent.teal}; }

        .emi-box { background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(0,0,0,0.4)); border: 1px solid rgba(16,185,129,0.2); border-radius: 16px; padding: 24px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
        .emi-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${THEME.palette.accent.teal}; margin-bottom: 12px; font-weight: 800; }
        .emi-val { font-size: 32px; font-weight: 800; font-family: ${THEME.typography.mono}; text-shadow: 0 2px 10px rgba(0,0,0,0.5); }
        .emi-val .mo { font-size: 14px; color: ${THEME.palette.text.secondary}; font-weight: 600; font-family: ${THEME.typography.sans}; text-shadow: none; }

        /* Ledger Table (V2) */
        .ledger-pane { display: flex; flex-direction: column; height: 100%; }
        .table-container { flex: 1; overflow-y: auto; overflow-x: auto; background: rgba(0,0,0,0.3); border-radius: 16px; border: 1px solid rgba(255,255,255,0.05); }
        .z-table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: right; font-family: ${THEME.typography.mono}; }
        .z-table th { position: sticky; top: 0; background: #0c1015; padding: 16px; color: ${THEME.palette.text.secondary}; font-weight: 700; font-family: ${THEME.typography.sans}; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid rgba(255,255,255,0.1); z-index: 2; }
        .z-table th:first-child, .z-table td:first-child { text-align: center; }
        .z-table td { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.02); color: ${THEME.palette.text.primary}; }
        .z-table tr:hover td { background: rgba(255,255,255,0.02); }
        .z-table .profit-row td { background: rgba(16,185,129,0.02); }
        .z-table .purp-txt { color: ${THEME.palette.accent.purple}; }
        .z-table .red-txt { color: ${THEME.palette.accent.red}; }
        .z-table .green-txt { color: ${THEME.palette.accent.teal}; }
        .z-table .bold { font-weight: 800; }

        /* Telemetry (V2) */
        .telemetry-pane { display: flex; flex-direction: column; gap: 24px; }
        .tel-header { display: flex; align-items: center; gap: 12px; font-size: 14px; font-weight: 800; color: ${THEME.palette.accent.cyan}; text-transform: uppercase; letter-spacing: 2px; }
        .live-dot { width: 10px; height: 10px; background: ${THEME.palette.accent.cyan}; border-radius: 50%; animation: blink 1s infinite; box-shadow: 0 0 10px ${THEME.palette.accent.cyan}; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        
        .tel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .tel-card { background: rgba(0,0,0,0.5); border: 1px solid rgba(6,182,212,0.15); border-radius: 12px; padding: 20px; position: relative; overflow: hidden; }
        .tel-card::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: ${THEME.palette.accent.cyan}; opacity: 0.5; }
        .t-lbl { font-size: 10px; font-weight: 700; color: ${THEME.palette.text.secondary}; letter-spacing: 1px; margin-bottom: 8px; }
        .t-val { font-size: 28px; font-weight: 800; text-shadow: 0 0 10px rgba(255,255,255,0.2); transition: color 0.2s; }
        .t-val.green { color: ${THEME.palette.accent.teal}; } .t-val.red { color: ${THEME.palette.accent.red}; }
        .t-unit { font-size: 12px; color: ${THEME.palette.text.muted}; font-family: ${THEME.typography.sans}; }
        .t-graph { width: 100%; height: 4px; background: rgba(255,255,255,0.05); margin-top: 12px; border-radius: 2px; overflow: hidden; }
        .t-bar { height: 100%; background: ${THEME.palette.accent.cyan}; transition: width 0.3s; }
        .t-bar.green { background: ${THEME.palette.accent.teal}; } .t-bar.red { background: ${THEME.palette.accent.red}; }

        .tel-console { background: #050505; border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; font-family: ${THEME.typography.mono}; font-size: 12px; color: ${THEME.palette.accent.teal}; display: flex; flex-direction: column; gap: 8px; box-shadow: inset 0 0 20px #000; }
        .console-line { opacity: 0.8; }
        .cursor-blink::after { content: '█'; animation: blink 1s infinite; margin-left: 4px; }

        /* Impact Area */
        .impact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .i-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 20px; padding: 32px 24px; text-align: center; transition: all 0.3s; }
        .i-card:hover { transform: translateY(-5px); background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
        .i-icon { font-size: 42px; margin-bottom: 16px; filter: drop-shadow(0 4px 12px rgba(255,255,255,0.1)); }
        .i-val { font-size: 26px; font-weight: 800; font-family: ${THEME.typography.mono}; margin-bottom: 8px; color: ${THEME.palette.gold.bright}; text-shadow: 0 2px 10px rgba(212,175,55,0.2); }
        .i-lbl { font-size: 13px; color: ${THEME.palette.text.secondary}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .impact-footer { margin-top: 32px; text-align: center; font-size: 13px; font-weight: 500; color: ${THEME.palette.text.secondary}; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 16px; border: 1px solid rgba(255,255,255,0.03); line-height: 1.6; }

        /* Utils */
        .mono { font-family: ${THEME.typography.mono}; }
        
        @media (max-width: 1024px) {
          .z-grid { flex-direction: column; height: auto; }
          .z-panel { width: 100%; height: auto; }
          .feature-split { flex-direction: column; }
          .tel-grid { grid-template-columns: 1fr; }
        }

        .ai-insight-card {
  background: linear-gradient(
    135deg,
    rgba(6,182,212,0.12),
    rgba(16,185,129,0.05)
  );
  border: 1px solid rgba(6,182,212,0.25);
  border-radius: 20px;
  padding: 24px;
  box-shadow: inset 0 0 24px rgba(6,182,212,0.15);
}

.ai-badge {
  font-size: 10px;
  letter-spacing: 2px;
  font-weight: 800;
  color: #67e8f9;
  margin-bottom: 12px;
}

.ai-text {
  font-size: 14px;
  line-height: 1.6;
  color: #e5e7eb;
  margin-left: 2px;
}

.ai-sub {
  margin-top: 10px;
  font-size: 12px;
  color: #a1a1aa;
}
  .ai-reasons {
  margin-top: 14px;
  padding-left: 12px;
  font-size: 12px;
  color: #d1d5db;
  line-height: 1.6;
}

.ai-reasons li {
  margin-bottom: 6px;
}
  .gauge-container {
  transform: scale(1.05);
}
  .z-panel {
  display: flex;
  flex-direction: column;
}
  .panel-content {
  padding: 32px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
  .hs-grid {
  display: grid;
  gap: 16px;
}



/* Card styling remains same */
.hs-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 20px;
  padding: 20px;
}

/* Optional highlight */
.hs-card.main {
  background: linear-gradient(135deg, rgba(255,255,255,0.05), rgba(0,0,0,0.4));
}


      `}</style>
    </div>
  );
}
