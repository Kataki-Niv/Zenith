"use client";

import { motion, Variants } from "framer-motion";
import { Cpu } from "lucide-react";
import { useRouter } from "next/navigation";
import { calculateSolarBenefits } from "@/lib/solarCalculations";
import { useEffect, useState } from "react";
import { getFeasibilityScore, getInvestmentLabel } from "@/lib/feasibilityScores";

const TARIFF_PER_KWH = 8;
const OFFSET_FACTOR = 0.8; // realistic 80% offset
const SERVICE1_STORAGE_KEY = "service1Data";

  const fadeUp: Variants = {
  hidden: { opacity: 0, y: 30 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 100, damping: 15 }
  }
};

function MetricCard({
  title,
  value,
  subtitle,
  highlight = false,
}: {
  title: string;
  value: string;
  subtitle?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`relative rounded-2xl p-6 overflow-hidden border transition-all
        
        ${
          highlight
            ? "bg-slate-800/80 border-slate-600 shadow-lg shadow-slate-900/50"
            : "bg-slate-900/40 border-slate-800 hover:bg-slate-800/50"
        }`}
    >
      {highlight && (
        <div className="absolute -top-[1px] left-1/2 -translate-x-1/2 w-[100%] h-[3px] bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400 rounded-full" />
      )}

      <p className="text-xs uppercase tracking-wider text-[#F3F4F4]/60">
        {title}
      </p>
      <p className="text-2xl font-bold text-[#F3F4F4] mt-1">
        {value}
      </p>
      {subtitle && (
        <p className="text-xs text-[#F3F4F4]/50 mt-1">{subtitle}</p>
      )}
    </div>


  );
}

type Service1StoredData = {
  hasCalculated?: boolean;
  location?: string;
  monthlyBill?: number | "";
  results?: {
    systemSizeKW: number;
    numberOfPanels: number;
    installationCost: number;
    annualSavings: number;
    paybackYears: number;
    lifetimeProfit: number;
    feasibilityScore: number;
  } | null;
};

function getStoredService1Data(): Service1StoredData {
  if (typeof window === "undefined") {
    return {};
  }

  const saved = localStorage.getItem(SERVICE1_STORAGE_KEY);
  if (!saved) {
    return {};
  }

  try {
    const parsed = JSON.parse(saved);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    localStorage.removeItem(SERVICE1_STORAGE_KEY);
    return {};
  }
}

export default function Service1Page() {
  const router = useRouter();
  const [showBillUpload, setShowBillUpload] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [hasCalculated, setHasCalculated] = useState(false);
  const [location, setLocation] = useState("");
  const [monthlyBill, setMonthlyBill] = useState<number | "">("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<null | {
  systemSizeKW: number;
  numberOfPanels: number;
  installationCost: number;
  annualSavings: number;
  paybackYears: number;
  lifetimeProfit: number;
  feasibilityScore: number;
}>(null);
  const [geminiText, setGeminiText] = useState<string>("Loading explanation...");
  const [isGeminiLoading, setIsGeminiLoading] = useState(false);
  const [isBillLoading, setIsBillLoading] = useState(false);

  useEffect(() => {
    const storedData = getStoredService1Data();

    setHasCalculated(storedData.hasCalculated ?? false);
    setLocation(typeof storedData.location === "string" ? storedData.location : "");
    setMonthlyBill(
      typeof storedData.monthlyBill === "number" ? storedData.monthlyBill : ""
    );
    setResults(storedData.results ?? null);
    setHasHydrated(true);
  }, []);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    localStorage.setItem(
      SERVICE1_STORAGE_KEY,
      JSON.stringify({
        location,
        monthlyBill,
        results,
        hasCalculated,
      })
    );
  }, [hasHydrated, location, monthlyBill, results, hasCalculated]);

  return (
    <div className="h-full flex flex-col bg-[#050808] text-gray-200">

      {/* Header */}
 {/* Hero Heading */}
<motion.div
  initial="hidden"
  animate="show"
  variants={fadeUp}
  className="mb-12 border-b border-slate-800/50 pb-8 text-center"
>

  {/* Zenith Badge */}
  <div className="flex justify-center">
    <div className="flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full
      bg-slate-800/50 border border-slate-700/50 backdrop-blur-md shadow-lg w-max">
      <Cpu className="w-4 h-4 text-emerald-400" />
      <span className="text-xs font-semibold tracking-wider uppercase text-slate-300">
        Zenith Enterprise OS v6.0
      </span>
    </div>
  </div>



  {/* Headline */}
  <h1 className="text-[clamp(36px,5vw,60px)] font-black tracking-tighter text-[#F3F4F4] leading-tight">
    Unlock Your Roof&apos;s <br />
    <span className="bg-clip-text text-transparent
      bg-gradient-to-r from-emerald-400 via-cyan-400 to-indigo-400">
      Energy Potential
    </span>
  </h1>

  {/* Description */}
  <p className="mt-4 text-sm md:text-base text-slate-400 max-w-2xl mx-auto">
    Upload your bill and let our AI generate a hyper-accurate,
    investment-grade solar feasibility score in seconds.
  </p>

</motion.div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 flex-1 min-h-0">

        {/* LEFT: Input Card */}
        <div className="lg:col-span-2 bg-[#0A0F0F]/80 backdrop-blur-xl border border-[#1E2A2A] rounded-2xl p-6 flex flex-col">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-[#F3F4F4]">
              Configuration
            </h2>
             <p className="text-sm text-[#F3F4F4]/50 mt-1">
              Calibrate the model parameters.
            </p>
           </div>

          <div className="flex flex-col flex-1 space-y-4">
            <div className="space-y-2">
  {/* Label */}
  <div className="flex items-center justify-between">
    <label className="text-xs font-bold uppercase tracking-widest text-gray-400">
      Grid Location
    </label>
  </div>

  {/* Input container */}
  <div className="bg-[#131A1A] border border-[#2A3737] rounded-xl px-4 py-3">
    <input
      type="text"
      placeholder="Enter your location"
      value={location}
      onChange={(e) => setLocation(e.target.value)}
      className="w-full bg-transparent outline-none text-white placeholder:text-gray-500 text-sm"
    />
  </div>
</div>

            <div className="space-y-2">
  {/* Label */}
  <div className="flex items-center justify-between">
    <label className="text-xs font-bold uppercase tracking-widest text-gray-400">
      Monthly Usage
    </label>

    {/* Optional value chip (can remove later) */}
{monthlyBill !== "" && (
  <span className="text-xs font-mono text-teal-400 bg-teal-500/10 px-2 py-1 rounded-md">
    ₹ {monthlyBill}
  </span>
)}
  </div>

  {/* Input container */}
  <div className="bg-[#131A1A] border border-[#2A3737] rounded-xl px-4 py-3">
    <input
      type="number"
      placeholder="e.g. 2500"
      value={monthlyBill}
      onChange={(e) =>
        setMonthlyBill(e.target.value === "" ? "" : Number(e.target.value))
      }
      className="w-full bg-transparent outline-none text-white placeholder:text-gray-500 text-sm"
    />
  </div>
</div>

            {/* AI Bill Upload (Beta) */}

            <p className="text-xs text-[#F3F4F4]/50 text-center mt-2">
  — OR —
</p>

<div className="pt-2">
  <button
    type="button"
    onClick={() => setShowBillUpload(!showBillUpload)}
    className="w-full rounded-md border border-[#5F9598]/50 py-2 text-sm text-[#F3F4F4] hover:bg-[#5F9598]/10 transition"
  >
    ✨ Auto-fill from Bill (AI – Beta)
  </button>

  {showBillUpload && (
    <div className="relative mt-3 rounded-md border border-dashed border-[#5F9598]/40 p-4 text-center bg-[#061E29]/60">



      <p className="text-sm text-[#F3F4F4]/80 mb-2">
        Upload your electricity bill
      </p>

<input
  type="file"
  accept=".jpg,.jpeg,.png"   // ⛔ PDF later, images only for now
  onChange={async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

try {
  setIsBillLoading(true);



  const res = await fetch("/api/bill-parser", {
    method: "POST",
    body: formData,
  });

  const data = await res.json();

  if (data.monthlyBill) {
    setMonthlyBill(data.monthlyBill);
    setShowBillUpload(false);
  } else {
    alert("Could not read bill. Please enter manually.");
  }
} catch {
  alert("Bill upload failed. Please enter manually.");
} finally {
  setIsBillLoading(false);
}

  }}
  className="block w-full text-sm text-[#F3F4F4]/70
             file:mr-4 file:py-2 file:px-4
             file:rounded-md file:border-0
             file:text-sm file:font-medium
             file:bg-[#5F9598] file:text-[#061E29]
             hover:file:bg-[#6FAFB2]"
/>
{isBillLoading && (
  <p className="mt-2 text-xs text-[#F3F4F4]/60">
    Reading bill…
  </p>
)}


      <p className="mt-2 text-xs text-[#F3F4F4]/50">
        AI will extract bill details. You can edit values manually if needed.
      </p>
    </div>
  )}
</div>


{error && (
  <p className="text-sm text-red-400 mt-2">
    {error}
  </p>
)}





<button
  onClick={async () => {
    setError("");

    if (!location) {
      setError("Please enter your location.");
      return;
    }

    if (monthlyBill === "" || monthlyBill <= 0) {
      setError("Please enter your monthly bill or use bill auto-fill.");
      return;
    }

    const FEASIBILITY_SCORE = getFeasibilityScore(location);

    const calculationResult = calculateSolarBenefits({
      monthlyBill,
      tariffPerKWh: TARIFF_PER_KWH,
      offsetFactor: OFFSET_FACTOR,
      feasibilityScore: FEASIBILITY_SCORE,
    });

    const investmentLabel = getInvestmentLabel(
      calculationResult.paybackYears
    );

    setResults(calculationResult);
    setHasCalculated(true);

    setGeminiText("");
    setIsGeminiLoading(true);

    try {
      const res = await fetch("/api/gemini-explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location,
          monthlyBill,
          systemSizeKW: calculationResult.systemSizeKW,
          paybackYears: calculationResult.paybackYears,
          investmentLabel,
        }),
      });

      const data = await res.json();
      setGeminiText(data.text);
    } catch {
      setGeminiText(
        "AI explanation temporarily unavailable. Please try again."
      );
    } finally {
      setIsGeminiLoading(false);
    }
  }}
  disabled={isGeminiLoading}
className={`
  w-full mt-6
  rounded-full
  px-6 py-3
  flex items-center justify-center gap-3
  font-semibold tracking-wide uppercase
  text-[#061E29]
  transition-all duration-200
  ${
    isGeminiLoading
      ? `
        bg-gradient-to-r from-emerald-400/60 to-teal-400/60
        shadow-[0_0_15px_rgba(52,211,153,0.25)]
        cursor-not-allowed
        `
      : `
bg-emerald-500
hover:bg-emerald-400
text-slate-950
shadow-none
        `
  }
`}
>
  <span className="text-lg">⚡</span>
  {isGeminiLoading ? "Calculating..." : "Calculate Feasibility"}
</button>

            {hasCalculated && (
  <div className="mt-6  rounded-lg bg-[#061E29]/70 border border-[#5F9598]/20 p-4">
    <p className="text-lg font-medium text-[#7EE081] mb-2 flex items-center gap-2">
      💡 Did you know?
    </p>
    <p className="text-base text-[#F3F4F4]/90 leading-relaxed">
      India’s solar capacity has grown over <span className="font-medium">30× in the last decade</span>.
      By installing a Zenith-optimized system, you’re contributing to the National Green Grid.
    </p>
  </div>
)}

          </div>
        </div>

        {/* RIGHT: Image as the card */}
        <div className="lg:col-span-3 rounded-xl flex flex-col overflow-hidden">

{!hasCalculated ? (
  <div className="h-full min-h-[500px] rounded-3xl border border-dashed border-[#2A3737] bg-[#0A0F0F]/80 backdrop-blur-xl flex flex-col items-center justify-center text-center p-10">

    <div className="w-20 h-20 rounded-full bg-[#131A1A] border border-[#1E2A2A] flex items-center justify-center mb-6 shadow-inner">
      <span className="text-teal-400 text-3xl">⚡</span>
    </div>

    <h3 className="text-2xl font-semibold text-[#E5E7EB] mb-2">
      System Standby
    </h3>

    <p className="text-sm text-[#9CA3AF] max-w-md leading-relaxed">
      Enter your details and run the feasibility engine to generate a
      personalized solar & savings report.
    </p>

  </div>
) : (
  <div className="h-full rounded-xl bg-[#0A0F0F]/80 backdrop-blur-xl
                border border-[#1E2A2A]
                p-8 overflow-y-auto space-y-8">

  {/* TOP SUMMARY */}
  <div>
   <p className="text-sm uppercase tracking-wider text-slate-400">
      Potential Monthly Savings
    </p>
    <h2 className="text-4xl font-bold text-[#7EE081] mt-1">
      ₹{results ? Math.round(results.annualSavings / 12).toLocaleString() : "--"}
    </h2>
  </div>

  {/* METRICS GRID */}

<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">


    {/* Number of Panels */}
  <MetricCard
    title="Solar Panels"
    value={
      results ? `${results.numberOfPanels} Panels` : "--"
    } highlight
  />

  {/* System Size */}
  <MetricCard
    title="System Size"
    value={
      results ? `${results.systemSizeKW.toFixed(1)} kW` : "--"
    }
  />

  {/* Installation Cost */}
  <MetricCard
    title="Installation Cost"
    value={
      results
        ? `₹${Math.round(results.installationCost).toLocaleString()}`
        : "--"
    }
    

  />

  {/* Annual Savings */}
  <MetricCard
    title="Annual Savings"
    value={
      results
        ? `₹${Math.round(results.annualSavings).toLocaleString()}`
        : "--"
    } highlight
    
  />

  {/* Payback Period */}
  <MetricCard
    title="Payback Period"
    value={
      results ? `${results.paybackYears.toFixed(1)} yrs` : "--"
    }
  />

  {/* 25 Year Profit */}
  <MetricCard
    title="25 Year Profit"
    value={
      results
        ? `₹${Math.round(results.lifetimeProfit).toLocaleString()}`
        : "--"
    }
  />

</div>

  {/* FEASIBILITY SCORE */}
  <div>
    <p className="text-sm text-[#F3F4F4]/70 mb-2">
      Feasibility Score
    </p>
    <div className="w-full h-3 rounded-full bg-[#1D546D]/40">
      <div
        className="h-3 rounded-full bg-[#7EE081]"
        style={{
          width: results ? `${results.feasibilityScore * 10}%` : "0%",
        }}
      />
    </div>
    <p className="text-xs text-[#F3F4F4]/60 mt-1">
      Score: {results ? results.feasibilityScore.toFixed(1) : "--"} / 10
    </p>
  </div>

  {/* EXECUTIVE SUMMARY */}
  <div className="rounded-2xl bg-[#1D546D]/30 border border-white/10 p-6">
    <p className="text-xs uppercase tracking-wider text-[#7EE081] mb-2">
      Executive Summary
    </p>
    <p className="text-sm text-[#F3F4F4]/80 whitespace-pre-line leading-relaxed">
      {isGeminiLoading
        ? "Analyzing your solar feasibility..."
        : geminiText}
    </p>
  </div>

  <button
  onClick={() => {
    if (!results) return;

    router.push(
      `/service2?kw=${results.systemSizeKW}&tariff=${TARIFF_PER_KWH}&sun=4.5&bill=${monthlyBill}&location=${location}`
    );
  }}
  className="
   w-full mt-6
rounded-full
px-6 py-3
flex items-center justify-center gap-3
font-semibold tracking-wide uppercase
bg-emerald-500
hover:bg-emerald-400
text-slate-950
transition-all
  "
>
  📈 Analyze Future Profitability
</button>

</div>
)}


        </div>

      </div>
    </div>
  );
}
