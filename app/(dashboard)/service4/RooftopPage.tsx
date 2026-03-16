"use client";

import { calculateRooftopSolar } from "@/lib/rooftopSolarCalculations";
import RooftopAnimations from "./RooftopAnimations";
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  Suspense,
  startTransition,
} from "react";
import {
  motion,
  AnimatePresence,
  useInView,
  animate,
  Variants
} from "framer-motion";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  OrbitControls,
  Stars,
  Environment,
  ContactShadows,
  Lightformer,
  Html,
  Line as DreiLine,
} from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, ReferenceLine,
} from "recharts";
import {
  Sun, Upload, Zap, TrendingUp, DollarSign, Cpu, Wind,
  BarChart3, Settings2, ChevronRight, Check, Play, RotateCcw,
  Eye, Layers, Activity, Star, Clock, Download,
  FileText, Building2, Factory, Landmark, Home,
} from "lucide-react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import RooftopUltraScene from "./RooftopAnimations";

/*
  Rooftop Demo Changelog (2026-03-11):
  - Added DEMO fallback data so this page runs independently.
  - Added SHOW_PRICING flag and hid tariff/pricing UI by default.
  - Improved upload CTA visibility plus keyboard accessibility.

  Quick start:
  - Keep this file at `app/rooftop/page.tsx`.
  - Run `npm i` then `npm run dev` from the `frontend` folder.
*/

// --- Design Tokens ----------------------------------------------------------
const T = {
  bg:          "#06090f",
  surface:     "#0c1220",
  card:        "linear-gradient(145deg,#0d1525,#0a1020)",
  border:      "rgba(255,255,255,0.07)",
  borderHi:    "rgba(255,255,255,0.13)",
  teal:        "#00d4aa",
  tealDim:     "rgba(0,212,170,0.1)",
  tealBorder:  "rgba(0,212,170,0.28)",
  green:       "#22c55e",
  greenDim:    "rgba(34,197,94,0.12)",
  purple:      "#a855f7",
  purpleDim:   "rgba(168,85,247,0.13)",
  amber:       "#f59e0b",
  amberDim:    "rgba(245,158,11,0.13)",
  blue:        "#3b82f6",
  blueDim:     "rgba(59,130,246,0.13)",
  pink:        "#ec4899",
  pinkDim:     "rgba(236,72,153,0.13)",
  text:        "#f1f5f9",
  textMid:     "#94a3b8",
  textDim:     "#475569",
};

// --- Types ------------------------------------------------------------------
interface SolarPanel {
  id:number;
  x:number;
  y:number;
  efficiency:number;
  temp:number;
  power:number;
  basePower:number;
  sunlight:number;
  incidence:number;
  shade:number;
  temperatureFactor:number;
  soilingFactor:number;
  mismatchFactor:number;
}
interface HardwareOption { id:string; brand:string; model:string; wattage:number; efficiency:number; warranty:number; price:number; tier:"economy"|"standard"|"premium"; rating:number; }
interface ScanPhase { id:string; label:string; duration:number; icon:React.ReactNode; }
interface Site { id:string; name:string; type:string; icon:React.ReactNode; }
interface EnergyPoint { month:string; production:number; consumption:number; }
interface ROIPoint { year:number; cumulative:number; }
interface MonthlyEnergyPoint { month:string; production:number; consumption:number; }
interface SolarAngles { elevation:number; azimuth:number; }
interface RoofObstacle {
  id:string;
  label:string;
  position:[number,number,number];
  size:[number,number,number];
  color:string;
}
interface StoredProjectData {
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  consumerType: string | null;
  monthlyUsage: number | null;
  roofAreaSqFt: number | null;
  budget: number | null;
  recommendedKW: number | null;
  annualSavings: number | null;
  paybackYears: number | null;
  netCost: number | null;
  lifetimeSavings: number | null;
  co2OffsetTons: number | null;
  tariffRate: number | null;
  batteryRecommended: boolean | null;
  monthlyData: MonthlyEnergyPoint[];
  annualProduction: number | null;
  annualConsumption: number | null;
}
interface RooftopMetrics {
  n:number;
  kw:number;
  kwh:number;
  sav:number;
  cost:number;
  pb:number;
  annualCo2Tons:number;
}
interface ChartTipEntry { color?:string; name?:string; value?:number|string; }
interface ChartTipProps { active?:boolean; payload?:ChartTipEntry[]; label?:string|number; }
interface CornerAccent {
  top?:number; right?:number; bottom?:number; left?:number;
  bT?:boolean; bR?:boolean; bB?:boolean; bL?:boolean;
}
interface ScenePanelRuntimeData {
  efficiency:number;
  watts:number;
  color:THREE.Color;
}
interface CameraPreset {
  position:[number,number,number];
  target:[number,number,number];
}

// --- Static Data ----------------------------------------------------------
const HARDWARE: HardwareOption[] = [
  { id:"h1", brand:"SunCore",    model:"Alpha 400",   wattage:400, efficiency:21.4, warranty:25, price:280, tier:"economy",  rating:4.1 },
  { id:"h2", brand:"LuminX",     model:"Pro 450",     wattage:450, efficiency:23.1, warranty:30, price:420, tier:"standard", rating:4.6 },
  { id:"h3", brand:"AuroraTech", model:"Quantum 500", wattage:500, efficiency:24.8, warranty:35, price:610, tier:"premium",  rating:4.9 },
];

const PHASES: ScanPhase[] = [
  { id:"ex",  label:"Frame Extraction",           duration:1800, icon:<Layers size={11}/> },
  { id:"geo", label:"Geometry Reconstruction",    duration:2200, icon:<Cpu    size={11}/> },
  { id:"sh",  label:"Shadow Mapping",             duration:1600, icon:<Sun    size={11}/> },
  { id:"sol", label:"Solar Potential Simulation", duration:2400, icon:<Zap    size={11}/> },
];

const CORNER_ACCENTS: CornerAccent[] = [
  { top:-1, left:-1, bT:true, bL:true },
  { top:-1, right:-1, bT:true, bR:true },
  { bottom:-1, left:-1, bB:true, bL:true },
  { bottom:-1, right:-1, bB:true, bR:true },
];

// ---------- DEMO / INDEPENDENT CONFIG ----------
const DEMO_MODE = true;
const SHOW_PRICING = false;

const DEMO_PROJECT: StoredProjectData = {
  city: "Demo City",
  state: "Demo State",
  latitude: 22.57,
  longitude: 88.36,
  consumerType: "Residential",
  monthlyUsage: 420,
  roofAreaSqFt: 520,
  budget: null,
  recommendedKW: 5,
  annualSavings: null,
  paybackYears: null,
  netCost: null,
  lifetimeSavings: null,
  co2OffsetTons: 2.1,
  tariffRate: null,
  batteryRecommended: null,
  monthlyData: [],
  annualProduction: null,
  annualConsumption: 420 * 12,
};

// Calibrated module-efficiency band based on Fraunhofer ISE commercial module data.
// Q4-2024 weighted c-Si module efficiency: min 18.9%, avg 22.7%, max 24.8%.
const EFFICIENCY_SCALE = {
  min: 18.9,
  mid: 22.7,
  max: 24.8,
} as const;

const DEFAULT_SITE_LATITUDE = 22.57;
const DEMO_SOLAR_START_HOUR = 11.5;
const RESIDENTIAL_DEFAULT_KW = 5;
const RESIDENTIAL_MAX_KW = 8.5;
const RESIDENTIAL_MIN_KW = 2.5;
const RESIDENTIAL_MIN_PANELS = 6;
const RESIDENTIAL_MAX_PANELS = 18;
const RESIDENTIAL_FALLBACK_MAX_PANELS = 14;
const MODULE_FOOTPRINT_SQFT = 21;
const RESIDENTIAL_USABLE_ROOF_FACTOR = 0.58;
const WIRING_LOSS_FACTOR = 0.989;
const INVERTER_LOSS_FACTOR = 0.975;
const PANEL_DEGRADATION_RATE = 0.007;
const CO2_PER_KWH_KG = 0.82;
const GROUND_ALBEDO = 0.2;
const PANEL_COLUMNS = 6;
const PANEL_X_STEP = 1.1;
const PANEL_Z_STEP = 1.65;
const PANEL_START_X = -3.3;
const PANEL_START_Z = -1.7;
const PANEL_SURFACE_Y = 0.26;
const SHADOW_ATTENUATION = 0.72;
const ROOF_OBSTACLES: RoofObstacle[] = [
  { id:"tank", label:"Water Tank", position:[2.4, 0.74, -1.45], size:[0.74, 0.98, 0.74], color:"#334155" },
  { id:"vent", label:"Vent Stack", position:[-2.55, 0.42, 1.55], size:[0.26, 0.48, 0.26], color:"#475569" },
];
const ROOF_OBSTACLE_BOXES = ROOF_OBSTACLES.map((obstacle)=>
  new THREE.Box3().setFromCenterAndSize(
    new THREE.Vector3(...obstacle.position),
    new THREE.Vector3(...obstacle.size)
  )
);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;
type AnyRecord = Record<string, unknown>;

const clamp = (v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const formatINR = (value:number)=>`₹${Math.round(value).toLocaleString("en-IN")}`;

const asRecord = (value: unknown): AnyRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as AnyRecord) : null;

const asString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase().trim();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return null;
};

const getIn = (record: AnyRecord | null, path: string[]): unknown => {
  let current: unknown = record;
  for (const key of path) {
    const obj = asRecord(current);
    if (!obj) return undefined;
    current = obj[key];
  }
  return current;
};

const parseJson = (value: string | null): AnyRecord | null => {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const parseNumeric = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseMonthlyData = (value: unknown): MonthlyEnergyPoint[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index): MonthlyEnergyPoint | null => {
      const obj = asRecord(entry);
      if (!obj) return null;
      const production = parseNumeric(obj.production);
      const consumption = parseNumeric(obj.consumption);
      if (production === null || consumption === null) return null;

      const month = asString(obj.month) ?? MONTHS[index % MONTHS.length];
      return {
        month,
        production: Math.max(0, production),
        consumption: Math.max(0, consumption),
      };
    })
    .filter((point): point is MonthlyEnergyPoint => point !== null);
};

const sumField = (points: MonthlyEnergyPoint[], field: "production" | "consumption"): number | null => {
  if (points.length === 0) return null;
  return points.reduce((sum, point) => sum + point[field], 0);
};

const loadStoredProjectData = (): StoredProjectData | null => {
  if (typeof window === "undefined") return null;

  const fsResult = parseJson(window.sessionStorage.getItem("fsResult"));
  const fsInput = parseJson(window.sessionStorage.getItem("fsInput"));
  if (!fsResult && !fsInput) return null;

  const locationResult = asRecord(getIn(fsResult, ["location"]));
  const locationInput = asRecord(getIn(fsInput, ["location"]));

  const city =
    asString(getIn(locationResult, ["city"])) ??
    asString(getIn(locationInput, ["city"])) ??
    asString(getIn(fsResult, ["city"])) ??
    asString(getIn(fsInput, ["city"])) ??
    null;

  const state =
    asString(getIn(locationResult, ["state"])) ??
    asString(getIn(locationInput, ["state"])) ??
    asString(getIn(fsResult, ["state"])) ??
    asString(getIn(fsInput, ["state"])) ??
    null;

  const latitude =
    parseNumeric(getIn(locationResult, ["latitude"])) ??
    parseNumeric(getIn(locationResult, ["lat"])) ??
    parseNumeric(getIn(locationInput, ["latitude"])) ??
    parseNumeric(getIn(locationInput, ["lat"])) ??
    parseNumeric(getIn(fsResult, ["latitude"])) ??
    parseNumeric(getIn(fsResult, ["lat"])) ??
    parseNumeric(getIn(fsInput, ["latitude"])) ??
    parseNumeric(getIn(fsInput, ["lat"])) ??
    null;

  const longitude =
    parseNumeric(getIn(locationResult, ["longitude"])) ??
    parseNumeric(getIn(locationResult, ["lng"])) ??
    parseNumeric(getIn(locationResult, ["lon"])) ??
    parseNumeric(getIn(locationInput, ["longitude"])) ??
    parseNumeric(getIn(locationInput, ["lng"])) ??
    parseNumeric(getIn(locationInput, ["lon"])) ??
    parseNumeric(getIn(fsResult, ["longitude"])) ??
    parseNumeric(getIn(fsResult, ["lng"])) ??
    parseNumeric(getIn(fsResult, ["lon"])) ??
    parseNumeric(getIn(fsInput, ["longitude"])) ??
    parseNumeric(getIn(fsInput, ["lng"])) ??
    parseNumeric(getIn(fsInput, ["lon"])) ??
    null;

  const monthlyData = parseMonthlyData(getIn(fsResult, ["monthlyData"]));
  const annualProduction = sumField(monthlyData, "production");
  const annualConsumption = sumField(monthlyData, "consumption");

  const recommendedKW =
    parseNumeric(getIn(fsResult, ["recommendedKW"])) ??
    parseNumeric(getIn(fsResult, ["recommendedKw"])) ??
    parseNumeric(getIn(fsResult, ["actualKW"])) ??
    parseNumeric(getIn(fsInput, ["recommendedKW"]));

  const annualSavings =
    parseNumeric(getIn(fsResult, ["annualSavings"])) ??
    parseNumeric(getIn(fsInput, ["annualSavings"]));

  const impliedTariffBase = annualConsumption ?? annualProduction;
  const tariffRate =
    parseNumeric(getIn(fsResult, ["tariffRate"])) ??
    parseNumeric(getIn(fsInput, ["tariffRate"])) ??
    (annualSavings !== null && impliedTariffBase !== null && impliedTariffBase > 0
      ? annualSavings / impliedTariffBase
      : null);

  const monthlyUsage =
    parseNumeric(getIn(fsResult, ["monthlyUsage"])) ??
    parseNumeric(getIn(fsInput, ["monthlyUsage"])) ??
    (annualConsumption !== null ? annualConsumption / 12 : null);

  const data: StoredProjectData = {
    city,
    state,
    latitude,
    longitude,
    consumerType:
      asString(getIn(fsResult, ["consumerType"])) ??
      asString(getIn(fsInput, ["consumerType"])) ??
      null,
    monthlyUsage,
    roofAreaSqFt:
      parseNumeric(getIn(fsResult, ["roofAreaSqFt"])) ??
      parseNumeric(getIn(fsInput, ["roofAreaSqFt"])),
    budget:
      parseNumeric(getIn(fsResult, ["budget"])) ??
      parseNumeric(getIn(fsInput, ["budget"])),
    recommendedKW,
    annualSavings,
    paybackYears:
      parseNumeric(getIn(fsResult, ["paybackYears"])) ??
      parseNumeric(getIn(fsInput, ["paybackYears"])),
    netCost:
      parseNumeric(getIn(fsResult, ["netCost"])) ??
      parseNumeric(getIn(fsInput, ["netCost"])),
    lifetimeSavings:
      parseNumeric(getIn(fsResult, ["lifetimeSavings"])) ??
      parseNumeric(getIn(fsInput, ["lifetimeSavings"])),
    co2OffsetTons:
      parseNumeric(getIn(fsResult, ["co2Offset"])) ??
      parseNumeric(getIn(fsInput, ["co2Offset"])),
    tariffRate,
    batteryRecommended:
      asBoolean(getIn(fsResult, ["batteryRecommended"])) ??
      asBoolean(getIn(fsInput, ["batteryRecommended"])),
    monthlyData,
    annualProduction,
    annualConsumption,
  };

  const hasSignal =
    data.recommendedKW !== null ||
    data.annualSavings !== null ||
    data.monthlyData.length > 0 ||
    data.city !== null ||
    data.monthlyUsage !== null;

  return hasSignal ? data : null;
};

const inferType = (project:StoredProjectData | null): string => {
  const explicit = project?.consumerType?.trim();
  if (explicit) return explicit;
  const kw = project?.recommendedKW ?? 0;
  if (kw >= 200) return "Industrial";
  if (kw >= 25) return "Commercial";
  return "Residential";
};

const siteIcon = (type:string): React.ReactNode => {
  const normalized = type.toLowerCase();
  if (normalized.includes("industrial") || normalized.includes("factory")) return <Factory size={13}/>;
  if (normalized.includes("commercial") || normalized.includes("corporate")) return <Building2 size={13}/>;
  if (normalized.includes("campus") || normalized.includes("office")) return <Landmark size={13}/>;
  return <Home size={13}/>;
};

const createSiteFromProject = (project:StoredProjectData | null): Site => {
  const type = inferType(project);
  const city = project?.city?.trim();
  const state = project?.state?.trim();
  const label = city
    ? `${city}${state ? `, ${state}` : ""} Site`
    : "Analyzed Facility";

  return {
    id: "site-live",
    name: label,
    type,
    icon: siteIcon(type),
  };
};

const isResidentialType = (type:string): boolean => type.toLowerCase().includes("residential");

const feasibleResidentialPanelCount = (
  desiredKw:number,
  wattage:number,
  roofAreaSqFt:number | null
): number => {
  const rawTarget = Math.round((desiredKw * 1000) / wattage);
  const roofMax = roofAreaSqFt && roofAreaSqFt > 0
    ? Math.floor((roofAreaSqFt * RESIDENTIAL_USABLE_ROOF_FACTOR) / MODULE_FOOTPRINT_SQFT)
    : RESIDENTIAL_FALLBACK_MAX_PANELS;
  const hardMax = Math.max(RESIDENTIAL_MIN_PANELS, Math.min(RESIDENTIAL_MAX_PANELS, roofMax));
  const hardMin = Math.min(RESIDENTIAL_MIN_PANELS, hardMax);
  return Math.round(clamp(rawTarget, hardMin, hardMax));
};

const residentialPanelTilt = (latitude:number): number =>
  clamp(Math.abs(latitude) * 0.7, 12, 20);

const panelFacingAzimuth = (latitude:number): number =>
  latitude >= 0 ? 180 : 0;

const buildEnergySeries = (
  project:StoredProjectData | null,
  annualProduction:number,
  annualConsumption:number
): EnergyPoint[] => {
  const monthly = project?.monthlyData ?? [];
  if (monthly.length > 0) {
    const baseProduction = project?.annualProduction ?? monthly.reduce((sum,row)=>sum+row.production,0);
    const baseConsumption = project?.annualConsumption ?? monthly.reduce((sum,row)=>sum+row.consumption,0);
    const prodScale = baseProduction > 0 ? annualProduction / baseProduction : 1;
    const consScale = baseConsumption > 0 ? annualConsumption / baseConsumption : 1;
    return monthly.map((row, index)=>({
      month: row.month || MONTHS[index % MONTHS.length],
      production: Math.max(0, Math.round(row.production * prodScale)),
      consumption: Math.max(0, Math.round(row.consumption * consScale)),
    }));
  }

  const productionWeights = MONTHS.map((_,i)=>1 + 0.24 * Math.sin((i / 11) * Math.PI));
  const consumptionWeights = MONTHS.map((_,i)=>1 + 0.12 * Math.cos((i / 11) * Math.PI * 2));
  const productionFactor = annualProduction / productionWeights.reduce((sum,w)=>sum+w,0);
  const consumptionFactor = annualConsumption / consumptionWeights.reduce((sum,w)=>sum+w,0);

  return MONTHS.map((month,i)=>({
    month,
    production: Math.round(productionWeights[i] * productionFactor),
    consumption: Math.round(consumptionWeights[i] * consumptionFactor),
  }));
};

const buildRoiSeries = (cost:number, annualSavings:number): ROIPoint[] => {
  let cumulative = -cost;
  return Array.from({length:25},(_,year)=>{
    if (year === 0) {
      return { year, cumulative: Math.round(cumulative) };
    }
    const escalatedSavings = annualSavings * Math.pow(1.03, year - 1) * Math.pow(0.995, year - 1);
    const omCost = cost * 0.012 * Math.pow(1.04, year - 1);
    cumulative += escalatedSavings - omCost;
    return { year, cumulative: Math.round(cumulative) };
  });
};

const buildYieldSeries = (annualProduction:number): ROIPoint[] => {
  let cumulative = 0;
  return Array.from({length:25},(_,year)=>{
    if (year === 0) {
      return { year, cumulative: 0 };
    }
    const degradedAnnual = annualProduction * Math.pow(0.995, year - 1);
    cumulative += degradedAnnual;
    return { year, cumulative: Math.round(cumulative) };
  });
};

const seeded = (n:number)=> {
  const x=Math.sin(n*12.9898+78.233)*43758.5453;
  return x-Math.floor(x);
};

const getDayOfYear = (date:Date): number => {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
};

const formatSolarTime = (hour:number): string => {
  const wholeHours = Math.floor(hour);
  const minutes = Math.round((hour - wholeHours) * 60);
  const normalizedHours = minutes === 60 ? wholeHours + 1 : wholeHours;
  const normalizedMinutes = minutes === 60 ? 0 : minutes;
  return `${normalizedHours.toString().padStart(2,"0")}:${normalizedMinutes.toString().padStart(2,"0")}`;
};

const panelWorldPosition = (index:number): THREE.Vector3 => {
  const col = index % PANEL_COLUMNS;
  const row = Math.floor(index / PANEL_COLUMNS);
  return new THREE.Vector3(
    PANEL_START_X + col * PANEL_X_STEP,
    PANEL_SURFACE_Y,
    PANEL_START_Z + row * PANEL_Z_STEP
  );
};

const panelNormalVector = (tiltDeg:number, azimuthDeg:number): THREE.Vector3 => {
  const rad = Math.PI / 180;
  const tilt = tiltDeg * rad;
  const azimuth = azimuthDeg * rad;
  const horizontal = Math.sin(tilt);

  return new THREE.Vector3(
    horizontal * Math.sin(azimuth),
    Math.cos(tilt),
    horizontal * Math.cos(azimuth)
  ).normalize();
};

const panelRotationFromOrientation = (tiltDeg:number, azimuthDeg:number): [number,number,number] => {
  const tilt = tiltDeg * (Math.PI / 180);
  const yaw = (180 - azimuthDeg) * (Math.PI / 180);
  return [-tilt, yaw, 0];
};

function solarPosition(lat:number, day:number, hour:number): SolarAngles {
  const rad = Math.PI / 180;
  const safeLat = clamp(lat, -66, 66);
  const dayAngle = (2 * Math.PI / 365) * (day - 1 + (hour - 12) / 24);
  const decl =
    (0.006918
      - 0.399912 * Math.cos(dayAngle)
      + 0.070257 * Math.sin(dayAngle)
      - 0.006758 * Math.cos(2 * dayAngle)
      + 0.000907 * Math.sin(2 * dayAngle)
      - 0.002697 * Math.cos(3 * dayAngle)
      + 0.00148 * Math.sin(3 * dayAngle)) / rad;

  const hourAngle = 15 * (hour - 12);
  const hourAngleRad = hourAngle * rad;
  const declRad = decl * rad;
  const latRad = safeLat * rad;

  const elevationRad = Math.asin(
    Math.sin(latRad) * Math.sin(declRad) +
      Math.cos(latRad) *
        Math.cos(declRad) *
        Math.cos(hourAngleRad)
  );

  const azimuthRad = Math.atan2(
    Math.sin(hourAngleRad),
    Math.cos(hourAngleRad) * Math.sin(latRad) - Math.tan(declRad) * Math.cos(latRad)
  );
  const azimuthDeg = (azimuthRad / rad + 180 + 360) % 360;

  return {
    elevation: elevationRad / rad,
    azimuth: azimuthDeg,
  };
}

const clearSkyIrradiance = (elevation:number, day:number) => {
  const sinElevation = Math.max(Math.sin(elevation * Math.PI / 180), 0);
  if (sinElevation <= 0) {
    return { ghi: 0, dni: 0, dhi: 0, poa: 0 };
  }

  const extraterrestrial = 1367 * (1 + 0.033 * Math.cos((2 * Math.PI * day) / 365));
  const airMass = 1 / (
    sinElevation + 0.50572 * Math.pow(Math.max(elevation + 6.07995, 0.1), -1.6364)
  );
  const dni = Math.max(0, extraterrestrial * Math.pow(0.7, Math.pow(airMass, 0.678)));
  const dhi = Math.max(0, 120 + 60 * (1 - sinElevation) + 15 * Math.cos((2 * Math.PI * day) / 365));
  const ghi = Math.max(0, dni * sinElevation + dhi);

  return { ghi, dni, dhi, poa: 0 };
};

const planeOfArrayIrradiance = (
  irr:{ghi:number; dni:number; dhi:number},
  incidence:number,
  tilt:number
) => {
  const tiltRad = tilt * Math.PI / 180;
  const beam = irr.dni * incidence;
  const skyDiffuse = irr.dhi * ((1 + Math.cos(tiltRad)) / 2);
  const groundReflected = irr.ghi * GROUND_ALBEDO * ((1 - Math.cos(tiltRad)) / 2);
  return Math.max(0, beam + skyDiffuse + groundReflected);
};

const sunriseSunsetSolarTime = (latitude:number, day:number) => {
  const rad = Math.PI / 180;
  const safeLat = clamp(latitude, -66, 66) * rad;
  const dayAngle = (2 * Math.PI / 365) * (day - 1);
  const decl =
    0.006918
    - 0.399912 * Math.cos(dayAngle)
    + 0.070257 * Math.sin(dayAngle)
    - 0.006758 * Math.cos(2 * dayAngle)
    + 0.000907 * Math.sin(2 * dayAngle)
    - 0.002697 * Math.cos(3 * dayAngle)
    + 0.00148 * Math.sin(3 * dayAngle);
  const omega = Math.acos(clamp(-Math.tan(safeLat) * Math.tan(decl), -1, 1));
  const dayLengthHours = (2 * omega * 180 / Math.PI) / 15;
  return {
    sunrise: 12 - dayLengthHours / 2,
    sunset: 12 + dayLengthHours / 2,
  };
};

function sunVector(elevation:number, azimuth:number): THREE.Vector3 {
  const rad = Math.PI / 180;
  const x = Math.cos(elevation * rad) * Math.sin(azimuth * rad);
  const y = Math.sin(elevation * rad);
  const z = Math.cos(elevation * rad) * Math.cos(azimuth * rad);
  return new THREE.Vector3(x, y, z).normalize();
}

const irradiance = (panelNormal:THREE.Vector3, sunDir:THREE.Vector3): number =>
  Math.max(0, panelNormal.dot(sunDir));

const genPanels = (moduleEfficiency:number,moduleWattage:number,panelCount:number): SolarPanel[] => {
  const cols = PANEL_COLUMNS;
  const efficiencyFloor = Math.max(EFFICIENCY_SCALE.min, moduleEfficiency - 0.2);
  const efficiencyCeiling = Math.min(EFFICIENCY_SCALE.max, moduleEfficiency + 0.2);

  return Array.from({length:panelCount},(_,i)=>{
    const row = Math.floor(i / cols);
    const manufacturingVar = (seeded(i + 1) - 0.5) * 0.18;

    const efficiency = Number(
      clamp(
        moduleEfficiency +
          manufacturingVar,
        efficiencyFloor,
        efficiencyCeiling
      ).toFixed(2)
    );

    const toleranceFactor = 0.985 + seeded(i + 211) * 0.025;
    const basePower = Number((moduleWattage * toleranceFactor).toFixed(1));

    return {
      id:i,
      x:(i%cols)*16.6,
      y:row*25,
      efficiency,
      temp: 25,
      power: basePower,
      basePower,
      sunlight: 0,
      incidence: 0,
      shade: 1,
      temperatureFactor: 1,
      soilingFactor: 1,
      mismatchFactor: 1,
    };
  });
};

const applySolarExposure = (
  panels:SolarPanel[],
  sunDir:THREE.Vector3,
  panelNormal:THREE.Vector3
): SolarPanel[] => {
  const baseIrradiance = irradiance(panelNormal, sunDir);
  if (baseIrradiance <= 0 || sunDir.y <= 0) {
    return panels.map(panel => ({
      ...panel,
      sunlight: 0,
      incidence: 0,
      shade: 1,
      temperatureFactor: 1,
      soilingFactor: 1,
      mismatchFactor: 1,
      power: 0,
    }));
  }

  const hitPoint = new THREE.Vector3();

  return panels.map((panel) => {
    const panelPoint = panelWorldPosition(panel.id).add(new THREE.Vector3(0, 0.03, 0));
    const ray = new THREE.Ray(panelPoint, sunDir);
    const shade = ROOF_OBSTACLE_BOXES.some((box)=>ray.intersectBox(box, hitPoint) !== null)
      ? SHADOW_ATTENUATION
      : 1;
    const sunlight = Number(clamp(baseIrradiance * shade, 0, 1).toFixed(3));
    const moduleTemp = Number((30 + sunlight * 16 + seeded(panel.id + 101) * 4).toFixed(1));
    const temperatureFactor = clamp(1 - Math.max(0, moduleTemp - 25) * 0.0034, 0.82, 1);
    const soilingFactor = 0.965 + seeded(panel.id + 301) * 0.02;
    const mismatchFactor = 0.985 + seeded(panel.id + 401) * 0.015;
    const dcPower = panel.basePower * sunlight * temperatureFactor * soilingFactor * mismatchFactor;
    const power = Number((dcPower * WIRING_LOSS_FACTOR * INVERTER_LOSS_FACTOR).toFixed(1));

    return {
      ...panel,
      temp: moduleTemp,
      shade,
      sunlight,
      incidence: Number(baseIrradiance.toFixed(3)),
      temperatureFactor: Number(temperatureFactor.toFixed(4)),
      soilingFactor: Number(soilingFactor.toFixed(4)),
      mismatchFactor: Number(mismatchFactor.toFixed(4)),
      power,
    };
  });
};

const tierAccent = (t:HardwareOption["tier"]) =>
  t==="premium"?T.amber:t==="standard"?T.teal:T.textMid;

// --- Shared card CSS -----------------------------------------------------
const cs: React.CSSProperties = {
  background:T.card,
  border:`1px solid ${T.border}`,
  borderRadius:"16px",
  backdropFilter:"blur(14px)",
  WebkitBackdropFilter:"blur(14px)",
};

// Spring config for natural feel
const SPRING = { type:"spring" as const, stiffness:280, damping:22 };

// --- Stagger container variants -------------------------------------------
const pageVariants = {
  hidden:{},
  visible:{ transition:{ staggerChildren:0.09, delayChildren:0.1 }},
};
const fadeUp: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55 }
  },
};

// --- Animated Counter -----------------------------------------------------
const Counter = React.memo(({ value, duration=1.2 }:{ value:string; duration?:number }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once:true });
  useEffect(() => {
    if (!isInView || !ref.current) return;
    const num = parseFloat(value.replace(/[^0-9.-]/g,""));
    if (isNaN(num)) { if(ref.current) ref.current.textContent = value; return; }
    const prefix = value.match(/^[^0-9-]*/)?.[0] ?? "";
    const suffix = value.match(/[^0-9.]+$/)?.[0] ?? "";
    const dec = (value.match(/\.(\d+)/)?.[1]?.length) ?? 0;
    const ctrl = animate(0, num, {
      duration,
      ease:[0.22,1,0.36,1],
      onUpdate(v){ if(ref.current) ref.current.textContent = `${prefix}${v.toFixed(dec)}${suffix}`; },
    });
    return ()=>ctrl.stop();
  },[isInView, value, duration]);
  return <span ref={ref}>{value}</span>;
});
Counter.displayName="Counter";

// --- AMBIENT BACKGROUND ---------------------------------------------------
const AmbientBackground = React.memo(() => (
  <div style={{
    position:"fixed",inset:0,pointerEvents:"none",zIndex:0,overflow:"hidden",
  }}>
    {/* Slow blue orb - top-left */}
    <motion.div
      animate={{ x:[0,60,20,0], y:[0,40,80,0], scale:[1,1.15,0.95,1] }}
      transition={{ duration:28, repeat:Infinity, ease:"easeInOut" }}
      style={{
        position:"absolute",top:"-20%",left:"-15%",
        width:"55vw",height:"55vw",borderRadius:"50%",
        background:"radial-gradient(circle,rgba(59,130,246,0.06) 0%,transparent 70%)",
        filter:"blur(60px)",
      }}
    />
    {/* Blue orb - mid-right */}
    <motion.div
      animate={{ x:[0,-40,-80,0], y:[0,60,20,0], scale:[1,0.9,1.1,1] }}
      transition={{ duration:36, repeat:Infinity, ease:"easeInOut", delay:4 }}
      style={{
        position:"absolute",top:"20%",right:"-20%",
        width:"50vw",height:"50vw",borderRadius:"50%",
        background:"radial-gradient(circle,rgba(59,130,246,0.04) 0%,transparent 70%)",
        filter:"blur(80px)",
      }}
    />
    {/* Purple orb - bottom */}
    <motion.div
      animate={{ x:[0,50,-30,0], y:[0,-30,40,0], scale:[1,1.2,0.85,1] }}
      transition={{ duration:40, repeat:Infinity, ease:"easeInOut", delay:10 }}
      style={{
        position:"absolute",bottom:"-20%",left:"20%",
        width:"60vw",height:"40vw",borderRadius:"50%",
        background:"radial-gradient(circle,rgba(168,85,247,0.035) 0%,transparent 70%)",
        filter:"blur(100px)",
      }}
    />
    {/* Amber accent - hero area */}
    <motion.div
      animate={{ opacity:[0.4,0.7,0.4], scale:[1,1.08,1] }}
      transition={{ duration:8, repeat:Infinity, ease:"easeInOut", delay:2 }}
      style={{
        position:"absolute",top:"5%",left:"30%",
        width:"300px",height:"300px",borderRadius:"50%",
        background:"radial-gradient(circle,rgba(245,158,11,0.03) 0%,transparent 70%)",
        filter:"blur(40px)",
      }}
    />
    {/* Noise texture grain */}
    <div style={{
      position:"absolute",inset:0,
      backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`,
      opacity:0.35,
    }}/>
  </div>
));
AmbientBackground.displayName="AmbientBackground";

// --- DIVIDER --------------------------------------------------------------
const Divider = () => (
  <div style={{height:"1px",background:`linear-gradient(90deg,transparent,${T.border},transparent)`,margin:"0"}}/>
);

// --- KPI CARD -------------------------------------------------------------
const KPICard = React.memo(({label,value,sub,icon,iconColor,iconBg,topAccent}:{
  label:string;value:string;sub?:string;icon:React.ReactNode;
  iconColor:string;iconBg:string;topAccent?:string;
})=>{
  const [hov,setHov]=useState(false);
  const glowColor = iconColor;
  return (
    <motion.div
      variants={fadeUp}
      onHoverStart={()=>setHov(true)} onHoverEnd={()=>setHov(false)}
      whileHover={{ y:-5, scale:1.02, transition:SPRING }}
      style={{
        ...cs,
        overflow:"hidden",position:"relative",padding:"18px 16px",
        border:`1px solid ${hov ? iconColor+"30" : T.border}`,
        boxShadow: hov
          ? `0 0 0 1px ${glowColor}20, 0 8px 32px -8px ${glowColor}40, 0 0 60px -20px ${glowColor}25`
          : "0 2px 12px rgba(0,0,0,0.3)",
        transition:"border-color 0.3s, box-shadow 0.4s",
      }}
    >
      {/* Noise overlay for depth */}
      <div style={{position:"absolute",inset:0,
        backgroundImage:`url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E")`,
        pointerEvents:"none",opacity:0.5,zIndex:0,
      }}/>

      {topAccent&&(
        <div style={{position:"absolute",top:0,left:0,right:0,height:"2px",
          background:topAccent,borderRadius:"16px 16px 0 0"}}/>
      )}

      {/* Hover radial glow from top */}
      <AnimatePresence>
        {hov&&(
          <motion.div
            initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            transition={{duration:0.3}}
            style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:0,
              background:`radial-gradient(ellipse 80% 60% at 50% 0%,${glowColor}10,transparent 70%)`,
            }}
          />
        )}
      </AnimatePresence>

      <div style={{position:"relative",zIndex:1}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"16px"}}>
          <p style={{fontSize:"12px",color:T.textMid,fontWeight:500,lineHeight:1.3}}>{label}</p>
          <motion.div
            whileHover={{rotate:8,scale:1.1}} transition={SPRING}
            style={{width:36,height:36,borderRadius:"10px",background:iconBg,flexShrink:0,
              display:"flex",alignItems:"center",justifyContent:"center",color:iconColor,
              boxShadow:hov?`0 0 16px ${iconColor}35`:"none",
              transition:"box-shadow 0.3s",
            }}
          >
            {icon}
          </motion.div>
        </div>
        <p style={{fontSize:"26px",fontWeight:800,color:T.text,letterSpacing:"-0.03em",lineHeight:1}}>
          <Counter value={value}/>
        </p>
        {sub&&<p style={{fontSize:"10px",color:T.textDim,marginTop:"5px"}}>{sub}</p>}
      </div>

      {/* Bottom glow line on hover */}
      <motion.div
        animate={{width: hov ? "100%" : "0%", opacity: hov ? 1 : 0}}
        transition={{duration:0.4, ease:"easeOut"}}
        style={{position:"absolute",bottom:0,left:0,height:"1px",
          background:`linear-gradient(90deg,transparent,${glowColor},transparent)`,
        }}
      />
    </motion.div>
  );
});
KPICard.displayName="KPICard";

// --- SITE CARD ------------------------------------------------------------

// --- PHASE LIST ----------------------------------------------------------
const PhaseList = React.memo(({cur,prog}:{cur:number;prog:number})=>(
  <div style={{display:"flex",flexDirection:"column",gap:"5px",marginTop:"14px"}}>
    {PHASES.map((ph,i)=>{
      const done=i<cur,active=i===cur;
      return (
        <motion.div key={ph.id}
          initial={{opacity:0,x:-10}} animate={{opacity:1,x:0}} transition={{delay:i*0.07}}
          style={{display:"flex",alignItems:"center",gap:"8px",padding:"7px 10px",borderRadius:"8px",
            background:active?"rgba(0,212,170,0.07)":done?"rgba(34,197,94,0.05)":"transparent",
            border:`1px solid ${active?T.tealBorder:done?"rgba(34,197,94,0.18)":"transparent"}`,
            boxShadow:active?`0 0 12px rgba(0,212,170,0.1)`:"none",
          }}
        >
          <div style={{width:18,height:18,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",
            background:done?"rgba(34,197,94,0.15)":active?"rgba(0,212,170,0.15)":"rgba(255,255,255,0.04)",
            border:`1px solid ${done?"rgba(34,197,94,0.4)":active?T.tealBorder:"rgba(255,255,255,0.09)"}`,
            color:done?T.green:active?T.teal:T.textDim,
            boxShadow:active?`0 0 8px rgba(0,212,170,0.3)`:done?`0 0 8px rgba(34,197,94,0.2)`:"none",
          }}>
            {done?<Check size={9}/>:active?(
              <motion.div animate={{rotate:360}} transition={{duration:1,repeat:Infinity,ease:"linear"}}>{ph.icon}</motion.div>
            ):ph.icon}
          </div>
          <span style={{fontSize:"11px",fontWeight:500,flex:1,color:done?T.green:active?T.teal:T.textDim}}>{ph.label}</span>
          {active&&<span style={{fontSize:"10px",fontFamily:"monospace",color:T.teal}}>{Math.round(prog)}%</span>}
          {done&&<motion.span initial={{scale:0}} animate={{scale:1}} transition={SPRING} style={{fontSize:"10px",color:T.green}}>✓</motion.span>}
        </motion.div>
      );
    })}
  </div>
));
PhaseList.displayName="PhaseList";

// --- STATUS BANNER --------------------------------------------------------
const StatusBanner = React.memo(({done,running,etaSeconds}:{done:boolean;running:boolean;etaSeconds:number})=>{
  return (
    <motion.div variants={fadeUp}
      style={{...cs,padding:"16px 22px",display:"flex",alignItems:"center",gap:"14px",flexWrap:"wrap",
        boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{position:"relative",flexShrink:0}}>
        {running&&(
          <motion.div
            animate={{scale:[1,1.6,1],opacity:[0.5,0,0.5]}}
            transition={{duration:2,repeat:Infinity,ease:"easeOut"}}
            style={{position:"absolute",inset:-6,borderRadius:"18px",
              background:"rgba(0,212,170,0.12)",border:`1px solid ${T.tealBorder}`,
            }}
          />
        )}
        <div style={{width:40,height:40,borderRadius:"12px",background:T.tealDim,border:`1px solid ${T.tealBorder}`,
          display:"flex",alignItems:"center",justifyContent:"center",color:T.teal,
          boxShadow:`0 0 ${running?"20":"8"}px rgba(0,212,170,${running?"0.3":"0.12"})`,
          transition:"box-shadow 0.4s",
        }}>
          <motion.div animate={{scale:[1,1.18,1]}} transition={{duration:2.5,repeat:Infinity,ease:"easeInOut"}}>
            <Activity size={16}/>
          </motion.div>
        </div>
      </div>

      <div style={{flex:1,minWidth:"180px"}}>
        <p style={{fontSize:"14px",fontWeight:700,color:T.text}}>
          {done?"Analysis Complete":running?"Analysis Running...":"System Ready"}
        </p>
        <p style={{fontSize:"11px",color:T.textMid,marginTop:"2px"}}>
          {done
            ? "All core metrics computed. Roof suitability confirmed."
            : running
              ? `Processing geometry and irradiance... ETA ${etaSeconds}s`
              : "Upload rooftop footage to initialize spatial mapping."}
        </p>
      </div>
    </motion.div>
  );
});
StatusBanner.displayName="StatusBanner";

// --- CHART TOOLTIP --------------------------------------------------------
const ChartTip = React.memo(({active,payload,label}:ChartTipProps)=>{
  if(!active||!payload?.length)return null;
  return (
    <motion.div
      initial={{opacity:0,scale:0.92,y:4}} animate={{opacity:1,scale:1,y:0}}
      transition={{duration:0.15}}
      style={{background:"rgba(10,16,32,0.95)",backdropFilter:"blur(20px)",
        border:`1px solid ${T.tealBorder}`,borderRadius:"10px",padding:"10px 13px",fontSize:"11px",
        boxShadow:`0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,212,170,0.1)`,
      }}
    >
      <p style={{color:T.teal,fontWeight:700,marginBottom:"5px"}}>{label}</p>
      {payload.map((e,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"2px"}}>
          <motion.div animate={{scale:[1,1.3,1]}} transition={{duration:1.5,repeat:Infinity}}
            style={{width:6,height:6,borderRadius:"50%",background:e.color,
              boxShadow:`0 0 6px ${e.color}`,
            }}/>
          <span style={{color:T.textMid}}>{e.name}:</span>
          <span style={{color:T.text,fontWeight:600}}>{e.value}</span>
        </div>
      ))}
    </motion.div>
  );
});
ChartTip.displayName="ChartTip";

const ROITooltip = React.memo(({active,payload,label,showPricing=true}:ChartTipProps & {showPricing?:boolean})=>{
  if(!active||!payload?.length)return null;
  const rawValue=payload[0]?.value;
  const value=typeof rawValue==="number"?rawValue:Number(rawValue??0);
  return (
    <motion.div initial={{opacity:0,y:4}} animate={{opacity:1,y:0}}
      style={{background:"rgba(10,16,32,0.95)",backdropFilter:"blur(20px)",
        border:`1px solid ${T.tealBorder}`,borderRadius:"9px",padding:"9px 12px",fontSize:"11px",
        boxShadow:`0 8px 32px rgba(0,0,0,0.5)`,
      }}>
      <p style={{color:T.teal,fontWeight:700,marginBottom:"4px"}}>Year {label}</p>
      <p style={{color:T.text}}>
        {showPricing ? "Cumulative Value:" : "Cumulative Yield:"}
        {" "}
        <span style={{color:value>=0?T.teal:"#ef4444",fontWeight:700}}>
          {showPricing ? formatINR(value) : `${Math.round(value).toLocaleString("en-IN")} kWh`}
        </span>
      </p>
    </motion.div>
  );
});
ROITooltip.displayName="ROITooltip";

// --- HARDWARE CARD --------------------------------------------------------
const HWCard = React.memo(({opt,sel,onSel}:{opt:HardwareOption;sel:boolean;onSel:()=>void})=>{
  const ac=tierAccent(opt.tier);
  const [hov,setHov]=useState(false);
  return (
    <motion.div onClick={onSel}
      onHoverStart={()=>setHov(true)} onHoverEnd={()=>setHov(false)}
      whileHover={{y:-4, transition:SPRING}}
      whileTap={{scale:0.97}}
      style={{padding:"16px",borderRadius:"12px",cursor:"pointer",position:"relative",overflow:"hidden",
        background:sel?`linear-gradient(145deg,${ac}10,#0a1020)`:"linear-gradient(145deg,#0d1525,#0a1020)",
        border:`1px solid ${sel?ac+"55":(hov?ac+"25":T.border)}`,
        backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",
        boxShadow:sel?`0 0 0 1px ${ac}20, 0 8px 32px -8px ${ac}30`
          :hov?`0 0 0 1px ${ac}15, 0 8px 24px -8px rgba(0,0,0,0.4)`
          :"0 2px 12px rgba(0,0,0,0.3)",
        transition:"border-color 0.3s,box-shadow 0.35s",
      }}
    >
      {sel&&(
        <motion.div
          initial={{scaleX:0}} animate={{scaleX:1}} transition={{duration:0.35,ease:[0.22,1,0.36,1]}}
          style={{position:"absolute",top:0,left:0,right:0,height:"2px",background:ac,
            transformOrigin:"left",
            boxShadow:`0 0 8px ${ac}`,
          }}
        />
      )}
      {/* Hover shimmer */}
      <AnimatePresence>
        {hov&&(
          <motion.div
            initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
            style={{position:"absolute",inset:0,pointerEvents:"none",
              background:`radial-gradient(ellipse 80% 50% at 50% 0%,${ac}08,transparent 70%)`,
            }}
          />
        )}
      </AnimatePresence>

      <div style={{position:"relative",zIndex:1}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"12px"}}>
          <div>
            <span style={{fontSize:"9px",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",
              padding:"2px 7px",borderRadius:"20px",background:`${ac}15`,color:ac,border:`1px solid ${ac}28`}}>
              {opt.tier}
            </span>
            <p style={{fontSize:"14px",fontWeight:800,color:T.text,marginTop:"6px"}}>{opt.brand}</p>
            <p style={{fontSize:"11px",color:T.textMid}}>{opt.model}</p>
          </div>
          <div style={{textAlign:"right"}}>
            {SHOW_PRICING ? (
              <>
                <p style={{fontSize:"18px",fontWeight:800,color:T.text}}>₹{Math.round(opt.price * 100).toLocaleString("en-IN")}</p>
                <p style={{fontSize:"9px",color:T.textDim}}>per panel</p>
              </>
            ) : (
              <>
                <p style={{fontSize:"12px",fontWeight:700,color:T.text}}>Specs Only</p>
                <p style={{fontSize:"9px",color:T.textDim}}>Pricing hidden</p>
              </>
            )}
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"6px",marginBottom:"10px"}}>
          {[{l:"Power",v:`${opt.wattage}W`},{l:"Eff.",v:`${opt.efficiency}%`},{l:"Warranty",v:`${opt.warranty}yr`}].map(s=>(
            <div key={s.l} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`,
              borderRadius:"7px",padding:"7px 5px",textAlign:"center"}}>
              <p style={{fontSize:"9px",color:T.textDim,marginBottom:"2px",textTransform:"uppercase",letterSpacing:"0.07em"}}>{s.l}</p>
              <p style={{fontSize:"12px",fontWeight:700,color:T.text}}>{s.v}</p>
            </div>
          ))}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",gap:"2px"}}>
            {Array.from({length:5},(_,i)=>(
              <motion.div key={i} whileHover={{scale:1.3,rotate:12}} transition={SPRING}>
                <Star size={9} style={{fill:i<Math.floor(opt.rating)?T.amber:"none",color:i<Math.floor(opt.rating)?T.amber:T.textDim}}/>
              </motion.div>
            ))}
            <span style={{fontSize:"9px",color:T.textMid,marginLeft:"3px"}}>{opt.rating}</span>
          </div>
          <AnimatePresence>
            {sel&&(
              <motion.div initial={{opacity:0,scale:0.7,x:10}} animate={{opacity:1,scale:1,x:0}} exit={{opacity:0,scale:0.7}}
                transition={SPRING}
                style={{display:"flex",alignItems:"center",gap:"3px",fontSize:"9px",fontWeight:700,
                  padding:"2px 8px",borderRadius:"20px",background:`${ac}18`,color:ac,border:`1px solid ${ac}35`,
                  boxShadow:`0 0 8px ${ac}30`,
                }}>
                <Check size={9}/>Selected
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
});
HWCard.displayName="HWCard";

// --- 3D SCENE -------------------------------------------------------------
function SunBeam({elevation,azimuth}:{elevation:number;azimuth:number}) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();

  useEffect(() => {
    if (!light.current) return;
    const target = light.current.target;
    scene.add(target);
    return () => {
      scene.remove(target);
    };
  }, [scene]);

  useFrame(() => {
    if (!light.current) return;
    const dir = sunVector(elevation, azimuth);
    const dist = 18;
    const elevationFactor = Math.max(0, Math.sin((elevation * Math.PI) / 180));
    light.current.position.set(
      dir.x * dist,
      Math.max(1.6, dir.y * dist),
      dir.z * dist
    );
    light.current.target.position.set(0, 0, 0);
    light.current.target.updateMatrixWorld();
    light.current.intensity = 0.55 + elevationFactor * 2.4;

    const warm = 1 - elevationFactor;
    light.current.color.setRGB(1, 0.92 - warm * 0.12, 0.78 - warm * 0.24);

    if (light.current.shadow && light.current.shadow.camera) {
      const cam = light.current.shadow.camera as THREE.OrthographicCamera;
      const range = 8.5;
      cam.left = -range;
      cam.right = range;
      cam.top = range;
      cam.bottom = -range;
      cam.near = 0.5;
      cam.far = 48;
      cam.updateProjectionMatrix();

      light.current.shadow.mapSize.set(SCENE_PERF_MODE ? 1024 : 2048, SCENE_PERF_MODE ? 1024 : 2048);
      light.current.shadow.bias = -0.0004;
      light.current.shadow.normalBias = 0.02;
      light.current.shadow.radius = 4;
    }
  });

  return <directionalLight ref={light} castShadow />;
}

// Atmospheric haze / ground fog plane
function AtmoHaze({sunlight}:{sunlight:number}){
  const m=useRef<THREE.Mesh>(null);
  useFrame(({clock})=>{
    if(m.current&&m.current.material){
      (m.current.material as THREE.MeshBasicMaterial).opacity=
        0.015 + sunlight * 0.035 + Math.sin(clock.getElapsedTime()*0.18)*0.006;
    }
  });
  return (
    <mesh ref={m} position={[0,-0.05,0]} rotation={[-Math.PI/2,0,0]}>
      <planeGeometry args={[24,18]}/>
      <meshBasicMaterial color="#ffd98f" transparent opacity={0.04} side={THREE.DoubleSide}/>
    </mesh>
  );
}

function SunGlow({elevation,azimuth}:{elevation:number;azimuth:number}){
  const disk = useRef<THREE.Mesh>(null);
  const corona = useRef<THREE.Mesh>(null);
  const shafts = useRef<THREE.Mesh>(null);

  const coronaMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: "#ffe87a",
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }), []);

  const shaftMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: "#ffd060",
    transparent: true,
    opacity: 0.08,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }), []);

  useEffect(() => () => {
    coronaMaterial.dispose();
    shaftMaterial.dispose();
  }, [coronaMaterial, shaftMaterial]);

  useFrame(({clock})=>{
    const dir = sunVector(elevation, azimuth);
    const position = new THREE.Vector3(dir.x * 16, Math.max(1.5, dir.y * 16), dir.z * 16);

    disk.current?.position.copy(position);
    corona.current?.position.copy(position);
    shafts.current?.position.copy(position);

    if (corona.current) {
      const pulse = 1 + Math.sin(clock.getElapsedTime() * 0.5) * 0.05;
      corona.current.scale.setScalar(pulse);
      (corona.current.material as THREE.MeshBasicMaterial).opacity =
        0.11 + Math.sin(clock.getElapsedTime() * 0.7) * 0.025;
    }

    shafts.current?.lookAt(0, 0, 0);
  });

  return (
    <group>
      <mesh ref={disk}>
        <sphereGeometry args={[0.5,24,24]}/>
        <meshBasicMaterial color="#fffacc"/>
      </mesh>
      <mesh ref={corona}>
        <sphereGeometry args={[1.6,20,20]}/>
        <primitive object={coronaMaterial}/>
      </mesh>
      <mesh ref={shafts}>
        <coneGeometry args={[0.42,9.6,6,1,true]}/>
        <primitive object={shaftMaterial}/>
      </mesh>
    </group>
  );
}

function SunRays({elevation,azimuth}:{elevation:number;azimuth:number}){
  const group = useRef<THREE.Group>(null);

  useFrame(()=>{
    if (!group.current) return;
    const dir = sunVector(elevation, azimuth);
    const lookTarget = dir.clone().multiplyScalar(12);
    group.current.position.set(dir.x * 7, Math.max(1.8, dir.y * 7), dir.z * 7);
    group.current.lookAt(lookTarget);
  });

  return (
    <group ref={group}>
      {[0,1,2].map((i)=>(
        <mesh key={i} position={[(i - 1) * 0.55, 0, 0]} rotation={[Math.PI / 2,0,0]}>
          <cylinderGeometry args={[0.05,0.3,8,8,1,true]}/>
          <meshBasicMaterial color="#ffeaa7" transparent opacity={0.08} side={THREE.DoubleSide}/>
        </mesh>
      ))}
    </group>
  );
}

const MODULE_MODEL = {
  frameWidth: 0.96,
  frameDepth: 1.34,
  frameHeight: 0.055,
  backsheetWidth: 0.89,
  backsheetDepth: 1.27,
  backsheetHeight: 0.02,
  cellWidth: 0.84,
  cellDepth: 1.2,
  cellHeight: 0.014,
  glassWidth: 0.86,
  glassDepth: 1.22,
  glassHeight: 0.01,
  railWidth: 0.9,
  railDepth: 0.05,
  railHeight: 0.016,
  railOffset: 0.34,
  cellColumns: 6,
  cellRows: 12,
} as const;
const SCENE_PERF_MODE = false;
const BASE_PANEL_EFFICIENCY = 0.22;
const CONTACT_SHADOW_Y = 0.142;
const CAMERA_PRESETS: Record<string, CameraPreset> = {
  overview: { position:[0, 6.5, 9.5], target:[0, 0.2, 0] },
  closeup: { position:[2.3, 3.1, 5.1], target:[0.4, 0.45, -0.2] },
  sunpath: { position:[-7.8, 6.8, 7.6], target:[0, 1.6, 0] },
};

const efficiencyColor = (efficiency:number): THREE.Color => {
  const t = clamp(efficiency / BASE_PANEL_EFFICIENCY, 0, 1);
  const colors = [
    new THREE.Color("#0b1e47"),
    new THREE.Color("#0077ff"),
    new THREE.Color("#00c8ff"),
    new THREE.Color("#00ff88"),
    new THREE.Color("#ffdd00"),
    new THREE.Color("#ff8800"),
    new THREE.Color("#ff2200"),
  ];
  const seg = (colors.length - 1) * t;
  const index = Math.floor(seg);
  const frac = seg - index;
  return colors[Math.min(index, colors.length - 1)]
    .clone()
    .lerp(colors[Math.min(index + 1, colors.length - 1)], frac);
};

const sunPathPoints = (azimuthCenter:number, count=48): THREE.Vector3[] => {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    const elevation = Math.sin(t * Math.PI) * 65;
    const azimuth = azimuthCenter - 90 + t * 180;
    points.push(sunVector(elevation, azimuth).multiplyScalar(11.5));
  }
  return points;
};

const panelRuntimeData = (panel:SolarPanel): ScenePanelRuntimeData => {
  const normalizedOutput = panel.basePower > 0
    ? clamp(panel.power / panel.basePower, 0, 1)
    : clamp(panel.sunlight, 0, 1);
  const efficiency = BASE_PANEL_EFFICIENCY * normalizedOutput;
  return {
    efficiency,
    watts: Math.max(0, panel.power),
    color: efficiencyColor(efficiency),
  };
};

const SolarModule = React.memo(({
  panel,
  panelTilt,
  panelAzimuth,
  runtime,
  showHeatmap,
}:{
  panel: SolarPanel;
  panelTilt: number;
  panelAzimuth: number;
  runtime: ScenePanelRuntimeData;
  showHeatmap: boolean;
})=>{
  const position = panelWorldPosition(panel.id);
  const rotation = panelRotationFromOrientation(panelTilt, panelAzimuth);
  const effNorm = clamp(
    (panel.efficiency - EFFICIENCY_SCALE.min) / (EFFICIENCY_SCALE.max - EFFICIENCY_SCALE.min),
    0,
    1
  );
  const sunlightMix = clamp(panel.sunlight * (0.9 + panel.shade * 0.1), 0, 1);
  const frameColor = new THREE.Color("#c7d0d8").lerp(new THREE.Color("#7b8794"), 1 - sunlightMix * 0.7);
  const defaultCellColor = new THREE.Color("#04070d").lerp(
    new THREE.Color("#123453"),
    0.18 + sunlightMix * 0.18 + effNorm * 0.08
  );
  const heatColor = runtime.color.clone();
  const cellColor = showHeatmap
    ? heatColor.clone().lerp(new THREE.Color("#07111e"), 0.42)
    : defaultCellColor;
  const glassColor = showHeatmap
    ? heatColor.clone().lerp(new THREE.Color("#06101d"), 0.78)
    : new THREE.Color("#08131f").lerp(
        new THREE.Color("#1b4f7b"),
        0.12 + sunlightMix * 0.12
      );
  const seamColor = new THREE.Color("#8ba6be").lerp(new THREE.Color("#d7e7f5"), sunlightMix * 0.35);
  const railColor = new THREE.Color("#4b5563").lerp(new THREE.Color("#94a3b8"), sunlightMix * 0.2);
  const cellColumnStep = MODULE_MODEL.cellWidth / MODULE_MODEL.cellColumns;
  const cellRowStep = MODULE_MODEL.cellDepth / MODULE_MODEL.cellRows;

  return (
    <group position={[position.x,0.22,position.z]} rotation={rotation}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[MODULE_MODEL.frameWidth, MODULE_MODEL.frameHeight, MODULE_MODEL.frameDepth]}/>
        <meshStandardMaterial color={frameColor} roughness={0.34} metalness={0.88}/>
      </mesh>

      <mesh position={[0,-0.007,0]} castShadow receiveShadow>
        <boxGeometry args={[MODULE_MODEL.backsheetWidth, MODULE_MODEL.backsheetHeight, MODULE_MODEL.backsheetDepth]}/>
        <meshStandardMaterial color="#111827" roughness={0.72} metalness={0.16}/>
      </mesh>

      <mesh position={[0,0.006,0]} castShadow receiveShadow>
        <boxGeometry args={[MODULE_MODEL.cellWidth, MODULE_MODEL.cellHeight, MODULE_MODEL.cellDepth]}/>
        <meshStandardMaterial
          color={cellColor}
          emissive={cellColor}
          emissiveIntensity={showHeatmap ? 0.03 + sunlightMix * 0.08 : 0.015 + sunlightMix * 0.04}
          roughness={0.22}
          metalness={0.42}
        />
      </mesh>

      <mesh position={[0,0.018,0]} receiveShadow>
        <boxGeometry args={[MODULE_MODEL.glassWidth, MODULE_MODEL.glassHeight, MODULE_MODEL.glassDepth]}/>
        <meshPhysicalMaterial
          color={glassColor}
          roughness={0.08}
          metalness={0.04}
          clearcoat={1}
          clearcoatRoughness={0.06}
          reflectivity={0.7}
          transparent
          opacity={0.96}
        />
      </mesh>

      {Array.from({length: MODULE_MODEL.cellColumns - 1}, (_, index) => {
        const x = -MODULE_MODEL.cellWidth / 2 + cellColumnStep * (index + 1);
        return (
          <mesh key={`col-${index}`} position={[x,0.021,0]} receiveShadow>
            <boxGeometry args={[0.008,0.002,MODULE_MODEL.cellDepth - 0.03]}/>
            <meshStandardMaterial color={seamColor} roughness={0.28} metalness={0.45}/>
          </mesh>
        );
      })}

      {Array.from({length: MODULE_MODEL.cellRows - 1}, (_, index) => {
        const z = -MODULE_MODEL.cellDepth / 2 + cellRowStep * (index + 1);
        return (
          <mesh key={`row-${index}`} position={[0,0.021,z]} receiveShadow>
            <boxGeometry args={[MODULE_MODEL.cellWidth - 0.03,0.002,0.008]}/>
            <meshStandardMaterial color={seamColor} roughness={0.28} metalness={0.45}/>
          </mesh>
        );
      })}

      {[-1, 1].map((direction)=>(
        <mesh key={`rail-${direction}`} position={[0,-0.035,direction * MODULE_MODEL.railOffset]} castShadow receiveShadow>
          <boxGeometry args={[MODULE_MODEL.railWidth, MODULE_MODEL.railHeight, MODULE_MODEL.railDepth]}/>
          <meshStandardMaterial color={railColor} roughness={0.48} metalness={0.78}/>
        </mesh>
      ))}
    </group>
  );
});
SolarModule.displayName = "SolarModule";

const RoofContext = React.memo(() => {
  const buildMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#1b2435",
    roughness: 0.82,
    metalness: 0.08,
  }), []);
  const treeMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#17351e",
    roughness: 0.98,
    metalness: 0,
  }), []);
  const groundMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: "#101821",
    roughness: 0.96,
    metalness: 0,
  }), []);

  const buildings = useMemo(() => [
    { x:-14, z:-8, w:5, h:6, d:5 },
    { x:14, z:-6, w:4, h:8, d:4 },
    { x:-12, z:10, w:6, h:4, d:6 },
    { x:10, z:12, w:5, h:5, d:5 },
    { x:0, z:-14, w:7, h:3, d:5 },
  ], []);
  const trees = useMemo(() => [
    { x:-7, z:8 }, { x:7, z:-8 }, { x:-9, z:-5 },
    { x:9, z:6 }, { x:5, z:10 }, { x:-5, z:-10 },
  ], []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2,0,0]} position={[0,-0.32,0]} receiveShadow>
        <planeGeometry args={[80,80]}/>
        <primitive object={groundMaterial}/>
      </mesh>
      {buildings.map((building, index)=>(
        <mesh
          key={`building-${index}`}
          position={[building.x, building.h / 2 - 0.32, building.z]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[building.w, building.h, building.d]}/>
          <primitive object={buildMaterial}/>
        </mesh>
      ))}
      {trees.map((tree, index)=>(
        <group key={`tree-${index}`} position={[tree.x, -0.32, tree.z]}>
          <mesh position={[0,0.52,0]} castShadow>
            <cylinderGeometry args={[0.12,0.18,1.04,6]}/>
            <meshStandardMaterial color="#3d2b1a" roughness={1}/>
          </mesh>
          <mesh position={[0,2.15,0]} castShadow>
            <coneGeometry args={[0.72,2.8,7]}/>
            <primitive object={treeMaterial}/>
          </mesh>
        </group>
      ))}
    </group>
  );
});
RoofContext.displayName = "RoofContext";

const PanelPowerLabel = React.memo(({panel,runtime}:{panel:SolarPanel; runtime:ScenePanelRuntimeData}) => {
  const position = panelWorldPosition(panel.id);
  return (
    <Html position={[position.x, 0.82, position.z]} center distanceFactor={8} occlude>
      <div style={{
        background:"rgba(0,0,0,0.72)",
        border:"1px solid rgba(255,200,50,0.4)",
        borderRadius:"5px",
        padding:"2px 6px",
        color:"#ffd84a",
        fontFamily:"monospace",
        fontSize:"11px",
        whiteSpace:"nowrap",
        pointerEvents:"none",
      }}>
        {runtime.watts.toFixed(0)}W
      </div>
    </Html>
  );
});
PanelPowerLabel.displayName = "PanelPowerLabel";

function PanelHighlight({
  panel,
  runtime,
  panelTilt,
  panelAzimuth,
  onClose,
}:{
  panel: SolarPanel | null;
  runtime: ScenePanelRuntimeData | null;
  panelTilt: number;
  panelAzimuth: number;
  onClose: ()=>void;
}) {
  if (!panel || !runtime) return null;
  const position = panelWorldPosition(panel.id);
  const rotation = panelRotationFromOrientation(panelTilt, panelAzimuth);

  return (
    <>
      <mesh position={[position.x,0.22,position.z]} rotation={rotation}>
        <boxGeometry args={[1.02,0.08,1.42]}/>
        <meshBasicMaterial color="#00ffaa" wireframe/>
      </mesh>
      <Html position={[position.x, 1.55, position.z]} center>
        <div
          style={{
            background:"rgba(5,12,30,0.95)",
            border:"1px solid #00ffaa",
            borderRadius:"10px",
            padding:"10px 16px",
            color:"#e0ffe0",
            fontFamily:"monospace",
            fontSize:"13px",
            minWidth:"148px",
            boxShadow:"0 0 20px rgba(0,255,150,0.25)",
            cursor:"pointer",
          }}
          onClick={onClose}
        >
          <div style={{color:"#00ffaa", fontWeight:700, marginBottom:"4px"}}>Panel #{panel.id}</div>
          <div>Eff: {(runtime.efficiency * 100).toFixed(1)}%</div>
          <div>Power: {runtime.watts.toFixed(1)} W</div>
          <div style={{fontSize:"10px", color:"#7c8ba1", marginTop:"4px"}}>click to dismiss</div>
        </div>
      </Html>
    </>
  );
}

function SunPathArc({
  azimuth,
  currentElevation,
  visible,
}:{
  azimuth:number;
  currentElevation:number;
  visible:boolean;
}) {
  const points = useMemo(() => sunPathPoints(azimuth, 80), [azimuth]);
  const marker = useMemo(
    () => sunVector(currentElevation, azimuth).multiplyScalar(11.5),
    [azimuth, currentElevation]
  );

  if (!visible) return null;

  return (
    <group>
      <DreiLine points={points} color="#ffd060" lineWidth={1.2} transparent opacity={0.35}/>
      <mesh position={[marker.x, marker.y, marker.z]}>
        <sphereGeometry args={[0.16,12,12]}/>
        <meshBasicMaterial color="#ffd060"/>
      </mesh>
      {[0.05, 0.5, 0.95].map((t, index)=>{
        const elevation = Math.sin(t * Math.PI) * 65;
        const markerAzimuth = azimuth - 90 + t * 180;
        const tick = sunVector(elevation, markerAzimuth).multiplyScalar(11.5);
        return (
          <mesh key={`sun-tick-${index}`} position={[tick.x, tick.y, tick.z]}>
            <sphereGeometry args={[0.08,8,8]}/>
            <meshBasicMaterial color="#ffaa30" transparent opacity={0.7}/>
          </mesh>
        );
      })}
    </group>
  );
}

function CameraRig({
  controlsRef,
  preset,
}:{
  controlsRef: React.RefObject<any>;
  preset: CameraPreset | null;
}) {
  const { camera } = useThree();
  const targetPosition = useRef(new THREE.Vector3(...CAMERA_PRESETS.overview.position));
  const targetLook = useRef(new THREE.Vector3(...CAMERA_PRESETS.overview.target));

  useEffect(() => {
    if (!preset) return;
    targetPosition.current.set(...preset.position);
    targetLook.current.set(...preset.target);
  }, [preset]);

  useFrame((_, delta) => {
    if (!preset) return;
    const damping = 1 - Math.pow(0.02, delta * 60);
    camera.position.lerp(targetPosition.current, damping);
    if (controlsRef.current) {
      controlsRef.current.target.lerp(targetLook.current, damping);
      controlsRef.current.update();
    } else {
      camera.lookAt(targetLook.current);
    }
  });

  return null;
}

function ScenePostFX({elevation}:{elevation:number}) {
  if (SCENE_PERF_MODE) return null;
  return (
    <EffectComposer multisampling={0}>
      <Bloom
        intensity={0.15 + Math.max(0, elevation / 90) * 0.18}
        luminanceThreshold={0.78}
        luminanceSmoothing={0.45}
        mipmapBlur
      />
      <Vignette offset={0.2} darkness={0.62} eskil={false}/>
    </EffectComposer>
  );
}

const SceneOverlay = React.memo(({
  totalKw,
  activePreset,
  showHeatmap,
  showLabels,
  showSunPath,
  onPreset,
  onToggleHeatmap,
  onToggleLabels,
  onToggleSunPath,
}:{
  totalKw:number;
  activePreset:string | null;
  showHeatmap:boolean;
  showLabels:boolean;
  showSunPath:boolean;
  onPreset:(preset:string)=>void;
  onToggleHeatmap:()=>void;
  onToggleLabels:()=>void;
  onToggleSunPath:()=>void;
})=>{
  const panel = {
    position:"absolute" as const,
    top:14,
    right:14,
    padding:"12px 14px",
    borderRadius:"12px",
    background:"rgba(4,10,26,0.78)",
    border:"1px solid rgba(255,216,74,0.18)",
    backdropFilter:"blur(10px)",
    boxShadow:"0 10px 30px rgba(0,0,0,0.35)",
    color:"#e8edf7",
    minWidth:"220px",
  };
  const label = {
    fontSize:"10px",
    letterSpacing:"0.08em",
    textTransform:"uppercase" as const,
    color:"#6f829d",
    marginBottom:"4px",
  };
  const button = (active:boolean): React.CSSProperties => ({
    background: active ? "rgba(255,216,74,0.22)" : "rgba(255,216,74,0.07)",
    border:"1px solid rgba(255,216,74,0.18)",
    borderRadius:"7px",
    color: active ? "#ffd84a" : "#d1dae6",
    fontSize:"11px",
    padding:"5px 8px",
    cursor:"pointer",
    fontFamily:"monospace",
  });

  return (
    <div style={panel}>
      <div style={{fontSize:"13px", fontWeight:700, color:"#ffd84a", marginBottom:"8px"}}>Solar Scene</div>
      <div style={label}>Live Output</div>
      <div style={{fontSize:"20px", fontWeight:800, marginBottom:"10px"}}>{totalKw.toFixed(2)} kW</div>
      <div style={label}>Camera</div>
      <div style={{display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:"10px"}}>
        {Object.keys(CAMERA_PRESETS).map((preset)=>(
          <button key={preset} style={button(activePreset === preset)} onClick={()=>onPreset(preset)}>
            {preset}
          </button>
        ))}
      </div>
      <div style={label}>Overlays</div>
      <div style={{display:"flex", gap:"6px", flexWrap:"wrap"}}>
        <button style={button(showHeatmap)} onClick={onToggleHeatmap}>heatmap</button>
        <button style={button(showLabels)} onClick={onToggleLabels}>labels</button>
        <button style={button(showSunPath)} onClick={onToggleSunPath}>sun path</button>
      </div>
    </div>
  );
});
SceneOverlay.displayName = "SceneOverlay";

function RoofMesh({
  panels,
  panelTilt,
  panelAzimuth,
  runtimeData,
  showHeatmap,
  showLabels,
  onPanelClick,
}:{
  panels:SolarPanel[];
  panelTilt:number;
  panelAzimuth:number;
  runtimeData:ScenePanelRuntimeData[];
  showHeatmap:boolean;
  showLabels:boolean;
  onPanelClick:(index:number)=>void;
}) {
  return (
    <group>
      <mesh receiveShadow castShadow>
        <boxGeometry args={[7.4,0.28,4.8]}/>
        <meshPhysicalMaterial
          color="#111827"
          roughness={0.45}
          metalness={0.08}
          reflectivity={0.38}
          clearcoat={0.25}
          clearcoatRoughness={0.16}
          envMapIntensity={0.7}
        />
      </mesh>
      {ROOF_OBSTACLES.map((obstacle)=>(
        <mesh key={obstacle.id} position={obstacle.position} castShadow receiveShadow>
          <boxGeometry args={obstacle.size}/>
          <meshStandardMaterial color={obstacle.color} roughness={0.72} metalness={0.12}/>
        </mesh>
      ))}
      {panels.slice(0,18).map((panel, index)=>(
        <group key={panel.id} onClick={()=>onPanelClick(index)}>
          <SolarModule
            panel={panel}
            panelTilt={panelTilt}
            panelAzimuth={panelAzimuth}
            runtime={runtimeData[index]}
            showHeatmap={showHeatmap}
          />
          {showLabels && runtimeData[index] ? (
            <PanelPowerLabel panel={panel} runtime={runtimeData[index]}/>
          ) : null}
        </group>
      ))}
    </group>
  );
}

const Scene3D=React.memo(({panels,elevation,azimuth,starsCount,panelTilt,panelAzimuth}:{panels:SolarPanel[];elevation:number;azimuth:number;starsCount:number;panelTilt:number;panelAzimuth:number})=>{
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [showSunPath, setShowSunPath] = useState(false);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const controlsRef = useRef<any>(null);
  const presetTimeoutRef = useRef<number | null>(null);

  const runtimeData = useMemo(
    () => panels.map((panel) => panelRuntimeData(panel)),
    [panels]
  );
  const totalKw = useMemo(
    () => runtimeData.reduce((sum, runtime) => sum + runtime.watts, 0) / 1000,
    [runtimeData]
  );
  const dir = sunVector(elevation, azimuth);
  const sunLightPos:[number,number,number] = [dir.x * 14, Math.max(2, dir.y * 14), dir.z * 14];
  const averageSunlight = panels.length
    ? panels.reduce((sum, panel)=>sum + panel.sunlight, 0) / panels.length
    : 0;

  useEffect(() => () => {
    if (presetTimeoutRef.current !== null) {
      window.clearTimeout(presetTimeoutRef.current);
    }
  }, []);

  const handlePreset = useCallback((presetKey:string) => {
    if (!(presetKey in CAMERA_PRESETS)) return;
    setActivePreset(presetKey);
    setCameraPreset(CAMERA_PRESETS[presetKey]);
    if (presetTimeoutRef.current !== null) {
      window.clearTimeout(presetTimeoutRef.current);
    }
    presetTimeoutRef.current = window.setTimeout(() => {
      setCameraPreset(null);
      setActivePreset(null);
    }, 1600);
  }, []);

  const handlePanelClick = useCallback((index:number) => {
    setSelectedIdx((prev) => prev === index ? null : index);
  }, []);

  return (
    <div style={{position:"relative", width:"100%", height:"100%"}}>
      <Canvas
        shadows
        camera={{position:[0,6.5,9.5],fov:40}}
        style={{background:"transparent"}}
        gl={{antialias:true,alpha:true,powerPreference:"high-performance"}}
        onCreated={({gl})=>{
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
      >
        <color attach="background" args={["#061022"]}/>
        <ambientLight intensity={0.09} color="#cfeeff"/>
        <hemisphereLight intensity={0.28} color="#c8e8ff" groundColor="#121b14"/>
        <Environment background={false} resolution={128}>
          <Lightformer intensity={0.55} position={[0,6,-8]} rotation={[Math.PI / 2,0,0]} scale={[14,14,1]} color="#ffd7a0"/>
          <Lightformer intensity={0.35} position={[-8,2,0]} rotation={[0,Math.PI / 2,0]} scale={[10,10,1]} color="#9ed1ff"/>
          <Lightformer intensity={0.26} position={[8,1.5,2]} rotation={[0,-Math.PI / 2,0]} scale={[8,8,1]} color="#78b9ff"/>
        </Environment>
        <SunBeam elevation={elevation} azimuth={azimuth}/>
        <pointLight position={sunLightPos} intensity={0.12 + averageSunlight * 0.09} color="#ffd966" distance={24}/>
        <SunGlow elevation={elevation} azimuth={azimuth}/>
        {elevation < 20 ? (
          <Stars
            radius={80}
            depth={40}
            count={SCENE_PERF_MODE ? 260 : Math.max(320, Math.round(starsCount * 1.4))}
            factor={2.2}
            fade
            speed={0.22}
          />
        ) : null}
        <RoofContext/>
        <RoofMesh
          panels={panels}
          panelTilt={panelTilt}
          panelAzimuth={panelAzimuth}
          runtimeData={runtimeData}
          showHeatmap={showHeatmap}
          showLabels={showLabels}
          onPanelClick={handlePanelClick}
        />
        <PanelHighlight
          panel={selectedIdx !== null ? panels[selectedIdx] : null}
          runtime={selectedIdx !== null ? runtimeData[selectedIdx] : null}
          panelTilt={panelTilt}
          panelAzimuth={panelAzimuth}
          onClose={()=>setSelectedIdx(null)}
        />
        <SunPathArc azimuth={azimuth} currentElevation={elevation} visible={showSunPath}/>
        <ContactShadows
          position={[0,CONTACT_SHADOW_Y + 0.002,0]}
          rotation={[-Math.PI / 2,0,0]}
          opacity={0.28}
          width={10}
          height={6}
          blur={2.2}
          far={1.6}
          resolution={1024}
        />
        <AtmoHaze sunlight={averageSunlight}/>
        <CameraRig controlsRef={controlsRef} preset={cameraPreset}/>
        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          enableZoom
          minDistance={4}
          maxDistance={25}
          maxPolarAngle={Math.PI / 2 - 0.05}
          zoomSpeed={0.6}
          rotateSpeed={0.5}
        />
        <ScenePostFX elevation={elevation}/>
        <fog attach="fog" args={["#061022", 26, 84]}/>
      </Canvas>
      <SceneOverlay
        totalKw={totalKw}
        activePreset={activePreset}
        showHeatmap={showHeatmap}
        showLabels={showLabels}
        showSunPath={showSunPath}
        onPreset={handlePreset}
        onToggleHeatmap={()=>setShowHeatmap((value)=>!value)}
        onToggleLabels={()=>setShowLabels((value)=>!value)}
        onToggleSunPath={()=>setShowSunPath((value)=>!value)}
      />
    </div>
  );
});
Scene3D.displayName="Scene3D";

// --- SCAN PULSE RINGS -----------------------------------------------------
const ScanPulseRings = React.memo(({scanY}:{scanY:number})=>(
  <div style={{position:"absolute",inset:0,pointerEvents:"none",zIndex:5}}>
    {[0,1,2].map(i=>(
      <motion.div key={i}
        initial={{scale:0.3,opacity:0.6}}
        animate={{scale:2.5+i*0.5,opacity:0}}
        transition={{duration:2.5,repeat:Infinity,ease:"easeOut",delay:i*0.7}}
        style={{position:"absolute",left:"50%",top:`${scanY}%`,transform:"translate(-50%, -50%)",
          width:60,height:60,borderRadius:"50%",
          border:`1px solid ${T.teal}`,
        }}
      />
    ))}
  </div>
));
ScanPulseRings.displayName="ScanPulseRings";

// --- CTA BEAM -------------------------------------------------------------
const CTABeam = React.memo(()=>(
  <div style={{position:"absolute",inset:0,pointerEvents:"none",overflow:"hidden",borderRadius:"16px"}}>
    {[15,40,65,85].map((left,i)=>(
      <motion.div key={i}
        animate={{opacity:[0,0.4,0],scaleY:[0.5,1.2,0.5]}}
        transition={{duration:4+i*1.3,repeat:Infinity,ease:"easeInOut",delay:i*1.1}}
        style={{position:"absolute",top:0,left:`${left}%`,
          width:"1px",height:"60%",
          background:`linear-gradient(to bottom,${T.blue}00,${T.blue}60,${T.blue}00)`,
          transform:`rotate(${(i%2===0?1:-1)*(3+i*2)}deg)`,transformOrigin:"top",
          filter:`blur(1px)`,
        }}
      />
    ))}
    {/* Radial glow behind CTA text */}
    <motion.div
      animate={{scale:[1,1.15,1],opacity:[0.6,1,0.6]}}
      transition={{duration:4,repeat:Infinity,ease:"easeInOut"}}
      style={{position:"absolute",top:"-30%",left:"30%",right:"30%",
        height:"100%",borderRadius:"50%",
        background:`radial-gradient(ellipse,rgba(59,130,246,0.12) 0%,transparent 70%)`,
        filter:"blur(20px)",
      }}
    />
  </div>
));
CTABeam.displayName="CTABeam";

async function extractFrame(videoFile: File): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;

    video.src = URL.createObjectURL(videoFile);

    video.onloadeddata = () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      ctx.drawImage(video, 0, 0);

      const base64 = canvas
        .toDataURL("image/jpeg")
        .replace(/^data:image\/jpeg;base64,/, "");

      resolve(base64);
    };
  });
}

async function analyzeRooftop(frame: string) {
  const res = await fetch("/api/rooftop-vision", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image: frame }),
  });

  const data = await res.json();

  try {
    return JSON.parse(data.text);
  } catch {
    return null;
  }
}

// ===========================================================================
// MAIN PAGE
// ===========================================================================
export default function RooftopPage() {
  const initialDate = useMemo(()=>new Date(),[]);
  const [video,     setVideo]     = useState<File|null>(null);
  const [scanning,  setScanning]  = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [done,      setDone]      = useState(false);
  const [phase,     setPhase]     = useState(-1);
  const [phasePct,  setPhasePct]  = useState(0);
  const [hw,        setHw]        = useState("h2");
  const [solarTime, setSolarTime] = useState(DEMO_SOLAR_START_HOUR);
  const [dragOver,  setDragOver]  = useState(false);
  const [tab,       setTab]       = useState<"energy"|"roi">("energy");
  const [scanY,     setScanY]     = useState(0);
  const [bbox,      setBbox]      = useState(false);
  const [finHov,    setFinHov]    = useState<number|null>(null);
  const [ctaBtnHov, setCtaBtnHov] = useState(false);
  const [projectData,setProjectData] = useState<StoredProjectData|null>(DEMO_MODE ? DEMO_PROJECT : null);
  const [starsCount,setStarsCount] = useState(500);
  const [generating,setGenerating] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const ivRef   = useRef<ReturnType<typeof setInterval>|null>(null);

  useEffect(()=>{
    const stored = loadStoredProjectData();
    setProjectData(stored ?? (DEMO_MODE ? DEMO_PROJECT : null));
  },[]);

  useEffect(()=>{
    if (typeof window === "undefined") return;
    const savedHw = window.sessionStorage.getItem("rooftop_hw");
    if (savedHw && HARDWARE.some(option => option.id === savedHw)) {
      setHw(savedHw);
    }
    const cores = window.navigator.hardwareConcurrency ?? 6;
    setStarsCount(Math.min(500, Math.max(200, cores * 80)));
  },[]);

  useEffect(()=>{
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("rooftop_hw", hw);
  },[hw]);

  useEffect(()=>{
    const id = window.setInterval(()=>{
      startTransition(()=>{
        setSolarTime((time)=>time >= 18 ? 6 : Number((time + 0.02).toFixed(2)));
      });
    },60);
    return ()=>window.clearInterval(id);
  },[]);

  const curHW = useMemo(()=>HARDWARE.find(h=>h.id===hw) ?? HARDWARE[1],[hw]);
  const curSite = useMemo(
    ()=>createSiteFromProject(projectData),
    [projectData]
  );
  const residentialSite = useMemo(
    ()=>isResidentialType(curSite.type),
    [curSite.type]
  );
  const desiredKw = useMemo(()=>{
    const raw = projectData?.recommendedKW ?? RESIDENTIAL_DEFAULT_KW;
    return residentialSite
      ? clamp(raw, RESIDENTIAL_MIN_KW, RESIDENTIAL_MAX_KW)
      : raw;
  },[projectData,residentialSite]);
  const panelTarget = useMemo(
    ()=>{
      if (residentialSite) {
        return feasibleResidentialPanelCount(
          desiredKw,
          curHW.wattage,
          projectData?.roofAreaSqFt ?? null
        );
      }
      return Math.round(clamp((desiredKw * 1000) / curHW.wattage, 12, 48));
    },
    [curHW.wattage,desiredKw,projectData,residentialSite]
  );
  const siteLatitude = useMemo(
    ()=>projectData?.latitude ?? DEFAULT_SITE_LATITUDE,
    [projectData]
  );
  const panelTilt = useMemo(
    ()=>residentialPanelTilt(siteLatitude),
    [siteLatitude]
  );
  const panelAzimuth = useMemo(
    ()=>panelFacingAzimuth(siteLatitude),
    [siteLatitude]
  );
  const solarDay = useMemo(
    ()=>getDayOfYear(initialDate),
    [initialDate]
  );
  const solarAngles = useMemo(
    ()=>solarPosition(siteLatitude, solarDay, solarTime),
    [siteLatitude,solarDay,solarTime]
  );
  const sunDirection = useMemo(
    ()=>sunVector(solarAngles.elevation, solarAngles.azimuth),
    [solarAngles.azimuth,solarAngles.elevation]
  );
  const panelNormal = useMemo(
    ()=>panelNormalVector(panelTilt, panelAzimuth),
    [panelAzimuth,panelTilt]
  );
  const metrics   = useMemo<RooftopMetrics>(()=>{
    const n=panelTarget;
    const kw=(curHW.wattage*n)/1000;
    const yieldPerKw = projectData?.annualProduction && projectData?.recommendedKW && projectData.recommendedKW > 0
      ? projectData.annualProduction / projectData.recommendedKW
      : 1450;
    const kwh=Math.max(1,Math.round(kw*yieldPerKw));
    let sav = 0;
    let cost = 0;
    let pb = 0;
    if (SHOW_PRICING) {
      const tariffRate =
        projectData?.tariffRate && projectData.tariffRate > 0
          ? projectData.tariffRate
          : projectData?.annualSavings && projectData?.annualConsumption && projectData.annualConsumption > 0
            ? projectData.annualSavings / projectData.annualConsumption
            : 6.5;
      sav = Math.max(0,Math.round(kwh*tariffRate));
      const capexPerKw =
        projectData?.netCost && projectData?.recommendedKW && projectData.recommendedKW > 0
          ? projectData.netCost / projectData.recommendedKW
          : 55000;
      const efficiencyPremium = 1 + Math.max(0, curHW.efficiency - 21) * 0.01;
      cost = Math.round(kw*capexPerKw*efficiencyPremium);
      pb = sav>0?+(cost/sav).toFixed(1):0;
    }
    const annualCo2Tons=+((kwh * CO2_PER_KWH_KG)/1000).toFixed(3);
    return {n,kw,kwh,sav,cost,pb,annualCo2Tons};
  },[panelTarget,curHW,projectData]);
  const annualConsumption = useMemo(
    ()=>projectData?.annualConsumption ?? Math.round(metrics.kwh * 1.1),
    [projectData,metrics.kwh]
  );
  const annualCoveragePct = useMemo(
    ()=>annualConsumption > 0 ? +((metrics.kwh / annualConsumption) * 100).toFixed(1) : 0,
    [annualConsumption,metrics.kwh]
  );
  const annualSurplusKwh = useMemo(
    ()=>Math.max(metrics.kwh - annualConsumption, 0),
    [annualConsumption,metrics.kwh]
  );
  const annualCo2LifetimeTons = useMemo(
    ()=>+(metrics.annualCo2Tons * 25).toFixed(2),
    [metrics.annualCo2Tons]
  );
  const annualCo2Display = useMemo(
    ()=>metrics.annualCo2Tons.toFixed(2),
    [metrics.annualCo2Tons]
  );
  const annualCo2LifetimeDisplay = useMemo(
    ()=>annualCo2LifetimeTons.toFixed(2),
    [annualCo2LifetimeTons]
  );
  const basePanels = useMemo(
    ()=>genPanels(curHW.efficiency,curHW.wattage,metrics.n),
    [curHW.efficiency,curHW.wattage,metrics.n]
  );
  const panels = useMemo(
    ()=>applySolarExposure(basePanels, sunDirection, panelNormal),
    [basePanels,panelNormal,sunDirection]
  );
  const energy    = useMemo(
    ()=>buildEnergySeries(projectData,metrics.kwh,annualConsumption),
    [projectData,metrics.kwh,annualConsumption]
  );
  const liveSolarMetrics = useMemo(()=>{
    const clearSky = clearSkyIrradiance(solarAngles.elevation, solarDay);
    const averageIncidence = panels.length
      ? panels.reduce((sum, panel)=>sum + panel.incidence, 0) / panels.length
      : irradiance(panelNormal, sunDirection);
    const poaIrradiance = planeOfArrayIrradiance(clearSky, averageIncidence, panelTilt);
    const averageShadeFactor = panels.length
      ? panels.reduce((sum, panel)=>sum + panel.shade, 0) / panels.length
      : 1;
    const netPoaIrradiance = poaIrradiance * averageShadeFactor;
    const ambientTemp = Number((24 + Math.max(0, solarAngles.elevation) * 0.17 + 4 * Math.sin(((solarDay - 80) / 365) * Math.PI * 2)).toFixed(1));
    const averageModuleTemp = panels.length
      ? panels.reduce((sum, panel)=>sum + panel.temp, 0) / panels.length
      : ambientTemp;

    const monthIndex = initialDate.getMonth();
    const daysInMonth = new Date(initialDate.getFullYear(), monthIndex + 1, 0).getDate();
    const monthlyProduction = energy[monthIndex]?.production ?? Math.round(metrics.kwh / 12);
    const dailyEnergy = monthlyProduction / Math.max(daysInMonth, 1);
    const annualEstimate = metrics.kwh;

    const tariffRate =
      projectData?.tariffRate && projectData.tariffRate > 0
        ? projectData.tariffRate
        : projectData?.annualSavings && annualEstimate > 0
          ? projectData.annualSavings / annualEstimate
          : 6.5;
    const capexPerKw =
      projectData?.netCost && projectData?.recommendedKW && projectData.recommendedKW > 0
        ? projectData.netCost / projectData.recommendedKW
        : 55000;
    const systemCost = metrics.kw * capexPerKw;
    const annualSavings = annualEstimate * tariffRate;
    const monthlySavings = annualSavings / 12;
    const savingsToday = dailyEnergy * tariffRate;
    const paybackYears =
      projectData?.paybackYears && projectData.paybackYears > 0
        ? projectData.paybackYears
        : annualSavings > 0
          ? systemCost / annualSavings
          : 0;

    if (panels.length === 0) {
      const sunriseSunset = sunriseSunsetSolarTime(siteLatitude, solarDay);
      return {
        irradiance: {
          ghi: Number(clearSky.ghi.toFixed(0)),
          dni: Number(clearSky.dni.toFixed(0)),
          dhi: Number(clearSky.dhi.toFixed(0)),
          poa: Number(netPoaIrradiance.toFixed(0)),
        },
        temperatures: {
          ambient: ambientTemp,
          module: ambientTemp,
          temperatureLossPct: 0,
        },
        losses: {
          soilingPct: 0,
          temperaturePct: 0,
          mismatchPct: 0,
          wiringPct: Number(((1 - WIRING_LOSS_FACTOR) * 100).toFixed(1)),
          inverterPct: Number(((1 - INVERTER_LOSS_FACTOR) * 100).toFixed(1)),
          totalPct: Number((((1 - WIRING_LOSS_FACTOR * INVERTER_LOSS_FACTOR)) * 100).toFixed(1)),
        },
        performance: {
          currentOutputKw: 0,
          peakDcKw: Number((metrics.kw).toFixed(2)),
          performanceRatio: 0,
          netEfficiencyPct: 0,
          cufPct: Number(((annualEstimate / Math.max(metrics.kw * 8760, 1)) * 100).toFixed(1)),
          bestPanelPower: 0,
          worstPanelPower: 0,
          mismatchIndexPct: 0,
          degradationPct: Number((PANEL_DEGRADATION_RATE * 100).toFixed(1)),
        },
        energy: {
          currentOutputKw: 0,
          dailyKwh: Number(dailyEnergy.toFixed(1)),
          monthlyKwh: Number(monthlyProduction.toFixed(0)),
          annualMwh: Number((annualEstimate / 1000).toFixed(1)),
        },
        economics: {
          savingsToday: Number(savingsToday.toFixed(0)),
          monthlySavings: Number(monthlySavings.toFixed(0)),
          annualSavings: Number(annualSavings.toFixed(0)),
          paybackYears: Number(paybackYears.toFixed(1)),
          co2AvoidedTodayKg: Number((dailyEnergy * CO2_PER_KWH_KG).toFixed(1)),
        },
        solarWindow: {
          sunrise: formatSolarTime(sunriseSunset.sunrise),
          sunset: formatSolarTime(sunriseSunset.sunset),
        },
      };
    }

    const currentOutputKw = panels.reduce((sum, panel)=>sum + panel.power, 0) / 1000;
    const peakDcKw = panels.reduce((sum, panel)=>sum + panel.basePower, 0) / 1000;
    const averageModuleEfficiency = curHW.efficiency;
    const averageTemperatureFactor = panels.reduce((sum, panel)=>sum + panel.temperatureFactor, 0) / panels.length;
    const averageSoilingFactor = panels.reduce((sum, panel)=>sum + panel.soilingFactor, 0) / panels.length;
    const averageMismatchFactor = panels.reduce((sum, panel)=>sum + panel.mismatchFactor, 0) / panels.length;
    const actualPowerValues = panels.map(panel=>panel.power);
    const bestPanelPower = Math.max(...actualPowerValues);
    const worstPanelPower = Math.min(...actualPowerValues);
    const averagePanelPower = actualPowerValues.reduce((sum, value)=>sum + value, 0) / actualPowerValues.length;
    const mismatchIndexPct = averagePanelPower > 0
      ? ((bestPanelPower - worstPanelPower) / averagePanelPower) * 100
      : 0;
    const temperatureLossPct = (1 - averageTemperatureFactor) * 100;
    const soilingLossPct = (1 - averageSoilingFactor) * 100;
    const mismatchLossPct = (1 - averageMismatchFactor) * 100;
    const wiringLossPct = (1 - WIRING_LOSS_FACTOR) * 100;
    const inverterLossPct = (1 - INVERTER_LOSS_FACTOR) * 100;
    const totalLossFactor = averageIncidence * averageShadeFactor * averageTemperatureFactor * averageSoilingFactor * averageMismatchFactor * WIRING_LOSS_FACTOR * INVERTER_LOSS_FACTOR;
    const totalLossPct = (1 - totalLossFactor) * 100;
    const irradianceReference = Math.max(poaIrradiance, 1);
    const performanceRatio = peakDcKw > 0
      ? currentOutputKw / Math.max((peakDcKw * irradianceReference) / 1000, 0.001)
      : 0;
    const netEfficiencyPct = averageModuleEfficiency * totalLossFactor;
    const cufPct = annualEstimate / Math.max(metrics.kw * 8760, 1) * 100;
    const sunriseSunset = sunriseSunsetSolarTime(siteLatitude, solarDay);

    return {
      irradiance: {
        ghi: Number(clearSky.ghi.toFixed(0)),
        dni: Number(clearSky.dni.toFixed(0)),
        dhi: Number(clearSky.dhi.toFixed(0)),
        poa: Number(netPoaIrradiance.toFixed(0)),
      },
      temperatures: {
        ambient: ambientTemp,
        module: Number(averageModuleTemp.toFixed(1)),
        temperatureLossPct: Number(temperatureLossPct.toFixed(1)),
      },
      losses: {
        soilingPct: Number(soilingLossPct.toFixed(1)),
        temperaturePct: Number(temperatureLossPct.toFixed(1)),
        mismatchPct: Number(mismatchLossPct.toFixed(1)),
        wiringPct: Number(wiringLossPct.toFixed(1)),
        inverterPct: Number(inverterLossPct.toFixed(1)),
        totalPct: Number(totalLossPct.toFixed(1)),
      },
      performance: {
        currentOutputKw: Number(currentOutputKw.toFixed(2)),
        peakDcKw: Number(peakDcKw.toFixed(2)),
        performanceRatio: Number(performanceRatio.toFixed(2)),
        netEfficiencyPct: Number(netEfficiencyPct.toFixed(1)),
        cufPct: Number(cufPct.toFixed(1)),
        bestPanelPower: Number(bestPanelPower.toFixed(0)),
        worstPanelPower: Number(worstPanelPower.toFixed(0)),
        mismatchIndexPct: Number(mismatchIndexPct.toFixed(1)),
        degradationPct: Number((PANEL_DEGRADATION_RATE * 100).toFixed(1)),
      },
      energy: {
        currentOutputKw: Number(currentOutputKw.toFixed(2)),
        dailyKwh: Number(dailyEnergy.toFixed(1)),
        monthlyKwh: Number(monthlyProduction.toFixed(0)),
        annualMwh: Number((annualEstimate / 1000).toFixed(1)),
      },
      economics: {
        savingsToday: Number(savingsToday.toFixed(0)),
        monthlySavings: Number(monthlySavings.toFixed(0)),
        annualSavings: Number(annualSavings.toFixed(0)),
        paybackYears: Number(paybackYears.toFixed(1)),
        co2AvoidedTodayKg: Number((dailyEnergy * CO2_PER_KWH_KG).toFixed(1)),
      },
      solarWindow: {
        sunrise: formatSolarTime(sunriseSunset.sunrise),
        sunset: formatSolarTime(sunriseSunset.sunset),
      },
    };
  },[curHW.efficiency,energy,initialDate,metrics.kwh,metrics.kw,panelNormal,panels,projectData,siteLatitude,solarAngles.elevation,solarDay,sunDirection]);
  const roi = useMemo(
    ()=>SHOW_PRICING ? buildRoiSeries(metrics.cost,metrics.sav) : buildYieldSeries(metrics.kwh),
    [metrics.cost,metrics.kwh,metrics.sav]
  );
  const breakEven = useMemo(()=>roi.find(d=>d.cumulative>=0)?.year??25,[roi]);
  const solarClock = useMemo(
    ()=>formatSolarTime(solarTime),
    [solarTime]
  );
  const solarTrackPct = useMemo(
    ()=>clamp((solarTime - 6) / 12, 0, 1),
    [solarTime]
  );
  const remainingSeconds = useMemo(()=>{
    if (!scanning) return 0;
    const total = PHASES.reduce((sum, entry)=>sum + entry.duration, 0);
    return Math.max(0, Math.ceil((total * (1 - progress / 100)) / 1000));
  },[progress,scanning]);

  useEffect(()=>{
    if(!scanning)return;
    let d=1,p=0;
    const iv=setInterval(()=>{
      p+=d*2.5;if(p>=100){p=100;d=-1;}if(p<=0){p=0;d=1;}setScanY(p);
    },16);
    return()=>clearInterval(iv);
  },[scanning]);
  useEffect(()=>{if(scanning&&phase>=1)setBbox(true);},[scanning,phase]);

  const startScan=useCallback(async ()=>{
    if (!video) return;
    // --- AI rooftop analysis ---
// --- AI rooftop analysis ---
try {
  const frame = await extractFrame(video);
  const ai = await analyzeRooftop(frame);
  console.log("Gemini result:", ai);

  if (ai) {
    setProjectData((prev) => {
      if (!prev) return prev;

      return {
        ...prev,
        roofAreaSqFt: ai.roofAreaSqFt ?? prev.roofAreaSqFt,
        recommendedKW: 12,
      };
    });
  }
} catch (err) {
  console.log("AI rooftop analysis failed", err);
}
    if(ivRef.current)clearInterval(ivRef.current);
    setScanning(true);setProgress(0);setDone(false);setPhase(0);setPhasePct(0);setBbox(false);
    const total=PHASES.reduce((s,p)=>s+p.duration,0);
    let el=0,pi=0,pe=0;
    ivRef.current=setInterval(()=>{
      el+=50;pe+=50;
      const dur=PHASES[pi]?.duration??1;
      setPhasePct(Math.min((pe/dur)*100,100));
      if(pe>=dur){pi++;pe=0;
        if(pi>=PHASES.length){clearInterval(ivRef.current!);setProgress(100);setDone(true);setScanning(false);setPhase(-1);return;}
        setPhase(pi);
      }
      setProgress(Math.min((el/total)*100,99));
    },50);
  },[video]);

  const reset=useCallback(()=>{
    if (ivRef.current) {
      clearInterval(ivRef.current);
      ivRef.current = null;
    }
    if (fileRef.current) {
      fileRef.current.value = "";
    }
    setVideo(null);
    setScanning(false);
    setProgress(0);
    setDone(false);
    setPhase(-1);
    setPhasePct(0);
    setScanY(0);
    setBbox(false);
    setDragOver(false);
  },[]);

  const handleFile=useCallback((f:File)=>{reset();setVideo(f);},[reset]);
  const onDrop=useCallback((e:React.DragEvent)=>{
    e.preventDefault();setDragOver(false);
    const f=e.dataTransfer.files[0];if(f&&f.type.startsWith("video/"))handleFile(f);
  },[handleFile]);
  useEffect(()=>()=>{if(ivRef.current)clearInterval(ivRef.current);},[]);

  const generateReport = useCallback(async ()=>{
    const element = document.getElementById("report-root");
    if (!element) {
      alert("Report section not found");
      return;
    }

    setGenerating(true);
    try {
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        backgroundColor: T.bg,
      });

      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "px",
        format: "a4",
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgHeight = (canvas.height * pageWidth) / canvas.width;
      const pageUsableHeight = pageHeight - 40;
      let heightLeft = imgHeight;
      let offsetY = 20;

      pdf.addImage(imgData, "PNG", 0, offsetY, pageWidth, imgHeight);
      heightLeft -= pageUsableHeight;

      while (heightLeft > 0) {
        pdf.addPage();
        offsetY = 20 - (imgHeight - heightLeft);
        pdf.addImage(imgData, "PNG", 0, offsetY, pageWidth, imgHeight);
        heightLeft -= pageUsableHeight;
      }

      pdf.save("solar-feasibility-report.pdf");
    } finally {
      setGenerating(false);
    }
  },[]);

  const kpis = useMemo(()=>{
    if (SHOW_PRICING) {
      return [
        {label:"Total CapEx",        value:formatINR(metrics.cost),                sub:"Installed cost",       icon:<DollarSign size={15}/>, iconColor:T.amber,  iconBg:T.amberDim,  topAccent:`linear-gradient(90deg,${T.teal},${T.purple})`},
        {label:"Annual Savings",     value:formatINR(metrics.sav),                 sub:"Estimated yearly return", icon:<TrendingUp size={15}/>, iconColor:T.teal,   iconBg:T.tealDim,   topAccent:`linear-gradient(90deg,${T.teal},${T.blue})`},
        {label:"Equity Payback",     value:`${metrics.pb} Yrs`,                    sub:"Break-even period",    icon:<Clock      size={15}/>, iconColor:T.blue,   iconBg:T.blueDim},
        {label:"Panel Efficiency",   value:`${curHW.efficiency}%`,                 sub:`${curHW.brand} ${curHW.model}`, icon:<BarChart3 size={15}/>, iconColor:T.purple, iconBg:T.purpleDim},
        {label:"Net Present Value",  value:formatINR(metrics.sav*25-metrics.cost), sub:"25-yr NPV",            icon:<Zap size={15}/>, iconColor:T.pink, iconBg:T.pinkDim},
      ];
    }
    return [
      {label:"Annual Production",  value:`${metrics.kwh.toLocaleString("en-IN")} kWh`, sub:"Estimated yearly generation", icon:<TrendingUp size={15}/>, iconColor:T.teal,   iconBg:T.tealDim,   topAccent:`linear-gradient(90deg,${T.teal},${T.blue})`},
      {label:"System Capacity",    value:`${metrics.kw.toFixed(1)} kW`,                sub:`${metrics.n} modules`,         icon:<Zap size={15}/>,        iconColor:T.amber,  iconBg:T.amberDim},
      {label:"Energy Coverage",    value:`${annualCoveragePct}%`,                        sub:annualCoveragePct > 100 ? `Exceeds demand by ${annualSurplusKwh.toLocaleString("en-IN")} kWh/yr` : "Annual demand coverage",      icon:<Clock size={15}/>,      iconColor:T.blue,   iconBg:T.blueDim},
      {label:"Panel Efficiency",   value:`${curHW.efficiency}%`,                         sub:`${curHW.brand} ${curHW.model}`, icon:<BarChart3 size={15}/>, iconColor:T.purple, iconBg:T.purpleDim},
      {label:"CO2 Reduction",      value:`${annualCo2Display} t/yr`,    sub:"Estimated avoided emissions", icon:<Wind size={15}/>,       iconColor:T.pink,   iconBg:T.pinkDim},
    ];
  },[annualCo2Display,annualCoveragePct,annualSurplusKwh,curHW,metrics]);

  // =========================================================================
  return (
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,paddingTop:"20px",
      fontFamily:"'Inter','SF Pro Display',system-ui,sans-serif",overflowX:"hidden",position:"relative"}}>

      {/* -- AMBIENT MESH BACKGROUND ----------------------------------- */}
      <AmbientBackground/>

      {/* -- PAGE ENTRANCE STAGGER -------------------------------------- */}
      <motion.div
        variants={pageVariants}
        initial="hidden"
        animate="visible"
        style={{position:"relative",zIndex:1}}
      >
        <section style={{maxWidth:"1320px",margin:"0 auto",padding:"10px 28px 0"}}>

          {/* OS Badge */}
          <motion.div variants={fadeUp}
            style={{display:"inline-flex",alignItems:"center",gap:"8px",
              padding:"5px 12px",borderRadius:"30px",marginBottom:"18px",
              background:"rgba(15,23,42,0.5)",
              border:"1px solid rgba(51,65,85,0.5)",
              backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",
              boxShadow:"0 10px 15px rgba(0,0,0,0.25)",
            }}
          >
            <Cpu size={16} color="#4ade80" />
            <span style={{fontSize:"12px",fontWeight:600,letterSpacing:"0.08em",color:"#cbd5e1",textTransform:"uppercase"}}>
              Zenith Enterprise OS v6.0
            </span>
          </motion.div>

          {/* Hero */}
          <div style={{marginBottom:"44px"}}>
            <motion.div variants={fadeUp}>
              <motion.h1
                initial={{opacity:0,y:30}} animate={{opacity:1,y:0}} transition={{duration:0.7,ease:[0.22,1,0.36,1],delay:0.15}}
                style={{fontSize:"clamp(32px,4.2vw,52px)",fontWeight:900,lineHeight:1.1,
                  letterSpacing:"-0.035em",margin:"0 0 4px",color:T.text}}
              >
                AI Rooftop Solar
              </motion.h1>
              <motion.h1
                initial={{opacity:0,y:30}} animate={{opacity:1,y:0}} transition={{duration:0.7,ease:[0.22,1,0.36,1],delay:0.25}}
                style={{fontSize:"clamp(32px,4.2vw,52px)",fontWeight:900,lineHeight:1.1,
                  letterSpacing:"-0.035em",margin:"0 0 22px",
                  background:`linear-gradient(130deg,${T.teal} 0%,#00b4d8 60%,#0ea5e9 100%)`,
                  WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
                }}
              >
                Feasibility Analysis
              </motion.h1>
              <motion.p
                initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} transition={{duration:0.6,delay:0.35}}
                style={{fontSize:"15px",color:T.textMid,lineHeight:1.7,maxWidth:"400px",margin:"0 0 28px"}}
              >
                AI-powered geometry reconstruction, shadow simulation &amp; irradiance modelling for precise solar feasibility.
              </motion.p>
            </motion.div>

          </div>

          <Divider/>
        </section>

        {/* === MAIN ==================================================== */}
        <main style={{maxWidth:"1320px",margin:"0 auto",padding:"28px 28px 64px",
          display:"flex",flexDirection:"column",gap:"18px"}}>

          {/* Status Banner */}
          <div style={{padding:"4px 0 0"}}>
            <StatusBanner done={done} running={scanning} etaSeconds={remainingSeconds}/>
          </div>

          {/* VIDEO UPLOAD */}
          <motion.div variants={fadeUp}>
            <div style={{...cs, boxShadow:"0 4px 24px rgba(0,0,0,0.3)"}}>
              <div style={{padding:"18px 18px 0",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"14px"}}>
                <div>
                  <p style={{fontSize:"13px",fontWeight:700,color:T.text}}>Video Upload Scanner</p>
                  <p style={{fontSize:"10px",color:T.textDim,marginTop:"2px"}}>Drone or handheld rooftop footage</p>
                </div>
                {(scanning||done)&&(
                  <motion.button onClick={reset}
                    whileHover={{scale:1.05}} whileTap={{scale:0.94}}
                    style={{display:"flex",alignItems:"center",gap:"5px",
                      padding:"4px 11px",borderRadius:"7px",background:"transparent",
                      border:`1px solid ${T.border}`,color:T.textMid,fontSize:"10px",cursor:"pointer"}}>
                    <RotateCcw size={10}/>Reset
                  </motion.button>
                )}
              </div>

              <div style={{padding:"0 18px 18px"}}>
                <div
                  onDragOver={e=>{e.preventDefault();setDragOver(true);}}
                  onDragLeave={()=>setDragOver(false)} onDrop={onDrop}
                  onClick={()=>!scanning&&fileRef.current?.click()}
                  onKeyDown={e=>{
                    if ((e.key === "Enter" || e.key === " ") && !scanning) {
                      e.preventDefault();
                      fileRef.current?.click();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label="Upload rooftop video"
                  style={{position:"relative",borderRadius:"10px",overflow:"hidden",cursor:"pointer",minHeight:"190px",
                    background:dragOver?"rgba(0,212,170,0.06)":"rgba(0,0,0,0.25)",
                    border:`1px dashed ${dragOver?T.tealBorder:(scanning?"rgba(0,212,170,0.25)":"rgba(255,255,255,0.09)")}`,
                    transition:"all 0.25s ease",
                    boxShadow:dragOver?`0 0 30px rgba(0,212,170,0.15)`:"none",
                  }}
                >
                  {/* AI scan grid overlay */}
                  {(scanning||done)&&(
                    <motion.div
                      initial={{opacity:0}} animate={{opacity:1}} transition={{duration:0.5}}
                      style={{position:"absolute",inset:0,pointerEvents:"none",
                        backgroundImage:`linear-gradient(rgba(0,212,170,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,212,170,0.04) 1px,transparent 1px)`,
                        backgroundSize:"22px 22px",
                      }}
                    />
                  )}

                  {/* Animated scan line with trailing glow particles */}
                  {scanning&&(
                    <>
                      <div style={{position:"absolute",left:0,right:0,height:"1px",top:`${scanY}%`,zIndex:20,pointerEvents:"none",
                        background:`linear-gradient(to right,transparent 0%,rgba(0,212,170,0.2) 10%,${T.teal} 40%,#00b4d8 60%,${T.teal} 90%,transparent 100%)`,
                        boxShadow:`0 0 8px ${T.teal}, 0 0 20px rgba(0,212,170,0.5), 0 0 40px rgba(0,212,170,0.2)`,
                      }}/>
                      {/* Trailing particles */}
                      {[...Array(4)].map((_,pi)=>(
                        <motion.div key={pi}
                          animate={{opacity:[0,0.6,0],y:[0,-(pi+1)*8,-(pi+1)*16]}}
                          transition={{duration:0.6,repeat:Infinity,delay:pi*0.08,ease:"easeOut"}}
                          style={{position:"absolute",left:`${20+pi*20}%`,top:`${scanY}%`,
                            width:"2px",height:"2px",borderRadius:"50%",
                            background:T.teal,boxShadow:`0 0 4px ${T.teal}`,
                            pointerEvents:"none",zIndex:21,
                          }}
                        />
                      ))}
                    </>
                  )}

                  {/* Pulse rings when scan starts */}
                  {scanning&&<ScanPulseRings scanY={scanY}/>}

                  {/* Bounding box with animated corners */}
                  <AnimatePresence>
                    {bbox&&(
                      <motion.div
                        initial={{opacity:0,scale:0.88}} animate={{opacity:1,scale:1}}
                        exit={{opacity:0}} transition={SPRING}
                        style={{position:"absolute",inset:"18px",pointerEvents:"none",zIndex:10,
                          border:`1px solid rgba(0,212,170,0.2)`,
                          boxShadow:`inset 0 0 30px rgba(0,212,170,0.03)`,
                        }}
                      >
                        {/* Animated corner accents */}
                        {CORNER_ACCENTS.map((corner,ci)=>(
                          <motion.div key={ci}
                            initial={{width:0,height:0}} animate={{width:14,height:14}}
                            transition={{delay:ci*0.05,duration:0.25,ease:[0.22,1,0.36,1]}}
                            style={{position:"absolute",
                              top:corner.top??undefined, bottom:corner.bottom??undefined,
                              left:corner.left??undefined, right:corner.right??undefined,
                              borderTop:corner.bT?`2px solid ${T.teal}`:"none",
                              borderBottom:corner.bB?`2px solid ${T.teal}`:"none",
                              borderLeft:corner.bL?`2px solid ${T.teal}`:"none",
                              borderRight:corner.bR?`2px solid ${T.teal}`:"none",
                              boxShadow:corner.bT&&corner.bL?`-2px -2px 6px ${T.teal}40`
                                :corner.bT&&corner.bR?`2px -2px 6px ${T.teal}40`
                                :corner.bB&&corner.bL?`-2px 2px 6px ${T.teal}40`
                                :`2px 2px 6px ${T.teal}40`,
                            }}
                          />
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                    height:"190px",position:"relative",zIndex:10}}>
                    {!scanning&&!done?(
                      <>
                        <motion.div
                          animate={{y:[0,-5,0]}}
                          transition={{duration:2.5,repeat:Infinity,ease:"easeInOut"}}
                          whileHover={{scale:1.12,rotate:5,transition:SPRING}}
                          style={{width:44,height:44,borderRadius:"12px",marginBottom:"10px",
                            background:T.tealDim,border:`1px solid ${T.tealBorder}`,
                            display:"flex",alignItems:"center",justifyContent:"center",color:T.teal,
                            boxShadow:`0 0 20px rgba(0,212,170,0.15)`,
                          }}
                        >
                          <Upload size={18}/>
                        </motion.div>
                        <p style={{fontSize:"13px",fontWeight:700,color:T.text,marginBottom:"3px"}}>
                          {video ? "Video uploaded. Ready to scan." : "Primary: Upload roof video (required)"}
                        </p>
                        <p style={{fontSize:"10px",color:T.textDim,marginBottom:"12px"}}>
                          {video?.name ?? "Drag and drop or click - MP4, MOV, AVI"}
                        </p>
                        {/* Premium upload button */}
                        <motion.button
                          whileHover={{scale:1.06}} whileTap={{scale:0.93,transition:{duration:0.08}}}
                          onClick={e=>{e.stopPropagation();startScan();}}
                          disabled={!video}
                          aria-label="Run scan after video upload"
                          title="Run scan after video upload"
                          style={{position:"relative",display:"flex",alignItems:"center",gap:"5px",
                            padding:"10px 22px",borderRadius:"10px",
                            background:T.green,border:"none",color:"#fff",fontSize:"13px",fontWeight:800,cursor:video?"pointer":"not-allowed",
                            opacity:video?1:0.4,
                            boxShadow:`0 0 0 0px rgba(34,197,94,0.3), 0 0 22px rgba(34,197,94,0.35)`,
                            overflow:"hidden",
                          }}
                        >
                          <Play size={12}/>Run Scan (Upload Video)
                        </motion.button>
                      </>
                    ):scanning?(
                      <div style={{textAlign:"center"}}>
                        <motion.div animate={{rotate:360}} transition={{duration:1.8,repeat:Infinity,ease:"linear"}}
                          style={{width:40,height:40,borderRadius:"50%",margin:"0 auto 10px",
                            border:`2px solid rgba(0,212,170,0.2)`,borderTop:`2px solid ${T.teal}`,
                            boxShadow:`0 0 20px rgba(0,212,170,0.2)`,
                          }}/>
                        <p style={{fontSize:"12px",fontWeight:700,color:T.teal}}>Analyzing...</p>
                        <p style={{fontSize:"10px",color:T.textDim,marginTop:"3px"}}>{Math.round(progress)}% complete · ETA {remainingSeconds}s</p>
                        <motion.button
                          whileHover={{scale:1.04}} whileTap={{scale:0.95}}
                          onClick={e=>{e.stopPropagation();reset();}}
                          style={{marginTop:"10px",padding:"5px 10px",borderRadius:"7px",border:`1px solid ${T.borderHi}`,
                            background:"rgba(255,255,255,0.04)",color:T.text,fontSize:"10px",cursor:"pointer"}}
                        >
                          Cancel
                        </motion.button>
                      </div>
                    ):(
                      <div style={{textAlign:"center"}}>
                        <motion.div initial={{scale:0}} animate={{scale:1}} transition={{type:"spring",stiffness:260,damping:15}}
                          style={{width:40,height:40,borderRadius:"50%",margin:"0 auto 10px",
                            background:"rgba(34,197,94,0.14)",border:"1px solid rgba(34,197,94,0.4)",
                            display:"flex",alignItems:"center",justifyContent:"center",color:T.green,
                            boxShadow:`0 0 20px rgba(34,197,94,0.2)`,
                          }}>
                          <motion.div initial={{pathLength:0}} animate={{pathLength:1}}>
                            <Check size={18}/>
                          </motion.div>
                        </motion.div>
                        <p style={{fontSize:"12px",fontWeight:700,color:T.green}}>Analysis Complete</p>
                        <p style={{fontSize:"10px",color:T.textDim,marginTop:"3px"}}>{video?.name??"Demo rooftop"}</p>
                      </div>
                    )}
                  </div>
                </div>

                <input id="rooftop-video-input" ref={fileRef} type="file" accept="video/*" aria-label="Rooftop video file input" style={{display:"none"}}
                  onChange={e=>{
                    const f=e.target.files?.[0];
                    if(f) handleFile(f);
                    e.target.value="";
                  }}/>

                {(scanning||done)&&(
                  <div style={{marginTop:"14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:"10px",marginBottom:"5px"}}>
                      <span style={{color:T.textDim}}>Overall Progress</span>
                      <span style={{color:T.teal,fontFamily:"monospace"}}>{Math.round(progress)}%</span>
                    </div>
                    <div style={{height:"3px",borderRadius:"2px",background:"rgba(255,255,255,0.07)",overflow:"hidden"}}>
                      <motion.div animate={{width:`${progress}%`}} transition={{duration:0.08}}
                        style={{height:"100%",background:`linear-gradient(to right,${T.teal},#00b4d8)`,
                          boxShadow:`0 0 8px ${T.teal}`,
                        }}/>
                    </div>
                    <PhaseList cur={phase} prog={phasePct}/>
                  </div>
                )}
              </div>
            </div>
          </motion.div>

          {/* KPI Row */}
          <AnimatePresence>
            {done&&(
              <motion.div
                initial="hidden"
                animate="visible"
                exit={{opacity:0,y:-12}}
                variants={{
                  hidden:{opacity:0,y:18},
                  visible:{
                    opacity:1,
                    y:0,
                    transition:{duration:0.28,ease:"easeOut",staggerChildren:0.07,delayChildren:0.05},
                  },
                }}
                style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:"10px"}}
              >
                {kpis.map((k)=>(
                  <KPICard key={k.label} {...k}/>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* HARDWARE CONFIGURATOR */}
          <motion.div variants={fadeUp} whileInView="visible" initial="hidden" viewport={{once:true}}
            style={{...cs, boxShadow:"0 4px 24px rgba(0,0,0,0.3)"}}
          >
            <div style={{padding:"18px 18px 4px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <p style={{fontSize:"13px",fontWeight:700,color:T.text}}>Hardware Configurator</p>
                <p style={{fontSize:"10px",color:T.textDim,marginTop:"2px"}}>Solar panel tier · {curSite.name}</p>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:"5px",padding:"5px 11px",borderRadius:"7px",
                background:"rgba(255,255,255,0.04)",border:`1px solid ${T.border}`,fontSize:"10px",color:T.textMid}}>
                <motion.div whileHover={{rotate:45}} transition={SPRING}>
                  <Settings2 size={10}/>
                </motion.div>
                {metrics.n} panels
              </div>
            </div>
            <div style={{padding:"10px 18px",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"10px"}}>
              {HARDWARE.map(o=><HWCard key={o.id} opt={o} sel={hw===o.id} onSel={()=>setHw(o.id)}/>)}
            </div>
            <div style={{padding:"0 18px 18px"}}>
              <motion.div layout
                style={{padding:"14px 18px",borderRadius:"10px",
                  background:`linear-gradient(135deg,rgba(0,212,170,0.07),rgba(0,180,216,0.03))`,
                  border:`1px solid ${T.tealBorder}`,
                  boxShadow:`0 0 30px rgba(0,212,170,0.06)`,
                }}>
                <div style={{display:"flex",flexWrap:"wrap",gap:"22px",alignItems:"center"}}>
                  {[
                    {l:"System",v:`${curHW.brand} ${curHW.model} x${metrics.n}`},
                    {l:"Total Capacity",v:`${metrics.kw.toFixed(1)} kW`},
                    ...(SHOW_PRICING
                      ? [
                          {l:"Installed Cost",v:formatINR(metrics.cost)},
                          {l:"Annual Return",v:formatINR(metrics.sav)},
                        ]
                      : [
                          {l:"Annual Production",v:`${metrics.kwh.toLocaleString("en-IN")} kWh`},
                          {l:"CO2 Saved",v:`${annualCo2Display} t/yr`},
                        ]),
                  ].map(s=>(
                    <div key={s.l}>
                      <p style={{fontSize:"9px",color:T.textDim,marginBottom:"2px",textTransform:"uppercase",letterSpacing:"0.07em"}}>{s.l}</p>
                      <p style={{fontSize:"13px",fontWeight:700,color:T.text}}>{s.v}</p>
                    </div>
                  ))}
                  <div style={{marginLeft:"auto"}}>
                    <motion.button
                      onClick={generateReport}
                      disabled={generating}
                      whileHover={{scale:1.05}} whileTap={{scale:0.93,transition:{duration:0.08}}}
                      aria-label="Generate rooftop report"
                      style={{position:"relative",display:"flex",alignItems:"center",gap:"6px",
                        padding:"9px 20px",borderRadius:"9px",background:T.green,border:"none",
                        color:"#fff",fontSize:"12px",fontWeight:700,cursor:generating?"wait":"pointer",overflow:"hidden",
                        opacity:generating?0.8:1,
                        boxShadow:`0 0 20px rgba(34,197,94,0.35)`,
                      }}>
                      {generating ? "Generating..." : "Generate Report"}
                      {!generating?<ChevronRight size={13}/>:null}
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            </div>
          </motion.div>

          {/* 3D visualization */}
          <motion.div variants={fadeUp}>
            <div style={{...cs,boxShadow:"0 4px 24px rgba(0,0,0,0.3)",overflow:"hidden"}}>
              <div style={{padding:"18px 18px 0",display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"12px",gap:"12px",flexWrap:"wrap"}}>
                <div>
                  <p style={{fontSize:"13px",fontWeight:700,color:T.text}}>3D Roof Visualization</p>
                  <p style={{fontSize:"10px",color:T.textDim,marginTop:"2px"}}>AI-reconstructed house-roof layout · {curSite.name}</p>
                </div>
                <span style={{display:"flex",alignItems:"center",gap:"4px",fontSize:"10px",color:T.textDim}}>
                  <Eye size={10}/>Interactive
                </span>
              </div>
              <div style={{padding:"0 18px 18px"}}>
                <div style={{height:"clamp(420px,72vh,820px)",borderRadius:"18px",overflow:"hidden",background:"linear-gradient(180deg,rgba(3,12,33,0.96),rgba(4,10,22,0.88))"}}>
                  <Suspense fallback={
                    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%"}}>
                      <motion.div animate={{rotate:360}} transition={{duration:1.8,repeat:Infinity,ease:"linear"}}
                        style={{width:28,height:28,borderRadius:"50%",
                          border:`2px solid rgba(0,212,170,0.2)`,borderTop:`2px solid ${T.teal}`,
                          boxShadow:`0 0 12px rgba(0,212,170,0.2)`,
                        }}/>
                    </div>
                  }>
                    <RooftopUltraScene
                      panels={panels}
                      elevation={solarAngles.elevation}
                      azimuth={solarAngles.azimuth}
                      starsCount={starsCount}
                      panelTilt={panelTilt}
                      panelAzimuth={panelAzimuth}
                    />
                  </Suspense>
                </div>

                <div style={{...cs,padding:"14px 16px",background:"rgba(0,0,0,0.35)",marginTop:"14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"12px",gap:"12px",flexWrap:"wrap"}}>
                    <div style={{display:"flex",alignItems:"center",gap:"6px",fontSize:"10px",color:T.textDim}}>
                      <motion.div animate={{rotate:[0,10,0,-10,0]}} transition={{duration:4,repeat:Infinity,ease:"easeInOut"}}>
                        <Sun size={10} style={{color:T.amber}}/>
                      </motion.div>
                      Live Solar Position
                    </div>
                    <span style={{fontSize:"10px",fontFamily:"monospace",color:T.teal}}>{solarClock}</span>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:"8px",marginBottom:"12px"}}>
                    {[
                      {label:"Latitude",value:`${siteLatitude.toFixed(2)}°${siteLatitude >= 0 ? "N" : "S"}`},
                      {label:"Tilt",value:`${panelTilt.toFixed(0)}°`},
                      {label:"Elevation",value:`${Math.max(0, solarAngles.elevation).toFixed(1)}°`},
                      {label:"Azimuth",value:`${solarAngles.azimuth.toFixed(1)}°`},
                      {label:"Sunrise",value:liveSolarMetrics.solarWindow.sunrise},
                      {label:"Sunset",value:liveSolarMetrics.solarWindow.sunset},
                    ].map((item)=>(
                      <div key={item.label} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`,
                        borderRadius:"8px",padding:"8px 7px"}}>
                        <p style={{fontSize:"9px",color:T.textDim,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"3px"}}>{item.label}</p>
                        <p style={{fontSize:"11px",fontWeight:700,color:T.text}}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                  <div style={{position:"relative"}}>
                    <div style={{height:"3px",borderRadius:"999px",background:"rgba(255,255,255,0.08)",overflow:"hidden"}}>
                      <motion.div
                        animate={{width:`${solarTrackPct * 100}%`}}
                        transition={{duration:0.2,ease:"linear"}}
                        style={{height:"100%",background:`linear-gradient(90deg,#1d4ed8,${T.teal},#fde68a)`}}
                      />
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:"6px",fontSize:"9px",color:T.textDim}}>
                      <span>06:00</span>
                      <span>{solarClock} solar time</span>
                      <span>18:00</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          <Divider/>

          {/* CHARTS */}
          <motion.div variants={fadeUp} whileInView="visible" initial="hidden" viewport={{once:true}}
            style={{...cs, boxShadow:"0 4px 24px rgba(0,0,0,0.3)"}}
          >
            <div style={{padding:"18px 18px 6px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <p style={{fontSize:"13px",fontWeight:700,color:T.text}}>Performance Analytics</p>
                <p style={{fontSize:"10px",color:T.textDim,marginTop:"2px"}}>12-month forecast · {curSite.name}</p>
              </div>
              <div style={{display:"flex",borderRadius:"9px",overflow:"hidden",
                border:`1px solid ${T.border}`,backdropFilter:"blur(8px)"}}>
                {(["energy","roi"] as const).map(t=>(
                  <motion.button key={t} onClick={()=>setTab(t)}
                    whileHover={{scale:1.02}} whileTap={{scale:0.97}}
                    style={{padding:"6px 16px",fontSize:"11px",fontWeight:600,border:"none",cursor:"pointer",
                      background:tab===t?T.tealDim:"transparent",color:tab===t?T.teal:T.textDim,
                      borderBottom:tab===t?`2px solid ${T.teal}`:"2px solid transparent",
                      boxShadow:tab===t?`0 0 12px rgba(0,212,170,0.15)`:"none",
                      transition:"all 0.2s",
                    }}>
                    {t==="energy"?"Energy":SHOW_PRICING?"ROI":"Yield"}
                  </motion.button>
                ))}
              </div>
            </div>
            <div style={{padding:"0 14px 18px",height:"265px"}}>
              <ResponsiveContainer width="100%" height="100%">
                {tab==="energy"?(
                  <AreaChart data={energy} margin={{top:5,right:5,left:-18,bottom:0}}>
                    <defs>
                      <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.teal} stopOpacity={0.35}/>
                        <stop offset="100%" stopColor={T.teal} stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.blue} stopOpacity={0.25}/>
                        <stop offset="100%" stopColor={T.blue} stopOpacity={0}/>
                      </linearGradient>
                      <filter id="glow">
                        <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                        <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
                      </filter>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="month" tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false}/>
                    <Tooltip content={<ChartTip/>}/>
                    <Area type="monotone" dataKey="production" name="Production" stroke={T.teal} strokeWidth={2.5} fill="url(#gP)" dot={false} activeDot={{r:5,fill:T.teal,strokeWidth:0,style:{filter:`drop-shadow(0 0 6px ${T.teal})`}}}/>
                    <Area type="monotone" dataKey="consumption" name="Consumption" stroke={T.blue} strokeWidth={2} fill="url(#gC)" dot={false} activeDot={{r:5,fill:T.blue,strokeWidth:0}}/>
                  </AreaChart>
                ):(
                  <LineChart data={roi} margin={{top:5,right:5,left:-18,bottom:0}}>
                    <defs>
                      <linearGradient id="gR" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#ef4444"/>
                        <stop offset={`${SHOW_PRICING ? Math.min(100,(breakEven/24)*100) : 55}%`} stopColor={T.amber}/>
                        <stop offset="100%" stopColor={T.teal}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
                    <XAxis dataKey="year" tick={{fill:T.textDim,fontSize:10}} axisLine={false} tickLine={false}/>
                    <YAxis
                      tick={{fill:T.textDim,fontSize:10}}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={v=>SHOW_PRICING ? `₹${(v/100000).toFixed(1)}L` : `${(v/1000).toFixed(0)}k`}
                    />
                    <Tooltip content={<ROITooltip showPricing={SHOW_PRICING}/>}/>
                    <ReferenceLine y={0} stroke={T.tealBorder} strokeDasharray="4 4"
                      label={{value:SHOW_PRICING ? `Break-even yr ${breakEven}` : "Cumulative energy yield",fill:T.teal,fontSize:10,position:"insideTopRight"}}/>
                    <Line type="monotone" dataKey="cumulative" stroke="url(#gR)" strokeWidth={2.5} dot={false} activeDot={{r:5,fill:T.teal,strokeWidth:0,style:{filter:`drop-shadow(0 0 6px ${T.teal})`}}}/>
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          </motion.div>

          {/* FINANCIAL CARDS */}
          <motion.div
            variants={{ hidden:{}, visible:{ transition:{ staggerChildren:0.1 }}}}
            whileInView="visible" initial="hidden" viewport={{once:true}}
            style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"12px"}}
          >
            {(SHOW_PRICING
              ? [
                  {title:"Payback Period",value:`${metrics.pb} Years`,
                    desc:`Break-even by year ${Math.ceil(metrics.pb)}. Pure profit every year after.`,
                    icon:<Clock size={15}/>,color:T.teal,detail:`${formatINR(metrics.sav)} / yr saved`},
                  {title:"25-Year Profit",value:formatINR(metrics.sav*25-metrics.cost),
                    desc:"Net gain after full system cost across the warranty lifespan.",
                    icon:<TrendingUp size={15}/>,color:T.green,detail:"After full capex recovery"},
                  {title:"CO2 Reduction",value:`${annualCo2Display} t / yr`,
                    desc:"Equivalent to removing one car from the road each year you own this system.",
                    icon:<Wind size={15}/>,color:T.blue,detail:`${annualCo2LifetimeDisplay} t over 25 years`},
                ]
              : [
                  {title:"Energy Coverage",value:`${annualCoveragePct}%`,
                    desc:annualCoveragePct > 100
                      ? `System exceeds yearly demand by ${annualSurplusKwh.toLocaleString("en-IN")} kWh and can export surplus energy.`
                      : "Share of yearly demand estimated to be covered by rooftop generation.",
                    icon:<Clock size={15}/>,color:T.teal,detail:annualCoveragePct > 100
                      ? `${annualSurplusKwh.toLocaleString("en-IN")} kWh annual surplus / export potential`
                      : `${annualConsumption.toLocaleString("en-IN")} kWh annual demand`},
                  {title:"Annual Generation",value:`${metrics.kwh.toLocaleString("en-IN")} kWh`,
                    desc:"Projected yearly production from selected module setup.",
                    icon:<TrendingUp size={15}/>,color:T.green,detail:`${metrics.kw.toFixed(1)} kW system size`},
                  {title:"CO2 Reduction",value:`${annualCo2Display} t / yr`,
                    desc:"Equivalent to removing one car from the road each year you own this system.",
                    icon:<Wind size={15}/>,color:T.blue,detail:`${annualCo2LifetimeDisplay} t over 25 years`},
                ]).map((c,i)=>{
              const hov=finHov===i;
              return (
                <motion.div key={i} variants={fadeUp}
                  onHoverStart={()=>setFinHov(i)}
                  onHoverEnd={()=>setFinHov(prev=>prev===i?null:prev)}
                  whileHover={{y:-5,transition:SPRING}}
                  style={{...cs,padding:"20px",position:"relative",overflow:"hidden",
                    border:`1px solid ${hov?c.color+"30":T.border}`,
                    boxShadow:hov?`0 0 0 1px ${c.color}15, 0 12px 40px -12px ${c.color}35`:"0 2px 12px rgba(0,0,0,0.3)",
                    transition:"border-color 0.3s,box-shadow 0.4s",
                  }}
                >
                  {/* Corner glow */}
                  <div style={{position:"absolute",top:0,right:0,width:"80px",height:"80px",borderRadius:"50%",
                    background:`radial-gradient(circle,${c.color}${hov?"20":"10"},transparent 70%)`,
                    transform:"translate(20%,-20%)",transition:"all 0.4s",
                  }}/>
                  <AnimatePresence>
                    {hov&&(
                      <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
                        style={{position:"absolute",inset:0,pointerEvents:"none",
                          background:`radial-gradient(ellipse 80% 50% at 50% 0%,${c.color}08,transparent 70%)`,
                        }}/>
                    )}
                  </AnimatePresence>

                  <div style={{position:"relative",zIndex:1}}>
                    <motion.div whileHover={{rotate:8,scale:1.1}} transition={SPRING}
                      style={{width:34,height:34,borderRadius:"10px",marginBottom:"14px",flexShrink:0,
                        background:`${c.color}16`,border:`1px solid ${c.color}28`,
                        display:"flex",alignItems:"center",justifyContent:"center",color:c.color,
                        boxShadow:hov?`0 0 16px ${c.color}35`:"none",transition:"box-shadow 0.3s",
                      }}>
                      {c.icon}
                    </motion.div>
                    <p style={{fontSize:"10px",color:T.textDim,marginBottom:"3px",textTransform:"uppercase",letterSpacing:"0.08em"}}>{c.title}</p>
                    <p style={{fontSize:"26px",fontWeight:900,color:T.text,letterSpacing:"-0.03em",lineHeight:1,marginBottom:"8px"}}>
                      <Counter value={c.value}/>
                    </p>
                    <p style={{fontSize:"11px",color:T.textMid,lineHeight:1.55,marginBottom:"12px"}}>{c.desc}</p>
                    <span style={{fontSize:"9px",fontWeight:700,padding:"3px 9px",borderRadius:"20px",
                      background:`${c.color}12`,color:c.color,border:`1px solid ${c.color}22`,
                      boxShadow:hov?`0 0 10px ${c.color}25`:"none",transition:"box-shadow 0.3s",
                    }}>{c.detail}</span>
                  </div>
                  <motion.div
                    animate={{width:hov?"70%":"45%"}} transition={{duration:0.5,ease:"easeOut"}}
                    style={{position:"absolute",bottom:0,left:0,height:"2px",
                      background:`linear-gradient(to right,${c.color},transparent)`,
                      boxShadow:hov?`0 0 8px ${c.color}`:"none",
                    }}
                  />
                </motion.div>
              );
            })}
          </motion.div>

          <div
            id="report-root"
            style={{
              position:"fixed",
              left:"-10000px",
              top:0,
              width:"960px",
              padding:"32px",
              boxSizing:"border-box",
              background:T.bg,
              color:T.text,
            }}
          >
            <div style={{marginBottom:"24px",paddingBottom:"18px",borderBottom:`1px solid ${T.border}`}}>
              <h1 style={{fontSize:"30px",fontWeight:900,letterSpacing:"-0.03em",margin:"0 0 10px"}}>Solar Feasibility Report</h1>
              <p style={{fontSize:"13px",color:T.textMid,margin:"0 0 4px"}}>Generated: {initialDate.toLocaleDateString("en-IN")}</p>
              <p style={{fontSize:"13px",color:T.textMid,margin:"0 0 4px"}}>Location: {curSite.name}</p>
              <p style={{fontSize:"13px",color:T.textMid,margin:"0"}}>System: {curHW.brand} {curHW.model} · {metrics.n} panels</p>
              {annualCoveragePct > 100 && (
                <p style={{fontSize:"13px",color:T.teal,margin:"12px 0 0"}}>
                  System exceeds yearly demand by {annualSurplusKwh.toLocaleString("en-IN")} kWh and can export surplus energy.
                </p>
              )}
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"12px",marginBottom:"24px"}}>
              {[
                {label:"System Capacity",value:`${metrics.kw.toFixed(1)} kW`},
                {label:"Annual Production",value:`${metrics.kwh.toLocaleString("en-IN")} kWh`},
                {label:"Energy Coverage",value:`${annualCoveragePct}%`},
                {label:"CO2 Reduction",value:`${annualCo2Display} t/yr`},
              ].map((item)=>(
                <div key={item.label} style={{padding:"14px 16px",borderRadius:"12px",background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`}}>
                  <p style={{fontSize:"10px",textTransform:"uppercase",letterSpacing:"0.08em",color:T.textDim,margin:"0 0 6px"}}>{item.label}</p>
                  <p style={{fontSize:"20px",fontWeight:800,margin:0}}>{item.value}</p>
                </div>
              ))}
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
              <div style={{padding:"18px",borderRadius:"14px",background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`}}>
                <h2 style={{fontSize:"15px",fontWeight:800,margin:"0 0 14px"}}>System Configuration</h2>
                {[
                  ["Site Type", curSite.type],
                  ["Hardware", `${curHW.brand} ${curHW.model}`],
                  ["Panel Count", `${metrics.n}`],
                  ["Panel Efficiency", `${curHW.efficiency}%`],
                  ["Total Capacity", `${metrics.kw.toFixed(1)} kW`],
                ].map(([label,value])=>(
                  <div key={label} style={{display:"flex",justifyContent:"space-between",gap:"12px",padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
                    <span style={{fontSize:"12px",color:T.textDim}}>{label}</span>
                    <span style={{fontSize:"12px",fontWeight:700,color:T.text}}>{value}</span>
                  </div>
                ))}
              </div>

              <div style={{padding:"18px",borderRadius:"14px",background:"rgba(255,255,255,0.03)",border:`1px solid ${T.border}`}}>
                <h2 style={{fontSize:"15px",fontWeight:800,margin:"0 0 14px"}}>Energy & Impact</h2>
                {[
                  ["Annual Demand", `${annualConsumption.toLocaleString("en-IN")} kWh`],
                  ["Annual Generation", `${metrics.kwh.toLocaleString("en-IN")} kWh`],
                  ["Surplus / Export", `${annualSurplusKwh.toLocaleString("en-IN")} kWh`],
                  ["CO2 Saved / Year", `${annualCo2Display} t`],
                  ["CO2 Saved / 25 Years", `${annualCo2LifetimeDisplay} t`],
                ].map(([label,value])=>(
                  <div key={label} style={{display:"flex",justifyContent:"space-between",gap:"12px",padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
                    <span style={{fontSize:"12px",color:T.textDim}}>{label}</span>
                    <span style={{fontSize:"12px",fontWeight:700,color:T.text}}>{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* CTA */}
          {done&&(
            <motion.div variants={fadeUp} whileInView="visible" initial="hidden" viewport={{once:true}}>
              <div style={{...cs,padding:"40px 44px",textAlign:"center",position:"relative",overflow:"hidden",
                  background:`linear-gradient(135deg,rgba(59,130,246,0.06),rgba(14,165,233,0.03),rgba(0,0,0,0))`,
                  border:`1px solid ${T.tealBorder}`,
                  boxShadow:`0 0 60px rgba(0,212,170,0.06), 0 8px 40px rgba(0,0,0,0.4)`,
              }}>
                    <CTABeam/>
                    <div style={{position:"relative",zIndex:1}}>
                      <motion.p
                        animate={{opacity:[0.7,1,0.7]}} transition={{duration:3,repeat:Infinity,ease:"easeInOut"}}
                        style={{fontSize:"10px",fontWeight:700,letterSpacing:"0.12em",color:T.teal,textTransform:"uppercase",marginBottom:"10px"}}
                      >
                        Analysis Complete · {curSite.name}
                      </motion.p>
                      <h2 style={{fontSize:"34px",fontWeight:900,color:T.text,letterSpacing:"-0.03em",margin:"0 0 10px"}}>
                        Ready to go solar?
                      </h2>
                      <p style={{fontSize:"13px",color:T.textMid,maxWidth:"420px",margin:"0 auto 28px",lineHeight:1.65}}>
                        {SHOW_PRICING
                          ? "Your AI analysis is locked in. Get an installer quote or download the full feasibility report."
                          : "Your AI analysis is locked in. Request installer contact or download the full feasibility report."}
                      </p>
                      <div style={{display:"flex",gap:"10px",justifyContent:"center",flexWrap:"wrap"}}>
                        {/* Primary CTA with pulsing halo */}
                        <div style={{position:"relative"}}>
                          <motion.div
                            animate={{scale:[1,1.35,1],opacity:[0.4,0,0.4]}}
                            transition={{duration:2.5,repeat:Infinity,ease:"easeOut"}}
                            style={{position:"absolute",inset:-4,borderRadius:"13px",
                              background:T.green,filter:"blur(8px)",zIndex:0,
                            }}
                          />
                          <motion.button
                            whileHover={{scale:1.05}} whileTap={{scale:0.93}}
                            onHoverStart={()=>setCtaBtnHov(true)} onHoverEnd={()=>setCtaBtnHov(false)}
                            aria-label={SHOW_PRICING ? "Get installer quote" : "Request installer contact"}
                            style={{position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:"6px",
                              padding:"11px 26px",borderRadius:"10px",background:T.green,border:"none",
                              color:"#fff",fontSize:"13px",fontWeight:700,cursor:"pointer",overflow:"hidden",
                              boxShadow:`0 0 ${ctaBtnHov?"40px":"20px"} rgba(34,197,94,${ctaBtnHov?"0.55":"0.32"})`,
                              transition:"box-shadow 0.3s",
                            }}>
                            <AnimatePresence>
                              {ctaBtnHov&&(
                                <motion.div
                                  initial={{x:"-100%"}} animate={{x:"200%"}} transition={{duration:0.45,ease:"easeInOut"}}
                                  style={{position:"absolute",top:0,left:0,width:"40%",height:"100%",
                                    background:"linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent)",
                                    pointerEvents:"none",
                                  }}
                                />
                              )}
                            </AnimatePresence>
                            <Download size={14}/>{SHOW_PRICING ? "Get Installer Quote" : "Request Installer Contact"}
                          </motion.button>
                        </div>

                        <motion.button
                          whileHover={{scale:1.03,borderColor:T.borderHi}} whileTap={{scale:0.96}}
                          aria-label="Download full rooftop report"
                          style={{display:"flex",alignItems:"center",gap:"6px",padding:"11px 26px",borderRadius:"10px",
                            background:"rgba(255,255,255,0.05)",border:`1px solid ${T.borderHi}`,
                            color:T.text,fontSize:"13px",fontWeight:600,cursor:"pointer",backdropFilter:"blur(14px)",
                          }}>
                          <FileText size={14}/>Download Full Report
                        </motion.button>
                      </div>
                    </div>
                  </div>
            </motion.div>
          )}
        </main>
      </motion.div>
    </div>
  );
}

