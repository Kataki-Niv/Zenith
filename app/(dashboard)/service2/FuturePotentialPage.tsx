"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  ComposedChart, Line, Bar
} from "recharts";
import {
  Zap, TrendingUp, BatteryMedium, Activity, Download, FileSpreadsheet, Cpu, Landmark, DollarSign,
  BarChart3, Calculator, Bot, Sparkles, X, ChevronRight, Clock, CalendarDays, Building2, Factory, Briefcase, Coins, Leaf
} from "lucide-react";

/**
 * FuturePotentialPage.tsx — Improved / Hardened Version
 * - See inline comments for rationale behind specific changes.
 * - Keep the same visual structure; improved correctness & perf.
 */

// ==========================================
// TYPES & INTERFACES
// ==========================================

interface ChartData {
  year: string
  yearNum: number;
  capacity: number;
  batteryHealth: number;
  annualKwh: number;
  solarRev: number;
  storageRev: number;
  recRev: number;
  taxShield: number;
  omCost: number;
  debtService: number;
  netCashFlow: number;
  cumulativeCashFlow: number;
}

interface KPIResult {
  totalCapex: number;
  equityRequired: number;
  loanAmount: number;
  npv: number;
  leveragedIrr: string;
  paybackYear: string;
  totalKwh: number;
  co2Offset: number;
  waterSaved: number;
  coalAvoided: number;
}

interface HourlyData {
  hour: string;
  solarGen: number;
  loadDemand: number;
  batteryCharge: number;
  batteryDischarge: number;
  gridImport: number;
}

interface SiteProfile {
  id: string;
  name: string;
  type: string;
  icon: React.ReactNode;
  baseRate: number;
  recommendedKw: number;
  recommendedStorage: number;
}

// ==========================================
// MOCK DATA & CONSTANTS (deterministic)
// ==========================================

const VENDORS = [
  { name: "SolaTech Enterprise", rating: 4.9, installs: 340, tags: ["Tier 1 Panels", "Commercial"], priceRange: "₹42k - ₹48k / kW" },
  { name: "GridDefenders Ltd", rating: 4.7, installs: 890, tags: ["Battery Experts", "C&I"], priceRange: "₹45k - ₹55k / kW" },
  { name: "Apex Sun Power", rating: 4.8, installs: 120, tags: ["Rapid Install", "Maintenance"], priceRange: "₹40k - ₹44k / kW" },
];

const SITES: SiteProfile[] = [
  { id: "site-1", name: "Delhi Corporate HQ", type: "Commercial", icon: <Building2 size={16} />, baseRate: 14.5, recommendedKw: 250, recommendedStorage: 500 },
  { id: "site-2", name: "Pune Manufacturing", type: "Industrial", icon: <Factory size={16} />, baseRate: 9.8, recommendedKw: 1500, recommendedStorage: 3000 },
  { id: "site-3", name: "Bangalore Tech Park", type: "IT Campus", icon: <Briefcase size={16} />, baseRate: 12.2, recommendedKw: 800, recommendedStorage: 1500 },
];

// Deterministic hourly profile (removed Math.random for reproducibility)
const HOURLY_PROFILE: HourlyData[] = Array.from({ length: 24 }).map((_, i) => {
  const hour = i.toString().padStart(2, "0") + ":00";
  const isDay = i >= 7 && i <= 17;
  // Smooth bell curve for solar: 0 to ~100
  const solarGen = isDay ? Math.max(0, Math.sin(((i - 7) / 10) * Math.PI) * 100) : 0;
  // deterministic load pattern with morning & evening peaks
  const base = (i >= 9 && i <= 18) ? 90 : 40;
  const peakAdj = (i === 19 || i === 20) ? 25 : (i === 9 ? 15 : 0);
  const loadDemand = base + peakAdj;

  // simple dispatch logic
  let batteryCharge = 0;
  let batteryDischarge = 0;
  let gridImport = 0;

  if (solarGen > loadDemand) {
    batteryCharge = Math.min(solarGen - loadDemand, 40);
    gridImport = 0;
  } else {
    const deficit = loadDemand - solarGen;
    if (i >= 18 && i <= 22) {
      batteryDischarge = Math.min(deficit, 60);
      gridImport = Math.max(0, deficit - batteryDischarge);
    } else {
      gridImport = deficit;
    }
  }

  return {
    hour,
    solarGen: Math.round(solarGen),
    loadDemand: Math.round(loadDemand),
    batteryCharge: Math.round(batteryCharge),
    batteryDischarge: Math.round(batteryDischarge),
    gridImport: Math.round(gridImport),
  };
});

const COLORS = ["#10b981", "#06b6d4", "#6366f1", "#f59e0b", "#ec4899"];

// ==========================================
// ANIMATION VARIANTS
// ==========================================
import { Variants } from "framer-motion";

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 30 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 100, damping: 15 }
  }
};

const slideIn: Variants = {
  hidden: { opacity: 0, x: 50 },
  show: {
    opacity: 1,
    x: 0,
    transition: { type: "spring", stiffness: 100, damping: 20 }
  },
  exit: { opacity: 0, x: 50 }
};
// ==========================================
// HELPERS & UTILITIES
// ==========================================

/**
 * Robust IRR implementation:
 * - Newton-Raphson with safeguard (derivative small / divergence)
 * - Fallback to bisection root-finding on NPV if Newton fails
 * Returns percentage string with 2 decimals or "N/A"
 */
const calculateIRR = (cashFlows: number[], guess = 0.1): string => {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) return "N/A";
  const npv = (rate: number) => {
    return cashFlows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0);
  };
  const npvDerivative = (rate: number) => {
    return cashFlows.reduce((acc, cf, t) => acc - (t * cf) / Math.pow(1 + rate, t + 1), 0);
  };

  // Newton-Raphson with guards
  let irr = guess;
  const maxTries = 200;
  for (let i = 0; i < maxTries; i++) {
    const f = npv(irr);
    const df = npvDerivative(irr);
    if (Math.abs(df) < 1e-8) break;
    const newIrr = irr - f / df;
    if (!isFinite(newIrr) || Math.abs(newIrr) > 1e6) break;
    if (Math.abs(newIrr - irr) < 1e-9) return (newIrr * 100).toFixed(2);
    irr = newIrr;
  }

  // Bisection fallback: search between -0.9999 and 10
  let left = -0.9999;
  let right = 10;
  let fLeft = npv(left);
  let fRight = npv(right);
  if (Math.sign(fLeft) === Math.sign(fRight)) return "N/A";
  for (let i = 0; i < 200; i++) {
    const mid = (left + right) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-6) return (mid * 100).toFixed(2);
    if (Math.sign(fMid) === Math.sign(fLeft)) {
      left = mid;
      fLeft = fMid;
    } else {
      right = mid;
      fRight = fMid;
    }
  }
  const approx = (left + right) / 2;
  return isFinite(approx) ? (approx * 100).toFixed(2) : "N/A";
};

const formatINR = (val: number) => {
  try {
    if (typeof val !== "number" || !isFinite(val)) return "—";
    const abs = Math.abs(val);
    if (abs >= 100000) return `₹${(val / 100000).toFixed(2)}L`; // preserve your L shorthand
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(val);
  } catch {
    return "—";
  }
};

const formatCompact = (val: number) => {
  try {
    return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(val);
  } catch {
    return String(val);
  }
};

// Simple debounce hook for heavy recalculation
function useDebounce<T>(value: T, ms = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// Clamp utility
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

// ==========================================
// MAIN PAGE
// ==========================================

export default function FuturePotentialPage() {
  const dashboardRef = useRef<HTMLDivElement | null>(null);
  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const [activeSite, setActiveSite] = useState<SiteProfile>(SITES[0]);

  // Export (debounced guard built-in)
  const exportLock = useRef(false);
  const handleExportPDF = useCallback(async () => {
    if (!dashboardRef.current) return;
    if (exportLock.current) return;
    exportLock.current = true;
    setIsExportingPDF(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const { jsPDF } = await import("jspdf");
      // scale defensively to avoid massive canvas on 4K monitors
      const canvas = await html2canvas(dashboardRef.current, { scale: 1.5, useCORS: true, backgroundColor: "#060913" });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [canvas.width, canvas.height] });
      pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
      pdf.save(`Zenith_Model_${activeSite.name.replace(/\s/g, "_")}.pdf`);
    } catch (error) {
      // fail gracefully
      // eslint-disable-next-line no-console
      console.error("Export failed:", error);
      window.alert("Failed to export PDF. Try a smaller screen or fewer elements.");
    } finally {
      setIsExportingPDF(false);
      setTimeout(() => (exportLock.current = false), 1200); // small cooldown
    }
  }, [activeSite]);

  return (
    <main className="min-h-screen bg-[#050808] text-[#F3F4F4] font-sans selection:bg-[#7EE081]/30 selection:text-[#7EE081] pb-20 overflow-x-hidden">
      {/* Background Ambience */}
      <div className="fixed top-[-20%] left-[-10%] w-[50%] h-[50%] bg-emerald-500/10 rounded-full blur-[150px] pointer-events-none" />
      <div className="fixed bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-indigo-500/10 rounded-full blur-[150px] pointer-events-none" />

      <div className="max-w-[1600px] mx-auto px-4 md:px-8 relative z-10" ref={dashboardRef}>
        {/* Header */}
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-12 gap-6 border-b border-slate-800/50 pb-8">
          <motion.div initial="hidden" animate="show" variants={fadeUp}>
            <div className="flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full bg-slate-800/50 border border-slate-700/50 backdrop-blur-md shadow-lg w-max">
              <Cpu className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-semibold tracking-wider uppercase text-slate-300">Zenith Enterprise OS v6.0</span>
            </div>
            <h1 className="text-4xl md:text-5xl font-black tracking-tighter mb-2">
              Portfolio <span className="bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400">Intelligence</span>
            </h1>
            <p className="text-slate-400 max-w-2xl font-light">Tax-shielded, debt-leveraged financial modeling & dispatch simulation.</p>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-slate-900/60 p-2 rounded-2xl border border-slate-800 backdrop-blur-xl shadow-2xl flex flex-wrap gap-2">
            {SITES.map((site) => (
              <button
                key={site.id}
                onClick={() => setActiveSite(site)}
                aria-pressed={activeSite.id === site.id}
                className={`flex flex-col items-start px-4 py-3 rounded-xl transition-all duration-300 min-w-[160px] border ${
                  activeSite.id === site.id
                    ? "bg-slate-800 border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.15)]"
                    : "bg-transparent border-transparent hover:bg-slate-800/50"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-bold text-white mb-1">
                  <span className={`${activeSite.id === site.id ? "text-emerald-400" : "text-slate-400"}`}>{site.icon}</span> {site.name}
                </div>
                <div className="text-[10px] text-slate-400 uppercase tracking-wider">{site.type} • {site.baseRate} ₹/kWh</div>
              </button>
            ))}
          </motion.div>
        </div>

        <EstimatorDashboard onExportPDF={handleExportPDF} isExportingPDF={isExportingPDF} activeSite={activeSite} />
      </div>
    </main>
  );
}

// ==========================================
// ESTIMATOR DASHBOARD
// ==========================================

function EstimatorDashboard({ onExportPDF, isExportingPDF, activeSite }: any) {
  const [activeTab, setActiveTab] = useState<'solar' | 'storage' | 'finance' | 'debt' | 'tax'>('solar');
  const [isCopilotOpen, setIsCopilotOpen] = useState(false);
  const [aiText, setAiText] = useState("Zenith AI ready. Click 'Ask AI' to analyze this project.");
const [isAiLoading, setIsAiLoading] = useState(false);

  // Engine states
  const [kW, setKW] = useState<number>(activeSite.recommendedKw);
  const [hoursPerDay, setHoursPerDay] = useState<number>(4.5);
  const [pricePerKwh, setPricePerKwh] = useState<number>(activeSite.baseRate);
  const [utilisation, setUtilisation] = useState<number>(0.85);
  const [batteryKWh, setBatteryKWh] = useState<number>(activeSite.recommendedStorage);
  const [peakArbitrageSpread, setPeakArbitrageSpread] = useState<number>(8);
  const [cyclesPerDay, setCyclesPerDay] = useState<number>(1.2);

  // Finance
  const [capexPerKW, setCapexPerKW] = useState<number>(42000);
  const [capexPerKWh, setCapexPerKWh] = useState<number>(22000);
  const [discountRate, setDiscountRate] = useState<number>(0.08);
  const [inflationRate, setInflationRate] = useState<number>(0.05);
  const [tariffEscalation, setTariffEscalation] = useState<number>(0.03);

  // Debt
  const [debtPercentage, setDebtPercentage] = useState<number>(70);
  const [loanTenure, setLoanTenure] = useState<number>(7);
  const [interestRate, setInterestRate] = useState<number>(0.095);

  // Tax / ESG
  const [corpTaxRate, setCorpTaxRate] = useState<number>(0.2517);
  const [enableAD, setEnableAD] = useState<number>(1);
  const [enableRecs, setEnableRecs] = useState<number>(1);
  const [recPrice, setRecPrice] = useState<number>(1200);

  // Keep UI-sync when activeSite changes
  useEffect(() => {
    setKW(activeSite.recommendedKw);
    setBatteryKWh(activeSite.recommendedStorage);
    setPricePerKwh(activeSite.baseRate);
  }, [activeSite]);

  // Defensive clamps to avoid invalid model inputs
  useEffect(() => {
    setKW((v) => clamp(v, 1, 100000));
    setBatteryKWh((v) => clamp(v, 0, 100000));
    setPricePerKwh((v) => clamp(v, 0.01, 1000));
    setDiscountRate((v) => clamp(v, 0, 1));
    setInterestRate((v) => clamp(v, 0, 1));
    setDebtPercentage((v) => clamp(v, 0, 100));
    setLoanTenure((v) => Math.max(1, Math.round(v)));
    setUtilisation((v) => clamp(v, 0, 1));
  }, []);

  // Debounced inputs for heavy compute
  const debouncedInputs = useDebounce({
    kW, hoursPerDay, utilisation, pricePerKwh, batteryKWh, peakArbitrageSpread, cyclesPerDay, capexPerKW, capexPerKWh, discountRate, inflationRate, tariffEscalation, debtPercentage, loanTenure, interestRate, enableRecs, recPrice, corpTaxRate, enableAD
  }, 250);

  // Compute Engine (uses debounced inputs)
  const { chartData, kpiData } = useMemo(() => {
    // destructure for readability
    const {
      kW: dkW, hoursPerDay: dhoursPerDay, utilisation: dutilisation, pricePerKwh: dpricePerKwh,
      batteryKWh: dbatteryKWh, peakArbitrageSpread: dpeakArbitrageSpread, cyclesPerDay: dcyclesPerDay,
      capexPerKW: dcapexPerKW, capexPerKWh: dcapexPerKWh, discountRate: ddiscountRate,
      inflationRate: dinflationRate, tariffEscalation: dtariffEscalation, debtPercentage: ddebtPercentage,
      loanTenure: dloanTenure, interestRate: dinterestRate, enableRecs: denableRecs, recPrice: drecPrice,
      corpTaxRate: dcorpTaxRate, enableAD: denableAD
    } = debouncedInputs as any;

    let data: ChartData[] = [];

    // capex
    const solarCapex = dkW * dcapexPerKW;
    const storageCapex = dbatteryKWh * dcapexPerKWh;
    const totalCapex = solarCapex + storageCapex;

    const loanAmount = totalCapex * (ddebtPercentage / 100);
    const equityRequired = Math.max(0, totalCapex - loanAmount);

    // EMI: handle zero interest separately
    let annualEMI = 0;
    if (loanAmount > 0 && dloanTenure > 0) {
      if (dinterestRate > 0) {
        const r = dinterestRate;
        const n = dloanTenure;
        annualEMI = loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      } else {
        annualEMI = loanAmount / dloanTenure;
      }
    }

    let currentCapacity = dkW;
    let currentBatteryHealth = 1.0;
    let cumulativeCashFlow = -equityRequired;
    let cumulativeKwh = 0;
    let remainingDepreciationValue = totalCapex;

    const cashFlowsForIRR: number[] = [-equityRequired];

    // Battery modeling params (adjustable)
    const depthOfDischarge = 0.8; // assume 80% usable
    const roundTripEff = 0.9; // 90% efficiency
    const storageAvailability = 0.95; // availability factor

    for (let year = 1; year <= 10; year++) {
      const currentTariff = dpricePerKwh * Math.pow(1 + dtariffEscalation, year - 1);
      const currentSpread = dpeakArbitrageSpread * Math.pow(1 + dtariffEscalation, year - 1);
      const currentOM = (totalCapex * 0.015) * Math.pow(1 + dinflationRate, year - 1);

      // Energy math
      const annualKwh = currentCapacity * dhoursPerDay * dutilisation * 365;
      const yearSolarRev = annualKwh * currentTariff;

      // battery degradation (applied at year end)
      const batteryDegradationRate = 0.025 + (dcyclesPerDay > 1.5 ? 0.015 : 0.005);
      // usable energy per day = batteryKWh * DoD * cycles * availability * roundTripEff
      const dailyUsableKwh = dbatteryKWh * depthOfDischarge * dcyclesPerDay * storageAvailability * roundTripEff;
      const yearStorageRev = dailyUsableKwh * currentSpread * 365 * currentBatteryHealth;

      // RECs
      const yearRecRev = denableRecs === 1 ? (annualKwh / 1000) * drecPrice : 0;
      const debtPayment = year <= dloanTenure ? annualEMI : 0;

      // Depreciation
      let depreciationExpense = 0;
      if (denableAD === 1) {
        depreciationExpense = remainingDepreciationValue * 0.4;
        remainingDepreciationValue -= depreciationExpense;
      } else {
        depreciationExpense = totalCapex / 25;
      }

      // interest component (approximate)
      let interestComponent = 0;
      if (year <= dloanTenure && loanAmount > 0) {
        // approximate interest outstanding using amortization schedule is non-trivial;
        // we approximate interestComponent = outstanding * interestRate
        // conservative: assume average outstanding in year
        const n = dloanTenure;
        const r = dinterestRate;
        if (r > 0) {
          // compute outstanding after (year-1) payments using annuity formula inverse
          // approximate with: outstanding = loanAmount * ( (1+r)^{n} - (1+r)^{year-1} ) / ( (1+r)^{n} - 1 )
          const numerator = Math.pow(1 + r, n) - Math.pow(1 + r, year - 1);
          const denominator = Math.pow(1 + r, n) - 1;
          const outstanding = loanAmount * (numerator / denominator);
          interestComponent = outstanding * r;
        } else {
          // zero interest -> interest component zero
          interestComponent = 0;
        }
      }

      const taxableIncome = Math.max(0, (yearSolarRev + yearStorageRev + yearRecRev) - currentOM - depreciationExpense - Math.max(0, interestComponent));
      const taxesPaid = taxableIncome * dcorpTaxRate;

      const taxShield = (depreciationExpense + Math.max(0, interestComponent)) * dcorpTaxRate;

      const netCashFlow = (yearSolarRev + yearStorageRev + yearRecRev) - currentOM - debtPayment - taxesPaid + taxShield;
      cumulativeCashFlow += netCashFlow;
      cumulativeKwh += annualKwh;

      cashFlowsForIRR.push(netCashFlow);

      data.push({
        year: `Y${year}`,
        yearNum: year,
        capacity: Number(currentCapacity.toFixed(2)),
        batteryHealth: Number((currentBatteryHealth * 100).toFixed(1)),
        annualKwh: Math.round(annualKwh),
        solarRev: Math.round(yearSolarRev),
        storageRev: Math.round(yearStorageRev),
        recRev: Math.round(yearRecRev),
        taxShield: Math.round(taxShield),
        omCost: Math.round(currentOM),
        debtService: Math.round(debtPayment),
        netCashFlow: Math.round(netCashFlow),
        cumulativeCashFlow: Math.round(cumulativeCashFlow),
      });

      // degrade capacity and battery health AFTER year accounting (so first year is full)
      currentCapacity *= 0.98;
      currentBatteryHealth = Math.max(0, currentBatteryHealth * (1 - batteryDegradationRate));
    }

    // payback interpolation
    let paybackYear = "10+";
    for (let i = 0; i < data.length; i++) {
      if (data[i].cumulativeCashFlow >= 0) {
        const prevCF = i === 0 ? -equityRequired : data[i - 1].cumulativeCashFlow;
        const currentCF = data[i].cumulativeCashFlow;
        const denom = (currentCF - prevCF) || 1;
        const fraction = Math.abs(prevCF) / denom;
        paybackYear = (i + fraction).toFixed(1);
        break;
      }
    }

    const irr = calculateIRR(cashFlowsForIRR);
    const npv = cashFlowsForIRR.reduce((acc, val, i) => acc + (val / Math.pow(1 + ddiscountRate, i)), 0);

    const kpiData: KPIResult = {
      totalCapex,
      equityRequired,
      loanAmount,
      npv,
      leveragedIrr: irr,
      paybackYear,
      totalKwh: Math.round(cumulativeKwh),
      co2Offset: Math.round(cumulativeKwh * 0.85),
      waterSaved: Math.round(cumulativeKwh * 3),
      coalAvoided: Math.round(cumulativeKwh * 0.4),
    };

    return { chartData: data, kpiData };
  }, [debouncedInputs]); // only recalc when debounced inputs change


  const insights = useMemo(() => {
  const arr: string[] = [];

  if (debtPercentage >= 60) {
    arr.push(
      `Using ${debtPercentage}% debt reduces upfront equity to ${formatINR(
        kpiData.equityRequired
      )}, improving leveraged returns.`
    );
  } else {
    arr.push(
      `Lower debt increases equity requirement to ${formatINR(
        kpiData.equityRequired
      )}, reducing leverage benefits.`
    );
  }

  if (parseFloat(kpiData.paybackYear) < 3) {
    arr.push(
      `This project is highly bankable with a payback period of ${kpiData.paybackYear} years.`
    );
  } else if (parseFloat(kpiData.paybackYear) < 6) {
    arr.push(
      `The payback period of ${kpiData.paybackYear} years is typical for commercial solar investments.`
    );
  } else {
    arr.push(
      `The payback period of ${kpiData.paybackYear} years indicates slower investment recovery.`
    );
  }

  if (enableAD) {
    arr.push(
      `Accelerated depreciation improves early cash flows through tax shields.`
    );
  }

  return arr;
}, [kpiData, debtPercentage, enableAD]);

  // CSV export (safe & deterministic)
  const handleExportCSV = useCallback(() => {
    try {
      const headers = ["Year", "Capacity", "Gen", "Solar Rev", "Storage Rev", "REC Rev", "Tax Shield", "O&M", "Debt Service", "Net Cash Flow", "Cumulative"];
      const rows = chartData.map((r) => [r.year, r.capacity, r.annualKwh, r.solarRev, r.storageRev, r.recRev, r.taxShield, r.omCost, r.debtService, r.netCashFlow, r.cumulativeCashFlow]);
      const csvContent = "data:text/csv;charset=utf-8," + headers.join(",") + "\n" + rows.map((e) => e.join(",")).join("\n");
      const link = document.createElement("a");
      link.href = encodeURI(csvContent);
      link.download = `Zenith_${activeSite.name.replace(/\s/g, "_")}_Model.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("CSV export failed:", err);
      alert("Failed to export CSV.");
    }
  }, [chartData, activeSite.name]);

  return (
    <div className="space-y-6 relative">
      {/* AI Co-Pilot Widget */}
      <AnimatePresence>
        {isCopilotOpen && (
          <motion.div variants={slideIn} initial="hidden" animate="show" exit="exit" className="fixed top-24 right-4 z-50 w-80 bg-slate-900 border border-emerald-500/50 rounded-2xl shadow-[0_0_40px_rgba(16,185,129,0.2)] overflow-hidden flex flex-col h-[500px]">
            <div className="bg-slate-950 p-4 border-b border-slate-800 flex justify-between items-center">
              <div className="flex items-center gap-2"><Bot className="text-emerald-400 w-5 h-5" /> <span className="font-bold text-white text-sm">Zenith AI</span></div>
              <button onClick={() => setIsCopilotOpen(false)} aria-label="Close AI" className="text-slate-400 hover:text-white"><X size={16} /></button>
            </div>
            <div className="p-4 flex-grow overflow-y-auto space-y-4 text-sm bg-gradient-to-b from-slate-900 to-slate-950">
              <div className="bg-slate-800/50 p-3 rounded-xl rounded-tl-none border border-slate-700 text-slate-200">
                {isAiLoading ? "Analyzing your solar model..." : aiText}
              </div>
{insights.map((text, i) => (
  <div
    key={i}
    className="bg-slate-800/50 p-3 rounded-xl border border-slate-700 text-slate-200 flex gap-2"
  >
    <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-emerald-400" />
    {text}
  </div>
))}
            </div>

          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Action Bar */}
      <div className="flex flex-col md:flex-row justify-between items-center bg-slate-900/40 p-4 rounded-2xl border border-slate-800 shadow-lg gap-4 relative z-20">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
            <Activity className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white">Simulation Engine Active</h2>
            <p className="text-xs text-slate-400">All metrics recalculate dynamically (debounced for performance).</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 w-full md:w-auto">
          <button
  onClick={async () => {
    setIsCopilotOpen(true);
    setIsAiLoading(true);

    try {
      const res = await fetch("/api/rooftop-ai", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          siteName: activeSite.name,
          systemSizeKW: kW,
          batteryKWh: batteryKWh,
          irr: kpiData.leveragedIrr,
          paybackYears: kpiData.paybackYear,
          equityRequired: kpiData.equityRequired,
          npv: kpiData.npv
        })
      });

      const data = await res.json();

      setAiText(data.text);

    } catch {
      setAiText("AI analysis failed. Try again.");
    } finally {
      setIsAiLoading(false);
    }
  }} aria-pressed={isCopilotOpen} className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-emerald-400 px-4 py-2 rounded-xl text-sm font-bold border border-emerald-900/50 transition-colors shadow-[0_0_10px_rgba(16,185,129,0.1)]">
            <Bot className="w-4 h-4" /> Ask AI
          </button>
          <button onClick={handleExportCSV} className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-sm font-bold border border-slate-700 transition-colors" aria-label="Export CSV">
            <FileSpreadsheet className="w-4 h-4" /> CSV
          </button>
          <button onClick={onExportPDF} disabled={isExportingPDF} className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-6 py-2 rounded-xl text-sm font-bold transition-colors" aria-label="Export Deck">
            {isExportingPDF ? <Activity className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Deck
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard title="Total CapEx" value={formatINR(kpiData.totalCapex)} icon={<DollarSign className="text-amber-400" />} />
        <KPICard title="Upfront Equity" value={formatINR(kpiData.equityRequired)} icon={<Landmark className="text-emerald-400" />} highlight />
        <KPICard title="Equity Payback" value={`${kpiData.paybackYear} Yrs`} icon={<TrendingUp className="text-cyan-400" />} />
        <KPICard title="Leveraged IRR" value={`${kpiData.leveragedIrr}%`} icon={<BarChart3 className="text-indigo-400" />} highlight />
        <KPICard title="Net Present Value" value={formatINR(kpiData.npv)} icon={<Calculator className="text-pink-400" />} className="col-span-2 lg:col-span-1" />
      </div>

      <div className="grid lg:grid-cols-12 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-4 flex flex-col gap-6">
          <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-xl shadow-2xl flex-grow flex flex-col h-[780px]">
            <h3 className="text-xl font-bold mb-4">Simulation Variables</h3>

            <div className="flex flex-wrap bg-slate-950 p-1 rounded-xl mb-6 border border-slate-800 gap-1">
              <TabButton active={activeTab === 'solar'} onClick={() => setActiveTab('solar')} icon={<Zap size={14} />} label="Solar" />
              <TabButton active={activeTab === 'storage'} onClick={() => setActiveTab('storage')} icon={<BatteryMedium size={14} />} label="Storage" />
              <TabButton active={activeTab === 'debt'} onClick={() => setActiveTab('debt')} icon={<Landmark size={14} />} label="Debt" />
              <TabButton active={activeTab === 'tax'} onClick={() => setActiveTab('tax')} icon={<Coins size={14} />} label="Tax" />
            </div>

            <div className="space-y-6 flex-grow overflow-y-auto pr-2 custom-scrollbar">
              <AnimatePresence mode="wait">
                {activeTab === 'solar' && (
                  <motion.div key="solar" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} className="space-y-6">
                    <SliderControl label="System Size (kW)" value={kW} min={50} max={5000} step={50} onChange={(v: number) => setKW(clamp(v, 1, 100000))} highlight />
                    <SliderControl label="Active Sun Hours" value={hoursPerDay} min={2} max={8} step={0.1} onChange={(v: number) => setHoursPerDay(clamp(v, 0, 24))} />
                    <SliderControl label="Base Tariff (₹/kWh)" value={pricePerKwh} min={0.5} max={100} step={0.1} onChange={(v: number) => setPricePerKwh(clamp(v, 0.01, 1000))} />
                    <SliderControl label="Tariff Escalation (YoY)" value={tariffEscalation} min={0} max={0.10} step={0.005} onChange={(v: number) => setTariffEscalation(clamp(v, 0, 1))} isPercent />
                    <SliderControl label="Solar Capex (₹/kW)" value={capexPerKW} min={20000} max={120000} step={1000} onChange={(v: number) => setCapexPerKW(clamp(v, 0, 1e7))} />
                  </motion.div>
                )}

                {activeTab === 'storage' && (
                  <motion.div key="storage" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} className="space-y-6">
                    <SliderControl label="Battery Capacity (kWh)" value={batteryKWh} min={0} max={10000} step={50} onChange={(v: number) => setBatteryKWh(clamp(v, 0, 1e6))} highlight color="indigo" />
                    <SliderControl label="Peak Spread (₹/kWh)" value={peakArbitrageSpread} min={0} max={50} step={0.5} onChange={(v: number) => setPeakArbitrageSpread(clamp(v, 0, 1e4))} color="indigo" />
                    <SliderControl label="Cycles Per Day" value={cyclesPerDay} min={0.1} max={4} step={0.1} onChange={(v: number) => setCyclesPerDay(clamp(v, 0.1, 10))} color="indigo" />
                    <SliderControl label="Storage Capex (₹/kWh)" value={capexPerKWh} min={10000} max={100000} step={500} onChange={(v: number) => setCapexPerKWh(clamp(v, 0, 1e7))} color="indigo" />
                  </motion.div>
                )}

                {activeTab === 'debt' && (
                  <motion.div key="debt" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} className="space-y-6">
                    <div className="p-4 bg-amber-950/20 border border-amber-900/50 rounded-xl mb-2 text-xs text-amber-300">Model leveraged returns via project finance.</div>
                    <SliderControl label="Debt Financing (%)" value={debtPercentage / 100} min={0} max={1} step={0.01} onChange={(v: number) => setDebtPercentage(clamp(v * 100, 0, 100))} isPercent color="amber" highlight />
                    <SliderControl label="Loan Tenure (Years)" value={loanTenure} min={1} max={25} step={1} onChange={(v: number) => setLoanTenure(Math.max(1, Math.round(v)))} color="amber" />
                    <SliderControl label="Interest Rate (Annual)" value={interestRate} min={0} max={0.3} step={0.001} onChange={(v: number) => setInterestRate(clamp(v, 0, 1))} isPercent color="amber" />
                    <SliderControl label="Discount Rate (WACC)" value={discountRate} min={0} max={0.3} step={0.001} onChange={(v: number) => setDiscountRate(clamp(v, 0, 1))} isPercent color="amber" />
                  </motion.div>
                )}

                {activeTab === 'tax' && (
                  <motion.div key="tax" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }} className="space-y-6">
                    <div className="p-4 bg-emerald-950/20 border border-emerald-900/50 rounded-xl mb-2 text-xs text-emerald-300">Factor in corporate tax shields and REC trading.</div>
                    <SliderControl label="Enable Accelerated Dep." value={enableAD} min={0} max={1} step={1} onChange={(v: number) => setEnableAD(v ? 1 : 0)} color="emerald" highlight />
                    <SliderControl label="Corporate Tax Rate" value={corpTaxRate} min={0.05} max={0.45} step={0.001} onChange={(v: number) => setCorpTaxRate(clamp(v, 0, 1))} isPercent color="emerald" />
                    <SliderControl label="Enable REC Trading" value={enableRecs} min={0} max={1} step={1} onChange={(v: number) => setEnableRecs(v ? 1 : 0)} color="cyan" />
                    {enableRecs === 1 && <SliderControl label="REC Price (₹/MWh)" value={recPrice} min={100} max={5000} step={25} onChange={(v: number) => setRecPrice(clamp(v, 0, 1e6))} color="cyan" />}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Right Column: Visualizations */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          {/* Main Chart */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 md:p-8 backdrop-blur-xl shadow-2xl h-[400px] flex flex-col relative overflow-hidden">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-2 relative z-10">
              <h3 className="text-xl font-bold">10-Year Post-Tax Cash Flow</h3>
              <div className="flex flex-wrap gap-3 bg-slate-950/80 px-4 py-2 rounded-full border border-slate-800 text-[10px] font-bold uppercase tracking-wider">
                <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-emerald-500" /> Solar</span>
                <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-indigo-500" /> Arbitrage</span>
                {enableAD === 1 && <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-fuchsia-500" /> Tax Shield</span>}
                <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-red-500" /> Debt Serv.</span>
                <span className="flex items-center gap-1"><div className="w-3 h-1 rounded-full bg-cyan-400" /> Cum. Net</span>
              </div>
            </div>

            <div className="w-full flex-grow relative z-10">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="year" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `₹${(val / 100000).toFixed(0)}L`} />
                  <YAxis yAxisId="right" orientation="right" stroke="#22d3ee" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `₹${(val / 100000).toFixed(0)}L`} />
                  <RechartsTooltip content={<CustomTooltip showRec={enableRecs === 1} showTax={enableAD === 1} />} />

                  <Bar yAxisId="left" dataKey="solarRev" stackId="rev" fill="#10b981" />
                  <Bar yAxisId="left" dataKey="storageRev" stackId="rev" fill="#6366f1" />
                  {enableRecs === 1 && <Bar yAxisId="left" dataKey="recRev" stackId="rev" fill="#86efac" />}
                  {enableAD === 1 && <Bar yAxisId="left" dataKey="taxShield" stackId="rev" fill="#d946ef" radius={[4, 4, 0, 0]} />}

                  <Bar yAxisId="left" dataKey="debtService" fill="#ef4444" radius={[4, 4, 0, 0]} barSize={10} />

                  <Line yAxisId="right" type="monotone" dataKey={() => 0} stroke="#475569" strokeWidth={1} dot={false} activeDot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="cumulativeCashFlow" stroke="#22d3ee" strokeWidth={3} dot={{ fill: '#060913', strokeWidth: 2, r: 4 }} activeDot={{ r: 6, strokeWidth: 0, fill: '#22d3ee' }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[356px]">
            {/* 24-Hour Dispatch */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-xl shadow-2xl flex flex-col">
              <h3 className="text-sm font-bold mb-1 flex items-center gap-2"><Clock size={16} className="text-amber-400" /> Typical Daily Dispatch Flow</h3>
              <p className="text-[10px] text-slate-400 mb-4">Simulated 24-hour profile mapping generation vs load.</p>
              <div className="flex-grow">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={HOURLY_PROFILE} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorSolar" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorLoad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="hour" stroke="#64748b" fontSize={9} tickLine={false} axisLine={false} interval={3} />
                    <YAxis stroke="#64748b" fontSize={9} tickLine={false} axisLine={false} />
                    <RechartsTooltip contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", fontSize: "10px" }} />
                    <Area type="monotone" dataKey="solarGen" stroke="#10b981" fillOpacity={1} fill="url(#colorSolar)" name="Solar Gen (kW)" />
                    <Area type="monotone" dataKey="loadDemand" stroke="#f59e0b" fillOpacity={1} fill="url(#colorLoad)" name="Facility Load (kW)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Gantt */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-xl shadow-2xl flex flex-col relative">
              <h3 className="text-sm font-bold mb-1 flex items-center gap-2"><CalendarDays size={16} className="text-cyan-400" /> Execution Timeline</h3>
              <p className="text-[10px] text-slate-400 mb-4">Est. Deployment for {kW}kW system: {kW > 1000 ? "24" : "16"} Weeks</p>
              <div className="flex-grow flex flex-col justify-around relative">
                <div className="absolute left-[20%] top-0 bottom-0 w-px bg-slate-800" />
                <div className="absolute left-[40%] top-0 bottom-0 w-px bg-slate-800" />
                <div className="absolute left-[60%] top-0 bottom-0 w-px bg-slate-800" />
                <div className="absolute left-[80%] top-0 bottom-0 w-px bg-slate-800" />

                <GanttBar label="Permitting" width="30%" start="0%" color="bg-slate-600" />
                <GanttBar label="Procurement" width="40%" start="20%" color="bg-indigo-500" />
                <GanttBar label="Installation" width="35%" start="50%" color="bg-cyan-500" />
                <GanttBar label="Commissioning" width="15%" start="85%" color="bg-emerald-500" />
              </div>
              <div className="flex justify-between text-[8px] font-mono text-slate-500 mt-2 border-t border-slate-800 pt-2">
                <span>Month 1</span><span>Month 2</span><span>Month 3</span><span>Month 4</span><span>Month 5</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Matrix Table */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 backdrop-blur-xl shadow-2xl overflow-hidden flex flex-col mt-4">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-bold">Comprehensive Amortization Matrix</h3>
          <span className="text-xs text-slate-500 italic bg-slate-950 px-3 py-1 rounded-full border border-slate-800">Post-Tax EoY Values</span>
        </div>
        <div className="overflow-x-auto custom-scrollbar pb-2">
          <table className="w-full text-left text-sm text-slate-400 whitespace-nowrap">
            <thead className="text-xs text-slate-500 uppercase bg-slate-950/80">
              <tr>
                <th className="px-4 py-4 rounded-tl-lg font-bold">Year</th>
                <th className="px-4 py-4">Solar (kW)</th>
                <th className="px-4 py-4">Gen (kWh)</th>
                <th className="px-4 py-4 text-emerald-400/70">Solar Rev</th>
                <th className="px-4 py-4 text-indigo-400/70">Store Rev</th>
                {enableRecs === 1 && <th className="px-4 py-4 text-green-300/70">REC Rev</th>}
                <th className="px-4 py-4 text-fuchsia-400/70">Tax Shield</th>
                <th className="px-4 py-4 text-red-500/70 font-bold">Debt Serv.</th>
                <th className="px-4 py-4 text-slate-200">Net Cash Flow</th>
                <th className="px-4 py-4 rounded-tr-lg text-cyan-400 font-bold">Cum. Cash</th>
              </tr>
            </thead>
            <tbody>
              {chartData.map((row) => (
                <tr key={row.year} className="border-b border-slate-800/50 hover:bg-slate-800/40 transition-colors group">
                  <td className="px-4 py-3 font-medium text-slate-200">{row.year}</td>
                  <td className="px-4 py-3">{row.capacity.toFixed(0)}</td>
                  <td className="px-4 py-3 font-mono"> {row.annualKwh.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-3 text-emerald-400 font-mono">{formatCompact(row.solarRev)}</td>
                  <td className="px-4 py-3 text-indigo-400 font-mono">{formatCompact(row.storageRev)}</td>
                  {enableRecs === 1 && <td className="px-4 py-3 text-green-300 font-mono">{formatCompact(row.recRev)}</td>}
                  <td className="px-4 py-3 text-fuchsia-400 font-mono">+{formatCompact(row.taxShield)}</td>
                  <td className="px-4 py-3 text-red-500 font-mono">-{formatCompact(row.debtService)}</td>
                  <td className="px-4 py-3 font-medium text-slate-200 font-mono">{formatINR(row.netCashFlow)}</td>
                  <td className={`px-4 py-3 font-bold font-mono ${row.cumulativeCashFlow >= 0 ? "text-cyan-400" : "text-slate-500"}`}>
                    {row.cumulativeCashFlow < 0 ? "-" : ""}{formatINR(Math.abs(row.cumulativeCashFlow))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// SUBCOMPONENTS (memoized + accessible)
// ==========================================

const GanttBar = React.memo(function GanttBar({ label, width, start, color }: any) {
  return (
    <div className="relative h-8 flex items-center group z-10" role="listitem" aria-label={label}>
      <span className="w-24 text-[10px] font-bold text-slate-300 group-hover:text-white transition-colors">{label}</span>
      <div className="flex-grow relative h-4 bg-slate-800/50 rounded-full overflow-hidden">
        <motion.div initial={{ width: 0 }} whileInView={{ width }} transition={{ duration: 1, delay: 0.2 }} viewport={{ once: true }} className={`absolute top-0 bottom-0 rounded-full ${color}`} style={{ left: start }} />
      </div>
    </div>
  );
});

const KPICard = React.memo(function KPICard({ title, value, icon, highlight = false, className = "" }: any) {
  return (
    <div className={`border rounded-2xl p-5 flex flex-col justify-between transition-all duration-300 relative overflow-hidden ${className}
      ${highlight ? "bg-slate-800/80 border-slate-600 shadow-lg shadow-slate-900/50" : "bg-slate-900/40 border-slate-800 hover:bg-slate-800/50"}`}
      role="region" aria-label={title}
    >
      {highlight && <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400" />}
      <div className="flex justify-between items-start mb-4 relative z-10">
        <span className={`text-sm font-medium ${highlight ? "text-slate-300" : "text-slate-400"}`}>{title}</span>
        <div className="p-2 bg-slate-950 rounded-lg border border-slate-800 shadow-inner" aria-hidden>{icon}</div>
      </div>
      <div className={`text-3xl font-black tracking-tight relative z-10 ${highlight ? "text-white" : "text-slate-100"}`}>{value}</div>
    </div>
  );
});

const TabButton = React.memo(function TabButton({ active, onClick, icon, label }: any) {
  return (
    <button onClick={onClick} aria-pressed={active} className={`flex-1 flex flex-col md:flex-row items-center justify-center gap-1 md:gap-2 py-2 px-1 text-[10px] md:text-sm font-bold rounded-lg transition-all duration-300 ${active ? "bg-slate-800 text-white shadow-[0_4px_10px_rgba(0,0,0,0.3)] border border-slate-700" : "text-slate-500 hover:text-slate-300 hover:bg-slate-900/50 border border-transparent"}`}>
      {icon} {label}
    </button>
  );
});

function CustomTooltipInner({ active, payload, label, showRec, showTax }: any) {
  if (active && payload && payload.length) {
    // Recharts payload shape can contain entries with value in .value or .payload
    const findVal = (key: string) => {
      const item = payload.find((p: any) => p && (p.dataKey === key || p.name === key));
      if (!item) return 0;
      if (typeof item.value === "number") return item.value;
      if (item.payload && typeof item.payload[key] === "number") return item.payload[key];
      return 0;
    };

    const solarVal = findVal("solarRev");
    const storageVal = findVal("storageRev");
    const recVal = findVal("recRev");
    const taxVal = findVal("taxShield");
    const debtVal = findVal("debtService");
    const cumVal = findVal("cumulativeCashFlow") || (payload[payload.length - 1] && (payload[payload.length - 1].payload?.cumulativeCashFlow ?? 0)) || 0;

    return (
      <div className="bg-slate-950/95 backdrop-blur-md border border-slate-700 p-4 rounded-xl shadow-2xl space-y-3 min-w-[240px]">
        <p className="font-black text-slate-200 border-b border-slate-800 pb-2 uppercase tracking-wider text-xs">{label} Analysis</p>
        <div className="flex justify-between text-sm items-center"><span className="text-emerald-400 flex items-center gap-1.5"><Zap size={12} /> Solar:</span><span className="font-mono">{formatINR(solarVal)}</span></div>
        <div className="flex justify-between text-sm items-center"><span className="text-indigo-400 flex items-center gap-1.5"><BatteryMedium size={12} /> Arbitrage:</span><span className="font-mono">{formatINR(storageVal)}</span></div>
        {showRec && <div className="flex justify-between text-sm items-center"><span className="text-green-300 flex items-center gap-1.5"><Leaf size={12} /> REC Credit:</span><span className="font-mono">{formatINR(recVal)}</span></div>}
        {showTax && <div className="flex justify-between text-sm items-center"><span className="text-fuchsia-400 flex items-center gap-1.5"><Landmark size={12} /> Tax Shield:</span><span className="font-mono">{formatINR(taxVal)}</span></div>}
        <div className="flex justify-between text-sm items-center border-t border-slate-800/50 pt-2"><span className="text-red-400 flex items-center gap-1.5"><Coins size={12} /> Debt Serv:</span><span className="font-mono text-red-400">-{formatINR(debtVal)}</span></div>
        <div className="flex justify-between text-sm items-center border-t border-slate-800 pt-2 mt-1"><span className="text-cyan-400 font-bold text-xs uppercase">Cumulative Net:</span><span className="font-mono font-black text-cyan-400">{formatINR(cumVal)}</span></div>
      </div>
    );
  }
  return null;
}
const CustomTooltip = React.memo(CustomTooltipInner);

const SliderControl = React.memo(function SliderControl({ label, value, min, max, step, onChange, isPercent = false, highlight = false, color = "emerald" }: any) {
  const accentColors: any = {
    emerald: "accent-emerald-500 focus:ring-emerald-500/50 text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    indigo: "accent-indigo-500 focus:ring-indigo-500/50 text-indigo-400 bg-indigo-500/10 border-indigo-500/20",
    cyan: "accent-cyan-500 focus:ring-cyan-500/50 text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
    amber: "accent-amber-500 focus:ring-amber-500/50 text-amber-400 bg-amber-500/10 border-amber-500/20",
  };
  const activeColor = accentColors[color] || accentColors.emerald;

  return (
    <div className={`space-y-3 p-1 ${highlight ? 'bg-slate-800/30 rounded-xl p-3 border border-slate-700/50' : ''}`}>
      <div className="flex justify-between items-center">
        <label className="text-sm font-semibold text-slate-300">{label}</label>
        <span className={`font-mono text-sm px-2.5 py-1 rounded-md border ${activeColor} font-bold shadow-inner`}>{isPercent ? `${(value * 100).toFixed(1)}%` : (typeof value === "number" ? value.toLocaleString('en-IN') : value)}</span>
      </div>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(isPercent ? Number(n) : Number(n));
        }}
        className={`w-full h-2 bg-slate-950 rounded-full appearance-none cursor-pointer focus:outline-none focus:ring-2 transition-all ${activeColor.split(' ')[0]} ${activeColor.split(' ')[1]}`}
      />
      <div className="flex justify-between text-[10px] text-slate-600 font-mono px-1"><span>{isPercent ? `${(min * 100).toFixed(0)}%` : min}</span><span>{isPercent ? `${(max * 100).toFixed(0)}%` : max}</span></div>
    </div>
  );
});
