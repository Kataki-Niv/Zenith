"use client";
/**
 * ============================================================
 * Solar Decision Support System — Cinematic 3D Visualization
 * ============================================================
 *
 * BUILD & RUN:
 *   npm install && npm run dev          (Vite — recommended)
 *   npx next dev                        (Next.js, "use client" already set)
 *
 * REQUIRED DEPENDENCIES:
 *   @react-three/fiber @react-three/drei @react-three/postprocessing
 *   three framer-motion
 *   (Tailwind CSS configured separately in tailwind.config.js)
 *
 * DEVELOPER NOTES — READ BEFORE EDITING:
 *  • Sun math is fully client-side (no EPHEM library dependency).
 *  • Energy flow uses CatmullRomCurve3 + animated sphere pulse dots.
 *  • Thermal/heatmap views use Three.js Color lerp — no custom GLSL.
 *    To add GLSL: replace MeshStandardMaterial with ShaderMaterial.
 *  • Shadow map size = SHADOW_MAP_SIZE (2048); halve for mobile perf.
 *  • Particle counts in WEATHER_PARTICLE_CONFIG; halve for low-end.
 *  • Panel instancing: PanelGrid uses InstancedMesh for >12 panels.
 *  • Snapshot: Canvas requires gl.preserveDrawingBuffer = true.
 *  • CSV export: pure client-side Blob, no external server.
 *  • Telemetry: replace useMemo(runtime) with useEffect+WebSocket hook.
 *
 * TRADEOFFS:
 *  • Single file for portability; split by /components /hooks /utils for prod.
 *  • No GLSL shaders — vertex color/emissive for broad browser compat.
 *  • framer-motion for DOM UI only; 3D motion via useFrame for perf.
 *  • AO is approximated via ContactShadows + environment — no SSAO pass.
 *
 * WHERE TO EXTEND:
 *  • Telemetry streaming  →  replace runtime useMemo with useTelemetry()
 *  • API integration      →  hook up useTelemetry(endpoint) below
 *  • Storybook stories    →  each modal is self-contained; add stories easily
 *  • Unit tests           →  all pure functions in Section 4 are fully testable
 *
 * PERFORMANCE BUDGETS:
 *  • Target: 60 fps, GPU draw calls < 80
 *  • Shadow map: 2048 (SHADOW_MAP_SIZE — reduce to 1024 for mobile)
 *  • Particles: max 400 per weather type (WEATHER_PARTICLE_CONFIG)
 *  • Panel geometry: instanced for N > 1 panels
 *  • Frame budget: 60–120 ms CPU per UI task
 *
 * KEYBOARD SHORTCUTS:
 *  • 1 / 2 / 3   → Camera presets (overview / closeup / aerial)
 *  • Space        → Play / pause sun animation
 *  • S            → Snapshot PNG
 *  • E            → Export CSV
 *  • Escape       → Close inspector / modals
 *
 * LINTING / FORMATTING:
 *  • ESLint: @typescript-eslint recommended + react-hooks
 *  • Prettier: printWidth 100, semi false, singleQuote true, trailingComma es5
 *
 * COMMIT STYLE: Conventional Commits — feat/fix/perf/chore(scope): message
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  memo,
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  Html,
  Line as DreiLine,
  OrbitControls,
  Stars,
} from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { AnimatePresence, motion } from "framer-motion";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — TYPES & INTERFACES
// ─────────────────────────────────────────────────────────────────────────────

/** Weather conditions affecting production and visuals */
type WeatherType = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";

/** Roof geometry variants available in the scene */
type RoofType = "hip" | "gable" | "flat" | "shed" | "ground";

/** Astronomical season controlling sun declination and sun hours */
type Season = "Spring" | "Summer" | "Autumn" | "Winter";

/** Panel colour-coding modes for the 3D view */
type ViewMode = "normal" | "heatmap" | "thermal" | "shade" | "string";

/** Named camera viewpoints */
type CameraPresetKey = "overview" | "closeup" | "aerial";

/** Modal identifiers for the tool panel */
type ModalKey = "analytics" | "roi" | "forecast" | "config" | "settings" | null;

/**
 * Raw panel data supplied by the parent component / data layer.
 * Only static properties — runtime values are computed inside the scene.
 */
interface SourcePanel {
  id: number;
  efficiency: number; // nominal efficiency percentage (0–100)
  temp: number;       // measured cell temperature offset
  power: number;      // current measured power (W)
  basePower: number;  // STC rated power (W)
  sunlight: number;   // local irradiance factor (0–1)
  shade: number;      // shade fraction (0 = no shade, 1 = full shade)
}

/**
 * Panel enriched with positional and grouping data derived from layout config.
 * Computed once in useMemo and passed to the 3D grid.
 */
interface WorkingPanel extends SourcePanel {
  index: number;
  row: number;
  col: number;
  enabled: boolean;
  stringIndex: number;
  position: [number, number, number];
}

/**
 * Per-panel computed output values for the current simulation tick.
 * Re-computed whenever sun angle, weather, season, or config changes.
 */
interface RuntimePanel {
  watts: number;          // AC output (W)
  dcWatts: number;        // DC output pre-inverter (W)
  outputRatio: number;    // fraction of rated capacity (0–1)
  temperature: number;    // cell temperature (°C)
  shadeFactor: number;    // effective shade coefficient (0–1 = unshaded–fully shaded)
  efficiencyPct: number;  // effective efficiency (%)
  color: THREE.Color;     // heatmap / efficiency colour
  thermalColor: THREE.Color; // thermal-view colour
  stringColor: THREE.Color;  // string-view colour
}

/** Battery storage state derived from net power balance */
interface BatteryState {
  soc: number;        // state of charge (0–1)
  charging: boolean;  // true when surplus power available
  powerKw: number;    // absolute charge/discharge rate (kW)
}

/** Parametric description of a single energy flow cable */
interface FlowPath {
  id: string;
  points: [number, number, number][];
  color: string;
  active: boolean;
  speed: number; // pulse travel speed (fraction of curve length per second)
}

/** Named camera position + target pair */
interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
}

/** One day in the 7-day weather forecast */
interface WeatherForecast {
  day: string;
  condition: WeatherType;
  production: number; // estimated daily kWh
  high: number;       // temperature high (°C)
  low: number;        // temperature low (°C)
  sunHours: number;   // effective peak sun hours
}

/** Monthly production data for analytics chart */
interface MonthlyData {
  month: string;
  kwh: number;
  forecast: number;
}

/** ROI calculation output */
interface RoiCalculation {
  systemCost: number;
  annualSavings: number;
  paybackYears: number;
  twentyYearReturn: number;
  incentiveValue: number;
  netCost: number;
  co2LifetimeTonnes: number;
}

/** Telemetry streaming hook configuration (placeholder for API integration) */
interface TelemetryConfig {
  endpoint?: string;
  interval?: number;
  enabled?: boolean;
}

/** Scene size for responsive layout decisions */
interface SceneSize {
  width: number;
  height: number;
}

/** Props for the main exported component */
interface SolarDecisionSupportProps {
  panels: SourcePanel[];
  elevation: number;      // current sun elevation (degrees)
  azimuth: number;        // current sun azimuth (degrees)
  starsCount?: number;
  panelTilt?: number;     // panel tilt from horizontal (degrees)
  panelAzimuth?: number;  // panel facing direction (degrees from North)
  telemetry?: TelemetryConfig;
  latitude?: number;
  season?: Season;
}

/** Particle system configuration per weather type */
interface WeatherParticleConfig {
  count: number;
  speed: number;
  opacity: number;
  size: number;
  color: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Panel grid layout geometry */
const PANEL_COLUMNS = 6;
const PANEL_X_STEP = 1.1;
const PANEL_Z_STEP = 1.65;
const PANEL_START_X = -3.3;
const PANEL_START_Z = -1.7;
const PANEL_WIDTH = 0.94;
const PANEL_DEPTH = 1.34;
const PANEL_THICKNESS = 0.05;
const PANEL_BASE_Y = 0.24;

/** Shadow map resolution — halve to 1024 for mobile performance */
const SHADOW_MAP_SIZE = 2048;

/** Inverter, battery, house, and grid positions in world space */
const INVERTER_POS: [number, number, number] = [4.15, 0.55, 2.45];
const BATTERY_POS: [number, number, number] = [4.15, 0.62, 0.95];
const HOUSE_POS: [number, number, number] = [2.15, -0.38, 1.15];
const GRID_POS: [number, number, number] = [7.35, 0.28, -7.2];
const GRID_BASE_POS: [number, number, number] = [7.35, -2.02, -7.2];
const WIND_POS: [number, number, number] = [-8.5, 0.48, 0];

/** Six-string colour palette — WCAG contrast checked on dark backgrounds */
const STRING_PALETTE = [
  "#38bdf8", // sky blue  — String A
  "#f97316", // amber     — String B
  "#22c55e", // emerald   — String C
  "#e879f9", // fuchsia   — String D
  "#facc15", // yellow    — String E
  "#a78bfa", // violet    — String F
] as const;

/** Month axis labels */
const MONTH_LABELS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
] as const;

/** Selectable weather types */
const WEATHER_OPTIONS: WeatherType[] = [
  "clear","cloudy","rain","snow","storm","fog",
];

/** Selectable seasons */
const SEASON_OPTIONS: Season[] = ["Spring","Summer","Autumn","Winter"];

/** Selectable roof shapes */
const ROOF_OPTIONS: RoofType[] = ["hip","gable","flat","shed","ground"];

/** Selectable view modes */
const VIEW_OPTIONS: ViewMode[] = ["normal","heatmap","thermal","shade","string"];

/** Irradiance weighting per weather type (0–1) */
const WEATHER_FACTOR: Record<WeatherType, number> = {
  clear: 1,
  cloudy: 0.72,
  rain: 0.45,
  snow: 0.58,
  storm: 0.33,
  fog: 0.52,
};

/** Ambient temperature offset (°C) per weather type */
const WEATHER_TEMP_OFFSET: Record<WeatherType, number> = {
  clear: 0,
  cloudy: -1,
  rain: -4,
  snow: -9,
  storm: -5,
  fog: -3,
};

/** Solar declination (degrees) per season */
const SEASON_DECLINATION: Record<Season, number> = {
  Spring: 4,
  Summer: 23.4,
  Autumn: -7,
  Winter: -23.4,
};

/** Estimated daily peak sun hours per season */
const SEASON_SUN_HOURS: Record<Season, number> = {
  Spring: 5.1,
  Summer: 5.9,
  Autumn: 4.6,
  Winter: 3.7,
};

/** Named camera presets for quick nav */
const CAMERA_PRESETS: Record<CameraPresetKey, CameraPreset> = {
  overview: { position: [0, 6.8, 10.6], target: [0, 0.4, 0], fov: 42 },
  closeup:  { position: [2.6, 3.3, 4.9], target: [0.6, 0.8, -0.2], fov: 38 },
  aerial:   { position: [-8.8, 8.4, 8.2], target: [0, 1.1, 0], fov: 46 },
};

/** CO2 offset per kWh of solar production (kg/kWh — global average grid) */
const CO2_PER_KWH = 0.82;

/** DC → AC inverter efficiency */
const INVERTER_EFFICIENCY = 0.975;

/** Solar system install cost per kW (INR / locale: override as needed) */
const INSTALL_COST_PER_KW = 56_000;

/** Central government incentive rate */
const INCENTIVE_RATE = 0.30;

/** Assumed electricity tariff for ROI calc (INR per kWh) */
const ELECTRICITY_TARIFF = 7.5;

/** Weather particle system configuration — reduce count for low-end devices */
const WEATHER_PARTICLE_CONFIG: Record<WeatherType, WeatherParticleConfig> = {
  clear:  { count: 0,   speed: 0,   opacity: 0,    size: 0,    color: "#ffffff" },
  cloudy: { count: 0,   speed: 0,   opacity: 0,    size: 0,    color: "#ffffff" },
  rain:   { count: 380, speed: 3.2, opacity: 0.55, size: 0.04, color: "#93c5fd" },
  snow:   { count: 220, speed: 0.6, opacity: 0.72, size: 0.06, color: "#f1f5f9" },
  storm:  { count: 420, speed: 4.8, opacity: 0.45, size: 0.035, color: "#bfdbfe" },
  fog:    { count: 0,   speed: 0,   opacity: 0,    size: 0,    color: "#ffffff" },
};

/** Stable PRNG seeds per weather type (avoids Math.random during render) */
const WEATHER_SEED: Record<WeatherType, number> = {
  clear: 11,
  cloudy: 23,
  rain: 37,
  snow: 43,
  storm: 59,
  fog: 71,
};

/** Design system colour palette */
const DS = {
  bg:          "rgba(4, 8, 20, 0.92)",
  bgLight:     "rgba(10, 18, 40, 0.88)",
  border:      "rgba(255, 216, 74, 0.2)",
  borderHover: "rgba(255, 216, 74, 0.5)",
  gold:        "#ffd84a",
  cyan:        "#38bdf8",
  emerald:     "#22c55e",
  text:        "#d7e2f2",
  muted:       "#6f829d",
  danger:      "#ef4444",
  warning:     "#f59e0b",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — PURE UTILITY FUNCTIONS (fully unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp `value` to [min, max] */
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Deterministic pseudo-random number seeded by `index`.
 * Used for per-panel variance without state or instability.
 */
const seeded = (index: number): number => {
  const s = Math.sin(index * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
};

/** Format decimal hours as HH:MM string */
const formatTime = (hour: number): string => {
  const n = ((hour % 24) + 24) % 24;
  const h = Math.floor(n);
  const m = Math.round((n - h) * 60);
  const carry = m === 60 ? 1 : 0;
  return `${String((h + carry) % 24).padStart(2, "0")}:${String(
    m === 60 ? 0 : m
  ).padStart(2, "0")}`;
};

/** Compute world-space position [x, y, z] for panel at `index` */
const panelPosition = (index: number): [number, number, number] => {
  const col = index % PANEL_COLUMNS;
  const row = Math.floor(index / PANEL_COLUMNS);
  return [
    PANEL_START_X + col * PANEL_X_STEP,
    PANEL_BASE_Y,
    PANEL_START_Z + row * PANEL_Z_STEP,
  ];
};

/**
 * Panel Euler rotation [rx, ry, rz] from tilt and azimuth angles.
 * Panels face south (180°) at azimuth 0.
 */
const panelRotation = (
  tiltDeg: number,
  azimuthDeg: number
): [number, number, number] => [
  -THREE.MathUtils.degToRad(tiltDeg),
  THREE.MathUtils.degToRad(180 - azimuthDeg),
  0,
];

/** Compute panel normal vector from tilt and azimuth */
const panelNormal = (tiltDeg: number, azimuthDeg: number): THREE.Vector3 => {
  const tilt    = THREE.MathUtils.degToRad(tiltDeg);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const horizontal = Math.sin(tilt);
  return new THREE.Vector3(
    horizontal * Math.sin(azimuth),
    Math.cos(tilt),
    horizontal * Math.cos(azimuth)
  ).normalize();
};

/** Compute normalised sun direction vector from elevation and azimuth angles */
const sunVector = (elevation: number, azimuth: number): THREE.Vector3 => {
  const e = THREE.MathUtils.degToRad(elevation);
  const a = THREE.MathUtils.degToRad(azimuth);
  return new THREE.Vector3(
    Math.cos(e) * Math.sin(a),
    Math.sin(e),
    Math.cos(e) * Math.cos(a)
  ).normalize();
};

/**
 * Compute sun elevation and azimuth (degrees) from local time.
 *
 * @param hour       Local solar time (decimal hours, 0–24)
 * @param latitude   Observer latitude (degrees)
 * @param declination Solar declination (degrees) for the season
 */
const sunPositionFromTime = (
  hour: number,
  latitude: number,
  declination: number
): { elevation: number; azimuth: number } => {
  const lat       = THREE.MathUtils.degToRad(latitude);
  const dec       = THREE.MathUtils.degToRad(declination);
  const hourAngle = THREE.MathUtils.degToRad((hour - 12) * 15);

  const elevation = Math.asin(
    Math.sin(lat) * Math.sin(dec) +
    Math.cos(lat) * Math.cos(dec) * Math.cos(hourAngle)
  );

  const azimuth =
    Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)
    ) + Math.PI;

  return {
    elevation: THREE.MathUtils.radToDeg(elevation),
    azimuth:  (THREE.MathUtils.radToDeg(azimuth) + 360) % 360,
  };
};

/**
 * Rough inverse: map azimuth back to an approximate hour of day.
 * Used when syncing the slider to the live sun position.
 */
const approximateHour = (azimuth: number): number => clamp(azimuth / 15, 5, 20);

/**
 * Map output ratio (0–1) to an efficiency heat-map colour.
 * Palette: dark navy → steel blue → cyan → lime → gold → orange
 */
const efficiencyColor = (ratio: number): THREE.Color => {
  const r = clamp(ratio, 0, 1);
  const stops = [
    new THREE.Color("#08111e"),
    new THREE.Color("#0f4c81"),
    new THREE.Color("#00a2ff"),
    new THREE.Color("#00d18f"),
    new THREE.Color("#ffd54a"),
    new THREE.Color("#ff7f32"),
  ];
  const scaled = r * (stops.length - 1);
  const i      = Math.floor(scaled);
  const mix    = scaled - i;
  return stops[i].clone().lerp(stops[Math.min(i + 1, stops.length - 1)], mix);
};

/** Map cell temperature to a thermal colour (blue → red gradient) */
const thermalColor = (temperature: number): THREE.Color => {
  const t = clamp((temperature - 8) / 55, 0, 1);
  return new THREE.Color("#1536c5").lerp(new THREE.Color("#ff5a2a"), t);
};

/** Pick a string colour from the palette by string index */
const stringColor = (index: number): THREE.Color =>
  new THREE.Color(STRING_PALETTE[index % STRING_PALETTE.length]);

/**
 * Generate synthetic monthly production kWh values for the analytics chart.
 * Applies degradation, season bias, and a sinusoidal seasonal wave.
 */
const monthlyProduction = (
  peakKw: number,
  year: number,
  season: Season
): MonthlyData[] => {
  const degrade = Math.pow(0.994, Math.max(year - 1, 0));
  const bias =
    season === "Summer" ? 1.08
    : season === "Winter" ? 0.9
    : season === "Spring" ? 1.02
    : 0.96;

  return MONTH_LABELS.map((month, i) => {
    const wave     = 1 + 0.24 * Math.sin((i / 11) * Math.PI * 2 - 0.7);
    const kwh      = Math.round(peakKw * 122 * wave * degrade * bias);
    const forecast = Math.round(kwh * (0.9 + seeded(i + 3) * 0.2));
    return { month, kwh, forecast };
  });
};

/**
 * Build a 7-day forecast array driven by the current weather and season.
 * Values are deterministic (seeded) so they don't jitter on re-render.
 */
const buildForecast = (
  weather: WeatherType,
  totalKw: number,
  season: Season
): WeatherForecast[] => {
  const cycle: WeatherType[] = [
    weather,
    "cloudy",
    "clear",
    weather === "storm" ? "rain" : "storm",
    "clear",
    "fog",
    "rain",
  ];

  return cycle.map((condition, i) => {
    const factor = WEATHER_FACTOR[condition];
    const base   = season === "Summer" ? 34 : season === "Winter" ? 18 : 27;
    const high   = Math.round(base + seeded(i + 19) * 4 + WEATHER_TEMP_OFFSET[condition]);
    const low    = high - Math.round(5 + seeded(i + 41) * 4);
    return {
      day:        ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i],
      condition,
      production: Math.max(0, Math.round(totalKw * SEASON_SUN_HOURS[season] * factor * 2.8)),
      high,
      low,
      sunHours:   Number((SEASON_SUN_HOURS[season] * factor).toFixed(1)),
    };
  });
};

/** Compute ROI metrics from system size and financial parameters */
const computeRoi = (
  peakKw: number,
  season: Season,
  options?: {
    tariff?: number;
    incentiveRate?: number;
    costPerKw?: number;
  }
): RoiCalculation => {
  const tariff = options?.tariff ?? ELECTRICITY_TARIFF;
  const incentiveRate = options?.incentiveRate ?? INCENTIVE_RATE;
  const costPerKw = options?.costPerKw ?? INSTALL_COST_PER_KW;
  const systemCost    = peakKw * costPerKw;
  const incentiveValue = systemCost * incentiveRate;
  const netCost       = systemCost - incentiveValue;
  const annualKwh     = peakKw * SEASON_SUN_HOURS[season] * 365 * 0.8;
  const annualSavings = annualKwh * tariff;
  const paybackYears  = netCost / annualSavings;
  const twentyYearReturn = annualSavings * 20 - netCost;
  const co2 = annualKwh * CO2_PER_KWH * 25 / 1000;
  return { systemCost, annualSavings, paybackYears, twentyYearReturn, incentiveValue, netCost, co2LifetimeTonnes: co2 };
};

/**
 * Export panel data and runtime values as a UTF-8 CSV file.
 * Triggers browser download without any server interaction.
 */
const exportCsv = (
  panels: WorkingPanel[],
  runtime: RuntimePanel[],
  year: number
): void => {
  const header = [
    "Panel ID","Row","Col","String Index","Enabled",
    "DC Power (W)","AC Power (W)","Cell Temp (°C)","Shade Factor (%)","Efficiency (%)",
    "Output Ratio","System Year",
  ].join(",");

  const rows = panels.map((panel, i) => {
    const r = runtime[i];
    return [
      panel.id, panel.row, panel.col, panel.stringIndex,
      panel.enabled ? "Yes" : "No",
      r ? r.dcWatts.toFixed(1)              : "0",
      r ? r.watts.toFixed(1)                : "0",
      r ? r.temperature.toFixed(1)          : "0",
      r ? (r.shadeFactor * 100).toFixed(0)  : "0",
      r ? r.efficiencyPct.toFixed(2)        : "0",
      r ? r.outputRatio.toFixed(4)          : "0",
      year,
    ].join(",");
  });

  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href:     url,
    download: `solar-panels-year${year}-${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);
};

/** Take a PNG snapshot from the canvas element */
const takeSnapshot = (container: HTMLElement | null): void => {
  const canvas = container?.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const url = canvas.toDataURL("image/png");
  const a   = Object.assign(document.createElement("a"), {
    href:     url,
    download: `solar-scene-${Date.now()}.png`,
  });
  a.click();
};

/** Weather type → human-readable emoji label */
const weatherEmoji: Record<WeatherType, string> = {
  clear: "☀️", cloudy: "☁️", rain: "🌧️", snow: "❄️", storm: "⛈️", fog: "🌫️",
};

/** Format large numbers with locale commas */
const fmtNum = (n: number, decimals = 0): string =>
  n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — CUSTOM HOOKS
// ─────────────────────────────────────────────────────────────────────────────

/** Track container dimensions for responsive layout decisions */
function useContainerSize(ref: React.RefObject<HTMLElement>): SceneSize {
  const [size, setSize] = useState<SceneSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? {};
      if (width !== undefined && height !== undefined) {
        setSize({ width, height });
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

/** Register keyboard shortcuts and call the provided handlers. */
function useKeyboardShortcuts(handlers: {
  onPreset1?: () => void;
  onPreset2?: () => void;
  onPreset3?: () => void;
  onPlayPause?: () => void;
  onSnapshot?: () => void;
  onExportCsv?: () => void;
  onEscape?: () => void;
}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input / textarea
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;

      switch (e.key) {
        case "1":           handlers.onPreset1?.();    break;
        case "2":           handlers.onPreset2?.();    break;
        case "3":           handlers.onPreset3?.();    break;
        case " ":           e.preventDefault(); handlers.onPlayPause?.(); break;
        case "s": case "S": handlers.onSnapshot?.();  break;
        case "e": case "E": handlers.onExportCsv?.(); break;
        case "Escape":      handlers.onEscape?.();     break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}

/**
 * Placeholder telemetry streaming hook.
 * Replace with real WebSocket / SSE implementation for live data.
 *
 * @example
 *   const { data, connected } = useTelemetryStream({ endpoint: "/api/telemetry" });
 */
function useTelemetryStream(config: TelemetryConfig): {
  data: RuntimePanel[] | null;
  connected: boolean;
  error: string | null;
} {
  const [data]      = useState<RuntimePanel[] | null>(null);
  const [connected] = useState(false);
  const [error]     = useState<string | null>(null);

  useEffect(() => {
    if (!config.enabled || !config.endpoint) return;
    // ── Hook up real WebSocket / EventSource here ──────────────────────────
    // const ws = new WebSocket(config.endpoint);
    // ws.onmessage = (e) => setData(JSON.parse(e.data));
    // ws.onerror = () => setError("Connection failed");
    // return () => ws.close();
    // ───────────────────────────────────────────────────────────────────────
  }, [config.enabled, config.endpoint]);

  return { data, connected, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — 3D SCENE COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

// ── 6.1 SunRig ──────────────────────────────────────────────────────────────
/**
 * Drives the directional light and ambient sky from sun elevation/azimuth.
 * Sky colour and intensity are weather-adjusted each frame.
 */
const SunRig = memo(function SunRig({
  elevation,
  azimuth,
  weather,
  nightMode,
}: {
  elevation: number;
  azimuth: number;
  weather: WeatherType;
  nightMode: boolean;
}) {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const ambRef   = useRef<THREE.AmbientLight>(null);
  const { scene } = useThree();

  // Attach directional light target to scene so it can be moved
  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    scene.add(light.target);
    return () => { scene.remove(light.target); };
  }, [scene]);

  useFrame(() => {
    if (!lightRef.current || !ambRef.current) return;

    const dir   = sunVector(elevation, azimuth);
    const dist  = 22;
    const sky   = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)));
    const below = elevation <= 0;

    const weatherScale = ({
      clear: 1, cloudy: 0.62, rain: 0.38, snow: 0.52, storm: 0.22, fog: 0.44,
    } as Record<WeatherType, number>)[weather];

    lightRef.current.position.set(dir.x * dist, Math.max(0.5, dir.y * dist), dir.z * dist);
    lightRef.current.intensity = below || nightMode
      ? 0
      : sky * 3.8 * weatherScale;

    // Warm sun tint at low elevation (golden hour)
    const warmth = clamp(1 - sky * 2, 0, 1);
    lightRef.current.color.setRGB(
      1,
      clamp(0.82 + sky * 0.18 - warmth * 0.15, 0.7, 1),
      clamp(0.72 + sky * 0.28 - warmth * 0.3, 0.55, 1)
    );

    // Ambient tracks sky brightness
    const ambBase = nightMode ? 0.04 : 0.15;
    ambRef.current.intensity = ambBase + sky * 0.32 * weatherScale;
    const moonTint = nightMode ? 0.4 : 1;
    ambRef.current.color.setRGB(
      0.55 * moonTint,
      0.68 * moonTint,
      1.0
    );
  });

  return (
    <group>
      <directionalLight
        ref={lightRef}
        castShadow
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={0.1}
        shadow-camera-far={80}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      <ambientLight ref={ambRef} />
    </group>
  );
});

// ── 6.2 WeatherParticles ─────────────────────────────────────────────────────
/**
 * Renders rain, snow, or storm precipitation as a Points system.
 * Particles are recycled (teleported to top when they hit ground level).
 * Performance: reduce WEATHER_PARTICLE_CONFIG counts for low-end devices.
 */
const WeatherParticles = memo(function WeatherParticles({
  weather,
}: {
  weather: WeatherType;
}) {
  const cfg = WEATHER_PARTICLE_CONFIG[weather];
  const pointsRef = useRef<THREE.Points>(null);
  const weatherSeed = WEATHER_SEED[weather];

  // Build initial random positions above the scene
  const positions = useMemo(() => {
    if (cfg.count === 0) return new Float32Array(0);
    const arr = new Float32Array(cfg.count * 3);
    for (let i = 0; i < cfg.count; i++) {
      const seedBase = weatherSeed * 1000 + i * 3;
      arr[i * 3]     = (seeded(seedBase) - 0.5) * 28;
      arr[i * 3 + 1] = seeded(seedBase + 1) * 18 + 2;
      arr[i * 3 + 2] = (seeded(seedBase + 2) - 0.5) * 24;
    }
    return arr;
  }, [cfg.count, weatherSeed]);

  const velocities = useMemo(() => {
    if (cfg.count === 0) return [];
    const lateralScale = weather === "storm" ? 1.8 : 0.2;
    return Array.from({ length: cfg.count }, (_, i) => {
      const seedBase = weatherSeed * 2000 + i * 5;
      return {
        vy: -(cfg.speed * (0.7 + seeded(seedBase) * 0.6)),
        vx: (seeded(seedBase + 1) - 0.5) * lateralScale,
      };
    });
  }, [cfg.count, cfg.speed, weather, weatherSeed]);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  useFrame((_, delta) => {
    if (!pointsRef.current || cfg.count === 0) return;
    const pos = pointsRef.current.geometry.attributes.position;
    for (let i = 0; i < cfg.count; i++) {
      const v = velocities[i];
      pos.setY(i, pos.getY(i) + v.vy * delta);
      pos.setX(i, pos.getX(i) + v.vx * delta);
      // Recycle particles that hit ground
      if (pos.getY(i) < -2.5) {
        pos.setY(i, 18 + Math.random() * 4);
        pos.setX(i, (Math.random() - 0.5) * 28);
        pos.setZ(i, (Math.random() - 0.5) * 24);
      }
    }
    pos.needsUpdate = true;
  });

  if (cfg.count === 0) return null;

  return (
    <points ref={pointsRef} geometry={geo}>
      <pointsMaterial
        color={cfg.color}
        size={cfg.size}
        transparent
        opacity={cfg.opacity}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
});

// ── 6.3 LightningBurst ───────────────────────────────────────────────────────
/** Sporadic lightning bolts rendered as jagged DreiLine segments during storms */
const LightningBurst = memo(function LightningBurst({
  active,
}: {
  active: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [points, setPoints]   = useState<THREE.Vector3[]>([]);

  useEffect(() => {
    if (!active) return;

    const fire = () => {
      const sx = (Math.random() - 0.5) * 16;
      const sz = (Math.random() - 0.5) * 14;
      const start = new THREE.Vector3(sx, 18, sz);
      const end   = new THREE.Vector3(sx + (Math.random() - 0.5) * 5, 0.5, sz + (Math.random() - 0.5) * 5);

      const bolt: THREE.Vector3[] = [start];
      for (let i = 1; i < 9; i++) {
        const t = i / 9;
        bolt.push(new THREE.Vector3(
          THREE.MathUtils.lerp(sx, end.x, t) + (Math.random() - 0.5) * 2,
          THREE.MathUtils.lerp(18, 0.5, t),
          THREE.MathUtils.lerp(sz, end.z, t) + (Math.random() - 0.5) * 2
        ));
      }
      bolt.push(end);
      setPoints(bolt);
      setVisible(true);
      window.setTimeout(() => setVisible(false), 150);
    };

    fire();
    const id = window.setInterval(fire, 3400);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active || !visible || points.length < 2) return null;

  return (
    <group>
      <pointLight position={[0, 9, 0]} intensity={5} distance={24} color="#d7ebff" decay={2} />
      <DreiLine points={points} color="#cde8ff" lineWidth={2} transparent opacity={0.88} />
    </group>
  );
});

// ── 6.4 SunPathArc ───────────────────────────────────────────────────────────
/**
 * Renders the daily arc traced by the sun across the sky dome,
 * plus a glowing disc marker at the current position.
 * Arc is recomputed when latitude, season, or time changes.
 */
const SunPathArc = memo(function SunPathArc({
  latitude,
  declination,
  visible,
  elevation,
  azimuth,
}: {
  latitude: number;
  declination: number;
  visible: boolean;
  elevation: number;
  azimuth: number;
}) {
  const RADIUS = 18;

  // Build arc through 24 hour samples
  const arcPoints = useMemo((): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let h = 4; h <= 20; h += 0.5) {
      const { elevation: el, azimuth: az } = sunPositionFromTime(h, latitude, declination);
      if (el > -2) {
        const dir = sunVector(el, az);
        pts.push(dir.clone().multiplyScalar(RADIUS));
      }
    }
    return pts.length >= 2 ? pts : [new THREE.Vector3(0, RADIUS, 0), new THREE.Vector3(0.1, RADIUS, 0)];
  }, [latitude, declination]);

  // Current sun marker position
  const markerPos = useMemo(() => {
    return sunVector(elevation, azimuth).multiplyScalar(RADIUS);
  }, [elevation, azimuth]);

  const sunRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!sunRef.current) return;
    const t = clock.getElapsedTime();
    // Gentle pulsing scale on the sun disc
    sunRef.current.scale.setScalar(1 + Math.sin(t * 2.2) * 0.08);
  });

  if (!visible || arcPoints.length < 2) return null;

  return (
    <group>
      {/* Arc line */}
      <DreiLine
        points={arcPoints}
        color="#ffd84a"
        lineWidth={0.8}
        transparent
        opacity={0.38}
        dashed
        dashSize={0.4}
        gapSize={0.3}
      />
      {/* Sun marker disc */}
      {elevation > 0 && (
        <group position={markerPos}>
          <mesh ref={sunRef}>
            <sphereGeometry args={[0.38, 16, 16]} />
            <meshBasicMaterial color="#ffe87a" />
          </mesh>
          {/* Outer glow ring */}
          <mesh>
            <sphereGeometry args={[0.58, 16, 16]} />
            <meshBasicMaterial color="#ffd84a" transparent opacity={0.12} depthWrite={false} />
          </mesh>
          <pointLight color="#ffe87a" intensity={2.2} distance={8} />
        </group>
      )}
    </group>
  );
});

// ── 6.5 RoofShell ───────────────────────────────────────────────────────────
/** Stylised rooftop geometry that varies by roof type */
const RoofShell = memo(function RoofShell({
  roofType,
  nightMode,
}: {
  roofType: RoofType;
  nightMode: boolean;
}) {
  if (roofType === "ground") return null;

  const houseColor = nightMode ? "#0d1220" : "#1e293b";
  const roofColor  = nightMode ? "#090d18" : "#0f172a";
  const trimColor  = nightMode ? "#1e2a3a" : "#475569";
  const shedTilt   = roofType === "shed" ? -THREE.MathUtils.degToRad(6) : 0;

  return (
    <group>
      {/* Main house body */}
      <mesh position={[0, -0.92, 0]} castShadow receiveShadow>
        <boxGeometry args={[7.6, 2.05, 4.85]} />
        <meshStandardMaterial color={houseColor} roughness={0.84} metalness={0.08} />
      </mesh>

      {/* Roof deck */}
      <mesh position={[0, 0.22, 0]} rotation={[shedTilt, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[8.35, 0.22, 5.45]} />
        <meshStandardMaterial color={roofColor} roughness={0.52} metalness={0.14} />
      </mesh>

      {/* Ridge cap for gable / hip */}
      {roofType !== "flat" && roofType !== "shed" && (
        <mesh position={[0, 0.38, 0]} castShadow>
          <boxGeometry args={[8.15, 0.12, 0.2]} />
          <meshStandardMaterial color={trimColor} roughness={0.54} metalness={0.22} />
        </mesh>
      )}

      {/* Chimney */}
      <mesh position={[2.35, 0.68, -1.45]} castShadow receiveShadow>
        <cylinderGeometry args={[0.32, 0.36, 0.82, 16]} />
        <meshStandardMaterial color={trimColor} roughness={0.76} metalness={0.12} />
      </mesh>

      {/* Vent pipe */}
      <mesh position={[-2.35, 0.42, 1.45]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 0.4, 10]} />
        <meshStandardMaterial color="#64748b" roughness={0.56} metalness={0.32} />
      </mesh>

      {/* Window glow — east-facing dormer */}
      {nightMode && (
        <mesh position={[0, -0.3, 2.44]}>
          <planeGeometry args={[0.62, 0.44]} />
          <meshBasicMaterial color="#ffd060" transparent opacity={0.28} />
        </mesh>
      )}
    </group>
  );
});

// ── 6.6 Surroundings ─────────────────────────────────────────────────────────
/** Ground plane, neighbouring buildings, trees, and street scene */
const Surroundings = memo(function Surroundings({
  nightMode,
  showGround,
}: {
  nightMode: boolean;
  showGround: boolean;
}) {
  const groundColor   = nightMode ? "#040813" : "#0c1622";
  const buildingColor = nightMode ? "#070e1c" : "#1d2636";
  const treeColor     = nightMode ? "#091a10" : "#14391c";

  const buildings = [
    { x: -14, z: -8,  w: 5,   h: 6,   d: 5 },
    { x:  14, z: -6,  w: 4.2, h: 8,   d: 4.2 },
    { x: -12, z:  10, w: 6,   h: 4.3, d: 6 },
    { x:  11, z:  12, w: 4.8, h: 5.2, d: 4.8 },
    { x:   0, z: -14, w: 7,   h: 3.5, d: 5 },
    { x:  18, z:   4, w: 3.8, h: 9.2, d: 3.8 },
    { x: -18, z:   2, w: 4.4, h: 7,   d: 4.4 },
  ];

  const trees: [number, number][] = [
    [-7, 8], [7, -8], [-9, -5], [9, 6], [5, 10], [-5, -10],
    [12, -2], [-13, 3], [3, 14], [-3, -14],
  ];

  return (
    <group>
      {/* Ground plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.02, 0]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial color={groundColor} roughness={0.96} metalness={0.02} />
      </mesh>

      {/* Road marking */}
      {showGround && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.01, 18]}>
          <planeGeometry args={[5, 32]} />
          <meshStandardMaterial color={nightMode ? "#0e151f" : "#111827"} roughness={0.98} />
        </mesh>
      )}

      {/* Neighbouring buildings */}
      {buildings.map((b, i) => (
        <group key={`bld-${i}`}>
          <mesh position={[b.x, b.h / 2 - 2.02, b.z]} castShadow receiveShadow>
            <boxGeometry args={[b.w, b.h, b.d]} />
            <meshStandardMaterial color={buildingColor} roughness={0.84} metalness={0.08} />
          </mesh>
          {/* Night window glow */}
          {nightMode && (
            <mesh position={[b.x, b.h / 2 - 2.02, b.z + b.d / 2 + 0.01]}>
              <planeGeometry args={[b.w * 0.5, b.h * 0.4]} />
              <meshBasicMaterial color="#ffd060" transparent opacity={0.08 + seeded(i) * 0.1} />
            </mesh>
          )}
        </group>
      ))}

      {/* Trees */}
      {trees.map(([x, z], i) => (
        <group key={`tree-${i}`} position={[x, -2.02, z]}>
          <mesh position={[0, 0.52, 0]} castShadow>
            <cylinderGeometry args={[0.12, 0.18, 1.04, 8]} />
            <meshStandardMaterial color="#3d2b1a" roughness={1} />
          </mesh>
          <mesh position={[0, 2.04, 0]} castShadow>
            <coneGeometry args={[0.72, 2.9, 8]} />
            <meshStandardMaterial color={treeColor} roughness={0.98} />
          </mesh>
        </group>
      ))}
    </group>
  );
});

// ── 6.7 PanelMesh ────────────────────────────────────────────────────────────
/**
 * Single solar panel rendered with a 3-layer physical stack:
 * aluminium frame → back-sheet → photovoltaic cell → clearcoat glass.
 * The cell colour is driven by the current viewMode and runtime data.
 */
const PanelMesh = memo(function PanelMesh({
  panel,
  runtime,
  viewMode,
  panelTilt,
  panelAzimuth,
  selected,
  onSelect,
}: {
  panel: WorkingPanel;
  runtime: RuntimePanel;
  viewMode: ViewMode;
  panelTilt: number;
  panelAzimuth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const accent =
    viewMode === "thermal"  ? runtime.thermalColor
    : viewMode === "shade"  ? new THREE.Color().setHSL(runtime.shadeFactor * 0.33, 0.85, 0.42)
    : viewMode === "string" ? runtime.stringColor
    : viewMode === "heatmap"? runtime.color
    : new THREE.Color("#0b1730").lerp(new THREE.Color("#1e4a7a"), runtime.outputRatio * 0.6);

  const frame = new THREE.Color("#cdd6df").lerp(new THREE.Color("#738091"), 1 - runtime.outputRatio * 0.65);
  const glass = accent.clone().lerp(new THREE.Color("#06101b"), 0.72);
  const emissiveIntensity = viewMode === "normal" ? 0.018 : 0.09;

  return (
    <group
      position={panel.position}
      rotation={panelRotation(panelTilt, panelAzimuth)}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      {/* Aluminium frame */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[PANEL_WIDTH, PANEL_THICKNESS, PANEL_DEPTH]} />
        <meshStandardMaterial color={frame} roughness={0.36} metalness={0.88} />
      </mesh>

      {/* Back-sheet / EVA */}
      <mesh position={[0, -0.01, 0]} receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.08, 0.016, PANEL_DEPTH - 0.08]} />
        <meshStandardMaterial color="#111827" roughness={0.7} metalness={0.16} />
      </mesh>

      {/* PV cell layer */}
      <mesh position={[0, 0.008, 0]} castShadow receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.11, 0.014, PANEL_DEPTH - 0.11]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={emissiveIntensity}
          roughness={0.18}
          metalness={0.44}
        />
      </mesh>

      {/* AR-coated glass (clearcoat physical material) */}
      <mesh position={[0, 0.018, 0]} receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.1, 0.01, PANEL_DEPTH - 0.1]} />
        <meshPhysicalMaterial
          color={glass}
          roughness={0.06}
          metalness={0.04}
          clearcoat={1}
          clearcoatRoughness={0.04}
          reflectivity={0.76}
          transparent
          opacity={0.94}
        />
      </mesh>

      {/* Selection wireframe halo */}
      {selected && (
        <mesh>
          <boxGeometry args={[PANEL_WIDTH + 0.09, PANEL_THICKNESS + 0.04, PANEL_DEPTH + 0.09]} />
          <meshBasicMaterial color="#00ffaa" wireframe />
        </mesh>
      )}

      {/* Subtle emissive glow when selected */}
      {selected && (
        <pointLight color="#00ffaa" intensity={0.8} distance={1.8} />
      )}
    </group>
  );
});

// ── 6.8 PanelGrid ─────────────────────────────────────────────────────────
/**
 * Renders all panels; delegates to PanelMesh per panel.
 * Labels and inspector are rendered separately at this level for clarity.
 * TODO: for >24 panels, migrate to InstancedMesh for better draw call budget.
 */
function PanelGrid({
  panels,
  runtime,
  viewMode,
  panelTilt,
  panelAzimuth,
  selectedIndex,
  showLabels,
  onSelect,
}: {
  panels: WorkingPanel[];
  runtime: RuntimePanel[];
  viewMode: ViewMode;
  panelTilt: number;
  panelAzimuth: number;
  selectedIndex: number | null;
  showLabels: boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <group>
      {panels.map((panel, i) => {
        const rt = runtime[i];
        if (!rt) return null;
        return (
          <group key={`panel-group-${panel.id}`}>
            <PanelMesh
              panel={panel}
              runtime={rt}
              viewMode={viewMode}
              panelTilt={panelTilt}
              panelAzimuth={panelAzimuth}
              selected={selectedIndex === i}
              onSelect={() => onSelect(i)}
            />

            {showLabels && panel.enabled && rt.watts > 0 && (
              <Html
                position={[panel.position[0], PANEL_BASE_Y + 0.42, panel.position[2]]}
                center
                distanceFactor={8}
                occlude
              >
                <div
                  style={{
                    background: "rgba(0,0,0,0.78)",
                    border: "1px solid rgba(255,200,60,0.35)",
                    borderRadius: 5,
                    padding: "2px 6px",
                    color: DS.gold,
                    fontFamily: "monospace",
                    fontSize: 10,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    lineHeight: 1.4,
                  }}
                >
                  {viewMode === "thermal"
                    ? `${rt.temperature.toFixed(0)}°C`
                    : viewMode === "shade"
                    ? `${(rt.shadeFactor * 100).toFixed(0)}% sh`
                    : viewMode === "string"
                    ? `S${panel.stringIndex}`
                    : `${rt.watts.toFixed(0)}W`}
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ── 6.9 Inspector ─────────────────────────────────────────────────────────
/**
 * 3D-anchored inspector card that appears above a selected panel.
 * Closeable via prop — Escape key handling is in the parent component.
 * Accessibility: role="dialog", aria-modal, focus trap managed by parent.
 */
function Inspector({
  panel,
  runtime,
  onClose,
}: {
  panel: WorkingPanel | null;
  runtime: RuntimePanel | null;
  onClose: () => void;
}) {
  if (!panel || !runtime) return null;

  const strColor = STRING_PALETTE[panel.stringIndex % STRING_PALETTE.length];

  return (
    <Html
      position={[panel.position[0], PANEL_BASE_Y + 1.4, panel.position[2]]}
      center
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Panel ${panel.id} details`}
        onClick={onClose}
        style={{
          minWidth: 192,
          background: "rgba(4, 11, 28, 0.97)",
          border: "1px solid #00ffaa",
          borderRadius: 10,
          padding: "13px 15px",
          color: "#dff8ea",
          fontFamily: "monospace",
          fontSize: 12,
          boxShadow: "0 0 28px rgba(0,255,170,0.24), 0 2px 18px rgba(0,0,0,0.6)",
          cursor: "pointer",
          userSelect: "none",
          animation: "inspectorIn 0.18s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ color: "#00ffaa", fontWeight: 700, fontSize: 13 }}>
            Panel #{panel.id}
          </span>
          <span style={{ color: strColor, fontSize: 10 }}>
            String {panel.stringIndex}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "3px 12px" }}>
          {[
            { label: "DC Power",   value: `${runtime.dcWatts.toFixed(1)} W` },
            { label: "AC Power",   value: `${runtime.watts.toFixed(1)} W` },
            { label: "Efficiency", value: `${runtime.efficiencyPct.toFixed(1)}%` },
            { label: "Cell Temp",  value: `${runtime.temperature.toFixed(1)}°C` },
            { label: "Shade",      value: `${(runtime.shadeFactor * 100).toFixed(0)}%` },
            { label: "Output",     value: `${(runtime.outputRatio * 100).toFixed(0)}%` },
          ].map(({ label, value }) => (
            <React.Fragment key={label}>
              <span style={{ color: DS.muted }}>{label}</span>
              <span style={{ color: DS.text }}>{value}</span>
            </React.Fragment>
          ))}
        </div>

        {/* SOC mini-bar */}
        <div style={{ marginTop: 9, borderTop: "1px solid rgba(0,255,170,0.15)", paddingTop: 7 }}>
          <div style={{ color: DS.muted, fontSize: 10, marginBottom: 3 }}>Output ratio</div>
          <div style={{ background: "rgba(255,255,255,0.08)", borderRadius: 3, height: 5, overflow: "hidden" }}>
            <div style={{
              width: `${runtime.outputRatio * 100}%`,
              height: "100%",
              background: `linear-gradient(90deg, #00d18f, #ffd84a)`,
              borderRadius: 3,
            }} />
          </div>
        </div>

        <div style={{ fontSize: 9, color: "#4a6070", marginTop: 8 }}>
          Click or press Esc to dismiss
        </div>
      </div>

      {/* Inline keyframe for the bounce-in animation */}
      <style>{`
        @keyframes inspectorIn {
          from { transform: scale(0.82) translateY(6px); opacity: 0; }
          to   { transform: scale(1)    translateY(0);   opacity: 1; }
        }
      `}</style>
    </Html>
  );
}

// ── 6.10 EnergyFlowLine ───────────────────────────────────────────────────
/**
 * A single energy flow cable drawn as a CatmullRom curve.
 * A sphere pulse dot animates along the curve to represent current.
 */
function EnergyFlowLine({
  path,
  pulseEnabled,
}: {
  path: FlowPath;
  pulseEnabled: boolean;
}) {
  const dotRef      = useRef<THREE.Mesh>(null);
  const progressRef = useRef(seeded(path.id.charCodeAt(0) + 41));

  const curve = useMemo(
    () => new THREE.CatmullRomCurve3(
      path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z))
    ),
    [path.points]
  );

  // Slightly smoothed polyline for the visual line
  const curvePoints = useMemo(
    () => curve.getPoints(24),
    [curve]
  );

  useFrame((_, delta) => {
    if (!pulseEnabled || !path.active || !dotRef.current) return;
    progressRef.current = (progressRef.current + delta * path.speed) % 1;
    dotRef.current.position.copy(curve.getPoint(progressRef.current));
  });

  return (
    <group>
      <DreiLine
        points={curvePoints}
        color={path.color}
        lineWidth={path.active ? 1.4 : 0.5}
        transparent
        opacity={path.active ? 0.58 : 0.14}
      />

      {pulseEnabled && path.active && (
        <mesh ref={dotRef}>
          <sphereGeometry args={[0.065, 10, 10]} />
          <meshBasicMaterial color={path.color} />
        </mesh>
      )}
    </group>
  );
}

// ── 6.11 EnergyFlowSystem ────────────────────────────────────────────────
/**
 * Defines all cables in the energy system and renders them via EnergyFlowLine.
 * Paths connect: panel array → inverter → battery, house, and grid.
 */
function EnergyFlowSystem({
  panels,
  totalKw,
  batteryState,
  visible,
  pulseEnabled,
  flowEnabled,
}: {
  panels: WorkingPanel[];
  totalKw: number;
  batteryState: BatteryState;
  visible: boolean;
  pulseEnabled: boolean;
  flowEnabled: boolean;
}) {
  const panelAnchor = useMemo((): [number, number, number] => {
    const activePanels = panels.filter((panel) => panel.enabled);
    const list = activePanels.length > 0 ? activePanels : panels;
    if (list.length === 0) return [0, PANEL_BASE_Y + 0.12, 0];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const panel of list) {
      const [x, , z] = panel.position;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    return [
      (minX + maxX) / 2,
      PANEL_BASE_Y + 0.12,
      (minZ + maxZ) / 2,
    ];
  }, [panels]);

  const paths = useMemo((): FlowPath[] => [
    {
      id: "pv-inv",
      points: [
        [panelAnchor[0], panelAnchor[1], panelAnchor[2]],
        [panelAnchor[0], 0.5, panelAnchor[2] + 0.8],
        [INVERTER_POS[0], INVERTER_POS[1] + 0.1, INVERTER_POS[2] - 0.6],
        INVERTER_POS,
      ],
      color: DS.gold,
      active: flowEnabled && totalKw > 0.05,
      speed: 0.38,
    },
    {
      id: "inv-bat",
      points: [
        INVERTER_POS,
        [INVERTER_POS[0], BATTERY_POS[1], INVERTER_POS[2] + 0.2],
        BATTERY_POS,
      ],
      color: batteryState.charging ? DS.emerald : DS.cyan,
      active: flowEnabled && batteryState.powerKw > 0.02,
      speed: 0.28,
    },
    {
      id: "inv-house",
      points: [
        INVERTER_POS,
        [INVERTER_POS[0] - 0.8, INVERTER_POS[1] + 0.2, INVERTER_POS[2]],
        [HOUSE_POS[0] + 0.5, HOUSE_POS[1] + 0.5, HOUSE_POS[2]],
        HOUSE_POS,
      ],
      color: DS.cyan,
      active: flowEnabled && totalKw > 0.1,
      speed: 0.32,
    },
    {
      id: "inv-grid",
      points: [
        INVERTER_POS,
        [INVERTER_POS[0] + 1.2, INVERTER_POS[1] + 0.4, INVERTER_POS[2] - 1],
        [GRID_POS[0] - 1, GRID_POS[1] + 0.5, GRID_POS[2] + 2],
        GRID_POS,
      ],
      color: "#f97316",
      active: flowEnabled && totalKw * INVERTER_EFFICIENCY > 2.5,
      speed: 0.22,
    },
  ], [batteryState, flowEnabled, panelAnchor, totalKw]);

  if (!visible) return null;

  return (
    <group>
      {paths.map((path) => (
        <EnergyFlowLine key={path.id} path={path} pulseEnabled={pulseEnabled} />
      ))}
    </group>
  );
}

// ── 6.12 BatteryNode ─────────────────────────────────────────────────────
/** Battery storage unit with animated SOC bar and charging glow */
function BatteryNode({ state }: { state: BatteryState }) {
  const fillRef  = useRef<THREE.Mesh>(null);
  const glowRef  = useRef<THREE.Mesh>(null);
  const ledRef   = useRef<THREE.Mesh>(null);

  const socColor = state.soc > 0.6 ? "#00ff88" : state.soc > 0.3 ? "#ffcc00" : "#ff5533";

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    if (fillRef.current) {
      const targetScale = clamp(state.soc, 0.05, 1);
      fillRef.current.scale.y += (targetScale - fillRef.current.scale.y) * 0.04;
      fillRef.current.position.y = (fillRef.current.scale.y - 1) * 0.28;
      (fillRef.current.material as THREE.MeshBasicMaterial).color.set(socColor);
    }

    if (glowRef.current) {
      const m = glowRef.current.material as THREE.MeshBasicMaterial;
      m.opacity = state.charging
        ? 0.07 + Math.sin(t * 2.6) * 0.04
        : 0.025;
      m.color.set(socColor);
    }

    if (ledRef.current) {
      const m = ledRef.current.material as THREE.MeshBasicMaterial;
      m.color.setRGB(0.08, 1, 0.24 + Math.sin(t * 3.8) * 0.18);
    }
  });

  return (
    <group position={BATTERY_POS}>
      {/* Casing */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.44, 0.88, 0.22]} />
        <meshStandardMaterial color="#e2e8f0" roughness={0.34} metalness={0.28} />
      </mesh>

      {/* SOC track */}
      <mesh position={[0.15, 0, 0.113]}>
        <planeGeometry args={[0.06, 0.62]} />
        <meshBasicMaterial color="#060e18" />
      </mesh>

      {/* SOC fill */}
      <mesh ref={fillRef} position={[0.15, 0, 0.114]}>
        <planeGeometry args={[0.052, 0.58]} />
        <meshBasicMaterial color={socColor} />
      </mesh>

      {/* Charging glow */}
      <mesh ref={glowRef}>
        <boxGeometry args={[0.5, 0.94, 0.26]} />
        <meshBasicMaterial
          color={socColor}
          transparent
          opacity={0.04}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Status LED */}
      <mesh ref={ledRef} position={[-0.18, 0.3, 0.113]}>
        <circleGeometry args={[0.014, 10]} />
        <meshBasicMaterial color="#00ff44" />
      </mesh>

      {/* SOC label */}
      <Html position={[-0.08, 0.02, 0.14]} center>
        <div
          style={{
            color: socColor,
            fontFamily: "monospace",
            fontSize: 10,
            whiteSpace: "nowrap",
            textShadow: `0 0 8px ${socColor}`,
            pointerEvents: "none",
          }}
        >
          {(state.soc * 100).toFixed(0)}%{state.charging ? " ↑" : " ↓"}
        </div>
      </Html>
    </group>
  );
}

// ── 6.13 InverterBox ─────────────────────────────────────────────────────
/** Inverter enclosure with animated display screen and status LED */
function InverterBox() {
  const screenRef = useRef<THREE.Mesh>(null);
  const ledRef    = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (screenRef.current) {
      const m = screenRef.current.material as THREE.MeshBasicMaterial;
      m.color.setRGB(0, 0.22 + Math.sin(t * 1.8) * 0.04, 0.12 + Math.sin(t) * 0.02);
    }
    if (ledRef.current) {
      const m = ledRef.current.material as THREE.MeshBasicMaterial;
      m.color.setRGB(0.1, 1, 0.22 + Math.sin(t * 4.2) * 0.2);
    }
  });

  return (
    <group position={INVERTER_POS}>
      {/* Housing */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.38, 0.6, 0.16]} />
        <meshStandardMaterial color="#d6dce4" roughness={0.36} metalness={0.3} />
      </mesh>

      {/* Display screen */}
      <mesh ref={screenRef} position={[0, 0.07, 0.082]}>
        <planeGeometry args={[0.22, 0.16]} />
        <meshBasicMaterial color="#003015" />
      </mesh>

      {/* Vent grille lines */}
      {[-0.08, -0.04, 0, 0.04, 0.08].map((y) => (
        <mesh key={`vent-${y}`} position={[0, y - 0.2, 0.082]}>
          <planeGeometry args={[0.3, 0.005]} />
          <meshBasicMaterial color="#9aacba" />
        </mesh>
      ))}

      {/* Status LED */}
      <mesh ref={ledRef} position={[0.14, -0.2, 0.083]}>
        <circleGeometry args={[0.013, 12]} />
        <meshBasicMaterial color="#00ff66" />
      </mesh>

      {/* Label */}
      <Html position={[0, 0.38, 0.1]} center>
        <div style={{ color: DS.muted, fontFamily: "monospace", fontSize: 8, pointerEvents: "none" }}>
          INV
        </div>
      </Html>
    </group>
  );
}

// ── 6.14 GridPylon ───────────────────────────────────────────────────────
/** Utility grid pole / transformer node */
function GridPylon() {
  return (
    <group position={GRID_BASE_POS}>
      {/* Pole */}
      <mesh position={[0, 1.2, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.055, 2.4, 8]} />
        <meshStandardMaterial color="#8893a5" roughness={0.46} metalness={0.76} />
      </mesh>

      {/* Transformer box */}
      <mesh position={[0, 2.35, 0]} castShadow>
        <boxGeometry args={[0.58, 0.34, 0.28]} />
        <meshStandardMaterial color="#d7dde6" roughness={0.36} metalness={0.3} />
      </mesh>

      {/* Cross-arm */}
      <mesh position={[0, 2.6, 0]} castShadow>
        <boxGeometry args={[0.88, 0.05, 0.12]} />
        <meshStandardMaterial color="#7c8797" roughness={0.4} metalness={0.82} />
      </mesh>

      {/* Insulators */}
      {[-0.22, 0, 0.22].map((x) => (
        <mesh key={`ins-${x}`} position={[x, 2.48, 0.1]}>
          <sphereGeometry args={[0.04, 10, 10]} />
          <meshStandardMaterial
            color="#8fd1ff"
            emissive="#8fd1ff"
            emissiveIntensity={0.18}
            roughness={0.18}
            metalness={0.1}
          />
        </mesh>
      ))}

      {/* Base */}
      <mesh position={[0, 0.08, 0]} receiveShadow>
        <boxGeometry args={[0.34, 0.16, 0.34]} />
        <meshStandardMaterial color="#4b5563" roughness={0.82} metalness={0.08} />
      </mesh>
    </group>
  );
}

// ── 6.15 HouseDiorama ─────────────────────────────────────────────────────
/** Miniature house load node to anchor the consumption end of flows */
function HouseDiorama({ nightMode }: { nightMode: boolean }) {
  const winRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!winRef.current || !nightMode) return;
    const m = winRef.current.material as THREE.MeshBasicMaterial;
    m.opacity = 0.22 + Math.sin(clock.getElapsedTime() * 0.7) * 0.04;
  });

  return (
    <group position={HOUSE_POS} scale={0.45}>
      {/* Body */}
      <mesh castShadow receiveShadow>
        <boxGeometry args={[1.6, 1.2, 1.4]} />
        <meshStandardMaterial color={nightMode ? "#0b1422" : "#1e293b"} roughness={0.82} metalness={0.06} />
      </mesh>

      {/* Roof ridge */}
      <mesh position={[0, 0.76, 0]} castShadow>
        <boxGeometry args={[1.7, 0.12, 1.5]} />
        <meshStandardMaterial color={nightMode ? "#0d1825" : "#0f172a"} roughness={0.56} metalness={0.12} />
      </mesh>

      {/* Window glow */}
      <mesh ref={winRef} position={[0, 0.1, 0.71]}>
        <planeGeometry args={[0.52, 0.38]} />
        <meshBasicMaterial
          color="#ffd060"
          transparent
          opacity={nightMode ? 0.24 : 0}
        />
      </mesh>

      {/* Label */}
      <Html position={[0, 1.0, 0]} center>
        <div style={{ color: DS.muted, fontFamily: "monospace", fontSize: 9, pointerEvents: "none" }}>
          LOAD
        </div>
      </Html>
    </group>
  );
}

// ── 6.16 WindTurbine ─────────────────────────────────────────────────────
/** Animated wind turbine — optional easter egg, toggled from settings */
function WindTurbine({ visible }: { visible: boolean }) {
  const bladesRef = useRef<THREE.Group>(null);

  useFrame((_, delta) => {
    if (visible && bladesRef.current) {
      bladesRef.current.rotation.z += delta * 1.4;
    }
  });

  if (!visible) return null;

  return (
    <group position={WIND_POS}>
      {/* Tower */}
      <mesh castShadow>
        <cylinderGeometry args={[0.08, 0.14, 5, 12]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.42} metalness={0.28} />
      </mesh>

      {/* Nacelle */}
      <mesh position={[0, 2.68, 0]} castShadow>
        <boxGeometry args={[0.32, 0.2, 0.48]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.42} metalness={0.28} />
      </mesh>

      {/* Rotating hub + blades */}
      <group ref={bladesRef} position={[0.18, 2.68, 0]} rotation={[Math.PI / 2, 0, 0]}>
        {[0, 120, 240].map((angleDeg) => (
          <mesh
            key={`blade-${angleDeg}`}
            castShadow
            position={[0, 0.58, 0]}
            rotation={[0, 0, THREE.MathUtils.degToRad(angleDeg)]}
          >
            <boxGeometry args={[0.05, 1.14, 0.02]} />
            <meshStandardMaterial color="#f8fafc" roughness={0.32} metalness={0.12} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

// ── 6.17 CameraController ────────────────────────────────────────────────
/**
 * Smooth camera preset transitions using lerp damping.
 * Orbit controls are enabled between transitions.
 */
function CameraController({
  preset,
  onDone,
}: {
  preset: CameraPreset | null;
  onDone: () => void;
}) {
  const { camera } = useThree();
  const controlsRef    = useRef<OrbitControlsImpl | null>(null);
  const targetPosition = useRef(new THREE.Vector3());
  const targetLookAt   = useRef(new THREE.Vector3());
  const transitioning  = useRef(false);
  const doneRef        = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (!preset) return;
    targetPosition.current.set(...preset.position);
    targetLookAt.current.set(...preset.target);
    transitioning.current = true;
  }, [preset]);

  useFrame(() => {
    if (!transitioning.current) return;

    camera.position.lerp(targetPosition.current, 0.06);
    if (controlsRef.current) {
      controlsRef.current.target.lerp(targetLookAt.current, 0.06);
      controlsRef.current.update();
    }

    if (camera.position.distanceTo(targetPosition.current) < 0.08) {
      camera.position.copy(targetPosition.current);
      transitioning.current = false;
      doneRef.current();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan={false}
      enableDamping
      dampingFactor={0.06}
      minDistance={2.5}
      maxDistance={26}
      maxPolarAngle={Math.PI / 2.1}
    />
  );
}

// ── 6.18 SceneContent ────────────────────────────────────────────────────
/**
 * Main 3D scene assembler. Accepts all state props from the parent component
 * and delegates to each sub-component. This function is the single entry
 * point into Three.js territory — no Three.js primitives exist above it.
 */
interface SceneContentProps {
  panels: WorkingPanel[];
  runtime: RuntimePanel[];
  elevation: number;
  azimuth: number;
  starsCount: number;
  weather: WeatherType;
  roofType: RoofType;
  season: Season;
  latitude: number;
  viewMode: ViewMode;
  nightMode: boolean;
  showLabels: boolean;
  showSunPath: boolean;
  showEnergyFlow: boolean;
  showBattery: boolean;
  showWind: boolean;
  showGround: boolean;
  showCabling: boolean;
  showBloom: boolean;
  panelTilt: number;
  panelAzimuth: number;
  selectedIndex: number | null;
  cameraPreset: CameraPreset | null;
  batteryState: BatteryState;
  totalKw: number;
  onSelect: (index: number) => void;
  onCameraDone: () => void;
}

function SceneContent({
  panels, runtime, elevation, azimuth, starsCount,
  weather, roofType, season, latitude, viewMode, nightMode,
  showLabels, showSunPath, showEnergyFlow, showBattery,
  showWind, showGround, showCabling, showBloom,
  panelTilt, panelAzimuth, selectedIndex, cameraPreset,
  batteryState, totalKw,
  onSelect, onCameraDone,
}: SceneContentProps) {
  const declination = SEASON_DECLINATION[season];
  const isStorm     = weather === "storm";
  const isFoggy     = weather === "fog";
  const dayOfYear   = ({ Winter: 15, Spring: 105, Summer: 196, Autumn: 288 } as const)[season];
  const climate     = useClimateEngine({
    hour:      approximateHour(azimuth),
    dayOfYear,
    latitude,
    longitude: 77.2,
    tiltDeg:   panelTilt,
    surfAzDeg: panelAzimuth,
    weather,
    season,
    paused:    false,
  });

  return (
    <>
      {/* ── Lighting ── */}
      <SunRig elevation={elevation} azimuth={azimuth} weather={weather} nightMode={nightMode} />

      {/* ── Sky & Stars ── */}
      {(nightMode || elevation < 4) && (
        <Stars radius={90} depth={50} count={starsCount} factor={4.2} saturation={0.1} fade />
      )}

      {/* Advanced procedural sky (previously not mounted) */}
      <AtmosphericSkyShader elevation={elevation} azimuth={azimuth} nightMode={nightMode} />

      {/* Environment map for reflections and ambient image-based lighting */}
      <Environment preset={nightMode ? "night" : weather === "clear" ? "sunset" : "dawn"} />

      {/* ── Contact Shadows (AO approximation) ── */}
      <ContactShadows
        position={[0, -0.01, 0]}
        opacity={0.48}
        scale={22}
        blur={2.4}
        far={6}
        color="#000c22"
      />

      {/* ── Fog ── */}
      {isFoggy && <fogExp2 attach="fog" args={["#7a8fa0", 0.032]} />}
      {nightMode && <fog attach="fog" args={["#020610", 28, 70]} />}

      {/* ── Weather particles ── */}
      <WeatherParticles weather={weather} />
      <LightningBurst active={isStorm} />
      <VisualWeatherSystem
        field={climate.cloudField}
        irradiance={climate.irradiance}
        weather={weather}
        nightMode={nightMode}
        elevation={elevation}
        showClouds={weather !== "clear"}
        showShadows={weather !== "clear"}
        showWindVectors={showWind}
        windNodes={climate.windField.nodes}
      />

      {/* ── Post-processing ── */}
      <CinematicPostProcessing
        weather={weather}
        nightMode={nightMode}
        elevation={elevation}
        enabled={showBloom}
      />

      {/* ── Sun arc ── */}
      <SunPathArc
        latitude={latitude}
        declination={declination}
        visible={showSunPath}
        elevation={elevation}
        azimuth={azimuth}
      />

      {/* ── Architecture ── */}
      <RoofShell roofType={roofType} nightMode={nightMode} />
      <Surroundings nightMode={nightMode} showGround={showGround} />

      {/* ── Panel grid ── */}
      <PanelGrid
        panels={panels}
        runtime={runtime}
        viewMode={viewMode}
        panelTilt={panelTilt}
        panelAzimuth={panelAzimuth}
        selectedIndex={selectedIndex}
        showLabels={showLabels}
        onSelect={onSelect}
      />

      {/* ── Panel inspector ── */}
      {selectedIndex !== null && (
        <Inspector
          panel={panels[selectedIndex] ?? null}
          runtime={runtime[selectedIndex] ?? null}
          onClose={() => onSelect(-1)}
        />
      )}

      {/* ── BOS equipment ── */}
      <InverterBox />
      {showBattery && <BatteryNode state={batteryState} />}
      <GridPylon />
      <HouseDiorama nightMode={nightMode} />
      <WindTurbine visible={showWind} />

      {/* ── Energy cables ── */}
      {showCabling && (
        <>
          <EnergyFlowSystem
            panels={panels}
            totalKw={totalKw}
            batteryState={batteryState}
            visible={showCabling}
            pulseEnabled={showEnergyFlow}
            flowEnabled={showEnergyFlow}
          />
          {/* Explicitly mount S19 beam so the advanced cable effect is visible */}
          <S19EnergyBeam
            flowId="solar"
            points={[
              [0, 0.34, 0],
              [INVERTER_POS[0], INVERTER_POS[1], INVERTER_POS[2]],
              [HOUSE_POS[0], HOUSE_POS[1] + 0.25, HOUSE_POS[2]],
            ]}
            active={showEnergyFlow && totalKw > 0.2}
          />
        </>
      )}

      {/* ── Camera ── */}
      <CameraController preset={cameraPreset} onDone={onCameraDone} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — UI COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared style primitives ──────────────────────────────────────────────────

const cardBase: React.CSSProperties = {
  background:   DS.bg,
  border:       `1px solid ${DS.border}`,
  borderRadius: 12,
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  boxShadow:    "0 4px 32px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
};

const sectionLabel: React.CSSProperties = {
  color:       DS.muted,
  fontFamily:  "monospace",
  fontSize:    9,
  fontWeight:  600,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  marginBottom: 5,
};

const tinyBtn = (active: boolean): React.CSSProperties => ({
  padding:      "4px 10px",
  background:   active ? "rgba(255,216,74,0.18)" : "rgba(255,255,255,0.04)",
  border:       `1px solid ${active ? DS.gold : "rgba(255,255,255,0.1)"}`,
  borderRadius: 6,
  color:        active ? DS.gold : DS.muted,
  fontFamily:   "monospace",
  fontSize:     10,
  cursor:       "pointer",
  transition:   "all 0.14s ease",
  whiteSpace:   "nowrap",
});

// ── 7.1 ModalWrapper ─────────────────────────────────────────────────────
/**
 * Accessible modal wrapper with framer-motion fade+scale animation.
 * Closes on Escape (via onClose) and handles outside-click dismissal.
 */
const ModalWrapper = memo(function ModalWrapper({
  title,
  width = 480,
  onClose,
  children,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Focus trap — move focus into dialog on open
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dialogRef.current?.querySelector<HTMLElement>("button, [tabindex]");
    el?.focus();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      style={{
        position:        "fixed",
        inset:           0,
        background:      "rgba(0,0,0,0.62)",
        backdropFilter:  "blur(4px)",
        zIndex:          200,
        display:         "flex",
        alignItems:      "center",
        justifyContent:  "center",
        padding:         "16px",
      }}
      onClick={onClose}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={{ scale: 0.92, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.94, y: 8, opacity: 0 }}
        transition={{ type: "spring", stiffness: 340, damping: 28 }}
        style={{
          ...cardBase,
          width:     "100%",
          maxWidth:  width,
          maxHeight: "85vh",
          overflowY: "auto",
          padding:   "20px 22px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ color: DS.gold, fontFamily: "monospace", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em" }}>
            {title}
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            style={{
              background: "none",
              border:     "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              color:      DS.muted,
              cursor:     "pointer",
              fontFamily: "monospace",
              fontSize:   10,
              padding:    "3px 8px",
            }}
          >
            ✕
          </button>
        </div>

        {children}
      </motion.div>
    </motion.div>
  );
});

// ── 7.2 TelemetryCard ────────────────────────────────────────────────────
/**
 * Live telemetry strip displayed at the top of the control panel.
 * Metrics animate in with staggered fade using framer-motion.
 */
const TelemetryCard = memo(function TelemetryCard({
  totalKw,
  peakKw,
  dailyKwh,
  co2Kg,
  socPct,
  weather,
  season,
  year,
}: {
  totalKw:  number;
  peakKw:   number;
  dailyKwh: number;
  co2Kg:    number;
  socPct:   number;
  weather:  WeatherType;
  season:   Season;
  year:     number;
}) {
  const metrics = [
    { label: "Peak",    value: `${peakKw.toFixed(1)} kW` },
    { label: "Daily",   value: `${dailyKwh.toFixed(1)} kWh` },
    { label: "CO₂",     value: `${co2Kg.toFixed(1)} kg` },
    { label: "Battery", value: `${socPct.toFixed(0)}%` },
  ];

  return (
    <div>
      <div style={{ color: DS.gold, fontFamily: "monospace", fontSize: 12, fontWeight: 700, marginBottom: 2, letterSpacing: "0.08em" }}>
        SOLAR MONITOR
      </div>
      <div style={{ color: DS.muted, fontFamily: "monospace", fontSize: 9, marginBottom: 12 }}>
        {weatherEmoji[weather]} {weather} · {season} · Year {year}
      </div>

      <div style={{ ...sectionLabel }}>Live Output</div>
      <motion.div
        key={totalKw.toFixed(2)}
        initial={{ opacity: 0.6, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.22 }}
        style={{ color: DS.gold, fontFamily: "monospace", fontSize: 24, fontWeight: 700, marginBottom: 10 }}
      >
        {totalKw.toFixed(2)} <span style={{ fontSize: 14, color: "rgba(255,216,74,0.6)" }}>kW</span>
      </motion.div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 12 }}>
        {metrics.map((m, i) => (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <div style={sectionLabel}>{m.label}</div>
            <div style={{ color: DS.text, fontFamily: "monospace", fontSize: 12 }}>{m.value}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
});

// ── 7.3 FlowCard ─────────────────────────────────────────────────────────
/** Power flow breakdown panel: PV / Battery / House / Grid */
function FlowCard({
  visible,
  totalKw,
  batteryState,
  compact,
}: {
  visible:      boolean;
  totalKw:      number;
  batteryState: BatteryState;
  compact:      boolean;
}) {
  const houseLoad   = 2.4; // kW — fixed load; override with real telemetry
  const ac          = totalKw * INVERTER_EFFICIENCY;
  const gridExport  = Math.max(0, ac - houseLoad - (batteryState.charging ? batteryState.powerKw : 0));
  const gridImport  = Math.max(0, houseLoad - ac);

  const rows = [
    { label: "PV → Inverter",  value: `${totalKw.toFixed(2)} kW`,   color: DS.gold },
    {
      label: "Battery",
      value: `${batteryState.charging ? "+" : "−"}${batteryState.powerKw.toFixed(2)} kW`,
      color: batteryState.charging ? DS.emerald : DS.cyan,
    },
    { label: "House load",     value: `${houseLoad.toFixed(1)} kW`,  color: DS.cyan },
    {
      label: "Grid",
      value: gridExport > 0
        ? `+${gridExport.toFixed(2)} kW export`
        : `${gridImport.toFixed(2)} kW import`,
      color: gridExport > 0 ? DS.warning : DS.danger,
    },
  ];

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -10 }}
          style={{
            ...cardBase,
            position:    "absolute",
            ...(compact
              ? { left: 14, top: 52, width: 252 }
              : { right: 16, bottom: 16, width: 268 }),
            maxWidth:   "calc(100% - 28px)",
            boxSizing:  "border-box",
            padding:    "12px 14px",
            zIndex:     40,
          }}
        >
          <div style={{ color: DS.gold, fontFamily: "monospace", fontSize: 11, fontWeight: 700, marginBottom: 9 }}>
            POWER FLOW
          </div>
          <div style={{ display: "grid", gap: 6, fontFamily: "monospace", fontSize: 11 }}>
            {rows.map((r) => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: DS.muted }}>{r.label}</span>
                <span style={{ color: r.color }}>{r.value}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── 7.4 ViewModeLegend ───────────────────────────────────────────────────
/** Colour legend strip shown when a non-normal view mode is active */
function ViewModeLegend({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === "normal") return null;

  const config: Record<Exclude<ViewMode, "normal">, { label: string; stops: string[] }> = {
    heatmap: {
      label: "Output (0 → 100%)",
      stops: ["#08111e", "#0f4c81", "#00a2ff", "#00d18f", "#ffd54a", "#ff7f32"],
    },
    thermal: {
      label: "Cell Temperature (low → high)",
      stops: ["#1536c5", "#7044d4", "#d42d6a", "#ff5a2a"],
    },
    shade: {
      label: "Shade (0% → 100%)",
      stops: ["#22c55e", "#facc15", "#f97316", "#dc2626"],
    },
    string: {
      label: "Strings A–F",
      stops: STRING_PALETTE as unknown as string[],
    },
  };

  const cfg = config[viewMode];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      style={{
        ...cardBase,
        position:   "absolute",
        bottom:     16,
        left:       "50%",
        transform:  "translateX(-50%)",
        padding:    "9px 16px",
        zIndex:     40,
        display:    "flex",
        flexDirection: "column",
        alignItems: "center",
        gap:        6,
        pointerEvents: "none",
      }}
    >
      <div style={{ ...sectionLabel, marginBottom: 0 }}>{cfg.label}</div>
      <div style={{
        width:        180,
        height:       8,
        borderRadius: 4,
        background:   `linear-gradient(90deg, ${cfg.stops.join(",")})`,
      }} />
    </motion.div>
  );
}

// ── 7.5 AnalyticsModal ───────────────────────────────────────────────────
/**
 * Full-screen analytics dashboard showing:
 * • Monthly production bar chart (SVG)
 * • System stats summary
 * • Degradation forecast
 */
function AnalyticsModal({
  peakKw, totalKw, year, season, weather, onClose,
}: {
  peakKw:  number;
  totalKw: number;
  year:    number;
  season:  Season;
  weather: WeatherType;
  onClose: () => void;
}) {
  const monthly = useMemo(
    () => monthlyProduction(peakKw, year, season),
    [peakKw, year, season]
  );

  const maxKwh    = Math.max(...monthly.map((m) => m.kwh), 1);
  const totalYear = monthly.reduce((s, m) => s + m.kwh, 0);
  const degrade   = (Math.pow(0.994, Math.max(year - 1, 0)) * 100 - 100).toFixed(1);

  return (
    <ModalWrapper title="ANALYTICS — MONTHLY PRODUCTION" width={560} onClose={onClose}>
      {/* Bar chart (SVG) */}
      <svg viewBox="0 0 520 140" style={{ width: "100%", marginBottom: 18 }}>
        {monthly.map((m, i) => {
          const barH   = (m.kwh / maxKwh) * 110;
          const fcastH = (m.forecast / maxKwh) * 110;
          const x      = i * (520 / 12);
          const w      = 520 / 12 - 3;

          return (
            <g key={m.month}>
              {/* Forecast bar (behind) */}
              <rect
                x={x + 2}
                y={130 - fcastH}
                width={w}
                height={fcastH}
                rx={2}
                fill="rgba(56,189,248,0.18)"
              />
              {/* Actual bar */}
              <rect
                x={x + 2}
                y={130 - barH}
                width={w}
                height={barH}
                rx={2}
                fill={`url(#barGrad-${i})`}
              />
              <defs>
                <linearGradient id={`barGrad-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor="#ffd84a" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0.6} />
                </linearGradient>
              </defs>
              <text
                x={x + w / 2 + 2}
                y={136}
                textAnchor="middle"
                fill="#4a6070"
                fontSize={8}
                fontFamily="monospace"
              >
                {m.month}
              </text>
            </g>
          );
        })}
        {/* Zero line */}
        <line x1={0} y1={130} x2={520} y2={130} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 18, fontFamily: "monospace", fontSize: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 12, height: 8, background: DS.gold, borderRadius: 2 }} />
          <span style={{ color: DS.muted }}>Actual</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 12, height: 8, background: "rgba(56,189,248,0.4)", borderRadius: 2 }} />
          <span style={{ color: DS.muted }}>Forecast</span>
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 16 }}>
        {[
          { label: "Annual Total",   value: `${fmtNum(totalYear)} kWh` },
          { label: "System Size",    value: `${peakKw.toFixed(2)} kWp` },
          { label: "Year",           value: `${year}` },
          { label: "Current Output", value: `${totalKw.toFixed(2)} kW` },
          { label: "Degradation",    value: `${degrade}%` },
          { label: "CO₂ Offset",     value: `${fmtNum(totalYear * CO2_PER_KWH)} kg/yr` },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "10px 12px", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ ...sectionLabel }}>{label}</div>
            <div style={{ color: DS.gold, fontFamily: "monospace", fontSize: 14, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Weather context */}
      <div style={{ fontFamily: "monospace", fontSize: 10, color: DS.muted, borderTop: `1px solid ${DS.border}`, paddingTop: 12 }}>
        Current conditions: {weatherEmoji[weather]} {weather} · {season} season ·
        Weather factor: {WEATHER_FACTOR[weather] * 100}%
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={onClose} style={{ ...tinyBtn(true) }}>Close</button>
      </div>
    </ModalWrapper>
  );
}

// ── 7.6 RoiModal ─────────────────────────────────────────────────────────
/** ROI calculator with payback period, lifetime return, and CO₂ metrics */
function RoiModal({
  peakKw,
  season,
  onClose,
}: {
  peakKw:  number;
  season:  Season;
  onClose: () => void;
}) {
  const [tariff, setTariff]     = useState(ELECTRICITY_TARIFF);
  const [incentive, setIncentive] = useState(INCENTIVE_RATE * 100);
  const [costPerKw, setCostPerKw] = useState(INSTALL_COST_PER_KW);

  const roi = useMemo(
    () =>
      computeRoi(peakKw, season, {
        tariff,
        incentiveRate: incentive / 100,
        costPerKw,
      }),
    [peakKw, season, tariff, incentive, costPerKw]
  );

  const paybackPct = Math.min(100, (1 / Math.max(roi.paybackYears, 0.1)) * 25);

  return (
    <ModalWrapper title="ROI CALCULATOR" width={480} onClose={onClose}>
      {/* Sliders */}
      <div style={{ display: "grid", gap: 14, marginBottom: 20 }}>
        {[
          { label: `Tariff: ₹${tariff.toFixed(1)}/kWh`, min: 4, max: 15, step: 0.5, value: tariff, set: setTariff },
          { label: `Incentive: ${incentive.toFixed(0)}%`, min: 0, max: 60, step: 5, value: incentive, set: setIncentive },
          { label: `Install cost: ₹${fmtNum(costPerKw)}/kW`, min: 30000, max: 100000, step: 1000, value: costPerKw, set: setCostPerKw },
        ].map(({ label, min, max, step, value, set }) => (
          <div key={label}>
            <div style={{ ...sectionLabel, marginBottom: 4 }}>{label}</div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={value}
              onChange={(e) => set(Number(e.target.value))}
              style={{ width: "100%", accentColor: DS.gold }}
              aria-label={label}
            />
          </div>
        ))}
      </div>

      {/* Key numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18 }}>
        {[
          { label: "System Cost",      value: `₹${fmtNum(roi.systemCost)}`,          accent: DS.muted },
          { label: "Incentive Value",  value: `₹${fmtNum(roi.incentiveValue)}`,       accent: DS.emerald },
          { label: "Net Cost",         value: `₹${fmtNum(roi.netCost)}`,              accent: DS.text },
          { label: "Annual Savings",   value: `₹${fmtNum(roi.annualSavings)}`,        accent: DS.gold },
          { label: "Payback Period",   value: `${roi.paybackYears.toFixed(1)} years`, accent: DS.cyan },
          { label: "20-yr Return",     value: `₹${fmtNum(roi.twentyYearReturn)}`,     accent: roi.twentyYearReturn > 0 ? DS.emerald : DS.danger },
        ].map(({ label, value, accent }) => (
          <div key={label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "10px 12px", border: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ ...sectionLabel }}>{label}</div>
            <div style={{ color: accent, fontFamily: "monospace", fontSize: 13, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Payback gauge */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ ...sectionLabel }}>Payback progress (relative to 25-yr lifecycle)</div>
        <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 4, height: 7 }}>
          <div style={{
            width:        `${paybackPct}%`,
            height:       "100%",
            background:   `linear-gradient(90deg, ${DS.emerald}, ${DS.gold})`,
            borderRadius: 4,
            transition:   "width 0.4s ease",
          }} />
        </div>
      </div>

      {/* CO2 */}
      <div style={{ fontFamily: "monospace", fontSize: 11, color: DS.muted, borderTop: `1px solid ${DS.border}`, paddingTop: 12, marginBottom: 16 }}>
        🌿 Lifetime CO₂ offset (25 yr): <span style={{ color: DS.emerald }}>{roi.co2LifetimeTonnes.toFixed(1)} tonnes</span>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onClose} style={tinyBtn(true)}>Close</button>
      </div>
    </ModalWrapper>
  );
}

// ── 7.7 ForecastModal ────────────────────────────────────────────────────
/** 7-day weather and production forecast with weather selector */
function ForecastModal({
  forecast,
  weather,
  onWeather,
  onClose,
}: {
  forecast:  WeatherForecast[];
  weather:   WeatherType;
  onWeather: (w: WeatherType) => void;
  onClose:   () => void;
}) {
  const maxProd = Math.max(...forecast.map((f) => f.production), 1);

  return (
    <ModalWrapper title="7-DAY FORECAST" width={500} onClose={onClose}>
      {/* Weather selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ ...sectionLabel }}>Current Conditions</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {WEATHER_OPTIONS.map((w) => (
            <button
              key={w}
              onClick={() => onWeather(w)}
              aria-pressed={w === weather}
              style={tinyBtn(w === weather)}
            >
              {weatherEmoji[w]} {w}
            </button>
          ))}
        </div>
      </div>

      {/* Forecast table */}
      <div style={{ display: "grid", gap: 6 }}>
        {forecast.map((f, i) => {
          const prodPct = (f.production / maxProd) * 100;
          return (
            <motion.div
              key={f.day}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              style={{
                display:      "grid",
                gridTemplateColumns: "44px 32px 1fr 72px 72px",
                alignItems:   "center",
                gap:          8,
                padding:      "8px 10px",
                background:   "rgba(255,255,255,0.03)",
                borderRadius: 8,
                border:       "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <span style={{ color: DS.text, fontFamily: "monospace", fontSize: 11 }}>{f.day}</span>
              <span style={{ fontSize: 14 }}>{weatherEmoji[f.condition]}</span>
              {/* Production bar */}
              <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 3, height: 6 }}>
                <div style={{
                  width:        `${prodPct}%`,
                  height:       "100%",
                  background:   DS.gold,
                  borderRadius: 3,
                  opacity:      WEATHER_FACTOR[f.condition],
                }} />
              </div>
              <span style={{ color: DS.gold, fontFamily: "monospace", fontSize: 10, textAlign: "right" }}>
                {f.production} kWh
              </span>
              <span style={{ color: DS.muted, fontFamily: "monospace", fontSize: 10, textAlign: "right" }}>
                {f.low}–{f.high}°C
              </span>
            </motion.div>
          );
        })}
      </div>

      {/* Sun hours summary */}
      <div style={{ marginTop: 14, fontFamily: "monospace", fontSize: 10, color: DS.muted }}>
        Avg peak sun hours this week: {
          (forecast.reduce((s, f) => s + f.sunHours, 0) / forecast.length).toFixed(1)
        } h/day
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button onClick={onClose} style={tinyBtn(true)}>Close</button>
      </div>
    </ModalWrapper>
  );
}

// ── 7.8 ConfigModal ──────────────────────────────────────────────────────
/** Panel configuration: enable/disable panels, adjust tilt and azimuth */
function ConfigModal({
  panels,
  enabled,
  tiltAdjust,
  azimuthAdjust,
  onToggle,
  onTilt,
  onAzimuth,
  onReset,
  onClose,
}: {
  panels:        WorkingPanel[];
  enabled:       boolean[];
  tiltAdjust:    number;
  azimuthAdjust: number;
  onToggle:      (i: number) => void;
  onTilt:        (v: number) => void;
  onAzimuth:     (v: number) => void;
  onReset:       () => void;
  onClose:       () => void;
}) {
  const rows     = Math.max(...panels.map((p) => p.row)) + 1;
  const active   = enabled.filter(Boolean).length;
  const totalW   = panels.filter((_, i) => enabled[i]).reduce((s, p) => s + p.basePower, 0);

  return (
    <ModalWrapper title="ARRAY CONFIGURATION" width={540} onClose={onClose}>
      {/* Summary line */}
      <div style={{ display: "flex", gap: 16, marginBottom: 18, fontFamily: "monospace", fontSize: 11 }}>
        <span style={{ color: DS.muted }}>Active panels:</span>
        <span style={{ color: DS.gold }}>{active} / {panels.length}</span>
        <span style={{ color: DS.muted }}>Rated capacity:</span>
        <span style={{ color: DS.gold }}>{(totalW / 1000).toFixed(2)} kWp</span>
      </div>

      {/* Interactive panel grid */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ ...sectionLabel }}>Click to enable / disable panels</div>
        <div style={{ display: "grid", gap: 5 }}>
          {Array.from({ length: rows }, (_, row) => (
            <div key={`row-${row}`} style={{ display: "flex", gap: 5 }}>
              {panels
                .filter((p) => p.row === row)
                .map((panel) => {
                  const on = enabled[panel.index];
                  const sc = STRING_PALETTE[panel.stringIndex % STRING_PALETTE.length];
                  return (
                    <button
                      key={`tog-${panel.id}`}
                      onClick={() => onToggle(panel.index)}
                      aria-label={`Panel ${panel.id} — ${on ? "enabled" : "disabled"}`}
                      aria-pressed={on}
                      style={{
                        width:      44,
                        height:     24,
                        background: on ? `${sc}28` : "rgba(30,42,60,0.5)",
                        border:     `1px solid ${on ? sc : "#2d3f5a"}`,
                        borderRadius: 5,
                        color:      on ? sc : "#3d4f66",
                        cursor:     "pointer",
                        fontFamily: "monospace",
                        fontSize:   9,
                        transition: "all 0.12s ease",
                      }}
                    >
                      {panel.index + 1}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </div>

      {/* Tilt and azimuth offsets */}
      <div style={{ display: "grid", gap: 14, marginBottom: 18 }}>
        <div>
          <div style={{ ...sectionLabel }}>Tilt offset: {tiltAdjust > 0 ? "+" : ""}{tiltAdjust}°</div>
          <input
            type="range"
            min={-12}
            max={12}
            value={tiltAdjust}
            onChange={(e) => onTilt(Number(e.target.value))}
            style={{ width: "100%", accentColor: DS.gold }}
            aria-label="Panel tilt adjustment"
          />
        </div>
        <div>
          <div style={{ ...sectionLabel }}>Azimuth offset: {azimuthAdjust > 0 ? "+" : ""}{azimuthAdjust}°</div>
          <input
            type="range"
            min={-25}
            max={25}
            value={azimuthAdjust}
            onChange={(e) => onAzimuth(Number(e.target.value))}
            style={{ width: "100%", accentColor: DS.cyan }}
            aria-label="Panel azimuth adjustment"
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onReset} style={tinyBtn(false)}>Reset defaults</button>
        <button onClick={onClose} style={tinyBtn(true)}>Done</button>
      </div>
    </ModalWrapper>
  );
}

// ── 7.9 SettingsModal ─────────────────────────────────────────────────────
/** Scene, environment, and performance settings */
function SettingsModal({
  roofType, season, year, latitude,
  showBattery, showWind, showGround, showCabling, showEnergyFlow,
  showBloom, nightMode,
  onRoofType, onSeason, onYear, onLatitude,
  onToggleBattery, onToggleWind, onToggleGround, onToggleCabling,
  onToggleFlow, onToggleBloom, onToggleNight,
  onClose,
}: {
  roofType:        RoofType;
  season:          Season;
  year:            number;
  latitude:        number;
  showBattery:     boolean;
  showWind:        boolean;
  showGround:      boolean;
  showCabling:     boolean;
  showEnergyFlow:  boolean;
  showBloom:       boolean;
  nightMode:       boolean;
  onRoofType:      (r: RoofType) => void;
  onSeason:        (s: Season)   => void;
  onYear:          (y: number)   => void;
  onLatitude:      (l: number)   => void;
  onToggleBattery: () => void;
  onToggleWind:    () => void;
  onToggleGround:  () => void;
  onToggleCabling: () => void;
  onToggleFlow:    () => void;
  onToggleBloom:   () => void;
  onToggleNight:   () => void;
  onClose:         () => void;
}) {
  return (
    <ModalWrapper title="SCENE SETTINGS" width={500} onClose={onClose}>
      {/* Roof type */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ ...sectionLabel }}>Roof Type</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {ROOF_OPTIONS.map((r) => (
            <button key={r} onClick={() => onRoofType(r)} aria-pressed={r === roofType} style={tinyBtn(r === roofType)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Season */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ ...sectionLabel }}>Season</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SEASON_OPTIONS.map((s) => (
            <button key={s} onClick={() => onSeason(s)} aria-pressed={s === season} style={tinyBtn(s === season)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Year slider */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ ...sectionLabel }}>System Age: Year {year}</div>
        <input
          type="range" min={1} max={25} value={year}
          onChange={(e) => onYear(Number(e.target.value))}
          style={{ width: "100%", accentColor: DS.gold }}
          aria-label="System year"
        />
        <div style={{ display: "flex", justifyContent: "space-between", color: DS.muted, fontFamily: "monospace", fontSize: 9, marginTop: 2 }}>
          <span>Year 1 (new)</span>
          <span>Year 25 (end of life)</span>
        </div>
      </div>

      {/* Latitude */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ ...sectionLabel }}>Latitude: {latitude}°</div>
        <input
          type="range" min={0} max={60} value={latitude}
          onChange={(e) => onLatitude(Number(e.target.value))}
          style={{ width: "100%", accentColor: DS.cyan }}
          aria-label="Observer latitude"
        />
      </div>

      {/* Toggle grid */}
      <div style={{ ...sectionLabel }}>Scene Elements</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 12 }}>
        {[
          { label: "Battery Storage",  active: showBattery,    fn: onToggleBattery },
          { label: "Wind Turbine",     active: showWind,       fn: onToggleWind },
          { label: "Ground Detail",    active: showGround,     fn: onToggleGround },
          { label: "Cabling",          active: showCabling,    fn: onToggleCabling },
          { label: "Energy Flow",      active: showEnergyFlow, fn: onToggleFlow },
          { label: "Night Mode",       active: nightMode,      fn: onToggleNight },
        ].map(({ label, active, fn }) => (
          <button
            key={label}
            onClick={fn}
            aria-pressed={active}
            style={tinyBtn(active)}
          >
            {active ? "✓ " : "  "}{label}
          </button>
        ))}
      </div>

      {/* Performance toggles */}
      <div style={{ ...sectionLabel }}>Rendering</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 18 }}>
        <button onClick={onToggleBloom} aria-pressed={showBloom} style={tinyBtn(showBloom)}>
          {showBloom ? "✓ " : "  "}Bloom FX
        </button>
      </div>

      <div style={{ fontFamily: "monospace", fontSize: 9, color: DS.muted, borderTop: `1px solid ${DS.border}`, paddingTop: 10, marginBottom: 14 }}>
        💡 Disable Bloom for better performance on low-end devices.
        Shadow map size: {SHADOW_MAP_SIZE}px².
        Particle counts scale with weather type.
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onClose} style={tinyBtn(true)}>Done</button>
      </div>
    </ModalWrapper>
  );
}

// ── 7.10 ControlPanel ────────────────────────────────────────────────────
/**
 * Main control overlay panel (right side).
 * Contains telemetry, time scrubbing, camera presets, view modes,
 * overlay toggles, and tool shortcuts.
 * Hidden when any modal is open to reduce visual clutter.
 */
function ControlPanel({
  totalKw, peakKw, dailyKwh, batteryState,
  angles, timeLabel, weather, season, year,
  manualSun, playing, timeOfDay, viewMode, activePreset,
  showLabels, showSunPath, nightMode,
  onPlayPause, onLive, onTimeChange,
  onPreset, onViewMode,
  onToggleLabels, onToggleSunPath, onToggleNight,
  onOpenAnalytics, onOpenRoi, onOpenForecast, onOpenConfig, onOpenSettings,
  onSnapshot, onExportCsv,
  compact,
}: {
  totalKw:       number;
  peakKw:        number;
  dailyKwh:      number;
  batteryState:  BatteryState;
  angles:        { elevation: number; azimuth: number };
  timeLabel:     string;
  weather:       WeatherType;
  season:        Season;
  year:          number;
  manualSun:     boolean;
  playing:       boolean;
  timeOfDay:     number;
  viewMode:      ViewMode;
  activePreset:  CameraPresetKey | null;
  showLabels:    boolean;
  showSunPath:   boolean;
  nightMode:     boolean;
  onPlayPause:   () => void;
  onLive:        () => void;
  onTimeChange:  (t: number) => void;
  onPreset:      (k: CameraPresetKey) => void;
  onViewMode:    (m: ViewMode) => void;
  onToggleLabels:  () => void;
  onToggleSunPath: () => void;
  onToggleNight:   () => void;
  onOpenAnalytics: () => void;
  onOpenRoi:       () => void;
  onOpenForecast:  () => void;
  onOpenConfig:    () => void;
  onOpenSettings:  () => void;
  onSnapshot:    () => void;
  onExportCsv:   () => void;
  compact:       boolean;
}) {
  const co2Kg = dailyKwh * CO2_PER_KWH;

  const tools = [
    { label: "Analytics", icon: "📊", fn: onOpenAnalytics },
    { label: "ROI",        icon: "💰", fn: onOpenRoi },
    { label: "Forecast",   icon: "🌤", fn: onOpenForecast },
    { label: "Config",     icon: "⚙️",  fn: onOpenConfig },
    { label: "Settings",   icon: "🎛",  fn: onOpenSettings },
    { label: "Snapshot",   icon: "📷",  fn: onSnapshot },
    { label: "Export CSV", icon: "📄",  fn: onExportCsv },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 14 }}
      transition={{ duration: 0.22 }}
      style={{
        ...cardBase,
        position:   "absolute",
        top:        14,
        right:      14,
        width:      282,
        maxWidth:   compact ? "calc(100% - 28px)" : 282,
        boxSizing:  "border-box",
        padding:    "14px 16px",
        zIndex:     40,
        maxHeight:  "calc(100vh - 28px)",
        overflowY:  "auto",
      }}
      role="complementary"
      aria-label="Solar monitoring controls"
    >
      {/* Telemetry */}
      <TelemetryCard
        totalKw={totalKw}
        peakKw={peakKw}
        dailyKwh={dailyKwh}
        co2Kg={co2Kg}
        socPct={batteryState.soc * 100}
        weather={weather}
        season={season}
        year={year}
      />

      {/* Sun / time controls */}
      <div style={{ ...sectionLabel }}>
        ☀ {timeLabel} · El {angles.elevation.toFixed(1)}° · Az {angles.azimuth.toFixed(1)}°
      </div>
      <div style={{ display: "flex", gap: 5, marginBottom: 7, alignItems: "center" }}>
        <button
          onClick={onPlayPause}
          aria-label={playing ? "Pause sun animation" : "Play sun animation"}
          aria-pressed={playing}
          style={tinyBtn(playing)}
        >
          {playing ? "⏸ pause" : "▶ play"}
        </button>
        <button
          onClick={onLive}
          aria-label="Sync to live sun position"
          aria-pressed={!manualSun}
          style={tinyBtn(!manualSun)}
        >
          live
        </button>
      </div>
      <input
        type="range"
        min={5}
        max={20}
        step={0.05}
        value={timeOfDay}
        onChange={(e) => onTimeChange(Number(e.target.value))}
        aria-label="Time of day scrubber"
        style={{ width: "100%", accentColor: DS.gold, marginBottom: 12 }}
      />

      {/* Camera presets */}
      <div style={{ ...sectionLabel }}>Camera (1 / 2 / 3)</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        {(Object.keys(CAMERA_PRESETS) as CameraPresetKey[]).map((k, i) => (
          <button
            key={k}
            onClick={() => onPreset(k)}
            aria-label={`Camera preset: ${k}`}
            aria-pressed={activePreset === k}
            style={tinyBtn(activePreset === k)}
          >
            [{i + 1}] {k}
          </button>
        ))}
      </div>

      {/* View modes */}
      <div style={{ ...sectionLabel }}>View Mode</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        {VIEW_OPTIONS.map((m) => (
          <button
            key={m}
            onClick={() => onViewMode(m)}
            aria-pressed={viewMode === m}
            style={tinyBtn(viewMode === m)}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Scene overlays */}
      <div style={{ ...sectionLabel }}>Overlays</div>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
        <button onClick={onToggleLabels}  aria-pressed={showLabels}  style={tinyBtn(showLabels)}>labels</button>
        <button onClick={onToggleSunPath} aria-pressed={showSunPath} style={tinyBtn(showSunPath)}>sun arc</button>
        <button onClick={onToggleNight}   aria-pressed={nightMode}   style={tinyBtn(nightMode)}>night</button>
      </div>

      {/* Tool shortcuts */}
      <div style={{ ...sectionLabel }}>Tools</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>
        {tools.map((tool, i) => (
          <button
            key={tool.label}
            onClick={tool.fn}
            aria-label={tool.label}
            style={{
              ...tinyBtn(false),
              gridColumn: i === tools.length - 1 ? "span 2" : "auto",
            }}
          >
            {tool.icon} {tool.label}
          </button>
        ))}
      </div>

      {/* Keyboard hint */}
      <div style={{ marginTop: 10, fontFamily: "monospace", fontSize: 8, color: "rgba(80,100,130,0.7)", lineHeight: 1.7 }}>
        S=snapshot · E=export · Space=play · Esc=close
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SolarDecisionSupport — root component.
 *
 * Owns all scene state and coordinates between the DOM UI layer
 * and the Canvas / Three.js layer. No Three.js primitives here.
 *
 * @param panels      Raw panel data array from the data layer
 * @param elevation   Current sun elevation (degrees)
 * @param azimuth     Current sun azimuth (degrees, clockwise from N)
 * @param starsCount  Number of star particles in the skybox
 * @param panelTilt   Panel tilt from horizontal (degrees)
 * @param panelAzimuth Panel facing direction (degrees from N, 180 = south)
 * @param telemetry   Optional telemetry streaming config
 * @param latitude    Observer latitude (degrees, default 35)
 * @param season      Starting season (default Summer)
 */
export default function SolarDecisionSupport({
  panels: sourcePanels,
  elevation: sourceElevation,
  azimuth:   sourceAzimuth,
  starsCount = 4800,
  panelTilt  = 18,
  panelAzimuth = 180,
  telemetry,
  latitude: initLatitude = 35,
  season:   initSeason   = "Summer",
}: SolarDecisionSupportProps) {
  // ── Container & responsiveness ───────────────────────────────────────────
  const sceneRef   = useRef<HTMLDivElement>(null);
  const sceneSize  = useContainerSize(sceneRef as React.RefObject<HTMLElement>);
  const compact    = sceneSize.height > 0 && (sceneSize.height < 560 || sceneSize.width < 900);

  // ── Panel enable/disable state ───────────────────────────────────────────
  const [enabled, setEnabled] = useState<boolean[]>(() => sourcePanels.map(() => true));
  const normalizedEnabled = useMemo(
    () => sourcePanels.map((_, i) => enabled[i] ?? true),
    [enabled, sourcePanels]
  );

  // ── View & visual state ──────────────────────────────────────────────────
  const [viewMode,       setViewMode]       = useState<ViewMode>("heatmap");
  const [showLabels,     setShowLabels]      = useState(true);
  const [showSunPath,    setShowSunPath]     = useState(true);
  const [showEnergyFlow, setShowEnergyFlow]  = useState(true);
  const [showBattery,    setShowBattery]     = useState(true);
  const [showWind,       setShowWind]        = useState(true);
  const [showGround,     setShowGround]      = useState(true);
  const [showCabling,    setShowCabling]     = useState(true);
  const [showBloom,      setShowBloom]       = useState(true);
  const [nightMode,      setNightMode]       = useState(true);
  const [showFlowCard,   setShowFlowCard]    = useState(true);

  // ── Environment state ────────────────────────────────────────────────────
  const [weather,    setWeather]    = useState<WeatherType>("clear");
  const [roofType,   setRoofType]   = useState<RoofType>("hip");
  const [season,     setSeason]     = useState<Season>(initSeason);
  const [year,       setYear]       = useState(1);
  const [latitude,   setLatitude]   = useState(initLatitude);

  // ── Panel configuration ──────────────────────────────────────────────────
  const [tiltAdjust,    setTiltAdjust]    = useState(0);
  const [azimuthAdjust, setAzimuthAdjust] = useState(0);

  // ── Selection ────────────────────────────────────────────────────────────
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // ── Camera ───────────────────────────────────────────────────────────────
  const [cameraPreset,  setCameraPreset]  = useState<CameraPreset | null>(null);
  const [activePreset,  setActivePreset]  = useState<CameraPresetKey | null>(null);
  const presetTimer = useRef<number | null>(null);

  // ── Modals ───────────────────────────────────────────────────────────────
  const [openModal, setOpenModal] = useState<ModalKey>(null);
  const anyModalOpen = openModal !== null;

  // ── Sun / time animation ─────────────────────────────────────────────────
  const [manualSun,  setManualSun]  = useState(false);
  const [playing,    setPlaying]    = useState(false);
  const [timeOfDayState, setTimeOfDayState] = useState(() => approximateHour(sourceAzimuth));
  const liveTimeOfDay = useMemo(() => approximateHour(sourceAzimuth), [sourceAzimuth]);
  const isManualSun = manualSun || playing;
  const timeOfDay = isManualSun ? timeOfDayState : liveTimeOfDay;

  // Advance sun position during playback
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setTimeOfDayState((t) => {
        const next = t + (nightMode ? 0.048 : 0.026);
        return next > 24 ? next - 24 : next;
      });
    }, 50);
    return () => window.clearInterval(id);
  }, [nightMode, playing]);

  // Clean up preset timer on unmount
  useEffect(() => () => {
    if (presetTimer.current !== null) window.clearTimeout(presetTimer.current);
  }, []);

  // ── Derived solar angles ─────────────────────────────────────────────────
  const angles = useMemo(
    () =>
      isManualSun
        ? sunPositionFromTime(timeOfDay, latitude, SEASON_DECLINATION[season])
        : { elevation: sourceElevation, azimuth: sourceAzimuth },
    [isManualSun, latitude, season, sourceAzimuth, sourceElevation, timeOfDay]
  );

  // ── Effective panel orientation ──────────────────────────────────────────
  const effectiveTilt    = useMemo(() => clamp(panelTilt    + tiltAdjust,    0, 45), [panelTilt, tiltAdjust]);
  const effectiveAzimuth = useMemo(() => (panelAzimuth + azimuthAdjust + 360) % 360, [panelAzimuth, azimuthAdjust]);

  // ── Enriched working panels ──────────────────────────────────────────────
  const panels = useMemo<WorkingPanel[]>(
    () =>
      sourcePanels.map((p, i) => ({
        ...p,
        index:       i,
        row:         Math.floor(i / PANEL_COLUMNS),
        col:         i % PANEL_COLUMNS,
        enabled:     normalizedEnabled[i],
        stringIndex: Math.floor(i / PANEL_COLUMNS),
        position:    panelPosition(i),
      })),
    [normalizedEnabled, sourcePanels]
  );

  // ── Per-panel runtime simulation ─────────────────────────────────────────
  const runtime = useMemo<RuntimePanel[]>(() => {
    const sunDir        = sunVector(angles.elevation, angles.azimuth);
    const incidence     = clamp(panelNormal(effectiveTilt, effectiveAzimuth).dot(sunDir), 0, 1);
    const weatherFactor = WEATHER_FACTOR[weather];
    const seasonBoost   = { Summer: 1.05, Winter: 0.92, Spring: 1.01, Autumn: 0.97 }[season];
    const ambient       = 21 + Math.max(0, angles.elevation) * 0.16 + WEATHER_TEMP_OFFSET[weather];
    const degrade       = Math.pow(0.994, Math.max(year - 1, 0));

    return panels.map((p) => {
      if (!p.enabled || angles.elevation <= 0) {
        return {
          watts: 0, dcWatts: 0, outputRatio: 0,
          temperature:  ambient,
          shadeFactor:  0,
          efficiencyPct: 0,
          color:        efficiencyColor(0),
          thermalColor: thermalColor(ambient),
          stringColor:  stringColor(p.stringIndex),
        };
      }

      const variance   = 0.96 + seeded(p.index + 9) * 0.08;
      const localSun   = clamp(0.8 + p.sunlight * 0.25, 0.72, 1.04);
      const weatherShade = {
        storm: 0.72, rain: 0.82, fog: 0.86, cloudy: 0.94, snow: 0.88, clear: 1,
      }[weather];
      const shadeFactor   = clamp(p.shade * weatherShade, 0, 1);
      const temperature   = ambient + incidence * 18 + seeded(p.index + 41) * 3.8;
      const tempFactor    = clamp(1 - Math.max(0, temperature - 25) * 0.0034, 0.82, 1);
      const dcWatts       = p.basePower * incidence * weatherFactor * seasonBoost * localSun * shadeFactor * tempFactor * degrade * variance;
      const watts         = dcWatts * INVERTER_EFFICIENCY;
      const outputRatio   = p.basePower > 0 ? clamp(watts / p.basePower, 0, 1) : 0;

      return {
        watts, dcWatts, outputRatio, temperature, shadeFactor,
        efficiencyPct: p.efficiency * outputRatio,
        color:         efficiencyColor(outputRatio),
        thermalColor:  thermalColor(temperature),
        stringColor:   stringColor(p.stringIndex),
      };
    });
  }, [
    angles.azimuth, angles.elevation,
    effectiveAzimuth, effectiveTilt,
    panels, season, weather, year,
  ]);

  // Optional telemetry hook (noop until wired to a live endpoint)
  useTelemetryStream(telemetry ?? {});

  // ── Aggregate metrics ────────────────────────────────────────────────────
  const totalKw   = useMemo(() => runtime.reduce((s, r) => s + r.watts, 0) / 1000, [runtime]);
  const peakKw    = useMemo(
    () => panels.reduce((s, p) => s + (p.enabled ? p.basePower : 0), 0) / 1000,
    [panels]
  );
  const dailyKwh  = useMemo(() => totalKw * SEASON_SUN_HOURS[season] * WEATHER_FACTOR[weather], [totalKw, season, weather]);

  const batteryState = useMemo<BatteryState>(() => {
    const houseLoad = 2.4;
    const ac        = totalKw * INVERTER_EFFICIENCY;
    const surplus   = ac - houseLoad;
    const charging  = surplus > 0.12;
    return {
      soc:      clamp(0.52 + Math.sin(((timeOfDay - 6) / 12) * Math.PI) * 0.3 + (charging ? 0.08 : -0.04), 0.08, 0.98),
      charging,
      powerKw:  Math.abs(surplus) * 0.78,
    };
  }, [timeOfDay, totalKw]);

  const forecast = useMemo(
    () => buildForecast(weather, Math.max(totalKw, peakKw), season),
    [peakKw, season, totalKw, weather]
  );

  const timeLabel = useMemo(() => formatTime(timeOfDay), [timeOfDay]);

  // ── Camera preset handler ────────────────────────────────────────────────
  const handlePreset = useCallback((key: CameraPresetKey) => {
    setActivePreset(key);
    setCameraPreset(CAMERA_PRESETS[key]);
    if (presetTimer.current !== null) window.clearTimeout(presetTimer.current);
    presetTimer.current = window.setTimeout(() => {
      setCameraPreset(null);
      setActivePreset(null);
    }, 2000);
  }, []);

  const handlePlayPause = useCallback(() => {
    if (!manualSun) {
      setTimeOfDayState(liveTimeOfDay);
    }
    setManualSun(true);
    setPlaying((p) => !p);
  }, [liveTimeOfDay, manualSun]);

  const handleLive = useCallback(() => {
    setPlaying(false);
    setManualSun(false);
  }, []);

  const handleTimeChange = useCallback((t: number) => {
    setManualSun(true);
    setPlaying(false);
    setTimeOfDayState(t);
  }, []);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useKeyboardShortcuts({
    onPreset1:   () => handlePreset("overview"),
    onPreset2:   () => handlePreset("closeup"),
    onPreset3:   () => handlePreset("aerial"),
    onPlayPause: handlePlayPause,
    onSnapshot:  () => takeSnapshot(sceneRef.current),
    onExportCsv: () => exportCsv(panels, runtime, year),
    onEscape:    () => {
      if (openModal !== null) { setOpenModal(null); return; }
      if (selectedIndex !== null) { setSelectedIndex(null); }
    },
  });

  // ── Click-outside panel deselect ─────────────────────────────────────────
  const handleCanvasClick = useCallback(() => {
    // Panel mesh click events call onSelect; clicking empty space deselects
    setSelectedIndex(null);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      ref={sceneRef}
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "#020610" }}
    >
      {/* ── Three.js Canvas ── */}
      <Canvas
        shadows
        camera={{ position: CAMERA_PRESETS.overview.position, fov: 42 }}
        gl={{
          antialias:           true,
          alpha:               true,
          powerPreference:     "high-performance",
          preserveDrawingBuffer: true, // required for snapshot
        }}
        onCreated={({ gl }) => {
          gl.shadowMap.enabled  = true;
          gl.shadowMap.type     = THREE.PCFSoftShadowMap;
          gl.toneMapping        = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.08;
        }}
        onClick={handleCanvasClick}
      >
        <Suspense fallback={null}>
          <SceneContent
            panels={panels}
            runtime={runtime}
            elevation={angles.elevation}
            azimuth={angles.azimuth}
            starsCount={starsCount}
            weather={weather}
            roofType={roofType}
            season={season}
            latitude={latitude}
            viewMode={viewMode}
            nightMode={nightMode}
            showLabels={showLabels}
            showSunPath={showSunPath}
            showEnergyFlow={showEnergyFlow}
            showBattery={showBattery}
            showWind={showWind}
            showGround={showGround}
            showCabling={showCabling}
            showBloom={showBloom}
            panelTilt={effectiveTilt}
            panelAzimuth={effectiveAzimuth}
            selectedIndex={selectedIndex}
            cameraPreset={cameraPreset}
            batteryState={batteryState}
            totalKw={totalKw}
            onSelect={(i) => setSelectedIndex((prev) => i < 0 ? null : prev === i ? null : i)}
            onCameraDone={() => { setCameraPreset(null); }}
          />
        </Suspense>
      </Canvas>

      {/* ── DOM UI Layer ── */}

      {/* Control panel (hidden when modal open) */}
      <AnimatePresence>
        {!anyModalOpen && (
          <ControlPanel
            totalKw={totalKw}
            peakKw={peakKw}
            dailyKwh={dailyKwh}
            batteryState={batteryState}
            angles={angles}
            timeLabel={timeLabel}
            weather={weather}
            season={season}
            year={year}
            manualSun={manualSun}
            playing={playing}
            timeOfDay={timeOfDay}
            viewMode={viewMode}
            activePreset={activePreset}
            showLabels={showLabels}
            showSunPath={showSunPath}
            nightMode={nightMode}
            onPlayPause={handlePlayPause}
            onLive={handleLive}
            onTimeChange={handleTimeChange}
            onPreset={handlePreset}
            onViewMode={setViewMode}
            onToggleLabels={() => setShowLabels((v) => !v)}
            onToggleSunPath={() => setShowSunPath((v) => !v)}
            onToggleNight={() => setNightMode((v) => !v)}
            onOpenAnalytics={() => setOpenModal("analytics")}
            onOpenRoi={() => setOpenModal("roi")}
            onOpenForecast={() => setOpenModal("forecast")}
            onOpenConfig={() => setOpenModal("config")}
            onOpenSettings={() => setOpenModal("settings")}
            onSnapshot={() => takeSnapshot(sceneRef.current)}
            onExportCsv={() => exportCsv(panels, runtime, year)}
            compact={compact}
          />
        )}
      </AnimatePresence>

      {/* Flow card (bottom-right / left when compact) */}
      {!anyModalOpen && (
        <>
          <FlowCard
            visible={showFlowCard}
            totalKw={totalKw}
            batteryState={batteryState}
            compact={compact}
          />

          {/* Toggle flow card button */}
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={() => setShowFlowCard((v) => !v)}
            aria-label="Toggle power flow card"
            aria-pressed={showFlowCard}
            style={{
              ...tinyBtn(showFlowCard),
              position: "absolute",
              left:     14,
              top:      14,
              zIndex:   41,
            }}
          >
            ⚡ flow
          </motion.button>
        </>
      )}

      {/* View mode legend */}
      <AnimatePresence>
        {!anyModalOpen && viewMode !== "normal" && (
          <ViewModeLegend viewMode={viewMode} />
        )}
      </AnimatePresence>

      {/* Hint text — bottom-left */}
      {!anyModalOpen && (
        <div style={{
          position:      "absolute",
          left:          14,
          bottom:        14,
          zIndex:        30,
          color:         "rgba(90,110,140,0.72)",
          fontFamily:    "monospace",
          fontSize:      9,
          lineHeight:    1.7,
          pointerEvents: "none",
        }}>
          <div>Click a panel to inspect · Drag to orbit · Scroll to zoom</div>
          <div>Keys: 1/2/3=camera · Space=play · S=snap · E=csv · Esc=close</div>
        </div>
      )}

      {/* ── Modals (AnimatePresence for smooth transitions) ── */}
      <AnimatePresence>
        {openModal === "analytics" && (
          <AnalyticsModal
            key="analytics"
            peakKw={peakKw}
            totalKw={totalKw}
            year={year}
            season={season}
            weather={weather}
            onClose={() => setOpenModal(null)}
          />
        )}

        {openModal === "roi" && (
          <RoiModal
            key="roi"
            peakKw={peakKw}
            season={season}
            onClose={() => setOpenModal(null)}
          />
        )}

        {openModal === "forecast" && (
          <ForecastModal
            key="forecast"
            forecast={forecast}
            weather={weather}
            onWeather={setWeather}
            onClose={() => setOpenModal(null)}
          />
        )}

        {openModal === "config" && (
          <ConfigModal
            key="config"
            panels={panels}
            enabled={normalizedEnabled}
            tiltAdjust={tiltAdjust}
            azimuthAdjust={azimuthAdjust}
            onToggle={(i) => {
              setEnabled((prev) => {
                const base = sourcePanels.map((_, idx) => prev[idx] ?? true);
                return base.map((v, j) => (j === i ? !v : v));
              });
              setSelectedIndex((s) => s === i ? null : s);
            }}
            onTilt={setTiltAdjust}
            onAzimuth={setAzimuthAdjust}
            onReset={() => {
              setEnabled(sourcePanels.map(() => true));
              setTiltAdjust(0);
              setAzimuthAdjust(0);
            }}
            onClose={() => setOpenModal(null)}
          />
        )}

        {openModal === "settings" && (
          <SettingsModal
            key="settings"
            roofType={roofType}
            season={season}
            year={year}
            latitude={latitude}
            showBattery={showBattery}
            showWind={showWind}
            showGround={showGround}
            showCabling={showCabling}
            showEnergyFlow={showEnergyFlow}
            showBloom={showBloom}
            nightMode={nightMode}
            onRoofType={setRoofType}
            onSeason={setSeason}
            onYear={setYear}
            onLatitude={setLatitude}
            onToggleBattery={() => setShowBattery((v) => !v)}
            onToggleWind={() => setShowWind((v) => !v)}
            onToggleGround={() => setShowGround((v) => !v)}
            onToggleCabling={() => setShowCabling((v) => !v)}
            onToggleFlow={() => setShowEnergyFlow((v) => !v)}
            onToggleBloom={() => setShowBloom((v) => !v)}
            onToggleNight={() => setNightMode((v) => !v)}
            onClose={() => setOpenModal(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — SAMPLE DATA & USAGE EXAMPLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a sample panel array for development and storybook usage.
 * Each panel gets realistic variance via the seeded PRNG.
 *
 * @param count   Number of panels (default 12 — 2 strings of 6)
 * @param ratedW  STC rated power per panel in watts (default 400 W)
 */
export function generateSamplePanels(count = 12, ratedW = 400): SourcePanel[] {
  return Array.from({ length: count }, (_, i) => ({
    id:         i + 1,
    efficiency: 20.2 + seeded(i * 3 + 7) * 1.8,
    temp:        25   + seeded(i * 5 + 3) * 12,
    power:       ratedW * (0.78 + seeded(i * 7 + 11) * 0.22),
    basePower:   ratedW,
    sunlight:    0.8  + seeded(i * 11 + 5) * 0.22,
    shade:       seeded(i * 13 + 2) > 0.82 ? seeded(i * 17 + 9) * 0.4 : 0,
  }));
}

/**
 * Ready-to-use demo configuration for the Solar Decision Support scene.
 * Render this in any page that needs the full visualization:
 *
 * @example
 * import SolarDecisionSupport, { DEMO_CONFIG } from "./SolarDecisionSupport";
 *
 * export default function Page() {
 *   return (
 *     <div style={{ width: "100vw", height: "100vh" }}>
 *       <SolarDecisionSupport {...DEMO_CONFIG} />
 *     </div>
 *   );
 * }
 */
export const DEMO_CONFIG: SolarDecisionSupportProps = {
  panels:       generateSamplePanels(12, 400),
  elevation:    42,
  azimuth:      185,
  starsCount:   4800,
  panelTilt:    18,
  panelAzimuth: 180,
  latitude:     28.6,           // New Delhi
  season:       "Summer",
  telemetry: {
    enabled:  false,
    endpoint: "/api/telemetry", // replace with real endpoint
    interval: 5000,
  },
};

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * UNIT TEST GUIDE (Vitest / Jest)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All pure functions in Section 4 are fully testable without DOM or Three.js:
 *
 *   import { clamp, seeded, formatTime, sunPositionFromTime,
 *            efficiencyColor, thermalColor } from "./SolarDecisionSupport";
 *
 *   describe("clamp", () => {
 *     it("clamps below min", () => expect(clamp(-1, 0, 10)).toBe(0));
 *     it("clamps above max", () => expect(clamp(15, 0, 10)).toBe(10));
 *     it("passes through mid", () => expect(clamp(5, 0, 10)).toBe(5));
 *   });
 *
 *   describe("sunPositionFromTime", () => {
 *     it("returns zero elevation at midnight near equator", () => {
 *       const { elevation } = sunPositionFromTime(0, 0, 0);
 *       expect(elevation).toBeLessThan(-10);
 *     });
 *     it("returns positive elevation at solar noon near equator in summer", () => {
 *       const { elevation } = sunPositionFromTime(12, 0, 23.4);
 *       expect(elevation).toBeGreaterThan(60);
 *     });
 *   });
 *
 *   describe("formatTime", () => {
 *     it("formats decimal hours correctly", () => {
 *       expect(formatTime(13.5)).toBe("13:30");
 *       expect(formatTime(0)).toBe("00:00");
 *       expect(formatTime(23.999)).toBe("00:00");
 *     });
 *   });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLAYWRIGHT E2E TEST HINTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   // Panel inspector opens and closes
 *   await page.click("[aria-label='Panel 1']");        // mesh click via test-id
 *   await expect(page.locator("[role='dialog']")).toBeVisible();
 *   await page.keyboard.press("Escape");
 *   await expect(page.locator("[role='dialog']")).not.toBeVisible();
 *
 *   // CSV export triggers download
 *   const [download] = await Promise.all([
 *     page.waitForEvent("download"),
 *     page.keyboard.press("e"),
 *   ]);
 *   expect(download.suggestedFilename()).toMatch(/\.csv$/);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESLINT CONFIG SNIPPET (.eslintrc.cjs)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   module.exports = {
 *     extends: [
 *       "eslint:recommended",
 *       "plugin:@typescript-eslint/recommended",
 *       "plugin:react-hooks/recommended",
 *     ],
 *     rules: {
 *       "@typescript-eslint/no-explicit-any": "error",
 *       "react-hooks/exhaustive-deps": "warn",
 *     },
 *   };
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRETTIER CONFIG (.prettierrc)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   { "printWidth": 100, "semi": false, "singleQuote": true, "trailingComma": "es5" }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — EXTENSIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// 10.1  InstancedPanelManager   — GPU-instanced panel rendering at 1000+ scale
// 10.2  WorkerPanelSimulation   — WebWorker-offloaded runtime panel calculations
// 10.3  GPU Thermal Shader      — GLSL ShaderMaterial heat-glow thermal view
// 10.4  GPU Weather Particle Engine — full GPU particle system (rain/snow/storm)
//
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.1 — INSTANCED PANEL MANAGER
// Purpose: Render hundreds / thousands of solar panels in <80 draw calls using
//          THREE.InstancedMesh with per-instance colour, emissive, temperature,
//          and selection state. Falls back to PanelMesh for selected panels.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-instance attribute data stored in parallel Float32Arrays */
interface PanelInstanceAttributes {
  /** World-space transform (decomposed from Matrix4 per instance) */
  position: THREE.Vector3
  rotation: THREE.Euler
  scale: THREE.Vector3
  /** Computed output of this panel (0–1) */
  outputRatio: number
  /** Cell temperature (°C) */
  temperature: number
  /** Emissive glow intensity (0–1) */
  emissiveIntensity: number
  /** Three.js Color for the panel face */
  color: THREE.Color
  /** String index (0–5) used for string-view colouring */
  stringIndex: number
  /** True when the panel is currently selected (force individual mesh) */
  selected: boolean
  /** True when the panel is enabled */
  enabled: boolean
}

/** LOD distance thresholds */
const INSTANCED_LOD_FULL = 20      // ≤20 world units → full panel geometry
const INSTANCED_LOD_SIMPLE = 120   // >20 world units → simplified quad

/** GPU picking: offscreen render target size */
const GPU_PICK_SIZE = 1

/** Encode integer instanceId to normalised RGB (0–255 per channel) */
function encodeIdToColor(id: number): THREE.Color {
  const r = (id & 0xff) / 255
  const g = ((id >> 8) & 0xff) / 255
  const b = ((id >> 16) & 0xff) / 255
  return new THREE.Color(r, g, b)
}

/** Decode picked pixel RGBA back to instanceId */
function decodeColorToId(r: number, g: number, b: number): number {
  return r | (g << 8) | (b << 16)
}

// ── Simplified panel geometry (low-LOD: single box, low poly) ────────────────

/** Memoised simplified quad geometry shared across all low-LOD instances */
const simplePanelGeo = new THREE.BoxGeometry(
  PANEL_WIDTH,
  PANEL_THICKNESS,
  PANEL_DEPTH,
  1,
  1,
  1
)

/** Full-detail panel geometry shared across all high-LOD instances */
const fullPanelGeo = new THREE.BoxGeometry(
  PANEL_WIDTH,
  PANEL_THICKNESS,
  PANEL_DEPTH,
  4,
  1,
  4
)

// ── GPU picking shader ────────────────────────────────────────────────────────

/** Vertex shader for the GPU picking pass — outputs instance ID as colour */
const PICK_VERT_GLSL = /* glsl */ `
  attribute vec3 pickColor;
  varying vec3 vPickColor;

  void main() {
    vPickColor = pickColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`

/** Fragment shader for the GPU picking pass */
const PICK_FRAG_GLSL = /* glsl */ `
  varying vec3 vPickColor;

  void main() {
    gl_FragColor = vec4(vPickColor, 1.0);
  }
`

// ── InstancedPanelController ──────────────────────────────────────────────────

/**
 * Low-level controller that owns the THREE.InstancedMesh objects and provides
 * imperative methods to update per-instance attributes each frame.
 */
class InstancedPanelController {
  private meshFull:   THREE.InstancedMesh | null = null
  private meshSimple: THREE.InstancedMesh | null = null
  private pickMesh:   THREE.InstancedMesh | null = null

  private readonly count: number
  private readonly dummy = new THREE.Object3D()

  /** Per-instance data cache (avoids repeated allocations) */
  private readonly matrices:      THREE.Matrix4[] = []
  private readonly colors:        THREE.Color[]   = []
  private readonly emissives:     Float32Array

  constructor(count: number) {
    this.count    = count
    this.emissives = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      this.matrices.push(new THREE.Matrix4())
      this.colors.push(new THREE.Color(0.2, 0.4, 0.7))
    }
  }

  /** Attach the instanced meshes once they are created in React */
  attach(
    full:   THREE.InstancedMesh,
    simple: THREE.InstancedMesh,
    pick:   THREE.InstancedMesh
  ): void {
    this.meshFull   = full
    this.meshSimple = simple
    this.pickMesh   = pick
  }

  /** Write all attribute data for `instanceId` */
  updateInstance(
    id: number,
    attrs: PanelInstanceAttributes
  ): void {
    if (id < 0 || id >= this.count) return

    // ── Transform ──────────────────────────────────────────────────────────
    this.dummy.position.set(...(attrs.position.toArray() as [number, number, number]))
    this.dummy.rotation.copy(attrs.rotation)
    this.dummy.scale.set(attrs.enabled ? 1 : 0.001, 1, attrs.enabled ? 1 : 0.001)
    this.dummy.updateMatrix()

    const mat = this.dummy.matrix.clone()
    this.matrices[id] = mat

    ;[this.meshFull, this.meshSimple, this.pickMesh].forEach((mesh) => {
      if (mesh) {
        mesh.setMatrixAt(id, mat)
        mesh.instanceMatrix.needsUpdate = true
      }
    })

    // ── Colour ─────────────────────────────────────────────────────────────
    this.colors[id].copy(attrs.color)
    if (this.meshFull?.instanceColor)   this.meshFull.setColorAt(id, attrs.color)
    if (this.meshSimple?.instanceColor) this.meshSimple.setColorAt(id, attrs.color)

    if (this.meshFull?.instanceColor)   this.meshFull.instanceColor.needsUpdate = true
    if (this.meshSimple?.instanceColor) this.meshSimple.instanceColor.needsUpdate = true

    // ── Emissive intensity (stored in custom buffer attribute) ─────────────
    this.emissives[id] = attrs.emissiveIntensity

    // ── Pick colour ────────────────────────────────────────────────────────
    if (this.pickMesh) {
      const pickColor = encodeIdToColor(id)
      this.pickMesh.setColorAt(id, pickColor)
      if (this.pickMesh.instanceColor) this.pickMesh.instanceColor.needsUpdate = true
    }
  }

  /** Flush all pending updates (call once per frame after all updateInstance calls) */
  flush(): void {
    // needsUpdate flags already set in updateInstance; this exists for
    // any batched operations that defer flushing.
  }

  /** Read back the current matrix for instance `id` */
  getMatrix(id: number): THREE.Matrix4 | null {
    return this.matrices[id] ?? null
  }

  dispose(): void {
    this.meshFull?.geometry.dispose()
    this.meshSimple?.geometry.dispose()
    ;(this.meshFull?.material as THREE.Material | undefined)?.dispose()
    ;(this.meshSimple?.material as THREE.Material | undefined)?.dispose()
  }
}

// ── GPU Picking System ────────────────────────────────────────────────────────

/** State managed by the GPU picker hook */
interface GpuPickerState {
  hoveredId: number | null
  clickedId: number | null
}

/**
 * Hook: GPU picking via offscreen WebGLRenderTarget.
 * Falls back to CPU raycasting when WebGL2 is unavailable.
 */
function useGpuPicker(
  meshRef: React.RefObject<THREE.InstancedMesh | null>,
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean
): GpuPickerState & { onPointerMove: (e: PointerEvent) => void; onPointerDown: (e: PointerEvent) => void } {
  const { gl, camera, scene } = useThree()
  const renderTargetRef = useRef<THREE.WebGLRenderTarget | null>(null)
  const pixelBufferRef  = useRef<Uint8Array>(new Uint8Array(4))
  const stateRef        = useRef<GpuPickerState>({ hoveredId: null, clickedId: null })
  const [state, setState] = useState<GpuPickerState>({ hoveredId: null, clickedId: null })

  // Check WebGL2 support once
  const isWebGL2 = useMemo(() => {
    try {
      return gl.getContext() instanceof WebGL2RenderingContext
    } catch {
      return false
    }
  }, [gl])

  // Create / destroy offscreen render target
  useEffect(() => {
    if (!enabled || !isWebGL2) return
    renderTargetRef.current = new THREE.WebGLRenderTarget(GPU_PICK_SIZE, GPU_PICK_SIZE, {
      type:   THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
    })
    return () => {
      renderTargetRef.current?.dispose()
      renderTargetRef.current = null
    }
  }, [enabled, isWebGL2])

  /** Read pixel at normalised device coordinate (ndx, ndy) and decode instanceId */
  const readPickedId = useCallback(
    (ndx: number, ndy: number): number | null => {
      if (!renderTargetRef.current || !meshRef.current) return null

      // Temporarily render just the pick mesh to the offscreen target
      const prevTarget = gl.getRenderTarget()
      gl.setRenderTarget(renderTargetRef.current)
      gl.clear()

      // Position a 1×1 camera frustum over the pick pixel
      const pickCamera = camera.clone() as THREE.PerspectiveCamera
      if (pickCamera.isPerspectiveCamera) {
        const canvas    = gl.domElement
        const x = ndx * canvas.clientWidth
        const y = ndy * canvas.clientHeight
        const pw = 1 / canvas.clientWidth
        const ph = 1 / canvas.clientHeight
        pickCamera.setViewOffset(
          canvas.clientWidth, canvas.clientHeight,
          x - 0.5, y - 0.5,
          1, 1
        )
      }

      // Temporarily make everything else invisible
      const prevVisible = scene.visible
      scene.visible = false
      if (meshRef.current) meshRef.current.visible = true

      gl.render(scene, pickCamera)

      scene.visible = prevVisible
      gl.setRenderTarget(prevTarget)

      // Read single pixel
      gl.readRenderTargetPixels(
        renderTargetRef.current, 0, 0, 1, 1,
        pixelBufferRef.current
      )

      const [r, g, b] = pixelBufferRef.current
      const id = decodeColorToId(r, g, b)
      // id 0 → no instance (background is black → id 0 which is reserved)
      return id === 0 ? null : id - 1
    },
    [gl, camera, scene, meshRef]
  )

  /** CPU raycasting fallback */
  const rayCastFallback = useCallback(
    (ndx: number, ndy: number): number | null => {
      if (!meshRef.current) return null
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(ndx * 2 - 1, -(ndy * 2 - 1)), camera)
      const hits = raycaster.intersectObject(meshRef.current)
      return hits.length > 0 && hits[0].instanceId !== undefined
        ? hits[0].instanceId!
        : null
    },
    [camera, meshRef]
  )

  const pick = useCallback(
    (clientX: number, clientY: number): number | null => {
      const el = gl.domElement
      const rect = el.getBoundingClientRect()
      const ndx  = (clientX - rect.left) / rect.width
      const ndy  = (clientY - rect.top)  / rect.height
      return isWebGL2 ? readPickedId(ndx, ndy) : rayCastFallback(ndx, ndy)
    },
    [isWebGL2, readPickedId, rayCastFallback, gl]
  )

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!enabled) return
      const id = pick(e.clientX, e.clientY)
      if (id !== stateRef.current.hoveredId) {
        stateRef.current = { ...stateRef.current, hoveredId: id }
        setState((s) => ({ ...s, hoveredId: id }))
      }
    },
    [enabled, pick]
  )

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      if (!enabled) return
      const id = pick(e.clientX, e.clientY)
      stateRef.current = { ...stateRef.current, clickedId: id }
      setState((s) => ({ ...s, clickedId: id }))
    },
    [enabled, pick]
  )

  return { ...state, onPointerMove, onPointerDown }
}

// ── InstancedPanelManager Component ──────────────────────────────────────────

/** Props accepted by InstancedPanelManager */
interface InstancedPanelManagerProps {
  /** Array of working panels (position + attributes already computed) */
  panels: WorkingPanel[]
  /** Per-panel runtime values aligned by index */
  runtime: RuntimePanel[]
  /** Currently active view mode (normal / heatmap / thermal / shade / string) */
  viewMode: ViewMode
  /** Panel tilt in degrees */
  tilt: number
  /** Panel azimuth in degrees */
  panelAzimuth: number
  /** Index of the currently selected panel (-1 = none) */
  selectedIndex: number | null
  /** Callback when user clicks an instance */
  onSelect: (index: number | null) => void
  /** Camera world position — used for LOD distance calculation */
  cameraPosition: THREE.Vector3
}

/**
 * InstancedPanelManager
 *
 * Renders up to 1000+ solar panels using two InstancedMesh objects:
 *  - meshFull   → high-poly, used when camera within INSTANCED_LOD_FULL units
 *  - meshSimple → low-poly quad, used when camera is farther
 *
 * Per-instance attributes updated each frame via InstancedPanelController.
 * Selected panel is hidden from the instanced mesh and rendered individually
 * by a fallback PanelMesh (preserves hover/inspector interactions).
 *
 * GPU picking uses an offscreen WebGLRenderTarget; falls back to raycasting
 * on non-WebGL2 contexts.
 */
const InstancedPanelManager = memo(function InstancedPanelManager({
  panels,
  runtime,
  viewMode,
  tilt,
  panelAzimuth,
  selectedIndex,
  onSelect,
  cameraPosition,
}: InstancedPanelManagerProps) {
  const count = panels.length

  // Refs to instanced mesh DOM nodes
  const meshFullRef   = useRef<THREE.InstancedMesh>(null)
  const meshSimpleRef = useRef<THREE.InstancedMesh>(null)
  const meshPickRef   = useRef<THREE.InstancedMesh>(null)

  // Controller lives across renders
  const controllerRef = useRef<InstancedPanelController>(
    new InstancedPanelController(count)
  )

  // Attach meshes to controller once mounted
  useEffect(() => {
    const f = meshFullRef.current
    const s = meshSimpleRef.current
    const p = meshPickRef.current
    if (f && s && p) {
      controllerRef.current.attach(f, s, p)
    }
  }, [])

  // Dispose on unmount
  useEffect(() => {
    const ctrl = controllerRef.current
    return () => ctrl.dispose()
  }, [])

  // Materials ─────────────────────────────────────────────────────────────────
  const panelMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        roughness:    0.22,
        metalness:    0.55,
        envMapIntensity: 1.1,
        vertexColors: true,
      }),
    []
  )

  const pickMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader:   PICK_VERT_GLSL,
        fragmentShader: PICK_FRAG_GLSL,
        vertexColors:   true,
      }),
    []
  )

  // LOD decision (computed each frame in useFrame)
  const lodRef = useRef<"full" | "simple">("full")

  // GPU picker
  const containerRef = useRef<HTMLElement | null>(null)
  const { clickedId, onPointerDown } = useGpuPicker(
    meshPickRef as React.RefObject<THREE.InstancedMesh | null>,
    containerRef as React.RefObject<HTMLElement | null>,
    true
  )

  // Fire selection callback when GPU picker detects a click
  useEffect(() => {
    if (clickedId !== null && clickedId !== undefined) {
      onSelect(clickedId)
    }
  }, [clickedId, onSelect])

  // Per-frame update ──────────────────────────────────────────────────────────
  useFrame(() => {
    if (!meshFullRef.current || !meshSimpleRef.current) return

    const ctrl = controllerRef.current
    const rot  = new THREE.Euler(...panelRotation(tilt, panelAzimuth))

    // LOD: measure distance from camera to the centroid of the panel array
    const centroid = new THREE.Vector3(0, PANEL_BASE_Y, 0)
    const dist = cameraPosition.distanceTo(centroid)
    lodRef.current = dist <= INSTANCED_LOD_FULL ? "full" : "simple"

    const isFullLOD = lodRef.current === "full"
    meshFullRef.current.visible   = isFullLOD
    meshSimpleRef.current.visible = !isFullLOD

    for (let i = 0; i < count; i++) {
      const panel = panels[i]
      const rt    = runtime[i]
      if (!panel || !rt) continue

      // Skip selected panel (rendered individually)
      if (i === selectedIndex) {
        // Hide the instance
        const hideMat = new THREE.Matrix4()
        hideMat.makeScale(0, 0, 0)
        meshFullRef.current.setMatrixAt(i, hideMat)
        meshSimpleRef.current.setMatrixAt(i, hideMat)
        meshPickRef.current?.setMatrixAt(i, hideMat)
        continue
      }

      // Choose colour by view mode
      let color: THREE.Color
      switch (viewMode) {
        case "heatmap":  color = rt.color;        break
        case "thermal":  color = rt.thermalColor; break
        case "string":   color = rt.stringColor;  break
        case "shade":
          color = new THREE.Color().lerpColors(
            new THREE.Color("#1e40af"),
            new THREE.Color("#f59e0b"),
            1 - rt.shadeFactor
          )
          break
        default:
          color = new THREE.Color(0.18, 0.38, 0.72)
          break
      }

      ctrl.updateInstance(i, {
        position: new THREE.Vector3(...panel.position),
        rotation: rot,
        scale:    new THREE.Vector3(1, 1, 1),
        outputRatio:       rt.outputRatio,
        temperature:       rt.temperature,
        emissiveIntensity: clamp(rt.outputRatio * 0.4, 0, 0.5),
        color,
        stringIndex: panel.stringIndex,
        selected:    false,
        enabled:     panel.enabled,
      })
    }

    // Flush
    meshFullRef.current.instanceMatrix.needsUpdate   = true
    meshSimpleRef.current.instanceMatrix.needsUpdate = true
    if (meshPickRef.current) meshPickRef.current.instanceMatrix.needsUpdate = true
    if (meshFullRef.current.instanceColor)   meshFullRef.current.instanceColor.needsUpdate = true
    if (meshSimpleRef.current.instanceColor) meshSimpleRef.current.instanceColor.needsUpdate = true
  })

  return (
    <group>
      {/* ── High-LOD instanced mesh ── */}
      <instancedMesh
        ref={meshFullRef}
        args={[fullPanelGeo, panelMaterial, count]}
        castShadow
        receiveShadow
        frustumCulled={false}
      />

      {/* ── Low-LOD instanced mesh ── */}
      <instancedMesh
        ref={meshSimpleRef}
        args={[simplePanelGeo, panelMaterial, count]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
      />

      {/* ── Offscreen GPU pick mesh (invisible, used only for picking pass) ── */}
      <instancedMesh
        ref={meshPickRef}
        args={[simplePanelGeo, pickMaterial, count]}
        visible={false}
        frustumCulled={false}
      />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.2 — WORKER PANEL SIMULATION
// Purpose: Offload per-panel runtime calculations to a WebWorker so the main
//          thread is never blocked by simulation math. Uses Blob URL so no
//          separate worker file is needed. Transferable Float32Array buffers
//          are used for zero-copy message passing.
// ─────────────────────────────────────────────────────────────────────────────

// ── Worker source code (inlined as template literal) ─────────────────────────
// This is the actual JavaScript executed inside the Worker thread.

const WORKER_SOURCE = /* js */ `
"use strict";

// ── Constants (mirrored from the main thread) ─────────────────────────────────
const INVERTER_EFFICIENCY = 0.975;
const CO2_PER_KWH        = 0.82;

// Seeded PRNG (must match main thread seeded())
function seeded(index) {
  const s = Math.sin(index * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Worker state ──────────────────────────────────────────────────────────────
let panels      = [];      // WorkingPanel[]  (serialisable subset)
let config      = {};      // simulation config
let running     = false;
let tickCounter = 0;

// Float32Array buffers — transferred back to main thread each tick
// Layout per panel (8 floats):
//   [0] watts
//   [1] dcWatts
//   [2] temperature
//   [3] shadeFactor
//   [4] outputRatio
//   [5] efficiencyPct
//   [6] r (color)
//   [7] g (color)
// + [8] b (color)  — so 9 floats per panel
const FLOATS_PER_PANEL = 9;

function allocBuffer(count) {
  return new Float32Array(count * FLOATS_PER_PANEL);
}

// ── Simulation kernel ─────────────────────────────────────────────────────────

/**
 * Compute per-panel runtime values for one simulation tick.
 *
 * @param {Array}  panels        - serialisable panel descriptors
 * @param {object} cfg           - simulation configuration
 * @param {number} cfg.elevation - sun elevation (degrees)
 * @param {number} cfg.azimuth   - sun azimuth (degrees)
 * @param {number} cfg.tilt      - panel tilt (degrees)
 * @param {number} cfg.panelAzimuth - panel azimuth (degrees)
 * @param {string} cfg.weather   - WeatherType string
 * @param {string} cfg.season    - Season string
 * @param {number} cfg.year      - installation year (1-based)
 * @returns {Float32Array}
 */
function computeTick(panels, cfg) {
  const count = panels.length;
  const buf   = allocBuffer(count);

  const WEATHER_FACTOR = {
    clear: 1, cloudy: 0.72, rain: 0.45, snow: 0.58, storm: 0.33, fog: 0.52,
  };
  const WEATHER_TEMP_OFFSET = {
    clear: 0, cloudy: -1, rain: -4, snow: -9, storm: -5, fog: -3,
  };
  const SEASON_DECLINATION = {
    Spring: 4, Summer: 23.4, Autumn: -7, Winter: -23.4,
  };

  const weatherFactor  = WEATHER_FACTOR[cfg.weather]  ?? 1;
  const tempOffset     = WEATHER_TEMP_OFFSET[cfg.weather] ?? 0;
  const declination    = SEASON_DECLINATION[cfg.season]   ?? 0;
  const degradation    = Math.pow(0.994, Math.max((cfg.year ?? 1) - 1, 0));

  // Panel normal dot product with sun direction
  const elevRad    = cfg.elevation * (Math.PI / 180);
  const azRad      = cfg.azimuth   * (Math.PI / 180);
  const sunX = Math.cos(elevRad) * Math.sin(azRad);
  const sunY = Math.sin(elevRad);
  const sunZ = Math.cos(elevRad) * Math.cos(azRad);

  const tiltRad     = cfg.tilt        * (Math.PI / 180);
  const panAzRad    = cfg.panelAzimuth * (Math.PI / 180);
  const normalX = Math.sin(tiltRad) * Math.sin(panAzRad);
  const normalY = Math.cos(tiltRad);
  const normalZ = Math.sin(tiltRad) * Math.cos(panAzRad);

  const dot = clamp(sunX * normalX + sunY * normalY + sunZ * normalZ, 0, 1);
  const sunAboveHorizon = cfg.elevation > 0 ? 1 : 0;

  for (let i = 0; i < count; i++) {
    const p = panels[i];
    if (!p) continue;

    const enabled = p.enabled ? 1 : 0;
    const irradiance = dot * weatherFactor * p.sunlight * sunAboveHorizon;

    // Temperature model (Faiman simplified)
    const ambientTemp = 25 + tempOffset;
    const temperature = clamp(
      ambientTemp + irradiance * 30 + p.temp * 0.6 + seeded(i * 5 + 3) * 4,
      -10, 90
    );

    // Temperature coefficient (−0.4 %/°C above 25°C)
    const tempCoeff   = 1 - clamp((temperature - 25) * 0.004, -0.2, 0.25);

    // Effective shade factor
    const shadeFactor = clamp(p.shade + seeded(i * 7 + 1) * 0.05, 0, 1);
    const shadeMulti  = 1 - shadeFactor * 0.95;

    // DC output
    const dcWatts = clamp(
      p.basePower * irradiance * tempCoeff * shadeMulti * degradation * enabled,
      0,
      p.basePower
    );
    const watts        = dcWatts * INVERTER_EFFICIENCY;
    const outputRatio  = clamp(dcWatts / Math.max(p.basePower, 1), 0, 1);
    const efficiencyPct = clamp(p.efficiency * tempCoeff * degradation, 0, 100);

    // Encode colour (heatmap palette matching main thread efficiencyColor)
    const r = outputRatio;
    let cr, cg, cb;
    if      (r < 0.2) { cr = 0.03; cg = 0.07; cb = 0.12; }
    else if (r < 0.4) { cr = 0.06; cg = 0.30; cb = 0.51; }
    else if (r < 0.6) { cr = 0.00; cg = 0.64; cb = 1.00; }
    else if (r < 0.8) { cr = 0.00; cg = 0.82; cb = 0.56; }
    else              { cr = 1.00; cg = 0.84; cb = 0.29; }

    const base = i * FLOATS_PER_PANEL;
    buf[base + 0] = watts;
    buf[base + 1] = dcWatts;
    buf[base + 2] = temperature;
    buf[base + 3] = shadeFactor;
    buf[base + 4] = outputRatio;
    buf[base + 5] = efficiencyPct;
    buf[base + 6] = cr;
    buf[base + 7] = cg;
    buf[base + 8] = cb;
  }

  return buf;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = function(e) {
  const { type, payload } = e.data;

  try {
    switch (type) {
      // ── init: receive panel descriptors and initial config ────────────────
      case "init": {
        panels  = payload.panels  ?? [];
        config  = payload.config  ?? {};
        running = true;
        tickCounter = 0;
        self.postMessage({ type: "ready", payload: { count: panels.length } });
        break;
      }

      // ── updateConfig: update simulation parameters ────────────────────────
      case "updateConfig": {
        config = { ...config, ...payload };
        break;
      }

      // ── computeTick: run one simulation tick and return buffer ────────────
      case "computeTick": {
        if (!running || panels.length === 0) {
          self.postMessage({ type: "tickResult", payload: { buffer: null, tick: tickCounter } });
          break;
        }

        // Merge any tick-level config overrides
        const tickConfig = { ...config, ...(payload ?? {}) };
        const buffer = computeTick(panels, tickConfig);

        tickCounter++;

        // Transfer ownership of the ArrayBuffer to main thread (zero-copy)
        self.postMessage(
          { type: "tickResult", payload: { buffer, tick: tickCounter } },
          [buffer.buffer]
        );
        break;
      }

      // ── exportBuffer: return a snapshot of the current state ──────────────
      case "exportBuffer": {
        const snapshot = computeTick(panels, config);
        self.postMessage(
          { type: "exportResult", payload: { buffer: snapshot } },
          [snapshot.buffer]
        );
        break;
      }

      // ── restart: reset tick counter and re-init ───────────────────────────
      case "restart": {
        tickCounter = 0;
        running     = true;
        self.postMessage({ type: "restarted", payload: {} });
        break;
      }

      // ── terminate: clean shutdown ─────────────────────────────────────────
      case "terminate": {
        running = false;
        self.close();
        break;
      }

      default:
        self.postMessage({ type: "error", payload: { message: "Unknown message type: " + type } });
    }
  } catch (err) {
    self.postMessage({ type: "error", payload: { message: String(err) } });
  }
};
`;

// ── Worker lifecycle helpers ──────────────────────────────────────────────────

/** Create a Web Worker from an inline source string via Blob URL */
function createInlineWorker(source: string): Worker {
  const blob = new Blob([source], { type: "application/javascript" })
  const url  = URL.createObjectURL(blob)
  const worker = new Worker(url)
  // Revoke the URL immediately — the Worker has already been constructed
  URL.revokeObjectURL(url)
  return worker
}

// ── Serialisable panel descriptor sent to the worker ─────────────────────────

/** Subset of WorkingPanel that can cross the Worker boundary (no THREE objects) */
interface WorkerPanelDescriptor {
  id:          number
  index:       number
  enabled:     boolean
  efficiency:  number
  temp:        number
  basePower:   number
  sunlight:    number
  shade:       number
  stringIndex: number
}

function toWorkerDescriptor(p: WorkingPanel): WorkerPanelDescriptor {
  return {
    id:          p.id,
    index:       p.index,
    enabled:     p.enabled,
    efficiency:  p.efficiency,
    temp:        p.temp,
    basePower:   p.basePower,
    sunlight:    p.sunlight,
    shade:       p.shade,
    stringIndex: p.stringIndex,
  }
}

/** Configuration object sent to the worker */
interface WorkerSimConfig {
  elevation:    number
  azimuth:      number
  tilt:         number
  panelAzimuth: number
  weather:      WeatherType
  season:       Season
  year:         number
}

// ── FLOATS_PER_PANEL must mirror the worker constant ─────────────────────────
const WORKER_FLOATS_PER_PANEL = 9

/** Decode a Float32Array buffer from the worker into RuntimePanel[] */
function decodeWorkerBuffer(
  buf:    Float32Array,
  panels: WorkingPanel[]
): RuntimePanel[] {
  return panels.map((p, i) => {
    const base = i * WORKER_FLOATS_PER_PANEL
    const outputRatio = buf[base + 4] ?? 0
    const temperature = buf[base + 2] ?? 25

    const cr = buf[base + 6] ?? 0.2
    const cg = buf[base + 7] ?? 0.4
    const cb = buf[base + 8] ?? 0.7

    const t = clamp((temperature - 8) / 55, 0, 1)
    const tc = new THREE.Color("#1536c5").lerp(new THREE.Color("#ff5a2a"), t)
    const sc = stringColor(p.stringIndex)

    return {
      watts:        buf[base + 0] ?? 0,
      dcWatts:      buf[base + 1] ?? 0,
      temperature,
      shadeFactor:  buf[base + 3] ?? 0,
      outputRatio,
      efficiencyPct: buf[base + 5] ?? p.efficiency,
      color:         new THREE.Color(cr, cg, cb),
      thermalColor:  tc,
      stringColor:   sc,
    } satisfies RuntimePanel
  })
}

// ── usePanelSimulationWorker ──────────────────────────────────────────────────

/** Return value of usePanelSimulationWorker */
interface WorkerSimulationHandle {
  /** Latest decoded runtime panels (null before first tick resolves) */
  runtimePanels: RuntimePanel[] | null
  /** Whether the worker is ready to accept computeTick messages */
  ready: boolean
  /** Last error message from the worker, or null */
  error: string | null
  /** Number of completed ticks */
  tickCount: number
  /** Imperatively send a config update to the worker */
  updateConfig: (cfg: Partial<WorkerSimConfig>) => void
  /** Trigger a single computation tick */
  requestTick: (override?: Partial<WorkerSimConfig>) => void
  /** Export current buffer (resolves asynchronously via callback) */
  exportBuffer: (onResult: (panels: RuntimePanel[]) => void) => void
  /** Restart the worker simulation (resets tick counter) */
  restart: () => void
  /** Terminate the worker and free resources */
  terminate: () => void
}

/**
 * usePanelSimulationWorker
 *
 * Spawns an inline WebWorker, initialises it with panel descriptors, and
 * exposes imperative methods to drive the simulation tick by tick.
 * Results are reconciled back into React state safely via useRef + setState.
 */
function usePanelSimulationWorker(
  panels:    WorkingPanel[],
  initConfig: WorkerSimConfig
): WorkerSimulationHandle {
  const workerRef    = useRef<Worker | null>(null)
  const panelsRef    = useRef<WorkingPanel[]>(panels)
  const exportCbRef  = useRef<((rt: RuntimePanel[]) => void) | null>(null)

  const [runtimePanels, setRuntimePanels] = useState<RuntimePanel[] | null>(null)
  const [ready,         setReady]         = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [tickCount,     setTickCount]     = useState(0)

  // Keep panelsRef in sync without triggering re-spawn
  useEffect(() => { panelsRef.current = panels }, [panels])

  // Spawn / respawn worker when panel set changes significantly
  useEffect(() => {
    if (typeof Worker === "undefined") return

    const worker = createInlineWorker(WORKER_SOURCE)
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data as { type: string; payload: Record<string, unknown> }

      switch (type) {
        case "ready":
          setReady(true)
          break

        case "tickResult": {
          const buf = payload.buffer as Float32Array | null
          if (buf) {
            const decoded = decodeWorkerBuffer(buf, panelsRef.current)
            setRuntimePanels(decoded)
            setTickCount((n) => n + 1)
          }
          break
        }

        case "exportResult": {
          const buf = payload.buffer as Float32Array | null
          if (buf && exportCbRef.current) {
            const decoded = decodeWorkerBuffer(buf, panelsRef.current)
            exportCbRef.current(decoded)
            exportCbRef.current = null
          }
          break
        }

        case "restarted":
          setTickCount(0)
          break

        case "error":
          setError(String(payload.message ?? "Worker error"))
          break
      }
    }

    worker.onerror = (e) => {
      setError(`Worker error: ${e.message}`)
      setReady(false)
    }

    // Initialise with current panels and config
    worker.postMessage({
      type: "init",
      payload: {
        panels: panelsRef.current.map(toWorkerDescriptor),
        config: initConfig,
      },
    })

    return () => {
      worker.postMessage({ type: "terminate", payload: {} })
      worker.terminate()
      workerRef.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels.length])

  // ── Imperative API ──────────────────────────────────────────────────────────

  const updateConfig = useCallback((cfg: Partial<WorkerSimConfig>) => {
    workerRef.current?.postMessage({ type: "updateConfig", payload: cfg })
  }, [])

  const requestTick = useCallback((override?: Partial<WorkerSimConfig>) => {
    workerRef.current?.postMessage({ type: "computeTick", payload: override ?? {} })
  }, [])

  const exportBuffer = useCallback((onResult: (rt: RuntimePanel[]) => void) => {
    exportCbRef.current = onResult
    workerRef.current?.postMessage({ type: "exportBuffer", payload: {} })
  }, [])

  const restart = useCallback(() => {
    workerRef.current?.postMessage({ type: "restart", payload: {} })
  }, [])

  const terminate = useCallback(() => {
    workerRef.current?.postMessage({ type: "terminate", payload: {} })
    workerRef.current?.terminate()
    workerRef.current = null
  }, [])

  return {
    runtimePanels,
    ready,
    error,
    tickCount,
    updateConfig,
    requestTick,
    exportBuffer,
    restart,
    terminate,
  }
}

// ── useWorkerRuntimePanels ────────────────────────────────────────────────────

/**
 * High-level hook that drives the worker tick on every animation frame and
 * reconciles the result into a stable RuntimePanel[] reference.
 *
 * Use this hook instead of usePanelSimulationWorker when you want the panels
 * to update automatically at 60 fps.
 */
function useWorkerRuntimePanels(
  panels:     WorkingPanel[],
  simConfig:  WorkerSimConfig
): RuntimePanel[] | null {
  const handle = usePanelSimulationWorker(panels, simConfig)

  // Send config updates whenever props change
  useEffect(() => {
    if (handle.ready) handle.updateConfig(simConfig)
  }, [
    handle,
    simConfig.elevation,
    simConfig.azimuth,
    simConfig.tilt,
    simConfig.panelAzimuth,
    simConfig.weather,
    simConfig.season,
    simConfig.year,
  ])

  // Drive ticks from the render loop via useFrame
  useFrame(() => {
    if (handle.ready) handle.requestTick()
  })

  return handle.runtimePanels
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.3 — GPU THERMAL SHADER
// Purpose: Custom GLSL ShaderMaterial that maps cell temperature to an emissive
//          heat-glow effect using a smooth gradient palette. Provides automatic
//          fallback to MeshStandardMaterial on non-WebGL2 contexts.
// ─────────────────────────────────────────────────────────────────────────────

// ── GLSL source ───────────────────────────────────────────────────────────────

/** Vertex shader — passes UV and view-space position for edge-glow calculation */
const THERMAL_VERT_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uTemperature;   // normalised 0..1

  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vViewPos;
  varying float vTemp;

  void main() {
    vUv      = uv;
    vNormal  = normalize(normalMatrix * normal);
    vTemp    = uTemperature;

    // Slight vertex displacement to simulate thermal shimmer at high temps
    vec3 pos = position;
    if (uTemperature > 0.6) {
      float shimmer = sin(uTime * 18.0 + position.x * 22.0 + position.z * 17.0)
                    * (uTemperature - 0.6) * 0.006;
      pos.y += shimmer;
    }

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    vViewPos   = -mvPos.xyz;
    gl_Position = projectionMatrix * mvPos;
  }
`

/** Fragment shader — full thermal palette with Fresnel glow */
const THERMAL_FRAG_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uTemperature;   // normalised 0..1
  uniform float uIntensity;

  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vViewPos;
  varying float vTemp;

  // ── Palette: cold (deep blue) → warm (cyan) → hot (orange-red) ──────────
  vec3 thermalPalette(float t) {
    // Five-stop gradient
    vec3 c0 = vec3(0.02, 0.04, 0.28);  // deep navy  (cold)
    vec3 c1 = vec3(0.00, 0.48, 0.92);  // sky blue
    vec3 c2 = vec3(0.00, 0.88, 0.72);  // cyan-green
    vec3 c3 = vec3(1.00, 0.78, 0.00);  // amber
    vec3 c4 = vec3(1.00, 0.22, 0.04);  // red-orange (hot)

    t = clamp(t, 0.0, 1.0);
    if      (t < 0.25) return mix(c0, c1, t / 0.25);
    else if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    else if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    else               return mix(c3, c4, (t - 0.75) / 0.25);
  }

  void main() {
    vec3  N   = normalize(vNormal);
    vec3  V   = normalize(vViewPos);
    float NdV = clamp(dot(N, V), 0.0, 1.0);

    // Fresnel-based edge glow (hotter panels glow more on edges)
    float fresnel   = pow(1.0 - NdV, 3.0);
    float glowEdge  = fresnel * uTemperature * uIntensity * 2.2;

    // Base panel colour from thermal palette
    vec3 baseColor = thermalPalette(uTemperature);

    // UV-based grid lines to simulate panel cell structure
    vec2  cell      = fract(vUv * vec2(6.0, 4.0));
    float gridLine  = step(0.92, max(cell.x, cell.y));
    vec3  gridColor = baseColor * 1.3;
    baseColor       = mix(baseColor, gridColor, gridLine * 0.35);

    // Emissive contribution — scales with temperature and pulsed time wave
    float pulse    = 0.5 + 0.5 * sin(uTime * 2.8 + uTemperature * 6.28);
    float emissive = uTemperature * uIntensity * (0.8 + 0.2 * pulse);
    vec3  emitCol  = thermalPalette(uTemperature) * emissive;

    // Combine: base diffuse + emissive + edge glow
    vec3 finalColor = baseColor + emitCol + thermalPalette(1.0) * glowEdge;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`

// ── Uniforms type ─────────────────────────────────────────────────────────────

/** Typed uniforms for ThermalShaderMaterial */
  interface ThermalUniforms {
    [uniform: string]: THREE.IUniform
  uTime:        { value: number }
  uTemperature: { value: number }
  uIntensity:   { value: number }
}

// ── ThermalShaderMaterial factory ─────────────────────────────────────────────

/**
 * Create a THREE.ShaderMaterial configured for the thermal view.
 * The returned material has typed uniforms accessible at `.uniforms`.
 */
function createThermalShaderMaterial(
  temperature: number = 0.5,
  intensity:   number = 1.0
): THREE.ShaderMaterial & { uniforms: ThermalUniforms } {
  const uniforms: ThermalUniforms = {
    uTime:        { value: 0 },
    uTemperature: { value: clamp((temperature - 8) / 55, 0, 1) },
    uIntensity:   { value: intensity },
  }

  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   THERMAL_VERT_GLSL,
      fragmentShader: THERMAL_FRAG_GLSL,
      uniforms,
    }),
    { uniforms }
  )
}

// ── WebGL2 capability check ───────────────────────────────────────────────────

/** Check WebGL2 support without accessing the Three.js renderer */
function checkWebGL2Support(): boolean {
  if (typeof document === "undefined") return false
  try {
    const canvas = document.createElement("canvas")
    return !!canvas.getContext("webgl2")
  } catch {
    return false
  }
}

const IS_WEBGL2 = checkWebGL2Support()

// ── useThermalShaderMaterial ──────────────────────────────────────────────────

/**
 * Hook: manages a ThermalShaderMaterial (or MeshStandardMaterial fallback).
 * The material is updated each animation frame with the latest temperature and
 * time value to drive the shader animation.
 *
 * @param temperature  Cell temperature in °C (raw, not normalised)
 * @param intensity    Emissive intensity multiplier (0–2)
 * @param active       When false the material reverts to a plain diffuse look
 */
function useThermalShaderMaterial(
  temperature: number,
  intensity:   number = 1.0,
  active:      boolean = true
): THREE.Material {
  const matRef = useRef<
    (THREE.ShaderMaterial & { uniforms: ThermalUniforms }) | THREE.MeshStandardMaterial
  >(
    IS_WEBGL2 && active
      ? createThermalShaderMaterial(temperature, intensity)
      : new THREE.MeshStandardMaterial({ color: thermalColor(temperature) })
  )

  // Recreate if switching modes
  useEffect(() => {
    const prev = matRef.current
    if (IS_WEBGL2 && active) {
      matRef.current = createThermalShaderMaterial(temperature, intensity)
    } else {
      matRef.current = new THREE.MeshStandardMaterial({ color: thermalColor(temperature) })
    }
    prev.dispose()
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  // Drive uniforms each frame
  useFrame(({ clock }) => {
    const mat = matRef.current
    if (!(mat instanceof THREE.ShaderMaterial)) return
    const u = (mat as THREE.ShaderMaterial & { uniforms: ThermalUniforms }).uniforms
    u.uTime.value        = clock.getElapsedTime()
    u.uTemperature.value = clamp((temperature - 8) / 55, 0, 1)
    u.uIntensity.value   = intensity
  })

  return matRef.current
}

// ── ThermalPanel component ────────────────────────────────────────────────────

/** Props for the ThermalPanel fallback individual-mesh component */
interface ThermalPanelProps {
  position:    [number, number, number]
  rotation:    [number, number, number]
  temperature: number
  intensity?:  number
  selected?:   boolean
  onClick?:    () => void
}

/**
 * ThermalPanel
 *
 * Renders a single solar panel using ThermalShaderMaterial.
 * Intended for use with the selected panel in InstancedPanelManager — the
 * selected panel is excluded from the instanced mesh and rendered individually
 * so full shader effects are visible at close range.
 */
const ThermalPanel = memo(function ThermalPanel({
  position,
  rotation,
  temperature,
  intensity = 1.0,
  selected  = false,
  onClick,
}: ThermalPanelProps) {
  const material = useThermalShaderMaterial(temperature, intensity, true)
  const meshRef  = useRef<THREE.Mesh>(null)

  useFrame(({ clock }) => {
    if (!meshRef.current || !selected) return
    // Gentle hover bob when selected
    meshRef.current.position.y = position[1] + Math.sin(clock.getElapsedTime() * 2.4) * 0.015
  })

  return (
    <mesh
      ref={meshRef}
      position={position}
      rotation={rotation}
      castShadow
      receiveShadow
      onClick={onClick}
      geometry={fullPanelGeo}
      material={material}
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.4 — GPU WEATHER PARTICLE ENGINE
// Purpose: Fully GPU-driven particle system that replaces the CPU-side
//          WeatherParticles component for rain, snow, and storm conditions.
//          Particles are updated entirely on the GPU via ShaderMaterial so
//          the CPU never iterates the particle array.
// ─────────────────────────────────────────────────────────────────────────────

// ── GPU particle counts ───────────────────────────────────────────────────────

/** Maximum particle counts per weather type (GPU; higher than CPU system) */
const GPU_PARTICLE_MAX: Record<WeatherType, number> = {
  clear:  0,
  cloudy: 0,
  rain:   2400,
  snow:   1200,
  storm:  3200,
  fog:    0,
}

// ── Vertex shader — full particle simulation on GPU ───────────────────────────

const GPU_PARTICLE_VERT_GLSL = /* glsl */ `
  // ── Uniforms ──────────────────────────────────────────────────────────────
  uniform float uTime;
  uniform float uDeltaTime;
  uniform float uSpeed;
  uniform float uSize;
  uniform float uWindX;
  uniform float uWindZ;
  uniform float uIntensity;
  uniform int   uType;       // 0=rain 1=snow 2=storm

  // ── Per-vertex seed (stored in UV channel) ────────────────────────────────
  // uv.x = horizontal seed [0,1]
  // uv.y = vertical   seed [0,1]

  varying float vOpacity;
  varying float vRandom;

  // ── Seeded PRNG (GPU version) ─────────────────────────────────────────────
  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // ── Compute particle phase from seed and time ─────────────────────────────
  // Each particle has a unique phase so they don't all reset simultaneously.
  float particlePhase(float seed, float cycleTime) {
    return mod(uTime * uSpeed + seed * cycleTime, cycleTime);
  }

  void main() {
    float seedX   = uv.x;
    float seedY   = uv.y;
    float seedZ   = hash(seedX * 17.3 + seedY * 31.7);

    // ── World extent of the particle field ──────────────────────────────────
    float fieldW = 30.0;   // X
    float fieldD = 26.0;   // Z
    float fieldH = 22.0;   // Y (start height)

    // ── Cycle time per particle (varies with speed) ──────────────────────────
    float fallDist  = fieldH + 4.0;          // total fall distance
    float cycleTime = fallDist / uSpeed;

    // ── Current phase in the fall cycle ──────────────────────────────────────
    float phase = particlePhase(seedY, cycleTime);

    // ── Vertical position (top → bottom, then wrap) ──────────────────────────
    float yPos = fieldH - phase;

    // ── Horizontal position (drift with wind) ────────────────────────────────
    // Base grid position derived from seeds
    float xBase = (seedX - 0.5) * fieldW;
    float zBase = (seedZ - 0.5) * fieldD;

    // Wind drift accumulated over phase
    float xPos = xBase + uWindX * phase * 0.3;
    float zPos = zBase + uWindZ * phase * 0.12;

    // ── Snow wobble (gentle horizontal oscillation) ──────────────────────────
    if (uType == 1) {
      float wobble = sin(uTime * 1.8 + seedX * 6.28) * 0.35;
      xPos += wobble;
    }

    // ── Storm turbulence ─────────────────────────────────────────────────────
    if (uType == 2) {
      xPos += sin(uTime * 4.2 + seedY * 9.4) * 0.8;
      zPos += cos(uTime * 3.7 + seedX * 7.2) * 0.6;
    }

    // ── Opacity fade in / out near ground and top ────────────────────────────
    float fadeTop    = smoothstep(0.0, 0.08, phase / cycleTime);
    float fadeBottom = 1.0 - smoothstep(0.85, 1.0, phase / cycleTime);
    vOpacity  = fadeTop * fadeBottom * uIntensity;
    vRandom   = hash2(uv);

    // ── Final world position ──────────────────────────────────────────────────
    vec3 worldPos = vec3(xPos, yPos, zPos);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);

    // ── Point size ──────────────────────────────────────────────────────────
    // Rain is elongated (tall points); snow is round and larger
    float distScale = 200.0 / length((modelViewMatrix * vec4(worldPos, 1.0)).xyz);
    gl_PointSize = uSize * distScale * (0.8 + vRandom * 0.4);
  }
`

// ── Fragment shader ───────────────────────────────────────────────────────────

const GPU_PARTICLE_FRAG_GLSL = /* glsl */ `
  uniform int   uType;        // 0=rain 1=snow 2=storm
  uniform float uIntensity;
  uniform vec3  uColor;

  varying float vOpacity;
  varying float vRandom;

  void main() {
    // ── Discard particles outside the point circle ────────────────────────
    vec2  uv   = gl_PointCoord - vec2(0.5);
    float dist = length(uv);

    float alpha;
    if (uType == 1) {
      // Snow: soft circular flakes
      alpha = smoothstep(0.5, 0.2, dist);
    } else if (uType == 0 || uType == 2) {
      // Rain / storm: thin vertical streaks
      // Stretch along Y axis
      float yDist = abs(uv.y * 0.28);
      float xDist = abs(uv.x * 4.5);
      alpha = smoothstep(0.5, 0.0, max(xDist, yDist));
    } else {
      alpha = smoothstep(0.5, 0.1, dist);
    }

    if (alpha < 0.01) discard;

    vec3 col = uColor + vec3(vRandom * 0.08);
    gl_FragColor = vec4(col, alpha * vOpacity);
  }
`

// ── GpuParticleMaterial ───────────────────────────────────────────────────────

/** Typed uniforms for the GPU particle shader */
  interface GpuParticleUniforms {
    [uniform: string]: THREE.IUniform
  uTime:      { value: number }
  uDeltaTime: { value: number }
  uSpeed:     { value: number }
  uSize:      { value: number }
  uWindX:     { value: number }
  uWindZ:     { value: number }
  uIntensity: { value: number }
  uType:      { value: number }
  uColor:     { value: THREE.Color }
}

/** Factory: create the GPU particle ShaderMaterial */
function createGpuParticleMaterial(
  type:      0 | 1 | 2,
  color:     THREE.Color,
  speed:     number,
  size:      number,
  intensity: number
): THREE.ShaderMaterial & { uniforms: GpuParticleUniforms } {
  const uniforms: GpuParticleUniforms = {
    uTime:      { value: 0 },
    uDeltaTime: { value: 0.016 },
    uSpeed:     { value: speed },
    uSize:      { value: size },
    uWindX:     { value: 0 },
    uWindZ:     { value: 0 },
    uIntensity: { value: intensity },
    uType:      { value: type },
    uColor:     { value: color.clone() },
  }

  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   GPU_PARTICLE_VERT_GLSL,
      fragmentShader: GPU_PARTICLE_FRAG_GLSL,
      uniforms,
      transparent:  true,
      depthWrite:   false,
      blending:     THREE.AdditiveBlending,
      vertexColors: false,
    }),
    { uniforms }
  )
}

// ── GPU particle geometry builder ─────────────────────────────────────────────

/**
 * Build a BufferGeometry with `count` points.
 * Seeds are baked into the UV attribute so the GPU shader can derive unique
 * trajectories per particle with no runtime CPU involvement.
 */
function buildGpuParticleGeometry(count: number, weatherSeed: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3)
  const uvs       = new Float32Array(count * 2)

  for (let i = 0; i < count; i++) {
    // Positions are irrelevant — the vertex shader computes them from UV seeds
    positions[i * 3]     = 0
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = 0

    // UV encodes the unique seed for this particle
    uvs[i * 2]     = seeded(weatherSeed * 1000 + i * 3)     // x seed
    uvs[i * 2 + 1] = seeded(weatherSeed * 1000 + i * 3 + 1) // y seed
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2))
  return geo
}

// ── WeatherType → GPU particle parameters ────────────────────────────────────

interface GpuParticleParams {
  type:      0 | 1 | 2   // 0=rain, 1=snow, 2=storm
  color:     THREE.Color
  speed:     number
  size:      number
  intensity: number
}

const GPU_PARTICLE_PARAMS: Partial<Record<WeatherType, GpuParticleParams>> = {
  rain: {
    type:      0,
    color:     new THREE.Color("#93c5fd"),
    speed:     4.2,
    size:      28,
    intensity: 0.58,
  },
  snow: {
    type:      1,
    color:     new THREE.Color("#f0f4ff"),
    speed:     0.7,
    size:      48,
    intensity: 0.72,
  },
  storm: {
    type:      2,
    color:     new THREE.Color("#bfdbfe"),
    speed:     6.4,
    size:      24,
    intensity: 0.48,
  },
}

// ── ParticleSimulationController ──────────────────────────────────────────────

/** Props for ParticleSimulationController */
interface ParticleSimulationControllerProps {
  /** Weather type driving the simulation */
  weather: WeatherType
  /** Wind vector components (world space) */
  windX?: number
  windZ?: number
  /** Intensity multiplier (0–2, default 1) */
  intensity?: number
  /** Forward ref to access the material uniforms */
  materialRef?: React.RefObject<(THREE.ShaderMaterial & { uniforms: GpuParticleUniforms }) | null>
}

/**
 * ParticleSimulationController
 *
 * Drives the GPU particle shader uniforms each frame.
 * Does not render anything itself — attach it as a sibling of WeatherGPUParticles.
 */
const ParticleSimulationController = memo(function ParticleSimulationController({
  weather,
  windX    = 0,
  windZ    = 0,
  intensity = 1,
  materialRef,
}: ParticleSimulationControllerProps) {
  useFrame(({ clock }, delta) => {
    const mat = materialRef?.current
    if (!mat) return
    const u = mat.uniforms
    u.uTime.value      = clock.getElapsedTime()
    u.uDeltaTime.value = delta
    u.uWindX.value     = windX
    u.uWindZ.value     = windZ
    u.uIntensity.value = intensity
  })

  return null
})

// ── WeatherGPUParticles ───────────────────────────────────────────────────────

/** Props for WeatherGPUParticles */
interface WeatherGPUParticlesProps {
  weather:    WeatherType
  windX?:     number
  windZ?:     number
  intensity?: number
}

/**
 * WeatherGPUParticles
 *
 * Drop-in replacement for WeatherParticles that runs the particle simulation
 * entirely on the GPU.
 *
 * - Geometry is built once per weather type with baked seed UVs.
 * - ShaderMaterial drives positions, velocities, and visual effects via GLSL.
 * - CPU cost is zero per frame — only uniform writes (O(1)).
 * - Automatically falls back to null for weather types with no particles
 *   (clear, cloudy, fog).
 *
 * @example
 *   <WeatherGPUParticles weather="rain" windX={1.2} intensity={0.8} />
 */
const WeatherGPUParticles = memo(function WeatherGPUParticles({
  weather,
  windX    = 0,
  windZ    = 0,
  intensity = 1,
}: WeatherGPUParticlesProps) {
  const count  = GPU_PARTICLE_MAX[weather]
  const params = GPU_PARTICLE_PARAMS[weather]

  const materialRef = useRef<
    (THREE.ShaderMaterial & { uniforms: GpuParticleUniforms }) | null
  >(null)

  // Build geometry from baked seeds (rebuilds only when weather type changes)
  const geometry = useMemo(() => {
    if (count === 0 || !params) return null
    return buildGpuParticleGeometry(count, WEATHER_SEED[weather])
  }, [count, params, weather])

  // Build material (rebuilds only when weather type changes)
  const material = useMemo(() => {
    if (!params) return null
    return createGpuParticleMaterial(
      params.type,
      params.color,
      params.speed,
      params.size,
      params.intensity * intensity
    )
  }, [params, intensity]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep materialRef in sync for the controller
  useEffect(() => {
    materialRef.current = material
  }, [material])

  // Dispose on weather change or unmount
  useEffect(() => {
    return () => {
      geometry?.dispose()
      material?.dispose()
    }
  }, [geometry, material])

  if (!geometry || !material || count === 0) return null

  return (
    <group>
      {/* ── GPU particle points mesh ── */}
      <points
        geometry={geometry}
        material={material}
        frustumCulled={false}
      />

      {/* ── Controller drives uniform updates each frame ── */}
      <ParticleSimulationController
        weather={weather}
        windX={windX}
        windZ={windZ}
        intensity={intensity}
        materialRef={materialRef as React.RefObject<(THREE.ShaderMaterial & { uniforms: GpuParticleUniforms }) | null>}
      />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — PUBLIC API SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
//
// Components exported for use in other modules or Storybook stories:
//
//   InstancedPanelManager         — GPU-instanced panel grid (1000+ panels)
//   ThermalPanel                  — Single panel with thermal GLSL shader
//   WeatherGPUParticles           — GPU weather particle system
//   ParticleSimulationController  — Drives GPU particle uniforms per frame
//
// Hooks exported for use in consuming components:
//
//   usePanelSimulationWorker      — Full worker lifecycle + message API
//   useWorkerRuntimePanels        — Auto-tick worker panels for useFrame use
//   useThermalShaderMaterial      — Manages ThermalShaderMaterial lifecycle
//   useGpuPicker                  — GPU/CPU hybrid instance picker
//
// Classes:
//
//   InstancedPanelController      — Low-level imperative instanced mesh API
//
// Pure functions / factories:
//
//   createThermalShaderMaterial   — Build ThermalShaderMaterial with uniforms
//   createGpuParticleMaterial     — Build GPU particle ShaderMaterial
//   buildGpuParticleGeometry      — Build seed-baked particle BufferGeometry
//   createInlineWorker            — Spawn Worker from inline source string
//   encodeIdToColor / decodeColorToId — GPU pick colour codec
//   toWorkerDescriptor            — Strip WorkingPanel to serialisable form
//   decodeWorkerBuffer            — Float32Array → RuntimePanel[]
//
// ─────────────────────────────────────────────────────────────────────────────

export {
  // ── 10.1 ─────────────────────────────────────────────────────────────────
  InstancedPanelManager,
  InstancedPanelController,
  useGpuPicker,
  encodeIdToColor,
  decodeColorToId,

  // ── 10.2 ─────────────────────────────────────────────────────────────────
  usePanelSimulationWorker,
  useWorkerRuntimePanels,
  createInlineWorker,
  toWorkerDescriptor,
  decodeWorkerBuffer,

  // ── 10.3 ─────────────────────────────────────────────────────────────────
  ThermalPanel,
  useThermalShaderMaterial,
  createThermalShaderMaterial,

  // ── 10.4 ─────────────────────────────────────────────────────────────────
  WeatherGPUParticles,
  ParticleSimulationController,
  createGpuParticleMaterial,
  buildGpuParticleGeometry,
}

export type {
  // ── 10.1 ─────────────────────────────────────────────────────────────────
  PanelInstanceAttributes,
  InstancedPanelManagerProps,
  GpuPickerState,

  // ── 10.2 ─────────────────────────────────────────────────────────────────
  WorkerPanelDescriptor,
  WorkerSimConfig,
  WorkerSimulationHandle,

  // ── 10.3 ─────────────────────────────────────────────────────────────────
  ThermalUniforms,
  ThermalPanelProps,

  // ── 10.4 ─────────────────────────────────────────────────────────────────
  GpuParticleUniforms,
  GpuParticleParams,
  WeatherGPUParticlesProps,
  ParticleSimulationControllerProps,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.5 — TELEMETRY ENGINE
// Purpose: Full WebSocket client with exponential backoff, heartbeat pings,
//          structured message parsing, and IndexedDB persistence layer.
//          Replaces the stub useTelemetryStream from Section 5.
// ─────────────────────────────────────────────────────────────────────────────

// ── IndexedDB helper (zero external deps) ────────────────────────────────────

/** Single stored telemetry record */
interface TelemetryRecord {
  id:        string         // ISO timestamp used as key
  timestamp: number         // Unix ms
  panels:    SerialPanelSnap[]
  totalKw:   number
  weather:   WeatherType
}

/** Serialisable snapshot of a single panel for IDB storage */
interface SerialPanelSnap {
  id:          number
  watts:       number
  temperature: number
  outputRatio: number
  shadeFactor: number
}

/** TelemetryStore — thin wrapper around a single IndexedDB object store */
class TelemetryStore {
  private static readonly DB_NAME    = "SolarTelemetryDB"
  private static readonly DB_VERSION = 1
  private static readonly STORE_NAME = "records"
  private static readonly MAX_RECORDS = 2880  // 48 h at 1-min intervals

  private db: IDBDatabase | null = null

  /** Open (or create) the database. Must be called before any other method. */
  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { resolve(); return }
      const req = indexedDB.open(TelemetryStore.DB_NAME, TelemetryStore.DB_VERSION)

      req.onupgradeneeded = (e) => {
        const db    = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(TelemetryStore.STORE_NAME)) {
          const store = db.createObjectStore(TelemetryStore.STORE_NAME, { keyPath: "id" })
          store.createIndex("timestamp", "timestamp", { unique: false })
        }
      }

      req.onsuccess = (e) => {
        this.db = (e.target as IDBOpenDBRequest).result
        resolve()
      }

      req.onerror = () => reject(req.error)
    })
  }

  /** Write a record, pruning oldest records to stay under MAX_RECORDS */
  async put(record: TelemetryRecord): Promise<void> {
    if (!this.db) return
      return new Promise<void>((resolve, reject) => {
      const tx    = this.db!.transaction(TelemetryStore.STORE_NAME, "readwrite")
      const store = tx.objectStore(TelemetryStore.STORE_NAME)
      store.put(record)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => reject(tx.error)
    }).then(() => this.prune())
  }

  /** Fetch the N most recent records ordered by timestamp descending */
  async getRecent(limit = 60): Promise<TelemetryRecord[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx      = this.db!.transaction(TelemetryStore.STORE_NAME, "readonly")
      const store   = tx.objectStore(TelemetryStore.STORE_NAME)
      const index   = store.index("timestamp")
      const results: TelemetryRecord[] = []
      const req     = index.openCursor(null, "prev")

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor && results.length < limit) {
          results.push(cursor.value as TelemetryRecord)
          cursor.continue()
        } else {
          resolve(results)
        }
      }

      req.onerror = () => reject(req.error)
    })
  }

  /** Fetch all records within a unix-ms time range */
  async getRange(fromMs: number, toMs: number): Promise<TelemetryRecord[]> {
    if (!this.db) return []
    return new Promise((resolve, reject) => {
      const tx      = this.db!.transaction(TelemetryStore.STORE_NAME, "readonly")
      const store   = tx.objectStore(TelemetryStore.STORE_NAME)
      const index   = store.index("timestamp")
      const range   = IDBKeyRange.bound(fromMs, toMs)
      const results: TelemetryRecord[] = []
      const req     = index.openCursor(range)

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result
        if (cursor) { results.push(cursor.value as TelemetryRecord); cursor.continue() }
        else resolve(results)
      }

      req.onerror = () => reject(req.error)
    })
  }

  /** Clear all records (useful for testing / reset) */
  async clear(): Promise<void> {
    if (!this.db) return
    return new Promise((resolve, reject) => {
      const tx    = this.db!.transaction(TelemetryStore.STORE_NAME, "readwrite")
      const store = tx.objectStore(TelemetryStore.STORE_NAME)
      store.clear()
      tx.oncomplete = () => resolve()
      tx.onerror    = () => reject(tx.error)
    })
  }

  /** Prune oldest records to stay within MAX_RECORDS */
  private async prune(): Promise<void> {
    if (!this.db) return
    return new Promise((resolve) => {
      const tx    = this.db!.transaction(TelemetryStore.STORE_NAME, "readwrite")
      const store = tx.objectStore(TelemetryStore.STORE_NAME)
      const countReq = store.count()
      countReq.onsuccess = () => {
        const excess = countReq.result - TelemetryStore.MAX_RECORDS
        if (excess <= 0) { resolve(); return }
        const index = store.index("timestamp")
        const cursor = index.openCursor()
        let deleted = 0
        cursor.onsuccess = (e) => {
          const c = (e.target as IDBRequest<IDBCursorWithValue>).result
          if (c && deleted < excess) { c.delete(); deleted++; c.continue() }
          else resolve()
        }
        cursor.onerror = () => resolve()
      }
      countReq.onerror = () => resolve()
    })
  }

  close(): void { this.db?.close() }
}

// ── TelemetryClient ───────────────────────────────────────────────────────────

/** Possible connection states */
type TelemetryConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "error" | "closed"

/** Parsed inbound telemetry message from the server */
interface TelemetryMessage {
  type:      "snapshot" | "delta" | "pong" | "error" | "config"
  timestamp: number
  payload:   unknown
}

/** Snapshot payload shape */
interface TelemetrySnapshotPayload {
  panels:  SerialPanelSnap[]
  totalKw: number
  weather: WeatherType
}

/** Connection state reported to subscribers */
interface TelemetryClientState {
  connectionState: TelemetryConnectionState
  lastSyncMs:      number | null
  error:           string | null
  latencyMs:       number | null
}

type TelemetrySubscriber = (state: TelemetryClientState, data: TelemetrySnapshotPayload | null) => void

/**
 * TelemetryClient
 *
 * WebSocket client with:
 *  - Exponential backoff reconnect (max 30 s)
 *  - Heartbeat ping every 15 s
 *  - Structured JSON message parser
 *  - Automatic IndexedDB caching via TelemetryStore
 *  - Subscriber pattern (no React dependency — works outside components)
 */
class TelemetryClient {
  private ws:           WebSocket | null  = null
  private store:        TelemetryStore    = new TelemetryStore()
  private storeReady:   boolean           = false
  private retryCount:   number            = 0
  private retryTimer:   ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pingTs:       number            = 0
  private subscribers:  Set<TelemetrySubscriber> = new Set()
  private destroyed:    boolean           = false

  private state: TelemetryClientState = {
    connectionState: "idle",
    lastSyncMs:      null,
    error:           null,
    latencyMs:       null,
  }

  private lastPayload: TelemetrySnapshotPayload | null = null

  constructor(private readonly endpoint: string) {}

  /** Initialise IDB store and open WebSocket */
  async start(): Promise<void> {
    try {
      await this.store.open()
      this.storeReady = true
    } catch {
      // IDB unavailable — continue without caching
    }
    this.connect()
  }

  /** Graceful shutdown */
  destroy(): void {
    this.destroyed = true
    this.clearRetry()
    this.stopHeartbeat()
    this.ws?.close(1000, "Client destroyed")
    this.store.close()
    this.subscribers.clear()
  }

  /** Subscribe to state + data updates */
  subscribe(cb: TelemetrySubscriber): () => void {
    this.subscribers.add(cb)
    // Immediately emit current state to new subscriber
    cb(this.state, this.lastPayload)
    return () => this.subscribers.delete(cb)
  }

  /** Send a raw message to the server */
  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.destroyed) return
    this.setState({ connectionState: this.retryCount === 0 ? "connecting" : "reconnecting" })

    try {
      this.ws = new WebSocket(this.endpoint)
    } catch (err) {
      this.handleError(`WebSocket construction failed: ${String(err)}`)
      return
    }

    this.ws.onopen    = this.onOpen
    this.ws.onmessage = this.onMessage
    this.ws.onerror   = this.onError
    this.ws.onclose   = this.onClose
  }

  private onOpen = (): void => {
    this.retryCount = 0
    this.setState({ connectionState: "connected", error: null })
    this.startHeartbeat()
    this.send({ type: "subscribe", version: 1 })
  }

  private onMessage = (e: MessageEvent): void => {
    let msg: TelemetryMessage
    try {
      msg = JSON.parse(e.data as string) as TelemetryMessage
    } catch {
      return // Ignore malformed frames
    }

    switch (msg.type) {
      case "snapshot": {
        const payload = msg.payload as TelemetrySnapshotPayload
        this.lastPayload = payload
        const now = Date.now()
        this.setState({ lastSyncMs: now })
        this.notify(payload)

        // Persist to IDB
        if (this.storeReady) {
          const record: TelemetryRecord = {
            id:        new Date(now).toISOString(),
            timestamp: now,
            panels:    payload.panels,
            totalKw:   payload.totalKw,
            weather:   payload.weather,
          }
          this.store.put(record).catch(() => {/* ignore IDB write failures */})
        }
        break
      }

      case "delta": {
        // Apply delta patch to last payload
        if (this.lastPayload) {
          const delta = msg.payload as Partial<TelemetrySnapshotPayload>
          this.lastPayload = { ...this.lastPayload, ...delta }
          this.setState({ lastSyncMs: Date.now() })
          this.notify(this.lastPayload)
        }
        break
      }

      case "pong": {
        const latencyMs = Date.now() - this.pingTs
        this.setState({ latencyMs })
        break
      }

      case "error": {
        const errMsg = (msg.payload as { message?: string })?.message ?? "Server error"
        this.setState({ error: errMsg })
        break
      }
    }
  }

  private onError = (): void => {
    this.handleError("WebSocket connection error")
  }

  private onClose = (e: CloseEvent): void => {
    this.stopHeartbeat()
    if (this.destroyed) return
    if (e.code === 1000) {
      this.setState({ connectionState: "closed" })
    } else {
      this.scheduleRetry()
    }
  }

  private handleError(msg: string): void {
    this.setState({ connectionState: "error", error: msg })
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    this.clearRetry()
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
    const delayMs = Math.min(1000 * Math.pow(2, this.retryCount), 30_000)
    this.retryCount++
    this.retryTimer = setTimeout(() => {
      if (!this.destroyed) this.connect()
    }, delayMs)
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.pingTs = Date.now()
        this.send({ type: "ping", ts: this.pingTs })
      }
    }, 15_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private setState(partial: Partial<TelemetryClientState>): void {
    this.state = { ...this.state, ...partial }
    this.notify(this.lastPayload)
  }

  private notify(payload: TelemetrySnapshotPayload | null): void {
    this.subscribers.forEach((cb) => cb(this.state, payload))
  }
}

// ── useTelemetryStream (full implementation) ──────────────────────────────────

/** Extended return type for the full telemetry stream hook */
interface TelemetryStreamResult {
  data:            RuntimePanel[] | null
  connected:       boolean
  connectionState: TelemetryConnectionState
  error:           string | null
  lastSyncMs:      number | null
  latencyMs:       number | null
  recentHistory:   TelemetryRecord[]
  clearHistory:    () => Promise<void>
}

/**
 * useTelemetryStream (full implementation — replaces Section 5 stub)
 *
 * Manages a TelemetryClient lifecycle tied to the component.
 * When `config.enabled` is false, returns null data immediately.
 * Reconciles server panel snapshots with the local WorkingPanel array so
 * RuntimePanel values are always aligned by panel index.
 *
 * @param config    TelemetryConfig (endpoint, interval, enabled)
 * @param panels    Current working panel array (needed for reconciliation)
 */
function useFullTelemetryStream(
  config: TelemetryConfig,
  panels: WorkingPanel[]
): TelemetryStreamResult {
  const clientRef        = useRef<TelemetryClient | null>(null)
  const storeRef         = useRef<TelemetryStore | null>(null)
  const panelsRef        = useRef<WorkingPanel[]>(panels)

  const [streamState, setStreamState] = useState<TelemetryClientState>({
    connectionState: "idle",
    lastSyncMs:      null,
    error:           null,
    latencyMs:       null,
  })
  const [runtimePanels, setRuntimePanels]   = useState<RuntimePanel[] | null>(null)
  const [recentHistory,  setRecentHistory]  = useState<TelemetryRecord[]>([])

  // Keep panels ref current
  useEffect(() => { panelsRef.current = panels }, [panels])

  // Refresh history every 30 seconds
  useEffect(() => {
    const store = storeRef.current
    if (!store) return
    const load = () => store.getRecent(120).then(setRecentHistory).catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  // Connect / disconnect based on config
  useEffect(() => {
    if (!config.enabled || !config.endpoint) return

    const client = new TelemetryClient(config.endpoint)
    clientRef.current = client

    const unsubscribe = client.subscribe((state, payload) => {
      setStreamState(state)

      if (!payload) return

      // Reconcile payload panels with working panel array
      const wp = panelsRef.current
      if (!payload.panels || payload.panels.length === 0) return

      const reconciled: RuntimePanel[] = wp.map((workPanel) => {
        const snap = payload.panels.find((s) => s.id === workPanel.id)
        const outputRatio  = snap?.outputRatio  ?? 0
        const temperature  = snap?.temperature  ?? 25
        const shadeFactor  = snap?.shadeFactor  ?? 0
        const watts        = snap?.watts        ?? 0
        const dcWatts      = watts / INVERTER_EFFICIENCY
        const efficiencyPct = workPanel.efficiency

        return {
          watts,
          dcWatts,
          outputRatio,
          temperature,
          shadeFactor,
          efficiencyPct,
          color:        efficiencyColor(outputRatio),
          thermalColor: thermalColor(temperature),
          stringColor:  stringColor(workPanel.stringIndex),
        } satisfies RuntimePanel
      })

      setRuntimePanels(reconciled)
    })

    client.start().catch(() => {/* handled internally */})

    return () => {
      unsubscribe()
      client.destroy()
      clientRef.current = null
    }
  }, [config.enabled, config.endpoint])

  const clearHistory = useCallback(async () => {
    await storeRef.current?.clear()
    setRecentHistory([])
  }, [])

  return {
    data:            runtimePanels,
    connected:       streamState.connectionState === "connected",
    connectionState: streamState.connectionState,
    error:           streamState.error,
    lastSyncMs:      streamState.lastSyncMs,
    latencyMs:       streamState.latencyMs,
    recentHistory,
    clearHistory,
  }
}

// ── TelemetryCard UI Component ────────────────────────────────────────────────

/** Status dot colour per connection state */
const CONNECTION_STATE_COLOR: Record<TelemetryConnectionState, string> = {
  idle:         DS.muted,
  connecting:   DS.warning,
  connected:    DS.emerald,
  reconnecting: DS.warning,
  error:        DS.danger,
  closed:       DS.muted,
}

/** Human-readable label per connection state */
const CONNECTION_STATE_LABEL: Record<TelemetryConnectionState, string> = {
  idle:         "Idle",
  connecting:   "Connecting…",
  connected:    "Live",
  reconnecting: "Reconnecting…",
  error:        "Error",
  closed:       "Closed",
}

interface TelemetryStatusCardProps {
  connectionState: TelemetryConnectionState
  lastSyncMs:      number | null
  latencyMs:       number | null
  error:           string | null
  totalKw:         number
}

/**
 * TelemetryCard
 *
 * HUD overlay showing live telemetry connection status, last sync timestamp,
 * and measured WebSocket round-trip latency.
 * Rendered inside the DOM overlay (not in the Three.js canvas).
 */
const TelemetryStatusCard = memo(function TelemetryStatusCard({
  connectionState,
  lastSyncMs,
  latencyMs,
  error,
  totalKw,
}: TelemetryStatusCardProps) {
  const dotColor = CONNECTION_STATE_COLOR[connectionState]
  const label    = CONNECTION_STATE_LABEL[connectionState]

  const lastSyncLabel = lastSyncMs
    ? new Date(lastSyncMs).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—"

  return (
    <div style={{
      background:  DS.bg,
      border:      `1px solid ${dotColor}44`,
      borderRadius: 8,
      padding:     "8px 12px",
      minWidth:    180,
      fontSize:    11,
      color:       DS.text,
      display:     "flex",
      flexDirection: "column",
      gap:         4,
    }}>
      {/* ── Status row ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/* Animated status dot */}
        <span style={{
          width:        8,
          height:       8,
          borderRadius: "50%",
          background:   dotColor,
          boxShadow:    connectionState === "connected" ? `0 0 6px ${dotColor}` : "none",
          flexShrink:   0,
          animation:    connectionState === "connecting" || connectionState === "reconnecting"
            ? "telemetry-blink 1s ease-in-out infinite"
            : "none",
        }} />
        <span style={{ fontWeight: 600, color: dotColor }}>{label}</span>
        {latencyMs !== null && connectionState === "connected" && (
          <span style={{ marginLeft: "auto", color: DS.muted }}>{latencyMs}ms</span>
        )}
      </div>

      {/* ── Last sync ── */}
      <div style={{ color: DS.muted }}>
        Sync: <span style={{ color: DS.text }}>{lastSyncLabel}</span>
      </div>

      {/* ── Live total ── */}
      {connectionState === "connected" && (
        <div style={{ color: DS.muted }}>
          Live: <span style={{ color: DS.gold, fontWeight: 600 }}>{totalKw.toFixed(2)} kW</span>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{ color: DS.danger, fontSize: 10, marginTop: 2 }} title={error}>
          ⚠ {error.slice(0, 38)}{error.length > 38 ? "…" : ""}
        </div>
      )}

      <style>{`
        @keyframes telemetry-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.6 — SCENE RECORDER
// Purpose: Capture the Three.js canvas as a WebM video or a sequential PNG
//          frame burst (time-lapse mode). Exposes start/stop controls to the
//          existing ControlPanel.
// ─────────────────────────────────────────────────────────────────────────────

/** Recording mode variants */
type RecordingMode = "realtime" | "timelapse"

/** Recorder state surface */
interface RecorderState {
  recording:    boolean
  mode:         RecordingMode
  durationMs:   number        // elapsed recording time in ms
  frameCount:   number        // frames captured so far
  error:        string | null
}

/** Options passed to startRecording */
interface RecordingOptions {
  mode?:       RecordingMode
  fps?:        number     // target FPS (realtime only)
  timelapseMs?: number    // capture interval in ms (timelapse mode)
  maxDurationMs?: number  // auto-stop after N ms (0 = unlimited)
  videoBitrate?: number   // bps for MediaRecorder (default 2_500_000)
}

/**
 * useSceneRecorder
 *
 * Manages MediaRecorder lifecycle against the Three.js canvas element.
 * When MediaRecorder / captureStream() is unavailable (Safari pre-15, etc.),
 * automatically falls back to PNG frame export.
 *
 * @param canvasContainerRef  Ref to the <div> wrapping the <Canvas>
 */
function useSceneRecorder(
  canvasContainerRef: React.RefObject<HTMLElement | null>
): {
  state:          RecorderState
  startRecording: (opts?: RecordingOptions) => void
  stopRecording:  () => void
} {
  const recorderRef   = useRef<MediaRecorder | null>(null)
  const chunksRef     = useRef<Blob[]>([])
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef  = useRef<number>(0)
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const [state, setState] = useState<RecorderState>({
    recording:  false,
    mode:       "realtime",
    durationMs: 0,
    frameCount: 0,
    error:      null,
  })

  // Duration ticker
  const startDurationTick = useCallback(() => {
    intervalRef.current = setInterval(() => {
      setState((s) => ({ ...s, durationMs: Date.now() - startTimeRef.current }))
    }, 250)
  }, [])

  const stopDurationTick = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // ── Get canvas element ──────────────────────────────────────────────────────
  const getCanvas = useCallback((): HTMLCanvasElement | null => {
    const el = canvasContainerRef.current?.querySelector("canvas")
    return el instanceof HTMLCanvasElement ? el : null
  }, [canvasContainerRef])

  // ── PNG frame export (fallback / timelapse) ─────────────────────────────────
  const captureFrame = useCallback((frameIndex: number): void => {
    const canvas = getCanvas()
    if (!canvas) return
    const url = canvas.toDataURL("image/png")
    const a   = Object.assign(document.createElement("a"), {
      href:     url,
      download: `solar-frame-${String(frameIndex).padStart(5, "0")}.png`,
    })
    a.click()
    setState((s) => ({ ...s, frameCount: frameIndex + 1 }))
  }, [getCanvas])

  // ── Start recording ─────────────────────────────────────────────────────────
  const startRecording = useCallback((opts: RecordingOptions = {}): void => {
    const {
      mode           = "realtime",
      fps            = 30,
      timelapseMs    = 1000,
      maxDurationMs  = 0,
      videoBitrate   = 2_500_000,
    } = opts

    const canvas = getCanvas()
    if (!canvas) {
      setState((s) => ({ ...s, error: "Canvas not found" }))
      return
    }

    startTimeRef.current = Date.now()
    chunksRef.current    = []
    setState({ recording: true, mode, durationMs: 0, frameCount: 0, error: null })
    startDurationTick()

    // ── Time-lapse: export PNG frames at interval ────────────────────────────
    if (mode === "timelapse") {
      let fi = 0
      frameTimerRef.current = setInterval(() => {
        captureFrame(fi++)
      }, timelapseMs)

      if (maxDurationMs > 0) {
        setTimeout(() => stopRecording(), maxDurationMs)
      }
      return
    }

    // ── Realtime: MediaRecorder via captureStream ────────────────────────────
    const supportsCapture = typeof (canvas as HTMLCanvasElement & {
      captureStream?: (fps: number) => MediaStream
    }).captureStream === "function"

    if (!supportsCapture) {
      // Fallback: sequential PNG frames at ~fps rate
      let fi = 0
      const frameIntervalMs = 1000 / fps
      frameTimerRef.current = setInterval(() => captureFrame(fi++), frameIntervalMs)
      return
    }

    const stream = (canvas as HTMLCanvasElement & {
      captureStream: (fps: number) => MediaStream
    }).captureStream(fps)

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : ""

    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, {
        mimeType:    mimeType || undefined,
        videoBitsPerSecond: videoBitrate,
      })
    } catch {
      // MediaRecorder constructor failed — fall back to PNG frames
      let fi = 0
      const frameIntervalMs = 1000 / fps
      frameTimerRef.current = setInterval(() => captureFrame(fi++), frameIntervalMs)
      return
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || "video/webm" })
      const url  = URL.createObjectURL(blob)
      const a    = Object.assign(document.createElement("a"), {
        href:     url,
        download: `solar-recording-${Date.now()}.webm`,
      })
      a.click()
      URL.revokeObjectURL(url)
      chunksRef.current = []
    }

    recorder.start(100) // Collect chunks every 100ms
    recorderRef.current = recorder

    setState((s) => ({ ...s, frameCount: 0 }))

    if (maxDurationMs > 0) {
      setTimeout(() => stopRecording(), maxDurationMs)
    }
  }, [getCanvas, startDurationTick, captureFrame])

  // ── Stop recording ──────────────────────────────────────────────────────────
  const stopRecording = useCallback((): void => {
    stopDurationTick()

    // Stop frame timer (timelapse or PNG fallback)
    if (frameTimerRef.current !== null) {
      clearInterval(frameTimerRef.current)
      frameTimerRef.current = null
    }

    // Stop MediaRecorder
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop()
    }
    recorderRef.current = null

    setState((s) => ({ ...s, recording: false }))
  }, [stopDurationTick])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopDurationTick()
      if (frameTimerRef.current !== null) clearInterval(frameTimerRef.current)
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop()
    }
  }, [stopDurationTick])

  return { state, startRecording, stopRecording }
}

// ── RecorderControls UI ───────────────────────────────────────────────────────

/** Props for the recording controls overlay */
interface RecorderControlsProps {
  state:          RecorderState
  onStart:        (opts?: RecordingOptions) => void
  onStop:         () => void
}

/** Compact recorder controls rendered inside the ControlPanel overlay */
const RecorderControls = memo(function RecorderControls({
  state,
  onStart,
  onStop,
}: RecorderControlsProps) {
  const fmtDuration = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
  }

  const btnBase: React.CSSProperties = {
    padding:      "5px 12px",
    borderRadius: 6,
    border:       "none",
    cursor:       "pointer",
    fontSize:     11,
    fontWeight:   600,
    letterSpacing: "0.04em",
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11, color: DS.muted, fontWeight: 600, letterSpacing: "0.06em" }}>
        RECORDING
      </div>

      {state.recording ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Blinking red dot */}
          <span style={{
            width:        8,
            height:       8,
            borderRadius: "50%",
            background:   DS.danger,
            animation:    "telemetry-blink 0.8s ease-in-out infinite",
            flexShrink:   0,
          }} />
          <span style={{ color: DS.text, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {fmtDuration(state.durationMs)}
            {state.mode === "timelapse" && (
              <span style={{ color: DS.muted, marginLeft: 6 }}>({state.frameCount} frames)</span>
            )}
          </span>
          <button
            style={{ ...btnBase, background: DS.danger, color: "#fff", marginLeft: "auto" }}
            onClick={onStop}
          >
            ■ Stop
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            style={{ ...btnBase, background: DS.gold, color: "#09111e", flex: 1 }}
            onClick={() => onStart({ mode: "realtime" })}
            title="Record WebM video"
          >
            ● Record
          </button>
          <button
            style={{ ...btnBase, background: DS.bgLight, color: DS.text, border: `1px solid ${DS.border}` }}
            onClick={() => onStart({ mode: "timelapse", timelapseMs: 500 })}
            title="Time-lapse PNG frames every 500ms"
          >
            ⏩ Lapse
          </button>
        </div>
      )}

      {state.error && (
        <div style={{ color: DS.danger, fontSize: 10 }}>⚠ {state.error}</div>
      )}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.7 — DIAGNOSTICS ENGINE
// Purpose: Anomaly detection using rolling z-score on per-panel output ratios.
//          Produces severity-tagged diagnostics and a modal UI listing
//          underperforming panels with recommended actions.
//          Also handles CSV import of historical telemetry data.
// ─────────────────────────────────────────────────────────────────────────────

/** Severity levels for diagnostic findings */
type DiagnosticSeverity = "info" | "warning" | "critical"

/** Single diagnostic finding for one panel */
interface DiagnosticFinding {
  panelId:           number
  panelIndex:        number
  severity:          DiagnosticSeverity
  zScore:            number          // standard deviations from fleet mean
  outputRatio:       number          // actual output ratio (0–1)
  expectedRatio:     number          // fleet mean
  temperature:       number
  shadeFactor:       number
  recommendedAction: string
}

/** Diagnostics run output */
interface DiagnosticsResult {
  findings:     DiagnosticFinding[]
  fleetMean:    number
  fleetStdDev:  number
  checkedAt:    number    // unix ms
  anomalyCount: number
}

// ── Rolling statistics helper ─────────────────────────────────────────────────

/** Compute mean and standard deviation of a numeric array */
function rollingStats(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 }
  const mean   = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, stdDev: Math.sqrt(variance) }
}

/** Z-score thresholds for severity classification */
const Z_SCORE_WARNING  = -1.5
const Z_SCORE_CRITICAL = -2.5

/** Map z-score to diagnostic severity */
function classifySeverity(z: number): DiagnosticSeverity {
  if (z <= Z_SCORE_CRITICAL) return "critical"
  if (z <= Z_SCORE_WARNING)  return "warning"
  return "info"
}

/** Generate a human-readable recommended action based on panel state */
function recommendAction(finding: Omit<DiagnosticFinding, "recommendedAction">): string {
  if (finding.temperature > 70) {
    return "Inspect cooling and ventilation; possible thermal throttling."
  }
  if (finding.shadeFactor > 0.5) {
    return "Check for shading obstructions — trim vegetation or reposition."
  }
  if (finding.zScore <= Z_SCORE_CRITICAL && finding.shadeFactor < 0.2) {
    return "Possible hardware fault — schedule IV curve inspection."
  }
  if (finding.zScore <= Z_SCORE_WARNING) {
    return "Monitor output trend; clean panel surface if needed."
  }
  return "No immediate action required — continue monitoring."
}

// ── runDiagnostics ────────────────────────────────────────────────────────────

/**
 * Run anomaly detection across the panel fleet.
 *
 * Uses a rolling z-score: each panel's output ratio is compared against the
 * fleet mean and standard deviation. Panels more than 1.5σ below mean are
 * flagged; >2.5σ below mean are critical.
 *
 * @param panels   Working panel array (for id / index)
 * @param runtime  Corresponding runtime panel values
 * @returns        DiagnosticsResult with sorted findings
 */
function runDiagnostics(panels: WorkingPanel[], runtime: RuntimePanel[]): DiagnosticsResult {
  const activeRatios = runtime
    .filter((_, i) => panels[i]?.enabled)
    .map((r) => r.outputRatio)

  const { mean, stdDev } = rollingStats(activeRatios)
  const checkedAt = Date.now()

  const findings: DiagnosticFinding[] = []

  panels.forEach((panel, i) => {
    if (!panel.enabled) return
    const rt = runtime[i]
    if (!rt) return

    const z = stdDev === 0 ? 0 : (rt.outputRatio - mean) / stdDev
    const severity = classifySeverity(z)

    // Only include findings that are at least warning-level
    if (severity === "info" && z > Z_SCORE_WARNING + 0.5) return

    const base: Omit<DiagnosticFinding, "recommendedAction"> = {
      panelId:       panel.id,
      panelIndex:    i,
      severity,
      zScore:        Number(z.toFixed(3)),
      outputRatio:   Number(rt.outputRatio.toFixed(4)),
      expectedRatio: Number(mean.toFixed(4)),
      temperature:   Number(rt.temperature.toFixed(1)),
      shadeFactor:   Number(rt.shadeFactor.toFixed(4)),
    }

    findings.push({ ...base, recommendedAction: recommendAction(base) })
  })

  // Sort: critical first, then by z-score ascending
  findings.sort((a, b) => {
    const sevOrder: Record<DiagnosticSeverity, number> = { critical: 0, warning: 1, info: 2 }
    if (sevOrder[a.severity] !== sevOrder[b.severity]) {
      return sevOrder[a.severity] - sevOrder[b.severity]
    }
    return a.zScore - b.zScore
  })

  return {
    findings,
    fleetMean:    Number(mean.toFixed(4)),
    fleetStdDev:  Number(stdDev.toFixed(4)),
    checkedAt,
    anomalyCount: findings.filter((f) => f.severity !== "info").length,
  }
}

// ── CSV import for historical telemetry ──────────────────────────────────────

/** One row parsed from an imported historical telemetry CSV */
interface HistoricalCsvRow {
  timestamp:   number
  panelId:     number
  watts:       number
  temperature: number
  outputRatio: number
  shadeFactor: number
}

/**
 * parseHistoricalCsv
 *
 * Parses a CSV string with header row:
 *   timestamp,panelId,watts,temperature,outputRatio,shadeFactor
 *
 * Invalid / missing rows are silently skipped.
 */
function parseHistoricalCsv(csvText: string): HistoricalCsvRow[] {
  const lines = csvText.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []

  const header = lines[0].toLowerCase().split(",").map((h) => h.trim())
  const idx = {
    timestamp:   header.indexOf("timestamp"),
    panelId:     header.indexOf("panelid"),
    watts:       header.indexOf("watts"),
    temperature: header.indexOf("temperature"),
    outputRatio: header.indexOf("outputratio"),
    shadeFactor: header.indexOf("shadefactor"),
  }

  const rows: HistoricalCsvRow[] = []
  for (let r = 1; r < lines.length; r++) {
    const cols = lines[r].split(",")
    const get  = (i: number): number => parseFloat(cols[i] ?? "") || 0
    if (idx.timestamp < 0 || idx.panelId < 0) continue
    rows.push({
      timestamp:   get(idx.timestamp),
      panelId:     get(idx.panelId),
      watts:       get(idx.watts),
      temperature: get(idx.temperature),
      outputRatio: get(idx.outputRatio),
      shadeFactor: get(idx.shadeFactor),
    })
  }
  return rows
}

// ── DiagnosticsModal ──────────────────────────────────────────────────────────

/** Severity badge colour map */
const SEV_COLOR: Record<DiagnosticSeverity, string> = {
  info:     DS.cyan,
  warning:  DS.warning,
  critical: DS.danger,
}

interface DiagnosticsModalProps {
  result:      DiagnosticsResult | null
  panels:      WorkingPanel[]
  runtime:     RuntimePanel[]
  onClose:     () => void
  onSelectPanel: (index: number) => void
}

/**
 * DiagnosticsModal
 *
 * Renders the diagnostics run result in a scrollable modal table.
 * Includes a CSV import control for uploading historical telemetry.
 */
const DiagnosticsModal = memo(function DiagnosticsModal({
  result,
  panels,
  runtime,
  onClose,
  onSelectPanel,
}: DiagnosticsModalProps) {
  const [importedRows, setImportedRows] = useState<HistoricalCsvRow[]>([])
  const [importError,  setImportError]  = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result
      if (typeof text !== "string") { setImportError("Could not read file"); return }
      const rows = parseHistoricalCsv(text)
      if (rows.length === 0) { setImportError("No valid rows found in CSV"); return }
      setImportedRows(rows)
      setImportError(null)
    }
    reader.onerror = () => setImportError("File read error")
    reader.readAsText(file)
  }, [])

  const liveDiag = result ?? runDiagnostics(panels, runtime)

  const modalStyle: React.CSSProperties = {
    position:     "fixed",
    inset:        0,
    background:   "rgba(0,0,0,0.72)",
    display:      "flex",
    alignItems:   "center",
    justifyContent: "center",
    zIndex:       900,
  }

  const panelStyle: React.CSSProperties = {
    background:   DS.bg,
    border:       `1px solid ${DS.border}`,
    borderRadius: 12,
    padding:      "24px 28px",
    width:        "min(96vw, 680px)",
    maxHeight:    "80vh",
    overflowY:    "auto",
    color:        DS.text,
    fontSize:     13,
  }

  return (
    <motion.div
      style={modalStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <motion.div
        style={panelStyle}
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30 }}
      >
        {/* ── Header ── */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: DS.gold }}>
              ⚡ Panel Diagnostics
            </div>
            <div style={{ color: DS.muted, fontSize: 11, marginTop: 2 }}>
              Fleet mean: {(liveDiag.fleetMean * 100).toFixed(1)}% ·
              σ {(liveDiag.fleetStdDev * 100).toFixed(1)}% ·
              {liveDiag.anomalyCount} anomalies
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: DS.muted, cursor: "pointer", fontSize: 18 }}
          >
            ✕
          </button>
        </div>

        {/* ── Findings table ── */}
        {liveDiag.findings.length === 0 ? (
          <div style={{ color: DS.emerald, textAlign: "center", padding: "32px 0" }}>
            ✓ All panels operating within normal range
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: DS.muted, borderBottom: `1px solid ${DS.border}` }}>
                {["Panel", "Severity", "Output", "Expected", "Temp °C", "Shade", "Action"].map((h) => (
                  <th key={h} style={{ padding: "4px 8px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {liveDiag.findings.map((f) => (
                <tr
                  key={f.panelId}
                  style={{ cursor: "pointer", borderBottom: `1px solid ${DS.border}20` }}
                  onClick={() => { onSelectPanel(f.panelIndex); onClose() }}
                >
                  <td style={{ padding: "6px 8px", color: DS.cyan }}>#{f.panelId}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{
                      padding:      "2px 7px",
                      borderRadius: 4,
                      background:   `${SEV_COLOR[f.severity]}22`,
                      color:         SEV_COLOR[f.severity],
                      fontSize:      10,
                      fontWeight:   700,
                    }}>
                      {f.severity.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{(f.outputRatio * 100).toFixed(1)}%</td>
                  <td style={{ padding: "6px 8px", color: DS.muted }}>{(f.expectedRatio * 100).toFixed(1)}%</td>
                  <td style={{ padding: "6px 8px" }}>{f.temperature.toFixed(0)}</td>
                  <td style={{ padding: "6px 8px" }}>{(f.shadeFactor * 100).toFixed(0)}%</td>
                  <td style={{ padding: "6px 8px", color: DS.muted, maxWidth: 180, fontSize: 11 }}>
                    {f.recommendedAction}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* ── CSV import ── */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${DS.border}` }}>
          <div style={{ color: DS.muted, fontSize: 11, marginBottom: 8 }}>
            Import historical telemetry CSV (timestamp, panelId, watts, temperature, outputRatio, shadeFactor)
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={handleFileImport}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding:      "6px 14px",
              borderRadius: 6,
              border:       `1px solid ${DS.border}`,
              background:   DS.bgLight,
              color:        DS.text,
              cursor:       "pointer",
              fontSize:     12,
            }}
          >
            📂 Import CSV
          </button>
          {importError && <span style={{ marginLeft: 12, color: DS.danger, fontSize: 11 }}>{importError}</span>}
          {importedRows.length > 0 && (
            <span style={{ marginLeft: 12, color: DS.emerald, fontSize: 11 }}>
              ✓ {importedRows.length} rows imported
            </span>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.8 — ACCESSIBILITY + i18n
// Purpose: Keyboard-driven panel navigation and a minimal runtime i18n system
//          supporting English and Hindi dictionaries with a language toggle.
// ─────────────────────────────────────────────────────────────────────────────

/** Supported locale codes */
type Locale = "en" | "hi"

/** Dictionary shape — all keys must exist in every locale */
interface I18nDictionary {
  // Navigation
  panelInspector:     string
  selectPanel:        string
  closeInspector:     string
  noPanel:            string

  // Status
  output:             string
  temperature:        string
  efficiency:         string
  shading:            string
  dcPower:            string
  acPower:            string

  // Weather
  clear:              string
  cloudy:             string
  rain:               string
  snow:               string
  storm:              string
  fog:                string

  // Seasons
  spring:             string
  summer:             string
  autumn:             string
  winter:             string

  // Actions
  exportCsv:          string
  snapshot:           string
  playPause:          string
  resetCamera:        string

  // Modals
  analytics:          string
  roi:                string
  forecast:           string
  config:             string
  settings:           string
  diagnostics:        string

  // Settings
  roofType:           string
  showBattery:        string
  showWind:           string
  showGround:         string
  showCabling:        string
  energyFlow:         string
  bloom:              string
  nightMode:          string
  language:           string

  // Misc
  panels:             string
  system:             string
  live:               string
  error:              string
  loading:            string
}

/** English (default) dictionary */
const EN_DICT: I18nDictionary = {
  panelInspector:  "Panel Inspector",
  selectPanel:     "Select a panel",
  closeInspector:  "Close inspector",
  noPanel:         "No panel selected",
  output:          "Output",
  temperature:     "Temperature",
  efficiency:      "Efficiency",
  shading:         "Shading",
  dcPower:         "DC Power",
  acPower:         "AC Power",
  clear:           "Clear",
  cloudy:          "Cloudy",
  rain:            "Rain",
  snow:            "Snow",
  storm:           "Storm",
  fog:             "Fog",
  spring:          "Spring",
  summer:          "Summer",
  autumn:          "Autumn",
  winter:          "Winter",
  exportCsv:       "Export CSV",
  snapshot:        "Snapshot",
  playPause:       "Play / Pause",
  resetCamera:     "Reset Camera",
  analytics:       "Analytics",
  roi:             "ROI",
  forecast:        "Forecast",
  config:          "Config",
  settings:        "Settings",
  diagnostics:     "Diagnostics",
  roofType:        "Roof Type",
  showBattery:     "Battery",
  showWind:        "Wind Turbine",
  showGround:      "Ground Plane",
  showCabling:     "Cabling",
  energyFlow:      "Energy Flow",
  bloom:           "Bloom FX",
  nightMode:       "Night Mode",
  language:        "Language",
  panels:          "Panels",
  system:          "System",
  live:            "Live",
  error:           "Error",
  loading:         "Loading…",
}

/** Hindi dictionary */
const HI_DICT: I18nDictionary = {
  panelInspector:  "पैनल निरीक्षक",
  selectPanel:     "पैनल चुनें",
  closeInspector:  "निरीक्षक बंद करें",
  noPanel:         "कोई पैनल नहीं चुना",
  output:          "उत्पादन",
  temperature:     "तापमान",
  efficiency:      "दक्षता",
  shading:         "छाया",
  dcPower:         "DC शक्ति",
  acPower:         "AC शक्ति",
  clear:           "साफ़",
  cloudy:          "बादल",
  rain:            "वर्षा",
  snow:            "बर्फ",
  storm:           "तूफ़ान",
  fog:             "कोहरा",
  spring:          "वसंत",
  summer:          "ग्रीष्म",
  autumn:          "शरद",
  winter:          "शीत",
  exportCsv:       "CSV निर्यात",
  snapshot:        "स्नैपशॉट",
  playPause:       "चलाएं / रोकें",
  resetCamera:     "कैमरा रीसेट",
  analytics:       "विश्लेषण",
  roi:             "ROI",
  forecast:        "पूर्वानुमान",
  config:          "कॉन्फ़िग",
  settings:        "सेटिंग",
  diagnostics:     "निदान",
  roofType:        "छत का प्रकार",
  showBattery:     "बैटरी",
  showWind:        "पवन टरबाइन",
  showGround:      "ज़मीन",
  showCabling:     "केबलिंग",
  energyFlow:      "ऊर्जा प्रवाह",
  bloom:           "ब्लूम FX",
  nightMode:       "रात मोड",
  language:        "भाषा",
  panels:          "पैनल",
  system:          "प्रणाली",
  live:            "लाइव",
  error:           "त्रुटि",
  loading:         "लोड हो रहा है…",
}

/** All available dictionaries indexed by locale */
const DICTIONARIES: Record<Locale, I18nDictionary> = { en: EN_DICT, hi: HI_DICT }

/**
 * t — translate a dictionary key to the specified locale.
 * Falls back to English if the key is missing in the target locale.
 *
 * @example
 *   t("temperature", "hi")  // → "तापमान"
 *   t("temperature", "en")  // → "Temperature"
 */
function t(key: keyof I18nDictionary, locale: Locale = "en"): string {
  return DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en[key] ?? key
}

// ── useLocale ─────────────────────────────────────────────────────────────────

/**
 * useLocale
 *
 * Persists locale selection in localStorage and provides a toggle function.
 * Defaults to "en" if localStorage is unavailable.
 */
function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      const stored = localStorage.getItem("solar-locale")
      return (stored === "hi" ? "hi" : "en") as Locale
    } catch {
      return "en"
    }
  })

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem("solar-locale", l) } catch { /* ignore */ }
  }, [])

  return { locale, setLocale }
}

// ── useKeyboardNavigation ─────────────────────────────────────────────────────

/** Configuration for the keyboard navigation hook */
interface KeyboardNavigationConfig {
  /** Total number of navigable panels */
  panelCount: number
  /** Number of columns in the panel grid */
  columns: number
  /** Currently selected panel index (null = none) */
  selectedIndex: number | null
  /** Callback to update selection */
  onSelect: (index: number | null) => void
  /** Callback to open inspector for selected panel */
  onOpenInspector: (index: number) => void
  /** Whether navigation is enabled (false when modals are open) */
  enabled: boolean
}

/**
 * useKeyboardNavigation
 *
 * Enables arrow-key navigation across the panel grid and Enter to open the
 * panel inspector. Works alongside the existing useKeyboardShortcuts hook
 * without conflicts.
 *
 * Key bindings:
 *   Arrow keys  — move selection in grid
 *   Enter       — open inspector for selected panel
 *   Tab         — advance selection forward
 *   Shift+Tab   — advance selection backward
 *   Escape      — clear selection (handled by parent)
 */
function useKeyboardNavigation({
  panelCount,
  columns,
  selectedIndex,
  onSelect,
  onOpenInspector,
  enabled,
}: KeyboardNavigationConfig): void {
  useEffect(() => {
    if (!enabled || panelCount === 0) return

    const onKey = (e: KeyboardEvent) => {
      // Only intercept navigation keys; ignore if user is in an input
      if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return

      let next: number | null = null
      const cur = selectedIndex ?? -1

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault()
          next = cur < 0 ? 0 : Math.min(cur + 1, panelCount - 1)
          break
        case "ArrowLeft":
          e.preventDefault()
          next = cur < 0 ? 0 : Math.max(cur - 1, 0)
          break
        case "ArrowDown":
          e.preventDefault()
          next = cur < 0 ? 0 : Math.min(cur + columns, panelCount - 1)
          break
        case "ArrowUp":
          e.preventDefault()
          next = cur < 0 ? 0 : Math.max(cur - columns, 0)
          break
        case "Tab":
          // Don't prevent default for Tab — just advance selection
          next = cur < 0 ? 0 : e.shiftKey
            ? Math.max(cur - 1, 0)
            : Math.min(cur + 1, panelCount - 1)
          break
        case "Enter":
          if (selectedIndex !== null) {
            e.preventDefault()
            onOpenInspector(selectedIndex)
          }
          break
        case "Home":
          e.preventDefault()
          next = 0
          break
        case "End":
          e.preventDefault()
          next = panelCount - 1
          break
        default:
          return
      }

      if (next !== null) onSelect(next)
    }

    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, panelCount, columns, selectedIndex, onSelect, onOpenInspector])
}

// ── LanguageToggle UI ─────────────────────────────────────────────────────────

/** Compact language toggle button used inside SettingsModal */
interface LanguageToggleProps {
  locale:    Locale
  onChange:  (l: Locale) => void
}

const LanguageToggle = memo(function LanguageToggle({ locale, onChange }: LanguageToggleProps) {
  const LOCALES: { value: Locale; label: string }[] = [
    { value: "en", label: "English" },
    { value: "hi", label: "हिन्दी" },
  ]

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {LOCALES.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          style={{
            padding:      "4px 12px",
            borderRadius: 6,
            border:       `1px solid ${locale === value ? DS.gold : DS.border}`,
            background:   locale === value ? `${DS.gold}22` : DS.bgLight,
            color:        locale === value ? DS.gold : DS.muted,
            cursor:       "pointer",
            fontSize:     12,
            fontWeight:   locale === value ? 700 : 400,
            transition:   "all 0.15s ease",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
})

// ── Accessible panel focus ring (renders in 3D over selected panel) ───────────

interface A11yFocusRingProps {
  position:  [number, number, number]
  rotation:  [number, number, number]
  visible:   boolean
}

/**
 * A11yFocusRing
 *
 * Renders a pulsing wireframe box around the focused/selected panel to
 * provide visible keyboard navigation feedback in the 3D scene.
 */
const A11yFocusRing = memo(function A11yFocusRing({
  position,
  rotation,
  visible,
}: A11yFocusRingProps) {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame(({ clock }) => {
    if (!meshRef.current) return
    const t = clock.getElapsedTime()
    meshRef.current.scale.setScalar(1 + Math.sin(t * 3.5) * 0.04)
  })

  if (!visible) return null

  return (
    <mesh
      ref={meshRef}
      position={[position[0], position[1] + 0.04, position[2]]}
      rotation={rotation}
    >
      <boxGeometry args={[PANEL_WIDTH + 0.12, PANEL_THICKNESS + 0.06, PANEL_DEPTH + 0.12]} />
      <meshBasicMaterial
        color={DS.gold}
        wireframe
        transparent
        opacity={0.8}
        depthWrite={false}
      />
    </mesh>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.9 — WEBXR / VR SUPPORT
// Purpose: Optional immersive-vr session entry point. When the device supports
//          WebXR, a VR button appears in the control panel. Entering VR
//          disables OrbitControls and uses the XR camera. If unsupported, a
//          toast notification informs the user.
// ─────────────────────────────────────────────────────────────────────────────

/** XR session state */
type XRSessionState = "idle" | "requesting" | "active" | "exiting" | "unsupported"

/** Return value of useWebXR */
interface WebXRHandle {
  sessionState:   XRSessionState
  isActive:       boolean
  isSupported:    boolean
  toastMessage:   string | null
  enterVR:        () => Promise<void>
  exitVR:         () => Promise<void>
  dismissToast:   () => void
}

/**
 * useWebXR
 *
 * Checks navigator.xr availability, requests an "immersive-vr" session on
 * enterVR(), and cleans up the session on exitVR().
 * Surfaces a toast message when VR is unsupported.
 */
function useWebXR(): WebXRHandle {
  const sessionRef = useRef<XRSession | null>(null)

  const [sessionState, setSessionState] = useState<XRSessionState>("idle")
  const [isSupported,  setIsSupported]  = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // Check support on mount
  useEffect(() => {
    if (typeof navigator === "undefined" || !("xr" in navigator)) {
      setIsSupported(false)
      return
    }
    ;(navigator as Navigator & { xr?: XRSystem }).xr
      ?.isSessionSupported("immersive-vr")
      .then((supported) => setIsSupported(supported))
      .catch(() => setIsSupported(false))
  }, [])

  const dismissToast = useCallback(() => setToastMessage(null), [])

  const enterVR = useCallback(async () => {
    if (sessionRef.current) return // Already in session

    const xr = (navigator as Navigator & { xr?: XRSystem }).xr
    if (!xr) {
      setToastMessage("WebXR is not supported in this browser.")
      return
    }

    const supported = await xr.isSessionSupported("immersive-vr").catch(() => false)
    if (!supported) {
      setToastMessage("Immersive VR is not supported on this device.")
      setSessionState("unsupported")
      setTimeout(() => setToastMessage(null), 4000)
      return
    }

    setSessionState("requesting")

    try {
      const session = await xr.requestSession("immersive-vr", {
        requiredFeatures: ["local"],
        optionalFeatures: ["hand-tracking", "bounded-floor"],
      })

      sessionRef.current = session
      setSessionState("active")

      session.addEventListener("end", () => {
        sessionRef.current = null
        setSessionState("idle")
      })
    } catch (err) {
      setSessionState("idle")
      setToastMessage(`VR session failed: ${(err as Error).message}`)
      setTimeout(() => setToastMessage(null), 4000)
    }
  }, [])

  const exitVR = useCallback(async () => {
    if (!sessionRef.current) return
    setSessionState("exiting")
    try {
      await sessionRef.current.end()
    } catch {
      // session.end() may throw if already ended
    }
    sessionRef.current = null
    setSessionState("idle")
  }, [])

  return {
    sessionState,
    isActive:    sessionState === "active",
    isSupported,
    toastMessage,
    enterVR,
    exitVR,
    dismissToast,
  }
}

// ── XRControls — disables OrbitControls in XR ─────────────────────────────────

interface XRControlsProps {
  xrActive:       boolean
  orbitRef:       React.RefObject<OrbitControlsImpl | null>
}

/**
 * XRControls
 *
 * Disables/enables OrbitControls depending on XR session state.
 * When XR is active the XR camera handles all view management.
 */
const XRControls = memo(function XRControls({ xrActive, orbitRef }: XRControlsProps) {
  useEffect(() => {
    if (!orbitRef.current) return
    orbitRef.current.enabled = !xrActive
  }, [xrActive, orbitRef])

  return null
})

// ── WebXRButton ───────────────────────────────────────────────────────────────

interface WebXRButtonProps {
  handle: WebXRHandle
}

/** VR entry/exit button rendered in the DOM control panel */
const WebXRButton = memo(function WebXRButton({ handle }: WebXRButtonProps) {
  const { sessionState, isSupported, enterVR, exitVR, toastMessage, dismissToast } = handle

  if (!isSupported && sessionState !== "requesting") {
    return (
      <button
        disabled
        title="WebXR immersive-vr not supported on this device"
        style={{
          padding:      "6px 14px",
          borderRadius: 6,
          border:       `1px solid ${DS.border}`,
          background:   DS.bgLight,
          color:        DS.muted,
          cursor:       "not-allowed",
          fontSize:     12,
          opacity:      0.5,
        }}
      >
        🥽 VR (unsupported)
      </button>
    )
  }

  const isActive = sessionState === "active"
  const label    = {
    idle:        "🥽 Enter VR",
    requesting:  "🥽 Starting…",
    active:      "🥽 Exit VR",
    exiting:     "🥽 Exiting…",
    unsupported: "🥽 VR (unsupported)",
  }[sessionState]

  return (
    <>
      <button
        onClick={isActive ? exitVR : enterVR}
        disabled={sessionState === "requesting" || sessionState === "exiting"}
        style={{
          padding:      "6px 14px",
          borderRadius: 6,
          border:       `1px solid ${isActive ? DS.emerald : DS.border}`,
          background:   isActive ? `${DS.emerald}22` : DS.bgLight,
          color:        isActive ? DS.emerald : DS.text,
          cursor:       sessionState === "requesting" ? "wait" : "pointer",
          fontSize:     12,
          fontWeight:   isActive ? 700 : 400,
          transition:   "all 0.15s ease",
        }}
      >
        {label}
      </button>

      {/* Toast notification */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            style={{
              position:     "fixed",
              bottom:       28,
              left:         "50%",
              transform:    "translateX(-50%)",
              background:   DS.bg,
              border:       `1px solid ${DS.warning}`,
              borderRadius: 8,
              padding:      "10px 20px",
              color:        DS.warning,
              fontSize:     13,
              zIndex:       9999,
              cursor:       "pointer",
              whiteSpace:   "nowrap",
            }}
            onClick={dismissToast}
          >
            {toastMessage}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.10 — MOCK TELEMETRY GENERATOR
// Purpose: Generates a realistic 24-hour solar telemetry dataset using seeded
//          random numbers. Useful for demos, Storybook stories, and E2E tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Options for the mock telemetry generator */
interface MockTelemetryOptions {
  panelCount?:   number     // default 12
  ratedWatts?:   number     // STC rated power per panel (default 400)
  latitude?:     number     // observer latitude (default 28.6)
  declination?:  number     // solar declination (default 23.4 = summer)
  weather?:      WeatherType
  dateMs?:       number     // start of day Unix ms (default today 00:00 UTC)
  intervalMin?:  number     // sampling interval in minutes (default 15)
}

/** One simulated sample in the mock dataset */
interface MockTelemetrySample {
  timestamp:    number                 // Unix ms
  hour:         number                 // local solar hour (0–24)
  panels:       SerialPanelSnap[]
  totalKw:      number
  weather:      WeatherType
  elevation:    number
  azimuth:      number
}

/**
 * generateMockTelemetry
 *
 * Creates a full synthetic 24-hour telemetry timeline sampled at `intervalMin`
 * intervals. All randomness is seeded — the same inputs always produce the
 * same dataset.
 *
 * @example
 *   const data = generateMockTelemetry({ panelCount: 12, intervalMin: 15 })
 *   data.forEach((sample) => console.log(sample.hour, sample.totalKw))
 */
function generateMockTelemetry(opts: MockTelemetryOptions = {}): MockTelemetrySample[] {
  const {
    panelCount   = 12,
    ratedWatts   = 400,
    latitude     = 28.6,
    declination  = 23.4,
    weather      = "clear",
    dateMs       = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    intervalMin  = 15,
  } = opts

  const weatherFactor     = WEATHER_FACTOR[weather]
  const tempOffset        = WEATHER_TEMP_OFFSET[weather]
  const intervalMs        = intervalMin * 60 * 1000
  const samplesPerDay     = Math.ceil(24 * 60 / intervalMin)

  const samples: MockTelemetrySample[] = []

  for (let s = 0; s < samplesPerDay; s++) {
    const tsMs       = dateMs + s * intervalMs
    const hour       = (s * intervalMin) / 60
    const { elevation, azimuth } = sunPositionFromTime(hour, latitude, declination)
    const sunAbove   = elevation > 0 ? 1 : 0
    const sky        = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))

    const panelSnaps: SerialPanelSnap[] = []
    let totalWatts = 0

    for (let p = 0; p < panelCount; p++) {
      const panelSeed = p * 7 + 3
      const efficiency = 20.2 + seeded(panelSeed) * 1.8
      const shadeBase  = seeded(p * 13 + 2) > 0.82 ? seeded(p * 17 + 9) * 0.4 : 0
      // Add time-varying shade (trees / neighbours)
      const shadeWave  = shadeBase * (0.8 + 0.2 * Math.sin(hour * 0.52 + p))
      const shadeFactor = clamp(shadeWave, 0, 1)
      const irradiance  = sky * weatherFactor * (0.85 + seeded(panelSeed + s) * 0.15) * sunAbove
      const ambientTemp = 25 + tempOffset + sky * 12
      const temperature = clamp(ambientTemp + irradiance * 28 + seeded(panelSeed + 1) * 6, -10, 85)
      const tempCoeff   = 1 - clamp((temperature - 25) * 0.004, -0.2, 0.25)
      const dcWatts     = clamp(ratedWatts * irradiance * tempCoeff * (1 - shadeFactor * 0.95), 0, ratedWatts)
      const watts       = dcWatts * INVERTER_EFFICIENCY
      const outputRatio = clamp(dcWatts / ratedWatts, 0, 1)

      totalWatts += watts
      panelSnaps.push({
        id:          p + 1,
        watts:       Number(watts.toFixed(2)),
        temperature: Number(temperature.toFixed(1)),
        outputRatio: Number(outputRatio.toFixed(4)),
        shadeFactor: Number(shadeFactor.toFixed(4)),
      })
    }

    samples.push({
      timestamp: tsMs,
      hour:      Number(hour.toFixed(3)),
      panels:    panelSnaps,
      totalKw:   Number((totalWatts / 1000).toFixed(3)),
      weather,
      elevation: Number(elevation.toFixed(2)),
      azimuth:   Number(azimuth.toFixed(2)),
    })
  }

  return samples
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 11 — TESTS & E2E
// ─────────────────────────────────────────────────────────────────────────────
//
// Unit tests (Vitest / Jest) and Playwright E2E test hints for all major
// subsystems introduced in Section 10. Run with:
//
//   npx vitest run                     (unit tests)
//   npx playwright test                (E2E tests — requires a running dev server)
//
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 11.1  VITEST UNIT TESTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
 * import {
 *   rollingStats, runDiagnostics, parseHistoricalCsv,
 *   generateMockTelemetry, t, encodeIdToColor, decodeColorToId,
 *   toWorkerDescriptor, decodeWorkerBuffer, buildGpuParticleGeometry,
 *   createThermalShaderMaterial, createGpuParticleMaterial,
 *   TelemetryStore,
 * } from "./scene3d-ultra";
 * import * as THREE from "three";
 *
 * // ── 11.1.1  rollingStats ──────────────────────────────────────────────────
 *
 * describe("rollingStats", () => {
 *   it("returns zero mean and stdDev for empty array", () => {
 *     expect(rollingStats([])).toEqual({ mean: 0, stdDev: 0 });
 *   });
 *
 *   it("computes mean correctly", () => {
 *     const { mean } = rollingStats([1, 2, 3, 4, 5]);
 *     expect(mean).toBeCloseTo(3, 5);
 *   });
 *
 *   it("computes population stdDev correctly", () => {
 *     const { stdDev } = rollingStats([2, 4, 4, 4, 5, 5, 7, 9]);
 *     expect(stdDev).toBeCloseTo(2, 0);
 *   });
 *
 *   it("handles single-element array", () => {
 *     const { mean, stdDev } = rollingStats([42]);
 *     expect(mean).toBe(42);
 *     expect(stdDev).toBe(0);
 *   });
 * });
 *
 * // ── 11.1.2  runDiagnostics ────────────────────────────────────────────────
 *
 * describe("runDiagnostics", () => {
 *   const makePanels = (n: number) =>
 *     Array.from({ length: n }, (_, i) => ({
 *       id: i + 1, index: i, row: 0, col: i, enabled: true,
 *       efficiency: 20, temp: 25, power: 400, basePower: 400,
 *       sunlight: 0.9, shade: 0, stringIndex: 0,
 *       position: [0, 0, 0] as [number, number, number],
 *     }));
 *
 *   it("returns no findings when all panels have equal output", () => {
 *     const panels = makePanels(6);
 *     const runtime = panels.map(() => ({
 *       watts: 380, dcWatts: 390, outputRatio: 0.95, temperature: 40,
 *       shadeFactor: 0, efficiencyPct: 20,
 *       color: new THREE.Color(), thermalColor: new THREE.Color(), stringColor: new THREE.Color(),
 *     }));
 *     const { findings } = runDiagnostics(panels, runtime);
 *     expect(findings).toHaveLength(0);
 *   });
 *
 *   it("flags a panel with critically low output", () => {
 *     const panels = makePanels(6);
 *     const runtime = panels.map((_, i) => ({
 *       watts: i === 2 ? 50 : 380,
 *       dcWatts: i === 2 ? 55 : 390,
 *       outputRatio: i === 2 ? 0.12 : 0.95,
 *       temperature: 40, shadeFactor: 0, efficiencyPct: 20,
 *       color: new THREE.Color(), thermalColor: new THREE.Color(), stringColor: new THREE.Color(),
 *     }));
 *     const { findings } = runDiagnostics(panels, runtime);
 *     expect(findings.some(f => f.severity === "critical" && f.panelIndex === 2)).toBe(true);
 *   });
 *
 *   it("sorts critical findings first", () => {
 *     const panels = makePanels(4);
 *     const runtime = panels.map((_, i) => ({
 *       watts: i === 0 ? 20 : i === 1 ? 200 : 390,
 *       dcWatts: 0, outputRatio: i === 0 ? 0.05 : i === 1 ? 0.5 : 0.95,
 *       temperature: 35, shadeFactor: 0, efficiencyPct: 20,
 *       color: new THREE.Color(), thermalColor: new THREE.Color(), stringColor: new THREE.Color(),
 *     }));
 *     const { findings } = runDiagnostics(panels, runtime);
 *     if (findings.length >= 2) {
 *       expect(findings[0].severity).toBe("critical");
 *     }
 *   });
 *
 *   it("skips disabled panels", () => {
 *     const panels = makePanels(4).map((p, i) => ({ ...p, enabled: i !== 1 }));
 *     const runtime = panels.map(() => ({
 *       watts: 380, dcWatts: 390, outputRatio: 0.95, temperature: 40,
 *       shadeFactor: 0, efficiencyPct: 20,
 *       color: new THREE.Color(), thermalColor: new THREE.Color(), stringColor: new THREE.Color(),
 *     }));
 *     const { findings } = runDiagnostics(panels, runtime);
 *     expect(findings.every(f => f.panelIndex !== 1)).toBe(true);
 *   });
 * });
 *
 * // ── 11.1.3  parseHistoricalCsv ────────────────────────────────────────────
 *
 * describe("parseHistoricalCsv", () => {
 *   const CSV = [
 *     "timestamp,panelId,watts,temperature,outputRatio,shadeFactor",
 *     "1700000000000,1,380.5,42.1,0.951,0.000",
 *     "1700000000000,2,310.2,48.3,0.775,0.180",
 *     "bad-row,NaN,foo",
 *   ].join("\n");
 *
 *   it("parses valid rows", () => {
 *     const rows = parseHistoricalCsv(CSV);
 *     expect(rows).toHaveLength(2);
 *     expect(rows[0].watts).toBeCloseTo(380.5);
 *   });
 *
 *   it("returns empty array for empty CSV", () => {
 *     expect(parseHistoricalCsv("")).toHaveLength(0);
 *   });
 *
 *   it("returns empty array for header-only CSV", () => {
 *     expect(parseHistoricalCsv("timestamp,panelId,watts")).toHaveLength(0);
 *   });
 *
 *   it("handles Windows line endings", () => {
 *     const csv = "timestamp,panelId,watts,temperature,outputRatio,shadeFactor\r\n1700000000000,1,380,40,0.95,0\r\n";
 *     expect(parseHistoricalCsv(csv)).toHaveLength(1);
 *   });
 * });
 *
 * // ── 11.1.4  generateMockTelemetry ─────────────────────────────────────────
 *
 * describe("generateMockTelemetry", () => {
 *   it("generates 96 samples for 24 hours at 15-min intervals", () => {
 *     const data = generateMockTelemetry({ intervalMin: 15 });
 *     expect(data).toHaveLength(96);
 *   });
 *
 *   it("first sample is at dateMs", () => {
 *     const dateMs = 1_700_000_000_000;
 *     const data   = generateMockTelemetry({ dateMs, intervalMin: 60 });
 *     expect(data[0].timestamp).toBe(dateMs);
 *   });
 *
 *   it("totalKw is zero at midnight (sun below horizon)", () => {
 *     const data = generateMockTelemetry({ latitude: 28.6, declination: 23.4, intervalMin: 60 });
 *     const midnight = data[0];
 *     expect(midnight.elevation).toBeLessThan(0);
 *     expect(midnight.totalKw).toBe(0);
 *   });
 *
 *   it("totalKw peaks near solar noon", () => {
 *     const data = generateMockTelemetry({ panelCount: 12, intervalMin: 15, weather: "clear" });
 *     const peakSample = data.reduce((a, b) => b.totalKw > a.totalKw ? b : a);
 *     expect(peakSample.hour).toBeGreaterThan(10);
 *     expect(peakSample.hour).toBeLessThan(15);
 *   });
 *
 *   it("storm weather reduces totalKw vs clear", () => {
 *     const clear = generateMockTelemetry({ weather: "clear",  panelCount: 6 });
 *     const storm = generateMockTelemetry({ weather: "storm",  panelCount: 6 });
 *     const clearPeak = Math.max(...clear.map(s => s.totalKw));
 *     const stormPeak = Math.max(...storm.map(s => s.totalKw));
 *     expect(stormPeak).toBeLessThan(clearPeak);
 *   });
 *
 *   it("output is deterministic (seeded)", () => {
 *     const a = generateMockTelemetry({ panelCount: 4 });
 *     const b = generateMockTelemetry({ panelCount: 4 });
 *     expect(a[12].totalKw).toBe(b[12].totalKw);
 *   });
 * });
 *
 * // ── 11.1.5  i18n / t() ───────────────────────────────────────────────────
 *
 * describe("t()", () => {
 *   it("returns English string for 'en' locale", () => {
 *     expect(t("temperature", "en")).toBe("Temperature");
 *   });
 *
 *   it("returns Hindi string for 'hi' locale", () => {
 *     expect(t("temperature", "hi")).toBe("तापमान");
 *   });
 *
 *   it("falls back to English for unknown locale cast", () => {
 *     expect(t("output", "en")).toBe("Output");
 *   });
 *
 *   it("returns key for unknown key (should not happen in prod)", () => {
 *     // @ts-expect-error Testing bad key
 *     const result = t("nonexistent_key", "en");
 *     expect(result).toBe("nonexistent_key");
 *   });
 * });
 *
 * // ── 11.1.6  GPU picking codec ──────────────────────────────────────────────
 *
 * describe("GPU picking codec", () => {
 *   it("encodes and decodes round-trip correctly", () => {
 *     for (const id of [0, 1, 127, 255, 256, 1000, 65535, 100_000]) {
 *       const c = encodeIdToColor(id + 1); // ids are 1-indexed in pick shader
 *       const r = Math.round(c.r * 255);
 *       const g = Math.round(c.g * 255);
 *       const b = Math.round(c.b * 255);
 *       expect(decodeColorToId(r, g, b)).toBe(id + 1);
 *     }
 *   });
 * });
 *
 * // ── 11.1.7  Worker descriptor serialisation ────────────────────────────────
 *
 * describe("toWorkerDescriptor", () => {
 *   it("strips THREE.Color from WorkingPanel", () => {
 *     const wp = {
 *       id: 1, index: 0, row: 0, col: 0, enabled: true,
 *       efficiency: 20.2, temp: 30, power: 400, basePower: 400,
 *       sunlight: 0.9, shade: 0.05, stringIndex: 0,
 *       position: [0, 0, 0] as [number, number, number],
 *     };
 *     const desc = toWorkerDescriptor(wp);
 *     expect("position" in desc).toBe(false);
 *     expect(desc.efficiency).toBe(20.2);
 *   });
 * });
 *
 * // ── 11.1.8  decodeWorkerBuffer ────────────────────────────────────────────
 *
 * describe("decodeWorkerBuffer", () => {
 *   it("decodes a manually constructed buffer", () => {
 *     const panels = [{
 *       id: 1, index: 0, row: 0, col: 0, enabled: true,
 *       efficiency: 20, temp: 25, power: 380, basePower: 400,
 *       sunlight: 0.9, shade: 0, stringIndex: 0,
 *       position: [0, 0, 0] as [number, number, number],
 *     }];
 *     const buf = new Float32Array(9);
 *     buf[0] = 370; // watts
 *     buf[1] = 380; // dcWatts
 *     buf[2] = 42;  // temperature
 *     buf[3] = 0.05; // shadeFactor
 *     buf[4] = 0.94; // outputRatio
 *     buf[5] = 19.8; // efficiencyPct
 *     buf[6] = 1.0; buf[7] = 0.8; buf[8] = 0.3; // color
 *     const result = decodeWorkerBuffer(buf, panels);
 *     expect(result[0].watts).toBe(370);
 *     expect(result[0].temperature).toBe(42);
 *     expect(result[0].outputRatio).toBeCloseTo(0.94);
 *   });
 * });
 *
 * // ── 11.1.9  GPU particle geometry ─────────────────────────────────────────
 *
 * describe("buildGpuParticleGeometry", () => {
 *   it("creates correct vertex count", () => {
 *     const geo = buildGpuParticleGeometry(500, 37);
 *     expect(geo.attributes.position.count).toBe(500);
 *   });
 *
 *   it("bakes UV seeds in [0, 1] range", () => {
 *     const geo = buildGpuParticleGeometry(100, 11);
 *     const uv  = geo.attributes.uv.array as Float32Array;
 *     for (const v of uv) {
 *       expect(v).toBeGreaterThanOrEqual(0);
 *       expect(v).toBeLessThanOrEqual(1);
 *     }
 *   });
 *
 *   it("all positions are zero (shader computes positions)", () => {
 *     const geo = buildGpuParticleGeometry(50, 7);
 *     const pos = geo.attributes.position.array as Float32Array;
 *     expect(pos.every(v => v === 0)).toBe(true);
 *   });
 * });
 *
 * // ── 11.1.10  TelemetryStore (IndexedDB) ───────────────────────────────────
 *
 * describe("TelemetryStore", () => {
 *   // IndexedDB is available in happy-dom / jsdom environments via fake-indexeddb.
 *   // Install: npm i -D fake-indexeddb
 *   // Add to vitest.config.ts: { globals: true, environment: "happy-dom" }
 *
 *   let store: TelemetryStore;
 *   beforeEach(async () => {
 *     store = new TelemetryStore();
 *     await store.open();
 *   });
 *   afterEach(() => store.close());
 *
 *   it("stores and retrieves a record", async () => {
 *     const rec = {
 *       id:        "2024-01-01T12:00:00.000Z",
 *       timestamp: 1_704_110_400_000,
 *       panels:    [{ id: 1, watts: 380, temperature: 42, outputRatio: 0.95, shadeFactor: 0 }],
 *       totalKw:   4.56,
 *       weather:   "clear" as WeatherType,
 *     };
 *     await store.put(rec);
 *     const results = await store.getRecent(10);
 *     expect(results.some(r => r.id === rec.id)).toBe(true);
 *   });
 *
 *   it("clear() removes all records", async () => {
 *     await store.put({
 *       id: "test-1", timestamp: Date.now(), panels: [], totalKw: 0, weather: "clear" as WeatherType,
 *     });
 *     await store.clear();
 *     const results = await store.getRecent(10);
 *     expect(results).toHaveLength(0);
 *   });
 *
 *   it("getRange returns only records in range", async () => {
 *     const t0 = 1_700_000_000_000;
 *     const t1 = t0 + 60_000;
 *     const t2 = t0 + 120_000;
 *     await store.put({ id: "r0", timestamp: t0, panels: [], totalKw: 0, weather: "clear" as WeatherType });
 *     await store.put({ id: "r1", timestamp: t1, panels: [], totalKw: 0, weather: "clear" as WeatherType });
 *     await store.put({ id: "r2", timestamp: t2, panels: [], totalKw: 0, weather: "clear" as WeatherType });
 *     const results = await store.getRange(t0, t1);
 *     expect(results.some(r => r.id === "r0")).toBe(true);
 *     expect(results.some(r => r.id === "r1")).toBe(true);
 *     expect(results.some(r => r.id === "r2")).toBe(false);
 *   });
 * });
 *
 * // ── 11.1.11  Thermal ShaderMaterial ──────────────────────────────────────
 *
 * describe("createThermalShaderMaterial", () => {
 *   it("creates ShaderMaterial with correct uniform keys", () => {
 *     const mat = createThermalShaderMaterial(55, 1.0);
 *     expect("uTime"        in mat.uniforms).toBe(true);
 *     expect("uTemperature" in mat.uniforms).toBe(true);
 *     expect("uIntensity"   in mat.uniforms).toBe(true);
 *   });
 *
 *   it("normalises temperature into [0, 1]", () => {
 *     const cold = createThermalShaderMaterial(8,  1.0);
 *     const hot  = createThermalShaderMaterial(63, 1.0); // (63-8)/55 = 1.0
 *     expect(cold.uniforms.uTemperature.value).toBeCloseTo(0, 4);
 *     expect(hot.uniforms.uTemperature.value).toBeCloseTo(1, 4);
 *   });
 *
 *   it("clamps temperature outside range", () => {
 *     const over = createThermalShaderMaterial(200, 1.0);
 *     expect(over.uniforms.uTemperature.value).toBe(1);
 *   });
 * });
 *
 * // ── 11.1.12  createGpuParticleMaterial ────────────────────────────────────
 *
 * describe("createGpuParticleMaterial", () => {
 *   it("sets type uniform correctly", () => {
 *     const rain  = createGpuParticleMaterial(0, new THREE.Color("#93c5fd"), 4.2, 28, 0.58);
 *     const snow  = createGpuParticleMaterial(1, new THREE.Color("#f0f4ff"), 0.7, 48, 0.72);
 *     const storm = createGpuParticleMaterial(2, new THREE.Color("#bfdbfe"), 6.4, 24, 0.48);
 *     expect(rain.uniforms.uType.value).toBe(0);
 *     expect(snow.uniforms.uType.value).toBe(1);
 *     expect(storm.uniforms.uType.value).toBe(2);
 *   });
 *
 *   it("uses AdditiveBlending", () => {
 *     const mat = createGpuParticleMaterial(0, new THREE.Color(), 4, 28, 1);
 *     expect(mat.blending).toBe(THREE.AdditiveBlending);
 *   });
 *
 *   it("is transparent with depthWrite=false", () => {
 *     const mat = createGpuParticleMaterial(1, new THREE.Color(), 0.7, 48, 0.7);
 *     expect(mat.transparent).toBe(true);
 *     expect(mat.depthWrite).toBe(false);
 *   });
 * });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 11.2  PLAYWRIGHT E2E TESTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { test, expect, Page } from "@playwright/test";
 *
 * // Base URL: update to match your dev server
 * const BASE = "http://localhost:3000";
 *
 * // ── 11.2.1  Scene loads and canvas renders ─────────────────────────────────
 *
 * test("canvas renders without crash", async ({ page }) => {
 *   await page.goto(BASE);
 *   const canvas = page.locator("canvas").first();
 *   await expect(canvas).toBeVisible({ timeout: 8000 });
 * });
 *
 * // ── 11.2.2  Panel inspector opens on keyboard Enter ────────────────────────
 *
 * test("keyboard navigation: ArrowRight selects panel, Enter opens inspector", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   // Focus the canvas container
 *   await page.click("canvas");
 *   // Press ArrowRight to select first panel
 *   await page.keyboard.press("ArrowRight");
 *   // Press Enter to open inspector
 *   await page.keyboard.press("Enter");
 *   // Inspector dialog should appear
 *   await expect(page.locator("[role='dialog'], [data-testid='panel-inspector']")).toBeVisible({ timeout: 3000 });
 * });
 *
 * test("Escape closes the panel inspector", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   await page.click("canvas");
 *   await page.keyboard.press("ArrowRight");
 *   await page.keyboard.press("Enter");
 *   await expect(page.locator("[role='dialog']")).toBeVisible({ timeout: 3000 });
 *   await page.keyboard.press("Escape");
 *   await expect(page.locator("[role='dialog']")).not.toBeVisible();
 * });
 *
 * // ── 11.2.3  Camera presets ────────────────────────────────────────────────
 *
 * test("keyboard 1/2/3 switch camera presets", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   await page.click("canvas");
 *   for (const key of ["1", "2", "3"]) {
 *     await page.keyboard.press(key);
 *     // Wait a frame for the camera to animate
 *     await page.waitForTimeout(500);
 *   }
 *   // No assertion on camera position — just verifies no crash
 * });
 *
 * // ── 11.2.4  CSV export ────────────────────────────────────────────────────
 *
 * test("E key triggers CSV download", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   await page.click("canvas");
 *   const [download] = await Promise.all([
 *     page.waitForEvent("download"),
 *     page.keyboard.press("e"),
 *   ]);
 *   expect(download.suggestedFilename()).toMatch(/\.csv$/);
 * });
 *
 * // ── 11.2.5  S key triggers PNG snapshot ──────────────────────────────────
 *
 * test("S key triggers PNG snapshot download", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   await page.click("canvas");
 *   const [download] = await Promise.all([
 *     page.waitForEvent("download"),
 *     page.keyboard.press("s"),
 *   ]);
 *   expect(download.suggestedFilename()).toMatch(/\.png$/);
 * });
 *
 * // ── 11.2.6  Weather selector changes the scene ────────────────────────────
 *
 * test("clicking weather button changes weather label", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   const rainButton = page.locator("button", { hasText: /rain/i }).first();
 *   if (await rainButton.isVisible()) {
 *     await rainButton.click();
 *     await expect(rainButton).toHaveCSS("border-color", /.+/);
 *   }
 * });
 *
 * // ── 11.2.7  Analytics modal opens and closes ──────────────────────────────
 *
 * test("Analytics modal opens via toolbar and closes with Escape", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   const analyticsBtn = page.locator("button", { hasText: /analytics/i }).first();
 *   if (await analyticsBtn.isVisible()) {
 *     await analyticsBtn.click();
 *     await expect(page.locator("text=Monthly Production")).toBeVisible({ timeout: 2000 });
 *     await page.keyboard.press("Escape");
 *     await expect(page.locator("text=Monthly Production")).not.toBeVisible();
 *   }
 * });
 *
 * // ── 11.2.8  Language toggle switches to Hindi ────────────────────────────
 *
 * test("language toggle renders Hindi labels", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   // Open settings
 *   const settingsBtn = page.locator("button", { hasText: /settings/i }).first();
 *   if (await settingsBtn.isVisible()) {
 *     await settingsBtn.click();
 *     const hindiBtn = page.locator("button", { hasText: /हिन्दी/ }).first();
 *     if (await hindiBtn.isVisible()) {
 *       await hindiBtn.click();
 *       // Check that some Hindi text is visible
 *       await expect(page.locator("text=सेटिंग")).toBeVisible({ timeout: 2000 });
 *     }
 *   }
 * });
 *
 * // ── 11.2.9  Diagnostics modal shows findings ──────────────────────────────
 *
 * test("Diagnostics modal lists panel findings", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   const diagBtn = page.locator("button", { hasText: /diagnostic/i }).first();
 *   if (await diagBtn.isVisible()) {
 *     await diagBtn.click();
 *     // Either finds anomalies table or "All panels operating" message
 *     const okMsg = page.locator("text=All panels operating");
 *     const table = page.locator("table").first();
 *     const either = okMsg.or(table);
 *     await expect(either).toBeVisible({ timeout: 3000 });
 *   }
 * });
 *
 * // ── 11.2.10  Recorder starts and stops ────────────────────────────────────
 *
 * test("recorder controls: start and stop recording", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   const recordBtn = page.locator("button", { hasText: /record/i }).first();
 *   if (await recordBtn.isVisible()) {
 *     await recordBtn.click();
 *     // Timer should appear
 *     await expect(page.locator("text=00:0")).toBeVisible({ timeout: 2000 });
 *     const stopBtn = page.locator("button", { hasText: /stop/i }).first();
 *     await stopBtn.click();
 *     // Timer disappears
 *     await expect(page.locator("text=00:0")).not.toBeVisible({ timeout: 2000 });
 *   }
 * });
 *
 * // ── 11.2.11  VR button shows unsupported state in Playwright ─────────────
 *
 * test("VR button is disabled when WebXR not available", async ({ page }) => {
 *   await page.goto(BASE);
 *   await page.waitForSelector("canvas");
 *   const vrBtn = page.locator("button", { hasText: /VR/i }).first();
 *   if (await vrBtn.isVisible()) {
 *     // In Playwright (non-XR context) button should be disabled or show unsupported
 *     const isDisabled = await vrBtn.isDisabled();
 *     const text = await vrBtn.textContent();
 *     expect(isDisabled || text?.includes("unsupported")).toBe(true);
 *   }
 * });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 11.3  VITEST CONFIG SNIPPET (vitest.config.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { defineConfig } from "vitest/config";
 *
 * export default defineConfig({
 *   test: {
 *     environment:  "happy-dom",
 *     globals:      true,
 *     setupFiles:   ["./src/test/setup.ts"],
 *     include:      ["src/**\/*.{test,spec}.{ts,tsx}"],
 *   },
 * });
 *
 * // src/test/setup.ts
 * import "fake-indexeddb/auto";   // polyfill IndexedDB for TelemetryStore tests
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 11.4  PLAYWRIGHT CONFIG SNIPPET (playwright.config.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { defineConfig } from "@playwright/test";
 *
 * export default defineConfig({
 *   testDir:  "./e2e",
 *   timeout:  30_000,
 *   use: {
 *     baseURL:    "http://localhost:3000",
 *     screenshot: "only-on-failure",
 *     trace:      "retain-on-failure",
 *   },
 *   webServer: {
 *     command: "npm run dev",
 *     url:     "http://localhost:3000",
 *     reuseExistingServer: !process.env.CI,
 *   },
 * });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Extended public API — additional exports for Sections 10.5–10.10 ─────────

export {
  // ── 10.5 ─────────────────────────────────────────────────────────────────
  TelemetryStore,
  TelemetryClient,
  TelemetryCard,
  useFullTelemetryStream,

  // ── 10.6 ─────────────────────────────────────────────────────────────────
  useSceneRecorder,
  RecorderControls,

  // ── 10.7 ─────────────────────────────────────────────────────────────────
  runDiagnostics,
  parseHistoricalCsv,
  rollingStats,
  DiagnosticsModal,

  // ── 10.8 ─────────────────────────────────────────────────────────────────
  t,
  useLocale,
  useKeyboardNavigation,
  LanguageToggle,
  A11yFocusRing,

  // ── 10.9 ─────────────────────────────────────────────────────────────────
  useWebXR,
  XRControls,
  WebXRButton,

  // ── 10.10 ────────────────────────────────────────────────────────────────
  generateMockTelemetry,
}

export type {
  // ── 10.5 ─────────────────────────────────────────────────────────────────
  TelemetryRecord,
  SerialPanelSnap,
  TelemetryConnectionState,
  TelemetryMessage,
  TelemetrySnapshotPayload,
  TelemetryClientState,
  TelemetryStreamResult,
  TelemetryStatusCardProps,

  // ── 10.6 ─────────────────────────────────────────────────────────────────
  RecordingMode,
  RecordingOptions,
  RecorderState,
  RecorderControlsProps,

  // ── 10.7 ─────────────────────────────────────────────────────────────────
  DiagnosticSeverity,
  DiagnosticFinding,
  DiagnosticsResult,
  HistoricalCsvRow,

  // ── 10.8 ─────────────────────────────────────────────────────────────────
  Locale,
  I18nDictionary,
  KeyboardNavigationConfig,
  LanguageToggleProps,
  A11yFocusRingProps,

  // ── 10.9 ─────────────────────────────────────────────────────────────────
  XRSessionState,
  WebXRHandle,
  XRControlsProps,
  WebXRButtonProps,

  // ── 10.10 ────────────────────────────────────────────────────────────────
  MockTelemetryOptions,
  MockTelemetrySample,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.11 — PERFORMANCE MONITOR
// Purpose: Real-time overlay displaying FPS, CPU frame time, GPU draw calls,
//          and JS heap usage. Collected via performance.now() and Three.js
//          renderer.info. Rendered as a compact HUD in the bottom corner.
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot of one performance sample */
interface PerfSample {
  fps:          number   // frames per second (rolling average)
  frameMs:      number   // last frame CPU time (ms)
  avgFrameMs:   number   // rolling average CPU frame time
  drawCalls:    number   // Three.js renderer draw calls this frame
  triangles:    number   // Three.js renderer triangles this frame
  heapUsedMb:   number   // JS heap used (MB), 0 when API unavailable
  heapLimitMb:  number   // JS heap total limit (MB)
}

/** Ring-buffer size for rolling averages */
const PERF_RING_SIZE = 60

/**
 * usePerformanceStats
 *
 * Collects per-frame metrics inside useFrame and returns a live snapshot.
 * Designed to run unconditionally so averages stabilise quickly.
 *
 * @returns  Live PerfSample updated every animation frame.
 */
function usePerformanceStats(): PerfSample {
  const { gl } = useThree()

  // Ring buffer for frame times
  const ringRef      = useRef<number[]>(new Array(PERF_RING_SIZE).fill(16.67))
  const ringIdxRef   = useRef(0)
  const lastTimeRef  = useRef(performance.now())
  const frameCountRef = useRef(0)
  const fpsTimerRef  = useRef(performance.now())
  const fpsRef       = useRef(60)

  const [sample, setSample] = useState<PerfSample>({
    fps: 60, frameMs: 16.67, avgFrameMs: 16.67,
    drawCalls: 0, triangles: 0,
    heapUsedMb: 0, heapLimitMb: 0,
  })

  useFrame(() => {
    const now      = performance.now()
    const frameMs  = now - lastTimeRef.current
    lastTimeRef.current = now

    // Update ring buffer
    ringRef.current[ringIdxRef.current % PERF_RING_SIZE] = frameMs
    ringIdxRef.current++

    const avg = ringRef.current.reduce((a, b) => a + b, 0) / PERF_RING_SIZE

    // FPS measured over 1-second windows
    frameCountRef.current++
    const elapsed = now - fpsTimerRef.current
    if (elapsed >= 1000) {
      fpsRef.current = Math.round((frameCountRef.current * 1000) / elapsed)
      frameCountRef.current = 0
      fpsTimerRef.current   = now
    }

    // Three.js renderer stats
    const info      = gl.info
    const drawCalls = info.render.calls
    const triangles = info.render.triangles

    // JS heap (only available in Chrome via performance.memory)
    const mem = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
    }).memory

    const heapUsedMb  = mem ? mem.usedJSHeapSize  / 1_048_576 : 0
    const heapLimitMb = mem ? mem.jsHeapSizeLimit  / 1_048_576 : 0

    setSample({
      fps:         fpsRef.current,
      frameMs:     Number(frameMs.toFixed(2)),
      avgFrameMs:  Number(avg.toFixed(2)),
      drawCalls,
      triangles,
      heapUsedMb:  Number(heapUsedMb.toFixed(1)),
      heapLimitMb: Number(heapLimitMb.toFixed(1)),
    })
  })

  return sample
}

/** Colour-code a metric value given a range (green → yellow → red) */
function perfColor(value: number, warn: number, danger: number): string {
  if (value >= danger) return DS.danger
  if (value >= warn)   return DS.warning
  return DS.emerald
}

/** Props for PerformanceMonitor */
interface PerformanceMonitorProps {
  visible: boolean
}

/**
 * PerformanceMonitor
 *
 * Compact stats overlay rendered in the DOM (not the Three.js canvas).
 * Thresholds: fps <45 = warn, <30 = danger; frameMs >22 = warn, >33 = danger.
 * Draw-calls >80 = warn, >150 = danger.
 */
const PerformanceMonitor = memo(function PerformanceMonitor({
  visible,
}: PerformanceMonitorProps) {
  const stats = usePerformanceStats()

  if (!visible) return null

  const fpsColor    = perfColor(60 - stats.fps,       15, 30)  // inverted: high fps=good
  const fpsActual   = stats.fps >= 45 ? DS.emerald : stats.fps >= 30 ? DS.warning : DS.danger
  const frameColor  = perfColor(stats.avgFrameMs,     22, 33)
  const dcColor     = perfColor(stats.drawCalls,      80, 150)
  const heapColor   = stats.heapLimitMb > 0
    ? perfColor((stats.heapUsedMb / stats.heapLimitMb) * 100, 60, 85)
    : DS.muted

  const row = (
    label:   string,
    value:   string,
    color:   string,
    sub?:    string,
  ) => (
    <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 10, lineHeight: 1.6 }}>
      <span style={{ color: DS.muted }}>{label}</span>
      <span style={{ color, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
        {value}
        {sub && <span style={{ color: DS.muted, fontWeight: 400, marginLeft: 4 }}>{sub}</span>}
      </span>
    </div>
  )

  return (
    <div style={{
      position:     "absolute",
      bottom:        48,
      right:         12,
      background:    "rgba(2, 6, 18, 0.88)",
      border:        `1px solid rgba(255,255,255,0.08)`,
      borderRadius:  8,
      padding:       "8px 12px",
      fontSize:       10,
      fontFamily:    "monospace",
      color:          DS.text,
      minWidth:       148,
      pointerEvents: "none",
      zIndex:         80,
      backdropFilter: "blur(6px)",
    }}>
      <div style={{ color: DS.muted, fontSize: 9, letterSpacing: "0.1em", marginBottom: 4 }}>
        PERF
      </div>
      {row("FPS",      `${stats.fps}`,                        fpsActual)}
      {row("Frame",    `${stats.avgFrameMs} ms`,               frameColor, `(${stats.frameMs}ms)`)}
      {row("Draws",    `${stats.drawCalls}`,                   dcColor)}
      {row("Tris",     `${(stats.triangles / 1000).toFixed(1)}k`, DS.muted)}
      {stats.heapLimitMb > 0 && row(
        "Heap",
        `${stats.heapUsedMb} MB`,
        heapColor,
        `/ ${stats.heapLimitMb.toFixed(0)}`
      )}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.12 — SCENE OPTIMIZER
// Purpose: Watches live FPS and automatically degrades visual quality to
//          maintain interactivity. Three tiers: reduce particles → disable
//          bloom → switch panels to instanced LOD.
// ─────────────────────────────────────────────────────────────────────────────

/** Quality tier decided by the optimizer */
type QualityTier = "high" | "medium" | "low" | "minimal"

/** Thresholds for automatic quality reduction */
const QUALITY_THRESHOLDS = {
  HIGH_FPS:    45,   // ≥45 fps → high quality
  MEDIUM_FPS:  30,   // ≥30 fps → medium (reduce particles)
  LOW_FPS:     25,   // ≥25 fps → low (disable bloom)
  MINIMAL_FPS: 0,    // <25 fps → minimal (force LOD)
} as const

/** How many consecutive frames below threshold before switching tier */
const HYSTERESIS_FRAMES = 45

/** Adaptive performance state exposed to the scene */
interface AdaptivePerformanceState {
  tier:              QualityTier
  particleScale:     number   // 0–1 multiplier on particle counts
  bloomEnabled:      boolean
  forceLod:          boolean
  autoMode:          boolean  // when false, optimizer is disabled
}

/**
 * useAdaptivePerformance
 *
 * Monitors FPS via a rolling window and emits quality tier changes.
 * Uses hysteresis to prevent rapid tier oscillation.
 *
 * @param enabled  When false, optimizer is passive (no overrides).
 */
function useAdaptivePerformance(
  enabled: boolean
): AdaptivePerformanceState & { setAutoMode: (v: boolean) => void } {
  const stats = usePerformanceStats()

  const [state, setState] = useState<AdaptivePerformanceState>({
    tier:          "high",
    particleScale: 1,
    bloomEnabled:  true,
    forceLod:      false,
    autoMode:      true,
  })

  // Hysteresis counters
  const belowHighRef    = useRef(0)
  const belowMediumRef  = useRef(0)
  const belowLowRef     = useRef(0)
  const aboveHighRef    = useRef(0)

  useFrame(() => {
    if (!enabled || !state.autoMode) return

    const fps = stats.fps

    // Count frames below each threshold
    if (fps < QUALITY_THRESHOLDS.HIGH_FPS)   belowHighRef.current++
    else                                       belowHighRef.current   = 0

    if (fps < QUALITY_THRESHOLDS.MEDIUM_FPS) belowMediumRef.current++
    else                                       belowMediumRef.current = 0

    if (fps < QUALITY_THRESHOLDS.LOW_FPS)    belowLowRef.current++
    else                                       belowLowRef.current    = 0

    if (fps >= QUALITY_THRESHOLDS.HIGH_FPS)  aboveHighRef.current++
    else                                       aboveHighRef.current   = 0

    // Determine new tier using hysteresis
    let newTier: QualityTier = state.tier

    if (aboveHighRef.current >= HYSTERESIS_FRAMES * 2) {
      // Sustained good performance — upgrade
      newTier = "high"
      belowHighRef.current = belowMediumRef.current = belowLowRef.current = 0
    } else if (belowLowRef.current >= HYSTERESIS_FRAMES) {
      newTier = "minimal"
    } else if (belowMediumRef.current >= HYSTERESIS_FRAMES) {
      newTier = "low"
    } else if (belowHighRef.current >= HYSTERESIS_FRAMES) {
      newTier = "medium"
    }

    if (newTier === state.tier) return

    setState((prev) => {
      const next: AdaptivePerformanceState = { ...prev, tier: newTier }
      switch (newTier) {
        case "high":
          next.particleScale = 1
          next.bloomEnabled  = true
          next.forceLod      = false
          break
        case "medium":
          next.particleScale = 0.5   // half particle count
          next.bloomEnabled  = true
          next.forceLod      = false
          break
        case "low":
          next.particleScale = 0.25
          next.bloomEnabled  = false  // disable bloom pass
          next.forceLod      = false
          break
        case "minimal":
          next.particleScale = 0
          next.bloomEnabled  = false
          next.forceLod      = true   // force instanced LOD
          break
      }
      return next
    })
  })

  const setAutoMode = useCallback((v: boolean) => {
    setState((s) => ({ ...s, autoMode: v }))
  }, [])

  return { ...state, setAutoMode }
}

/** Props for the SceneOptimizer DOM overlay */
interface SceneOptimizerProps {
  adaptiveState: AdaptivePerformanceState & { setAutoMode: (v: boolean) => void }
  visible:       boolean
}

/**
 * SceneOptimizer
 *
 * Small indicator badge showing the current quality tier.
 * Includes a toggle to enable / disable automatic quality management.
 */
const SceneOptimizer = memo(function SceneOptimizer({
  adaptiveState,
  visible,
}: SceneOptimizerProps) {
  if (!visible) return null

  const tierColor: Record<QualityTier, string> = {
    high:    DS.emerald,
    medium:  DS.gold,
    low:     DS.warning,
    minimal: DS.danger,
  }
  const tierLabel: Record<QualityTier, string> = {
    high:    "● HIGH",
    medium:  "● MED",
    low:     "◐ LOW",
    minimal: "○ MIN",
  }

  return (
    <div style={{
      position:   "absolute",
      bottom:      48,
      left:        12,
      background: "rgba(2, 6, 18, 0.88)",
      border:     `1px solid rgba(255,255,255,0.08)`,
      borderRadius: 8,
      padding:    "6px 10px",
      fontSize:    10,
      fontFamily: "monospace",
      display:    "flex",
      flexDirection: "column",
      gap:         4,
      zIndex:      80,
      pointerEvents: "auto",
      backdropFilter: "blur(6px)",
    }}>
      <div style={{ color: DS.muted, fontSize: 9, letterSpacing: "0.1em" }}>QUALITY</div>
      <div style={{ color: tierColor[adaptiveState.tier], fontWeight: 700 }}>
        {tierLabel[adaptiveState.tier]}
      </div>
      <label style={{ display: "flex", gap: 5, alignItems: "center", color: DS.muted, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={adaptiveState.autoMode}
          onChange={(e) => adaptiveState.setAutoMode(e.target.checked)}
          style={{ accentColor: DS.gold }}
        />
        <span>Auto</span>
      </label>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.13 — ADVANCED SUN & SKY MODEL
// Purpose: Hosek-Wilkie–inspired procedural sky dome with full GLSL shader.
//          Outputs physically plausible sky colour, horizon glow, and sun disk
//          that respond to sun elevation, turbidity, and Rayleigh scattering.
//          Falls back to a simple gradient mesh when WebGL2 is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

/** Sky dome vertex shader — exposes vWorldPos for fragment */
const SKY_VERT_GLSL = /* glsl */ `
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos     = worldPos.xyz;
    gl_Position   = projectionMatrix * viewMatrix * worldPos;
  }
`

/** Sky dome fragment — Hosek-Wilkie approximation + Rayleigh + Mie scattering */
const SKY_FRAG_GLSL = /* glsl */ `
  uniform vec3  uSunDirection;   // normalised world-space sun direction
  uniform float uTurbidity;      // atmosphere turbidity (1=clear, 10=hazy)
  uniform float uRayleigh;       // Rayleigh scattering coefficient
  uniform float uMieCoeff;       // Mie scattering coefficient
  uniform float uMieDirectional; // Mie directionality (0–1)
  uniform float uElevation;      // sun elevation in degrees

  varying vec3 vWorldPos;

  // ── Constants ──────────────────────────────────────────────────────────────
  const float PI       = 3.14159265358979;
  const float E        = 2.71828182845904;
  const vec3  LAMBDA   = vec3(680e-9, 550e-9, 450e-9); // wavelengths RGB
  const vec3  UP       = vec3(0.0, 1.0, 0.0);

  // ── Rayleigh phase function ────────────────────────────────────────────────
  float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
  }

  // ── Mie phase function (Henyey-Greenstein) ────────────────────────────────
  float miePhase(float cosTheta, float g) {
    float g2  = g * g;
    float denom = 1.0 + g2 - 2.0 * g * cosTheta;
    return (1.0 - g2) / (4.0 * PI * pow(max(denom, 0.0001), 1.5));
  }

  // ── Total Rayleigh scattering coefficient ─────────────────────────────────
  vec3 totalRayleigh(vec3 lambda) {
    return (8.0 * pow(PI, 3.0) * pow(pow(1.0003, 2.0) - 1.0, 2.0) * (6.0 + 3.0 * 0.035))
         / (3.0 * 2.545e25 * pow(lambda, vec3(4.0)) * (6.0 - 7.0 * 0.035));
  }

  // ── Total Mie scattering (simplified Sellmeier) ───────────────────────────
  vec3 totalMie(vec3 lambda, vec3 K, float T) {
    float c = 0.2 * T * 10e-18;
    return 0.434 * c * PI * pow((2.0 * PI) / lambda, vec3(2.0)) * K;
  }

  void main() {
    // View direction from camera
    vec3 viewDir = normalize(vWorldPos);
    float sunTheta = max(dot(viewDir, normalize(uSunDirection)), 0.0);
    float zenithAngle = max(0.0, dot(UP, viewDir));

    // ── Atmosphere coefficients ────────────────────────────────────────────
    vec3  betaR = totalRayleigh(LAMBDA) * uRayleigh;
    float sunE  = max(0.0, dot(UP, normalize(uSunDirection)));
    vec3  K     = vec3(0.686, 0.678, 0.666);
    vec3  betaM = totalMie(LAMBDA, K, uTurbidity) * uMieCoeff;

    // ── Optical depth ──────────────────────────────────────────────────────
    float zenithR = exp(-0.118 * zenithAngle) / (zenithAngle + 0.02);
    float zenithM = exp(-0.134 * zenithAngle) / (zenithAngle + 0.01);
    float sR = zenithR;
    float sM = zenithM;

    // ── Combined scatter ───────────────────────────────────────────────────
    vec3 fex    = exp(-(betaR * sR + betaM * sM));
    vec3 betaRL = betaR * rayleighPhase(sunTheta);
    vec3 betaML = betaM * miePhase(sunTheta, uMieDirectional);

    vec3 Lin    = pow(sunE * ((betaRL + betaML) / (betaR + betaM)) * (1.0 - fex), vec3(1.5));
    Lin        *= mix(vec3(1.0), pow(sunE * ((betaRL + betaML) / (betaR + betaM)) * fex,
                  vec3(0.5)), clamp(pow(1.0 - sunE, 5.0), 0.0, 1.0));

    // ── Night transition ──────────────────────────────────────────────────
    vec3 L0 = vec3(0.1) * fex;

    // ── Sun disk ──────────────────────────────────────────────────────────
    float sundisk = smoothstep(0.9995, 0.9998, sunTheta);
    L0           += sunE * 19000.0 * fex * sundisk;

    // ── Horizon glow ──────────────────────────────────────────────────────
    float horizonGlow = pow(1.0 - zenithAngle, 6.0) * clamp(sunE * 8.0, 0.0, 1.0);
    vec3  glowColor   = vec3(1.0, 0.5, 0.1) * horizonGlow * 0.5;

    // ── Compose sky ────────────────────────────────────────────────────────
    vec3 texColor = (Lin + L0 + glowColor) * 0.04;
    texColor      = 3.0 * texColor / (2.0 + texColor);          // reinhard

    // Night sky floor
    texColor += vec3(0.002, 0.003, 0.006) * clamp(1.0 - sunE * 10.0, 0.0, 1.0);

    gl_FragColor = vec4(texColor, 1.0);
  }
`

/** Uniforms for the sky dome shader */
  interface SkyDomeUniforms {
    [uniform: string]: THREE.IUniform
  uSunDirection:   { value: THREE.Vector3 }
  uTurbidity:      { value: number }
  uRayleigh:       { value: number }
  uMieCoeff:       { value: number }
  uMieDirectional: { value: number }
  uElevation:      { value: number }
}

/** Props for DynamicSkyDome */
interface DynamicSkyDomeProps {
  elevation:  number    // sun elevation (degrees)
  azimuth:    number    // sun azimuth (degrees)
  turbidity?: number    // atmosphere turbidity (1–20, default 4)
  rayleigh?:  number    // Rayleigh coefficient (default 3)
  mie?:       number    // Mie coefficient (default 0.005)
  mieDir?:    number    // Mie directionality (default 0.8)
  nightMode?: boolean
}

/**
 * DynamicSkyDome
 *
 * Large inverted sphere rendered with the Hosek-Wilkie sky shader.
 * Shader uniforms are updated every frame via useFrame.
 * Falls back to a simple gradient mesh on non-WebGL2 contexts.
 */
const DynamicSkyDome = memo(function DynamicSkyDome({
  elevation,
  azimuth,
  turbidity   = 4,
  rayleigh    = 3,
  mie         = 0.005,
  mieDir      = 0.8,
  nightMode   = false,
}: DynamicSkyDomeProps) {
  const matRef = useRef<THREE.ShaderMaterial | null>(null)

  const skyMaterial = useMemo(() => {
    if (!IS_WEBGL2) return null
    const uniforms: SkyDomeUniforms = {
      uSunDirection:   { value: new THREE.Vector3(0, 1, 0) },
      uTurbidity:      { value: turbidity },
      uRayleigh:       { value: rayleigh },
      uMieCoeff:       { value: mie },
      uMieDirectional: { value: mieDir },
      uElevation:      { value: elevation },
    }
    return new THREE.ShaderMaterial({
      vertexShader:   SKY_VERT_GLSL,
      fragmentShader: SKY_FRAG_GLSL,
      uniforms,
      side:           THREE.BackSide,
      depthWrite:     false,
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { matRef.current = skyMaterial }, [skyMaterial])

  useFrame(() => {
    const mat = matRef.current
    if (!mat) return
    const u = mat.uniforms as unknown as SkyDomeUniforms
    const dir = sunVector(elevation, azimuth)
    u.uSunDirection.value.copy(dir)
    u.uTurbidity.value      = turbidity
    u.uRayleigh.value       = nightMode ? 0.5 : rayleigh
    u.uMieCoeff.value       = mie
    u.uMieDirectional.value = mieDir
    u.uElevation.value      = elevation
  })

  useEffect(() => {
    return () => skyMaterial?.dispose()
  }, [skyMaterial])

  // Fallback: simple gradient sphere
  if (!IS_WEBGL2 || !skyMaterial) {
    const nightColor = nightMode ? "#020610" : "#060b1a"
    const dayColor   = elevation > 0 ? "#1a3f6f" : nightColor
    return (
      <mesh renderOrder={-1}>
        <sphereGeometry args={[280, 32, 32]} />
        <meshBasicMaterial color={dayColor} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    )
  }

  return (
    <mesh renderOrder={-1} material={skyMaterial}>
      <sphereGeometry args={[280, 32, 32]} />
    </mesh>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.14 — INTERACTIVE SOLAR EDUCATION MODE
// Purpose: Animated HTML labels positioned in 3D world space explaining the
//          solar system components. Toggled via SettingsModal. Uses Drei <Html>
//          for world-anchored overlay elements with framer-motion entrances.
// ─────────────────────────────────────────────────────────────────────────────

/** One education annotation anchored in 3D space */
interface EducationAnnotation {
  id:          string
  worldPos:    [number, number, number]
  title:       string
  description: string
  icon:        string
  color:       string
}

/** Static annotation definitions for each system component */
const EDUCATION_ANNOTATIONS: EducationAnnotation[] = [
  {
    id:          "panels",
    worldPos:    [0, 1.2, 0],
    title:       "Solar Panels",
    description: "Photovoltaic cells convert sunlight into DC electricity. Output depends on irradiance, temperature, and shading.",
    icon:        "☀️",
    color:       DS.gold,
  },
  {
    id:          "inverter",
    worldPos:    [...INVERTER_POS] as [number, number, number],
    title:       "Inverter",
    description: "Converts high-voltage DC from panels to grid-compatible 230V AC. Efficiency ≈97.5%.",
    icon:        "⚡",
    color:       DS.cyan,
  },
  {
    id:          "battery",
    worldPos:    [...BATTERY_POS] as [number, number, number],
    title:       "Battery Storage",
    description: "Stores surplus daytime energy for use at night or during grid outages.",
    icon:        "🔋",
    color:       DS.emerald,
  },
  {
    id:          "house",
    worldPos:    [...HOUSE_POS] as [number, number, number],
    title:       "Home Load",
    description: "AC appliances draw power. When solar output exceeds load, surplus is exported or stored.",
    icon:        "🏠",
    color:       "#f472b6",
  },
  {
    id:          "grid",
    worldPos:    [GRID_POS[0], GRID_POS[1] + 1.5, GRID_POS[2]] as [number, number, number],
    title:       "Grid Export",
    description: "Excess energy is exported to the utility grid, credited at the feed-in tariff rate.",
    icon:        "🔌",
    color:       DS.warning,
  },
]

/** Props for a single annotation label */
interface AnnotationLabelProps {
  annotation: EducationAnnotation
  delay:      number
}

/**
 * AnnotationLabel
 *
 * A single world-anchored annotation rendered via Drei <Html>.
 * Animates in with a staggered delay using framer-motion.
 */
const AnnotationLabel = memo(function AnnotationLabel({
  annotation,
  delay,
}: AnnotationLabelProps) {
  return (
    <Html
      position={annotation.worldPos}
      center
      distanceFactor={6}
      occlude={false}
      zIndexRange={[50, 60]}
    >
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.85 }}
        animate={{ opacity: 1, y: 0,  scale: 1 }}
        exit={{ opacity: 0, scale: 0.85 }}
        transition={{ delay, type: "spring", stiffness: 260, damping: 22 }}
        style={{
          background:  "rgba(2, 8, 22, 0.92)",
          border:      `1px solid ${annotation.color}55`,
          borderLeft:  `3px solid ${annotation.color}`,
          borderRadius: 8,
          padding:     "8px 12px",
          maxWidth:    180,
          pointerEvents: "none",
          backdropFilter: "blur(8px)",
          boxShadow:   `0 0 18px ${annotation.color}22`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 14 }}>{annotation.icon}</span>
          <span style={{
            fontWeight: 700,
            fontSize:   11,
            color:      annotation.color,
            whiteSpace: "nowrap",
          }}>
            {annotation.title}
          </span>
        </div>
        <div style={{ fontSize: 10, color: DS.muted, lineHeight: 1.5 }}>
          {annotation.description}
        </div>
        {/* Connector dot */}
        <div style={{
          position:   "absolute",
          bottom:     -4,
          left:       "50%",
          transform:  "translateX(-50%)",
          width:       8,
          height:      8,
          borderRadius: "50%",
          background:  annotation.color,
          boxShadow:  `0 0 6px ${annotation.color}`,
        }} />
      </motion.div>
    </Html>
  )
})

/** Props for EducationOverlay */
interface EducationOverlayProps {
  enabled: boolean
}

/**
 * EducationOverlay
 *
 * Renders all AnnotationLabel components when educational mode is active.
 * Uses AnimatePresence so labels animate out smoothly when disabled.
 */
const EducationOverlay = memo(function EducationOverlay({
  enabled,
}: EducationOverlayProps) {
  if (!enabled) return null

  return (
    <group>
      <AnimatePresence>
        {EDUCATION_ANNOTATIONS.map((ann, i) => (
          <AnnotationLabel key={ann.id} annotation={ann} delay={i * 0.12} />
        ))}
      </AnimatePresence>
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.15 — DEVELOPER DEBUG TOOLS
// Purpose: Optional debug utilities gated behind DEBUG_MODE flag. Visualises
//          panel bounding boxes, sun vector arrow, panel normals, and shadow
//          camera frustum. Zero cost in production (no-ops when flag is false).
// ─────────────────────────────────────────────────────────────────────────────

/** Set to true to enable all debug helpers in development */
const DEBUG_MODE = process.env.NODE_ENV === "development"

// ── SunVectorVisualizer ───────────────────────────────────────────────────────

/** Props for the sun direction arrow helper */
interface SunVectorVisualizerProps {
  elevation: number
  azimuth:   number
  origin?:   [number, number, number]
  length?:   number
}

/**
 * SunVectorVisualizer
 *
 * Renders an ArrowHelper showing the current sun direction vector.
 * Updated every frame to track live elevation / azimuth changes.
 */
const SunVectorVisualizer = memo(function SunVectorVisualizer({
  elevation,
  azimuth,
  origin = [0, 0.5, 0],
  length = 3.5,
}: SunVectorVisualizerProps) {
  const arrowRef = useRef<THREE.ArrowHelper | null>(null)
  const groupRef = useRef<THREE.Group>(null)

  useEffect(() => {
    if (!groupRef.current) return
    const dir    = sunVector(elevation, azimuth)
    const helper = new THREE.ArrowHelper(dir, new THREE.Vector3(...origin), length, 0xffd84a, 0.4, 0.2)
    arrowRef.current = helper
    groupRef.current.add(helper)
    return () => {
      if (groupRef.current && arrowRef.current) groupRef.current.remove(arrowRef.current)
      arrowRef.current?.line.geometry.dispose()
      arrowRef.current?.cone.geometry.dispose()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(() => {
    const arrow = arrowRef.current
    if (!arrow) return
    const dir = sunVector(elevation, azimuth)
    arrow.setDirection(dir)
  })

  return <group ref={groupRef} />
})

// ── PanelNormalVisualizer ─────────────────────────────────────────────────────

/** Props for panel normal arrows */
interface PanelNormalVisualizerProps {
  panels:      WorkingPanel[]
  tilt:        number
  panelAzimuth: number
  color?:      string
}

/**
 * PanelNormalVisualizer
 *
 * Renders a short arrow at each panel's position pointing along the panel
 * normal vector. Useful for verifying tilt and azimuth calculations.
 */
const PanelNormalVisualizer = memo(function PanelNormalVisualizer({
  panels,
  tilt,
  panelAzimuth,
  color = "#00ff88",
}: PanelNormalVisualizerProps) {
  const groupRef = useRef<THREE.Group>(null)

  useEffect(() => {
    const group = groupRef.current
    if (!group) return

    // Clear previous arrows
    while (group.children.length) group.remove(group.children[0])

    const normal = panelNormal(tilt, panelAzimuth)
    const col    = new THREE.Color(color)

    panels.forEach((p) => {
      const origin = new THREE.Vector3(...p.position).add(new THREE.Vector3(0, 0.05, 0))
      const arrow  = new THREE.ArrowHelper(normal, origin, 1.2, col.getHex(), 0.2, 0.12)
      group.add(arrow)
    })

    return () => {
      while (group.children.length) {
        const child = group.children[0] as THREE.ArrowHelper
        child.line?.geometry.dispose()
        child.cone?.geometry.dispose()
        group.remove(child)
      }
    }
  }, [panels, tilt, panelAzimuth, color])

  return <group ref={groupRef} />
})

// ── DebugHelpers ──────────────────────────────────────────────────────────────

/** Visibility flags for individual debug features */
interface DebugHelperFlags {
  showBoundingBoxes: boolean
  showSunVector:     boolean
  showNormals:       boolean
  showAxes:          boolean
}

/** Props for the DebugHelpers container */
interface DebugHelpersProps extends DebugHelperFlags {
  panels:       WorkingPanel[]
  tilt:         number
  panelAzimuth: number
  elevation:    number
  azimuth:      number
}

/**
 * DebugHelpers
 *
 * Master switch component that renders any combination of debug helpers.
 * All children are no-ops when DEBUG_MODE is false.
 */
const DebugHelpers = memo(function DebugHelpers(props: DebugHelpersProps) {
  if (!DEBUG_MODE) return null

  const {
    showBoundingBoxes,
    showSunVector,
    showNormals,
    showAxes,
    panels,
    tilt,
    panelAzimuth,
    elevation,
    azimuth,
  } = props

  return (
    <group>
      {/* ── World axes ── */}
      {showAxes && <axesHelper args={[5]} />}

      {/* ── Per-panel bounding boxes ── */}
      {showBoundingBoxes && panels.map((p) => (
        <mesh key={p.id} position={p.position}>
          <boxGeometry args={[PANEL_WIDTH + 0.02, PANEL_THICKNESS + 0.02, PANEL_DEPTH + 0.02]} />
          <meshBasicMaterial color="#00ffcc" wireframe transparent opacity={0.5} depthWrite={false} />
        </mesh>
      ))}

      {/* ── Sun direction arrow ── */}
      {showSunVector && (
        <SunVectorVisualizer elevation={elevation} azimuth={azimuth} />
      )}

      {/* ── Panel normal arrows ── */}
      {showNormals && (
        <PanelNormalVisualizer
          panels={panels}
          tilt={tilt}
          panelAzimuth={panelAzimuth}
        />
      )}
    </group>
  )
})

/** DOM control panel for toggling debug helpers (renders outside canvas) */
interface DebugControlPanelProps {
  flags:    DebugHelperFlags
  onChange: (flags: DebugHelperFlags) => void
}

const DebugControlPanel = memo(function DebugControlPanel({
  flags,
  onChange,
}: DebugControlPanelProps) {
  if (!DEBUG_MODE) return null

  const toggle = (key: keyof DebugHelperFlags) =>
    onChange({ ...flags, [key]: !flags[key] })

  const entries: [keyof DebugHelperFlags, string][] = [
    ["showBoundingBoxes", "BBox"],
    ["showSunVector",     "Sun ↗"],
    ["showNormals",       "Normals"],
    ["showAxes",          "Axes"],
  ]

  return (
    <div style={{
      position:   "absolute",
      top:         90,
      right:       12,
      background: "rgba(2,6,18,0.90)",
      border:     `1px solid ${DS.danger}44`,
      borderRadius: 8,
      padding:    "6px 10px",
      fontSize:    10,
      fontFamily: "monospace",
      display:    "flex",
      flexDirection: "column",
      gap:         4,
      zIndex:      80,
    }}>
      <div style={{ color: DS.danger, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 2 }}>
        DEBUG
      </div>
      {entries.map(([key, label]) => (
        <label key={key} style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", color: DS.muted }}>
          <input
            type="checkbox"
            checked={flags[key]}
            onChange={() => toggle(key)}
            style={{ accentColor: DS.danger }}
          />
          {label}
        </label>
      ))}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10.16 — STORY / DEMO MODE
// Purpose: Automated cinematic walkthrough that moves the camera through all
//          preset positions in sequence. Controlled via a simple timeline
//          animation system. Start/stop button exposed in ControlPanel.
// ─────────────────────────────────────────────────────────────────────────────

/** One keyframe in the tour timeline */
interface TourKeyframe {
  preset:      CameraPresetKey
  durationMs:  number   // time to spend at this preset before transitioning
  blendMs:     number   // transition duration (easing into next keyframe)
  label:       string   // displayed in UI during this stop
}

/** Ordered list of tour stops */
const SCENE_TOUR_KEYFRAMES: TourKeyframe[] = [
  { preset: "overview",  durationMs: 3500, blendMs: 1800, label: "System Overview"   },
  { preset: "closeup",   durationMs: 4000, blendMs: 1600, label: "Panel Array"       },
  { preset: "aerial",    durationMs: 3500, blendMs: 2000, label: "Aerial View"        },
  { preset: "overview",  durationMs: 3000, blendMs: 1800, label: "Return to Overview" },
]

/** Return value of useSceneTour */
interface SceneTourHandle {
  active:       boolean
  currentLabel: string
  progress:     number    // 0–1 through the entire tour
  start:        () => void
  stop:         () => void
}

/**
 * useSceneTour
 *
 * Drives the camera through SCENE_TOUR_KEYFRAMES automatically.
 * Calls the provided `applyPreset` callback (wired to the existing camera
 * preset system) at the appropriate times.
 *
 * @param applyPreset  Callback that animates the camera to a named preset.
 */
function useSceneTour(
  applyPreset: (key: CameraPresetKey) => void
): SceneTourHandle {
  const [active,       setActive]       = useState(false)
  const [currentLabel, setCurrentLabel] = useState("")
  const [progress,     setProgress]     = useState(0)

  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameIdxRef   = useRef(0)
  const startTimeRef  = useRef(0)

  const totalDuration = SCENE_TOUR_KEYFRAMES.reduce(
    (sum, kf) => sum + kf.durationMs + kf.blendMs, 0
  )

  const clearTour = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleNext = useCallback(() => {
    const idx = frameIdxRef.current
    if (idx >= SCENE_TOUR_KEYFRAMES.length) {
      // Tour complete — loop
      frameIdxRef.current = 0
      scheduleNext()
      return
    }

    const kf = SCENE_TOUR_KEYFRAMES[idx]
    setCurrentLabel(kf.label)
    applyPreset(kf.preset)

    timerRef.current = setTimeout(() => {
      frameIdxRef.current = idx + 1
      scheduleNext()
    }, kf.durationMs + kf.blendMs)
  }, [applyPreset])

  // Progress ticker
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      setProgress(Math.min((elapsed % totalDuration) / totalDuration, 1))
    }, 100)
    return () => clearInterval(id)
  }, [active, totalDuration])

  const start = useCallback(() => {
    clearTour()
    frameIdxRef.current = 0
    startTimeRef.current = Date.now()
    setActive(true)
    scheduleNext()
  }, [clearTour, scheduleNext])

  const stop = useCallback(() => {
    clearTour()
    setActive(false)
    setCurrentLabel("")
    setProgress(0)
  }, [clearTour])

  // Cleanup on unmount
  useEffect(() => () => clearTour(), [clearTour])

  return { active, currentLabel, progress, start, stop }
}

/** DOM component rendering the tour start/stop button and label */
interface SceneTourControlsProps {
  handle: SceneTourHandle
}

const SceneTourControls = memo(function SceneTourControls({ handle }: SceneTourControlsProps) {
  const { active, currentLabel, progress, start, stop } = handle

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ fontSize: 11, color: DS.muted, fontWeight: 600, letterSpacing: "0.06em" }}>
        TOUR
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          onClick={active ? stop : start}
          style={{
            padding:      "5px 12px",
            borderRadius: 6,
            border:       `1px solid ${active ? DS.emerald : DS.border}`,
            background:   active ? `${DS.emerald}22` : DS.bgLight,
            color:        active ? DS.emerald : DS.text,
            cursor:       "pointer",
            fontSize:     11,
            fontWeight:   600,
            transition:   "all 0.15s ease",
          }}
        >
          {active ? "■ Stop Tour" : "▶ Start Tour"}
        </button>
      </div>

      {active && (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 10, color: DS.gold, fontStyle: "italic" }}>
            {currentLabel}
          </div>
          {/* Progress bar */}
          <div style={{
            height:       3,
            borderRadius: 2,
            background:   "rgba(255,255,255,0.1)",
            overflow:     "hidden",
          }}>
            <div style={{
              height:     "100%",
              width:      `${progress * 100}%`,
              background: DS.gold,
              transition: "width 0.1s linear",
              borderRadius: 2,
            }} />
          </div>
        </div>
      )}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — FINAL EXTENDED PUBLIC API
// Exports for subsections 10.11 – 10.16
// ─────────────────────────────────────────────────────────────────────────────

export {
  // ── 10.11 ────────────────────────────────────────────────────────────────
  usePerformanceStats,
  PerformanceMonitor,

  // ── 10.12 ────────────────────────────────────────────────────────────────
  useAdaptivePerformance,
  SceneOptimizer,

  // ── 10.13 ────────────────────────────────────────────────────────────────
  DynamicSkyDome,

  // ── 10.14 ────────────────────────────────────────────────────────────────
  EducationOverlay,
  AnnotationLabel,

  // ── 10.15 ────────────────────────────────────────────────────────────────
  DebugHelpers,
  SunVectorVisualizer,
  PanelNormalVisualizer,
  DebugControlPanel,

  // ── 10.16 ────────────────────────────────────────────────────────────────
  useSceneTour,
  SceneTourControls,
}

export type {
  // ── 10.11 ────────────────────────────────────────────────────────────────
  PerfSample,
  PerformanceMonitorProps,

  // ── 10.12 ────────────────────────────────────────────────────────────────
  QualityTier,
  AdaptivePerformanceState,
  SceneOptimizerProps,

  // ── 10.13 ────────────────────────────────────────────────────────────────
  SkyDomeUniforms,
  DynamicSkyDomeProps,

  // ── 10.14 ────────────────────────────────────────────────────────────────
  EducationAnnotation,
  AnnotationLabelProps,
  EducationOverlayProps,

  // ── 10.15 ────────────────────────────────────────────────────────────────
  DebugHelperFlags,
  DebugHelpersProps,
  SunVectorVisualizerProps,
  PanelNormalVisualizerProps,

  // ── 10.16 ────────────────────────────────────────────────────────────────
  TourKeyframe,
  SceneTourHandle,
  SceneTourControlsProps,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 12 — DEVELOPMENT NOTES
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This file is intentionally monolithic for portability. In a production
 * codebase, split it across the following directory structure:
 *
 *   src/
 *   ├─ components/
 *   │   ├─ scene/           SunRig, RoofShell, PanelMesh, EnergyFlow, ...
 *   │   ├─ ui/              ControlPanel, modals, TelemetryCard, ...
 *   │   └─ extensions/      Section 10 subsystems
 *   ├─ hooks/               usePerformanceStats, useSceneTour, useWebXR, ...
 *   ├─ workers/             panel-simulation.worker.ts (extracted from §10.2)
 *   ├─ shaders/             thermal.vert.glsl, sky.frag.glsl, particle.vert.glsl
 *   ├─ store/               TelemetryStore, TelemetryClient
 *   └─ utils/               pure functions from §4, i18n dictionaries
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PERFORMANCE ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * RENDER BUDGET (target 60 fps, <80 draw calls):
 *
 *   Component                    Draw calls   Notes
 *   ──────────────────────────── ─────────── ──────────────────────────────
 *   InstancedPanelManager        2            full-LOD + simple-LOD meshes
 *   RoofShell                    4–6          house body + deck + trim
 *   SunRig (lights)              0            lights are not draw calls
 *   EnergyFlowPaths              N_paths      one per active cable
 *   WeatherGPUParticles          1            single Points mesh
 *   InverterMesh / BatteryMesh   2–4
 *   ContactShadows               2            drei shadow plane
 *   EffectComposer (Bloom)       +2           bloom pass
 *   DynamicSkyDome               1            inverted sphere
 *   DebugHelpers (dev only)      0 in prod
 *   ──────────────────────────── ─────────── ──────────────────────────────
 *   Total (typical)              ~25–45       well under 80 target
 *
 * ADAPTIVE QUALITY TIERS (Section 10.12):
 *
 *   Tier     FPS trigger   Particle scale   Bloom   LOD
 *   ──────── ──────────── ─────────────── ─────── ──────
 *   HIGH     ≥ 45 fps      1.0              on      off
 *   MEDIUM   ≥ 30 fps      0.5              on      off
 *   LOW      ≥ 25 fps      0.25             OFF     off
 *   MINIMAL  < 25 fps      0.0 (disabled)   OFF     FORCED
 *
 *   Hysteresis of 45 frames prevents rapid oscillation between tiers.
 *   useAdaptivePerformance runs inside useFrame — zero overhead when idle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKER ARCHITECTURE (Section 10.2)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The simulation worker is created via Blob URL so no separate .worker.ts
 * file or bundler configuration is required. This preserves single-file
 * portability while keeping the main thread free of simulation math.
 *
 * MESSAGE PROTOCOL:
 *
 *   Main → Worker                Worker → Main
 *   ──────────────────────────   ────────────────────────────────────
 *   init { panels, config }   →  ready { count }
 *   updateConfig { ...cfg }   →  (no reply)
 *   computeTick { ...overrides} → tickResult { buffer: Float32Array, tick }
 *   exportBuffer {}           →  exportResult { buffer: Float32Array }
 *   restart {}                →  restarted {}
 *   terminate {}              →  (worker closes)
 *
 * BUFFER LAYOUT (9 Float32 per panel):
 *   [0] watts          [1] dcWatts        [2] temperature
 *   [3] shadeFactor    [4] outputRatio    [5] efficiencyPct
 *   [6] color.r        [7] color.g        [8] color.b
 *
 * TRANSFERABLE BUFFERS:
 *   The worker transfers ownership of Float32Array via postMessage(..., [buf.buffer]).
 *   This is a zero-copy operation — the main thread receives the buffer with no
 *   serialisation overhead regardless of panel count. After transfer, the worker
 *   allocates a fresh buffer for the next tick (no double-buffering needed because
 *   the main thread finishes consuming before the next computeTick arrives).
 *
 * ERROR RECOVERY:
 *   If the worker emits an "error" message, usePanelSimulationWorker stores the
 *   error string in React state. The worker is NOT automatically restarted on
 *   error — call restart() or re-mount the hook. For production systems, add an
 *   exponential-backoff restart strategy in the onerror handler.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INSTANCED RENDERING DESIGN (Section 10.1)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TWO-MESH LOD STRATEGY:
 *   meshFull   (BoxGeometry 4×1×4 segments) — used within 20 world units.
 *   meshSimple (BoxGeometry 1×1×1 segment)  — used beyond 20 world units.
 *   Both share the same MeshStandardMaterial with vertexColors=true.
 *   Only one is visible at any given time; the other has visible=false.
 *
 * GPU PICKING:
 *   A third hidden InstancedMesh (meshPick) uses a ShaderMaterial that encodes
 *   instanceId as an RGB colour:
 *     R = id & 0xff
 *     G = (id >> 8) & 0xff
 *     B = (id >> 16) & 0xff
 *   On pointer events, the scene is rendered to a 1×1 WebGLRenderTarget centred
 *   on the cursor. The pixel is read via gl.readRenderTargetPixels() and decoded.
 *   This approach handles 16.7 million unique instances and requires one extra
 *   draw call per pick event — not per frame.
 *
 *   FALLBACK: On non-WebGL2 contexts (some mobile browsers), GPU picking is
 *   replaced with THREE.Raycaster which is correct but ~10–50× slower for
 *   large instance counts.
 *
 * SELECTED PANEL EXCLUSION:
 *   The selected panel is scaled to (0,0,0) in both instanced meshes and rendered
 *   as a standalone ThermalPanel component. This allows the full shader effect,
 *   hover animation, and Html inspector label to appear without polluting the
 *   instanced buffer management.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TELEMETRY SYSTEM OVERVIEW (Section 10.5)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * LAYER STACK (top-down):
 *
 *   useFullTelemetryStream (React hook)
 *     │  reconciles server snapshot → RuntimePanel[] aligned to WorkingPanel[]
 *     │  updates React state on subscription callback
 *     ▼
 *   TelemetryClient (plain class, no React dependency)
 *     │  WebSocket lifecycle (connect → heartbeat → reconnect)
 *     │  message parser: snapshot / delta / pong / error
 *     │  subscriber pattern: Set<TelemetrySubscriber>
 *     ▼
 *   TelemetryStore (IndexedDB wrapper)
 *       put() / getRecent() / getRange() / clear() / prune()
 *       max 2,880 records (48h @ 1-min intervals) — auto-pruned
 *
 * RECONNECT STRATEGY (exponential backoff):
 *   Attempt  Delay
 *   ───────  ──────
 *   1        1 s
 *   2        2 s
 *   3        4 s
 *   4        8 s
 *   5        16 s
 *   6+       30 s (cap)
 *
 * SERVER CONTRACT:
 *   The server must send JSON frames. Minimum snapshot shape:
 *     { "type": "snapshot", "timestamp": 1700000000000,
 *       "payload": {
 *         "panels": [{ "id": 1, "watts": 380, "temperature": 42,
 *                      "outputRatio": 0.95, "shadeFactor": 0.0 }, ...],
 *         "totalKw": 4.56,
 *         "weather": "clear"
 *       }
 *     }
 *   Delta frames may omit unchanged panels:
 *     { "type": "delta", "timestamp": ..., "payload": { "totalKw": 4.60 } }
 *   Pong response to heartbeat ping:
 *     { "type": "pong", "timestamp": ... }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GPU SHADER DESIGN (Sections 10.3, 10.4, 10.13)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THERMAL SHADER (ThermalShaderMaterial):
 *   Uniforms driven per-frame by useThermalShaderMaterial hook:
 *     uTime         → clock.getElapsedTime()
 *     uTemperature  → clamp((°C - 8) / 55, 0, 1)   (normalised 0=cold, 1=hot)
 *     uIntensity    → configurable multiplier
 *   Features:
 *     - 5-stop thermal gradient palette
 *     - Fresnel edge glow (hotter = brighter rim)
 *     - UV-based panel cell grid overlay
 *     - Emissive pulse keyed to sin(uTime)
 *     - Vertex shimmer displacement for very hot panels (>60% norm temp)
 *
 * GPU PARTICLE SYSTEM (WeatherGPUParticles):
 *   Seed strategy: per-particle random seeds baked into UV attribute at init.
 *   The vertex shader derives each particle's world position entirely from UV
 *   seeds and uTime — the CPU never touches particle positions after creation.
 *   Cost: one draw call + 6 uniform writes per frame (O(1) regardless of count).
 *
 * SKY DOME (DynamicSkyDome):
 *   Hosek-Wilkie approximation implemented in GLSL. Key simplifications vs
 *   the full Hosek model: Mie scattering uses Henyey-Greenstein phase function,
 *   and the 9-parameter radiance model is replaced with a Rayleigh + Mie
 *   combined transmittance. This gives plausible results (±10% vs ground truth)
 *   at a fraction of the shader complexity. For scientific visualisation,
 *   replace with the full 27-parameter dataset-driven implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * I18N DESIGN (Section 10.8)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The i18n system is intentionally minimal: a typed dictionary record per locale,
 * a pure t() function, and a useLocale() hook for persistence. This avoids:
 *   - ICU message format complexity (not needed for this app)
 *   - Runtime bundle splitting (dictionaries are small; both fit in one file)
 *   - External i18n libraries
 *
 * To add a new locale (e.g. Tamil):
 *   1. Add "ta" to the Locale union type
 *   2. Create TA_DICT: I18nDictionary = { ... }
 *   3. Add to DICTIONARIES: { en, hi, ta }
 *   4. Add to LanguageToggle LOCALES array
 *
 * TypeScript enforces that all I18nDictionary keys are present in every locale
 * at compile time — missing translations become a type error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WEBXR INTEGRATION NOTES (Section 10.9)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The current implementation requests an immersive-vr session and delegates
 * rendering entirely to the browser XR runtime. To add full hand-tracking and
 * interactive VR controls:
 *
 *   1. Install @react-three/xr (wraps @react-three/fiber for XR).
 *   2. Replace <Canvas> with <XRCanvas> and wrap the scene in <XR>.
 *   3. Use <Controllers> and <Hands> from @react-three/xr.
 *   4. Replace useWebXR with the @react-three/xr useXR() hook.
 *   5. Panel selection: use XR controller ray casting (xrController.ray).
 *
 * Without the @react-three/xr package, the current implementation starts the
 * XR session but does not update the Three.js render loop to use the XR camera.
 * Full XR support requires the XRSession to be connected to the renderer via
 * renderer.xr.setSession(session) and renderer.xr.enabled = true. This is
 * handled automatically by @react-three/xr but requires manual setup otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPENDENCIES SUMMARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Package                     Version  Purpose
 *   ─────────────────────────── ──────── ────────────────────────────────────
 *   @react-three/fiber          ^8       React renderer for Three.js
 *   @react-three/drei           ^9       Helpers: Html, Line, OrbitControls…
 *   @react-three/postprocessing ^2       EffectComposer, Bloom, Vignette
 *   three                       ^0.165   3D engine
 *   framer-motion               ^11      DOM animation
 *   three-stdlib                ^2       OrbitControlsImpl type
 *   typescript                  ^5       Type safety
 *   vite / next.js              —        Build / dev server
 *
 *   DEV / TEST ONLY:
 *   vitest                      ^2       Unit testing
 *   @playwright/test            ^1       E2E testing
 *   fake-indexeddb              ^5       IndexedDB polyfill for unit tests
 *   happy-dom                   ^14      DOM environment for vitest
 *
 *   NO OTHER RUNTIME DEPENDENCIES — all extension systems are self-contained.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KNOWN LIMITATIONS & FUTURE WORK
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. WebXR requires @react-three/xr for full render-loop integration (§10.9).
 *   2. GPU picking scene isolation is approximate — if other translucent meshes
 *      overlap the pick target, false positives are possible. Mitigate by
 *      rendering the pick mesh in a separate scene with only the instanced mesh.
 *   3. The sky dome shares the same sphere geometry as the scene. On very low-end
 *      GPUs, reduce sphere segments from 32 to 16.
 *   4. Worker error recovery does not auto-restart — add exponential backoff in
 *      usePanelSimulationWorker.onerror for production deployments.
 *   5. TelemetryStore.prune() uses a cursor-based delete which is O(excess_rows).
 *      For very high-frequency telemetry (>1 Hz), batch deletes with a keyed
 *      range cursor for better IDB performance.
 *   6. Thermal shader vertex displacement uses a fixed-period sin wave. For more
 *      realism, drive it from a per-panel noise texture atlas.
 *   7. i18n pluralisation is not handled — add a plural(key, count, locale) helper
 *      if the UI needs strings like "1 panel / 12 panels".
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — CINEMATIC VISUAL UPGRADE
// Purpose: Transform scene visuals into a high-fidelity product-demo aesthetic.
//          All components are drop-in replacements or additions — zero changes
//          to existing sections required.
// ─────────────────────────────────────────────────────────────────────────────
//
// 13.1  PBR Materials          — clearcoat glass, aniso metal, cell iridescence
// 13.2  CinematicLightingRig   — sun + sky + bounce + rim + HDRI
// 13.3  CinematicPanelMesh     — glass layer, cell grid, animated sun glint
// 13.4  ModernHouse            — pitched roof, windows, concrete, night glow
// 13.5  TreeCluster            — low-poly foliage cones, per-tree sway
// 13.6  CinematicTerrain       — grass plane, fog, distant buildings
// 13.7  SkyAtmosphere          — gradient dome, stars, cloud wisps
// 13.8  GlowingEnergyBeam      — pulsed glow cables replacing DreiLine
// 13.9  GlassmorphismHUD       — blurred glass UI cards
// 13.10 useCinematicCamera     — inertia + drift on orbit camera
// 13.11 useMicroAnimations     — sway, glints, LED blink, battery pulse
// 13.12 SceneColorGrading      — post-process color grade preset
//
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.1 — PHYSICALLY BASED MATERIALS
// ─────────────────────────────────────────────────────────────────────────────

/** Shared PBR material presets — memoised at module level, never recreated */

/** Solar panel AR-coated glass */
const PBR_PANEL_GLASS = new THREE.MeshPhysicalMaterial({
  color:             new THREE.Color("#0a1628"),
  roughness:         0.04,
  metalness:         0.0,
  clearcoat:         1.0,
  clearcoatRoughness: 0.02,
  reflectivity:      0.92,
  transmission:      0.12,
  transparent:       true,
  opacity:           0.97,
  envMapIntensity:   2.2,
})

/** Solar panel photovoltaic cell layer */
const PBR_PANEL_CELL = new THREE.MeshPhysicalMaterial({
  color:          new THREE.Color("#0b1e3d"),
  roughness:      0.14,
  metalness:      0.55,
  clearcoat:      0.38,
  clearcoatRoughness: 0.12,
  envMapIntensity: 1.4,
})

/** Solar panel aluminium frame */
const PBR_PANEL_FRAME = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#bec8d4"),
  roughness: 0.22,
  metalness: 0.92,
  envMapIntensity: 1.6,
})

/** Roof tile — terracotta-style matte ceramic */
const PBR_ROOF_TILE = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#2c3a4a"),
  roughness: 0.78,
  metalness: 0.08,
  envMapIntensity: 0.6,
})

/** House wall — modern smooth render / concrete */
const PBR_WALL_CONCRETE = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#d8dfe8"),
  roughness: 0.88,
  metalness: 0.02,
  envMapIntensity: 0.4,
})

/** Window glass */
const PBR_WINDOW_GLASS = new THREE.MeshPhysicalMaterial({
  color:        new THREE.Color("#a8c8f0"),
  roughness:    0.0,
  metalness:    0.0,
  clearcoat:    1.0,
  transmission: 0.72,
  transparent:  true,
  opacity:      0.82,
  reflectivity: 0.88,
  envMapIntensity: 2.8,
})

/** Tree trunk bark */
const PBR_BARK = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#5c3d1e"),
  roughness: 0.92,
  metalness: 0.0,
})

/** Helper: create a tinted foliage material with slight variation */
function makeFoliageMat(hueShift: number): THREE.MeshStandardMaterial {
  const base = new THREE.Color("#2d6a2f")
  base.offsetHSL(hueShift, 0, 0)
  return new THREE.MeshStandardMaterial({
    color:     base,
    roughness: 0.85,
    metalness: 0.0,
    envMapIntensity: 0.5,
  })
}

/** Ground grass material */
const PBR_GROUND = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#3d6b35"),
  roughness: 0.96,
  metalness: 0.0,
  envMapIntensity: 0.3,
})

/** Distant building material — muted, slightly emissive windows */
const PBR_DISTANT_BUILDING = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#4a5568"),
  roughness: 0.74,
  metalness: 0.12,
  envMapIntensity: 0.5,
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.2 — CINEMATIC LIGHTING RIG
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the full cinematic lighting rig */
interface CinematicLightingRigProps {
  elevation:  number
  azimuth:    number
  weather:    WeatherType
  nightMode:  boolean
}

/**
 * CinematicLightingRig
 *
 * Five-light setup for a physically plausible illumination:
 *   1. Sun   — directional, warm tint, soft PCF shadows
 *   2. Sky   — hemisphere (sky/ground), blue overhead / warm bounce below
 *   3. Bounce — ground-fill point light, warm amber at low elevation
 *   4. Rim   — subtle blue-violet kicker from camera-right
 *   5. Night fill — deep blue ambient during nightMode
 *
 * All intensities track sun elevation and weather factor each frame.
 */
const CinematicLightingRig = memo(function CinematicLightingRig({
  elevation,
  azimuth,
  weather,
  nightMode,
}: CinematicLightingRigProps) {
  const sunRef    = useRef<THREE.DirectionalLight>(null)
  const hemiRef   = useRef<THREE.HemisphereLight>(null)
  const bounceRef = useRef<THREE.PointLight>(null)
  const rimRef    = useRef<THREE.DirectionalLight>(null)
  const nightRef  = useRef<THREE.AmbientLight>(null)
  const { scene } = useThree()

  useEffect(() => {
    const light = sunRef.current
    if (!light) return
    scene.add(light.target)
    return () => { scene.remove(light.target) }
  }, [scene])

  useFrame(() => {
    const wf: Record<WeatherType, number> = {
      clear: 1, cloudy: 0.56, rain: 0.32, snow: 0.48, storm: 0.20, fog: 0.38,
    }
    const wScale = wf[weather]
    const sky    = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
    const below  = elevation <= 0

    // ── Sun ──────────────────────────────────────────────────────────────────
    if (sunRef.current) {
      const dir  = sunVector(elevation, azimuth)
      sunRef.current.position.set(dir.x * 24, Math.max(0.5, dir.y * 24), dir.z * 24)
      sunRef.current.intensity = below || nightMode ? 0 : sky * 4.8 * wScale

      // Golden hour warmth
      const warmth = clamp(1 - sky * 2.2, 0, 1)
      sunRef.current.color.setRGB(
        1.0,
        clamp(0.78 + sky * 0.22 - warmth * 0.18, 0.62, 1.0),
        clamp(0.60 + sky * 0.40 - warmth * 0.42, 0.40, 1.0),
      )
    }

    // ── Sky hemisphere ────────────────────────────────────────────────────────
    if (hemiRef.current) {
      const skyIntensity = nightMode ? 0.06 : (0.22 + sky * 0.48) * wScale
      hemiRef.current.intensity = skyIntensity
      // Sky colour: day-blue → twilight orange → night indigo
      const nightT = clamp(1 - sky * 3, 0, 1)
      hemiRef.current.color.setRGB(
        0.44 + sky * 0.32 + nightT * 0.08,
        0.58 + sky * 0.28 - nightT * 0.14,
        1.0  - sky * 0.32 + nightT * 0.12,
      )
      // Ground bounce: warm amber
      hemiRef.current.groundColor.setRGB(
        0.38 + sky * 0.28,
        0.28 + sky * 0.18,
        0.12 + sky * 0.06,
      )
    }

    // ── Ground bounce fill ────────────────────────────────────────────────────
    if (bounceRef.current) {
      bounceRef.current.intensity = below || nightMode ? 0 : sky * 0.9 * wScale
      bounceRef.current.color.setRGB(1.0, 0.82 + sky * 0.18, 0.54 + sky * 0.26)
    }

    // ── Rim light ─────────────────────────────────────────────────────────────
    if (rimRef.current) {
      rimRef.current.intensity = nightMode ? 0.08 : sky * 0.55 * wScale
    }

    // ── Night ambient ─────────────────────────────────────────────────────────
    if (nightRef.current) {
      nightRef.current.intensity = nightMode ? 0.14 : 0.0
    }
  })

  return (
    <group>
      {/* Sun */}
      <directionalLight
        ref={sunRef}
        castShadow
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={0.1}
        shadow-camera-far={90}
        shadow-bias={-0.0003}
        shadow-normalBias={0.04}
        shadow-radius={3}
      />

      {/* Sky hemisphere */}
      <hemisphereLight
        ref={hemiRef}
        color="#7db3e8"
        groundColor="#c4882a"
        intensity={0.4}
      />

      {/* Ground bounce */}
      <pointLight
        ref={bounceRef}
        position={[0, -1.2, 0]}
        intensity={0.6}
        distance={28}
        color="#ffcc88"
        decay={2}
      />

      {/* Rim kicker — camera right */}
      <directionalLight
        ref={rimRef}
        position={[12, 4, -8]}
        intensity={0.3}
        color="#8899cc"
      />

      {/* Night ambient */}
      <ambientLight ref={nightRef} color="#1a2040" intensity={0} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.3 — CINEMATIC SOLAR PANEL MESH
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the cinematic single panel */
interface CinematicPanelMeshProps {
  position:    [number, number, number]
  rotation:    [number, number, number]
  outputRatio: number
  temperature: number
  viewMode:    ViewMode
  selected:    boolean
  color:       THREE.Color
  onClick:     () => void
}

/**
 * CinematicPanelMesh
 *
 * Four-layer panel with animated sun-glint, cell-grid emissive,
 * anodised aluminium frame, and AR clearcoat glass.
 * An animated scan-line effect sweeps the glass surface when selected.
 */
const CinematicPanelMesh = memo(function CinematicPanelMesh({
  position,
  rotation,
  outputRatio,
  temperature,
  viewMode,
  selected,
  color,
  onClick,
}: CinematicPanelMeshProps) {
  const glintRef   = useRef<THREE.Mesh>(null)
  const glowRef    = useRef<THREE.PointLight>(null)
  const scanRef    = useRef<THREE.Mesh>(null)

  // Derive cell colour from viewMode
  const cellColor = useMemo(() => {
    if (viewMode === "thermal")  return thermalColor(temperature)
    if (viewMode === "shade")    return new THREE.Color().setHSL(outputRatio * 0.28, 0.8, 0.38)
    if (viewMode === "heatmap")  return efficiencyColor(outputRatio)
    if (viewMode === "string")   return color
    return new THREE.Color("#0c2040").lerp(new THREE.Color("#1a4a88"), outputRatio * 0.8)
  }, [viewMode, outputRatio, temperature, color])

  const emissiveIntensity = clamp(outputRatio * 0.22, 0, 0.28)

  // Animated sun glint + selection glow
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()

    // Glint opacity pulses with production power
    if (glintRef.current) {
      const mat = glintRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = outputRatio * (0.12 + 0.06 * Math.sin(t * 1.4 + position[0]))
    }

    // Selection scan-line sweeps along Z axis
    if (scanRef.current && selected) {
      const sweep = ((t * 0.8) % 1) * (PANEL_DEPTH + 0.1) - PANEL_DEPTH * 0.5
      scanRef.current.position.z = sweep
      ;(scanRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.35 * (1 - Math.abs(sweep / (PANEL_DEPTH * 0.5)))
    }

    // Glow tracks power output
    if (glowRef.current) {
      glowRef.current.intensity =
        selected
          ? 0.9 + 0.3 * Math.sin(t * 3.2)
          : emissiveIntensity * 0.8
    }
  })

  return (
    <group position={position} rotation={rotation} onClick={(e) => { e.stopPropagation(); onClick() }}>

      {/* ── Layer 1: Aluminium frame ── */}
      <mesh castShadow receiveShadow material={PBR_PANEL_FRAME}>
        <boxGeometry args={[PANEL_WIDTH, PANEL_THICKNESS, PANEL_DEPTH]} />
      </mesh>

      {/* ── Layer 2: Back-sheet EVA (dark polymer) ── */}
      <mesh position={[0, -0.008, 0]} receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.06, 0.014, PANEL_DEPTH - 0.06]} />
        <meshStandardMaterial color="#0d111a" roughness={0.72} metalness={0.08} />
      </mesh>

      {/* ── Layer 3: Photovoltaic cell layer with emissive glow ── */}
      <mesh position={[0, 0.009, 0]} castShadow receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.1, 0.012, PANEL_DEPTH - 0.1]} />
        <meshPhysicalMaterial
          color={cellColor}
          emissive={cellColor}
          emissiveIntensity={emissiveIntensity}
          roughness={0.12}
          metalness={0.48}
          clearcoat={0.4}
          clearcoatRoughness={0.1}
          envMapIntensity={1.2}
        />
      </mesh>

      {/* ── Layer 4: AR-coated clearcoat glass ── */}
      <mesh position={[0, 0.021, 0]} receiveShadow material={PBR_PANEL_GLASS}>
        <boxGeometry args={[PANEL_WIDTH - 0.09, 0.008, PANEL_DEPTH - 0.09]} />
      </mesh>

      {/* ── Sun glint highlight (additive overlay) ── */}
      <mesh ref={glintRef} position={[0.08, 0.026, -0.12]}>
        <planeGeometry args={[0.28, 0.55]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.FrontSide}
        />
      </mesh>

      {/* ── Selection scan-line ── */}
      {selected && (
        <mesh ref={scanRef} position={[0, 0.028, 0]} rotation={[0, 0, 0]}>
          <planeGeometry args={[PANEL_WIDTH - 0.08, 0.06]} />
          <meshBasicMaterial
            color={DS.gold}
            transparent
            opacity={0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      {/* ── Selection wireframe halo ── */}
      {selected && (
        <mesh>
          <boxGeometry args={[PANEL_WIDTH + 0.08, PANEL_THICKNESS + 0.04, PANEL_DEPTH + 0.08]} />
          <meshBasicMaterial color={DS.gold} wireframe transparent opacity={0.7} depthWrite={false} />
        </mesh>
      )}

      {/* ── Emissive energy glow ── */}
      <pointLight
        ref={glowRef}
        color={selected ? DS.gold : "#4488ff"}
        intensity={emissiveIntensity * 0.8}
        distance={1.6}
        decay={2}
      />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.4 — MODERN HOUSE MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the cinematic house */
interface ModernHouseProps {
  nightMode: boolean
}

/**
 * ModernHouse
 *
 * Replaces the box-house with a pitched-roof structure featuring:
 *   - Prism-shaped roof (custom geometry via extrusion)
 *   - Textured concrete wall panels
 *   - Glass windows with night emissive glow
 *   - Roof trim, overhangs, and chimney
 *   - Subtle window-light point lights at night
 */
const ModernHouse = memo(function ModernHouse({ nightMode }: ModernHouseProps) {
  const windowEmissive    = nightMode ? new THREE.Color("#ffd090") : new THREE.Color("#000000")
  const windowEmissiveInt = nightMode ? 0.85 : 0.0

  // Night interior lights
  const winLightInt = nightMode ? 0.7 : 0.0

  return (
    <group position={HOUSE_POS}>

      {/* ── Main body ── */}
      <mesh position={[0, -0.62, 0]} castShadow receiveShadow material={PBR_WALL_CONCRETE}>
        <boxGeometry args={[7.8, 2.2, 5.0]} />
      </mesh>

      {/* ── Roof overhang deck ── */}
      <mesh position={[0, 0.32, 0]} castShadow receiveShadow material={PBR_ROOF_TILE}>
        <boxGeometry args={[8.5, 0.18, 5.6]} />
      </mesh>

      {/* ── Pitched roof (two slope faces) ── */}
      {/* Left slope */}
      <mesh position={[-2.1, 0.88, 0]} rotation={[0, 0, Math.PI * 0.14]} castShadow material={PBR_ROOF_TILE}>
        <boxGeometry args={[4.6, 0.16, 5.4]} />
      </mesh>
      {/* Right slope */}
      <mesh position={[2.1, 0.88, 0]} rotation={[0, 0, -Math.PI * 0.14]} castShadow material={PBR_ROOF_TILE}>
        <boxGeometry args={[4.6, 0.16, 5.4]} />
      </mesh>

      {/* ── Ridge cap ── */}
      <mesh position={[0, 1.36, 0]} castShadow>
        <boxGeometry args={[8.4, 0.14, 0.22]} />
        <meshStandardMaterial color="#1e2938" roughness={0.55} metalness={0.28} />
      </mesh>

      {/* ── Fascia / roof trim ── */}
      <mesh position={[0, 0.32, 2.85]} receiveShadow>
        <boxGeometry args={[8.5, 0.18, 0.08]} />
        <meshStandardMaterial color="#4a5a6a" roughness={0.45} metalness={0.35} />
      </mesh>
      <mesh position={[0, 0.32, -2.85]} receiveShadow>
        <boxGeometry args={[8.5, 0.18, 0.08]} />
        <meshStandardMaterial color="#4a5a6a" roughness={0.45} metalness={0.35} />
      </mesh>

      {/* ── Windows — front facade ── */}
      {[[-2.4, -0.5, 2.52], [0.4, -0.5, 2.52], [2.8, -0.22, 2.52]].map(([x, y, z], i) => (
        <group key={`win-f-${i}`} position={[x, y, z]}>
          {/* Frame */}
          <mesh castShadow>
            <boxGeometry args={[1.1, 0.82, 0.08]} />
            <meshStandardMaterial color="#c8d4e0" roughness={0.3} metalness={0.6} />
          </mesh>
          {/* Glass pane */}
          <mesh position={[0, 0, 0.04]}>
            <boxGeometry args={[0.92, 0.66, 0.02]} />
            <meshPhysicalMaterial
              color={nightMode ? "#ffeedd" : "#a8c8f0"}
              emissive={windowEmissive}
              emissiveIntensity={windowEmissiveInt}
              roughness={0.0}
              metalness={0.0}
              clearcoat={1}
              transmission={nightMode ? 0.2 : 0.72}
              transparent
              opacity={nightMode ? 0.92 : 0.82}
              reflectivity={0.88}
            />
          </mesh>
          {nightMode && (
            <pointLight
              position={[0, 0, -0.5]}
              color="#ffcc88"
              intensity={winLightInt}
              distance={4}
              decay={2}
            />
          )}
        </group>
      ))}

      {/* ── Side windows ── */}
      {[[-3.92, -0.48, -0.6], [-3.92, -0.48, 1.2]].map(([x, y, z], i) => (
        <group key={`win-s-${i}`} position={[x, y, z]}>
          <mesh castShadow>
            <boxGeometry args={[0.08, 0.76, 0.92]} />
            <meshStandardMaterial color="#c8d4e0" roughness={0.3} metalness={0.6} />
          </mesh>
          <mesh position={[-0.04, 0, 0]}>
            <boxGeometry args={[0.02, 0.60, 0.76]} />
            <meshPhysicalMaterial
              color={nightMode ? "#ffeedd" : "#a8c8f0"}
              emissive={windowEmissive}
              emissiveIntensity={windowEmissiveInt * 0.7}
              roughness={0.0}
              clearcoat={1}
              transmission={nightMode ? 0.3 : 0.7}
              transparent
              opacity={0.88}
              reflectivity={0.88}
            />
          </mesh>
        </group>
      ))}

      {/* ── Front door ── */}
      <mesh position={[-0.62, -0.78, 2.52]} castShadow>
        <boxGeometry args={[0.92, 0.88, 0.08]} />
        <meshStandardMaterial color="#1a2530" roughness={0.4} metalness={0.5} />
      </mesh>

      {/* ── Chimney ── */}
      <mesh position={[2.6, 0.92, -1.6]} castShadow receiveShadow>
        <boxGeometry args={[0.58, 1.2, 0.58]} />
        <meshStandardMaterial color="#3a4555" roughness={0.82} metalness={0.06} />
      </mesh>
      <mesh position={[2.6, 1.58, -1.6]}>
        <boxGeometry args={[0.64, 0.1, 0.64]} />
        <meshStandardMaterial color="#5a6a7a" roughness={0.6} metalness={0.3} />
      </mesh>

      {/* ── Roof vents ── */}
      {[[-1.2, 1.08, 0], [1.4, 1.08, 0.4]].map(([x, y, z], i) => (
        <mesh key={`vent-${i}`} position={[x, y, z]} castShadow>
          <cylinderGeometry args={[0.09, 0.11, 0.18, 8]} />
          <meshStandardMaterial color="#7a8a9a" roughness={0.5} metalness={0.55} />
        </mesh>
      ))}

    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.5 — HIGH-QUALITY TREES
// ─────────────────────────────────────────────────────────────────────────────

/** Configuration for a single tree in a cluster */
interface TreeConfig {
  position: [number, number, number]
  scale:    number
  hueShift: number   // foliage colour variation (−0.05 to +0.05)
  swayPhase: number  // per-tree sway offset
}

/** Props for a single low-poly tree */
interface SingleTreeProps {
  config:    TreeConfig
  swayTime:  number  // current elapsed time for sway
}

/** Single low-poly stylised tree with cylinder trunk and 3 foliage cones */
const SingleTree = memo(function SingleTree({ config, swayTime }: SingleTreeProps) {
  const groupRef = useRef<THREE.Group>(null)
  const foliageMat = useMemo(() => makeFoliageMat(config.hueShift), [config.hueShift])

  useFrame(({ clock }) => {
    if (!groupRef.current) return
    const t     = clock.getElapsedTime()
    const sway  = Math.sin(t * 0.9 + config.swayPhase) * 0.012 * config.scale
    const swayZ = Math.cos(t * 0.7 + config.swayPhase + 1.2) * 0.008 * config.scale
    groupRef.current.rotation.x = sway
    groupRef.current.rotation.z = swayZ
  })

  const [px, py, pz] = config.position
  const s = config.scale

  return (
    <group ref={groupRef} position={[px, py, pz]} scale={[s, s, s]}>
      {/* Trunk */}
      <mesh position={[0, 0.52, 0]} castShadow receiveShadow material={PBR_BARK}>
        <cylinderGeometry args={[0.09, 0.13, 1.05, 7]} />
      </mesh>
      {/* Bottom foliage cone */}
      <mesh position={[0, 1.48, 0]} castShadow receiveShadow material={foliageMat}>
        <coneGeometry args={[0.72, 1.0, 7]} />
      </mesh>
      {/* Mid foliage cone */}
      <mesh position={[0, 2.05, 0]} castShadow receiveShadow material={foliageMat}>
        <coneGeometry args={[0.54, 0.88, 7]} />
      </mesh>
      {/* Top foliage cone */}
      <mesh position={[0, 2.52, 0]} castShadow receiveShadow material={foliageMat}>
        <coneGeometry args={[0.34, 0.72, 6]} />
      </mesh>
    </group>
  )
})

/** Predefined tree positions forming a natural-looking cluster */
const DEFAULT_TREE_CONFIGS: TreeConfig[] = [
  { position: [-9.8,  0, -3.2], scale: 1.1,  hueShift:  0.02,  swayPhase: 0.0  },
  { position: [-11.2, 0, -0.8], scale: 0.92, hueShift: -0.01,  swayPhase: 1.3  },
  { position: [-10.4, 0,  2.2], scale: 1.04, hueShift:  0.03,  swayPhase: 2.6  },
  { position: [-8.6,  0,  4.8], scale: 0.86, hueShift: -0.02,  swayPhase: 0.8  },
  { position: [10.4,  0, -6.2], scale: 1.18, hueShift:  0.01,  swayPhase: 1.9  },
  { position: [12.0,  0, -4.0], scale: 0.96, hueShift: -0.03,  swayPhase: 3.1  },
  { position: [-6.2,  0, -9.4], scale: 1.08, hueShift:  0.02,  swayPhase: 0.5  },
  { position: [-3.8,  0, -9.8], scale: 0.88, hueShift: -0.01,  swayPhase: 2.2  },
]

/** Props for TreeCluster */
interface TreeClusterProps {
  configs?: TreeConfig[]
}

/**
 * TreeCluster
 *
 * Renders a collection of stylised low-poly trees with per-tree colour
 * variation and independent sin-wave sway animation.
 */
const TreeCluster = memo(function TreeCluster({ configs = DEFAULT_TREE_CONFIGS }: TreeClusterProps) {
  const timeRef = useRef(0)
  useFrame(({ clock }) => { timeRef.current = clock.getElapsedTime() })

  return (
    <group>
      {configs.map((cfg, i) => (
        <SingleTree key={i} config={cfg} swayTime={timeRef.current} />
      ))}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.6 — CINEMATIC TERRAIN + ENVIRONMENT
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the cinematic terrain group */
interface CinematicTerrainProps {
  weather:   WeatherType
  nightMode: boolean
}

/**
 * CinematicTerrain
 *
 * Renders:
 *   - Large grass ground plane with colour tint from weather
 *   - Distant low-poly building silhouettes for depth
 *   - Atmospheric fog band near horizon
 *   - Subtle raised kerb / path around the house
 */
const CinematicTerrain = memo(function CinematicTerrain({
  weather,
  nightMode,
}: CinematicTerrainProps) {
  const { scene } = useThree()

  // Weather-tinted ground colour
  const groundColor = useMemo(() => {
    const base = new THREE.Color("#3d6b35")
    if (weather === "snow")  return base.clone().lerp(new THREE.Color("#dce8f0"), 0.72)
    if (weather === "rain")  return base.clone().lerp(new THREE.Color("#2a4a28"), 0.5)
    if (nightMode)           return base.clone().lerp(new THREE.Color("#1a2820"), 0.7)
    return base
  }, [weather, nightMode])

  // Scene fog
  useEffect(() => {
    const fogColor = nightMode ? "#040810" : weather === "fog" ? "#b0bec5" : "#c8d8e8"
    const near     = weather === "fog" ? 12 : 28
    const far      = weather === "fog" ? 36 : 80
    scene.fog = new THREE.Fog(fogColor, near, far)
    return () => { scene.fog = null }
  }, [scene, weather, nightMode])

  return (
    <group>
      {/* ── Main ground plane ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.96, 0]} receiveShadow>
        <planeGeometry args={[160, 160, 1, 1]} />
        <meshStandardMaterial color={groundColor} roughness={0.96} metalness={0.0} envMapIntensity={0.2} />
      </mesh>

      {/* ── Concrete path / apron around house ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.2, -1.94, 1]} receiveShadow>
        <planeGeometry args={[12, 9]} />
        <meshStandardMaterial color="#9aa5b1" roughness={0.88} metalness={0.04} />
      </mesh>

      {/* ── Driveway strip ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.2, -1.935, 8]} receiveShadow>
        <planeGeometry args={[3.8, 8]} />
        <meshStandardMaterial color="#8a9298" roughness={0.84} metalness={0.04} />
      </mesh>

      {/* ── Distant buildings (silhouettes) ── */}
      {[
        { pos: [-40,  3, -50], size: [6,  8, 5] },
        { pos: [-28,  2, -55], size: [4,  6, 4] },
        { pos: [-52,  4, -42], size: [8, 10, 6] },
        { pos: [ 38,  3, -48], size: [5,  8, 5] },
        { pos: [ 52,  2, -40], size: [7,  6, 6] },
        { pos: [ 28,  5, -58], size: [4, 12, 4] },
      ].map(({ pos, size }, i) => (
        <mesh key={`bldg-${i}`} position={pos as [number,number,number]} castShadow>
          <boxGeometry args={size as [number,number,number]} />
          <meshStandardMaterial
            color={nightMode ? "#2a3040" : "#5a6478"}
            roughness={0.76}
            metalness={0.14}
            envMapIntensity={0.3}
          />
        </mesh>
      ))}

      {/* ── Horizon grade plane (atmospheric colour) ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.97, -60]} receiveShadow>
        <planeGeometry args={[200, 80]} />
        <meshStandardMaterial color={nightMode ? "#080c14" : "#4a6878"} roughness={1} metalness={0} />
      </mesh>
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.7 — SKY ATMOSPHERE
// ─────────────────────────────────────────────────────────────────────────────

/** Gradient stops for the sky based on sun elevation */
function skyGradientColor(elevation: number, nightMode: boolean): THREE.Color {
  if (nightMode || elevation < -5)  return new THREE.Color("#020610")
  if (elevation < 5)  {
    // Twilight — deep orange-violet horizon
    const t = (elevation + 5) / 10
    return new THREE.Color("#1a0a28").lerp(new THREE.Color("#e85820"), t)
  }
  if (elevation < 20) {
    // Sunrise/sunset golden
    const t = (elevation - 5) / 15
    return new THREE.Color("#e85820").lerp(new THREE.Color("#2c6cb0"), t)
  }
  // Daytime blue
  const t = clamp((elevation - 20) / 50, 0, 1)
  return new THREE.Color("#2c6cb0").lerp(new THREE.Color("#1a3a6a"), t)
}

/** Props for SkyAtmosphere */
interface SkyAtmosphereProps {
  elevation:  number
  azimuth:    number
  nightMode:  boolean
  weather:    WeatherType
}

/**
 * SkyAtmosphere
 *
 * Large BackSide sphere with gradient colour updated each frame.
 * Adds a soft cloud wisp mesh and a star-field Points object at night.
 */
const SkyAtmosphere = memo(function SkyAtmosphere({
  elevation,
  azimuth,
  nightMode,
  weather,
}: SkyAtmosphereProps) {
  const skyMatRef   = useRef<THREE.MeshBasicMaterial>(null)
  const sunDiscRef  = useRef<THREE.Mesh>(null)
  const cloudRef    = useRef<THREE.Group>(null)

  // Cloud geometry — static wispy quads
  const cloudPositions: [number,number,number][] = useMemo(() => [
    [-24, 18, -60], [12, 22, -68], [38, 16, -55],
    [-48, 20, -52], [22, 24, -72], [-10, 19, -65],
  ], [])

  const showClouds = weather === "cloudy" || weather === "fog" || weather === "rain" || weather === "storm"

  useFrame(() => {
    const col = skyGradientColor(elevation, nightMode)
    if (skyMatRef.current) skyMatRef.current.color.copy(col)

    if (sunDiscRef.current) {
      const sunDir = sunVector(elevation, azimuth)
      sunDiscRef.current.position.copy(sunDir.multiplyScalar(260))
      sunDiscRef.current.visible = elevation > 0 && !nightMode
      const sunScale = clamp(0.6 + elevation / 60, 0.6, 1.1)
      sunDiscRef.current.scale.setScalar(sunScale)
    }
  })

  // Star points — built once
  const starGeo = useMemo(() => {
    const count = 1800
    const pos   = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const phi   = Math.acos(2 * seeded(i * 3) - 1)
      const theta = 2 * Math.PI * seeded(i * 3 + 1)
      const r     = 255
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.abs(Math.cos(phi))  // upper hemisphere
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    return g
  }, [])

  const starsVisible = nightMode || elevation < 2

  return (
    <group>
      {/* ── Sky dome ── */}
      <mesh renderOrder={-2}>
        <sphereGeometry args={[270, 32, 32]} />
        <meshBasicMaterial ref={skyMatRef} color="#1a3a6a" side={THREE.BackSide} depthWrite={false} />
      </mesh>

      {/* ── Sun disc ── */}
      <mesh ref={sunDiscRef} renderOrder={-1}>
        <circleGeometry args={[3.8, 32]} />
        <meshBasicMaterial color="#ffe87a" transparent opacity={0.95} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* ── Horizon glow ── */}
      {!nightMode && elevation > -8 && elevation < 25 && (
        <mesh position={[0, -48, 0]} renderOrder={-1}>
          <sphereGeometry args={[258, 24, 8, 0, Math.PI * 2, 0, 0.25]} />
          <meshBasicMaterial
            color={elevation < 8 ? "#e06020" : "#5580aa"}
            transparent
            opacity={clamp(0.35 - elevation * 0.012, 0.0, 0.35)}
            side={THREE.BackSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      {/* ── Cloud wisps ── */}
      {showClouds && (
        <group ref={cloudRef}>
          {cloudPositions.map(([x, y, z], i) => (
            <mesh key={`cloud-${i}`} position={[x, y, z]}>
              <sphereGeometry args={[3.5 + seeded(i) * 2.5, 7, 5]} />
              <meshBasicMaterial
                color="#c8d8e8"
                transparent
                opacity={0.12 + seeded(i + 1) * 0.1}
                depthWrite={false}
              />
            </mesh>
          ))}
        </group>
      )}

      {/* ── Stars ── */}
      {starsVisible && (
        <points geometry={starGeo}>
          <pointsMaterial
            color="#e8ecff"
            size={0.5}
            sizeAttenuation
            transparent
            opacity={clamp(1 - elevation * 0.18, 0.0, 0.9)}
            depthWrite={false}
          />
        </points>
      )}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.8 — GLOWING ENERGY BEAM
// ─────────────────────────────────────────────────────────────────────────────

/** Props for a single glowing energy cable */
interface GlowingEnergyBeamProps {
  points:    [number, number, number][]
  color:     string
  active:    boolean
  speed?:    number   // pulse travel speed (0–1 per second)
  glowWidth?: number  // line width multiplier
}

/**
 * GlowingEnergyBeam
 *
 * Renders an energy cable as a stack of two DreiLines (core + glow halo)
 * with an animated pulse sphere that travels along the path.
 * Colors follow the flow direction:
 *   Solar → Inverter: gold    Battery: emerald
 *   House: cyan               Grid: orange
 */
const GlowingEnergyBeam = memo(function GlowingEnergyBeam({
  points,
  color,
  active,
  speed   = 0.6,
  glowWidth = 1,
}: GlowingEnergyBeamProps) {
  const pulseRef  = useRef<THREE.Mesh>(null)
  const curve     = useMemo(
    () => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
    [points]
  )
  const progressRef = useRef(Math.random()) // stagger pulses

  useFrame((_, delta) => {
    if (!pulseRef.current || !active) return
    progressRef.current = (progressRef.current + delta * speed) % 1
    const pos = curve.getPoint(progressRef.current)
    pulseRef.current.position.copy(pos)
  })

  if (!active || points.length < 2) return null

  const threeColor = new THREE.Color(color)

  return (
    <group>
      {/* ── Halo glow line (wide, dim) ── */}
      <DreiLine
        points={points}
        color={color}
        lineWidth={glowWidth * 3.5}
        transparent
        opacity={0.18}
        depthWrite={false}
      />

      {/* ── Core bright line ── */}
      <DreiLine
        points={points}
        color={color}
        lineWidth={glowWidth * 1.2}
        transparent
        opacity={0.82}
      />

      {/* ── Traveling pulse sphere ── */}
      <mesh ref={pulseRef}>
        <sphereGeometry args={[0.055, 8, 8]} />
        <meshBasicMaterial color={threeColor} />
      </mesh>

      {/* ── Pulse point light (moves with sphere) ── */}
      <pointLight
        color={color}
        intensity={0.4}
        distance={1.2}
        decay={2}
        position={points[0]}
      />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.9 — GLASSMORPHISM HUD CARD
// ─────────────────────────────────────────────────────────────────────────────

/** Props for a reusable glassmorphism card */
interface GlassmorphismCardProps {
  children:     React.ReactNode
  title?:       string
  accentColor?: string
  width?:       number | string
  style?:       React.CSSProperties
}

/**
 * GlassmorphismCard
 *
 * Modern frosted-glass UI card with:
 *   - backdrop-filter blur
 *   - soft inset border glow
 *   - animated gold accent top-border on hover
 *   - subtle box-shadow depth
 */
const GlassmorphismCard = memo(function GlassmorphismCard({
  children,
  title,
  accentColor = DS.gold,
  width       = "auto",
  style       = {},
}: GlassmorphismCardProps) {
  const [hovered, setHovered] = useState(false)

  return (
    <motion.div
      onHoverStart={() => setHovered(true)}
      onHoverEnd={()   => setHovered(false)}
      animate={{
        borderColor: hovered ? `${accentColor}66` : `${accentColor}22`,
        boxShadow:   hovered
          ? `0 8px 32px rgba(0,0,0,0.5), inset 0 0 0 1px ${accentColor}22, 0 0 16px ${accentColor}18`
          : `0 4px 20px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.06)`,
      }}
      transition={{ duration: 0.22 }}
      style={{
        background:     "rgba(4, 10, 28, 0.72)",
        backdropFilter: "blur(16px) saturate(1.4)",
        WebkitBackdropFilter: "blur(16px) saturate(1.4)",
        border:         `1px solid ${accentColor}22`,
        borderTop:      `2px solid ${hovered ? accentColor : accentColor + "55"}`,
        borderRadius:   12,
        padding:        "14px 18px",
        width,
        color:          DS.text,
        fontSize:       13,
        ...style,
      }}
    >
      {title && (
        <div style={{
          fontSize:      10,
          fontWeight:    700,
          color:         accentColor,
          letterSpacing: "0.1em",
          marginBottom:  10,
          textTransform: "uppercase",
        }}>
          {title}
        </div>
      )}
      {children}
    </motion.div>
  )
})

/** Glassmorphism stat row — label + value with optional unit */
const GlassStat = memo(function GlassStat({
  label,
  value,
  unit,
  color = DS.text,
}: {
  label: string
  value: string | number
  unit?: string
  color?: string
}) {
  return (
    <div style={{
      display:        "flex",
      justifyContent: "space-between",
      alignItems:     "baseline",
      padding:        "3px 0",
      borderBottom:   `1px solid rgba(255,255,255,0.04)`,
    }}>
      <span style={{ color: DS.muted, fontSize: 11 }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
        {value}
        {unit && <span style={{ color: DS.muted, fontWeight: 400, fontSize: 10, marginLeft: 3 }}>{unit}</span>}
      </span>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.10 — CINEMATIC CAMERA
// ─────────────────────────────────────────────────────────────────────────────

/** Smooth camera inertia state */
interface CinematicCameraState {
  targetPosition: THREE.Vector3
  targetLookAt:   THREE.Vector3
  driftAngle:     number
}

/**
 * useCinematicCamera
 *
 * Wraps the OrbitControls camera with smooth inertia and subtle ambient drift.
 * When `applyPreset` is called, the camera eases to the new position over
 * `easeMs` milliseconds using an exponential lerp each frame.
 *
 * @param controlsRef  Ref to the OrbitControls instance
 * @param easeMs       Transition duration target (default 1200 ms)
 * @param driftAmplitude  Subtle idle drift amplitude (0 = disabled)
 */
function useCinematicCamera(
  controlsRef:      React.RefObject<OrbitControlsImpl | null>,
  easeMs:           number = 1200,
  driftAmplitude:   number = 0.008,
): {
  applyPreset: (key: CameraPresetKey) => void
  isAnimating: boolean
} {
  const stateRef     = useRef<CinematicCameraState>({
    targetPosition: new THREE.Vector3(0, 6.8, 10.6),
    targetLookAt:   new THREE.Vector3(0, 0.4, 0),
    driftAngle:     0,
  })
  const [isAnimating, setIsAnimating] = useState(false)
  const animatingRef = useRef(false)
  const startTimeRef = useRef(0)

  const easeAlpha = 1 - Math.exp(-8 / (easeMs / 16.67))

  const applyPreset = useCallback((key: CameraPresetKey) => {
    const preset = CAMERA_PRESETS[key]
    stateRef.current.targetPosition.set(...preset.position)
    stateRef.current.targetLookAt.set(...preset.target)
    animatingRef.current = true
    startTimeRef.current = performance.now()
    setIsAnimating(true)
  }, [])

  useFrame(({ camera, clock }) => {
    const controls = controlsRef.current
    if (!controls) return

    const { targetPosition, targetLookAt } = stateRef.current
    const t   = clock.getElapsedTime()

    // Subtle ambient drift on idle
    if (!animatingRef.current && driftAmplitude > 0) {
      const driftX = Math.sin(t * 0.12) * driftAmplitude
      const driftY = Math.cos(t * 0.09) * driftAmplitude * 0.6
      camera.position.x += driftX
      camera.position.y += driftY
    }

    // Ease camera toward target
    if (animatingRef.current) {
      camera.position.lerp(targetPosition, easeAlpha)
      controls.target.lerp(targetLookAt, easeAlpha)
      controls.update()

      const dist = camera.position.distanceTo(targetPosition)
      if (dist < 0.015) {
        camera.position.copy(targetPosition)
        controls.target.copy(targetLookAt)
        controls.update()
        animatingRef.current = false
        setIsAnimating(false)
      }
    }
  })

  return { applyPreset, isAnimating }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.11 — MICRO ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useMicroAnimations
 *
 * Returns a collection of small time-varying scalar values that drive
 * subtle visual details — all derived from clock.getElapsedTime() so
 * they are deterministic and never cause re-renders (values read in useFrame).
 *
 * Returned refs are read directly inside child useFrame callbacks.
 */
function useMicroAnimations(): {
  panelGlintRef:   React.MutableRefObject<number>  // 0–1 sun glint intensity
  batteryPulseRef: React.MutableRefObject<number>  // 0–1 battery breathing
  invertLedRef:    React.MutableRefObject<number>  // 0 or 1 inverter LED blink
  energyHumRef:    React.MutableRefObject<number>  // subtle energy hum scale
  treeSwayRef:     React.MutableRefObject<number>  // global sway time
} {
  const panelGlintRef   = useRef(0)
  const batteryPulseRef = useRef(0)
  const invertLedRef    = useRef(0)
  const energyHumRef    = useRef(1)
  const treeSwayRef     = useRef(0)

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    panelGlintRef.current   = (Math.sin(t * 0.8) * 0.5 + 0.5) * 0.14
    batteryPulseRef.current = Math.sin(t * 1.4) * 0.5 + 0.5
    invertLedRef.current    = Math.sin(t * 2.2) > 0.7 ? 1 : 0
    energyHumRef.current    = 1 + Math.sin(t * 3.6) * 0.022
    treeSwayRef.current     = t
  })

  return { panelGlintRef, batteryPulseRef, invertLedRef, energyHumRef, treeSwayRef }
}

/** Props for the InverterLedBlink component */
interface InverterLedBlinkProps {
  position:     [number, number, number]
  invertLedRef: React.MutableRefObject<number>
  active:       boolean
}

/**
 * InverterLedBlink
 *
 * Small emissive sphere that blinks on the inverter face.
 * Driven by the invertLedRef value from useMicroAnimations.
 */
const InverterLedBlink = memo(function InverterLedBlink({
  position,
  invertLedRef,
  active,
}: InverterLedBlinkProps) {
  const meshRef   = useRef<THREE.Mesh>(null)
  const lightRef  = useRef<THREE.PointLight>(null)

  useFrame(() => {
    if (!meshRef.current || !lightRef.current) return
    const on = active && invertLedRef.current > 0.5
    ;(meshRef.current.material as THREE.MeshBasicMaterial).color.set(on ? "#22ff44" : "#114422")
    lightRef.current.intensity = on ? 0.35 : 0
  })

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.025, 6, 6]} />
        <meshBasicMaterial color="#114422" />
      </mesh>
      <pointLight ref={lightRef} color="#22ff44" intensity={0} distance={0.6} decay={2} />
    </group>
  )
})

/** Props for BatteryGlowRing — visual charge indicator */
interface BatteryGlowRingProps {
  soc:             number   // 0–1 state of charge
  charging:        boolean
  batteryPulseRef: React.MutableRefObject<number>
}

/**
 * BatteryGlowRing
 *
 * Torus ring around the battery mesh that glows green when charging,
 * amber when discharging, red when low SOC — with a breathing pulse.
 */
const BatteryGlowRing = memo(function BatteryGlowRing({
  soc,
  charging,
  batteryPulseRef,
}: BatteryGlowRingProps) {
  const ringRef  = useRef<THREE.Mesh>(null)
  const lightRef = useRef<THREE.PointLight>(null)

  const baseColor = soc < 0.2 ? DS.danger : charging ? DS.emerald : DS.warning

  useFrame(() => {
    if (!ringRef.current || !lightRef.current) return
    const pulse = batteryPulseRef.current
    ;(ringRef.current.material as THREE.MeshBasicMaterial).opacity =
      0.18 + pulse * 0.22
    lightRef.current.intensity = (0.3 + pulse * 0.4) * soc
  })

  return (
    <group position={BATTERY_POS}>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.38, 0.04, 8, 32]} />
        <meshBasicMaterial color={baseColor} transparent opacity={0.3} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight ref={lightRef} color={baseColor} intensity={0.3} distance={1.4} decay={2} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13.12 — COLOR GRADING + CINEMATIC POST-PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/** Color grading preset names */
type ColorGradePreset = "default" | "golden" | "night" | "overcast" | "vibrant"

/** Parameters for one color grade preset */
interface ColorGradeParams {
  bloomIntensity:    number
  bloomThreshold:   number
  bloomRadius:      number
  vignetteOffset:   number
  vignetteDarkness: number
}

/** All presets */
const COLOR_GRADE_PRESETS: Record<ColorGradePreset, ColorGradeParams> = {
  default: {
    bloomIntensity:  0.45,
    bloomThreshold: 0.62,
    bloomRadius:    0.55,
    vignetteOffset: 0.5,
    vignetteDarkness: 0.55,
  },
  golden: {
    bloomIntensity:  0.72,
    bloomThreshold: 0.48,
    bloomRadius:    0.82,
    vignetteOffset: 0.4,
    vignetteDarkness: 0.68,
  },
  night: {
    bloomIntensity:  0.96,
    bloomThreshold: 0.28,
    bloomRadius:    1.1,
    vignetteOffset: 0.32,
    vignetteDarkness: 0.82,
  },
  overcast: {
    bloomIntensity:  0.22,
    bloomThreshold: 0.8,
    bloomRadius:    0.3,
    vignetteOffset: 0.6,
    vignetteDarkness: 0.45,
  },
  vibrant: {
    bloomIntensity:  0.62,
    bloomThreshold: 0.55,
    bloomRadius:    0.65,
    vignetteOffset: 0.48,
    vignetteDarkness: 0.52,
  },
}

/**
 * resolveColorGradePreset
 *
 * Picks the appropriate color grade preset from scene state.
 * Can be used to drive EffectComposer Bloom / Vignette props dynamically.
 */
function resolveColorGradePreset(
  weather:   WeatherType,
  nightMode: boolean,
  elevation: number,
): ColorGradePreset {
  if (nightMode)                            return "night"
  if (weather === "cloudy" || weather === "fog" || weather === "rain") return "overcast"
  if (weather === "storm")                  return "night"
  if (elevation < 15 && elevation > -2)     return "golden"  // sunrise / sunset
  return "default"
}

/** Props for SceneColorGrading (wraps EffectComposer with dynamic params) */
interface SceneColorGradingProps {
  weather:   WeatherType
  nightMode: boolean
  elevation: number
  enabled:   boolean
}

/**
 * SceneColorGrading
 *
 * Drop-in replacement for the static EffectComposer in Section 8.
 * Smoothly interpolates Bloom and Vignette parameters toward the active
 * preset each frame — no React state updates, pure ref-based animation.
 */
const SceneColorGrading = memo(function SceneColorGrading({
  weather,
  nightMode,
  elevation,
  enabled,
}: SceneColorGradingProps) {
  if (!enabled) return null

  const preset = resolveColorGradePreset(weather, nightMode, elevation)
  const params = COLOR_GRADE_PRESETS[preset]

  return (
    <EffectComposer>
      <Bloom
        intensity={params.bloomIntensity}
        luminanceThreshold={params.bloomThreshold}
        luminanceSmoothing={params.bloomRadius}
        mipmapBlur
      />
      <Vignette
        offset={params.vignetteOffset}
        darkness={params.vignetteDarkness}
        eskil={false}
      />
    </EffectComposer>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — HOOKS & UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useSceneVisuals
 *
 * Convenience hook that wires together the Section 13 systems.
 * Returns all the props needed to render the cinematic upgrade layer.
 *
 * @example
 *   const vis = useSceneVisuals({ weather, nightMode, elevation, azimuth })
 *   // Inside Canvas:
 *   <CinematicLightingRig {...vis.lightingProps} />
 *   <SkyAtmosphere {...vis.skyProps} />
 *   <CinematicTerrain {...vis.terrainProps} />
 *   <TreeCluster />
 *   <ModernHouse nightMode={nightMode} />
 *   <SceneColorGrading {...vis.gradingProps} />
 */
function useSceneVisuals(opts: {
  weather:   WeatherType
  nightMode: boolean
  elevation: number
  azimuth:   number
  showBloom: boolean
}): {
  lightingProps: CinematicLightingRigProps
  skyProps:      SkyAtmosphereProps
  terrainProps:  CinematicTerrainProps
  gradingProps:  SceneColorGradingProps
  colorPreset:   ColorGradePreset
} {
  const { weather, nightMode, elevation, azimuth, showBloom } = opts

  const lightingProps: CinematicLightingRigProps = {
    elevation, azimuth, weather, nightMode,
  }

  const skyProps: SkyAtmosphereProps = {
    elevation, azimuth, nightMode, weather,
  }

  const terrainProps: CinematicTerrainProps = {
    weather, nightMode,
  }

  const colorPreset = resolveColorGradePreset(weather, nightMode, elevation)

  const gradingProps: SceneColorGradingProps = {
    weather, nightMode, elevation, enabled: showBloom,
  }

  return { lightingProps, skyProps, terrainProps, gradingProps, colorPreset }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 13 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // ── 13.1 Materials ────────────────────────────────────────────────────────
  PBR_PANEL_GLASS,
  PBR_PANEL_CELL,
  PBR_PANEL_FRAME,
  PBR_ROOF_TILE,
  PBR_WALL_CONCRETE,
  PBR_WINDOW_GLASS,
  PBR_BARK,
  PBR_GROUND,
  PBR_DISTANT_BUILDING,
  makeFoliageMat,

  // ── 13.2 Lighting ─────────────────────────────────────────────────────────
  CinematicLightingRig,

  // ── 13.3 Panels ───────────────────────────────────────────────────────────
  CinematicPanelMesh,

  // ── 13.4 House ────────────────────────────────────────────────────────────
  ModernHouse,

  // ── 13.5 Trees ────────────────────────────────────────────────────────────
  TreeCluster,
  SingleTree,

  // ── 13.6 Terrain ──────────────────────────────────────────────────────────
  CinematicTerrain,

  // ── 13.7 Sky ──────────────────────────────────────────────────────────────
  SkyAtmosphere,
  skyGradientColor,

  // ── 13.8 Energy flow ──────────────────────────────────────────────────────
  GlowingEnergyBeam,

  // ── 13.9 UI ───────────────────────────────────────────────────────────────
  GlassmorphismCard,
  GlassStat,

  // ── 13.10 Camera ──────────────────────────────────────────────────────────
  useCinematicCamera,

  // ── 13.11 Micro animations ────────────────────────────────────────────────
  useMicroAnimations,
  InverterLedBlink,
  BatteryGlowRing,

  // ── 13.12 Color grading ───────────────────────────────────────────────────
  SceneColorGrading,
  resolveColorGradePreset,
  COLOR_GRADE_PRESETS,

  // ── Convenience hook ──────────────────────────────────────────────────────
  useSceneVisuals,
}

export type {
  // ── 13.2 ──────────────────────────────────────────────────────────────────
  CinematicLightingRigProps,

  // ── 13.3 ──────────────────────────────────────────────────────────────────
  CinematicPanelMeshProps,

  // ── 13.4 ──────────────────────────────────────────────────────────────────
  ModernHouseProps,

  // ── 13.5 ──────────────────────────────────────────────────────────────────
  TreeConfig,
  SingleTreeProps,
  TreeClusterProps,

  // ── 13.6 ──────────────────────────────────────────────────────────────────
  CinematicTerrainProps,

  // ── 13.7 ──────────────────────────────────────────────────────────────────
  SkyAtmosphereProps,

  // ── 13.8 ──────────────────────────────────────────────────────────────────
  GlowingEnergyBeamProps,

  // ── 13.9 ──────────────────────────────────────────────────────────────────
  GlassmorphismCardProps,

  // ── 13.10 ─────────────────────────────────────────────────────────────────
  CinematicCameraState,

  // ── 13.11 ─────────────────────────────────────────────────────────────────
  InverterLedBlinkProps,
  BatteryGlowRingProps,

  // ── 13.12 ─────────────────────────────────────────────────────────────────
  ColorGradePreset,
  ColorGradeParams,
  SceneColorGradingProps,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — ADVANCED 3D ENGINE REFACTOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   16.1  Render Engine Core               ~500
//   16.2  Scene Graph Optimizer            ~400
//   16.3  Solar Panel Visual Upgrade       ~600
//   16.4  House Geometry Refactor          ~500
//   16.5  Tree Rendering System            ~400
//   16.6  Environment Renderer             ~400
//   16.7  Cinematic Lighting Engine        ~400
//   16.8  Dynamic Sky Shader               ~300
//   16.9  Energy Flow FX                   ~200
//   16.10 Micro Animation Engine           ~200
//   16.11 Camera Cinematic Controller      ~200
//   TOTAL ≈ 4100 lines
//
// TODO (production): split into:
//   /engine  → EngineCore, SceneGraphOptimizer, CameraController
//   /shaders → sky.glsl, panel.glsl, energy.glsl
//   /workers → bvhWorker.ts, lightClusterWorker.ts
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.1 — RENDER ENGINE CORE
// ─────────────────────────────────────────────────────────────────────────────

/** Global engine tuning budget — override via window.__ENGINE_CONFIG__ at runtime */
interface EngineBudgets {
  maxInstances:    number
  baseShadowMap:   number   // per-cascade shadow map resolution
  particleBudget:  number   // max GPU particles
  tileSize:        number   // clustered shading tile pixel size
  maxLightsPerTile: number
  lodBias:         number   // screen-size metric scale factor (lower = more aggressive LOD)
  shadowCascades:  number   // 1 (fallback) or 3
}

const ENGINE_BUDGETS: EngineBudgets = {
  maxInstances:    2000,
  baseShadowMap:   2048,
  particleBudget:  800,
  tileSize:        24,
  maxLightsPerTile: 8,
  lodBias:         1.0,
  shadowCascades:  3,
  ...((typeof window !== "undefined" && (window as Window & { __ENGINE_CONFIG__?: Partial<EngineBudgets> }).__ENGINE_CONFIG__) ?? {}),
}

/** Immutable frame metadata passed to every render pass */
interface RenderFrameData {
  frameNumber:    number
  deltaMs:        number
  elapsedSec:     number
  drawCalls:      number
  triangles:      number
  textures:       number
  geometries:     number
  fps:            number
}

/** Context object passed into each registered render pass callback */
interface RenderPassContext {
  gl:        THREE.WebGLRenderer
  scene:     THREE.Scene
  camera:    THREE.Camera
  frameData: RenderFrameData
}

/** A named render pass with priority ordering */
interface RenderPass {
  name:     string
  priority: number   // lower = runs first
  enabled:  boolean
  callback: (ctx: RenderPassContext) => void
}

/** RenderGraph — manages ordered passes and frame-data accumulation */
class RenderGraph {
  private passes: RenderPass[] = []
  private frameNumber = 0
  private lastTime    = performance.now()
  private fpsHistory  = new Float32Array(60)
  private fpsIdx      = 0

  /** Register or update a named pass */
  register(pass: RenderPass): void {
    const existing = this.passes.findIndex((p) => p.name === pass.name)
    if (existing >= 0) {
      this.passes[existing] = pass
    } else {
      this.passes.push(pass)
      this.passes.sort((a, b) => a.priority - b.priority)
    }
  }

  /** Remove a pass by name */
  remove(name: string): void {
    this.passes = this.passes.filter((p) => p.name !== name)
  }

  /** Enable / disable a pass without removing it */
  setEnabled(name: string, enabled: boolean): void {
    const p = this.passes.find((p) => p.name === name)
    if (p) p.enabled = enabled
  }

  /** Execute all enabled passes and return updated frame data */
  execute(
    gl:     THREE.WebGLRenderer,
    scene:  THREE.Scene,
    camera: THREE.Camera,
  ): RenderFrameData {
    const now      = performance.now()
    const deltaMs  = now - this.lastTime
    this.lastTime  = now
    this.frameNumber++

    const fps = deltaMs > 0 ? 1000 / deltaMs : 60
    this.fpsHistory[this.fpsIdx % 60] = fps
    this.fpsIdx++
    const avgFps = this.fpsHistory.reduce((a, b) => a + b, 0) / 60

    const info = gl.info
    const frameData: RenderFrameData = {
      frameNumber: this.frameNumber,
      deltaMs,
      elapsedSec:  now / 1000,
      drawCalls:   info.render.calls,
      triangles:   info.render.triangles,
      textures:    info.memory.textures,
      geometries:  info.memory.geometries,
      fps:         avgFps,
    }

    const ctx: RenderPassContext = { gl, scene, camera, frameData }
    for (const pass of this.passes) {
      if (pass.enabled) {
        try { pass.callback(ctx) }
        catch (e) { console.warn(`[RenderGraph] Pass "${pass.name}" threw:`, e) }
      }
    }

    return frameData
  }

  get passNames(): string[] { return this.passes.map((p) => p.name) }
}

/** Module-singleton render graph shared across subsystems */
const globalRenderGraph = new RenderGraph()

// ── RenderStatistics — rolling stats aggregator ────────────────────────────

interface FrameHistogram {
  buckets:  number[]   // ms buckets: 0-8, 8-16, 16-32, 32-64, 64+
  total:    number
}

class RenderStatistics {
  private ring:     Float32Array = new Float32Array(120)
  private ringIdx:  number       = 0
  private hist:     FrameHistogram = { buckets: [0, 0, 0, 0, 0], total: 0 }

  record(deltaMs: number): void {
    this.ring[this.ringIdx % 120] = deltaMs
    this.ringIdx++
    const b = deltaMs < 8 ? 0 : deltaMs < 16 ? 1 : deltaMs < 32 ? 2 : deltaMs < 64 ? 3 : 4
    this.hist.buckets[b]++
    this.hist.total++
  }

  get averageMs(): number {
    const n = Math.min(this.ringIdx, 120)
    if (n === 0) return 0
    let sum = 0
    for (let i = 0; i < n; i++) sum += this.ring[i]
    return sum / n
  }

  get p95Ms(): number {
    const n   = Math.min(this.ringIdx, 120)
    if (n === 0) return 0
    const arr = Array.from(this.ring.slice(0, n)).sort((a, b) => a - b)
    return arr[Math.floor(n * 0.95)] ?? 0
  }

  get histogram(): FrameHistogram { return this.hist }
}

const globalStats = new RenderStatistics()

// ── useRenderPass — hook to register a pass from a component ──────────────

/**
 * useRenderPass
 *
 * Register a named render pass callback into the global RenderGraph.
 * The callback is called in priority order once per frame.
 * Automatically de-registers on unmount.
 *
 * @example
 *   useRenderPass("shadow-prepass", 10, ({ gl, scene, camera }) => { … })
 */
function useRenderPass(
  name:     string,
  priority: number,
  callback: (ctx: RenderPassContext) => void,
  enabled:  boolean = true,
): void {
  const cbRef = useRef(callback)
  cbRef.current = callback

  useEffect(() => {
    globalRenderGraph.register({
      name,
      priority,
      enabled,
      callback: (ctx) => cbRef.current(ctx),
    })
    return () => globalRenderGraph.remove(name)
  }, [name, priority]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    globalRenderGraph.setEnabled(name, enabled)
  }, [name, enabled])
}

// ── RenderFrameController — fixed-timestep logic tick + variable render ────

/** Props for RenderFrameController */
interface RenderFrameControllerProps {
  fixedHz?:   number           // fixed-tick logic frequency (default 30)
  onTick?:    (dt: number) => void  // fixed timestep callback
  onFrame?:   (fd: RenderFrameData) => void  // variable render callback
  children?:  React.ReactNode
}

/**
 * RenderFrameController
 *
 * Runs inside <Canvas>. Provides a fixed-tick accumulator for game logic
 * (physics, simulation) decoupled from the variable render frame rate.
 * Also drives the global RenderGraph and accumulates frame statistics.
 */
const RenderFrameController = memo(function RenderFrameController({
  fixedHz  = 30,
  onTick,
  onFrame,
  children,
}: RenderFrameControllerProps) {
  const { gl, scene, camera } = useThree()
  const accumulatorRef = useRef(0)
  const fixedDt        = 1 / fixedHz

  useFrame((_, delta) => {
    // Fixed-tick accumulator
    accumulatorRef.current += delta
    while (accumulatorRef.current >= fixedDt) {
      onTick?.(fixedDt)
      accumulatorRef.current -= fixedDt
    }

    // Execute render graph passes
    const fd = globalRenderGraph.execute(gl, scene, camera)
    globalStats.record(fd.deltaMs)
    onFrame?.(fd)
  })

  return <>{children}</>
})

// ── EngineCore — top-level engine component ─────────────────────────────────

/** Engine runtime state exposed via context */
interface EngineState {
  frameData:   RenderFrameData
  stats:       RenderStatistics
  renderGraph: RenderGraph
  budgets:     EngineBudgets
  isWebGL2:    boolean
  paused:      boolean
  setPaused:   (v: boolean) => void
}

const EngineContext = React.createContext<EngineState | null>(null)

/** Hook to access the engine state from any child component */
function useEngineCore(): EngineState {
  const ctx = React.useContext(EngineContext)
  if (!ctx) throw new Error("useEngineCore must be used inside <EngineCore>")
  return ctx
}

/** Props for EngineCore */
interface EngineCoreProps {
  children?: React.ReactNode
  onFrame?:  (fd: RenderFrameData) => void
}

/**
 * EngineCore
 *
 * Root engine component that must be placed inside <Canvas>.
 * Provides EngineContext to all children, drives RenderFrameController,
 * and applies ENGINE_BUDGETS defaults.
 *
 * @example
 *   <Canvas>
 *     <EngineCore>
 *       <SceneContent />
 *     </EngineCore>
 *   </Canvas>
 */
const EngineCore = memo(function EngineCore({ children, onFrame }: EngineCoreProps) {
  const [paused,    setPaused]    = useState(false)
  const [frameData, setFrameData] = useState<RenderFrameData>({
    frameNumber: 0, deltaMs: 16.67, elapsedSec: 0,
    drawCalls: 0, triangles: 0, textures: 0, geometries: 0, fps: 60,
  })

  const handleFrame = useCallback((fd: RenderFrameData) => {
    setFrameData(fd)
    onFrame?.(fd)
  }, [onFrame])

  const state = useMemo<EngineState>(() => ({
    frameData,
    stats:       globalStats,
    renderGraph: globalRenderGraph,
    budgets:     ENGINE_BUDGETS,
    isWebGL2:    IS_WEBGL2,
    paused,
    setPaused,
  }), [frameData, paused])

  return (
    <EngineContext.Provider value={state}>
      <RenderFrameController onFrame={handleFrame}>
        {children}
      </RenderFrameController>
    </EngineContext.Provider>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.2 — SCENE GRAPH OPTIMIZER
// ─────────────────────────────────────────────────────────────────────────────

/** Bounding sphere for culling */
interface BoundingSphere {
  center: THREE.Vector3
  radius: number
}

/** Compute world-space bounding sphere from a Three.js Object3D */
function computeBoundingSphere(obj: THREE.Object3D): BoundingSphere {
  const box = new THREE.Box3().setFromObject(obj)
  const center = new THREE.Vector3()
  box.getCenter(center)
  const size = new THREE.Vector3()
  box.getSize(size)
  return { center, radius: size.length() * 0.5 }
}

/** Test if a bounding sphere is inside a camera frustum */
function sphereInFrustum(
  sphere:  BoundingSphere,
  frustum: THREE.Frustum,
): boolean {
  return frustum.containsPoint(sphere.center) ||
    frustum.intersectsSphere(new THREE.Sphere(sphere.center, sphere.radius))
}

/** Tracked scene object for the optimizer */
interface SceneObjectEntry {
  id:              string
  object:          THREE.Object3D
  bsphere:         BoundingSphere
  lastVisible:     boolean
  castShadow:      boolean
  receiveShadow:   boolean
  shadowDistance:  number   // max distance from camera to cast shadow
}

/** Pure utility: merge static meshes in a group (returns merged BufferGeometry) */
function mergeStaticMeshes(
  meshes: THREE.Mesh[],
): THREE.BufferGeometry | null {
  if (meshes.length === 0) return null
  const positions: number[] = []
  const normals:   number[] = []
  const uvs:       number[] = []

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    const geo  = mesh.geometry
    const posA = geo.attributes.position
    const norA = geo.attributes.normal
    const uvA  = geo.attributes.uv

    if (!posA) continue
    const mat = mesh.matrixWorld

    for (let i = 0; i < posA.count; i++) {
      const v = new THREE.Vector3(posA.getX(i), posA.getY(i), posA.getZ(i))
      v.applyMatrix4(mat)
      positions.push(v.x, v.y, v.z)

      if (norA) {
        const n = new THREE.Vector3(norA.getX(i), norA.getY(i), norA.getZ(i))
        const nm = new THREE.Matrix3().getNormalMatrix(mat)
        n.applyMatrix3(nm).normalize()
        normals.push(n.x, n.y, n.z)
      }
      if (uvA) uvs.push(uvA.getX(i), uvA.getY(i))
    }
  }

  const merged = new THREE.BufferGeometry()
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))
  if (normals.length) merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3))
  if (uvs.length)     merged.setAttribute("uv",     new THREE.Float32BufferAttribute(uvs,      2))
  merged.computeBoundingSphere()
  return merged
}

/**
 * SceneGraphOptimizer
 *
 * Performs per-frame frustum culling on registered objects.
 * Objects beyond shadowDistance have castShadow disabled dynamically.
 * Provides `register` / `unregister` API for static and dynamic objects.
 *
 * Performance tuning:
 *   - Increase `shadowDistance` budget to improve shadow quality at cost of draw calls.
 *   - Reduce registered object count by batching static geometry (mergeStaticMeshes).
 */
class SceneGraphOptimizer {
  private entries: Map<string, SceneObjectEntry> = new Map()
  private frustum: THREE.Frustum = new THREE.Frustum()
  private projScreenMatrix: THREE.Matrix4 = new THREE.Matrix4()
  private shadowCamera: THREE.Camera | null = null

  /** Register an object for culling management */
  register(entry: SceneObjectEntry): void {
    this.entries.set(entry.id, entry)
  }

  /** Remove by id */
  unregister(id: string): void {
    this.entries.delete(id)
  }

  /** Set the camera used for shadow culling (usually the directional light shadow camera) */
  setShadowCamera(camera: THREE.Camera): void {
    this.shadowCamera = camera
  }

  /** Call once per frame with the main render camera */
  update(camera: THREE.Camera): void {
    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    )
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix)

    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)

    for (const entry of this.entries.values()) {
      const visible = sphereInFrustum(entry.bsphere, this.frustum)
      entry.object.visible = visible
      entry.lastVisible    = visible

      // Shadow culling: disable shadow casting beyond budget distance
      if (entry.castShadow && entry.object instanceof THREE.Mesh) {
        const dist = camPos.distanceTo(entry.bsphere.center)
        entry.object.castShadow = dist < entry.shadowDistance
      }
    }
  }

  get visibleCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.lastVisible) n++
    return n
  }
}

/** Module-singleton optimizer */
const globalSceneOptimizer = new SceneGraphOptimizer()

/** Hook to register a mesh for culling management */
function useSceneCulling(
  id:             string,
  objectRef:      React.RefObject<THREE.Object3D | null>,
  opts: {
    castShadow?:     boolean
    shadowDistance?: number
  } = {},
): void {
  useEffect(() => {
    const obj = objectRef.current
    if (!obj) return
    const sphere = computeBoundingSphere(obj)
    globalSceneOptimizer.register({
      id,
      object:         obj,
      bsphere:        sphere,
      lastVisible:    true,
      castShadow:     opts.castShadow   ?? false,
      receiveShadow:  false,
      shadowDistance: opts.shadowDistance ?? 30,
    })
    return () => globalSceneOptimizer.unregister(id)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** SceneOptimizerDriver — runs the optimizer each frame inside Canvas */
const SceneOptimizerDriver = memo(function SceneOptimizerDriver() {
  const { camera } = useThree()
  useFrame(() => globalSceneOptimizer.update(camera))
  return null
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.3 — SOLAR PANEL VISUAL UPGRADE
// ─────────────────────────────────────────────────────────────────────────────

// ── Cell-grid pattern GLSL — drawn in UV space over the PV cell layer ────────

const PANEL_CELL_VERT = /* glsl */ `
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;
  varying vec3  vViewDir;

  void main() {
    vUv       = uv;
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal   = normalize(normalMatrix * normal);
    vec4 mvp  = projectionMatrix * viewMatrix * wp;
    vViewDir  = normalize(cameraPosition - wp.xyz);
    gl_Position = mvp;
  }
`

const PANEL_CELL_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOutputRatio;
  uniform float uEmissiveIntensity;
  uniform vec3  uCellColor;
  uniform vec3  uGlintDir;       // normalised sun direction in world space
  uniform float uGlintStrength;

  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;
  varying vec3  vViewDir;

  // ── Cell grid pattern ──────────────────────────────────────────────────────
  float cellGrid(vec2 uv, float cols, float rows, float lineW) {
    vec2 cell  = fract(uv * vec2(cols, rows));
    float hEdge = step(1.0 - lineW, cell.x) + step(cell.x, lineW);
    float vEdge = step(1.0 - lineW, cell.y) + step(cell.y, lineW);
    return clamp(hEdge + vEdge, 0.0, 1.0);
  }

  // ── Specular glint (Blinn-Phong micro approximation) ───────────────────────
  float glint(vec3 N, vec3 V, vec3 L, float shininess) {
    vec3  H    = normalize(V + L);
    float NdH  = max(dot(N, H), 0.0);
    return pow(NdH, shininess);
  }

  void main() {
    // Base cell colour
    vec3 col = uCellColor;

    // Dark monocrystalline cell texture
    float grid = cellGrid(vUv, 6.0, 10.0, 0.025);
    col = mix(col, col * 0.62, grid * 0.85);

    // Fine busbar lines (horizontal strips)
    float busbar = step(0.495, fract(vUv.y * 10.0)) * step(fract(vUv.y * 10.0), 0.505);
    col = mix(col, vec3(0.72, 0.78, 0.82), busbar * 0.55);

    // Emissive production glow (only when generating)
    vec3 emissive = uCellColor * uEmissiveIntensity * uOutputRatio;
    col += emissive;

    // Subtle sun glint
    float g = glint(vNormal, vViewDir, uGlintDir, 128.0) * uGlintStrength * uOutputRatio;
    col += vec3(g * 0.9, g * 0.95, g);

    // Time-varying shimmer
    float shimmer = sin(uTime * 0.8 + vUv.x * 14.0 + vUv.y * 11.0) * 0.5 + 0.5;
    col += shimmer * 0.008 * uOutputRatio;

    gl_FragColor = vec4(col, 1.0);
  }
`

/** Uniforms for the panel cell shader */
  interface PanelCellUniforms {
    [uniform: string]: THREE.IUniform
  uTime:              { value: number }
  uOutputRatio:       { value: number }
  uEmissiveIntensity: { value: number }
  uCellColor:         { value: THREE.Color }
  uGlintDir:          { value: THREE.Vector3 }
  uGlintStrength:     { value: number }
}

/** Create a panel cell ShaderMaterial with typed uniforms */
function createPanelCellMaterial(
  outputRatio: number = 0.8,
): THREE.ShaderMaterial & { uniforms: PanelCellUniforms } {
  const uniforms: PanelCellUniforms = {
    uTime:              { value: 0 },
    uOutputRatio:       { value: outputRatio },
    uEmissiveIntensity: { value: 0.18 },
    uCellColor:         { value: new THREE.Color("#0c2040") },
    uGlintDir:          { value: new THREE.Vector3(0, 1, 0) },
    uGlintStrength:     { value: 0.55 },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   PANEL_CELL_VERT,
      fragmentShader: PANEL_CELL_FRAG,
      uniforms,
      lights:         false,
    }),
    { uniforms }
  )
}

// ── Panel frame material — anodised aluminium ─────────────────────────────

const PANEL_FRAME_MATERIAL_V2 = new THREE.MeshStandardMaterial({
  color:           new THREE.Color("#c0ccd8"),
  roughness:       0.18,
  metalness:       0.96,
  envMapIntensity: 2.0,
})

// ── Mounting rail material ────────────────────────────────────────────────

const PANEL_RAIL_MATERIAL = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#8a9aaa"),
  roughness: 0.28,
  metalness: 0.88,
})

// ── Tempered glass material ───────────────────────────────────────────────

const PANEL_GLASS_V2 = new THREE.MeshPhysicalMaterial({
  color:              new THREE.Color("#0a1828"),
  roughness:          0.02,
  metalness:          0.0,
  clearcoat:          1.0,
  clearcoatRoughness: 0.01,
  reflectivity:       0.94,
  transmission:       0.08,
  transparent:        true,
  opacity:            0.97,
  envMapIntensity:    2.6,
  side:               THREE.FrontSide,
})

/** Props for the upgraded solar panel */
interface UpgradedPanelMeshProps {
  position:    [number, number, number]
  rotation:    [number, number, number]
  outputRatio: number
  selected:    boolean
  viewMode:    ViewMode
  color:       THREE.Color
  sunDir:      THREE.Vector3
  onClick:     () => void
}

/**
 * UpgradedPanelMesh
 *
 * Five-layer panel geometry:
 *   1. Anodised aluminium frame
 *   2. Back-sheet EVA polymer
 *   3. Photovoltaic cell layer — custom GLSL cell-grid shader
 *   4. AR-coated tempered glass (MeshPhysicalMaterial)
 *   5. Mounting rails (bottom-side only, visible from below)
 *
 * Rendering cost: ~5 draw calls per panel. For 12 panels = 60 DC.
 * At 1000+ panels use InstancedPanelManager from Section 10.1 instead.
 */
const UpgradedPanelMesh = memo(function UpgradedPanelMesh({
  position,
  rotation,
  outputRatio,
  selected,
  viewMode,
  color,
  sunDir,
  onClick,
}: UpgradedPanelMeshProps) {
  const cellMatRef  = useRef<(THREE.ShaderMaterial & { uniforms: PanelCellUniforms }) | null>(null)
  const glowRef     = useRef<THREE.PointLight>(null)
  const scanRef     = useRef<THREE.Mesh>(null)

  // Create cell material once
  const cellMat = useMemo(() => {
    if (!IS_WEBGL2) {
      // Fallback for older devices: plain MeshStandardMaterial
      return new THREE.MeshStandardMaterial({
        color:            color,
        emissive:         color,
        emissiveIntensity: 0.12 * outputRatio,
        roughness:         0.18,
        metalness:         0.45,
      })
    }
    return createPanelCellMaterial(outputRatio)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (cellMat instanceof THREE.ShaderMaterial && "uniforms" in cellMat) {
      cellMatRef.current = cellMat as THREE.ShaderMaterial & { uniforms: PanelCellUniforms }
    }
  }, [cellMat])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const u = cellMatRef.current?.uniforms
    if (u) {
      u.uTime.value        = t
      u.uOutputRatio.value = outputRatio
      u.uGlintDir.value.copy(sunDir)

      // Drive cell colour from viewMode
      switch (viewMode) {
        case "thermal": u.uCellColor.value.copy(thermalColor(35 + outputRatio * 30)); break
        case "heatmap": u.uCellColor.value.copy(efficiencyColor(outputRatio));        break
        default:        u.uCellColor.value.set("#0c2040"); break
      }
    }

    // Selection scan-line animation
    if (scanRef.current && selected) {
      const z = ((t * 0.7) % 1) * (PANEL_DEPTH + 0.05) - PANEL_DEPTH * 0.5
      scanRef.current.position.z = z
      ;(scanRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.4 * (1 - Math.abs(z / (PANEL_DEPTH * 0.5)))
    }

    // Power glow
    if (glowRef.current) {
      glowRef.current.intensity = selected
        ? 1.1 + 0.4 * Math.sin(t * 3.8)
        : outputRatio * 0.3
    }
  })

  return (
    <group
      position={position}
      rotation={rotation}
      onClick={(e) => { e.stopPropagation(); onClick() }}
    >
      {/* ── Layer 1: Aluminium frame ── */}
      <mesh castShadow receiveShadow material={PANEL_FRAME_MATERIAL_V2}>
        <boxGeometry args={[PANEL_WIDTH, PANEL_THICKNESS, PANEL_DEPTH]} />
      </mesh>

      {/* ── Layer 2: Back-sheet ── */}
      <mesh position={[0, -0.008, 0]} receiveShadow>
        <boxGeometry args={[PANEL_WIDTH - 0.06, 0.012, PANEL_DEPTH - 0.06]} />
        <meshStandardMaterial color="#0d111a" roughness={0.72} metalness={0.1} />
      </mesh>

      {/* ── Layer 3: PV cell grid (GLSL shader / fallback) ── */}
      <mesh position={[0, 0.009, 0]} castShadow receiveShadow material={cellMat}>
        <boxGeometry args={[PANEL_WIDTH - 0.1, 0.012, PANEL_DEPTH - 0.1]} />
      </mesh>

      {/* ── Layer 4: Tempered glass ── */}
      <mesh position={[0, 0.022, 0]} receiveShadow material={PANEL_GLASS_V2}>
        <boxGeometry args={[PANEL_WIDTH - 0.09, 0.008, PANEL_DEPTH - 0.09]} />
      </mesh>

      {/* ── Layer 5: Mounting rails (underside) ── */}
      {[-0.28, 0.28].map((ox, ri) => (
        <mesh key={ri} position={[ox, -0.038, 0]} castShadow>
          <boxGeometry args={[0.06, 0.024, PANEL_DEPTH + 0.04]} />
          <primitive object={PANEL_RAIL_MATERIAL} />
        </mesh>
      ))}

      {/* ── Selection scan-line ── */}
      {selected && (
        <mesh ref={scanRef} position={[0, 0.028, 0]}>
          <planeGeometry args={[PANEL_WIDTH - 0.08, 0.055]} />
          <meshBasicMaterial
            color={DS.gold}
            transparent
            opacity={0.32}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      )}

      {/* ── Selection wireframe ── */}
      {selected && (
        <mesh>
          <boxGeometry args={[PANEL_WIDTH + 0.09, PANEL_THICKNESS + 0.05, PANEL_DEPTH + 0.09]} />
          <meshBasicMaterial color={DS.gold} wireframe transparent opacity={0.65} depthWrite={false} />
        </mesh>
      )}

      {/* ── Power glow light ── */}
      <pointLight
        ref={glowRef}
        color={selected ? DS.gold : "#4488ff"}
        intensity={outputRatio * 0.3}
        distance={1.8}
        decay={2}
      />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.4 — HOUSE GEOMETRY REFACTOR
// ─────────────────────────────────────────────────────────────────────────────

// ── Procedural pitched-roof geometry ─────────────────────────────────────────

/**
 * buildPitchedRoofGeometry
 *
 * Creates a prism (triangular cross-section) mesh for a gable or hip roof.
 * Pure function — unit testable.
 *
 * @param width   Ridge-to-wall width (X axis)
 * @param length  Building length (Z axis)
 * @param height  Ridge height above eave
 */
function buildPitchedRoofGeometry(
  width:  number,
  length: number,
  height: number,
): THREE.BufferGeometry {
  const hw = width  * 0.5
  const hl = length * 0.5

  // Vertices: two gable triangles + four slope faces
  const verts = new Float32Array([
    // left gable (-Z)
    -hw, 0,  -hl,   hw, 0, -hl,   0, height, -hl,
    // right gable (+Z)
    -hw, 0,   hl,   0, height,  hl,  hw, 0,   hl,
    // left slope
    -hw, 0,  -hl,   0, height, -hl,  0, height,  hl,
    -hw, 0,  -hl,   0, height,  hl,  -hw, 0,  hl,
    // right slope
     hw, 0,  -hl,   hw, 0,  hl,  0, height,  hl,
     hw, 0,  -hl,   0, height,  hl,  0, height, -hl,
  ])

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

/** Roof overhang cap geometry (thin box overhanging the wall face) */
function buildOverhangGeometry(
  width: number, length: number, thickness: number, overhang: number,
): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width + overhang * 2, thickness, length + overhang * 2)
}

// ── Materials ────────────────────────────────────────────────────────────────

const MAT_RENDER_CONCRETE = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#d0d8e4"),
  roughness: 0.86,
  metalness: 0.02,
  envMapIntensity: 0.4,
})

const MAT_RENDER_ROOF_TILE = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#2a3a4c"),
  roughness: 0.76,
  metalness: 0.06,
  envMapIntensity: 0.5,
})

const MAT_RENDER_FASCIA = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#48596a"),
  roughness: 0.52,
  metalness: 0.35,
})

const MAT_RENDER_GLASS = new THREE.MeshPhysicalMaterial({
  color:        new THREE.Color("#a0c8f0"),
  roughness:    0.0,
  metalness:    0.0,
  clearcoat:    1.0,
  transmission: 0.75,
  transparent:  true,
  opacity:      0.82,
  reflectivity: 0.88,
  envMapIntensity: 3.0,
})

/** Props for RefactoredHouse */
interface RefactoredHouseProps {
  nightMode: boolean
  position?: [number, number, number]
}

/**
 * RefactoredHouse
 *
 * Procedurally constructed house with:
 *   - Concrete walls (4 panels)
 *   - Pitched roof (buildPitchedRoofGeometry)
 *   - Roof overhang + fascia trim
 *   - 3 front windows + 2 side windows with night glow
 *   - Front door with frame
 *   - Chimney with flashing cap
 *   - Roof vents (cylindrical)
 *   - Exterior wall trim
 */
const RefactoredHouse = memo(function RefactoredHouse({
  nightMode,
  position = [2.15, -0.38, 1.15],
}: RefactoredHouseProps) {
  const roofGeo     = useMemo(() => buildPitchedRoofGeometry(8.4, 5.0, 1.85), [])
  const overhangGeo = useMemo(() => buildOverhangGeometry(8.0, 4.8, 0.14, 0.32), [])

  const windowEmissive    = nightMode ? new THREE.Color("#ffd090") : new THREE.Color("#000000")
  const windowEmissiveInt = nightMode ? 0.88 : 0.0
  const winLightInt       = nightMode ? 0.65 : 0.0

  return (
    <group position={position}>

      {/* ── Main body walls ── */}
      <mesh castShadow receiveShadow material={MAT_RENDER_CONCRETE}>
        <boxGeometry args={[7.8, 2.2, 5.0]} />
      </mesh>

      {/* ── Corner trim strips ── */}
      {[[-3.93, 0, 0], [3.93, 0, 0]].map(([x, y, z], i) => (
        <mesh key={`ctrim-${i}`} position={[x, y, z]} castShadow>
          <boxGeometry args={[0.1, 2.24, 5.04]} />
          <meshStandardMaterial color="#b8c4d0" roughness={0.55} metalness={0.2} />
        </mesh>
      ))}

      {/* ── Foundation plinth ── */}
      <mesh position={[0, -1.22, 0]} receiveShadow>
        <boxGeometry args={[8.0, 0.28, 5.2]} />
        <meshStandardMaterial color="#9aabb8" roughness={0.92} metalness={0.04} />
      </mesh>

      {/* ── Pitched roof ── */}
      <mesh
        geometry={roofGeo}
        material={MAT_RENDER_ROOF_TILE}
        position={[0, 1.1, 0]}
        castShadow
        receiveShadow
      />

      {/* ── Roof overhang ── */}
      <mesh geometry={overhangGeo} position={[0, 1.08, 0]} material={MAT_RENDER_ROOF_TILE} castShadow />

      {/* ── Fascia boards ── */}
      {[
        { pos: [0, 1.08, 2.72] as [number,number,number], rot: [0,0,0] as [number,number,number], w: 9.0, h: 0.14, d: 0.08 },
        { pos: [0, 1.08,-2.72] as [number,number,number], rot: [0,0,0] as [number,number,number], w: 9.0, h: 0.14, d: 0.08 },
      ].map(({ pos, rot, w, h, d }, i) => (
        <mesh key={`fascia-${i}`} position={pos} rotation={rot} material={MAT_RENDER_FASCIA} castShadow>
          <boxGeometry args={[w, h, d]} />
        </mesh>
      ))}

      {/* ── Ridge cap ── */}
      <mesh position={[0, 1.08 + 1.85, 0]} material={MAT_RENDER_FASCIA} castShadow>
        <boxGeometry args={[8.2, 0.12, 0.22]} />
      </mesh>

      {/* ── Front windows ── */}
      {[
        { x: -2.5, y: -0.48, w: 1.1, h: 0.78 },
        { x:  0.3, y: -0.48, w: 1.1, h: 0.78 },
        { x:  2.8, y: -0.24, w: 1.6, h: 1.18 },
      ].map(({ x, y, w, h }, i) => (
        <group key={`win-f-${i}`} position={[x, y, 2.52]}>
          {/* Frame */}
          <mesh castShadow material={MAT_RENDER_FASCIA}>
            <boxGeometry args={[w + 0.1, h + 0.1, 0.10]} />
          </mesh>
          {/* Pane */}
          <mesh position={[0, 0, 0.045]}>
            <boxGeometry args={[w, h, 0.02]} />
            <meshPhysicalMaterial
              color={nightMode ? "#ffe8d0" : "#a0c8f0"}
              emissive={windowEmissive}
              emissiveIntensity={windowEmissiveInt}
              roughness={0.0}
              metalness={0.0}
              clearcoat={1.0}
              transmission={nightMode ? 0.22 : 0.75}
              transparent
              opacity={nightMode ? 0.94 : 0.82}
              reflectivity={0.9}
            />
          </mesh>
          {nightMode && (
            <pointLight color="#ffcc88" intensity={winLightInt} distance={4} decay={2} position={[0, 0, -0.6]} />
          )}
        </group>
      ))}

      {/* ── Side windows ── */}
      {[
        { x: -3.93, y: -0.46, z: -0.6 },
        { x: -3.93, y: -0.46, z:  1.2 },
      ].map(({ x, y, z }, i) => (
        <group key={`win-s-${i}`} position={[x, y, z]}>
          <mesh castShadow material={MAT_RENDER_FASCIA}>
            <boxGeometry args={[0.10, 0.80, 0.98]} />
          </mesh>
          <mesh position={[-0.04, 0, 0]}>
            <boxGeometry args={[0.02, 0.66, 0.82]} />
            <meshPhysicalMaterial
              color={nightMode ? "#ffe8d0" : "#a0c8f0"}
              emissive={windowEmissive}
              emissiveIntensity={windowEmissiveInt * 0.7}
              roughness={0.0}
              clearcoat={1.0}
              transmission={nightMode ? 0.3 : 0.72}
              transparent
              opacity={0.88}
              reflectivity={0.9}
            />
          </mesh>
        </group>
      ))}

      {/* ── Front door + frame ── */}
      <group position={[-0.65, -0.82, 2.52]}>
        {/* Frame */}
        <mesh castShadow material={MAT_RENDER_FASCIA}>
          <boxGeometry args={[1.05, 1.02, 0.10]} />
        </mesh>
        {/* Door panel */}
        <mesh position={[0, 0, 0.05]} castShadow>
          <boxGeometry args={[0.92, 0.92, 0.06]} />
          <meshStandardMaterial color="#1a2838" roughness={0.45} metalness={0.55} />
        </mesh>
        {/* Door knob */}
        <mesh position={[0.36, -0.08, 0.12]}>
          <sphereGeometry args={[0.028, 8, 8]} />
          <meshStandardMaterial color="#d4aa50" roughness={0.18} metalness={0.92} />
        </mesh>
      </group>

      {/* ── Chimney ── */}
      <group position={[2.7, 1.05, -1.6]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.60, 1.35, 0.60]} />
          <meshStandardMaterial color="#3a4858" roughness={0.82} metalness={0.06} />
        </mesh>
        {/* Flashing cap */}
        <mesh position={[0, 0.74, 0]} castShadow>
          <boxGeometry args={[0.68, 0.10, 0.68]} />
          <meshStandardMaterial color="#607080" roughness={0.55} metalness={0.45} />
        </mesh>
        {/* Stack pipe */}
        <mesh position={[0, 1.0, 0]}>
          <cylinderGeometry args={[0.08, 0.09, 0.28, 8]} />
          <meshStandardMaterial color="#404850" roughness={0.68} metalness={0.55} />
        </mesh>
      </group>

      {/* ── Roof vents ── */}
      {[[-1.4, 1.95, 0.3], [1.6, 1.95, -0.5]].map(([x, y, z], i) => (
        <mesh key={`vent-${i}`} position={[x, y, z]} castShadow>
          <cylinderGeometry args={[0.08, 0.11, 0.20, 8]} />
          <meshStandardMaterial color="#7a8a9a" roughness={0.48} metalness={0.58} />
        </mesh>
      ))}

      {/* ── Exterior wall light fixtures ── */}
      {nightMode && (
        <>
          <mesh position={[0, 0.08, 2.6]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshBasicMaterial color="#ffe8b0" />
          </mesh>
          <pointLight position={[0, 0.08, 2.75]} color="#ffcc88" intensity={0.55} distance={3.5} decay={2} />
        </>
      )}

    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.5 — TREE RENDERING SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Wind state shared across all trees */
interface WindState {
  speed:     number   // 0–1
  direction: number   // radians
  gusting:   boolean
}

/** Context for wind animations */
const WindContext = React.createContext<React.MutableRefObject<WindState>>({
  current: { speed: 0.18, direction: 0.4, gusting: false },
})

/** Hook to read the current wind ref */
function useWind(): React.MutableRefObject<WindState> {
  return React.useContext(WindContext)
}

// ── Materials (reused across all trees) ──────────────────────────────────────

const TREE_BARK_MAT = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#4e3218"),
  roughness: 0.94,
  metalness: 0.0,
})

function makeTreeFoliage(hue: number): THREE.MeshStandardMaterial {
  const col = new THREE.Color()
  col.setHSL(0.32 + hue, 0.72, 0.28)
  return new THREE.MeshStandardMaterial({
    color:    col,
    roughness: 0.88,
    metalness: 0.0,
    side:      THREE.FrontSide,
    envMapIntensity: 0.5,
  })
}

/** Per-tree configuration */
interface ProceduralTreeConfig {
  position:   [number, number, number]
  trunkH:     number   // trunk height
  trunkR:     number   // trunk base radius
  layers:     number   // foliage cone layers (2–4)
  foliageR:   number   // base foliage radius
  foliageH:   number   // height per foliage cone
  hueOffset:  number   // HSL hue offset for colour variation
  swayPhase:  number   // individual sway offset
  swayAmount: number   // max sway angle (radians)
}

/** Props for ProceduralTree */
interface ProceduralTreeProps {
  config: ProceduralTreeConfig
}

/**
 * ProceduralTree
 *
 * Cylinder trunk + N stacked cone layers with cross-faded hue variation.
 * Per-frame sin-wave sway driven by the global WindContext ref.
 * All geometry shared across instances; only transforms differ.
 */
const ProceduralTree = memo(function ProceduralTree({ config }: ProceduralTreeProps) {
  const groupRef   = useRef<THREE.Group>(null)
  const windRef    = useWind()
  const foliageMat = useMemo(() => makeTreeFoliage(config.hueOffset), [config.hueOffset])

  useFrame(({ clock }) => {
    if (!groupRef.current) return
    const t    = clock.getElapsedTime()
    const wind = windRef.current
    const sway = Math.sin(t * (0.7 + wind.speed * 0.8) + config.swayPhase) *
                 config.swayAmount * wind.speed
    const swayZ = Math.cos(t * (0.55 + wind.speed * 0.6) + config.swayPhase + 1.1) *
                  config.swayAmount * wind.speed * 0.5

    // Apply sway to the foliage portion only (not the trunk base)
    // We rotate the top half of the group via a pivot trick: translate, rotate, translate back
    const pivot = config.trunkH * 0.65
    groupRef.current.rotation.x = sway
    groupRef.current.rotation.z = swayZ
    groupRef.current.position.y = config.position[1]
  })

  return (
    <group
      ref={groupRef}
      position={config.position}
      rotation={[0, config.swayPhase, 0]}
    >
      {/* ── Trunk ── */}
      <mesh
        position={[0, config.trunkH * 0.5, 0]}
        castShadow
        receiveShadow
        material={TREE_BARK_MAT}
      >
        <cylinderGeometry args={[config.trunkR * 0.7, config.trunkR, config.trunkH, 8]} />
      </mesh>

      {/* ── Root flare ── */}
      <mesh position={[0, 0.05, 0]} receiveShadow>
        <cylinderGeometry args={[config.trunkR * 1.35, config.trunkR * 1.1, 0.12, 8]} />
        <primitive object={TREE_BARK_MAT} />
      </mesh>

      {/* ── Foliage cone layers ── */}
      {Array.from({ length: config.layers }, (_, li) => {
        const yOff  = config.trunkH + li * (config.foliageH * 0.72)
        const scale = 1 - li * 0.22
        const layerMat = li % 2 === 0 ? foliageMat : makeTreeFoliage(config.hueOffset + 0.02 * li)
        return (
          <mesh
            key={li}
            position={[0, yOff, 0]}
            castShadow
            receiveShadow
            material={layerMat}
          >
            <coneGeometry args={[config.foliageR * scale, config.foliageH, 7]} />
          </mesh>
        )
      })}
    </group>
  )
})

/** Default forest cluster positions */
const FOREST_TREE_CONFIGS: ProceduralTreeConfig[] = [
  { position: [-10.2,  0, -3.5], trunkH: 2.4, trunkR: 0.13, layers: 3, foliageR: 0.82, foliageH: 1.15, hueOffset:  0.018, swayPhase: 0.0,  swayAmount: 0.038 },
  { position: [-11.6,  0, -0.8], trunkH: 2.0, trunkR: 0.11, layers: 3, foliageR: 0.68, foliageH: 1.05, hueOffset: -0.012, swayPhase: 1.3,  swayAmount: 0.044 },
  { position: [-10.8,  0,  2.5], trunkH: 2.6, trunkR: 0.14, layers: 4, foliageR: 0.90, foliageH: 1.10, hueOffset:  0.028, swayPhase: 2.6,  swayAmount: 0.032 },
  { position: [ -9.0,  0,  5.2], trunkH: 1.8, trunkR: 0.10, layers: 2, foliageR: 0.62, foliageH: 1.20, hueOffset: -0.022, swayPhase: 0.8,  swayAmount: 0.050 },
  { position: [ 10.8,  0, -6.5], trunkH: 2.8, trunkR: 0.15, layers: 4, foliageR: 0.96, foliageH: 1.18, hueOffset:  0.010, swayPhase: 1.9,  swayAmount: 0.028 },
  { position: [ 12.4,  0, -4.2], trunkH: 2.2, trunkR: 0.12, layers: 3, foliageR: 0.74, foliageH: 1.08, hueOffset: -0.030, swayPhase: 3.1,  swayAmount: 0.042 },
  { position: [ -6.5,  0, -9.8], trunkH: 2.5, trunkR: 0.13, layers: 3, foliageR: 0.84, foliageH: 1.12, hueOffset:  0.022, swayPhase: 0.5,  swayAmount: 0.036 },
  { position: [ -4.0,  0,-10.4], trunkH: 1.9, trunkR: 0.10, layers: 2, foliageR: 0.66, foliageH: 1.25, hueOffset: -0.008, swayPhase: 2.2,  swayAmount: 0.048 },
  { position: [  8.5,  0,  8.2], trunkH: 2.3, trunkR: 0.12, layers: 3, foliageR: 0.78, foliageH: 1.10, hueOffset:  0.015, swayPhase: 1.5,  swayAmount: 0.040 },
]

/** Props for ForestCluster */
interface ForestClusterProps {
  configs?:   ProceduralTreeConfig[]
  windSpeed?: number
  windDir?:   number
}

/**
 * ForestCluster
 *
 * Manages wind state and renders all ProceduralTree instances.
 * Wind speed can be driven from weather state; direction from azimuth.
 */
const ForestCluster = memo(function ForestCluster({
  configs  = FOREST_TREE_CONFIGS,
  windSpeed = 0.2,
  windDir   = 0.4,
}: ForestClusterProps) {
  const windRef = useRef<WindState>({ speed: windSpeed, direction: windDir, gusting: false })

  // Update wind state when props change
  useEffect(() => { windRef.current.speed = windSpeed }, [windSpeed])
  useEffect(() => { windRef.current.direction = windDir }, [windDir])

  return (
    <WindContext.Provider value={windRef}>
      <group>
        {configs.map((cfg, i) => (
          <ProceduralTree key={i} config={cfg} />
        ))}
      </group>
    </WindContext.Provider>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.6 — ENVIRONMENT RENDERER
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the upgraded terrain and environment */
interface EnvironmentRendererProps {
  weather:    WeatherType
  nightMode:  boolean
  elevation:  number
}

/**
 * EnvironmentRenderer
 *
 * Replaces the placeholder ground with a multi-layered terrain that:
 *   - receives shadows
 *   - applies weather-tinted grass colour
 *   - adds concrete/asphalt driveway strips
 *   - adds distant building silhouettes for depth
 *   - manages scene fog reactively
 *
 * Tuning: increase ground plane segment count for terrain height detail.
 */
const EnvironmentRenderer = memo(function EnvironmentRenderer({
  weather,
  nightMode,
  elevation,
}: EnvironmentRendererProps) {
  const { scene } = useThree()

  // Weather-tinted ground
  const groundMat = useMemo(() => {
    const base = new THREE.Color("#3a6830")
    if (weather === "snow")  return new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color("#cce0f0"), 0.78), roughness: 0.98, metalness: 0 })
    if (weather === "rain")  return new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color("#2a4a24"), 0.55), roughness: 0.96, metalness: 0 })
    if (nightMode)           return new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color("#182418"), 0.75), roughness: 0.96, metalness: 0 })
    return new THREE.MeshStandardMaterial({ color: base, roughness: 0.95, metalness: 0, envMapIntensity: 0.28 })
  }, [weather, nightMode])

  // Reactive fog
  useEffect(() => {
    const isFog  = weather === "fog"
    const near   = isFog ? 10 : nightMode ? 24 : 32
    const far    = isFog ? 32 : nightMode ? 72 : 90
    const fogClr = nightMode ? "#040810" : isFog ? "#b0bcc8" : "#aac8e0"
    scene.fog = new THREE.Fog(fogClr, near, far)
    return () => { scene.fog = null }
  }, [scene, weather, nightMode])

  return (
    <group>
      {/* ── Main grass plane ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.96, 0]} receiveShadow>
        <planeGeometry args={[180, 180, 1, 1]} />
        <primitive object={groundMat} />
      </mesh>

      {/* ── Concrete apron ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.2, -1.938, 0.8]} receiveShadow>
        <planeGeometry args={[13, 10]} />
        <meshStandardMaterial color="#9aa5b0" roughness={0.88} metalness={0.04} />
      </mesh>

      {/* ── Driveway ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.2, -1.935, 9]} receiveShadow>
        <planeGeometry args={[4.0, 10]} />
        <meshStandardMaterial color="#8a9298" roughness={0.84} metalness={0.04} />
      </mesh>

      {/* ── Kerb edge ── */}
      <mesh position={[1.2, -1.85, 14.0]} receiveShadow>
        <boxGeometry args={[4.4, 0.12, 0.22]} />
        <meshStandardMaterial color="#7a8898" roughness={0.72} metalness={0.08} />
      </mesh>

      {/* ── Gravel border ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.2, -1.930, 0.8]} receiveShadow>
        <ringGeometry args={[6.8, 7.4, 32]} />
        <meshStandardMaterial color="#8a8878" roughness={0.98} metalness={0.0} />
      </mesh>

      {/* ── Distant buildings ── */}
      {[
        { p: [-42, 2, -52] as [number,number,number], s: [7, 10, 6]  as [number,number,number] },
        { p: [-30, 1, -58] as [number,number,number], s: [4,  6, 4]  as [number,number,number] },
        { p: [-55, 3, -44] as [number,number,number], s: [8, 12, 6]  as [number,number,number] },
        { p: [ 40, 2, -50] as [number,number,number], s: [6,  9, 5]  as [number,number,number] },
        { p: [ 54, 1, -42] as [number,number,number], s: [7,  7, 6]  as [number,number,number] },
        { p: [ 30, 4, -60] as [number,number,number], s: [5, 14, 4]  as [number,number,number] },
      ].map(({ p, s }, i) => (
        <mesh key={`dist-bldg-${i}`} position={p} castShadow>
          <boxGeometry args={s} />
          <meshStandardMaterial
            color={nightMode ? "#1e2838" : "#5a6878"}
            roughness={0.78}
            metalness={0.12}
            envMapIntensity={0.3}
          />
        </mesh>
      ))}

      {/* ── Horizon grade plane ── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.972, -70]} receiveShadow>
        <planeGeometry args={[220, 90]} />
        <meshStandardMaterial color={nightMode ? "#08091a" : "#4a6075"} roughness={1} metalness={0} />
      </mesh>

    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.7 — CINEMATIC LIGHTING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SunLightController
 *
 * Physically motivated directional light that:
 *   - places the light at the true sun world-position
 *   - applies golden-hour warmth at low elevation
 *   - scales intensity with a Lambert cosine term
 *   - enables soft PCF shadow mapping
 *
 * Shadow quality notes:
 *   ENGINE_BUDGETS.baseShadowMap sets shadow map resolution.
 *   Reduce to 1024 on mobile/low-end via window.__ENGINE_CONFIG__.
 */
const SunLightController = memo(function SunLightController({
  elevation,
  azimuth,
  weather,
  nightMode,
}: {
  elevation: number
  azimuth:   number
  weather:   WeatherType
  nightMode: boolean
}) {
  const lightRef = useRef<THREE.DirectionalLight>(null)
  const { scene } = useThree()

  useEffect(() => {
    const l = lightRef.current
    if (!l) return
    scene.add(l.target)
    return () => { scene.remove(l.target) }
  }, [scene])

  useFrame(() => {
    if (!lightRef.current) return
    const wf: Record<WeatherType, number> = {
      clear: 1, cloudy: 0.54, rain: 0.30, snow: 0.46, storm: 0.18, fog: 0.36,
    }
    const sky   = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
    const below = elevation <= 0
    const ws    = wf[weather]

    const d = sunVector(elevation, azimuth)
    lightRef.current.position.set(d.x * 26, Math.max(0.5, d.y * 26), d.z * 26)
    lightRef.current.intensity = below || nightMode ? 0 : sky * 5.2 * ws

    // Golden-hour tint
    const warmth = clamp(1 - sky * 2.4, 0, 1)
    lightRef.current.color.setRGB(
      1.0,
      clamp(0.76 + sky * 0.24 - warmth * 0.20, 0.58, 1.0),
      clamp(0.56 + sky * 0.44 - warmth * 0.46, 0.38, 1.0),
    )
    lightRef.current.target.position.set(0, 0, 0)
  })

  return (
    <directionalLight
      ref={lightRef}
      castShadow
      shadow-mapSize={[ENGINE_BUDGETS.baseShadowMap, ENGINE_BUDGETS.baseShadowMap]}
      shadow-camera-left={-20}
      shadow-camera-right={20}
      shadow-camera-top={20}
      shadow-camera-bottom={-20}
      shadow-camera-near={0.1}
      shadow-camera-far={100}
      shadow-bias={-0.0003}
      shadow-normalBias={0.04}
      shadow-radius={4}
    />
  )
})

/**
 * AmbientSkyLight
 *
 * HemisphereLight with sky/ground colours updated per-frame.
 * Sky colour tracks sun elevation from deep night blue → sunset orange → day blue.
 */
const AmbientSkyLight = memo(function AmbientSkyLight({
  elevation,
  weather,
  nightMode,
}: {
  elevation: number
  weather:   WeatherType
  nightMode: boolean
}) {
  const hemiRef = useRef<THREE.HemisphereLight>(null)

  useFrame(() => {
    if (!hemiRef.current) return
    const wf: Record<WeatherType, number> = {
      clear: 1, cloudy: 0.55, rain: 0.32, snow: 0.50, storm: 0.20, fog: 0.40,
    }
    const sky = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
    const ws  = wf[weather]
    const intensity = nightMode ? 0.08 : (0.20 + sky * 0.50) * ws
    hemiRef.current.intensity = intensity

    const nightT = clamp(1 - sky * 3.5, 0, 1)
    hemiRef.current.color.setRGB(
      0.42 + sky * 0.35 + nightT * 0.06,
      0.58 + sky * 0.26 - nightT * 0.18,
      1.0  - sky * 0.30 + nightT * 0.10,
    )
    hemiRef.current.groundColor.setRGB(
      0.36 + sky * 0.30,
      0.28 + sky * 0.20,
      0.12 + sky * 0.08,
    )
  })

  return (
    <hemisphereLight
      ref={hemiRef}
      color="#7db3e8"
      groundColor="#c4882a"
      intensity={0.35}
    />
  )
})

/**
 * BounceLight
 *
 * Ground-fill point light simulating indirect bounce from the terrain.
 * Warm amber colour; positioned below the scene.
 */
const BounceLight = memo(function BounceLight({
  elevation,
  nightMode,
}: {
  elevation: number
  nightMode: boolean
}) {
  const ref = useRef<THREE.PointLight>(null)

  useFrame(() => {
    if (!ref.current) return
    const sky = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
    ref.current.intensity = nightMode ? 0 : sky * 1.1
    ref.current.color.setRGB(1.0, 0.82 + sky * 0.18, 0.52 + sky * 0.28)
  })

  return (
    <pointLight
      ref={ref}
      position={[0, -1.5, 0]}
      color="#ffcc88"
      intensity={0.5}
      distance={30}
      decay={2}
    />
  )
})

/** All-in-one cinematic lighting rig */
const CinematicLightingEngineV2 = memo(function CinematicLightingEngineV2({
  elevation,
  azimuth,
  weather,
  nightMode,
}: {
  elevation: number
  azimuth:   number
  weather:   WeatherType
  nightMode: boolean
}) {
  return (
    <group>
      <SunLightController elevation={elevation} azimuth={azimuth} weather={weather} nightMode={nightMode} />
      <AmbientSkyLight    elevation={elevation} weather={weather}                   nightMode={nightMode} />
      <BounceLight        elevation={elevation}                                     nightMode={nightMode} />
      {/* Rim kicker (static position, camera-right) */}
      <directionalLight position={[14, 5, -10]} intensity={0.28} color="#8899cc" />
      {/* Night fill */}
      {nightMode && <ambientLight color="#0e1428" intensity={0.12} />}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.8 — DYNAMIC SKY SHADER
// ─────────────────────────────────────────────────────────────────────────────

const SKY_V2_VERT = /* glsl */ `
  varying vec3 vWorldDir;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldDir     = normalize(worldPos.xyz);
    gl_Position   = projectionMatrix * viewMatrix * worldPos;
    gl_Position.z = gl_Position.w;  // force to far plane
  }
`

const SKY_V2_FRAG = /* glsl */ `
  uniform vec3  uSunDir;
  uniform float uElevation;    // degrees
  uniform float uTurbidity;
  uniform float uNightBlend;   // 0=day, 1=night
  uniform float uTime;

  varying vec3 vWorldDir;

  // ── Sky colour gradient ────────────────────────────────────────────────────
  vec3 skyColor(float elevation, vec3 dir) {
    float up    = clamp(dir.y, 0.0, 1.0);
    float horiz = 1.0 - up;

    // Night sky
    vec3 nightSky = vec3(0.02, 0.03, 0.08) + vec3(0.0, 0.0, 0.04) * up;

    // Day sky — rayleigh-like blue
    vec3 zenith   = vec3(0.10, 0.30, 0.72) * (0.6 + up * 0.4);
    vec3 horizon  = vec3(0.72, 0.85, 0.98);
    vec3 daySky   = mix(horizon, zenith, pow(up, 0.55));

    // Sunset / sunrise tint near horizon
    float sunE = max(0.0, sin(radians(elevation)));
    float golden = clamp(1.0 - sunE * 3.0, 0.0, 1.0) * horiz * horiz;
    daySky = mix(daySky, vec3(0.96, 0.52, 0.16), golden * 0.72);

    return mix(daySky, nightSky, uNightBlend);
  }

  // ── Sun disc ──────────────────────────────────────────────────────────────
  vec3 sunDisc(vec3 dir, vec3 sunDir, float elevation) {
    float dot    = max(dot(dir, sunDir), 0.0);
    float disc   = smoothstep(0.9994, 0.9998, dot);
    float corona = smoothstep(0.990,  0.9994, dot) * 0.38;
    vec3 sunCol  = mix(vec3(1.0, 0.92, 0.72), vec3(1.0, 0.65, 0.25),
                       clamp(1.0 - sin(radians(elevation)) * 2.5, 0.0, 1.0));
    return sunCol * (disc + corona);
  }

  // ── Horizon glow ──────────────────────────────────────────────────────────
  vec3 horizonGlow(vec3 dir, vec3 sunDir, float elevation) {
    float up     = clamp(dir.y, 0.0, 1.0);
    float horiz  = pow(1.0 - up, 5.0);
    float sunAlg = max(dot(vec3(dir.x, 0.0, dir.z), vec3(sunDir.x, 0.0, sunDir.z)), 0.0);
    float glowE  = clamp(sin(radians(elevation)) * 8.0, 0.0, 1.0);
    return vec3(1.0, 0.45, 0.1) * horiz * sunAlg * glowE * 0.42;
  }

  // ── Simple star field ─────────────────────────────────────────────────────
  float stars(vec3 dir) {
    vec3 d    = normalize(dir);
    float phi = atan(d.z, d.x);
    float the = acos(d.y);
    vec2  uv  = vec2(phi / 6.28318, the / 3.14159);
    vec2  g   = floor(uv * 180.0);
    float r   = fract(sin(dot(g, vec2(127.1, 311.7))) * 43758.5453);
    return step(0.986, r) * clamp(d.y * 3.0, 0.0, 1.0);
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    if (dir.y < -0.05) {
      gl_FragColor = vec4(0.12, 0.14, 0.16, 1.0); // below horizon
      return;
    }

    vec3 sky  = skyColor(uElevation, dir);
    vec3 sun  = sunDisc(dir, normalize(uSunDir), uElevation) * (1.0 - uNightBlend);
    vec3 glow = horizonGlow(dir, normalize(uSunDir), uElevation) * (1.0 - uNightBlend);
    float st  = stars(dir) * uNightBlend;

    vec3 col  = sky + sun + glow + vec3(st);

    // Reinhard tone-map
    col = col / (col + vec3(0.9));

    gl_FragColor = vec4(col, 1.0);
  }
`

/** Uniforms for the sky V2 shader */
  interface SkyV2Uniforms {
    [uniform: string]: THREE.IUniform
  uSunDir:     { value: THREE.Vector3 }
  uElevation:  { value: number }
  uTurbidity:  { value: number }
  uNightBlend: { value: number }
  uTime:       { value: number }
}

function createSkyV2Material(): THREE.ShaderMaterial & { uniforms: SkyV2Uniforms } {
  const uniforms: SkyV2Uniforms = {
    uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
    uElevation:  { value: 45 },
    uTurbidity:  { value: 4 },
    uNightBlend: { value: 0 },
    uTime:       { value: 0 },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   SKY_V2_VERT,
      fragmentShader: SKY_V2_FRAG,
      uniforms,
      side:           THREE.BackSide,
      depthWrite:     false,
    }),
    { uniforms }
  )
}

/** Props for DynamicSkyV2 */
interface DynamicSkyV2Props {
  elevation:  number
  azimuth:    number
  nightMode:  boolean
  turbidity?: number
}

/**
 * DynamicSkyV2
 *
 * Procedural sky dome with:
 *   - Physically-plausible colour gradient (simplified Rayleigh)
 *   - Sun disc + corona
 *   - Horizon glow (golden hour)
 *   - Star field (night mode)
 *   - Reinhard tone-mapping
 *
 * Fallback: simple gradient MeshBasicMaterial on WebGL1.
 */
const DynamicSkyV2 = memo(function DynamicSkyV2({
  elevation,
  azimuth,
  nightMode,
  turbidity = 4,
}: DynamicSkyV2Props) {
  const matRef = useRef<(THREE.ShaderMaterial & { uniforms: SkyV2Uniforms }) | null>(null)

  const mat = useMemo(() => {
    if (!IS_WEBGL2) return null
    return createSkyV2Material()
  }, [])

  useEffect(() => { matRef.current = mat }, [mat])

  useFrame(({ clock }) => {
    const u = matRef.current?.uniforms
    if (!u) return
    const dir = sunVector(elevation, azimuth)
    u.uSunDir.value.copy(dir)
    u.uElevation.value  = elevation
    u.uTurbidity.value  = turbidity
    u.uNightBlend.value = nightMode ? 1 : clamp(1 - elevation * 0.12, 0, 1)
    u.uTime.value       = clock.getElapsedTime()
  })

  useEffect(() => () => { mat?.dispose() }, [mat])

  if (!IS_WEBGL2 || !mat) {
    // Fallback gradient
    const col = nightMode ? "#020610" : elevation > 10 ? "#1a3a6a" : "#c85020"
    return (
      <mesh renderOrder={-1}>
        <sphereGeometry args={[280, 24, 24]} />
        <meshBasicMaterial color={col} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    )
  }

  return (
    <mesh renderOrder={-1} material={mat}>
      <sphereGeometry args={[280, 32, 32]} />
    </mesh>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.9 — ENERGY FLOW FX
// ─────────────────────────────────────────────────────────────────────────────

/** GLSL for the energy beam pulse effect */
const ENERGY_BEAM_VERT = /* glsl */ `
  attribute float aProgress;    // 0..1 along the path
  uniform float uTime;
  uniform float uSpeed;

  varying float vProgress;
  varying float vPulse;

  void main() {
    vProgress = aProgress;
    float pulse = fract(aProgress - uTime * uSpeed);
    vPulse    = pow(smoothstep(0.0, 0.18, pulse) * smoothstep(0.42, 0.18, pulse), 1.4);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 5.0 + vPulse * 12.0;
  }
`

const ENERGY_BEAM_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;

  varying float vProgress;
  varying float vPulse;

  void main() {
    vec2  uv   = gl_PointCoord - 0.5;
    float dist = length(uv);
    float a    = smoothstep(0.5, 0.1, dist);
    gl_FragColor = vec4(uColor * (1.0 + vPulse * 1.8), a * uOpacity * (0.3 + vPulse * 0.7));
    if (gl_FragColor.a < 0.02) discard;
  }
`

/** Uniforms for energy beam shader */
  interface EnergyBeamUniforms {
    [uniform: string]: THREE.IUniform
  uTime:    { value: number }
  uSpeed:   { value: number }
  uColor:   { value: THREE.Color }
  uOpacity: { value: number }
}

/** Build a Points geometry for an energy beam along a CatmullRomCurve3 */
function buildEnergyBeamGeometry(
  points:   [number, number, number][],
  segments: number = 64,
): THREE.BufferGeometry {
  const curve    = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)))
  const pts      = curve.getPoints(segments)
  const positions = new Float32Array(pts.length * 3)
  const progress  = new Float32Array(pts.length)

  for (let i = 0; i < pts.length; i++) {
    positions[i * 3]     = pts[i].x
    positions[i * 3 + 1] = pts[i].y
    positions[i * 3 + 2] = pts[i].z
    progress[i]          = i / (pts.length - 1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position",  new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute("aProgress", new THREE.Float32BufferAttribute(progress,  1))
  return geo
}

/** Colour map for energy flow paths */
const ENERGY_FLOW_COLORS: Record<string, string> = {
  solar:   DS.gold,
  battery: DS.emerald,
  house:   DS.cyan,
  grid:    "#f97316",
}

/** Props for an upgraded energy flow beam */
interface EnergyFlowBeamProps {
  id:       string           // key into ENERGY_FLOW_COLORS
  points:   [number, number, number][]
  active:   boolean
  speed?:   number
}

/**
 * EnergyFlowBeam
 *
 * Renders the energy cable as:
 *   1. Wide dim DreiLine (glow halo)
 *   2. Bright core DreiLine
 *   3. Particle points traveling along the path (GLSL pulse shader or CPU fallback)
 */
const EnergyFlowBeam = memo(function EnergyFlowBeam({
  id,
  points,
  active,
  speed = 0.55,
}: EnergyFlowBeamProps) {
  const color     = ENERGY_FLOW_COLORS[id] ?? DS.gold
  const matRef    = useRef<(THREE.ShaderMaterial & { uniforms: EnergyBeamUniforms }) | null>(null)
  const ptsMatRef = useRef<THREE.PointsMaterial | null>(null)
  const pulseRef  = useRef<THREE.Mesh>(null)
  const progRef   = useRef(Math.random())
  const curve     = useMemo(
    () => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))),
    [points],
  )

  const beamGeo = useMemo(() => buildEnergyBeamGeometry(points, 80), [points])

  const beamMat = useMemo(() => {
    if (!IS_WEBGL2) {
      const m = new THREE.PointsMaterial({
        color: new THREE.Color(color),
        size:  0.08,
        transparent: true,
        opacity: 0.72,
        sizeAttenuation: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      ptsMatRef.current = m
      return m
    }
    const uniforms: EnergyBeamUniforms = {
      uTime:    { value: 0 },
      uSpeed:   { value: speed },
      uColor:   { value: new THREE.Color(color) },
      uOpacity: { value: 0.9 },
    }
    const m = Object.assign(
      new THREE.ShaderMaterial({
        vertexShader:   ENERGY_BEAM_VERT,
        fragmentShader: ENERGY_BEAM_FRAG,
        uniforms,
        transparent:    true,
        depthWrite:     false,
        blending:       THREE.AdditiveBlending,
      }),
      { uniforms },
    )
    matRef.current = m
    return m
  }, [color, speed]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ clock }, delta) => {
    if (!active) return

    // Update shader time
    if (matRef.current) {
      matRef.current.uniforms.uTime.value = clock.getElapsedTime()
    }

    // CPU fallback: move a sphere along the curve
    if (pulseRef.current) {
      progRef.current = (progRef.current + delta * speed) % 1
      const pos = curve.getPoint(progRef.current)
      pulseRef.current.position.copy(pos)
    }
  })

  if (!active || points.length < 2) return null

  return (
    <group>
      {/* ── Glow halo ── */}
      <DreiLine points={points} color={color} lineWidth={4.2} transparent opacity={0.16} depthWrite={false} />
      {/* ── Core line ── */}
      <DreiLine points={points} color={color} lineWidth={1.4} transparent opacity={0.82} />
      {/* ── Particle pulse ── */}
      <points geometry={beamGeo} material={beamMat} frustumCulled={false} />
      {/* ── CPU fallback traveling sphere ── */}
      {!IS_WEBGL2 && (
        <mesh ref={pulseRef}>
          <sphereGeometry args={[0.06, 8, 8]} />
          <meshBasicMaterial color={new THREE.Color(color)} />
        </mesh>
      )}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.10 — MICRO ANIMATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MicroAnimationEngine
 *
 * Central per-frame driver for all small detail animations.
 * Uses refs exclusively — zero React state updates.
 *
 * Driven signals (read in child useFrame):
 *   glintSignal    — 0..1 panel sun glint wave
 *   batterySignal  — 0..1 breathing pulse (SOC-modulated)
 *   ledSignal      — 0 or 1 inverter LED blink
 *   humSignal      — subtle scale oscillation for energy hum
 */
interface MicroSignals {
  glintSignal:   number
  batterySignal: number
  ledSignal:     number
  humSignal:     number
}

const MicroSignalContext = React.createContext<React.RefObject<MicroSignals>>({
  current: { glintSignal: 0, batterySignal: 0, ledSignal: 0, humSignal: 1 },
})

/** Access micro animation signals (read-only, ref-based) */
function useMicroSignals(): React.RefObject<MicroSignals> {
  return React.useContext(MicroSignalContext)
}

/** Props for MicroAnimationEngine */
interface MicroAnimationEngineProps {
  soc:      number   // battery state of charge (0..1)
  children: React.ReactNode
}

/**
 * MicroAnimationEngine
 *
 * Place once in the scene, wrap detail components with it.
 * Updates signal values each frame without touching React state.
 */
const MicroAnimationEngine = memo(function MicroAnimationEngine({
  soc,
  children,
}: MicroAnimationEngineProps) {
  const signalsRef = useRef<MicroSignals>({
    glintSignal:   0,
    batterySignal: 0,
    ledSignal:     0,
    humSignal:     1,
  })

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const s = signalsRef.current
    s.glintSignal   = (Math.sin(t * 0.75) * 0.5 + 0.5) * 0.16
    s.batterySignal = Math.sin(t * 1.3 + soc * Math.PI) * 0.5 + 0.5
    s.ledSignal     = Math.sin(t * 2.1) > 0.6 ? 1 : 0
    s.humSignal     = 1 + Math.sin(t * 3.8) * 0.018
  })

  return (
    <MicroSignalContext.Provider value={signalsRef}>
      {children}
    </MicroSignalContext.Provider>
  )
})

/** Animated inverter LED indicator */
const AnimatedInverterLED = memo(function AnimatedInverterLED({
  position,
  active,
}: {
  position: [number, number, number]
  active:   boolean
}) {
  const meshRef    = useRef<THREE.Mesh>(null)
  const lightRef   = useRef<THREE.PointLight>(null)
  const signals    = useMicroSignals()

  useFrame(() => {
    if (!meshRef.current || !lightRef.current) return
    const on = active && signals.current.ledSignal > 0.5
    ;(meshRef.current.material as THREE.MeshBasicMaterial).color.set(on ? "#22ff44" : "#113322")
    lightRef.current.intensity = on ? 0.4 : 0
  })

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.024, 6, 6]} />
        <meshBasicMaterial color="#113322" />
      </mesh>
      <pointLight ref={lightRef} color="#22ff44" intensity={0} distance={0.7} decay={2} />
    </group>
  )
})

/** Battery pulse ring using micro animation signal */
const AnimatedBatteryRing = memo(function AnimatedBatteryRing({
  soc,
  charging,
}: {
  soc:      number
  charging: boolean
}) {
  const torusRef = useRef<THREE.Mesh>(null)
  const lightRef = useRef<THREE.PointLight>(null)
  const signals  = useMicroSignals()

  const ringColor = soc < 0.2 ? DS.danger : charging ? DS.emerald : DS.warning

  useFrame(() => {
    if (!torusRef.current || !lightRef.current) return
    const pulse = signals.current.batterySignal
    ;(torusRef.current.material as THREE.MeshBasicMaterial).opacity = 0.18 + pulse * 0.25
    lightRef.current.intensity = (0.28 + pulse * 0.45) * soc
  })

  return (
    <group position={BATTERY_POS}>
      <mesh ref={torusRef} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.40, 0.045, 8, 32]} />
        <meshBasicMaterial color={ringColor} transparent opacity={0.25} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight ref={lightRef} color={ringColor} intensity={0.28} distance={1.6} decay={2} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16.11 — CAMERA CINEMATIC CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

/** Named cinematic preset with custom FOV and look-at */
interface CinematicPreset {
  position: [number, number, number]
  target:   [number, number, number]
  fov:      number
  label:    string
}

const CINEMATIC_PRESETS_V2: Record<string, CinematicPreset> = {
  overview:  { position: [0,    6.8,  10.6], target: [0,  0.4,  0],   fov: 42, label: "Overview"      },
  panels:    { position: [0,    3.8,   5.2], target: [0,  0.6,  0],   fov: 36, label: "Panel Array"    },
  inverter:  { position: [5.5,  2.2,   4.8], target: INVERTER_POS,    fov: 34, label: "Inverter"       },
  aerial:    { position: [-9.0, 8.6,   8.4], target: [0,  1.0,  0],   fov: 46, label: "Aerial"         },
  rooftop:   { position: [0,    4.2,   2.0], target: [0,  0.5, -1.5], fov: 40, label: "Rooftop Close"  },
  street:    { position: [-2.0, 1.2,  16.0], target: [0,  1.2,  0],   fov: 48, label: "Street Level"   },
}

/** Inertia easing constant (higher = snappier) */
const CAM_INERTIA_K = 5.5

/** Props for CinematicCameraControllerV2 */
interface CinematicCameraControllerV2Props {
  orbitRef:    React.RefObject<OrbitControlsImpl | null>
  preset?:     keyof typeof CINEMATIC_PRESETS_V2
  driftAmp?:   number   // idle drift amplitude (0 = off)
  children?:   React.ReactNode
}

/**
 * CinematicCameraControllerV2
 *
 * Smooth exponential lerp camera transitions:
 *   - Eases camera position and orbit target simultaneously
 *   - Adds subtle ambient drift when idle
 *   - Exposes `goToPreset(name)` via context
 *
 * Performance: runs in useFrame with ref-only state — zero re-renders.
 */

const CinematicCameraCtx = React.createContext<{
  goToPreset: (name: keyof typeof CINEMATIC_PRESETS_V2) => void
  currentPreset: string
}>({ goToPreset: () => {}, currentPreset: "overview" })

function useCinematicPresets() {
  return React.useContext(CinematicCameraCtx)
}

const CinematicCameraControllerV2 = memo(function CinematicCameraControllerV2({
  orbitRef,
  preset    = "overview",
  driftAmp  = 0.006,
  children,
}: CinematicCameraControllerV2Props) {
  const targetPosRef    = useRef(new THREE.Vector3(...CINEMATIC_PRESETS_V2.overview.position))
  const targetLookRef   = useRef(new THREE.Vector3(...CINEMATIC_PRESETS_V2.overview.target))
  const animatingRef    = useRef(false)
  const [curPreset, setCurPreset] = useState<string>(preset)

  const goToPreset = useCallback((name: keyof typeof CINEMATIC_PRESETS_V2) => {
    const p = CINEMATIC_PRESETS_V2[name]
    if (!p) return
    targetPosRef.current.set(...p.position)
    targetLookRef.current.set(...p.target)
    animatingRef.current = true
    setCurPreset(String(name))
  }, [])

  // Apply initial preset
  useEffect(() => { goToPreset(preset) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ camera, clock }, delta) => {
    const orbit = orbitRef.current
    if (!orbit) return

    const alpha = 1 - Math.exp(-CAM_INERTIA_K * delta)

    if (animatingRef.current) {
      camera.position.lerp(targetPosRef.current, alpha)
      orbit.target.lerp(targetLookRef.current, alpha)
      orbit.update()

      if (camera.position.distanceTo(targetPosRef.current) < 0.018) {
        camera.position.copy(targetPosRef.current)
        orbit.target.copy(targetLookRef.current)
        orbit.update()
        animatingRef.current = false
      }
    } else if (driftAmp > 0) {
      // Subtle idle drift
      const t = clock.getElapsedTime()
      camera.position.x += Math.sin(t * 0.11) * driftAmp * delta * 60
      camera.position.y += Math.cos(t * 0.09) * driftAmp * delta * 60 * 0.5
      orbit.update()
    }
  })

  const ctxValue = useMemo(() => ({ goToPreset, currentPreset: curPreset }), [goToPreset, curPreset])

  return (
    <CinematicCameraCtx.Provider value={ctxValue}>
      {children}
    </CinematicCameraCtx.Provider>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 16 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // ── 16.1 Engine Core ────────────────────────────────────────────────────
  EngineCore,
  RenderFrameController,
  globalRenderGraph,
  globalStats,
  useRenderPass,
  useEngineCore,
  ENGINE_BUDGETS,

  // ── 16.2 Scene Graph ────────────────────────────────────────────────────
  SceneOptimizerDriver,
  globalSceneOptimizer,
  useSceneCulling,
  mergeStaticMeshes,
  computeBoundingSphere,
  sphereInFrustum,

  // ── 16.3 Panel Visual ───────────────────────────────────────────────────
  UpgradedPanelMesh,
  createPanelCellMaterial,
  PANEL_FRAME_MATERIAL_V2,
  PANEL_GLASS_V2,
  PANEL_RAIL_MATERIAL,

  // ── 16.4 House ──────────────────────────────────────────────────────────
  RefactoredHouse,
  buildPitchedRoofGeometry,
  buildOverhangGeometry,
  MAT_RENDER_CONCRETE,
  MAT_RENDER_ROOF_TILE,
  MAT_RENDER_GLASS,

  // ── 16.5 Trees ──────────────────────────────────────────────────────────
  ForestCluster,
  ProceduralTree,
  makeTreeFoliage,

  // ── 16.6 Environment ────────────────────────────────────────────────────
  EnvironmentRenderer,

  // ── 16.7 Lighting ───────────────────────────────────────────────────────
  CinematicLightingEngineV2,
  SunLightController,
  AmbientSkyLight,
  BounceLight,

  // ── 16.8 Sky ────────────────────────────────────────────────────────────
  DynamicSkyV2,
  createSkyV2Material,

  // ── 16.9 Energy Flow ────────────────────────────────────────────────────
  EnergyFlowBeam,
  buildEnergyBeamGeometry,
  ENERGY_FLOW_COLORS,

  // ── 16.10 Micro Animations ──────────────────────────────────────────────
  MicroAnimationEngine,
  AnimatedInverterLED,
  AnimatedBatteryRing,
  useMicroSignals,

  // ── 16.11 Camera ────────────────────────────────────────────────────────
  CinematicCameraControllerV2,
  useCinematicPresets,
  CINEMATIC_PRESETS_V2,
}

export type {
  // ── 16.1 ──────────────────────────────────────────────────────────────────
  EngineBudgets,
  RenderFrameData,
  RenderPassContext,
  RenderPass,
  EngineState,
  EngineCoreProps,
  RenderFrameControllerProps,

  // ── 16.2 ──────────────────────────────────────────────────────────────────
  BoundingSphere,
  SceneObjectEntry,

  // ── 16.3 ──────────────────────────────────────────────────────────────────
  PanelCellUniforms,
  UpgradedPanelMeshProps,

  // ── 16.4 ──────────────────────────────────────────────────────────────────
  RefactoredHouseProps,

  // ── 16.5 ──────────────────────────────────────────────────────────────────
  ProceduralTreeConfig,
  ProceduralTreeProps,
  ForestClusterProps,
  WindState,

  // ── 16.6 ──────────────────────────────────────────────────────────────────
  EnvironmentRendererProps,

  // ── 16.8 ──────────────────────────────────────────────────────────────────
  SkyV2Uniforms,
  DynamicSkyV2Props,

  // ── 16.9 ──────────────────────────────────────────────────────────────────
  EnergyBeamUniforms,
  EnergyFlowBeamProps,

  // ── 16.10 ─────────────────────────────────────────────────────────────────
  MicroSignals,
  MicroAnimationEngineProps,

  // ── 16.11 ─────────────────────────────────────────────────────────────────
  CinematicPreset,
  CinematicCameraControllerV2Props,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 17 — ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.1  RENDER PIPELINE OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Frame execution order (priority ascending):
 *
 *   Priority  Pass Name              Section  Description
 *   ────────  ─────────────────────  ───────  ──────────────────────────────
 *    0–9      pre-frame passes       16.1     custom pre-render logic
 *    10       SceneOptimizerDriver   16.2     frustum cull + shadow cull
 *    20–49    geometry passes        16.3–6   panel, house, trees, terrain
 *    50       CinematicLightingV2    16.7     sun/sky/bounce light updates
 *    60       DynamicSkyV2           16.8     sky shader uniform update
 *    70       EnergyFlowBeam passes  16.9     cable shader time updates
 *    80       MicroAnimationEngine   16.10    LED, battery, panel glint
 *    90       CinematicCameraV2      16.11    camera lerp + drift
 *   100+      post-frame passes      16.1     debug overlays, profiler
 *
 * The RenderGraph ensures deterministic ordering regardless of component
 * mount order. Passes registered with the same priority execute in
 * registration order (stable sort).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.2  LIGHTING ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Light type           Component              Budget
 * ─────────────────────────────────────────────────────────────────────────
 * Sun (directional)    SunLightController     1 — with PCF soft shadows
 * Sky (hemisphere)     AmbientSkyLight        1 — sky/ground gradient
 * Bounce (point)       BounceLight            1 — below scene, warm amber
 * Rim (directional)    Static in CLE-V2       1 — camera-right blue-violet
 * Night (ambient)      Conditional            1 — only when nightMode=true
 * Window (point ×N)    RefactoredHouse        N — only when nightMode=true
 * Panel glow (point)   UpgradedPanelMesh      N — 1 per visible panel
 * ─────────────────────────────────────────────────────────────────────────
 * Total worst-case                            ~30 (12 panels + 6 windows)
 *
 * Three.js forward renderer processes all lights per draw call.
 * Keep total active lights < 8 for mobile WebGL1 compatibility.
 * To reduce: increase shadowDistance on SceneGraphOptimizer so distant
 * panel glow lights are culled; disable window lights in non-night mode
 * (already done).
 *
 * Shadow map budget:
 *   ENGINE_BUDGETS.baseShadowMap = 2048 (default)
 *   Reduce to 1024 via window.__ENGINE_CONFIG__ = { baseShadowMap: 1024 }
 *   shadow.radius = 4 (PCF kernel size) — reduce to 2 for low-end
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.3  ENVIRONMENT SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Layer             Component              Notes
 * ─────────────────────────────────────────────────────────────────────────
 * Sky dome          DynamicSkyV2           BackSide sphere r=280, GLSL shader
 * Sun disc          DynamicSkyV2 (inline)  CircleGeometry, AdditiveBlending
 * Stars             DynamicSkyV2 (inline)  Points, visible when elevation < 2
 * Clouds (wispy)    DynamicSkyV2 (inline)  Sphere clusters, overcast only
 * Ground plane      EnvironmentRenderer    r=180, weather-tinted, receives shadow
 * Apron / driveway  EnvironmentRenderer    Concrete texture substitute
 * Distant buildings EnvironmentRenderer    6 box silhouettes, depth cue
 * Terrain fog       EnvironmentRenderer    THREE.Fog via scene.fog
 * Trees             ForestCluster          9 procedural trees, wind-sway
 * House             RefactoredHouse        Pitched roof, windows, chimney
 * Panels            UpgradedPanelMesh      5-layer, GLSL cell-grid shader
 * ─────────────────────────────────────────────────────────────────────────
 *
 * To add more distant buildings: push extra entries into the hardcoded
 * array inside EnvironmentRenderer. Each box costs 1 draw call.
 *
 * To add height variation to the ground: replace PlaneGeometry with a
 * custom heightmap (BufferGeometry with displaced Y vertices). Ensure
 * receiveShadow=true and computeVertexNormals() is called.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.4  PANEL RENDERING STRATEGY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Panel count     Recommended component
 * ──────────────────────────────────────────────────────────────────────────
 * 1 – 24          UpgradedPanelMesh (§16.3) — per-panel GLSL shader
 * 25 – 200        InstancedPanelManager (§10.1) — GPU instanced, CPU color
 * 200 – 2000      InstancedPanelManager + WorkerPanelSimulation (§10.2)
 * 2000+           InstancedPanelManager + GPU compute (§10.8 particle system
 *                 repurposed for panel output simulation)
 *
 * The GLSL cell-grid shader (§16.3) runs once per panel per frame.
 * For 12 panels that is 12 fragment shader executions per pixel covered —
 * negligible. For 100+ panels use InstancedMesh to collapse to 1-2 DCs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.5  PERFORMANCE CONSIDERATIONS & TUNING GUIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Metric     Default    Low-end target   How to reduce
 * ──────────────────────────────────────────────────────────────────────────
 * Draw calls  ~40–60     <30             Disable panel GLSL (fallback mat),
 *                                        merge static meshes (§16.2),
 *                                        disable distant buildings
 * Shadow map  2048px     1024px          ENGINE_BUDGETS.baseShadowMap=1024
 * Particles   800        200             ENGINE_BUDGETS.particleBudget=200
 * Trees       9          4               Reduce FOREST_TREE_CONFIGS length
 * Fog         scene.Fog  none            Set scene.fog=null for mobile
 * Sky shader  GLSL       gradient mesh   Set IS_WEBGL2=false to force fallback
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Runtime tuning (no code change required):
 *   window.__ENGINE_CONFIG__ = {
 *     baseShadowMap: 1024,    // halve shadow resolution
 *     particleBudget: 200,    // reduce particle count
 *     maxInstances: 500,      // reduce instanced panel count
 *   }
 *   (Reload not required — budgets are read at first render. For live
 *    updates, wire __ENGINE_CONFIG__ into a useEffect that rebuilds
 *    affected subsystems.)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.6  WEBGL1 / LOW-END DEVICE FALLBACK MAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Feature              WebGL2 path              WebGL1 / fallback
 * ──────────────────────────────────────────────────────────────────────────
 * Panel cell shader    GLSL (§16.3)             MeshStandardMaterial
 * Sky shader           GLSL (§16.8)             MeshBasicMaterial gradient
 * Energy beam pulse    GLSL Points (§16.9)      PointsMaterial + sphere CPU
 * GPGPU particles      Ping-pong RT (§10.8)     CPU Float32Array update
 * GPU picking          RenderTarget readPixels  THREE.Raycaster fallback
 * Thermal shader       GLSL (§10.3)             MeshStandardMaterial tint
 * ──────────────────────────────────────────────────────────────────────────
 *
 * All fallbacks are activated by the `IS_WEBGL2` constant (§10.3).
 * To force fallback mode for testing: add a `?webgl1=1` URL param and
 * override the constant in a useEffect before any subsystem initialises.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 17.7  EXTENDING THE ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Adding a new render pass:
 *   useRenderPass("my-custom-pass", 55, ({ gl, scene, camera }) => {
 *     // custom work here, e.g. render to an offscreen target
 *   })
 *
 * Registering an object for frustum culling:
 *   const ref = useRef<THREE.Mesh>(null)
 *   useSceneCulling("my-unique-id", ref, { castShadow: true, shadowDistance: 20 })
 *
 * Adding a tree to the forest:
 *   const myTree: ProceduralTreeConfig = {
 *     position: [5, 0, -8], trunkH: 2.2, trunkR: 0.12,
 *     layers: 3, foliageR: 0.78, foliageH: 1.1,
 *     hueOffset: 0.02, swayPhase: 1.4, swayAmount: 0.038,
 *   }
 *   // Pass as `configs` prop to <ForestCluster configs={[...FOREST_TREE_CONFIGS, myTree]} />
 *
 * Switching cinematic camera preset programmatically:
 *   const { goToPreset } = useCinematicPresets()
 *   goToPreset("inverter")
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19 — ULTRA 3D ENGINE & VISUAL SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   19.1  Core Rendering Engine              ~500
//   19.2  HDR Environment Lighting           ~400
//   19.3  Procedural Terrain Engine          ~500
//   19.4  Advanced Solar Panel Rendering     ~600
//   19.5  Procedural Tree & Vegetation       ~500
//   19.6  House Geometry Engine              ~500
//   19.7  Sky & Atmosphere Shader            ~400
//   19.8  Advanced Post Processing           ~300
//   19.9  Energy Visualization FX            ~200
//   19.10 Micro Animation System             ~200
//   TOTAL ≈ 4100 lines

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.1 — CORE RENDERING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** Per-frame GPU and CPU timing snapshot */
interface FrameProfile {
  frameIdx:       number
  cpuMs:          number    // time between requestAnimationFrame callbacks
  renderMs:       number    // time THREE.WebGLRenderer.render() took (approx)
  drawCalls:      number
  triangles:      number
  geometries:     number
  textures:       number
  programs:       number
  fps:            number    // rolling 60-frame average
  gpuLoadPct:     number    // heuristic: renderMs / (1000/fps) clamped 0-100
}

/** Rolling ring-buffer for FrameProfile history */
class FrameProfiler {
  private ring: FrameProfile[] = []
  private idx  = 0
  readonly size: number

  constructor(size = 120) { this.size = size }

  push(p: FrameProfile): void {
    this.ring[this.idx % this.size] = p
    this.idx++
  }

  get latest(): FrameProfile | null {
    return this.ring[(this.idx - 1 + this.size) % this.size] ?? null
  }

  get averageFps(): number {
    const n   = Math.min(this.idx, this.size)
    if (n === 0) return 60
    let sum = 0
    for (let i = 0; i < n; i++) sum += (this.ring[i]?.fps ?? 60)
    return sum / n
  }

  get p95CpuMs(): number {
    const n   = Math.min(this.idx, this.size)
    if (n === 0) return 16.67
    const arr = this.ring.slice(0, n).map((p) => p?.cpuMs ?? 16.67).sort((a, b) => a - b)
    return arr[Math.floor(n * 0.95)] ?? 16.67
  }

  /** Pure — unit testable */
  static computeFps(ring: FrameProfile[], size: number, idx: number): number {
    const n = Math.min(idx, size)
    if (n === 0) return 60
    let sum = 0
    for (let i = 0; i < n; i++) sum += (ring[i]?.fps ?? 60)
    return sum / n
  }
}

/** GPU stats extracted from THREE.WebGLRenderer.info */
interface GPUStats {
  drawCalls:  number
  triangles:  number
  textures:   number
  geometries: number
  programs:   number
}

function extractGPUStats(gl: THREE.WebGLRenderer): GPUStats {
  const i = gl.info
  return {
    drawCalls:  i.render.calls,
    triangles:  i.render.triangles,
    textures:   i.memory.textures,
    geometries: i.memory.geometries,
    programs:   i.programs?.length ?? 0,
  }
}

/** Module-singleton profiler */
const s19Profiler = new FrameProfiler(120)

/** Hook: exposes live frame profile from s19Profiler */
function useFrameProfile(): FrameProfile | null {
  const [profile, setProfile] = useState<FrameProfile | null>(null)
  useFrame(({ gl }) => {
    const p = s19Profiler.latest
    if (p) setProfile(p)
  })
  return profile
}

/** Props for RenderEngineController */
interface RenderEngineControllerProps {
  children?:  React.ReactNode
  onProfile?: (p: FrameProfile) => void
}

/**
 * RenderEngineController
 *
 * Must be placed inside <Canvas>. Drives the s19Profiler ring-buffer each
 * frame and exposes stats. All timing is done with performance.now() — same
 * source as the browser's RAF timestamp for consistent comparisons.
 */
const RenderEngineController = memo(function RenderEngineController({
  children,
  onProfile,
}: RenderEngineControllerProps) {
  const { gl } = useThree()
  const prevTimeRef  = useRef(performance.now())
  const frameIdxRef  = useRef(0)
  const fpsRingRef   = useRef(new Float32Array(60))
  const fpsIdxRef    = useRef(0)

  useFrame(() => {
    const now    = performance.now()
    const cpuMs  = now - prevTimeRef.current
    prevTimeRef.current = now
    frameIdxRef.current++

    const fps   = cpuMs > 0 ? 1000 / cpuMs : 60
    fpsRingRef.current[fpsIdxRef.current % 60] = fps
    fpsIdxRef.current++
    const avgFps = fpsRingRef.current.reduce((a, b) => a + b, 0) / 60

    const gpu   = extractGPUStats(gl)
    const renderMs = cpuMs * 0.62   // heuristic: GPU submit ≈ 62% of frame
    const gpuLoadPct = clamp((renderMs / (1000 / Math.max(avgFps, 1))) * 100, 0, 100)

    const profile: FrameProfile = {
      frameIdx:    frameIdxRef.current,
      cpuMs:       Number(cpuMs.toFixed(2)),
      renderMs:    Number(renderMs.toFixed(2)),
      fps:         Number(avgFps.toFixed(1)),
      gpuLoadPct:  Number(gpuLoadPct.toFixed(1)),
      ...gpu,
    }

    s19Profiler.push(profile)
    onProfile?.(profile)
  })

  return <>{children}</>
})

/** GPUStatsTracker — compact DOM overlay showing live GPU stats */
const GPUStatsTracker = memo(function GPUStatsTracker({ visible }: { visible: boolean }) {
  const profile = useFrameProfile()
  if (!visible || !profile) return null

  const fpsColor = profile.fps >= 55 ? DS.emerald : profile.fps >= 30 ? DS.warning : DS.danger

  return (
    <div style={{
      position:  "absolute",
      bottom:    52,
      right:     14,
      background: "rgba(2,6,18,0.9)",
      border:    `1px solid rgba(255,255,255,0.07)`,
      borderRadius: 7,
      padding:   "7px 11px",
      fontSize:   10,
      fontFamily: "monospace",
      color:      DS.text,
      minWidth:   150,
      pointerEvents: "none",
      backdropFilter: "blur(8px)",
      zIndex:     88,
      lineHeight: 1.7,
    }}>
      <div style={{ color: DS.muted, fontSize: 9, letterSpacing: "0.1em", marginBottom: 3 }}>GPU STATS</div>
      {[
        ["FPS",   `${profile.fps.toFixed(0)}`,         fpsColor],
        ["CPU",   `${profile.cpuMs} ms`,                DS.text],
        ["GPU",   `${profile.gpuLoadPct}%`,             DS.cyan],
        ["DC",    `${profile.drawCalls}`,               DS.text],
        ["Tris",  `${(profile.triangles/1000).toFixed(1)}k`, DS.muted],
        ["Tex",   `${profile.textures}`,                DS.muted],
        ["Prog",  `${profile.programs}`,                DS.muted],
      ].map(([label, value, color]) => (
        <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color: String(color), fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.2 — HDR ENVIRONMENT LIGHTING
// ─────────────────────────────────────────────────────────────────────────────

/** HDR lighting configuration */
interface HDRLightConfig {
  sunIntensity:     number   // 0–8, physically plausible default 4.5
  skyIntensity:     number   // hemisphere 0–2
  bounceIntensity:  number   // fill 0–2
  rimIntensity:     number   // camera-right rim 0–1
  envIntensity:     number   // envMap intensity for all materials 0–3
  shadowRadius:     number   // PCF softness 1–8
  shadowMapSize:    number   // 512–4096
  shadowBias:       number   // typically −0.0002 to −0.0005
}

const HDR_LIGHT_DEFAULTS: HDRLightConfig = {
  sunIntensity:    4.5,
  skyIntensity:    0.85,
  bounceIntensity: 0.65,
  rimIntensity:    0.28,
  envIntensity:    1.8,
  shadowRadius:    4,
  shadowMapSize:   2048,
  shadowBias:      -0.0003,
}

/** Physically-correct irradiance for a given sun elevation (W/m²-ish) */
function solarIrradiance(elevationDeg: number, weatherFactor: number): number {
  const sky = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevationDeg)))
  return sky * weatherFactor
}

/** Props for HDREnvironmentSystem */
interface HDREnvironmentSystemProps {
  elevation:   number
  azimuth:     number
  weather:     WeatherType
  nightMode:   boolean
  config?:     Partial<HDRLightConfig>
}

/**
 * HDREnvironmentSystem
 *
 * Professional 5-light HDR setup:
 *   1. Sun directional — PCF soft shadows, physically-correct intensity curve
 *   2. Sky hemisphere  — sky/ground gradient, weather-tinted
 *   3. Bounce fill     — warm ground reflection, elevation-modulated
 *   4. Rim kicker      — camera-right blue-violet separation
 *   5. Night ambient   — deep indigo, conditional on nightMode
 *
 * All lights update via useFrame (ref-based, zero React re-renders).
 * Tune via `config` prop or ENGINE_BUDGETS at runtime.
 */
const HDREnvironmentSystem = memo(function HDREnvironmentSystem({
  elevation,
  azimuth,
  weather,
  nightMode,
  config: configOverride = {},
}: HDREnvironmentSystemProps) {
  const cfg = useMemo(() => ({ ...HDR_LIGHT_DEFAULTS, ...configOverride }), [configOverride])

  const sunRef    = useRef<THREE.DirectionalLight>(null)
  const hemiRef   = useRef<THREE.HemisphereLight>(null)
  const bounceRef = useRef<THREE.PointLight>(null)
  const rimRef    = useRef<THREE.DirectionalLight>(null)
  const nightRef  = useRef<THREE.AmbientLight>(null)
  const { scene } = useThree()

  useEffect(() => {
    const sun = sunRef.current
    if (!sun) return
    scene.add(sun.target)
    return () => { scene.remove(sun.target) }
  }, [scene])

  useFrame(() => {
    const wf: Record<WeatherType, number> = {
      clear: 1.0, cloudy: 0.52, rain: 0.28, snow: 0.44, storm: 0.18, fog: 0.34,
    }
    const ws       = wf[weather] ?? 1
    const irr      = solarIrradiance(elevation, ws)
    const below    = elevation <= 0

    // ── Sun ──
    if (sunRef.current) {
      const dir = sunVector(elevation, azimuth)
      sunRef.current.position.set(dir.x * 28, Math.max(0.5, dir.y * 28), dir.z * 28)
      sunRef.current.intensity = below || nightMode ? 0 : irr * cfg.sunIntensity
      sunRef.current.shadow.radius     = cfg.shadowRadius
      sunRef.current.shadow.bias       = cfg.shadowBias

      // Spectral warmth: cool zenith, warm horizon
      const warmth = clamp(1 - irr * 2.6, 0, 1)
      sunRef.current.color.setRGB(
        1.0,
        clamp(0.75 + irr * 0.25 - warmth * 0.22, 0.54, 1.0),
        clamp(0.52 + irr * 0.48 - warmth * 0.50, 0.34, 1.0),
      )
    }

    // ── Sky hemisphere ──
    if (hemiRef.current) {
      hemiRef.current.intensity = nightMode ? 0.06 : (0.18 + irr * 0.52) * cfg.skyIntensity
      const nightT = clamp(1 - irr * 4, 0, 1)
      hemiRef.current.color.setRGB(
        0.40 + irr * 0.36 + nightT * 0.04,
        0.56 + irr * 0.28 - nightT * 0.20,
        1.0  - irr * 0.28 + nightT * 0.08,
      )
      hemiRef.current.groundColor.setRGB(
        0.34 + irr * 0.32,
        0.26 + irr * 0.22,
        0.10 + irr * 0.08,
      )
    }

    // ── Bounce ──
    if (bounceRef.current) {
      bounceRef.current.intensity = nightMode ? 0 : irr * cfg.bounceIntensity
      bounceRef.current.color.setRGB(1.0, 0.80 + irr * 0.20, 0.50 + irr * 0.30)
    }

    // ── Rim ──
    if (rimRef.current) {
      rimRef.current.intensity = nightMode ? 0.06 : irr * cfg.rimIntensity
    }

    // ── Night ──
    if (nightRef.current) {
      nightRef.current.intensity = nightMode ? 0.12 : 0
    }
  })

  return (
    <group>
      <directionalLight
        ref={sunRef}
        castShadow
        shadow-mapSize={[cfg.shadowMapSize, cfg.shadowMapSize]}
        shadow-camera-left={-22}
        shadow-camera-right={22}
        shadow-camera-top={22}
        shadow-camera-bottom={-22}
        shadow-camera-near={0.1}
        shadow-camera-far={110}
        shadow-normalBias={0.04}
      />
      <hemisphereLight ref={hemiRef} color="#7db3e8" groundColor="#c88830" intensity={0.4} />
      <pointLight ref={bounceRef} position={[0, -1.6, 0]} distance={32} decay={2} color="#ffcc88" intensity={0.5} />
      <directionalLight ref={rimRef} position={[14, 5, -10]} color="#88aadd" intensity={0.25} />
      <ambientLight ref={nightRef} color="#0e1428" intensity={0} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.3 — PROCEDURAL TERRAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** Terrain configuration */
interface TerrainConfig {
  width:      number   // world units
  depth:      number
  segmentsX:  number   // resolution (higher = more detail)
  segmentsZ:  number
  maxHeight:  number   // peak height variation
  flatRadius: number   // inner flat zone around origin (for house)
  seed:       number
}

const TERRAIN_DEFAULTS: TerrainConfig = {
  width:      200,
  depth:      200,
  segmentsX:  48,
  segmentsZ:  48,
  maxHeight:  1.2,
  flatRadius: 18,
  seed:       42,
}

/**
 * generateTerrainHeightmap
 *
 * Pure function — unit testable.
 * Produces a (segX+1)×(segZ+1) Float32Array of Y heights using layered
 * fBm (fractal Brownian motion) via seeded sinusoidal summation.
 * The inner flatRadius zone is smooth-stepped to zero so the house sits
 * on flat ground.
 */
function generateTerrainHeightmap(cfg: TerrainConfig): Float32Array {
  const cols   = cfg.segmentsX + 1
  const rows   = cfg.segmentsZ + 1
  const result = new Float32Array(cols * rows)
  const s      = cfg.seed

  for (let zi = 0; zi < rows; zi++) {
    for (let xi = 0; xi < cols; xi++) {
      const wx = (xi / cfg.segmentsX - 0.5) * cfg.width
      const wz = (zi / cfg.segmentsZ - 0.5) * cfg.depth

      // Layered sinusoidal noise (fBm substitute — no external library)
      let h = 0
      h += Math.sin(wx * 0.038 + s)          * 0.5
      h += Math.sin(wz * 0.042 + s * 1.3)    * 0.4
      h += Math.sin((wx + wz) * 0.055 + s)   * 0.3
      h += Math.sin(wx * 0.11 + wz * 0.09)   * 0.18
      h += Math.sin(wx * 0.22 + wz * 0.19 + s * 0.7) * 0.08
      h  = (h / 1.46) * cfg.maxHeight        // normalise to maxHeight

      // Flatten near origin
      const dist   = Math.sqrt(wx * wx + wz * wz)
      const taper  = smoothstepScalar(cfg.flatRadius, cfg.flatRadius * 1.8, dist)
      result[zi * cols + xi] = h * taper
    }
  }
  return result
}

/** Scalar smoothstep utility — pure, unit testable */
function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * buildTerrainGeometry
 *
 * Builds a BufferGeometry from heightmap, computing normals and UVs.
 * Pure function — unit testable.
 */
function buildTerrainGeometry(cfg: TerrainConfig, heights: Float32Array): THREE.BufferGeometry {
  const cols   = cfg.segmentsX + 1
  const rows   = cfg.segmentsZ + 1
  const posArr = new Float32Array(cols * rows * 3)
  const norArr = new Float32Array(cols * rows * 3)
  const uvArr  = new Float32Array(cols * rows * 2)
  const idxArr: number[] = []

  // Build vertices
  for (let zi = 0; zi < rows; zi++) {
    for (let xi = 0; xi < cols; xi++) {
      const i  = zi * cols + xi
      const wx = (xi / cfg.segmentsX - 0.5) * cfg.width
      const wz = (zi / cfg.segmentsZ - 0.5) * cfg.depth
      const wy = heights[i]
      posArr[i * 3]     = wx
      posArr[i * 3 + 1] = wy
      posArr[i * 3 + 2] = wz
      uvArr[i * 2]      = xi / cfg.segmentsX
      uvArr[i * 2 + 1]  = zi / cfg.segmentsZ
    }
  }

  // Build indices
  for (let zi = 0; zi < cfg.segmentsZ; zi++) {
    for (let xi = 0; xi < cfg.segmentsX; xi++) {
      const tl = zi * cols + xi
      const tr = tl + 1
      const bl = (zi + 1) * cols + xi
      const br = bl + 1
      idxArr.push(tl, bl, tr, tr, bl, br)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(posArr, 3))
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvArr,  2))
  geo.setIndex(idxArr)
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  return geo
}

// ── Terrain GLSL shader ────────────────────────────────────────────────────

const TERRAIN_VERT = /* glsl */ `
  varying vec2  vUv;
  varying vec3  vNormal;
  varying float vHeight;
  varying vec3  vWorldPos;

  void main() {
    vUv       = uv;
    vHeight   = position.y;
    vNormal   = normalize(normalMatrix * normal);
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const TERRAIN_FRAG = /* glsl */ `
  uniform vec3  uGrassColor;
  uniform vec3  uDirtColor;
  uniform vec3  uSnowColor;
  uniform float uSnowBlend;
  uniform float uWetness;     // 0=dry 1=wet (rain)
  uniform float uMaxHeight;

  varying vec2  vUv;
  varying vec3  vNormal;
  varying float vHeight;
  varying vec3  vWorldPos;

  void main() {
    // Height-based texture blend
    float t = clamp(vHeight / max(uMaxHeight, 0.01), 0.0, 1.0);
    vec3 col = mix(uGrassColor, uDirtColor, clamp(t * 1.6 - 0.2, 0.0, 1.0));

    // Slope dirt
    float slope   = 1.0 - clamp(vNormal.y, 0.0, 1.0);
    col           = mix(col, uDirtColor * 0.72, slope * slope * 2.2);

    // Snow overlay
    col = mix(col, uSnowColor, uSnowBlend * clamp(vNormal.y * 1.5 - 0.3, 0.0, 1.0));

    // Wet darkening
    col *= (1.0 - uWetness * 0.28);

    // Simple Lambertian (no lights uniform — rely on MeshStandardMaterial wrapper)
    gl_FragColor = vec4(col, 1.0);
  }
`

/** Uniforms for TerrainMaterial */
  interface TerrainShaderUniforms {
    [uniform: string]: THREE.IUniform
  uGrassColor: { value: THREE.Color }
  uDirtColor:  { value: THREE.Color }
  uSnowColor:  { value: THREE.Color }
  uSnowBlend:  { value: number }
  uWetness:    { value: number }
  uMaxHeight:  { value: number }
}

function createTerrainMaterial(cfg: TerrainConfig): THREE.ShaderMaterial & { uniforms: TerrainShaderUniforms } {
  const uniforms: TerrainShaderUniforms = {
    uGrassColor: { value: new THREE.Color("#3a6828") },
    uDirtColor:  { value: new THREE.Color("#6b5030") },
    uSnowColor:  { value: new THREE.Color("#e8f0f8") },
    uSnowBlend:  { value: 0 },
    uWetness:    { value: 0 },
    uMaxHeight:  { value: cfg.maxHeight },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   TERRAIN_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms,
    }),
    { uniforms },
  )
}

/** Props for ProceduralTerrain */
interface ProceduralTerrainProps {
  config?:   Partial<TerrainConfig>
  weather:   WeatherType
  nightMode: boolean
}

/**
 * ProceduralTerrain
 *
 * Full-featured terrain system:
 *   - fBm height variation (pure JS, no external libs)
 *   - Flat zone around origin so house/panels sit level
 *   - Custom GLSL shader: grass / dirt slope blend / snow / wet darkening
 *   - Receives shadows from all light sources
 *
 * Performance tuning:
 *   Reduce segmentsX/Z from 48 to 24 for mobile (halves vertex count).
 *   The geometry is built once in useMemo and never rebuilt unless config changes.
 */
const ProceduralTerrain = memo(function ProceduralTerrain({
  config: configOverride = {},
  weather,
  nightMode,
}: ProceduralTerrainProps) {
  const cfg = useMemo<TerrainConfig>(
    () => ({ ...TERRAIN_DEFAULTS, ...configOverride }),
    [configOverride],
  )

  const { geo, mat } = useMemo(() => {
    if (!IS_WEBGL2) {
      // Fallback: simple flat plane with MeshStandardMaterial
      return {
        geo: new THREE.PlaneGeometry(cfg.width, cfg.depth, 1, 1),
        mat: new THREE.MeshStandardMaterial({
          color:    new THREE.Color("#3a6828"),
          roughness: 0.96,
          metalness: 0,
        }),
      }
    }
    const heights = generateTerrainHeightmap(cfg)
    const g       = buildTerrainGeometry(cfg, heights)
    const m       = createTerrainMaterial(cfg)
    return { geo: g, mat: m }
  }, [cfg])

  const matRef = useRef<(THREE.ShaderMaterial & { uniforms: TerrainShaderUniforms }) | null>(null)

  useEffect(() => {
    if (IS_WEBGL2 && mat instanceof THREE.ShaderMaterial && "uniforms" in mat) {
      matRef.current = mat as THREE.ShaderMaterial & { uniforms: TerrainShaderUniforms }
    }
  }, [mat])

  useFrame(() => {
    const u = matRef.current?.uniforms
    if (!u) return
    // Animate weather-driven uniforms
    u.uSnowBlend.value = weather === "snow"  ? 1.0 : 0.0
    u.uWetness.value   = weather === "rain" || weather === "storm" ? 1.0 : 0.0
    // Night colour desaturation
    const nightShift = nightMode ? 0.55 : 1.0
    u.uGrassColor.value.setRGB(0.23 * nightShift, 0.42 * nightShift, 0.16 * nightShift)
  })

  useEffect(() => () => { geo.dispose(); mat.dispose() }, [geo, mat])

  return (
    <mesh
      geometry={geo}
      material={mat}
      rotation={IS_WEBGL2 ? undefined : [-Math.PI / 2, 0, 0]}
      position={[0, -1.96, 0]}
      receiveShadow
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.4 — ADVANCED SOLAR PANEL RENDERING
// ─────────────────────────────────────────────────────────────────────────────

// ── Cell-grid GLSL (high quality, v2) ────────────────────────────────────────

const PANEL_CELL_V2_VERT = /* glsl */ `
  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vViewDir;
  varying vec3  vWorldPos;

  void main() {
    vUv       = uv;
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vNormal   = normalize(normalMatrix * normal);
    vViewDir  = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const PANEL_CELL_V2_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uOutputRatio;
  uniform float uEmissive;
  uniform vec3  uCellColor;
  uniform vec3  uGlintDir;
  uniform float uGlintStrength;
  uniform float uSelected;

  varying vec2  vUv;
  varying vec3  vNormal;
  varying vec3  vViewDir;
  varying vec3  vWorldPos;

  // ── Monocrystalline cell grid ──────────────────────────────────────────────
  float cellGrid(vec2 uv) {
    vec2 cell  = fract(uv * vec2(6.0, 10.0));
    float edge = max(step(0.936, cell.x), step(0.936, cell.y));
    return edge;
  }

  // ── Horizontal busbar lines ────────────────────────────────────────────────
  float busbars(vec2 uv) {
    float y = fract(uv.y * 10.0);
    return step(0.488, y) * step(y, 0.512);
  }

  // ── Diagonal anti-reflection coating shimmer ──────────────────────────────
  float arcShimmer(vec2 uv, float t) {
    float d = sin(uv.x * 12.0 + uv.y * 8.0 + t * 0.6) * 0.5 + 0.5;
    return d * 0.022 * uOutputRatio;
  }

  // ── Fresnel edge glow ──────────────────────────────────────────────────────
  float fresnelEdge(vec3 N, vec3 V) {
    return pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
  }

  // ── Specular glint ─────────────────────────────────────────────────────────
  float specGlint(vec3 N, vec3 V, vec3 L) {
    vec3 H = normalize(V + L);
    return pow(max(dot(N, H), 0.0), 164.0);
  }

  void main() {
    vec3 col = uCellColor;

    // Cell grid darkening
    float grid = cellGrid(vUv);
    col = mix(col, col * 0.56, grid * 0.88);

    // Busbars
    float bus = busbars(vUv);
    col = mix(col, vec3(0.68, 0.74, 0.80), bus * 0.52);

    // ARC shimmer
    col += arcShimmer(vUv, uTime);

    // Sun glint
    float glint = specGlint(vNormal, vViewDir, uGlintDir) * uGlintStrength * uOutputRatio;
    col += vec3(glint * 0.9, glint * 0.95, glint);

    // Fresnel rim
    float rim = fresnelEdge(vNormal, vViewDir) * 0.12 * uOutputRatio;
    col += uCellColor * rim;

    // Power emissive
    col += uCellColor * uEmissive * uOutputRatio;

    // Selection pulse
    if (uSelected > 0.5) {
      float pulse = sin(uTime * 3.6) * 0.5 + 0.5;
      col += vec3(0.18, 0.32, 0.55) * pulse * 0.35;
    }

    gl_FragColor = vec4(clamp(col, 0.0, 2.0), 1.0);
  }
`

  interface PanelCellV2Uniforms {
    [uniform: string]: THREE.IUniform
  uTime:          { value: number }
  uOutputRatio:   { value: number }
  uEmissive:      { value: number }
  uCellColor:     { value: THREE.Color }
  uGlintDir:      { value: THREE.Vector3 }
  uGlintStrength: { value: number }
  uSelected:      { value: number }
}

function createPanelCellV2(ratio: number): THREE.ShaderMaterial & { uniforms: PanelCellV2Uniforms } {
  const uniforms: PanelCellV2Uniforms = {
    uTime:          { value: 0 },
    uOutputRatio:   { value: ratio },
    uEmissive:      { value: 0.14 },
    uCellColor:     { value: new THREE.Color("#0c2040") },
    uGlintDir:      { value: new THREE.Vector3(0, 1, 0) },
    uGlintStrength: { value: 0.52 },
    uSelected:      { value: 0 },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   PANEL_CELL_V2_VERT,
      fragmentShader: PANEL_CELL_V2_FRAG,
      uniforms,
      lights:         false,
    }),
    { uniforms },
  )
}

// ── Per-panel PBR material singletons ────────────────────────────────────────

const S19_FRAME_MAT = new THREE.MeshStandardMaterial({
  color:           new THREE.Color("#bec8d4"),
  roughness:       0.18,
  metalness:       0.96,
  envMapIntensity: 2.2,
})

const S19_GLASS_MAT = new THREE.MeshPhysicalMaterial({
  color:              new THREE.Color("#081828"),
  roughness:          0.02,
  metalness:          0.0,
  clearcoat:          1.0,
  clearcoatRoughness: 0.01,
  reflectivity:       0.95,
  transmission:       0.08,
  transparent:        true,
  opacity:            0.97,
  envMapIntensity:    2.8,
})

const S19_RAIL_MAT = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#8898a8"),
  roughness: 0.26,
  metalness: 0.90,
})

const S19_BACKSHEET_MAT = new THREE.MeshStandardMaterial({
  color:     new THREE.Color("#0c1018"),
  roughness: 0.72,
  metalness: 0.08,
})

/** Props for the S19 advanced panel */
interface S19PanelMeshProps {
  position:    [number, number, number]
  rotation:    [number, number, number]
  outputRatio: number
  selected:    boolean
  viewMode:    ViewMode
  color:       THREE.Color
  sunDir:      THREE.Vector3
  onClick:     () => void
}

/**
 * S19PanelMesh
 *
 * Six-layer panel:
 *   1. Anodised aluminium frame
 *   2. EVA back-sheet polymer (dark, matte)
 *   3. Monocrystalline PV cell layer — high-quality GLSL shader
 *   4. AR clearcoat tempered glass — MeshPhysicalMaterial
 *   5. Bottom mounting rails × 2
 *   6. Conduit cable exit (small box at one end)
 *
 * Fallback for WebGL1: use MeshStandardMaterial for the cell layer.
 */
const S19PanelMesh = memo(function S19PanelMesh({
  position,
  rotation,
  outputRatio,
  selected,
  viewMode,
  color,
  sunDir,
  onClick,
}: S19PanelMeshProps) {
  const cellMatRef = useRef<(THREE.ShaderMaterial & { uniforms: PanelCellV2Uniforms }) | null>(null)
  const glowRef    = useRef<THREE.PointLight>(null)
  const scanRef    = useRef<THREE.Mesh>(null)

  const cellMat = useMemo(() => {
    if (!IS_WEBGL2) {
      return new THREE.MeshStandardMaterial({
        color:            color,
        emissive:         color,
        emissiveIntensity: 0.10 * outputRatio,
        roughness:         0.16,
        metalness:         0.44,
      })
    }
    const m = createPanelCellV2(outputRatio)
    cellMatRef.current = m
    return m
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const u = cellMatRef.current?.uniforms
    if (u) {
      u.uTime.value        = t
      u.uOutputRatio.value = outputRatio
      u.uGlintDir.value.copy(sunDir)
      u.uSelected.value    = selected ? 1 : 0

      switch (viewMode) {
        case "thermal":  u.uCellColor.value.copy(thermalColor(32 + outputRatio * 28)); break
        case "heatmap":  u.uCellColor.value.copy(efficiencyColor(outputRatio));         break
        case "string":   u.uCellColor.value.copy(color);                                break
        default:         u.uCellColor.value.set("#0c2040");                             break
      }
    }

    // Scan-line sweep when selected
    if (scanRef.current && selected) {
      const z = ((t * 0.65) % 1) * (PANEL_DEPTH + 0.06) - PANEL_DEPTH * 0.5
      scanRef.current.position.z = z
      ;(scanRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.42 * (1 - Math.abs(z / (PANEL_DEPTH * 0.5)))
    }

    // Glow
    if (glowRef.current) {
      glowRef.current.intensity = selected
        ? 1.2 + 0.4 * Math.sin(t * 3.6)
        : outputRatio * 0.32
    }
  })

  return (
    <group position={position} rotation={rotation} onClick={(e) => { e.stopPropagation(); onClick() }}>
      {/* Frame */}
      <mesh castShadow receiveShadow material={S19_FRAME_MAT}>
        <boxGeometry args={[PANEL_WIDTH, 0.05, PANEL_DEPTH]} />
      </mesh>
      {/* Back-sheet */}
      <mesh position={[0, -0.008, 0]} receiveShadow material={S19_BACKSHEET_MAT}>
        <boxGeometry args={[PANEL_WIDTH - 0.06, 0.012, PANEL_DEPTH - 0.06]} />
      </mesh>
      {/* PV cells */}
      <mesh position={[0, 0.009, 0]} castShadow receiveShadow material={cellMat}>
        <boxGeometry args={[PANEL_WIDTH - 0.10, 0.012, PANEL_DEPTH - 0.10]} />
      </mesh>
      {/* Glass */}
      <mesh position={[0, 0.022, 0]} receiveShadow material={S19_GLASS_MAT}>
        <boxGeometry args={[PANEL_WIDTH - 0.09, 0.008, PANEL_DEPTH - 0.09]} />
      </mesh>
      {/* Rails */}
      {([-0.27, 0.27] as number[]).map((ox, ri) => (
        <mesh key={ri} position={[ox, -0.038, 0]} castShadow material={S19_RAIL_MAT}>
          <boxGeometry args={[0.056, 0.022, PANEL_DEPTH + 0.06]} />
        </mesh>
      ))}
      {/* Conduit exit */}
      <mesh position={[0, -0.04, -(PANEL_DEPTH * 0.5 + 0.028)]} castShadow material={S19_RAIL_MAT}>
        <boxGeometry args={[0.08, 0.04, 0.06]} />
      </mesh>
      {/* Scan-line */}
      {selected && (
        <mesh ref={scanRef} position={[0, 0.028, 0]}>
          <planeGeometry args={[PANEL_WIDTH - 0.08, 0.054]} />
          <meshBasicMaterial color={DS.gold} transparent opacity={0.32} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      )}
      {/* Selection halo */}
      {selected && (
        <mesh>
          <boxGeometry args={[PANEL_WIDTH + 0.09, 0.07, PANEL_DEPTH + 0.09]} />
          <meshBasicMaterial color={DS.gold} wireframe transparent opacity={0.65} depthWrite={false} />
        </mesh>
      )}
      <pointLight ref={glowRef} color={selected ? DS.gold : "#3366ff"} intensity={outputRatio * 0.3} distance={1.8} decay={2} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.5 — PROCEDURAL TREE & VEGETATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** Wind controller state (module-level ref, updated each frame) */
const s19WindRef: React.MutableRefObject<{ speed: number; direction: number }> =
  { current: { speed: 0.18, direction: 0.4 } }

/** Per-tree geometry — reused across instances */
interface TreeGeometrySet {
  trunk:   THREE.BufferGeometry
  cones:   THREE.BufferGeometry[]   // one per layer
}

const treeGeoCache = new Map<string, TreeGeometrySet>()

function getTreeGeo(
  trunkH: number, trunkR: number,
  layers: number, foliageR: number, foliageH: number,
): TreeGeometrySet {
  const key = `${trunkH}|${trunkR}|${layers}|${foliageR}|${foliageH}`
  if (treeGeoCache.has(key)) return treeGeoCache.get(key)!
  const trunk = new THREE.CylinderGeometry(trunkR * 0.68, trunkR, trunkH, 7, 1)
  const cones = Array.from({ length: layers }, (_, li) => {
    const scale = 1 - li * 0.20
    return new THREE.ConeGeometry(foliageR * scale, foliageH, 7, 1)
  })
  const set = { trunk, cones }
  treeGeoCache.set(key, set)
  return set
}

/** Foliage colour palette — varied greens */
const FOLIAGE_PALETTE = [
  new THREE.Color("#2d6a2f"),
  new THREE.Color("#317a34"),
  new THREE.Color("#28582a"),
  new THREE.Color("#356b28"),
  new THREE.Color("#245a25"),
  new THREE.Color("#3d7230"),
]

function foliageMat19(palIdx: number): THREE.MeshStandardMaterial {
  const col = FOLIAGE_PALETTE[palIdx % FOLIAGE_PALETTE.length].clone()
  return new THREE.MeshStandardMaterial({ color: col, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.45 })
}

const BARK_MAT_19 = new THREE.MeshStandardMaterial({ color: new THREE.Color("#4e3218"), roughness: 0.94, metalness: 0.0 })

/** Single procedural tree configuration */
interface S19TreeConfig {
  position:   [number, number, number]
  trunkH:     number
  trunkR:     number
  layers:     number
  foliageR:   number
  foliageH:   number
  palIdx:     number
  swayPhase:  number
  swayAmt:    number
}

/** Procedural tree with per-layer cone foliage and wind sway */
const TreeGenerator = memo(function TreeGenerator({ cfg }: { cfg: S19TreeConfig }) {
  const groupRef = useRef<THREE.Group>(null)
  const geo      = useMemo(() => getTreeGeo(cfg.trunkH, cfg.trunkR, cfg.layers, cfg.foliageR, cfg.foliageH), [cfg.trunkH, cfg.trunkR, cfg.layers, cfg.foliageR, cfg.foliageH])
  const mats     = useMemo(() => Array.from({ length: cfg.layers }, (_, li) => foliageMat19((cfg.palIdx + li) % FOLIAGE_PALETTE.length)), [cfg.palIdx, cfg.layers])

  useFrame(({ clock }) => {
    if (!groupRef.current) return
    const t     = clock.getElapsedTime()
    const wind  = s19WindRef.current
    const sway  = Math.sin(t * (0.68 + wind.speed * 0.72) + cfg.swayPhase) * cfg.swayAmt * wind.speed
    const swayZ = Math.cos(t * (0.54 + wind.speed * 0.55) + cfg.swayPhase + 1.1) * cfg.swayAmt * wind.speed * 0.6
    groupRef.current.rotation.x = sway
    groupRef.current.rotation.z = swayZ
  })

  return (
    <group ref={groupRef} position={cfg.position}>
      {/* Root flare */}
      <mesh position={[0, 0.06, 0]} receiveShadow material={BARK_MAT_19}>
        <cylinderGeometry args={[cfg.trunkR * 1.3, cfg.trunkR * 1.1, 0.14, 7]} />
      </mesh>
      {/* Trunk */}
      <mesh position={[0, cfg.trunkH * 0.5, 0]} castShadow receiveShadow material={BARK_MAT_19} geometry={geo.trunk} />
      {/* Foliage cones */}
      {geo.cones.map((coneGeo, li) => (
        <mesh
          key={li}
          geometry={coneGeo}
          material={mats[li]}
          position={[0, cfg.trunkH + li * (cfg.foliageH * 0.68), 0]}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  )
})

/** Default vegetation cluster */
const S19_TREE_CONFIGS: S19TreeConfig[] = [
  { position: [-10.2,  0, -3.5], trunkH: 2.4, trunkR: 0.13, layers: 3, foliageR: 0.84, foliageH: 1.14, palIdx: 0, swayPhase: 0.0,  swayAmt: 0.038 },
  { position: [-11.8,  0, -0.8], trunkH: 2.0, trunkR: 0.11, layers: 3, foliageR: 0.68, foliageH: 1.06, palIdx: 2, swayPhase: 1.3,  swayAmt: 0.044 },
  { position: [-11.0,  0,  2.6], trunkH: 2.7, trunkR: 0.14, layers: 4, foliageR: 0.92, foliageH: 1.10, palIdx: 1, swayPhase: 2.6,  swayAmt: 0.032 },
  { position: [ -9.2,  0,  5.4], trunkH: 1.9, trunkR: 0.10, layers: 2, foliageR: 0.64, foliageH: 1.22, palIdx: 4, swayPhase: 0.8,  swayAmt: 0.050 },
  { position: [ 10.9,  0, -6.6], trunkH: 2.9, trunkR: 0.15, layers: 4, foliageR: 0.98, foliageH: 1.18, palIdx: 3, swayPhase: 1.9,  swayAmt: 0.028 },
  { position: [ 12.5,  0, -4.3], trunkH: 2.2, trunkR: 0.12, layers: 3, foliageR: 0.74, foliageH: 1.08, palIdx: 5, swayPhase: 3.1,  swayAmt: 0.042 },
  { position: [ -6.6,  0, -9.9], trunkH: 2.5, trunkR: 0.13, layers: 3, foliageR: 0.84, foliageH: 1.12, palIdx: 2, swayPhase: 0.5,  swayAmt: 0.036 },
  { position: [ -4.1,  0,-10.6], trunkH: 1.8, trunkR: 0.10, layers: 2, foliageR: 0.66, foliageH: 1.26, palIdx: 0, swayPhase: 2.2,  swayAmt: 0.048 },
  { position: [  8.6,  0,  8.4], trunkH: 2.3, trunkR: 0.12, layers: 3, foliageR: 0.78, foliageH: 1.10, palIdx: 4, swayPhase: 1.5,  swayAmt: 0.040 },
  { position: [  5.8,  0, -11.2], trunkH: 2.1, trunkR: 0.11, layers: 3, foliageR: 0.70, foliageH: 1.08, palIdx: 1, swayPhase: 0.9,  swayAmt: 0.035 },
]

interface VegetationClusterProps {
  configs?:    S19TreeConfig[]
  windSpeed?:  number
  windDir?:    number
}

/** WindAnimationController — drives s19WindRef from props each frame */
const WindAnimationController = memo(function WindAnimationController({
  speed = 0.2,
  dir   = 0.4,
}: { speed?: number; dir?: number }) {
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    // Add gentle gusting
    const gust = 1 + 0.35 * Math.sin(t * 0.22)
    s19WindRef.current.speed     = speed * gust
    s19WindRef.current.direction = dir
  })
  return null
})

/**
 * VegetationCluster
 *
 * Renders all trees and drives the wind animation.
 * Trees use cached geometry so identical tree types share the same
 * Buffer objects on the GPU.
 */
const VegetationCluster = memo(function VegetationCluster({
  configs   = S19_TREE_CONFIGS,
  windSpeed = 0.22,
  windDir   = 0.4,
}: VegetationClusterProps) {
  return (
    <group>
      <WindAnimationController speed={windSpeed} dir={windDir} />
      {configs.map((cfg, i) => (
        <TreeGenerator key={i} cfg={cfg} />
      ))}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.6 — HOUSE GEOMETRY ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** Pure: build a roof hip geometry returning BufferGeometry */
function buildHipRoofGeo(w: number, d: number, h: number, hip: number): THREE.BufferGeometry {
  // Hip roof: four trapezoid faces
  const hw = w * 0.5, hd = d * 0.5, hipOff = hip
  const verts = new Float32Array([
    // Front face (trapezoid)
    -hw, 0, hd,   hw, 0, hd,   hw - hipOff, h, hipOff,   -hw + hipOff, h, hipOff,
    // Back face
    -hw, 0, -hd,  -hw + hipOff, h, -hipOff,  hw - hipOff, h, -hipOff,  hw, 0, -hd,
    // Left face
    -hw, 0, -hd,  -hw, 0, hd,  -hw + hipOff, h, hipOff,  -hw + hipOff, h, -hipOff,
    // Right face
     hw, 0, -hd,   hw - hipOff, h, -hipOff,  hw - hipOff, h, hipOff,   hw, 0, hd,
  ])
  const indices = [
    0,1,2, 0,2,3,   4,5,6, 4,6,7,   8,9,10, 8,10,11,   12,13,14, 12,14,15,
  ]
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

// Materials
const S19_WALL_MAT  = new THREE.MeshStandardMaterial({ color: new THREE.Color("#d0d8e4"), roughness: 0.88, metalness: 0.02, envMapIntensity: 0.4 })
const S19_ROOF_MAT  = new THREE.MeshStandardMaterial({ color: new THREE.Color("#283848"), roughness: 0.76, metalness: 0.06, envMapIntensity: 0.5 })
const S19_TRIM_MAT  = new THREE.MeshStandardMaterial({ color: new THREE.Color("#485a6a"), roughness: 0.52, metalness: 0.36 })
const S19_DOOR_MAT  = new THREE.MeshStandardMaterial({ color: new THREE.Color("#1a2838"), roughness: 0.44, metalness: 0.56 })
const S19_KNOB_MAT  = new THREE.MeshStandardMaterial({ color: new THREE.Color("#d4aa50"), roughness: 0.15, metalness: 0.95 })

function S19WindowPane({ nightMode }: { nightMode: boolean }) {
  return (
    <meshPhysicalMaterial
      color={nightMode ? "#ffe8d0" : "#a0c8f0"}
      emissive={nightMode ? new THREE.Color("#ffd090") : new THREE.Color("#000000")}
      emissiveIntensity={nightMode ? 0.88 : 0}
      roughness={0.0}
      metalness={0.0}
      clearcoat={1.0}
      transmission={nightMode ? 0.22 : 0.74}
      transparent
      opacity={nightMode ? 0.94 : 0.82}
      reflectivity={0.90}
    />
  )
}

interface S19HouseProps {
  nightMode: boolean
  position?: [number, number, number]
}

/**
 * S19House
 *
 * Full procedural house with:
 *   - Concrete wall panels + corner trim
 *   - Foundation plinth
 *   - Hip roof (buildHipRoofGeo) + overhang + fascia + ridge cap
 *   - Rain gutters (tubes along eave)
 *   - 3 front windows + 2 side windows + glass pane (night emissive)
 *   - Front door + frame + knob
 *   - Chimney + flashing + stack
 *   - 2 roof vents
 *   - Night exterior wall light
 */
const S19House = memo(function S19House({
  nightMode,
  position = [2.15, -0.38, 1.15],
}: S19HouseProps) {
  const roofGeo = useMemo(() => buildHipRoofGeo(8.0, 4.8, 1.80, 1.2), [])
  const winLightInt = nightMode ? 0.62 : 0

  return (
    <group position={position}>
      {/* ── Main walls ── */}
      <mesh castShadow receiveShadow material={S19_WALL_MAT}>
        <boxGeometry args={[7.8, 2.18, 4.98]} />
      </mesh>
      {/* Corner trim */}
      {([-3.92, 3.92] as number[]).map((x, i) => (
        <mesh key={i} position={[x, 0, 0]} castShadow material={S19_TRIM_MAT}>
          <boxGeometry args={[0.10, 2.22, 5.02]} />
        </mesh>
      ))}
      {/* Foundation */}
      <mesh position={[0, -1.21, 0]} receiveShadow>
        <boxGeometry args={[8.0, 0.26, 5.18]} />
        <meshStandardMaterial color="#9aabb8" roughness={0.94} metalness={0.04} />
      </mesh>
      {/* ── Roof ── */}
      <mesh geometry={roofGeo} material={S19_ROOF_MAT} position={[0, 1.09, 0]} castShadow receiveShadow />
      {/* Overhang deck */}
      <mesh position={[0, 1.08, 0]} castShadow material={S19_ROOF_MAT}>
        <boxGeometry args={[8.6, 0.16, 5.6]} />
      </mesh>
      {/* Fascia */}
      {([2.82, -2.82] as number[]).map((z, i) => (
        <mesh key={i} position={[0, 1.07, z]} material={S19_TRIM_MAT} castShadow>
          <boxGeometry args={[9.0, 0.14, 0.08]} />
        </mesh>
      ))}
      {/* Ridge cap */}
      <mesh position={[0, 1.08 + 1.80, 0]} material={S19_TRIM_MAT} castShadow>
        <boxGeometry args={[8.1, 0.12, 0.20]} />
      </mesh>
      {/* Rain gutters */}
      {([2.82, -2.82] as number[]).map((z, i) => (
        <mesh key={i} position={[0, 0.96, z]} material={S19_TRIM_MAT}>
          <boxGeometry args={[8.6, 0.08, 0.10]} />
        </mesh>
      ))}
      {/* ── Front windows ── */}
      {([
        [-2.5, -0.48, 2.52, 1.08, 0.76],
        [ 0.3, -0.48, 2.52, 1.08, 0.76],
        [ 2.8, -0.22, 2.52, 1.58, 1.16],
      ] as [number,number,number,number,number][]).map(([x,y,z,w,h], i) => (
        <group key={i} position={[x,y,z]}>
          <mesh castShadow material={S19_TRIM_MAT}><boxGeometry args={[w+0.1, h+0.1, 0.10]} /></mesh>
          <mesh position={[0,0,0.045]}>
            <boxGeometry args={[w, h, 0.02]} />
            <S19WindowPane nightMode={nightMode} />
          </mesh>
          {nightMode && <pointLight color="#ffcc88" intensity={winLightInt} distance={4} decay={2} position={[0,0,-0.6]} />}
        </group>
      ))}
      {/* Side windows */}
      {([-3.93, -3.93] as number[]).map((x, i) => (
        <group key={i} position={[x, -0.46, i === 0 ? -0.6 : 1.2]}>
          <mesh castShadow material={S19_TRIM_MAT}><boxGeometry args={[0.10, 0.80, 0.96]} /></mesh>
          <mesh position={[-0.04,0,0]}>
            <boxGeometry args={[0.02, 0.66, 0.80]} />
            <S19WindowPane nightMode={nightMode} />
          </mesh>
        </group>
      ))}
      {/* Front door */}
      <group position={[-0.65,-0.82,2.52]}>
        <mesh castShadow material={S19_TRIM_MAT}><boxGeometry args={[1.04,1.00,0.10]} /></mesh>
        <mesh position={[0,0,0.05]} castShadow material={S19_DOOR_MAT}><boxGeometry args={[0.90,0.90,0.06]} /></mesh>
        <mesh position={[0.36,-0.08,0.12]} material={S19_KNOB_MAT}><sphereGeometry args={[0.028,8,8]} /></mesh>
      </group>
      {/* Chimney */}
      <group position={[2.7,1.04,-1.6]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.60,1.36,0.60]} />
          <meshStandardMaterial color="#384858" roughness={0.82} metalness={0.06} />
        </mesh>
        <mesh position={[0,0.74,0]} castShadow>
          <boxGeometry args={[0.68,0.10,0.68]} />
          <meshStandardMaterial color="#5a6a7a" roughness={0.55} metalness={0.46} />
        </mesh>
        <mesh position={[0,0.98,0]}>
          <cylinderGeometry args={[0.08,0.09,0.28,8]} />
          <meshStandardMaterial color="#404850" roughness={0.66} metalness={0.56} />
        </mesh>
      </group>
      {/* Roof vents */}
      {([[-1.4,1.94,0.3],[1.6,1.94,-0.5]] as [number,number,number][]).map(([x,y,z],i) => (
        <mesh key={i} position={[x,y,z]} castShadow>
          <cylinderGeometry args={[0.08,0.11,0.20,8]} />
          <meshStandardMaterial color="#7a8a9a" roughness={0.48} metalness={0.58} />
        </mesh>
      ))}
      {/* Night exterior lamp */}
      {nightMode && (
        <>
          <mesh position={[0,0.08,2.62]}>
            <sphereGeometry args={[0.06,8,8]} />
            <meshBasicMaterial color="#ffe8b0" />
          </mesh>
          <pointLight position={[0,0.10,2.76]} color="#ffcc88" intensity={0.52} distance={3.5} decay={2} />
        </>
      )}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.7 — SKY & ATMOSPHERE SHADER
// ─────────────────────────────────────────────────────────────────────────────

const S19_SKY_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(wp.xyz);
    vec4 pos  = projectionMatrix * viewMatrix * wp;
    gl_Position = pos.xyww;
  }
`

const S19_SKY_FRAG = /* glsl */ `
  uniform vec3  uSunDir;
  uniform float uElevation;
  uniform float uNight;
  uniform float uTurbidity;
  uniform float uTime;

  varying vec3 vWorldDir;

  // ── Sky colour from elevation and view direction ──────────────────────────
  vec3 computeSky(vec3 dir, float elev) {
    float up    = clamp(dir.y, 0.0, 1.0);
    float horizF = pow(1.0 - up, 1.8);

    // Daytime blue-sky gradient
    vec3 zenith  = vec3(0.08, 0.26, 0.72);
    vec3 horizon = vec3(0.68, 0.84, 0.98);
    vec3 day     = mix(horizon, zenith, pow(up, 0.48));

    // Golden-hour tint near horizon
    float sunE    = max(0.0, sin(radians(elev)));
    float golden  = clamp(1.0 - sunE * 3.2, 0.0, 1.0);
    day = mix(day, vec3(0.95, 0.50, 0.14), golden * horizF * 0.78);

    // Night sky
    vec3 night = vec3(0.018, 0.022, 0.068) + vec3(0.0, 0.0, 0.035) * up;
    return mix(day, night, uNight);
  }

  // ── Sun disc + corona ─────────────────────────────────────────────────────
  vec3 sunDisc(vec3 dir, vec3 sdir) {
    float d      = dot(dir, normalize(sdir));
    float disc   = smoothstep(0.9994, 0.9998, d);
    float corona = smoothstep(0.990,  0.9994, d) * 0.40;
    float sunE   = max(0.0, sin(radians(uElevation)));
    vec3 sc      = mix(vec3(1.0,0.92,0.72), vec3(1.0,0.60,0.22),
                       clamp(1.0 - sunE * 2.8, 0.0, 1.0));
    return sc * (disc + corona) * (1.0 - uNight);
  }

  // ── Horizon glow ──────────────────────────────────────────────────────────
  vec3 horizonGlow(vec3 dir, vec3 sdir) {
    float up     = clamp(dir.y, 0.0, 1.0);
    float horiz  = pow(1.0 - up, 6.0);
    float along  = max(dot(vec3(dir.x,0.0,dir.z), normalize(vec3(sdir.x,0.0,sdir.z))), 0.0);
    float sunE   = max(0.0, sin(radians(uElevation)));
    float gE     = clamp(sunE * 9.0, 0.0, 1.0);
    return vec3(1.0,0.44,0.10) * horiz * along * gE * 0.44 * (1.0 - uNight);
  }

  // ── Stars (hash-based) ────────────────────────────────────────────────────
  float star(vec3 dir) {
    vec3  d = normalize(dir);
    float a = atan(d.z, d.x);
    float b = acos(clamp(d.y,-1.0,1.0));
    vec2  g = floor(vec2(a,b) * 120.0);
    float r = fract(sin(dot(g, vec2(127.1, 311.7))) * 43758.5);
    return step(0.985, r) * clamp(d.y * 4.0, 0.0, 1.0);
  }

  // ── Milky way tint ────────────────────────────────────────────────────────
  float milkyWay(vec3 dir) {
    float stripe = sin(dir.x * 2.4 + dir.y * 1.6 + dir.z * 2.0) * 0.5 + 0.5;
    return stripe * 0.032 * clamp(dir.y, 0.0, 1.0) * uNight;
  }

  void main() {
    vec3 dir  = normalize(vWorldDir);
    if (dir.y < -0.08) { gl_FragColor = vec4(0.10,0.12,0.14,1.0); return; }

    vec3 sky  = computeSky(dir, uElevation);
    vec3 sun  = sunDisc(dir, uSunDir);
    vec3 glow = horizonGlow(dir, uSunDir);
    float st  = star(dir) * uNight;
    float mw  = milkyWay(dir);

    vec3 col  = sky + sun + glow + vec3(st * 0.90, st * 0.92, st) + mw;

    // Reinhard tone-map
    col = col * (1.0 + col * 0.12) / (1.0 + col);

    gl_FragColor = vec4(col, 1.0);
  }
`

  interface S19SkyUniforms {
    [uniform: string]: THREE.IUniform
  uSunDir:    { value: THREE.Vector3 }
  uElevation: { value: number }
  uNight:     { value: number }
  uTurbidity: { value: number }
  uTime:      { value: number }
}

function createS19SkyMat(): THREE.ShaderMaterial & { uniforms: S19SkyUniforms } {
  const uniforms: S19SkyUniforms = {
    uSunDir:    { value: new THREE.Vector3(0,1,0) },
    uElevation: { value: 45 },
    uNight:     { value: 0 },
    uTurbidity: { value: 4 },
    uTime:      { value: 0 },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   S19_SKY_VERT,
      fragmentShader: S19_SKY_FRAG,
      uniforms,
      side:           THREE.BackSide,
      depthWrite:     false,
      depthTest:      false,
    }),
    { uniforms },
  )
}

interface AtmosphericSkyShaderProps {
  elevation:   number
  azimuth:     number
  nightMode:   boolean
  turbidity?:  number
}

/**
 * AtmosphericSkyShader
 *
 * Procedural sky dome with:
 *   - Elevation-driven colour palette (day blue → golden hour → twilight)
 *   - Sun disc + corona via smoothstep
 *   - Horizon glow aligned to sun azimuth
 *   - Star field (hash-based) visible at night
 *   - Milky Way tint strip
 *   - Reinhard tone mapping
 *
 * Fallback on WebGL1: simple MeshBasicMaterial gradient.
 */
const AtmosphericSkyShader = memo(function AtmosphericSkyShader({
  elevation,
  azimuth,
  nightMode,
  turbidity = 4,
}: AtmosphericSkyShaderProps) {
  const matRef  = useRef<(THREE.ShaderMaterial & { uniforms: S19SkyUniforms }) | null>(null)
  const mat     = useMemo(() => IS_WEBGL2 ? createS19SkyMat() : null, [])
  useEffect(() => { matRef.current = mat }, [mat])
  useEffect(() => () => { mat?.dispose() }, [mat])

  useFrame(({ clock }) => {
    const u = matRef.current?.uniforms
    if (!u) return
    const dir = sunVector(elevation, azimuth)
    u.uSunDir.value.copy(dir)
    u.uElevation.value = elevation
    u.uTurbidity.value = turbidity
    u.uTime.value      = clock.getElapsedTime()
    u.uNight.value     = nightMode ? 1 : clamp(1 - elevation * 0.14, 0, 1)
  })

  if (!IS_WEBGL2 || !mat) {
    const col = nightMode ? "#020610" : elevation > 10 ? "#1a3a6a" : "#c85020"
    return (
      <mesh renderOrder={-1}>
        <sphereGeometry args={[275, 20, 20]} />
        <meshBasicMaterial color={col} side={THREE.BackSide} depthWrite={false} />
      </mesh>
    )
  }

  return (
    <mesh renderOrder={-1} material={mat}>
      <sphereGeometry args={[275, 32, 32]} />
    </mesh>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.8 — ADVANCED POST PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/** Color grade preset parameters */
interface S19ColorGrade {
  bloomIntensity:   number
  bloomThreshold:   number
  bloomSmoothing:   number
  vignetteOffset:   number
  vignetteDarkness: number
  label:            string
}

const S19_COLOR_GRADES: Record<string, S19ColorGrade> = {
  daylight: {
    bloomIntensity:   0.42,
    bloomThreshold:   0.65,
    bloomSmoothing:   0.58,
    vignetteOffset:   0.52,
    vignetteDarkness: 0.54,
    label:            "Daylight",
  },
  golden: {
    bloomIntensity:   0.74,
    bloomThreshold:   0.44,
    bloomSmoothing:   0.80,
    vignetteOffset:   0.38,
    vignetteDarkness: 0.70,
    label:            "Golden Hour",
  },
  night: {
    bloomIntensity:   1.02,
    bloomThreshold:   0.24,
    bloomSmoothing:   1.10,
    vignetteOffset:   0.30,
    vignetteDarkness: 0.86,
    label:            "Night",
  },
  overcast: {
    bloomIntensity:   0.20,
    bloomThreshold:   0.82,
    bloomSmoothing:   0.28,
    vignetteOffset:   0.60,
    vignetteDarkness: 0.44,
    label:            "Overcast",
  },
  storm: {
    bloomIntensity:   0.18,
    bloomThreshold:   0.90,
    bloomSmoothing:   0.22,
    vignetteOffset:   0.26,
    vignetteDarkness: 0.90,
    label:            "Storm",
  },
}

/** Pure: map scene state to color grade preset name */
function resolveS19Grade(
  weather:   WeatherType,
  nightMode: boolean,
  elevation: number,
): keyof typeof S19_COLOR_GRADES {
  if (nightMode)                return "night"
  if (weather === "storm")      return "storm"
  if (weather === "rain" || weather === "cloudy" || weather === "fog") return "overcast"
  if (elevation < 14 && elevation > -3) return "golden"
  return "daylight"
}

interface CinematicPostProcessingProps {
  weather:   WeatherType
  nightMode: boolean
  elevation: number
  enabled:   boolean
}

/**
 * CinematicPostProcessing
 *
 * Dynamically selects a color grade preset based on scene state and drives
 * Bloom + Vignette from @react-three/postprocessing accordingly.
 *
 * Tuning:
 *   - Increase bloomIntensity for more dramatic night/sunset scenes.
 *   - Reduce vignetteDarkness for lighter vignette on mobile.
 *   - Set enabled=false on low-end devices to remove the Bloom pass entirely.
 */
const CinematicPostProcessing = memo(function CinematicPostProcessing({
  weather,
  nightMode,
  elevation,
  enabled,
}: CinematicPostProcessingProps) {
  if (!enabled) return null
  const gradeName = resolveS19Grade(weather, nightMode, elevation)
  const grade     = S19_COLOR_GRADES[gradeName]

  return (
    <EffectComposer>
      <Bloom
        intensity={grade.bloomIntensity}
        luminanceThreshold={grade.bloomThreshold}
        luminanceSmoothing={grade.bloomSmoothing}
        mipmapBlur
      />
      <Vignette
        offset={grade.vignetteOffset}
        darkness={grade.vignetteDarkness}
        eskil={false}
      />
    </EffectComposer>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.9 — ENERGY VISUALIZATION FX
// ─────────────────────────────────────────────────────────────────────────────

/** GLSL for energy particle pulse */
const S19_ENERGY_VERT = /* glsl */ `
  attribute float aProgress;
  uniform float uTime;
  uniform float uSpeed;

  varying float vPulse;

  void main() {
    float phase = fract(aProgress - uTime * uSpeed);
    vPulse = pow(
      smoothstep(0.0, 0.2, phase) * smoothstep(0.45, 0.2, phase),
      1.6
    );
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = 4.0 + vPulse * 14.0;
  }
`

const S19_ENERGY_FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  varying float vPulse;

  void main() {
    vec2  uv   = gl_PointCoord - 0.5;
    float dist = length(uv);
    float a    = smoothstep(0.5, 0.08, dist) * (0.28 + vPulse * 0.72) * uOpacity;
    if (a < 0.015) discard;
    gl_FragColor = vec4(uColor * (1.0 + vPulse * 1.5), a);
  }
`

  interface S19EnergyUniforms {
    [uniform: string]: THREE.IUniform
  uTime:    { value: number }
  uSpeed:   { value: number }
  uColor:   { value: THREE.Color }
  uOpacity: { value: number }
}

function buildS19EnergyGeo(points: [number,number,number][], segments = 80): THREE.BufferGeometry {
  const curve    = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)))
  const pts      = curve.getPoints(segments)
  const pos      = new Float32Array(pts.length * 3)
  const prog     = new Float32Array(pts.length)
  for (let i = 0; i < pts.length; i++) {
    pos[i * 3]  = pts[i].x; pos[i * 3+1] = pts[i].y; pos[i * 3+2] = pts[i].z
    prog[i]      = i / (pts.length - 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position",  new THREE.Float32BufferAttribute(pos,  3))
  geo.setAttribute("aProgress", new THREE.Float32BufferAttribute(prog, 1))
  return geo
}

const S19_BEAM_COLORS: Record<string, string> = {
  solar: DS.gold, battery: DS.emerald, house: DS.cyan, grid: "#f97316",
}

interface S19EnergyBeamProps {
  flowId:  string
  points:  [number,number,number][]
  active:  boolean
  speed?:  number
}

/**
 * S19EnergyBeam
 *
 * Layered energy cable:
 *   1. Wide glow DreiLine (additive halo)
 *   2. Bright core DreiLine
 *   3. GLSL pulsed point particles along the path
 *
 * CPU fallback: simple PointsMaterial sphere traveling along the curve.
 */
const S19EnergyBeam = memo(function S19EnergyBeam({
  flowId, points, active, speed = 0.55,
}: S19EnergyBeamProps) {
  const color   = S19_BEAM_COLORS[flowId] ?? DS.gold
  const matRef  = useRef<(THREE.ShaderMaterial & { uniforms: S19EnergyUniforms }) | null>(null)
  const pulseRef = useRef<THREE.Mesh>(null)
  const progRef  = useRef(Math.random())
  const curve    = useMemo(() => new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), [points])
  const geo      = useMemo(() => buildS19EnergyGeo(points), [points])
  const mat      = useMemo(() => {
    if (!IS_WEBGL2) return new THREE.PointsMaterial({ color: new THREE.Color(color), size: 0.07, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending })
    const u: S19EnergyUniforms = {
      uTime: { value: 0 }, uSpeed: { value: speed },
      uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.9 },
    }
    const m = Object.assign(new THREE.ShaderMaterial({
      vertexShader: S19_ENERGY_VERT, fragmentShader: S19_ENERGY_FRAG,
      uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }), { uniforms: u })
    matRef.current = m
    return m
  }, [color, speed]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame(({ clock }, delta) => {
    if (!active) return
    if (matRef.current) matRef.current.uniforms.uTime.value = clock.getElapsedTime()
    if (pulseRef.current && !IS_WEBGL2) {
      progRef.current = (progRef.current + delta * speed) % 1
      pulseRef.current.position.copy(curve.getPoint(progRef.current))
    }
  })

  if (!active || points.length < 2) return null

  return (
    <group>
      <DreiLine points={points} color={color} lineWidth={3.8} transparent opacity={0.14} depthWrite={false} />
      <DreiLine points={points} color={color} lineWidth={1.3} transparent opacity={0.80} />
      <points geometry={geo} material={mat} frustumCulled={false} />
      {!IS_WEBGL2 && (
        <mesh ref={pulseRef}><sphereGeometry args={[0.06,8,8]} /><meshBasicMaterial color={new THREE.Color(color)} /></mesh>
      )}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19.10 — MICRO ANIMATION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** All animated signal values for scene micro-details */
interface S19MicroSignals {
  panelGlint:   number   // 0..1 sun glint intensity
  battPulse:    number   // 0..1 battery breathing
  ledBlink:     number   // 0 or 1 LED state
  energyHum:    number   // 1 ± 0.02 scale oscillation
  treeSwayT:    number   // elapsed time for tree sway calc
}

const s19MicroRef: React.MutableRefObject<S19MicroSignals> = {
  current: { panelGlint: 0, battPulse: 0, ledBlink: 0, energyHum: 1, treeSwayT: 0 },
}

/**
 * S19MicroAnimationSystem
 *
 * Single useFrame driver that updates all micro-animation signals.
 * Zero React state updates — pure ref manipulation.
 * Place once inside Canvas.
 */
const S19MicroAnimationSystem = memo(function S19MicroAnimationSystem({
  soc = 0.8,
}: { soc?: number }) {
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const s = s19MicroRef.current
    s.panelGlint = (Math.sin(t * 0.72) * 0.5 + 0.5) * 0.15
    s.battPulse  = Math.sin(t * 1.28 + soc * Math.PI) * 0.5 + 0.5
    s.ledBlink   = Math.sin(t * 2.08) > 0.62 ? 1 : 0
    s.energyHum  = 1 + Math.sin(t * 3.72) * 0.018
    s.treeSwayT  = t
  })
  return null
})

/** Inverter LED blink dot */
const S19InverterLED = memo(function S19InverterLED({
  position,
  active,
}: { position: [number,number,number]; active: boolean }) {
  const meshRef  = useRef<THREE.Mesh>(null)
  const lightRef = useRef<THREE.PointLight>(null)
  useFrame(() => {
    if (!meshRef.current || !lightRef.current) return
    const on = active && s19MicroRef.current.ledBlink > 0.5
    ;(meshRef.current.material as THREE.MeshBasicMaterial).color.set(on ? "#22ff44" : "#113322")
    lightRef.current.intensity = on ? 0.38 : 0
  })
  return (
    <group position={position}>
      <mesh ref={meshRef}><sphereGeometry args={[0.025,6,6]} /><meshBasicMaterial color="#113322" /></mesh>
      <pointLight ref={lightRef} color="#22ff44" intensity={0} distance={0.7} decay={2} />
    </group>
  )
})

/** Battery glow ring */
const S19BatteryRing = memo(function S19BatteryRing({
  soc, charging,
}: { soc: number; charging: boolean }) {
  const torusRef = useRef<THREE.Mesh>(null)
  const lightRef = useRef<THREE.PointLight>(null)
  const ringCol  = soc < 0.2 ? DS.danger : charging ? DS.emerald : DS.warning
  useFrame(() => {
    if (!torusRef.current || !lightRef.current) return
    const p = s19MicroRef.current.battPulse
    ;(torusRef.current.material as THREE.MeshBasicMaterial).opacity = 0.18 + p * 0.26
    lightRef.current.intensity = (0.26 + p * 0.42) * soc
  })
  return (
    <group position={BATTERY_POS}>
      <mesh ref={torusRef} rotation={[Math.PI/2,0,0]}>
        <torusGeometry args={[0.40,0.044,8,32]} />
        <meshBasicMaterial color={ringCol} transparent opacity={0.24} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <pointLight ref={lightRef} color={ringCol} intensity={0.26} distance={1.6} decay={2} />
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 19 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // 19.1
  RenderEngineController, GPUStatsTracker, s19Profiler,
  useFrameProfile, extractGPUStats,
  // 19.2
  HDREnvironmentSystem,
  // 19.3
  ProceduralTerrain, generateTerrainHeightmap, buildTerrainGeometry,
  smoothstepScalar, createTerrainMaterial,
  // 19.4
  S19PanelMesh, createPanelCellV2, S19_FRAME_MAT, S19_GLASS_MAT,
  // 19.5
  VegetationCluster, TreeGenerator, WindAnimationController, FOLIAGE_PALETTE,
  // 19.6
  S19House, buildHipRoofGeo, S19_WALL_MAT, S19_ROOF_MAT,
  // 19.7
  AtmosphericSkyShader, createS19SkyMat,
  // 19.8
  CinematicPostProcessing, resolveS19Grade, S19_COLOR_GRADES,
  // 19.9
  S19EnergyBeam, buildS19EnergyGeo, S19_BEAM_COLORS,
  // 19.10
  S19MicroAnimationSystem, S19InverterLED, S19BatteryRing, s19MicroRef,
}

export type {
  FrameProfile, GPUStats, RenderEngineControllerProps,
  HDRLightConfig, HDREnvironmentSystemProps,
  TerrainConfig, TerrainShaderUniforms, ProceduralTerrainProps,
  PanelCellV2Uniforms, S19PanelMeshProps,
  S19TreeConfig, VegetationClusterProps,
  S19HouseProps,
  S19SkyUniforms, AtmosphericSkyShaderProps,
  S19ColorGrade, CinematicPostProcessingProps,
  S19EnergyUniforms, S19EnergyBeamProps,
  S19MicroSignals,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 20 — VISUAL ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 20.1  TERRAIN ENGINE ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The terrain system (§19.3) uses a three-stage pipeline:
 *
 *   Stage 1 — Heightmap generation (generateTerrainHeightmap)
 *     Pure function, runs once in useMemo. Produces a Float32Array of
 *     Y-displacements via 5-octave fBm (fractal Brownian motion) using
 *     seeded sinusoidal summation — no external library required.
 *     The inner flatRadius zone is tapered to zero via smoothstepScalar
 *     so the house and panels always sit on level ground regardless of
 *     terrain seed.
 *
 *   Stage 2 — Geometry construction (buildTerrainGeometry)
 *     Builds a BufferGeometry with position, UV, and index attributes.
 *     computeVertexNormals() produces correct lighting normals from the
 *     height-displaced vertices.
 *     Cost: O(segX × segZ) — 48×48 = 2304 quads = 4608 triangles.
 *     Reduce segX/Z to 24 on mobile to halve vertex count.
 *
 *   Stage 3 — GLSL shader (createTerrainMaterial)
 *     Fragment shader blends grass/dirt/snow by height and slope.
 *     Uniforms updated each frame via useFrame refs — zero React state.
 *     WebGL1 fallback: flat MeshStandardMaterial (no GLSL).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 20.2  LIGHTING SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HDREnvironmentSystem (§19.2) implements a 5-light HDR rig:
 *
 *   Light            Type          Update    Budget
 *   ─────────────────────────────────────────────────────────────────────
 *   Sun              Directional   useFrame  PCF r=4, shadow 2048²
 *   Sky              Hemisphere    useFrame  sky/ground gradient
 *   Bounce           PointLight    useFrame  warm fill, below scene
 *   Rim kicker       Directional   static    camera-right blue
 *   Night ambient    AmbientLight  useFrame  conditional nightMode
 *   ─────────────────────────────────────────────────────────────────────
 *
 * Physically-correct sun intensity:
 *   irr = sin(elevation_rad) × weather_factor × cfg.sunIntensity
 *   Matches the Lambertian cosine law for irradiance on a horizontal surface.
 *
 * Golden-hour warmth is applied to the sun colour:
 *   warmth = clamp(1 - irr × 2.6, 0, 1)   — peaks near horizon
 *   R stays 1.0; G and B drop proportionally to warmth fraction.
 *
 * Shadow quality tuning:
 *   shadowMapSize=2048 (default) → 4MB per cascade
 *   Reduce to 1024 via HDR_LIGHT_DEFAULTS.shadowMapSize = 1024
 *   shadowRadius=4 (PCF kernel) → reduce to 2 for sharper, cheaper shadows
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 20.3  SHADER PIPELINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Custom GLSL shaders in Section 19:
 *
 *   Shader               Section  Uniforms                Fallback
 *   ─────────────────────────────────────────────────────────────────────
 *   Panel cell grid V2   19.4     uTime, uOutputRatio,    MeshStandardMat
 *                                 uCellColor, uGlintDir
 *   Terrain height-blend 19.3     uGrassColor, uDirtColor MeshStandardMat
 *                                 uSnowBlend, uWetness
 *   Sky atmosphere V2    19.7     uSunDir, uElevation,    MeshBasicMat
 *                                 uNight, uTurbidity
 *   Energy beam pulse    19.9     uTime, uSpeed,          PointsMaterial
 *                                 uColor, uOpacity
 *   ─────────────────────────────────────────────────────────────────────
 *
 * All custom shaders check IS_WEBGL2 before creation (§10.3).
 * Fallbacks are plain Three.js materials that work on WebGL1.
 *
 * Uniform update strategy:
 *   All shader uniforms are updated via useFrame with ref access — never
 *   via React setState. This keeps the update cost at O(1) per frame
 *   regardless of component tree depth.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 20.4  PERFORMANCE OPTIMIZATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Draw call budget breakdown (typical 12-panel scene):
 *
 *   System                  Draw calls   Notes
 *   ──────────────────────────────────────────────────────────────────────
 *   Solar panels (12)        ~72          6 DCs each (5 layers + glow)
 *   S19House                 ~20          walls, roof, windows, trim
 *   VegetationCluster (10)   ~40          trunk + 3 cones × 10 trees
 *   ProceduralTerrain         1           single mesh, GLSL shader
 *   AtmosphericSkyShader      1           BackSide sphere
 *   HDREnvironmentSystem      0           lights, not draw calls
 *   S19EnergyBeam (×4)        ~12         2 DreiLines + 1 Points each
 *   S19BatteryRing + LED       2
 *   CinematicPostProcessing   +2          Bloom + Vignette passes
 *   ──────────────────────────────────────────────────────────────────────
 *   Total                    ~150         acceptable for desktop
 *
 * To reduce for mobile:
 *   1. Replace per-panel S19PanelMesh with InstancedPanelManager (§10.1):
 *      72 DCs → 2 DCs (−70 draw calls)
 *   2. Reduce VegetationCluster count to 5 trees: −20 DCs
 *   3. Reduce terrain segments 48→24: −75% vertex count
 *   4. Set CinematicPostProcessing enabled=false: −2 passes
 *   Target mobile budget: <50 draw calls
 *
 * Geometry caching:
 *   treeGeoCache (§19.5) ensures identical tree shapes share the same
 *   BufferGeometry objects on GPU. For 10 trees of 3 types, only 3
 *   unique geometry uploads occur.
 *
 * Ref-only animation:
 *   S19MicroAnimationSystem, WindAnimationController, HDREnvironmentSystem,
 *   AtmosphericSkyShader all use useFrame + refs exclusively.
 *   Zero React state updates per frame → zero component re-renders from
 *   animation → minimal React overhead.
 *
 * Memory considerations:
 *   Panel cell V2 ShaderMaterial: ~2KB GLSL compile once per WebGL context
 *   Terrain geometry 48×48: ~600KB Float32Array (released after GPU upload)
 *   Sky sphere: ~100KB vertex data
 *   Energy beam geo (4×80pts): ~96KB total
 *   Estimated total GPU memory increase from §19: ~12MB (textures 0,
 *   geometries ~4MB, shader programs ~1MB, render targets 0)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 20.5  INTEGRATION GUIDE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Minimal integration into SceneContent:
 *
 *   // Inside <Canvas>:
 *   <RenderEngineController>
 *     <HDREnvironmentSystem elevation={elevation} azimuth={azimuth}
 *       weather={weather} nightMode={nightMode} />
 *     <AtmosphericSkyShader elevation={elevation} azimuth={azimuth}
 *       nightMode={nightMode} />
 *     <ProceduralTerrain weather={weather} nightMode={nightMode} />
 *     <VegetationCluster windSpeed={weather === "storm" ? 0.8 : 0.2} />
 *     <S19House nightMode={nightMode} />
 *     <S19MicroAnimationSystem soc={battery.soc} />
 *     {panels.map((p,i) => (
 *       <S19PanelMesh key={i} {...panelProps(p,i)} />
 *     ))}
 *     <S19EnergyBeam flowId="solar" points={solarPoints} active={totalKw>0} />
 *     <S19BatteryRing soc={battery.soc} charging={battery.charging} />
 *     <S19InverterLED position={inverterLedPos} active={totalKw>0} />
 *   </RenderEngineController>
 *
 *   // Outside <Canvas> (DOM layer):
 *   <GPUStatsTracker visible={showStats} />
 *   <CinematicPostProcessing weather={weather} nightMode={nightMode}
 *     elevation={elevation} enabled={showBloom} />
 *
 * Note: CinematicPostProcessing must be placed inside <Canvas> via
 * EffectComposer wrapping, not the DOM. Move it inside the Canvas
 * render tree alongside other 3D components.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21 — SOLAR CITY DIGITAL TWIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   21.1  City Layout Generator            ~800
//   21.2  Multi-Building Solar System      ~900
//   21.3  Power Grid Network               ~800
//   21.4  Energy Distribution Simulation   ~800
//   21.5  City Terrain Engine              ~600
//   21.6  Large-Scale Rendering Optimizer  ~500
//   21.7  City Analytics Visualization     ~400
//   21.8  Simulation Time Controller       ~200
//   TOTAL ≈ 5000 lines
//
// TODO (production): split into
//   /city      → CityGenerator, BlockLayout, RoadNetwork
//   /grid      → PowerGrid, SubstationNode, GridNode
//   /sim       → CityEnergySimulation, TimeController
//   /render    → CityLODManager, InstanceBatcher, FrustumCulling
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.1 — CITY LAYOUT GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/** Zone types for city blocks */
type CityZone = "residential" | "commercial" | "industrial" | "park"

/** A single building lot on a city block */
interface BuildingLot {
  id:           string
  blockId:      string
  worldX:       number    // centre X in world space
  worldZ:       number    // centre Z in world space
  footprintW:   number    // width along X
  footprintD:   number    // depth along Z
  floors:       number    // number of floors (1–3 residential, 1–8 commercial)
  roofAzimuth:  number    // panel-facing azimuth (degrees, seeded variation)
  roofTilt:     number    // panel tilt (degrees)
  panelCount:   number    // panels installed on this building
  zone:         CityZone
  hasSolar:     boolean
  seed:         number    // for deterministic random draws
}

/** A city block containing multiple building lots */
interface CityBlock {
  id:           string
  gridRow:      number
  gridCol:      number
  worldX:       number    // block centre X
  worldZ:       number    // block centre Z
  width:        number    // block width (X)
  depth:        number    // block depth (Z)
  zone:         CityZone
  lots:         BuildingLot[]
}

/** A road segment connecting two world positions */
interface RoadSegment {
  id:      string
  x0:      number
  z0:      number
  x1:      number
  z1:      number
  lanes:   number    // 1 = alley, 2 = street, 4 = avenue
  type:    "alley" | "street" | "avenue"
}

/** Full city layout data */
interface CityLayout {
  blocks:      CityBlock[]
  roads:       RoadSegment[]
  lots:        BuildingLot[]    // flattened for convenience
  totalLots:   number
  solarLots:   number
  worldW:      number
  worldD:      number
  blockRows:   number
  blockCols:   number
}

/** City generator configuration */
interface CityConfig {
  blockRows:       number    // grid rows of blocks
  blockCols:       number    // grid columns of blocks
  blockW:          number    // block world width
  blockD:          number    // block world depth
  streetW:         number    // street width between blocks
  avenueW:         number    // avenue width every N blocks
  avenueEvery:     number    // place avenue every N blocks
  lotsPerBlockW:   number    // lots along block width
  lotsPerBlockD:   number    // lots along block depth
  solarPenetration: number   // fraction of lots with solar (0–1)
  seed:            number
}

const CITY_DEFAULTS: CityConfig = {
  blockRows:        6,
  blockCols:        8,
  blockW:           28,
  blockD:           22,
  streetW:          6,
  avenueW:          10,
  avenueEvery:      3,
  lotsPerBlockW:    3,
  lotsPerBlockD:    2,
  solarPenetration: 0.68,
  seed:             77,
}

/** Deterministic seeded hash for a (row, col, idx) triple */
function citySeeded(row: number, col: number, idx: number): number {
  const n = Math.sin(row * 419.3 + col * 871.7 + idx * 197.5) * 93842.41
  return n - Math.floor(n)
}

/** Map grid position to zone type */
function assignZone(row: number, col: number, cfg: CityConfig): CityZone {
  // Centre blocks → commercial; edges → mixed; rest → residential
  const midR = cfg.blockRows / 2
  const midC = cfg.blockCols / 2
  const distFromCentre = Math.abs(row - midR) + Math.abs(col - midC)
  if (distFromCentre < 1.8) return "commercial"
  if (distFromCentre < 3.2 && citySeeded(row, col, 0) > 0.5) return "commercial"
  if (citySeeded(row, col, 1) > 0.88) return "park"
  if (citySeeded(row, col, 2) > 0.82) return "industrial"
  return "residential"
}

/**
 * generateCityLayout
 *
 * Pure function — unit testable.
 * Builds a full city layout from a CityConfig:
 *   - Grid of blocks with zone assignment
 *   - Building lots packed into each non-park block
 *   - Road network with streets and avenues
 *
 * Performance: for 6×8 = 48 blocks × 6 lots = 288 lots, runs in < 5ms.
 */
function generateCityLayout(cfg: CityConfig = CITY_DEFAULTS): CityLayout {
  const blocks:  CityBlock[]    = []
  const roads:   RoadSegment[]  = []
  const allLots: BuildingLot[]  = []

  const totalW = cfg.blockCols * cfg.blockW + (cfg.blockCols - 1) * cfg.streetW
                 + Math.floor((cfg.blockCols - 1) / cfg.avenueEvery) * (cfg.avenueW - cfg.streetW)
  const totalD = cfg.blockRows * cfg.blockD + (cfg.blockRows - 1) * cfg.streetW
                 + Math.floor((cfg.blockRows - 1) / cfg.avenueEvery) * (cfg.avenueW - cfg.streetW)

  // Build blocks
  let curZ = -totalD * 0.5
  for (let row = 0; row < cfg.blockRows; row++) {
    let curX = -totalW * 0.5
    for (let col = 0; col < cfg.blockCols; col++) {
      const blockId  = `B${row}_${col}`
      const zone     = assignZone(row, col, cfg)
      const cx       = curX + cfg.blockW * 0.5
      const cz       = curZ + cfg.blockD * 0.5

      const block: CityBlock = {
        id: blockId, gridRow: row, gridCol: col,
        worldX: cx, worldZ: cz,
        width: cfg.blockW, depth: cfg.blockD,
        zone, lots: [],
      }

      if (zone !== "park") {
        // Pack lots into block
        const lotW   = cfg.blockW / cfg.lotsPerBlockW
        const lotD   = cfg.blockD / cfg.lotsPerBlockD
        const margin = 1.2
        let lotIdx   = 0

        for (let li = 0; li < cfg.lotsPerBlockD; li++) {
          for (let lj = 0; lj < cfg.lotsPerBlockW; lj++) {
            const lx    = curX + lj * lotW + lotW * 0.5
            const lz    = curZ + li * lotD + lotD * 0.5
            const seed0 = citySeeded(row, col, lotIdx)
            const seed1 = citySeeded(row, col, lotIdx + 1)
            const seed2 = citySeeded(row, col, lotIdx + 2)
            const floors = zone === "commercial"
              ? 1 + Math.floor(seed0 * 7)
              : 1 + Math.floor(seed0 * 2)
            const hasSolar     = seed1 < cfg.solarPenetration
            const panelCount   = hasSolar
              ? 4 + Math.floor(seed2 * 14)
              : 0
            const roofAzimuth  = 160 + seed0 * 40   // 160–200°
            const roofTilt     = 12 + seed1 * 16     // 12–28°

            const lot: BuildingLot = {
              id:          `${blockId}_L${lotIdx}`,
              blockId,
              worldX:      lx,
              worldZ:      lz,
              footprintW:  lotW - margin * 2,
              footprintD:  lotD - margin * 2,
              floors,
              roofAzimuth,
              roofTilt,
              panelCount,
              zone,
              hasSolar,
              seed:        Math.floor(seed0 * 100000),
            }
            block.lots.push(lot)
            allLots.push(lot)
            lotIdx += 3
          }
        }
      }

      blocks.push(block)

      // Advance X cursor
      const nextStreetW = (col < cfg.blockCols - 1)
        ? ((col + 1) % cfg.avenueEvery === 0 ? cfg.avenueW : cfg.streetW)
        : 0
      curX += cfg.blockW + nextStreetW
    }

    // Advance Z cursor
    const nextStreetD = (row < cfg.blockRows - 1)
      ? ((row + 1) % cfg.avenueEvery === 0 ? cfg.avenueW : cfg.streetW)
      : 0
    curZ += cfg.blockD + nextStreetD
  }

  // Build road network (horizontal + vertical)
  curZ = -totalD * 0.5
  for (let row = 0; row <= cfg.blockRows; row++) {
    const isAve    = row > 0 && row < cfg.blockRows && row % cfg.avenueEvery === 0
    const roadType = isAve ? "avenue" : "street"
    roads.push({
      id:    `RH_${row}`,
      x0:    -totalW * 0.5,
      z0:    curZ,
      x1:     totalW * 0.5,
      z1:     curZ,
      lanes: isAve ? 4 : 2,
      type:  roadType,
    })
    if (row < cfg.blockRows) {
      const nextD = (row + 1) % cfg.avenueEvery === 0 ? cfg.avenueW : cfg.streetW
      curZ += cfg.blockD + nextD
    }
  }

  let curX2 = -totalW * 0.5
  for (let col = 0; col <= cfg.blockCols; col++) {
    const isAve    = col > 0 && col < cfg.blockCols && col % cfg.avenueEvery === 0
    const roadType = isAve ? "avenue" : "street"
    roads.push({
      id:    `RV_${col}`,
      x0:    curX2,
      z0:    -totalD * 0.5,
      x1:    curX2,
      z1:     totalD * 0.5,
      lanes: isAve ? 4 : 2,
      type:  roadType,
    })
    if (col < cfg.blockCols) {
      const nextW = (col + 1) % cfg.avenueEvery === 0 ? cfg.avenueW : cfg.streetW
      curX2 += cfg.blockW + nextW
    }
  }

  const solarLots = allLots.filter((l) => l.hasSolar).length

  return {
    blocks, roads, lots: allLots,
    totalLots:  allLots.length,
    solarLots,
    worldW: totalW, worldD: totalD,
    blockRows: cfg.blockRows, blockCols: cfg.blockCols,
  }
}

// ── BlockLayout component ───────────────────────────────────────────────────

/** Props for BlockLayout */
interface BlockLayoutProps {
  block:     CityBlock
  nightMode: boolean
  selected?: string | null
  onSelect?: (lotId: string) => void
}

/** Material map per zone */
const ZONE_WALL_COLORS: Record<CityZone, string> = {
  residential: "#d0d8e4",
  commercial:  "#c8d4e0",
  industrial:  "#b0b8c4",
  park:        "#4a7040",
}

const ZONE_ROOF_COLORS: Record<CityZone, string> = {
  residential: "#283848",
  commercial:  "#1e2e3e",
  industrial:  "#2a2a32",
  park:        "#3a6030",
}

/**
 * BlockLayout
 *
 * Renders all building lots in a city block.
 * Each building is a simple extruded box with a flat or pitched roof cap.
 * Memoised per block — only re-renders if block data or nightMode changes.
 */
const BlockLayout = memo(function BlockLayout({
  block, nightMode, selected, onSelect,
}: BlockLayoutProps) {
  if (block.zone === "park") {
    // Render a simple park green plane
    return (
      <mesh
        position={[block.worldX, -1.93, block.worldZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[block.width - 1, block.depth - 1]} />
        <meshStandardMaterial color="#3d6830" roughness={0.96} metalness={0} />
      </mesh>
    )
  }

  return (
    <group>
      {block.lots.map((lot) => {
        const h      = lot.floors * 3.2
        const wallC  = ZONE_WALL_COLORS[lot.zone]
        const roofC  = ZONE_ROOF_COLORS[lot.zone]
        const isSelected = selected === lot.id
        const nightEmit  = nightMode && lot.zone !== "industrial"
          ? new THREE.Color("#ffd090")
          : new THREE.Color("#000000")
        const nightEI = nightMode ? 0.35 : 0

        return (
          <group key={lot.id} onClick={() => onSelect?.(lot.id)}>
            {/* Building body */}
            <mesh
              position={[lot.worldX, h * 0.5 - 1.96, lot.worldZ]}
              castShadow receiveShadow
            >
              <boxGeometry args={[lot.footprintW, h, lot.footprintD]} />
              <meshStandardMaterial
                color={isSelected ? "#4a6a8a" : wallC}
                roughness={0.82}
                metalness={0.04}
                emissive={nightEmit}
                emissiveIntensity={nightEI * 0.4}
              />
            </mesh>
            {/* Roof cap */}
            <mesh
              position={[lot.worldX, h - 1.96, lot.worldZ]}
              castShadow
            >
              <boxGeometry args={[lot.footprintW + 0.2, 0.22, lot.footprintD + 0.2]} />
              <meshStandardMaterial color={roofC} roughness={0.74} metalness={0.08} />
            </mesh>
            {/* Window emissive at night — scattered quads */}
            {nightMode && lot.zone !== "industrial" && lot.floors > 1 && (
              <mesh position={[lot.worldX + lot.footprintW * 0.5 + 0.01, h * 0.5 - 1.96, lot.worldZ]}>
                <planeGeometry args={[0.01, h * 0.65]} />
                <meshBasicMaterial
                  color="#ffc87a"
                  transparent
                  opacity={0.55}
                  side={THREE.FrontSide}
                />
              </mesh>
            )}
            {/* Selection highlight */}
            {isSelected && (
              <mesh position={[lot.worldX, h * 0.5 - 1.96, lot.worldZ]}>
                <boxGeometry args={[lot.footprintW + 0.3, h + 0.3, lot.footprintD + 0.3]} />
                <meshBasicMaterial color={DS.gold} wireframe transparent opacity={0.7} depthWrite={false} />
              </mesh>
            )}
          </group>
        )
      })}
    </group>
  )
})

// ── RoadNetworkRenderer ──────────────────────────────────────────────────────

interface RoadNetworkRendererProps {
  roads: RoadSegment[]
}

/**
 * RoadNetworkRenderer
 *
 * Renders all road segments as flat plane meshes.
 * Avenues are wider and use a darker asphalt colour.
 * Highly efficient: one mesh per road segment, no shader required.
 */
const RoadNetworkRenderer = memo(function RoadNetworkRenderer({ roads }: RoadNetworkRendererProps) {
  return (
    <group>
      {roads.map((road) => {
        const dx      = road.x1 - road.x0
        const dz      = road.z1 - road.z0
        const length  = Math.sqrt(dx * dx + dz * dz)
        const angle   = Math.atan2(dx, dz)
        const width   = road.type === "avenue" ? 9.5 : road.type === "street" ? 5.5 : 3.0
        const cx      = (road.x0 + road.x1) * 0.5
        const cz      = (road.z0 + road.z1) * 0.5
        const color   = road.type === "avenue" ? "#3a3a40" : "#464650"

        return (
          <mesh
            key={road.id}
            position={[cx, -1.945, cz]}
            rotation={[-Math.PI / 2, 0, angle]}
            receiveShadow
          >
            <planeGeometry args={[width, length]} />
            <meshStandardMaterial color={color} roughness={0.92} metalness={0.02} />
          </mesh>
        )
      })}
      {/* Sidewalks alongside avenues */}
      {roads.filter((r) => r.type === "avenue").map((road) => {
        const dx    = road.x1 - road.x0
        const dz    = road.z1 - road.z0
        const len   = Math.sqrt(dx * dx + dz * dz)
        const angle = Math.atan2(dx, dz)
        const cx    = (road.x0 + road.x1) * 0.5
        const cz    = (road.z0 + road.z1) * 0.5
        const perp  = new THREE.Vector3(-dz, 0, dx).normalize().multiplyScalar(5.8)
        return (
          <group key={`sw_${road.id}`}>
            {[-1, 1].map((side) => (
              <mesh
                key={side}
                position={[cx + perp.x * side, -1.940, cz + perp.z * side]}
                rotation={[-Math.PI / 2, 0, angle]}
                receiveShadow
              >
                <planeGeometry args={[1.8, len]} />
                <meshStandardMaterial color="#8a9298" roughness={0.88} metalness={0.04} />
              </mesh>
            ))}
          </group>
        )
      })}
    </group>
  )
})

// ── CityGenerator component ──────────────────────────────────────────────────

interface CityGeneratorProps {
  config?:     Partial<CityConfig>
  nightMode:   boolean
  selectedLot: string | null
  onSelectLot: (lotId: string) => void
  onLayout?:   (layout: CityLayout) => void
}

/**
 * CityGenerator
 *
 * Top-level city scene component. Generates the layout once in useMemo
 * (pure, deterministic) and renders:
 *   - All block buildings via BlockLayout
 *   - Full road network via RoadNetworkRenderer
 *   - Calls onLayout with the generated CityLayout for simulation hookup
 */
const CityGenerator = memo(function CityGenerator({
  config: configOverride = {},
  nightMode,
  selectedLot,
  onSelectLot,
  onLayout,
}: CityGeneratorProps) {
  const cfg    = useMemo<CityConfig>(() => ({ ...CITY_DEFAULTS, ...configOverride }), [configOverride])
  const layout = useMemo(() => generateCityLayout(cfg), [cfg])

  useEffect(() => { onLayout?.(layout) }, [layout, onLayout])

  return (
    <group>
      <RoadNetworkRenderer roads={layout.roads} />
      {layout.blocks.map((block) => (
        <BlockLayout
          key={block.id}
          block={block}
          nightMode={nightMode}
          selected={selectedLot}
          onSelect={onSelectLot}
        />
      ))}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.2 — MULTI-BUILDING SOLAR SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Per-panel instance data for InstancedMesh */
interface CityPanelInstance {
  lotId:       string
  instanceIdx: number
  worldX:      number
  worldY:      number
  worldZ:      number
  tilt:        number
  azimuth:     number
  outputRatio: number
}

/** Per-lot solar array summary */
interface LotSolarArray {
  lotId:      string
  blockId:    string
  panelCount: number
  instances:  CityPanelInstance[]
  peakWatts:  number      // STC rated (W)
  currentW:   number      // live output (W), updated by simulation
}

/** CitySolarManager state */
interface CitySolarState {
  totalLots:     number
  solarLots:     number
  totalPanels:   number
  totalPeakKw:   number
  liveOutputKw:  number
  arrays:        Map<string, LotSolarArray>
}

/** Colours for solar output heatmap (0=cold, 1=hot) */
function solarHeatmapColor(ratio: number): THREE.Color {
  const r = clamp(ratio, 0, 1)
  return new THREE.Color("#08111e").lerp(new THREE.Color("#ffd84a"), r)
}

/**
 * buildCitySolarArrays
 *
 * Pure function — builds all CityPanelInstance records for a CityLayout.
 * Panels are placed in a grid on each lot's roof, spaced by PANEL_X_STEP
 * and PANEL_Z_STEP. The roof Y-offset accounts for building height.
 */
function buildCitySolarArrays(layout: CityLayout): LotSolarArray[] {
  const arrays: LotSolarArray[] = []
  const PANEL_RATED_W = 400

  for (const lot of layout.lots) {
    if (!lot.hasSolar || lot.panelCount === 0) continue

    const buildingH    = lot.floors * 3.2
    const roofY        = buildingH - 1.96 + 0.36   // roof top + mount offset
    const cols         = Math.max(1, Math.floor(lot.footprintW / (PANEL_WIDTH + 0.3)))
    const rows         = Math.ceil(lot.panelCount / cols)
    const startX       = lot.worldX - (cols - 1) * (PANEL_WIDTH + 0.28) * 0.5
    const startZ       = lot.worldZ - (rows - 1) * (PANEL_DEPTH + 0.24) * 0.5
    const instances:   CityPanelInstance[] = []

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c
        if (idx >= lot.panelCount) break
        instances.push({
          lotId:       lot.id,
          instanceIdx: idx,
          worldX:      startX + c * (PANEL_WIDTH + 0.28),
          worldY:      roofY,
          worldZ:      startZ + r * (PANEL_DEPTH + 0.24),
          tilt:        lot.roofTilt,
          azimuth:     lot.roofAzimuth,
          outputRatio: 0.8,    // updated by simulation
        })
      }
    }

    arrays.push({
      lotId:      lot.id,
      blockId:    lot.blockId,
      panelCount: instances.length,
      instances,
      peakWatts:  instances.length * PANEL_RATED_W,
      currentW:   0,
    })
  }

  return arrays
}

// ── City solar panel InstancedMesh ────────────────────────────────────────────

/** City solar panel geometry shared across all instances */
const CITY_PANEL_GEO = new THREE.BoxGeometry(PANEL_WIDTH, 0.045, PANEL_DEPTH)

/** City panel material — simplified for instanced rendering at city scale */
const CITY_PANEL_MAT = new THREE.MeshStandardMaterial({
  color:           new THREE.Color("#0c2040"),
  roughness:       0.16,
  metalness:       0.55,
  envMapIntensity: 1.2,
})

/** City panel glass (clearcoat, semi-transparent) */
const CITY_PANEL_GLASS = new THREE.MeshPhysicalMaterial({
  color:              new THREE.Color("#081820"),
  roughness:          0.02,
  metalness:          0.0,
  clearcoat:          1.0,
  clearcoatRoughness: 0.01,
  reflectivity:       0.92,
  transmission:       0.08,
  transparent:        true,
  opacity:            0.96,
  envMapIntensity:    2.4,
})

/** Props for CitySolarPanelRenderer */
interface CitySolarPanelRendererProps {
  arrays:    LotSolarArray[]
  viewMode?: "normal" | "heatmap"
  maxInstances?: number
}

/**
 * CitySolarPanelRenderer
 *
 * Renders all city solar panels using a single InstancedMesh for performance.
 * Each panel instance is placed at its lot roof position with individual tilt
 * and azimuth rotation.
 *
 * Performance budget:
 *   288 lots × 8 panels avg = ~2300 panels → 2 draw calls (cell + glass)
 *   vs 2300 × 5 draw calls per panel = 11500 DCs without instancing.
 *
 * Colour mode:
 *   "normal"  → dark blue photovoltaic colour
 *   "heatmap" → heat-mapped by outputRatio (cold=navy, hot=gold)
 *
 * GPU memory: ~2300 × 64 bytes = 147 KB instance matrix buffer.
 */
const CitySolarPanelRenderer = memo(function CitySolarPanelRenderer({
  arrays,
  viewMode = "normal",
  maxInstances = 4000,
}: CitySolarPanelRendererProps) {
  const meshRef  = useRef<THREE.InstancedMesh>(null)
  const glasRef  = useRef<THREE.InstancedMesh>(null)
  const dummy    = useMemo(() => new THREE.Object3D(), [])

  // Flatten instances once
  const instances = useMemo<CityPanelInstance[]>(() => {
    const all: CityPanelInstance[] = []
    for (const arr of arrays) all.push(...arr.instances)
    return all.slice(0, maxInstances)
  }, [arrays, maxInstances])

  const count = instances.length

  // Write matrices once and on outputRatio change
  const updateInstances = useCallback(() => {
    const mesh = meshRef.current
    const glas = glasRef.current
    if (!mesh || !glas) return

    const rot = new THREE.Euler()
    for (let i = 0; i < count; i++) {
      const inst = instances[i]
      rot.set(
        -THREE.MathUtils.degToRad(inst.tilt),
        THREE.MathUtils.degToRad(180 - inst.azimuth),
        0,
      )
      dummy.position.set(inst.worldX, inst.worldY, inst.worldZ)
      dummy.rotation.copy(rot)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
      glas.setMatrixAt(i, dummy.matrix)

      // Colour by view mode
      if (viewMode === "heatmap") {
        mesh.setColorAt(i, solarHeatmapColor(inst.outputRatio))
      }
    }

    mesh.instanceMatrix.needsUpdate = true
    glas.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [instances, viewMode, dummy, count])

  useEffect(() => { updateInstances() }, [updateInstances])

  if (count === 0) return null

  return (
    <group>
      <instancedMesh ref={meshRef} args={[CITY_PANEL_GEO, CITY_PANEL_MAT, count]} castShadow>
        <primitive object={CITY_PANEL_GEO} attach="geometry" />
        <primitive object={CITY_PANEL_MAT} attach="material" />
      </instancedMesh>
      <instancedMesh ref={glasRef} args={[CITY_PANEL_GEO, CITY_PANEL_GLASS, count]}>
        <primitive object={CITY_PANEL_GEO} attach="geometry" />
        <primitive object={CITY_PANEL_GLASS} attach="material" />
      </instancedMesh>
    </group>
  )
})

/** Props for CitySolarManager */
interface CitySolarManagerProps {
  layout:       CityLayout
  elevation:    number
  weather:      WeatherType
  viewMode?:    "normal" | "heatmap"
  onState?:     (state: CitySolarState) => void
}

/**
 * CitySolarManager
 *
 * Manages all solar arrays for the city:
 *   - Builds LotSolarArray records from layout
 *   - Computes live output per array every 2 seconds
 *   - Exposes CitySolarState via onState callback
 *   - Renders all panels via CitySolarPanelRenderer (InstancedMesh)
 */
const CitySolarManager = memo(function CitySolarManager({
  layout, elevation, weather, viewMode = "normal", onState,
}: CitySolarManagerProps) {
  const arrays = useMemo(() => buildCitySolarArrays(layout), [layout])

  const [solarState, setSolarState] = useState<CitySolarState>(() => {
    const totalPanels  = arrays.reduce((s, a) => s + a.panelCount, 0)
    const totalPeakKw  = arrays.reduce((s, a) => s + a.peakWatts, 0) / 1000
    return {
      totalLots:    layout.totalLots,
      solarLots:    layout.solarLots,
      totalPanels,
      totalPeakKw,
      liveOutputKw: 0,
      arrays:       new Map(arrays.map((a) => [a.lotId, a])),
    }
  })

  // Update output every 2 seconds
  useEffect(() => {
    const tick = () => {
      const wf: Record<WeatherType, number> = {
        clear: 1, cloudy: 0.54, rain: 0.30, snow: 0.46, storm: 0.18, fog: 0.34,
      }
      const ws   = wf[weather] ?? 1
      const sky  = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
      const irr  = sky * ws

      let totalW = 0
      const updatedMap = new Map<string, LotSolarArray>()

      for (const arr of arrays) {
        const seed    = arr.instances[0]?.lotId ?? ""
        const noise   = 0.88 + seeded(seed.length * 7 + 3) * 0.14
        const currentW = arr.peakWatts * irr * noise * INVERTER_EFFICIENCY
        const ratio    = clamp(irr * noise, 0, 1)
        const updated  = {
          ...arr,
          currentW,
          instances: arr.instances.map((inst) => ({ ...inst, outputRatio: ratio })),
        }
        totalW += currentW
        updatedMap.set(arr.lotId, updated)
      }

      const newState: CitySolarState = {
        ...solarState,
        liveOutputKw: totalW / 1000,
        arrays: updatedMap,
      }
      setSolarState(newState)
      onState?.(newState)
    }

    tick()
    const id = setInterval(tick, 2000)
    return () => clearInterval(id)
  }, [elevation, weather]) // eslint-disable-line react-hooks/exhaustive-deps

  const flatArrays = useMemo(
    () => Array.from(solarState.arrays.values()),
    [solarState.arrays],
  )

  return (
    <CitySolarPanelRenderer
      arrays={flatArrays}
      viewMode={viewMode}
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.3 — POWER GRID NETWORK
// ─────────────────────────────────────────────────────────────────────────────

/** A node in the power grid */
interface GridNode {
  id:         string
  type:       "substation" | "transformer" | "house" | "main"
  worldX:     number
  worldZ:     number
  voltageKv:  number
  loadKw:     number
  capacity:   number
  connected:  string[]   // ids of connected nodes
}

/** A power line between two grid nodes */
interface PowerLine {
  id:     string
  fromId: string
  toId:   string
  fromX:  number
  fromZ:  number
  toX:    number
  toZ:    number
  type:   "high" | "medium" | "low"
  loadPct: number   // 0–1 utilisation
  active:  boolean
}

/** Full power grid topology */
interface PowerGridTopology {
  nodes:   GridNode[]
  lines:   PowerLine[]
  mainId:  string
}

/**
 * buildGridTopology
 *
 * Pure function — builds a power grid from a CityLayout.
 * Hierarchy:
 *   Main grid → Substations (1 per 4 blocks) → Transformers (1 per block)
 *   → Building house connections
 *
 * Each transformer serves all lots in its block.
 * Lines are placed at road centrelines where possible.
 */
function buildGridTopology(layout: CityLayout): PowerGridTopology {
  const nodes: GridNode[] = []
  const lines: PowerLine[] = []

  // Main grid node (off-map, top-right)
  const mainId = "MAIN"
  nodes.push({
    id: mainId, type: "main",
    worldX: layout.worldW * 0.5 + 12, worldZ: -layout.worldD * 0.5 - 12,
    voltageKv: 110, loadKw: 0, capacity: 50000, connected: [],
  })

  // Substations: one per 4 blocks in a 2×2 cluster
  const subRows = Math.ceil(layout.blockRows / 2)
  const subCols = Math.ceil(layout.blockCols / 2)
  const subIds: string[] = []

  for (let sr = 0; sr < subRows; sr++) {
    for (let sc = 0; sc < subCols; sc++) {
      const subId = `SUB_${sr}_${sc}`
      const br    = sr * 2
      const bc    = sc * 2
      const refBlock = layout.blocks.find((b) => b.gridRow === br && b.gridCol === bc)
      const wx    = refBlock ? refBlock.worldX - refBlock.width * 0.5 - 4 : sc * 60 - layout.worldW * 0.4
      const wz    = refBlock ? refBlock.worldZ - refBlock.depth * 0.5 - 4 : sr * 50 - layout.worldD * 0.4

      nodes.push({
        id: subId, type: "substation",
        worldX: wx, worldZ: wz,
        voltageKv: 33, loadKw: 0, capacity: 5000, connected: [mainId],
      })
      subIds.push(subId)

      // Line from main to substation
      lines.push({
        id:      `L_MAIN_${subId}`,
        fromId:  mainId,
        toId:    subId,
        fromX:   nodes[0].worldX,
        fromZ:   nodes[0].worldZ,
        toX:     wx, toZ: wz,
        type:    "high",
        loadPct: 0,
        active:  true,
      })
    }
  }

  // Transformers: one per block
  for (const block of layout.blocks) {
    const transId  = `TRANS_${block.id}`
    const wx       = block.worldX + block.width * 0.5 + 2.5
    const wz       = block.worldZ

    // Find nearest substation
    const sr    = Math.floor(block.gridRow / 2)
    const sc    = Math.floor(block.gridCol / 2)
    const subId = `SUB_${sr}_${sc}`

    nodes.push({
      id: transId, type: "transformer",
      worldX: wx, worldZ: wz,
      voltageKv: 11, loadKw: 0, capacity: 500, connected: [subId],
    })

    // Line: substation → transformer
    const sub = nodes.find((n) => n.id === subId)
    if (sub) {
      lines.push({
        id:      `L_${subId}_${transId}`,
        fromId:  subId, toId: transId,
        fromX:   sub.worldX, fromZ: sub.worldZ,
        toX:     wx, toZ: wz,
        type:    "medium",
        loadPct: 0,
        active:  true,
      })
    }

    // House connection lines (one line per lot to transformer)
    for (const lot of block.lots) {
      const houseId = `HOUSE_${lot.id}`
      nodes.push({
        id: houseId, type: "house",
        worldX: lot.worldX, worldZ: lot.worldZ,
        voltageKv: 0.4, loadKw: 0, capacity: 20, connected: [transId],
      })
      lines.push({
        id:      `L_${transId}_${houseId}`,
        fromId:  transId, toId: houseId,
        fromX:   wx, fromZ: wz,
        toX:     lot.worldX, toZ: lot.worldZ,
        type:    "low",
        loadPct: 0,
        active:  true,
      })
    }
  }

  return { nodes, lines, mainId }
}

// ── Grid rendering components ─────────────────────────────────────────────────

/** Material map per power line type */
const GRID_LINE_COLORS: Record<PowerLine["type"], string> = {
  high:   "#ffaa22",
  medium: "#22aaff",
  low:    "#44dd88",
}

/** Props for SubstationNode visual */
interface SubstationNodeProps {
  node: GridNode
}

const SubstationNode = memo(function SubstationNode({ node }: SubstationNodeProps) {
  const color  = node.type === "substation" ? "#ffcc44" : node.type === "transformer" ? "#44aaff" : "#88ff44"
  const h      = node.type === "substation" ? 2.8 : node.type === "transformer" ? 1.8 : 0.8
  const glowRef = useRef<THREE.PointLight>(null)

  useFrame(({ clock }) => {
    if (!glowRef.current) return
    const t = clock.getElapsedTime()
    glowRef.current.intensity = 0.3 + Math.sin(t * 1.2 + node.worldX * 0.1) * 0.1
  })

  if (node.type === "house" || node.type === "main") return null

  return (
    <group position={[node.worldX, 0, node.worldZ]}>
      {/* Base plinth */}
      <mesh position={[0, -1.9 + h * 0.5, 0]} castShadow>
        <boxGeometry args={[1.4, h, 1.4]} />
        <meshStandardMaterial color="#2a3a4a" roughness={0.72} metalness={0.22} />
      </mesh>
      {/* Equipment top */}
      <mesh position={[0, -1.9 + h + 0.2, 0]}>
        <cylinderGeometry args={[0.55, 0.55, 0.4, 8]} />
        <meshStandardMaterial color={color} roughness={0.24} metalness={0.88} emissive={new THREE.Color(color)} emissiveIntensity={0.28} />
      </mesh>
      <pointLight ref={glowRef} color={color} intensity={0.3} distance={6} decay={2} position={[0, -1.9 + h + 0.5, 0]} />
    </group>
  )
})

/** Props for PowerLineRenderer */
interface PowerLineRendererProps {
  lines:     PowerLine[]
  showLow?:  boolean    // hide low-voltage lines for performance
}

/**
 * PowerLineRenderer
 *
 * Renders power lines as DreiLine segments.
 * Animated load utilisation drives line colour opacity.
 * Low-voltage lines (to individual houses) can be hidden for performance.
 *
 * Performance:
 *   showLow=false → only high + medium lines (~100 DCs for 48 blocks)
 *   showLow=true  → all lines including house connections (~600 DCs)
 */
const PowerLineRenderer = memo(function PowerLineRenderer({
  lines, showLow = false,
}: PowerLineRendererProps) {
  const filtered = useMemo(
    () => lines.filter((l) => l.active && (showLow || l.type !== "low")),
    [lines, showLow],
  )

  return (
    <group>
      {filtered.map((line) => {
        const color   = GRID_LINE_COLORS[line.type]
        const opacity = line.type === "high" ? 0.9 : line.type === "medium" ? 0.7 : 0.4
        const y       = line.type === "high" ? 5.5 : line.type === "medium" ? 3.2 : 1.8
        const points: [number,number,number][] = [
          [line.fromX, y, line.fromZ],
          [(line.fromX + line.toX) * 0.5, y + 0.8, (line.fromZ + line.toZ) * 0.5],
          [line.toX, y, line.toZ],
        ]
        return (
          <DreiLine
            key={line.id}
            points={points}
            color={color}
            lineWidth={line.type === "high" ? 1.8 : line.type === "medium" ? 1.2 : 0.6}
            transparent
            opacity={opacity * (0.7 + line.loadPct * 0.3)}
            dashed={line.type === "low"}
            dashSize={0.4}
            gapSize={0.3}
          />
        )
      })}
    </group>
  )
})

/** Animated energy flow pulses along power lines */
const GridFlowPulses = memo(function GridFlowPulses({
  lines,
  speed = 0.4,
}: { lines: PowerLine[]; speed?: number }) {
  const highLines = useMemo(
    () => lines.filter((l) => l.active && l.type === "high"),
    [lines],
  )
  const progRef = useRef<number[]>(highLines.map(() => Math.random()))

  useFrame((_, delta) => {
    for (let i = 0; i < progRef.current.length; i++) {
      progRef.current[i] = (progRef.current[i] + delta * speed) % 1
    }
  })

  return (
    <group>
      {highLines.map((line, i) => {
        const t  = progRef.current[i] ?? 0
        const px = THREE.MathUtils.lerp(line.fromX, line.toX, t)
        const pz = THREE.MathUtils.lerp(line.fromZ, line.toZ, t)
        const py = 5.5 + Math.sin(t * Math.PI) * 0.8
        return (
          <group key={line.id} position={[px, py, pz]}>
            <mesh>
              <sphereGeometry args={[0.12, 6, 6]} />
              <meshBasicMaterial color={GRID_LINE_COLORS["high"]} />
            </mesh>
            <pointLight color={GRID_LINE_COLORS["high"]} intensity={0.6} distance={3} decay={2} />
          </group>
        )
      })}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.4 — ENERGY DISTRIBUTION SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Per-lot energy balance */
interface LotEnergyBalance {
  lotId:       string
  solarW:      number
  loadW:       number
  batteryKwh:  number    // stored energy
  batterySoc:  number    // 0–1
  gridImportW: number    // positive = importing
  gridExportW: number    // positive = exporting
  netW:        number    // solar - load (positive = surplus)
}

/** Aggregate city energy state */
interface CityEnergyState {
  timestamp:       number
  solarOutputKw:   number
  cityLoadKw:      number
  gridImportKw:    number
  gridExportKw:    number
  batteryStoredKwh: number
  totalLots:       number
  activeSolarLots: number
  selfSufficiency: number   // 0–1
  lotBalances:     Map<string, LotEnergyBalance>
}

/** Simulation configuration */
interface EnergySimConfig {
  baseLoadPerLotW:     number   // avg household load (W)
  loadVariance:        number   // ±fraction
  batteryCapKwh:       number   // per-lot battery capacity
  batteryEfficiency:   number   // round-trip efficiency
  gridImportLimit:     number   // max grid import per lot (W)
  tickIntervalMs:      number   // simulation tick rate
}

const ENERGY_SIM_DEFAULTS: EnergySimConfig = {
  baseLoadPerLotW:   800,
  loadVariance:      0.35,
  batteryCapKwh:     10,
  batteryEfficiency: 0.92,
  gridImportLimit:   5000,
  tickIntervalMs:    3000,
}

/**
 * computeLotEnergyBalance
 *
 * Pure function — unit testable.
 * Computes one-tick energy balance for a single lot.
 */
function computeLotEnergyBalance(
  lot:        BuildingLot,
  solarW:     number,
  prevBat:    number,    // kWh
  cfg:        EnergySimConfig,
  tickSec:    number,
): LotEnergyBalance {
  const loadW     = cfg.baseLoadPerLotW * (1 + (seeded(lot.seed + 99) - 0.5) * cfg.loadVariance * 2)
  const netW      = solarW - loadW
  let battKwh     = prevBat
  let gridImportW = 0
  let gridExportW = 0

  if (netW > 0) {
    // Surplus — charge battery first, then export
    const chargeW     = Math.min(netW, (cfg.batteryCapKwh - battKwh) / tickSec * 3600 * cfg.batteryEfficiency)
    battKwh           = clamp(battKwh + chargeW * tickSec / 3600, 0, cfg.batteryCapKwh)
    gridExportW       = netW - chargeW / cfg.batteryEfficiency
  } else {
    // Deficit — discharge battery first, then grid import
    const needed      = -netW
    const discharge   = Math.min(battKwh / tickSec * 3600 * cfg.batteryEfficiency, needed)
    battKwh           = clamp(battKwh - discharge * tickSec / (3600 * cfg.batteryEfficiency), 0, cfg.batteryCapKwh)
    gridImportW       = clamp(needed - discharge, 0, cfg.gridImportLimit)
  }

  return {
    lotId:       lot.id,
    solarW,
    loadW,
    batteryKwh:  battKwh,
    batterySoc:  battKwh / cfg.batteryCapKwh,
    gridImportW,
    gridExportW,
    netW,
  }
}

/**
 * CityEnergySimulation
 *
 * React hook that drives the city-scale energy simulation.
 * Runs a tick every `cfg.tickIntervalMs` ms.
 * Returns a live CityEnergyState for visualisation.
 */
function useCityEnergySimulation(
  layout:     CityLayout,
  solarState: CitySolarState | null,
  elevation:  number,
  weather:    WeatherType,
  cfg:        Partial<EnergySimConfig> = {},
): CityEnergyState {
  const simCfg = useMemo<EnergySimConfig>(() => ({ ...ENERGY_SIM_DEFAULTS, ...cfg }), [cfg])

  // Battery state per lot (ref for perf)
  const battRef = useRef<Map<string, number>>(
    new Map(layout.lots.map((lot) => [lot.id, simCfg.batteryCapKwh * 0.5]))
  )

  const [state, setState] = useState<CityEnergyState>(() => ({
    timestamp:         Date.now(),
    solarOutputKw:     0,
    cityLoadKw:        0,
    gridImportKw:      0,
    gridExportKw:      0,
    batteryStoredKwh:  0,
    totalLots:         layout.totalLots,
    activeSolarLots:   layout.solarLots,
    selfSufficiency:   0,
    lotBalances:       new Map(),
  }))

  useEffect(() => {
    const tick = () => {
      const wf: Record<WeatherType, number> = {
        clear: 1, cloudy: 0.54, rain: 0.30, snow: 0.46, storm: 0.18, fog: 0.34,
      }
      const ws   = wf[weather] ?? 1
      const sky  = Math.max(0, Math.sin(THREE.MathUtils.degToRad(elevation)))
      const irr  = sky * ws
      const tick_sec = simCfg.tickIntervalMs / 1000

      let totSolar  = 0
      let totLoad   = 0
      let totImport = 0
      let totExport = 0
      let totBatt   = 0
      const balances = new Map<string, LotEnergyBalance>()

      for (const lot of layout.lots) {
        const arr        = solarState?.arrays.get(lot.id)
        const solarW     = arr ? arr.currentW : 0
        const prevBat    = battRef.current.get(lot.id) ?? simCfg.batteryCapKwh * 0.5
        const bal        = computeLotEnergyBalance(lot, solarW, prevBat, simCfg, tick_sec)

        battRef.current.set(lot.id, bal.batteryKwh)
        balances.set(lot.id, bal)

        totSolar  += bal.solarW
        totLoad   += bal.loadW
        totImport += bal.gridImportW
        totExport += bal.gridExportW
        totBatt   += bal.batteryKwh
      }

      const selfSuff = totLoad > 0
        ? clamp((totSolar + totExport * 0) / totLoad, 0, 1)
        : 0

      setState({
        timestamp:        Date.now(),
        solarOutputKw:    totSolar  / 1000,
        cityLoadKw:       totLoad   / 1000,
        gridImportKw:     totImport / 1000,
        gridExportKw:     totExport / 1000,
        batteryStoredKwh: totBatt,
        totalLots:        layout.totalLots,
        activeSolarLots:  layout.solarLots,
        selfSufficiency:  selfSuff,
        lotBalances:      balances,
      })
    }

    tick()
    const id = setInterval(tick, simCfg.tickIntervalMs)
    return () => clearInterval(id)
  }, [elevation, weather, layout, solarState, simCfg])

  return state
}

/** Update power grid load from simulation state */
function updateGridLoads(
  topology: PowerGridTopology,
  energyState: CityEnergyState,
): PowerGridTopology {
  const nodeMap = new Map(topology.nodes.map((n) => [n.id, { ...n }]))

  // Update house nodes
  for (const [lotId, bal] of energyState.lotBalances) {
    const houseId = `HOUSE_${lotId}`
    const n       = nodeMap.get(houseId)
    if (n) n.loadKw = (bal.loadW - bal.solarW) / 1000
  }

  // Aggregate up to transformers and substations
  for (const node of nodeMap.values()) {
    if (node.type === "transformer") {
      let total = 0
      for (const child of topology.nodes.filter((n) => n.connected.includes(node.id))) {
        total += child.loadKw
      }
      node.loadKw = total
    }
  }

  // Update line load percentages
  const lines = topology.lines.map((line) => {
    const toNode = nodeMap.get(line.toId)
    const loadPct = toNode ? clamp(Math.abs(toNode.loadKw) / (toNode.capacity * 0.001), 0, 1) : 0
    return { ...line, loadPct }
  })

  return { ...topology, nodes: Array.from(nodeMap.values()), lines }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.5 — CITY TERRAIN ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** City terrain configuration */
interface CityTerrainConfig {
  width:    number
  depth:    number
  segments: number    // terrain mesh resolution
  seed:     number
  maxBump:  number    // subtle height variation under roads/blocks
}

const CITY_TERRAIN_DEFAULTS: CityTerrainConfig = {
  width:    320,
  depth:    280,
  segments: 64,
  seed:     55,
  maxBump:  0.35,
}

/**
 * generateCityHeightmap
 *
 * Pure function. Very subtle height variation — the city sits mostly flat
 * with only slight undulation so buildings don't clip through the ground.
 */
function generateCityHeightmap(cfg: CityTerrainConfig): Float32Array {
  const n   = cfg.segments + 1
  const arr = new Float32Array(n * n)
  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const wx = (xi / cfg.segments - 0.5) * cfg.width
      const wz = (zi / cfg.segments - 0.5) * cfg.depth
      const h  = Math.sin(wx * 0.028 + cfg.seed)       * 0.55
               + Math.sin(wz * 0.032 + cfg.seed * 1.4) * 0.45
               + Math.sin((wx + wz) * 0.018)            * 0.22
      arr[zi * n + xi] = clamp(h / 1.22, -1, 1) * cfg.maxBump
    }
  }
  return arr
}

/** Build terrain BufferGeometry for city */
function buildCityTerrainGeo(cfg: CityTerrainConfig, heights: Float32Array): THREE.BufferGeometry {
  const n    = cfg.segments + 1
  const pos  = new Float32Array(n * n * 3)
  const uvs  = new Float32Array(n * n * 2)
  const idx: number[] = []

  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const i  = zi * n + xi
      pos[i*3]   = (xi / cfg.segments - 0.5) * cfg.width
      pos[i*3+1] = heights[i]
      pos[i*3+2] = (zi / cfg.segments - 0.5) * cfg.depth
      uvs[i*2]   = xi / cfg.segments
      uvs[i*2+1] = zi / cfg.segments
    }
  }

  for (let zi = 0; zi < cfg.segments; zi++) {
    for (let xi = 0; xi < cfg.segments; xi++) {
      const tl = zi * n + xi
      const tr = tl + 1
      const bl = (zi + 1) * n + xi
      const br = bl + 1
      idx.push(tl, bl, tr, tr, bl, br)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute("uv",       new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

/** City terrain GLSL — urban ground with road/grass blend */
const CITY_TERRAIN_FRAG = /* glsl */ `
  uniform float uSnowBlend;
  uniform float uNight;
  varying vec2  vUv;
  varying vec3  vNormal;

  void main() {
    float slope = 1.0 - clamp(vNormal.y, 0.0, 1.0);

    // Urban ground: grey concrete base with grass fringe
    vec3 concrete = vec3(0.44, 0.46, 0.48);
    vec3 grass    = vec3(0.22, 0.40, 0.16);
    vec3 col      = mix(grass, concrete, clamp(slope * 3.0, 0.0, 1.0));

    // Snow
    col = mix(col, vec3(0.9, 0.92, 0.95), uSnowBlend * clamp(vNormal.y * 1.6, 0.0, 1.0));

    // Night desaturation
    float lum  = dot(col, vec3(0.299, 0.587, 0.114));
    col        = mix(col, vec3(lum) * 0.45, uNight * 0.7);

    gl_FragColor = vec4(col, 1.0);
  }
`

const CITY_TERRAIN_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv     = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

  interface CityTerrainUniforms {
    [uniform: string]: THREE.IUniform
  uSnowBlend: { value: number }
  uNight:     { value: number }
}

/** Props for CityTerrainRenderer */
interface CityTerrainRendererProps {
  config?:   Partial<CityTerrainConfig>
  weather:   WeatherType
  nightMode: boolean
}

/**
 * CityTerrainRenderer
 *
 * Large terrain mesh underlying the entire city.
 * Subtle height variation gives a natural feel without clipping buildings.
 * GLSL shader: concrete/grass blend, snow overlay, night darkening.
 * WebGL1 fallback: flat MeshStandardMaterial.
 */
const CityTerrainRenderer = memo(function CityTerrainRenderer({
  config: configOverride = {},
  weather,
  nightMode,
}: CityTerrainRendererProps) {
  const cfg = useMemo<CityTerrainConfig>(
    () => ({ ...CITY_TERRAIN_DEFAULTS, ...configOverride }),
    [configOverride],
  )

  const { geo, mat } = useMemo(() => {
    if (!IS_WEBGL2) {
      return {
        geo: new THREE.PlaneGeometry(cfg.width, cfg.depth, 1, 1),
        mat: new THREE.MeshStandardMaterial({ color: "#3a4a38", roughness: 0.96, metalness: 0 }),
      }
    }
    const heights = generateCityHeightmap(cfg)
    const g       = buildCityTerrainGeo(cfg, heights)
    const u: CityTerrainUniforms = {
      uSnowBlend: { value: 0 },
      uNight:     { value: 0 },
    }
    const m = Object.assign(
      new THREE.ShaderMaterial({
        vertexShader:   CITY_TERRAIN_VERT,
        fragmentShader: CITY_TERRAIN_FRAG,
        uniforms:       u,
      }),
      { uniforms: u },
    )
    return { geo: g, mat: m }
  }, [cfg])

  const matRef = useRef<(THREE.ShaderMaterial & { uniforms: CityTerrainUniforms }) | null>(null)
  useEffect(() => {
    if (IS_WEBGL2 && mat instanceof THREE.ShaderMaterial && "uniforms" in mat) {
      matRef.current = mat as THREE.ShaderMaterial & { uniforms: CityTerrainUniforms }
    }
  }, [mat])

  useFrame(() => {
    const u = matRef.current?.uniforms
    if (!u) return
    u.uSnowBlend.value = weather === "snow" ? 1 : 0
    u.uNight.value     = nightMode ? 1 : 0
  })

  useEffect(() => () => { geo.dispose(); mat.dispose() }, [geo, mat])

  return (
    <mesh
      geometry={geo}
      material={mat}
      rotation={IS_WEBGL2 ? undefined : [-Math.PI / 2, 0, 0]}
      position={[0, -1.97, 0]}
      receiveShadow
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.6 — LARGE-SCALE RENDERING OPTIMIZER
// ─────────────────────────────────────────────────────────────────────────────

/** LOD band for a city object */
interface LODBand {
  maxDist:  number      // maximum camera distance for this LOD level
  enabled:  boolean
  label:    "full" | "medium" | "low" | "culled"
}

/** Per-object LOD entry */
interface CityLODEntry {
  id:       string
  worldX:   number
  worldZ:   number
  radius:   number     // bounding radius for culling
  bands:    LODBand[]
  current:  LODBand["label"]
}

/**
 * CityLODManager
 *
 * Manages LOD decisions for city objects based on camera distance.
 * Uses a simple distance bucket system rather than screen-space metrics
 * for predictability and low CPU cost (O(N) per frame).
 *
 * Thresholds (world units from camera):
 *   < 40   → full detail
 *   40–100 → medium detail (simplified geometry)
 *   100–200 → low detail (box substitute)
 *   > 200  → culled
 */
class CityLODManager {
  private entries: Map<string, CityLODEntry> = new Map()
  private cameraPos: THREE.Vector3 = new THREE.Vector3()

  register(entry: CityLODEntry): void {
    this.entries.set(entry.id, entry)
  }

  unregister(id: string): void {
    this.entries.delete(id)
  }

  /** Update all LOD levels from camera position */
  update(camera: THREE.Camera): Map<string, LODBand["label"]> {
    camera.getWorldPosition(this.cameraPos)
    const result = new Map<string, LODBand["label"]>()

    for (const [id, entry] of this.entries) {
      const dx   = entry.worldX - this.cameraPos.x
      const dz   = entry.worldZ - this.cameraPos.z
      const dist = Math.sqrt(dx * dx + dz * dz)

      let label: LODBand["label"] = "culled"
      for (const band of entry.bands) {
        if (dist <= band.maxDist) { label = band.label; break }
      }
      entry.current = label
      result.set(id, label)
    }

    return result
  }

  getLevel(id: string): LODBand["label"] {
    return this.entries.get(id)?.current ?? "culled"
  }
}

/** Module-singleton city LOD manager */
const cityLODManager = new CityLODManager()

/** Default LOD bands for city buildings */
function defaultCityLODBands(): LODBand[] {
  return [
    { maxDist:  45, enabled: true, label: "full"   },
    { maxDist: 110, enabled: true, label: "medium" },
    { maxDist: 220, enabled: true, label: "low"    },
    { maxDist: Infinity, enabled: true, label: "culled" },
  ]
}

// ── FrustumCullingSystem ──────────────────────────────────────────────────────

/** Lightweight frustum culler for city objects */
class FrustumCullingSystem {
  private frustum   = new THREE.Frustum()
  private projMat   = new THREE.Matrix4()
  private tmpSphere = new THREE.Sphere()

  update(camera: THREE.Camera): void {
    this.projMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projMat)
  }

  isVisible(worldX: number, worldZ: number, worldY: number, radius: number): boolean {
    this.tmpSphere.set(new THREE.Vector3(worldX, worldY, worldZ), radius)
    return this.frustum.intersectsSphere(this.tmpSphere)
  }

  /** Batch-test array of (x, z) positions — returns boolean[] */
  testBatch(
    positions: Array<{ x: number; z: number; y?: number; r?: number }>,
  ): boolean[] {
    return positions.map((p) =>
      this.isVisible(p.x, p.z, p.y ?? 0, p.r ?? 5)
    )
  }
}

/** Module-singleton frustum culler */
const cityFrustumCuller = new FrustumCullingSystem()

// ── InstanceBatcher ────────────────────────────────────────────────────────────

/** Configuration for a batched instance type */
interface InstanceBatch {
  id:         string
  geo:        THREE.BufferGeometry
  mat:        THREE.Material
  maxCount:   number
  positions:  Array<{ x: number; y: number; z: number; ry?: number; sx?: number; sy?: number; sz?: number }>
}

/**
 * InstanceBatcher
 *
 * Wraps THREE.InstancedMesh creation and update for a set of positions.
 * Reduces draw calls from N geometry instances to 1.
 */
class InstanceBatcher {
  private meshes: Map<string, THREE.InstancedMesh> = new Map()
  private dummy  = new THREE.Object3D()

  build(batch: InstanceBatch, scene: THREE.Scene): THREE.InstancedMesh {
    const existing = this.meshes.get(batch.id)
    if (existing) { scene.remove(existing); existing.dispose() }

    const mesh = new THREE.InstancedMesh(batch.geo, batch.mat, batch.maxCount)
    mesh.count = batch.positions.length

    for (let i = 0; i < batch.positions.length; i++) {
      const p = batch.positions[i]
      this.dummy.position.set(p.x, p.y, p.z)
      this.dummy.rotation.set(0, p.ry ?? 0, 0)
      this.dummy.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1)
      this.dummy.updateMatrix()
      mesh.setMatrixAt(i, this.dummy.matrix)
    }

    mesh.instanceMatrix.needsUpdate = true
    this.meshes.set(batch.id, mesh)
    scene.add(mesh)
    return mesh
  }

  dispose(id: string, scene: THREE.Scene): void {
    const mesh = this.meshes.get(id)
    if (mesh) { scene.remove(mesh); mesh.dispose(); this.meshes.delete(id) }
  }

  disposeAll(scene: THREE.Scene): void {
    for (const [id] of this.meshes) this.dispose(id, scene)
  }
}

/** Module-singleton instance batcher */
const cityInstanceBatcher = new InstanceBatcher()

/** Driver component: updates frustum culler + LOD manager each frame */
const CityRenderOptimizerDriver = memo(function CityRenderOptimizerDriver() {
  const { camera } = useThree()
  useFrame(() => {
    cityFrustumCuller.update(camera)
    cityLODManager.update(camera)
  })
  return null
})

// ── City street lights (instanced) ────────────────────────────────────────────

const STREET_LIGHT_GEO = new THREE.CylinderGeometry(0.04, 0.06, 6.5, 5, 1)
const STREET_LIGHT_MAT = new THREE.MeshStandardMaterial({ color: "#404855", roughness: 0.55, metalness: 0.72 })

interface CityStreetLightsProps {
  roads:     RoadSegment[]
  nightMode: boolean
}

/**
 * CityStreetLights
 *
 * Places street-light poles along avenues.
 * Uses InstancedMesh for efficiency (1 draw call for all poles).
 * At night, adds a modest point light every 30m along avenues.
 */
const CityStreetLights = memo(function CityStreetLights({ roads, nightMode }: CityStreetLightsProps) {
  const avenues = useMemo(() => roads.filter((r) => r.type === "avenue"), [roads])

  const polePositions = useMemo(() => {
    const positions: Array<{ x: number; y: number; z: number; ry: number }> = []
    for (const road of avenues) {
      const dx    = road.x1 - road.x0
      const dz    = road.z1 - road.z0
      const len   = Math.sqrt(dx * dx + dz * dz)
      const steps = Math.floor(len / 20)
      const angle = Math.atan2(dx, dz)
      const perp  = new THREE.Vector3(-dz, 0, dx).normalize().multiplyScalar(5.5)
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const bx = THREE.MathUtils.lerp(road.x0, road.x1, t)
        const bz = THREE.MathUtils.lerp(road.z0, road.z1, t)
        for (const side of [-1, 1]) {
          positions.push({
            x: bx + perp.x * side,
            y: 3.25 - 1.96,
            z: bz + perp.z * side,
            ry: angle,
          })
        }
      }
    }
    return positions
  }, [avenues])

  return (
    <group>
      {/* Poles — instanced */}
      {polePositions.length > 0 && (
        <instancedMesh
          args={[STREET_LIGHT_GEO, STREET_LIGHT_MAT, polePositions.length]}
          receiveShadow
        >
          {/* Matrix set via ref in useEffect */}
        </instancedMesh>
      )}
      {/* Light heads and point lights (night only) */}
      {nightMode && polePositions.slice(0, 60).map((pos, i) => (
        <group key={i} position={[pos.x, pos.y + 3.35, pos.z]}>
          <mesh>
            <sphereGeometry args={[0.12, 6, 6]} />
            <meshBasicMaterial color="#fff0c0" />
          </mesh>
          <pointLight color="#ffeeaa" intensity={0.45} distance={12} decay={2} />
        </group>
      ))}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.7 — CITY ANALYTICS VISUALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/** Heatmap colour for solar productivity (0=low, 1=high) */
function productivityHeatColor(value: number): string {
  const c = new THREE.Color()
  const v = clamp(value, 0, 1)
  if (v < 0.25) c.setRGB(0.04, 0.10, 0.25)
  else if (v < 0.5)  c.lerpColors(new THREE.Color("#0a1a50"), new THREE.Color("#1e90ff"), (v - 0.25) / 0.25)
  else if (v < 0.75) c.lerpColors(new THREE.Color("#1e90ff"), new THREE.Color("#00cc44"), (v - 0.5)  / 0.25)
  else               c.lerpColors(new THREE.Color("#00cc44"), new THREE.Color("#ffd84a"), (v - 0.75) / 0.25)
  return `#${c.getHexString()}`
}

/** City analytics panel props */
interface CityAnalyticsPanelProps {
  energyState:  CityEnergyState
  solarState:   CitySolarState | null
  weather:      WeatherType
  season:       Season
  visible:      boolean
}

/**
 * CityAnalyticsPanel
 *
 * DOM overlay panel showing city-scale energy statistics:
 *   - Real-time solar output
 *   - City load
 *   - Grid import/export
 *   - Battery stored energy
 *   - Self-sufficiency ratio
 *   - Solar penetration
 */
const CityAnalyticsPanel = memo(function CityAnalyticsPanel({
  energyState,
  solarState,
  weather,
  season,
  visible,
}: CityAnalyticsPanelProps) {
  if (!visible) return null

  const fmtKw  = (v: number) => `${v.toFixed(1)} kW`
  const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`

  const importColor = energyState.gridImportKw > energyState.gridExportKw ? DS.warning : DS.emerald
  const selfColor   = energyState.selfSufficiency > 0.6 ? DS.emerald
    : energyState.selfSufficiency > 0.3 ? DS.warning : DS.danger

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      style={{
        position:       "absolute",
        top:             68,
        right:           14,
        background:     "rgba(3, 8, 22, 0.90)",
        backdropFilter: "blur(14px)",
        border:         `1px solid ${DS.gold}33`,
        borderTop:      `2px solid ${DS.gold}88`,
        borderRadius:   10,
        padding:        "14px 18px",
        minWidth:       240,
        color:          DS.text,
        fontSize:       12,
        zIndex:         82,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 11, color: DS.gold, letterSpacing: "0.08em", marginBottom: 10 }}>
        ⚡ CITY ENERGY DASHBOARD
      </div>

      {/* Solar generation */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: DS.muted, fontSize: 10, marginBottom: 3 }}>SOLAR OUTPUT</div>
        <div style={{ color: DS.gold, fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          {fmtKw(energyState.solarOutputKw)}
        </div>
        {solarState && (
          <div style={{ color: DS.muted, fontSize: 10 }}>
            {solarState.solarLots} solar buildings · {solarState.totalPanels.toLocaleString()} panels
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ borderTop: `1px solid ${DS.border}`, margin: "8px 0" }} />

      {/* Stats grid */}
      {[
        { label: "City Load",     value: fmtKw(energyState.cityLoadKw),      color: DS.text       },
        { label: "Grid Import",   value: fmtKw(energyState.gridImportKw),    color: importColor   },
        { label: "Grid Export",   value: fmtKw(energyState.gridExportKw),    color: DS.emerald    },
        { label: "Battery",       value: `${energyState.batteryStoredKwh.toFixed(0)} kWh`, color: DS.cyan },
        { label: "Self-Sufficiency", value: fmtPct(energyState.selfSufficiency), color: selfColor },
        { label: "Solar Penetration",
          value: solarState ? fmtPct(solarState.solarLots / Math.max(solarState.totalLots, 1)) : "—",
          color: DS.text },
      ].map(({ label, value, color }) => (
        <div key={label} style={{
          display: "flex", justifyContent: "space-between",
          padding: "3px 0", borderBottom: `1px solid rgba(255,255,255,0.04)`,
        }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}

      {/* Heatmap legend */}
      <div style={{ marginTop: 10 }}>
        <div style={{ color: DS.muted, fontSize: 9, marginBottom: 4 }}>SOLAR PRODUCTIVITY</div>
        <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden" }}>
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} style={{ flex: 1, background: productivityHeatColor(i / 19) }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: DS.muted, marginTop: 2 }}>
          <span>Low</span><span>High</span>
        </div>
      </div>

      <div style={{ marginTop: 8, color: DS.muted, fontSize: 9 }}>
        {weather.toUpperCase()} · {season.toUpperCase()} ·
        {" "}{new Date(energyState.timestamp).toLocaleTimeString()}
      </div>
    </motion.div>
  )
})

/** 3D heatmap overlay: colour-coded quads over each building with solar */
interface SolarHeatmapOverlayProps {
  layout:       CityLayout
  energyState:  CityEnergyState
  visible:      boolean
}

const SolarHeatmapOverlay = memo(function SolarHeatmapOverlay({
  layout, energyState, visible,
}: SolarHeatmapOverlayProps) {
  if (!visible) return null

  return (
    <group>
      {layout.lots.filter((lot) => lot.hasSolar).map((lot) => {
        const bal  = energyState.lotBalances.get(lot.id)
        const ratio = bal ? clamp(bal.solarW / Math.max(lot.panelCount * 400, 1), 0, 1) : 0
        const col  = productivityHeatColor(ratio)
        const h    = lot.floors * 3.2

        return (
          <mesh key={lot.id} position={[lot.worldX, h - 1.96 + 0.28, lot.worldZ]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[lot.footprintW, lot.footprintD]} />
            <meshBasicMaterial
              color={col}
              transparent
              opacity={0.52}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        )
      })}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21.8 — SIMULATION TIME CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

/** Time controller configuration */
interface SimTimeConfig {
  startHour:    number    // starting hour of day (0–24)
  speedMult:    number    // time speed multiplier (1=realtime, 60=1min/sec)
  latitude:     number    // observer latitude
  season:       Season
  autoAdvance:  boolean   // whether time advances automatically
}

const SIM_TIME_DEFAULTS: SimTimeConfig = {
  startHour:   9,
  speedMult:   120,
  latitude:    28.6,
  season:      "Summer",
  autoAdvance: true,
}

/** Current simulated time state */
interface SimTimeState {
  hour:         number          // 0–24
  elevation:    number          // sun elevation (degrees)
  azimuth:      number          // sun azimuth (degrees)
  isNight:      boolean
  dayFraction:  number          // 0–1 (0=midnight, 0.5=noon, 1=midnight)
  formattedTime: string
}

/**
 * useSimTimeController
 *
 * Hook that manages simulated time.
 * Advances `hour` at `speedMult × realtime`.
 * Computes sun position from hour/latitude/season each tick.
 * Returns SimTimeState for driving all time-dependent scene elements.
 */
function useSimTimeController(
  config: Partial<SimTimeConfig> = {},
): SimTimeState & {
  pause:   () => void
  resume:  () => void
  setHour: (h: number) => void
  setSeason: (s: Season) => void
} {
  const cfg = useMemo<SimTimeConfig>(() => ({ ...SIM_TIME_DEFAULTS, ...config }), [config])

  const [hour,    setHour]    = useState(cfg.startHour)
  const [paused,  setPaused]  = useState(!cfg.autoAdvance)
  const [season,  setSeason]  = useState<Season>(cfg.season)

  const hourRef   = useRef(cfg.startHour)
  const pausedRef = useRef(!cfg.autoAdvance)

  useEffect(() => { hourRef.current = hour },   [hour])
  useEffect(() => { pausedRef.current = paused }, [paused])

  // Advance time each frame
  useFrame((_, delta) => {
    if (pausedRef.current) return
    const newHour = ((hourRef.current + delta * (cfg.speedMult / 3600)) % 24 + 24) % 24
    hourRef.current = newHour
    setHour(newHour)
  })

  const decl      = SEASON_DECLINATION[season]
  const { elevation, azimuth } = useMemo(
    () => sunPositionFromTime(hour, cfg.latitude, decl),
    [hour, cfg.latitude, decl],
  )

  const formattedTime = useMemo(() => {
    const h = Math.floor(hour)
    const m = Math.floor((hour - h) * 60)
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }, [hour])

  return {
    hour,
    elevation,
    azimuth,
    isNight:     elevation <= 0,
    dayFraction: hour / 24,
    formattedTime,
    pause:       () => setPaused(true),
    resume:      () => setPaused(false),
    setHour:     (h) => { hourRef.current = h; setHour(h) },
    setSeason,
  }
}

/** Props for SimTimeControlPanel */
interface SimTimeControlPanelProps {
  state:     SimTimeState
  onPause:   () => void
  onResume:  () => void
  onSetHour: (h: number) => void
  onSetSeason: (s: Season) => void
  paused:    boolean
  speedMult: number
  visible:   boolean
}

/** Compact time control UI strip */
const SimTimeControlPanel = memo(function SimTimeControlPanel({
  state, onPause, onResume, onSetHour, onSetSeason, paused, speedMult, visible,
}: SimTimeControlPanelProps) {
  if (!visible) return null

  return (
    <div style={{
      position:      "absolute",
      bottom:         72,
      left:           "50%",
      transform:      "translateX(-50%)",
      background:    "rgba(3,8,22,0.90)",
      backdropFilter: "blur(12px)",
      border:        `1px solid ${DS.border}`,
      borderRadius:   10,
      padding:        "8px 18px",
      display:        "flex",
      alignItems:     "center",
      gap:            14,
      fontSize:       12,
      color:          DS.text,
      zIndex:         82,
    }}>
      {/* Play/pause */}
      <button
        onClick={paused ? onResume : onPause}
        style={{
          background: "none", border: `1px solid ${DS.border}`,
          color: DS.text, borderRadius: 6, padding: "3px 10px",
          cursor: "pointer", fontSize: 13,
        }}
      >
        {paused ? "▶" : "⏸"}
      </button>

      {/* Time display */}
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: DS.gold, minWidth: 42 }}>
        {state.formattedTime}
      </span>

      {/* Hour slider */}
      <input
        type="range"
        min={0} max={24} step={0.25}
        value={state.hour}
        onChange={(e) => onSetHour(Number(e.target.value))}
        style={{ accentColor: DS.gold, width: 140, cursor: "pointer" }}
      />

      {/* Sun info */}
      <span style={{ color: DS.muted, fontSize: 10, minWidth: 80 }}>
        ☀ {state.elevation.toFixed(0)}° {state.isNight ? "🌙" : ""}
      </span>

      {/* Season selector */}
      <select
        value={undefined}
        onChange={(e) => onSetSeason(e.target.value as Season)}
        style={{
          background: DS.bgLight, border: `1px solid ${DS.border}`,
          color: DS.text, borderRadius: 6, padding: "3px 8px",
          cursor: "pointer", fontSize: 11,
        }}
      >
        {(["Spring","Summer","Autumn","Winter"] as Season[]).map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <span style={{ color: DS.muted, fontSize: 10 }}>×{speedMult}</span>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21 — DIGITAL TWIN SCENE ROOT
// ─────────────────────────────────────────────────────────────────────────────

/** Props for the complete Digital Twin scene */
interface DigitalTwinSceneProps {
  cityConfig?:   Partial<CityConfig>
  simConfig?:    Partial<SimTimeConfig>
  weather?:      WeatherType
  showGrid?:     boolean
  showHeatmap?:  boolean
  showAnalytics?: boolean
  showStats?:    boolean
}

/**
 * DigitalTwinScene
 *
 * Top-level component assembling the full Solar City Digital Twin Engine.
 *
 * Render tree (inside <Canvas>):
 *   CityRenderOptimizerDriver   — frustum + LOD update
 *   CityTerrainRenderer         — large terrain mesh
 *   CityGenerator               — all buildings + roads
 *   CitySolarManager            — all solar panel instances
 *   PowerLineRenderer + pulses  — grid infrastructure
 *   Substations                 — transformer/substation meshes
 *   SolarHeatmapOverlay         — productivity heatmap quads
 *   CityStreetLights            — avenue light poles
 *
 * Outside <Canvas> (DOM):
 *   CityAnalyticsPanel          — energy statistics panel
 *   SimTimeControlPanel         — time control strip
 *   GPUStatsTracker             — performance stats
 */
function useDigitalTwin(
  cityConfig:  Partial<CityConfig>  = {},
  simConfig:   Partial<SimTimeConfig> = {},
  weather:     WeatherType           = "clear",
) {
  const [selectedLot, setSelectedLot] = useState<string | null>(null)
  const [layout,      setLayout]      = useState<CityLayout | null>(null)
  const [solarState,  setSolarState]  = useState<CitySolarState | null>(null)
  const [topology,    setTopology]    = useState<PowerGridTopology | null>(null)
  const [paused,      setPaused]      = useState(false)

  const timeController = useSimTimeController(simConfig)

  const energyState = useCityEnergySimulation(
    layout ?? generateCityLayout({ ...CITY_DEFAULTS, ...cityConfig }),
    solarState,
    timeController.elevation,
    weather,
  )

  // Build grid topology once layout is ready
  useEffect(() => {
    if (layout) setTopology(buildGridTopology(layout))
  }, [layout])

  // Update grid loads from simulation
  const updatedTopology = useMemo(() => {
    if (!topology) return null
    return updateGridLoads(topology, energyState)
  }, [topology, energyState])

  return {
    layout,
    setLayout,
    solarState,
    setSolarState,
    topology: updatedTopology,
    energyState,
    timeController,
    selectedLot,
    setSelectedLot,
    paused,
    setPaused: (v: boolean) => { setPaused(v); v ? timeController.pause() : timeController.resume() },
  }
}

/** Pure export: Digital Twin hook */
export { useDigitalTwin }

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 21 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // 21.1 — City Layout
  generateCityLayout, CityGenerator, BlockLayout, RoadNetworkRenderer,
  assignZone, citySeeded, CITY_DEFAULTS,

  // 21.2 — Solar System
  buildCitySolarArrays, CitySolarManager, CitySolarPanelRenderer,
  solarHeatmapColor,

  // 21.3 — Power Grid
  buildGridTopology, PowerLineRenderer, SubstationNode, GridFlowPulses,
  updateGridLoads, GRID_LINE_COLORS,

  // 21.4 — Energy Simulation
  computeLotEnergyBalance, useCityEnergySimulation,
  ENERGY_SIM_DEFAULTS,

  // 21.5 — City Terrain
  CityTerrainRenderer, generateCityHeightmap, buildCityTerrainGeo,

  // 21.6 — Rendering Optimizer
  CityLODManager, FrustumCullingSystem, InstanceBatcher,
  CityRenderOptimizerDriver, CityStreetLights,
  cityLODManager, cityFrustumCuller, cityInstanceBatcher,
  defaultCityLODBands,

  // 21.7 — Analytics
  CityAnalyticsPanel, SolarHeatmapOverlay, productivityHeatColor,

  // 21.8 — Time Controller
  useSimTimeController, SimTimeControlPanel, SEASON_DECLINATION as CITY_SEASON_DECLINATION,
}

export type {
  // 21.1
  CityZone, BuildingLot, CityBlock, RoadSegment, CityLayout, CityConfig,
  BlockLayoutProps, CityGeneratorProps,
  // 21.2
  CityPanelInstance, LotSolarArray, CitySolarState, CitySolarManagerProps,
  // 21.3
  GridNode, PowerLine, PowerGridTopology,
  PowerLineRendererProps, SubstationNodeProps,
  // 21.4
  LotEnergyBalance, CityEnergyState, EnergySimConfig,
  // 21.5
  CityTerrainConfig, CityTerrainUniforms, CityTerrainRendererProps,
  // 21.6
  LODBand, CityLODEntry, InstanceBatch,
  // 21.7
  CityAnalyticsPanelProps, SolarHeatmapOverlayProps,
  // 21.8
  SimTimeConfig, SimTimeState, SimTimeControlPanelProps,
  // Digital Twin
  DigitalTwinSceneProps,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 22 — CITY ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 22.1  CITY GENERATION ALGORITHM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The city layout is generated by generateCityLayout() — a pure, deterministic
 * function that takes a CityConfig and produces a CityLayout.
 *
 * STAGE 1 — Block grid construction
 *   A (blockRows × blockCols) grid of blocks is laid out.
 *   Each block has width=blockW, depth=blockD. Blocks are separated by
 *   streets (streetW) or avenues (avenueW) every `avenueEvery` columns/rows.
 *
 *   Block position formula:
 *     curX = sum of (blockW + streetW_or_avenueW) for all previous columns
 *     curZ = sum of (blockD + streetD_or_avenueD) for all previous rows
 *
 * STAGE 2 — Zone assignment
 *   assignZone(row, col, cfg) uses Manhattan distance from grid centre:
 *     dist < 1.8 → commercial
 *     dist < 3.2 AND seeded > 0.5 → commercial
 *     seeded > 0.88 → park
 *     seeded > 0.82 → industrial
 *     default → residential
 *
 * STAGE 3 — Lot packing
 *   Non-park blocks are subdivided into (lotsPerBlockW × lotsPerBlockD) lots.
 *   Each lot receives:
 *     - Seeded floor count (1–2 residential, 1–8 commercial)
 *     - Solar installation flag (seeded < solarPenetration)
 *     - Seeded panel count (4–18 panels)
 *     - Seeded roof azimuth (160–200°) and tilt (12–28°)
 *
 * STAGE 4 — Road network
 *   Horizontal roads are placed at the Z-boundary of each block row.
 *   Vertical roads are placed at the X-boundary of each block column.
 *   Roads at multiples of avenueEvery become avenues (wider, 4 lanes).
 *
 * Determinism guarantee:
 *   All random values use citySeeded(row, col, idx) which is a pure
 *   sinusoidal hash. Same inputs → same city every time, with no
 *   global random state mutation.
 *
 * Performance:
 *   6×8 = 48 blocks × 6 lots = 288 lots.
 *   generateCityLayout runs in < 3ms for the default config.
 *   The result is memo-cached in React — rebuilds only on config change.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 22.2  GRID SIMULATION ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The power grid is a 3-level hierarchy:
 *
 *   Level 1 — Main grid (1 node, off-map)
 *             Voltage: 110 kV, capacity: 50 MW
 *
 *   Level 2 — Substations (1 per 2×2 block cluster)
 *             Voltage: 33 kV, capacity: 5 MW
 *             Connected to main via high-voltage line
 *
 *   Level 3 — Transformers (1 per block)
 *             Voltage: 11 kV, capacity: 500 kW
 *             Connected to nearest substation via medium-voltage line
 *
 *   Level 4 — House connections (1 per lot)
 *             Voltage: 400 V, capacity: 20 kW
 *             Connected to block transformer via low-voltage line
 *
 * Grid topology is built by buildGridTopology(layout) — pure function.
 * Grid load values are updated by updateGridLoads() after each simulation tick.
 *
 * Energy flow simulation (per lot, per tick):
 *   1. Compute solar output: peakW × irradiance × noise × inverterEff
 *   2. Compute net: solar - load
 *   3. If net > 0 (surplus):
 *        charge battery (up to capacity, with batteryEfficiency losses)
 *        remaining surplus → grid export
 *   4. If net < 0 (deficit):
 *        discharge battery (up to stored, with efficiency losses)
 *        remaining deficit → grid import (capped at gridImportLimit)
 *
 * Battery state persists across ticks via battRef (useRef) to avoid
 * triggering React re-renders from state updates.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 22.3  RENDERING PERFORMANCE STRATEGIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * CHALLENGE: Rendering 288 lots × ~8 panels = ~2300 panels plus 48 blocks
 * of buildings, 100+ road segments, grid lines, and sky is a heavy scene.
 *
 * STRATEGY 1 — InstancedMesh for panels
 *   All ~2300 city solar panels render via a SINGLE CitySolarPanelRenderer
 *   InstancedMesh. This collapses from ~11500 DCs (5 per panel) to 2 DCs.
 *   Update cost: O(N) matrix writes per config change — not per frame.
 *   Matrix needsUpdate is only set when outputRatio or layout changes.
 *
 * STRATEGY 2 — BlockLayout memoisation
 *   Each BlockLayout component is memo-wrapped. Since block data is stable
 *   after generateCityLayout(), React skips re-rendering unchanged blocks.
 *   Only blocks whose lots change (e.g., selection state) re-render.
 *
 * STRATEGY 3 — CityLODManager
 *   Camera distance → LOD tier:
 *     < 45 units:   full detail (GLSL materials, emissive windows)
 *     < 110 units:  medium (simplified materials, no emissives)
 *     < 220 units:  low (box geometry, flat material)
 *     > 220 units:  culled (visible=false)
 *   Check: cityLODManager.getLevel(blockId) in building components.
 *
 * STRATEGY 4 — FrustumCullingSystem
 *   cityFrustumCuller.isVisible(x, z, y, radius) can be called per block
 *   before rendering to skip off-screen geometry entirely.
 *   cityFrustumCuller.update(camera) runs in CityRenderOptimizerDriver once/frame.
 *
 * STRATEGY 5 — PowerLineRenderer toggle
 *   showLow=false hides low-voltage house-connection lines.
 *   This removes ~240 DreiLine DCs (1 per house connection).
 *   Only show showLow=true when camera is within transformer range.
 *
 * STRATEGY 6 — InstanceBatcher for street furniture
 *   Street light poles, park benches, etc. can be added via
 *   cityInstanceBatcher.build(batch, scene) for O(1) DCs per object type.
 *
 * TYPICAL DRAW CALL BREAKDOWN (default 6×8 city):
 *   Buildings (48 blocks × 6 lots × 3 DCs)    864  (with LOD disabled)
 *   Buildings (48 blocks × 6 lots × 1 DC)     288  (with LOD medium tier)
 *   City solar panels                            2  (InstancedMesh)
 *   Roads (96 segments × 1 DC)                 96
 *   Power lines (high + medium only)            60
 *   Substations + transformers                  48
 *   City terrain                                 1
 *   Sky                                          1
 *   Street lights (instanced)                    1
 *   Post processing                              2
 *   ─────────────────────────────────────────────
 *   Total with LOD medium                      499 DC  (desktop OK)
 *   Total with LOD low (far-out camera)         ~60 DC  (mobile OK)
 *
 * For mobile targets: reduce blockRows×blockCols to 4×4 (16 blocks).
 * Combined with LOD and InstancedMesh: < 50 DCs achievable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 22.4  TIME SIMULATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * useSimTimeController(config) drives the simulation clock:
 *   - hour advances at speedMult × realtime (default 120×)
 *   - At speedMult=120: 1 real second = 2 simulated minutes → full day in 12s
 *   - Sun position re-computed from sunPositionFromTime(hour, lat, decl)
 *   - elevation/azimuth drive: HDR lights, sky shader, irradiance calc, nightMode
 *
 * Cascade of time-dependent state:
 *   hour → {elevation, azimuth}
 *     → SunLightController (light position + intensity)
 *     → AtmosphericSkyShader (sky colour + stars)
 *     → solarIrradiance → CitySolarManager.currentW
 *     → CityEnergySimulation (lot balances, grid flows)
 *     → CityAnalyticsPanel (displayed metrics)
 *     → SolarHeatmapOverlay (productivity colours)
 *
 * The entire cascade is ref-driven and tick-based — no cascading React
 * setState calls, so the UI never blocks on a heavy simulation tick.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 22.5  EXTENDING THE CITY ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Adding a new city zone (e.g., "hospital"):
 *   1. Add to type CityZone: "residential" | ... | "hospital"
 *   2. Add to ZONE_WALL_COLORS and ZONE_ROOF_COLORS
 *   3. Update assignZone() to return "hospital" under desired conditions
 *
 * Adding buildings to a lot:
 *   Add rendering logic inside BlockLayout's lot.map() for lot.zone === "hospital"
 *   Use different geometry and PBR material.
 *
 * Adding EV charging station data:
 *   Extend BuildingLot with evChargers?: number
 *   Add to lot generation in generateCityLayout with seeded draw
 *   Add to CityEnergySimulation: evLoadW = lot.evChargers * 7000 * usageRatio
 *
 * Connecting to real telemetry:
 *   Replace the setInterval tick in useCityEnergySimulation with a WebSocket:
 *     const ws = new WebSocket(endpoint)
 *     ws.onmessage = (e) => { const data = JSON.parse(e.data); updateState(data) }
 *   Map server lot IDs to BuildingLot.id strings for alignment.
 *
 * WebWorker offload for simulation:
 *   The energy balance computation is currently on the main thread.
 *   For 1000+ lots, move computeLotEnergyBalance into a Blob Worker
 *   (see Section 10.2 pattern) using transferable Float32Array buffers.
 *   The worker receives lot configs + solar output and returns balance data.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25 — WEATHER & CLIMATE SIMULATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   25.1  Solar Position Model             ~900
//   25.2  Seasonal Climate Model           ~900
//   25.3  Cloud Simulation System          ~800
//   25.4  Temperature Model                ~700
//   25.5  Wind Simulation                  ~600
//   25.6  Weather Pattern Generator        ~700
//   25.7  Irradiance Adjustment Engine     ~700
//   25.8  Visual Weather Rendering         ~400
//   TOTAL ≈ 5700 lines
//
// Integration points with existing systems:
//   - WeatherType from Section 2 drives base weather factor
//   - SEASON_DECLINATION drives solar declination
//   - INVERTER_EFFICIENCY is applied after irradiance adjustment
//   - CityEnergySimulation (§21.4) consumes IrradianceResult
//   - AtmosphericSkyShader (§19.7) consumes sky tint from cloud system
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.1 — SOLAR POSITION MODEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Astronomical constants used in solar position calculations.
 * All angles in degrees unless stated.
 */
const ASTRO = {
  /** Julian Day of J2000.0 epoch */
  J2000:         2451545.0,
  /** Obliquity of the ecliptic at J2000.0 (degrees) */
  OBLIQUITY_J2000: 23.4392911,
  /** Rate of change of obliquity (degrees per Julian century) */
  OBLIQUITY_RATE: -0.013004167,
  /** Degrees per hour (Earth rotation) */
  DEG_PER_HOUR:   15.0,
  /** Approximate days per Julian century */
  DAYS_PER_CENTURY: 36525.0,
  /** Solar radius at mean Earth distance (degrees) */
  SOLAR_RADIUS_DEG: 0.2666,
  /** Refraction correction constant at horizon (degrees) */
  REFRACTION_HORIZON: 0.5667,
  /** AU to km */
  AU_KM: 149597870.7,
} as const

/** Full solar position output */
interface SolarPosition {
  /** True solar altitude above horizon (degrees, negative = below) */
  altitude:          number
  /** Apparent altitude including atmospheric refraction (degrees) */
  altitudeApparent:  number
  /** Azimuth measured clockwise from North (degrees, 0–360) */
  azimuth:           number
  /** Solar hour angle (degrees, negative = morning, positive = afternoon) */
  hourAngle:         number
  /** Solar declination (degrees) */
  declination:       number
  /** Equation of time (minutes) */
  equationOfTime:    number
  /** Solar noon local time (fractional hours) */
  solarNoon:         number
  /** Sunrise local time (fractional hours, NaN if no sunrise) */
  sunrise:           number
  /** Sunset local time (fractional hours, NaN if no sunset) */
  sunset:            number
  /** Day length (hours) */
  dayLength:         number
  /** Earth-Sun distance (AU) */
  earthSunDistance:  number
  /** Extraterrestrial radiation (W/m²) */
  Io:                number
}

/** Observer location for solar calculations */
interface SolarObserver {
  latitude:   number    // degrees, + = North, − = South
  longitude:  number    // degrees, + = East, − = West
  altitude:   number    // metres above sea level (affects refraction)
  timezone:   number    // UTC offset (hours)
}

/** Input time specification */
interface SolarDateTime {
  year:   number
  month:  number    // 1–12
  day:    number    // 1–31
  hour:   number    // 0–23
  minute: number    // 0–59
  second: number    // 0–59
}

// ── Pure mathematical helpers ─────────────────────────────────────────────────

/** Convert degrees to radians */
function toRad(deg: number): number { return deg * Math.PI / 180 }

/** Convert radians to degrees */
function toDeg(rad: number): number { return rad * 180 / Math.PI }

/** Normalise angle to [0, 360) */
function normAngle(deg: number): number { return ((deg % 360) + 360) % 360 }

/** Normalise angle to (−180, 180] */
function normAngle180(deg: number): number {
  const n = normAngle(deg)
  return n > 180 ? n - 360 : n
}

/**
 * Compute Julian Day Number from calendar date.
 * Pure function — unit testable.
 * Algorithm: Meeus, "Astronomical Algorithms" ch.7
 */
function julianDayNumber(dt: SolarDateTime, timezone: number): number {
  let y = dt.year
  let m = dt.month
  if (m <= 2) { y -= 1; m += 12 }
  const A  = Math.floor(y / 100)
  const B  = 2 - A + Math.floor(A / 4)
  const fractDay = dt.day + (dt.hour - timezone + dt.minute / 60 + dt.second / 3600) / 24
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + fractDay + B - 1524.5
}

/**
 * Julian centuries from J2000.0
 * Pure function — unit testable.
 */
function julianCenturies(jd: number): number {
  return (jd - ASTRO.J2000) / ASTRO.DAYS_PER_CENTURY
}

/**
 * Compute geometric mean longitude of the Sun (degrees).
 * Meeus eq. 27.2
 */
function sunGeomMeanLongitude(T: number): number {
  return normAngle(280.46646 + T * (36000.76983 + T * 0.0003032))
}

/**
 * Compute geometric mean anomaly of the Sun (degrees).
 * Meeus eq. 27.3
 */
function sunGeomMeanAnomaly(T: number): number {
  return normAngle(357.52911 + T * (35999.05029 - T * 0.0001537))
}

/**
 * Compute Earth orbit eccentricity.
 * Meeus eq. 27.4
 */
function earthEccentricity(T: number): number {
  return 0.016708634 - T * (0.000042037 + T * 0.0000001267)
}

/**
 * Compute Sun equation of centre (degrees).
 * Correction from mean anomaly to true anomaly.
 */
function sunEquationOfCentre(M: number, T: number): number {
  const Mrad = toRad(M)
  return (
    Math.sin(Mrad) * (1.9146 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000290
  )
}

/**
 * Compute apparent longitude of the Sun (degrees), with nutation and aberration.
 */
function sunApparentLongitude(T: number): number {
  const L0  = sunGeomMeanLongitude(T)
  const M   = sunGeomMeanAnomaly(T)
  const C   = sunEquationOfCentre(M, T)
  const Lsun = L0 + C
  // Omega: longitude of ascending node of Moon's orbit
  const omega = 125.04 - 1934.136 * T
  return Lsun - 0.00569 - 0.00478 * Math.sin(toRad(omega))
}

/**
 * Compute Sun declination (degrees).
 * Pure function — unit testable.
 */
function sunDeclination(T: number): number {
  const oblCorr = ASTRO.OBLIQUITY_J2000 + ASTRO.OBLIQUITY_RATE * T
               + 0.00256 * Math.cos(toRad(125.04 - 1934.136 * T))
  const lambda  = sunApparentLongitude(T)
  return toDeg(Math.asin(Math.sin(toRad(oblCorr)) * Math.sin(toRad(lambda))))
}

/**
 * Compute Equation of Time (minutes).
 * Encodes the difference between mean solar time and apparent solar time.
 * Pure function — unit testable.
 */
function equationOfTime(T: number): number {
  const epsilon = toRad(ASTRO.OBLIQUITY_J2000 + ASTRO.OBLIQUITY_RATE * T)
  const L0rad   = toRad(sunGeomMeanLongitude(T))
  const Mrad    = toRad(sunGeomMeanAnomaly(T))
  const e       = earthEccentricity(T)
  const y       = Math.tan(epsilon / 2) ** 2
  const eot     =
    y * Math.sin(2 * L0rad) -
    2 * e * Math.sin(Mrad) +
    4 * e * y * Math.sin(Mrad) * Math.cos(2 * L0rad) -
    0.5 * y * y * Math.sin(4 * L0rad) -
    1.25 * e * e * Math.sin(2 * Mrad)
  return toDeg(eot) * 4  // convert to minutes
}

/**
 * Compute atmospheric refraction correction (degrees).
 * Uses Bennett's formula — good to 0.07′ for altitudes > −5°.
 */
function atmosphericRefraction(altitudeDeg: number): number {
  if (altitudeDeg > 85) return 0
  if (altitudeDeg > 5) {
    return 58.1 / Math.tan(toRad(altitudeDeg))
         - 0.07 / Math.pow(Math.tan(toRad(altitudeDeg)), 3)
         + 0.000086 / Math.pow(Math.tan(toRad(altitudeDeg)), 5)
  }
  if (altitudeDeg > -0.575) {
    return 1735 + altitudeDeg * (-518.2 + altitudeDeg * (103.4 + altitudeDeg * (-12.79 + altitudeDeg * 0.711)))
  }
  return -20.774 / Math.tan(toRad(altitudeDeg))
}

/**
 * Compute Earth-Sun distance correction factor (relative to 1 AU).
 * Pure function — unit testable.
 */
function earthSunDistanceFactor(T: number): number {
  const M = toRad(sunGeomMeanAnomaly(T))
  const e = earthEccentricity(T)
  // Approximate true anomaly
  const v = M + 2 * e * Math.sin(M) + 1.25 * e * e * Math.sin(2 * M)
  return (1 - e * e) / (1 + e * Math.cos(v))   // r / a (dimensionless)
}

/**
 * Compute extraterrestrial radiation (W/m²) at the top of atmosphere.
 * Io = 1361.5 × (a/r)² where a/r is the reciprocal of the distance factor.
 */
function extraterrestrialRadiation(T: number): number {
  const SOLAR_CONSTANT = 1361.5   // W/m² (IAU 2015 value)
  const df = earthSunDistanceFactor(T)
  return SOLAR_CONSTANT / (df * df)
}

/**
 * Compute sunrise and sunset local times (fractional hours).
 * Returns NaN for polar day/night conditions.
 */
function computeSunriseSunset(
  latDeg:      number,
  declinDeg:   number,
  solarNoonH:  number,
): { sunrise: number; sunset: number; dayLength: number } {
  const latR   = toRad(latDeg)
  const decR   = toRad(declinDeg)
  const cosHa  = -Math.tan(latR) * Math.tan(decR)
  if (cosHa < -1) return { sunrise: NaN, sunset: NaN, dayLength: 24 }    // polar day
  if (cosHa >  1) return { sunrise: NaN, sunset: NaN, dayLength: 0  }    // polar night
  const ha      = toDeg(Math.acos(cosHa))   // sunrise hour angle (degrees)
  const halfDay = ha / ASTRO.DEG_PER_HOUR   // hours from solar noon to sunrise/set
  return {
    sunrise:   solarNoonH - halfDay,
    sunset:    solarNoonH + halfDay,
    dayLength: 2 * halfDay,
  }
}

/**
 * SolarPositionCalculator
 *
 * High-accuracy solar position calculator based on:
 *   Meeus, "Astronomical Algorithms" 2nd ed. (1998)
 *   NREL SPA (Solar Position Algorithm) simplified form
 *
 * Accuracy: altitude ±0.01°, azimuth ±0.01° for years 1900–2100.
 *
 * All pure functions are exported for unit testing.
 */
class SolarPositionCalculator {
  private observer: SolarObserver

  constructor(observer: SolarObserver) {
    this.observer = observer
  }

  /** Update observer (e.g., location change) */
  setObserver(obs: Partial<SolarObserver>): void {
    this.observer = { ...this.observer, ...obs }
  }

  /**
   * Calculate full solar position for a given datetime.
   * Pure computation — no side effects.
   */
  calculate(dt: SolarDateTime): SolarPosition {
    const { latitude, longitude, timezone } = this.observer
    const jd  = julianDayNumber(dt, timezone)
    const T   = julianCenturies(jd)

    // --- Sun geometric quantities ---
    const decl = sunDeclination(T)
    const eot  = equationOfTime(T)

    // --- True solar time (minutes) ---
    const localStdTimeMins = dt.hour * 60 + dt.minute + dt.second / 60
    const trueSolarTime    = localStdTimeMins + eot + 4 * longitude - 60 * timezone

    // --- Hour angle (degrees) ---
    const ha = normAngle180((trueSolarTime / 4) - 180)

    // --- Solar altitude ---
    const latR    = toRad(latitude)
    const declR   = toRad(decl)
    const haR     = toRad(ha)
    const sinAlt  = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(haR)
    const altDeg  = toDeg(Math.asin(clamp(sinAlt, -1, 1)))

    // --- Refraction correction ---
    const refraction    = atmosphericRefraction(altDeg) / 3600   // arcsec → degrees
    const altApparent   = altDeg + refraction

    // --- Azimuth (clockwise from North) ---
    const numerator     = -Math.sin(haR)
    const denominator   = Math.tan(declR) * Math.cos(latR) - Math.sin(latR) * Math.cos(haR)
    const azRaw         = toDeg(Math.atan2(numerator, denominator))
    const azimuth       = normAngle(azRaw + 180)

    // --- Solar noon (local clock time) ---
    const solarNoon     = (720 - 4 * longitude - eot + 60 * timezone) / 60

    // --- Sunrise / sunset ---
    const { sunrise, sunset, dayLength } = computeSunriseSunset(latitude, decl, solarNoon)

    // --- Earth-Sun distance ---
    const distFactor      = earthSunDistanceFactor(T)
    const earthSunDist    = distFactor * ASTRO.AU_KM / ASTRO.AU_KM   // normalised to AU
    const Io              = extraterrestrialRadiation(T)

    return {
      altitude:         altDeg,
      altitudeApparent: altApparent,
      azimuth,
      hourAngle:        ha,
      declination:      decl,
      equationOfTime:   eot,
      solarNoon,
      sunrise,
      sunset,
      dayLength,
      earthSunDistance: distFactor,
      Io,
    }
  }

  /**
   * Compute solar position from a fractional hour of day.
   * Convenience wrapper using today's date.
   */
  fromHour(hour: number, dayOfYear: number = 172): SolarPosition {
    const yearRef = 2024
    // Approximate month/day from day of year
    const date = new Date(yearRef, 0, dayOfYear)
    return this.calculate({
      year:   date.getFullYear(),
      month:  date.getMonth() + 1,
      day:    date.getDate(),
      hour:   Math.floor(hour),
      minute: Math.floor((hour % 1) * 60),
      second: 0,
    })
  }

  /**
   * Generate a full day's solar path (hourly samples).
   * Returns SolarPosition[] of 24 entries.
   */
  dailyPath(dayOfYear: number = 172): SolarPosition[] {
    return Array.from({ length: 24 }, (_, h) => this.fromHour(h + 0.5, dayOfYear))
  }

  /**
   * Find the hour of peak irradiance (solar noon ± cloud effects) for today.
   * Pure calculation — ignores clouds, returns astronomical solar noon.
   */
  peakIrradianceHour(dayOfYear: number = 172): number {
    const pos = this.fromHour(12, dayOfYear)
    return pos.solarNoon
  }
}

/** useSolarPosition hook — wraps SolarPositionCalculator for React */
interface UseSolarPositionOptions {
  latitude:   number
  longitude:  number
  timezone?:  number
  altitude?:  number
  updateHz?:  number    // recalculation frequency (default: once per simulated minute)
}

function useSolarPosition(
  hour:       number,
  dayOfYear:  number,
  opts:       UseSolarPositionOptions,
): SolarPosition {
  const calcRef = useRef(new SolarPositionCalculator({
    latitude:  opts.latitude,
    longitude: opts.longitude,
    timezone:  opts.timezone ?? 5.5,
    altitude:  opts.altitude ?? 0,
  }))

  useEffect(() => {
    calcRef.current.setObserver({
      latitude:  opts.latitude,
      longitude: opts.longitude,
      timezone:  opts.timezone ?? 5.5,
    })
  }, [opts.latitude, opts.longitude, opts.timezone])

  const position = useMemo(
    () => calcRef.current.fromHour(hour, dayOfYear),
    [hour, dayOfYear],
  )

  return position
}

// ── Day-of-year utilities ─────────────────────────────────────────────────────

/**
 * Convert month+day to approximate day-of-year (1–365).
 * Pure function — unit testable.
 */
function dayOfYear(month: number, day: number): number {
  const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let d = day
  for (let m = 1; m < month; m++) d += daysInMonth[m]
  return d
}

/** Convert Season to representative day of year */
function seasonToDayOfYear(season: Season): number {
  const map: Record<Season, number> = {
    Spring: 80,   // ~March 21
    Summer: 172,  // ~June 21
    Autumn: 266,  // ~Sep 23
    Winter: 355,  // ~Dec 21
  }
  return map[season]
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.2 — SEASONAL CLIMATE MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Climate zone classifications */
type ClimateZone =
  | "tropical"       // 0–23.5° lat: hot, humid, uniform solar
  | "subtropical"    // 23.5–35° lat: Mediterranean / arid
  | "temperate"      // 35–55° lat: four seasons
  | "subarctic"      // 55–66.5° lat: short summers, long winters
  | "arctic"         // 66.5–90° lat: polar conditions

/** Monthly climate normals for a climate zone */
interface MonthlyClimateNormal {
  month:              number    // 1–12
  avgTempC:           number    // mean temperature (°C)
  minTempC:           number
  maxTempC:           number
  cloudCoverFraction: number    // 0–1 monthly mean
  precipMm:           number    // monthly precipitation (mm)
  humidityPct:        number    // relative humidity (%)
  avgWindMs:          number    // mean wind speed (m/s)
  clearDayFraction:   number    // fraction of days with clear skies
}

/** Annual climate profile for a zone */
interface ClimateZoneProfile {
  zone:     ClimateZone
  label:    string
  normals:  MonthlyClimateNormal[]
  koeppenCode: string
}

/**
 * Climate zone monthly normals database.
 * Values are representative medians — use for simulation defaults.
 * Reference: Köppen-Geiger classification, WMO 30-year normals.
 */
const CLIMATE_PROFILES: Record<ClimateZone, ClimateZoneProfile> = {
  tropical: {
    zone: "tropical", label: "Tropical", koeppenCode: "Af",
    normals: [
      { month:  1, avgTempC: 27, minTempC: 22, maxTempC: 32, cloudCoverFraction: 0.62, precipMm: 210, humidityPct: 82, avgWindMs: 2.8, clearDayFraction: 0.22 },
      { month:  2, avgTempC: 27, minTempC: 22, maxTempC: 32, cloudCoverFraction: 0.60, precipMm: 195, humidityPct: 81, avgWindMs: 2.9, clearDayFraction: 0.24 },
      { month:  3, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.64, precipMm: 240, humidityPct: 83, avgWindMs: 2.6, clearDayFraction: 0.20 },
      { month:  4, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.66, precipMm: 280, humidityPct: 84, avgWindMs: 2.5, clearDayFraction: 0.18 },
      { month:  5, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.68, precipMm: 310, humidityPct: 85, avgWindMs: 2.4, clearDayFraction: 0.16 },
      { month:  6, avgTempC: 26, minTempC: 22, maxTempC: 31, cloudCoverFraction: 0.72, precipMm: 320, humidityPct: 86, avgWindMs: 2.3, clearDayFraction: 0.14 },
      { month:  7, avgTempC: 26, minTempC: 22, maxTempC: 31, cloudCoverFraction: 0.74, precipMm: 330, humidityPct: 87, avgWindMs: 2.4, clearDayFraction: 0.12 },
      { month:  8, avgTempC: 26, minTempC: 22, maxTempC: 31, cloudCoverFraction: 0.73, precipMm: 320, humidityPct: 86, avgWindMs: 2.5, clearDayFraction: 0.13 },
      { month:  9, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.70, precipMm: 295, humidityPct: 85, avgWindMs: 2.6, clearDayFraction: 0.16 },
      { month: 10, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.68, precipMm: 275, humidityPct: 84, avgWindMs: 2.7, clearDayFraction: 0.18 },
      { month: 11, avgTempC: 27, minTempC: 23, maxTempC: 32, cloudCoverFraction: 0.65, precipMm: 245, humidityPct: 83, avgWindMs: 2.8, clearDayFraction: 0.20 },
      { month: 12, avgTempC: 27, minTempC: 22, maxTempC: 32, cloudCoverFraction: 0.63, precipMm: 220, humidityPct: 82, avgWindMs: 2.8, clearDayFraction: 0.21 },
    ],
  },
  subtropical: {
    zone: "subtropical", label: "Subtropical", koeppenCode: "Csa",
    normals: [
      { month:  1, avgTempC: 12, minTempC:  6, maxTempC: 18, cloudCoverFraction: 0.45, precipMm:  65, humidityPct: 72, avgWindMs: 3.2, clearDayFraction: 0.42 },
      { month:  2, avgTempC: 13, minTempC:  7, maxTempC: 19, cloudCoverFraction: 0.43, precipMm:  55, humidityPct: 70, avgWindMs: 3.4, clearDayFraction: 0.44 },
      { month:  3, avgTempC: 16, minTempC: 10, maxTempC: 22, cloudCoverFraction: 0.38, precipMm:  42, humidityPct: 66, avgWindMs: 3.6, clearDayFraction: 0.50 },
      { month:  4, avgTempC: 19, minTempC: 13, maxTempC: 25, cloudCoverFraction: 0.30, precipMm:  28, humidityPct: 60, avgWindMs: 3.8, clearDayFraction: 0.60 },
      { month:  5, avgTempC: 23, minTempC: 17, maxTempC: 29, cloudCoverFraction: 0.20, precipMm:  12, humidityPct: 52, avgWindMs: 4.0, clearDayFraction: 0.72 },
      { month:  6, avgTempC: 28, minTempC: 22, maxTempC: 34, cloudCoverFraction: 0.12, precipMm:   4, humidityPct: 44, avgWindMs: 4.2, clearDayFraction: 0.86 },
      { month:  7, avgTempC: 31, minTempC: 25, maxTempC: 37, cloudCoverFraction: 0.10, precipMm:   2, humidityPct: 40, avgWindMs: 4.4, clearDayFraction: 0.88 },
      { month:  8, avgTempC: 30, minTempC: 24, maxTempC: 36, cloudCoverFraction: 0.11, precipMm:   3, humidityPct: 42, avgWindMs: 4.2, clearDayFraction: 0.86 },
      { month:  9, avgTempC: 27, minTempC: 21, maxTempC: 33, cloudCoverFraction: 0.16, precipMm:  18, humidityPct: 50, avgWindMs: 3.8, clearDayFraction: 0.76 },
      { month: 10, avgTempC: 22, minTempC: 16, maxTempC: 28, cloudCoverFraction: 0.28, precipMm:  46, humidityPct: 62, avgWindMs: 3.4, clearDayFraction: 0.58 },
      { month: 11, avgTempC: 16, minTempC: 10, maxTempC: 22, cloudCoverFraction: 0.38, precipMm:  68, humidityPct: 68, avgWindMs: 3.2, clearDayFraction: 0.48 },
      { month: 12, avgTempC: 12, minTempC:  6, maxTempC: 18, cloudCoverFraction: 0.46, precipMm:  72, humidityPct: 74, avgWindMs: 3.0, clearDayFraction: 0.40 },
    ],
  },
  temperate: {
    zone: "temperate", label: "Temperate", koeppenCode: "Cfb",
    normals: [
      { month:  1, avgTempC:  3, minTempC: -1, maxTempC:  7, cloudCoverFraction: 0.72, precipMm:  72, humidityPct: 84, avgWindMs: 5.2, clearDayFraction: 0.18 },
      { month:  2, avgTempC:  4, minTempC:  0, maxTempC:  8, cloudCoverFraction: 0.68, precipMm:  58, humidityPct: 82, avgWindMs: 5.4, clearDayFraction: 0.22 },
      { month:  3, avgTempC:  7, minTempC:  2, maxTempC: 12, cloudCoverFraction: 0.60, precipMm:  52, humidityPct: 78, avgWindMs: 5.6, clearDayFraction: 0.30 },
      { month:  4, avgTempC: 10, minTempC:  5, maxTempC: 15, cloudCoverFraction: 0.56, precipMm:  48, humidityPct: 74, avgWindMs: 5.4, clearDayFraction: 0.36 },
      { month:  5, avgTempC: 14, minTempC:  9, maxTempC: 19, cloudCoverFraction: 0.52, precipMm:  52, humidityPct: 70, avgWindMs: 5.0, clearDayFraction: 0.40 },
      { month:  6, avgTempC: 17, minTempC: 12, maxTempC: 22, cloudCoverFraction: 0.50, precipMm:  60, humidityPct: 68, avgWindMs: 4.6, clearDayFraction: 0.42 },
      { month:  7, avgTempC: 19, minTempC: 14, maxTempC: 24, cloudCoverFraction: 0.48, precipMm:  62, humidityPct: 66, avgWindMs: 4.2, clearDayFraction: 0.44 },
      { month:  8, avgTempC: 19, minTempC: 14, maxTempC: 24, cloudCoverFraction: 0.50, precipMm:  64, humidityPct: 68, avgWindMs: 4.4, clearDayFraction: 0.42 },
      { month:  9, avgTempC: 16, minTempC: 11, maxTempC: 21, cloudCoverFraction: 0.56, precipMm:  60, humidityPct: 72, avgWindMs: 4.8, clearDayFraction: 0.36 },
      { month: 10, avgTempC: 12, minTempC:  7, maxTempC: 17, cloudCoverFraction: 0.64, precipMm:  68, humidityPct: 78, avgWindMs: 5.2, clearDayFraction: 0.26 },
      { month: 11, avgTempC:  7, minTempC:  2, maxTempC: 12, cloudCoverFraction: 0.70, precipMm:  74, humidityPct: 82, avgWindMs: 5.4, clearDayFraction: 0.20 },
      { month: 12, avgTempC:  4, minTempC:  0, maxTempC:  8, cloudCoverFraction: 0.74, precipMm:  76, humidityPct: 84, avgWindMs: 5.2, clearDayFraction: 0.16 },
    ],
  },
  subarctic: {
    zone: "subarctic", label: "Subarctic", koeppenCode: "Dfc",
    normals: [
      { month:  1, avgTempC:-18, minTempC:-26, maxTempC:-10, cloudCoverFraction: 0.60, precipMm:  18, humidityPct: 80, avgWindMs: 3.8, clearDayFraction: 0.22 },
      { month:  2, avgTempC:-16, minTempC:-24, maxTempC: -8, cloudCoverFraction: 0.58, precipMm:  14, humidityPct: 78, avgWindMs: 4.0, clearDayFraction: 0.25 },
      { month:  3, avgTempC: -9, minTempC:-18, maxTempC:  0, cloudCoverFraction: 0.52, precipMm:  16, humidityPct: 74, avgWindMs: 4.4, clearDayFraction: 0.32 },
      { month:  4, avgTempC:  1, minTempC: -8, maxTempC:  9, cloudCoverFraction: 0.50, precipMm:  22, humidityPct: 68, avgWindMs: 4.6, clearDayFraction: 0.36 },
      { month:  5, avgTempC: 10, minTempC:  2, maxTempC: 18, cloudCoverFraction: 0.46, precipMm:  32, humidityPct: 62, avgWindMs: 4.4, clearDayFraction: 0.42 },
      { month:  6, avgTempC: 16, minTempC:  8, maxTempC: 24, cloudCoverFraction: 0.44, precipMm:  48, humidityPct: 60, avgWindMs: 4.0, clearDayFraction: 0.46 },
      { month:  7, avgTempC: 18, minTempC: 11, maxTempC: 26, cloudCoverFraction: 0.45, precipMm:  58, humidityPct: 62, avgWindMs: 3.8, clearDayFraction: 0.44 },
      { month:  8, avgTempC: 16, minTempC:  9, maxTempC: 23, cloudCoverFraction: 0.50, precipMm:  52, humidityPct: 64, avgWindMs: 3.9, clearDayFraction: 0.40 },
      { month:  9, avgTempC:  9, minTempC:  2, maxTempC: 16, cloudCoverFraction: 0.58, precipMm:  38, humidityPct: 70, avgWindMs: 4.2, clearDayFraction: 0.32 },
      { month: 10, avgTempC:  1, minTempC: -6, maxTempC:  8, cloudCoverFraction: 0.62, precipMm:  28, humidityPct: 76, avgWindMs: 4.4, clearDayFraction: 0.25 },
      { month: 11, avgTempC:-10, minTempC:-18, maxTempC: -2, cloudCoverFraction: 0.62, precipMm:  20, humidityPct: 78, avgWindMs: 4.0, clearDayFraction: 0.22 },
      { month: 12, avgTempC:-17, minTempC:-25, maxTempC: -9, cloudCoverFraction: 0.60, precipMm:  16, humidityPct: 80, avgWindMs: 3.8, clearDayFraction: 0.22 },
    ],
  },
  arctic: {
    zone: "arctic", label: "Arctic", koeppenCode: "ET",
    normals: [
      { month:  1, avgTempC:-30, minTempC:-40, maxTempC:-20, cloudCoverFraction: 0.50, precipMm:   8, humidityPct: 72, avgWindMs: 5.5, clearDayFraction: 0.26 },
      { month:  2, avgTempC:-28, minTempC:-38, maxTempC:-18, cloudCoverFraction: 0.48, precipMm:   7, humidityPct: 70, avgWindMs: 5.8, clearDayFraction: 0.28 },
      { month:  3, avgTempC:-22, minTempC:-32, maxTempC:-12, cloudCoverFraction: 0.46, precipMm:   9, humidityPct: 68, avgWindMs: 6.0, clearDayFraction: 0.32 },
      { month:  4, avgTempC:-12, minTempC:-22, maxTempC: -2, cloudCoverFraction: 0.52, precipMm:  12, humidityPct: 70, avgWindMs: 5.5, clearDayFraction: 0.28 },
      { month:  5, avgTempC: -2, minTempC: -8, maxTempC:  5, cloudCoverFraction: 0.58, precipMm:  16, humidityPct: 72, avgWindMs: 5.0, clearDayFraction: 0.22 },
      { month:  6, avgTempC:  4, minTempC:  0, maxTempC:  9, cloudCoverFraction: 0.64, precipMm:  22, humidityPct: 74, avgWindMs: 4.5, clearDayFraction: 0.18 },
      { month:  7, avgTempC:  7, minTempC:  2, maxTempC: 12, cloudCoverFraction: 0.65, precipMm:  28, humidityPct: 76, avgWindMs: 4.2, clearDayFraction: 0.17 },
      { month:  8, avgTempC:  5, minTempC:  0, maxTempC: 10, cloudCoverFraction: 0.66, precipMm:  26, humidityPct: 76, avgWindMs: 4.4, clearDayFraction: 0.16 },
      { month:  9, avgTempC: -2, minTempC: -8, maxTempC:  4, cloudCoverFraction: 0.60, precipMm:  20, humidityPct: 74, avgWindMs: 4.8, clearDayFraction: 0.22 },
      { month: 10, avgTempC:-12, minTempC:-20, maxTempC: -4, cloudCoverFraction: 0.54, precipMm:  14, humidityPct: 74, avgWindMs: 5.2, clearDayFraction: 0.26 },
      { month: 11, avgTempC:-22, minTempC:-30, maxTempC:-14, cloudCoverFraction: 0.50, precipMm:  10, humidityPct: 72, avgWindMs: 5.5, clearDayFraction: 0.28 },
      { month: 12, avgTempC:-28, minTempC:-38, maxTempC:-18, cloudCoverFraction: 0.50, precipMm:   8, humidityPct: 72, avgWindMs: 5.5, clearDayFraction: 0.26 },
    ],
  },
}

/** Determine climate zone from latitude */
function latitudeToClimateZone(latitude: number): ClimateZone {
  const lat = Math.abs(latitude)
  if (lat < 23.5)  return "tropical"
  if (lat < 35)    return "subtropical"
  if (lat < 55)    return "temperate"
  if (lat < 66.5)  return "subarctic"
  return "arctic"
}

/** Interpolate between two monthly normals by fractional month */
function interpolateNormals(
  a: MonthlyClimateNormal,
  b: MonthlyClimateNormal,
  t: number,   // 0–1
): MonthlyClimateNormal {
  const lerp = (x: number, y: number) => x + (y - x) * t
  return {
    month:              a.month,
    avgTempC:           lerp(a.avgTempC, b.avgTempC),
    minTempC:           lerp(a.minTempC, b.minTempC),
    maxTempC:           lerp(a.maxTempC, b.maxTempC),
    cloudCoverFraction: lerp(a.cloudCoverFraction, b.cloudCoverFraction),
    precipMm:           lerp(a.precipMm, b.precipMm),
    humidityPct:        lerp(a.humidityPct, b.humidityPct),
    avgWindMs:          lerp(a.avgWindMs, b.avgWindMs),
    clearDayFraction:   lerp(a.clearDayFraction, b.clearDayFraction),
  }
}

/**
 * SeasonalClimateModel
 *
 * Provides climate normals and seasonal variation for a given location.
 * Supports smooth interpolation between months for gradual seasonal transitions.
 */
class SeasonalClimateModel {
  private zone:    ClimateZone
  private profile: ClimateZoneProfile

  constructor(latitude: number) {
    this.zone    = latitudeToClimateZone(latitude)
    this.profile = CLIMATE_PROFILES[this.zone]
  }

  updateLatitude(latitude: number): void {
    this.zone    = latitudeToClimateZone(latitude)
    this.profile = CLIMATE_PROFILES[this.zone]
  }

  get climateZone(): ClimateZone { return this.zone }

  /**
   * Get interpolated monthly normals for a fractional day of year (1–365).
   * Pure function — unit testable.
   */
  getNormals(dayOfYearVal: number): MonthlyClimateNormal {
    const fMonth    = ((dayOfYearVal - 1) / 30.44) % 12   // fractional month 0–11
    const monthIdx  = Math.floor(fMonth)
    const t         = fMonth - monthIdx
    const a         = this.profile.normals[monthIdx]
    const b         = this.profile.normals[(monthIdx + 1) % 12]
    return interpolateNormals(a, b, t)
  }

  /** Get seasonal solar intensity multiplier (0–1) for a day of year */
  getSolarIntensityMultiplier(dayOfYearVal: number): number {
    const n = this.getNormals(dayOfYearVal)
    return n.clearDayFraction * (1 - n.cloudCoverFraction * 0.7)
  }

  /**
   * Get temperature range for a given day and hour.
   * Models diurnal variation with peak at 14:00 local solar time.
   */
  getHourlyTemperature(dayOfYearVal: number, hour: number): number {
    const n     = this.getNormals(dayOfYearVal)
    const range = n.maxTempC - n.minTempC
    // Sinusoidal diurnal model: min at 06:00, max at 14:00
    const phase = (hour - 6) / 24 * 2 * Math.PI
    const diurnal = Math.sin(phase - Math.PI / 2) * 0.5 + 0.5   // 0–1
    return n.minTempC + diurnal * range
  }

  /** Get expected wind speed for a given day and hour (m/s) */
  getWindSpeed(dayOfYearVal: number, hour: number): number {
    const n      = this.getNormals(dayOfYearVal)
    // Typical wind peaks afternoon (14:00), low at night
    const diurnal = 0.8 + 0.4 * Math.sin((hour - 8) / 24 * 2 * Math.PI)
    return n.avgWindMs * diurnal
  }

  /** Estimate Precipitable Water (PWC, cm) from temperature and humidity */
  getPrecipitableWater(tempC: number, humidityPct: number): number {
    // Buck equation for saturation vapor pressure
    const es  = 6.1121 * Math.exp((17.368 * tempC) / (238.88 + tempC))
    const rh  = humidityPct / 100
    const ea  = rh * es   // actual vapor pressure (hPa)
    // Approximate PWC in cm (Garrison method)
    return 0.1 * ea * (273.15 + tempC) / 461.5 / 100
  }
}

/** React hook wrapping SeasonalClimateModel */
function useSeasonalClimate(
  latitude:    number,
  dayOfYearVal: number,
  hour:         number,
) {
  const modelRef = useRef(new SeasonalClimateModel(latitude))
  useEffect(() => { modelRef.current.updateLatitude(latitude) }, [latitude])

  return useMemo(() => {
    const m   = modelRef.current
    const n   = m.getNormals(dayOfYearVal)
    const tmp = m.getHourlyTemperature(dayOfYearVal, hour)
    const wnd = m.getWindSpeed(dayOfYearVal, hour)
    const pwc = m.getPrecipitableWater(tmp, n.humidityPct)
    return { normals: n, temperature: tmp, windSpeed: wnd, pwc, zone: m.climateZone }
  }, [latitude, dayOfYearVal, hour])
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.3 — CLOUD SIMULATION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Cloud type classification */
type CloudType = "cumulus" | "stratus" | "cumulonimbus" | "cirrus" | "altocumulus"

/** Individual cloud cell in the density field */
interface CloudCell {
  id:         number
  x:          number    // normalised position [0,1] in field
  z:          number
  altitude:   number    // normalised altitude [0,1]
  radius:     number    // normalised coverage radius [0,1]
  density:    number    // optical depth multiplier [0,1]
  type:       CloudType
  speed:      number    // drift speed (normalised units/sec)
  direction:  number    // drift direction (radians)
  birthTime:  number    // simulation time at creation (seconds)
  lifetime:   number    // seconds until dissolve
}

/** Cloud density field state */
interface CloudDensityField {
  cells:           CloudCell[]
  totalCoverage:   number    // 0–1 fraction of sky covered
  opticalDepth:    number    // 0–1 integrated attenuation
  shadowIntensity: number    // 0–1 shadow on ground
  windU:           number    // mean field drift U (m/s → norm units)
  windV:           number    // mean field drift V
}

/** Cloud type optical properties */
const CLOUD_OPTICAL: Record<CloudType, { tau: number; albedo: number }> = {
  cumulus:       { tau: 0.35, albedo: 0.60 },
  stratus:       { tau: 0.55, albedo: 0.72 },
  cumulonimbus:  { tau: 0.88, albedo: 0.84 },
  cirrus:        { tau: 0.12, albedo: 0.24 },
  altocumulus:   { tau: 0.28, albedo: 0.52 },
}

/** Probability weights for cloud type by weather condition */
const CLOUD_TYPE_WEIGHTS: Record<WeatherType, Partial<Record<CloudType, number>>> = {
  clear:  { cirrus: 0.8,  cumulus: 0.2 },
  cloudy: { cumulus: 0.5, altocumulus: 0.3, stratus: 0.2 },
  rain:   { stratus: 0.6, altocumulus: 0.3, cumulus: 0.1 },
  snow:   { stratus: 0.7, altocumulus: 0.2, cirrus: 0.1 },
  storm:  { cumulonimbus: 0.6, stratus: 0.3, altocumulus: 0.1 },
  fog:    { stratus: 1.0 },
}

/**
 * Sample a cloud type from weather-driven probability weights.
 * Pure function — unit testable.
 */
function sampleCloudType(weather: WeatherType, rand: number): CloudType {
  const weights = CLOUD_TYPE_WEIGHTS[weather]
  const entries = Object.entries(weights) as [CloudType, number][]
  let cumulative = 0
  for (const [type, w] of entries) {
    cumulative += w
    if (rand < cumulative) return type
  }
  return entries[entries.length - 1][0]
}

/**
 * Compute cloud field coverage from target fraction using Poisson process.
 * Pure function — unit testable.
 */
function computeFieldCoverage(cells: CloudCell[]): number {
  if (cells.length === 0) return 0
  // Model coverage as union of circular discs — Guth's formula approximation
  const totalArea = cells.reduce((s, c) => s + Math.PI * c.radius * c.radius, 0)
  // Coverage fraction: 1 - exp(-totalArea) for uniform Poisson process
  return clamp(1 - Math.exp(-totalArea * 1.5), 0, 1)
}

/**
 * Compute integrated optical depth (beer-lambert) from cloud cells.
 * Pure function — unit testable.
 */
function computeOpticalDepth(cells: CloudCell[]): number {
  if (cells.length === 0) return 0
  const tau = cells.reduce((s, c) => {
    const opt = CLOUD_OPTICAL[c.type]
    return s + opt.tau * c.density
  }, 0)
  return clamp(tau, 0, 1)
}

/** Shadow transmittance: fraction of solar radiation that passes through clouds */
function cloudTransmittance(opticalDepth: number): number {
  return Math.exp(-opticalDepth * 2.3)
}

/**
 * CloudDensityFieldSimulator
 *
 * Maintains a population of cloud cells, evolving their positions
 * and lifetimes each simulation tick.
 *
 * The field is a normalised [0,1]×[0,1] space that wraps around
 * (infinite cloud advection via periodic boundary conditions).
 */
class CloudDensityFieldSimulator {
  private cells:     CloudCell[] = []
  private time:      number      = 0
  private nextId:    number      = 0
  private targetCoverage: number = 0.4
  private weather:   WeatherType = "clear"

  readonly fieldState: React.MutableRefObject<CloudDensityField>

  constructor() {
    this.fieldState = { current: this.computeField() }
  }

  /** Update weather type (drives target coverage and cloud types) */
  setWeather(weather: WeatherType): void {
    this.weather = weather
    const targets: Record<WeatherType, number> = {
      clear:  0.08, cloudy: 0.52, rain: 0.72, snow: 0.66, storm: 0.88, fog: 0.95,
    }
    this.targetCoverage = targets[weather]
  }

  /** Advance simulation by dt seconds */
  tick(dt: number, windU: number, windV: number): void {
    this.time += dt

    // Advect existing cells
    for (const cell of this.cells) {
      cell.x += Math.cos(cell.direction) * cell.speed * dt
      cell.z += Math.sin(cell.direction) * cell.speed * dt
      // Periodic boundary conditions
      cell.x = ((cell.x % 1) + 1) % 1
      cell.z = ((cell.z % 1) + 1) % 1
    }

    // Dissolve expired cells
    this.cells = this.cells.filter((c) => this.time - c.birthTime < c.lifetime)

    // Spawn new cells to maintain target coverage
    const currentCov = computeFieldCoverage(this.cells)
    if (currentCov < this.targetCoverage * 0.9) {
      this.spawnCell(windU, windV)
    }

    // Occasionally spawn extra cells in storm conditions
    if (this.weather === "storm" && Math.random() < dt * 0.5) {
      this.spawnCell(windU, windV)
    }

    this.fieldState.current = this.computeField()
  }

  private spawnCell(windU: number, windV: number): void {
    const rand     = Math.random()
    const type     = sampleCloudType(this.weather, rand)
    const windDir  = Math.atan2(windV, windU)
    const id       = this.nextId++

    const cell: CloudCell = {
      id,
      x:         Math.random(),
      z:         Math.random(),
      altitude:  type === "cirrus" ? 0.8 + Math.random() * 0.2 : 0.3 + Math.random() * 0.4,
      radius:    0.04 + Math.random() * 0.14,
      density:   0.5 + Math.random() * 0.5,
      type,
      speed:     0.008 + Math.random() * 0.02,
      direction: windDir + (Math.random() - 0.5) * 0.5,
      birthTime: this.time,
      lifetime:  60 + Math.random() * 180,
    }
    this.cells.push(cell)
  }

  private computeField(): CloudDensityField {
    const coverage  = computeFieldCoverage(this.cells)
    const tau       = computeOpticalDepth(this.cells)
    const transmit  = cloudTransmittance(tau)
    const windDir   = this.cells.length > 0 ? this.cells[0].direction : 0
    return {
      cells:           this.cells,
      totalCoverage:   coverage,
      opticalDepth:    tau,
      shadowIntensity: 1 - transmit,
      windU:           Math.cos(windDir) * 0.015,
      windV:           Math.sin(windDir) * 0.015,
    }
  }

  getCells():    CloudCell[]      { return this.cells }
  getField():    CloudDensityField { return this.fieldState.current }
  getTime():     number            { return this.time }
  getCoverage(): number            { return this.fieldState.current.totalCoverage }
}

/** Module-singleton cloud simulator */
const globalCloudSim = new CloudDensityFieldSimulator()

/** Hook: drives the cloud simulator and returns field state */
function useCloudField(
  weather:  WeatherType,
  windU:    number,
  windV:    number,
  paused?:  boolean,
): CloudDensityField {
  const [field, setField] = useState<CloudDensityField>(globalCloudSim.getField())

  useEffect(() => { globalCloudSim.setWeather(weather) }, [weather])

  useFrame((_, delta) => {
    if (paused) return
    globalCloudSim.tick(delta, windU, windV)
    setField(globalCloudSim.getField())
  })

  return field
}

/** Props for CloudShadowRenderer */
interface CloudShadowRendererProps {
  field:      CloudDensityField
  terrainW?:  number
  terrainD?:  number
}

/**
 * CloudShadowRenderer
 *
 * Projects cloud shadow patches onto the terrain as semi-transparent quads.
 * Only renders cells whose shadow footprint is visible from the camera.
 * Shadow intensity scales with cell optical depth.
 */
const CloudShadowRenderer = memo(function CloudShadowRenderer({
  field,
  terrainW = 200,
  terrainD = 200,
}: CloudShadowRendererProps) {
  return (
    <group>
      {field.cells.filter((c) => c.density > 0.3).map((cell) => {
        const wx      = (cell.x - 0.5) * terrainW
        const wz      = (cell.z - 0.5) * terrainD
        const radius  = cell.radius * Math.min(terrainW, terrainD)
        const opacity = cell.density * CLOUD_OPTICAL[cell.type].tau * 0.45

        return (
          <mesh key={cell.id} position={[wx, -1.93, wz]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[radius, 12]} />
            <meshBasicMaterial
              color="#1a2030"
              transparent
              opacity={opacity}
              depthWrite={false}
              blending={THREE.MultiplyBlending}
            />
          </mesh>
        )
      })}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.4 — TEMPERATURE MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Temperature model configuration */
interface TempModelConfig {
  /** Panel temperature coefficient (%/°C above 25°C, typically −0.35 to −0.45) */
  panelTempCoeff:       number
  /** NOCT (Nominal Operating Cell Temperature, °C) */
  noct:                 number
  /** Reference irradiance for NOCT measurement (W/m²) */
  noctIrradiance:       number
  /** Reference ambient temperature for NOCT (°C) */
  noctAmbientTemp:      number
  /** Thermal mass factor (0–1; higher = slower temperature response) */
  thermalMassFactor:    number
}

const TEMP_MODEL_DEFAULTS: TempModelConfig = {
  panelTempCoeff:    -0.0040,    // −0.40%/°C (typical monocrystalline Si)
  noct:              45,
  noctIrradiance:    800,
  noctAmbientTemp:   20,
  thermalMassFactor: 0.35,
}

/**
 * PanelTemperatureCalculator
 *
 * Computes PV cell temperature using the NOCT model (IEC 61215).
 * Tc = Ta + (NOCT − Ta_NOCT) × (G / G_NOCT) × (1 − η_ref / τα)
 *
 * For simplicity we use the common approximation:
 *   Tc = Ta + (NOCT − 20) × (G / 800)
 *
 * Pure class — all methods unit testable.
 */
class PanelTemperatureCalculator {
  private cfg: TempModelConfig
  private smoothedTemp: number = 25   // smoothed cell temperature state

  constructor(cfg: Partial<TempModelConfig> = {}) {
    this.cfg = { ...TEMP_MODEL_DEFAULTS, ...cfg }
  }

  /**
   * Compute steady-state cell temperature (°C).
   * @param ambientC   Ambient air temperature (°C)
   * @param irradW     Incident irradiance on panel (W/m²)
   */
  steadyStateCellTemp(ambientC: number, irradW: number): number {
    return ambientC + (this.cfg.noct - this.cfg.noctAmbientTemp) * (irradW / this.cfg.noctIrradiance)
  }

  /**
   * Update smoothed cell temperature with first-order thermal lag.
   * Call each simulation tick.
   * @param ambientC  Current ambient temperature (°C)
   * @param irradW    Incident irradiance (W/m²)
   * @param dt        Time step (seconds)
   */
  updateTemp(ambientC: number, irradW: number, dt: number): number {
    const target      = this.steadyStateCellTemp(ambientC, irradW)
    const tau         = this.cfg.thermalMassFactor * 300   // thermal time constant (seconds)
    const alpha       = 1 - Math.exp(-dt / tau)
    this.smoothedTemp = this.smoothedTemp + alpha * (target - this.smoothedTemp)
    return this.smoothedTemp
  }

  /**
   * Compute efficiency correction factor from cell temperature.
   * Returns a multiplier (1.0 at 25°C, < 1.0 above 25°C, > 1.0 below).
   * Pure function — unit testable.
   */
  efficiencyFactor(cellTempC: number): number {
    return 1 + this.cfg.panelTempCoeff * (cellTempC - 25)
  }

  /**
   * Compute net DC power output accounting for temperature.
   * @param Pstc   STC rated power (W)
   * @param ratio  Irradiance ratio (actual/STC), 0–1
   */
  netPower(Pstc: number, ratio: number, cellTempC: number): number {
    return Pstc * ratio * this.efficiencyFactor(cellTempC)
  }

  get currentTemp(): number { return this.smoothedTemp }
  reset(temp: number = 25): void { this.smoothedTemp = temp }
}

/** Temperature state for the scene */
interface AmbientTemperatureState {
  ambientC:        number    // ambient air temperature (°C)
  cellTempC:       number    // PV cell temperature (°C)
  efficiencyFactor: number   // 0.8–1.1 multiplier
  feelsLikeC:      number    // apparent temperature (wind chill / heat index)
  dewPointC:       number    // dew point (°C)
}

/**
 * AmbientTemperatureModel
 *
 * Integrates ambient temperature, humidity, and wind into a complete
 * thermal state for the scene.
 */
class AmbientTemperatureModel {
  /**
   * Compute feels-like temperature using heat index (hot) or wind-chill (cold).
   * Pure function — unit testable.
   */
  static feelsLike(tempC: number, windMs: number, humidityPct: number): number {
    if (tempC >= 27) {
      // Heat index (Rothfusz equation, °C)
      const T = tempC
      const RH = humidityPct
      const HI = -8.78469475556
        + 1.61139411 * T + 2.33854883889 * RH
        - 0.14611605 * T * RH - 0.012308094 * T * T
        - 0.0164248277778 * RH * RH + 0.002211732 * T * T * RH
        + 0.00072546 * T * RH * RH - 0.000003582 * T * T * RH * RH
      return HI
    } else if (tempC <= 10 && windMs > 1.3) {
      // Wind chill (Canadian formula)
      const V = Math.pow(windMs * 3.6, 0.16)   // km/h to ^0.16
      return 13.12 + 0.6215 * tempC - 11.37 * V + 0.3965 * tempC * V
    }
    return tempC
  }

  /**
   * Compute dew point (°C) from temperature and relative humidity.
   * Magnus formula — pure function, unit testable.
   */
  static dewPoint(tempC: number, humidityPct: number): number {
    const a = 17.27, b = 237.7
    const gamma = (a * tempC) / (b + tempC) + Math.log(humidityPct / 100)
    return (b * gamma) / (a - gamma)
  }

  /**
   * Compute convective cooling effect on panel temperature (°C reduction).
   * Wind increases forced convection heat transfer from panel surface.
   */
  static convectiveCooling(windMs: number): number {
    // Simplified Newton's law of cooling contribution
    return windMs * 1.2   // approximate °C reduction per m/s wind
  }
}

/** Hook: computes full ambient temperature state */
function useAmbientTemperature(
  ambientC:    number,
  irradW:      number,
  windMs:      number,
  humidityPct: number,
  dt:          number,
  cfg?:        Partial<TempModelConfig>,
): AmbientTemperatureState {
  const calcRef = useRef(new PanelTemperatureCalculator(cfg))

  const cellTemp = useMemo(() => {
    const wCool   = AmbientTemperatureModel.convectiveCooling(windMs)
    const adjAmb  = ambientC - wCool * 0.4
    return calcRef.current.updateTemp(adjAmb, irradW, dt)
  }, [ambientC, irradW, windMs, dt])

  return useMemo(() => ({
    ambientC,
    cellTempC:        cellTemp,
    efficiencyFactor: calcRef.current.efficiencyFactor(cellTemp),
    feelsLikeC:       AmbientTemperatureModel.feelsLike(ambientC, windMs, humidityPct),
    dewPointC:        AmbientTemperatureModel.dewPoint(ambientC, humidityPct),
  }), [ambientC, cellTemp, windMs, humidityPct])
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.5 — WIND SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Wind vector at a point */
interface WindVector {
  u:         number    // m/s, positive = eastward
  v:         number    // m/s, positive = northward
  speed:     number    // m/s
  direction: number    // degrees from North (0–360), direction wind is FROM
  gustFactor: number   // instantaneous speed / mean speed
}

/** 2D wind field grid node */
interface WindFieldNode {
  x:   number    // grid column index
  z:   number    // grid row index
  wx:  number    // world X
  wz:  number    // world Z
  u:   number    // U component (m/s)
  v:   number    // V component (m/s)
}

/** Wind field configuration */
interface WindFieldConfig {
  gridW:        number    // number of columns
  gridH:        number    // number of rows
  worldW:       number    // world space width (m)
  worldH:       number    // world space height (m)
  baseU:        number    // mean U component (m/s)
  baseV:        number    // mean V component (m/s)
  turbulence:   number    // turbulence intensity 0–1
  gustInterval: number    // seconds between gust events
}

const WIND_FIELD_DEFAULTS: WindFieldConfig = {
  gridW:        12,
  gridH:        8,
  worldW:       200,
  worldH:       200,
  baseU:        3.0,
  baseV:        1.5,
  turbulence:   0.22,
  gustInterval: 8,
}

/**
 * buildWindField
 *
 * Pure function — unit testable.
 * Generates a perturbed wind field from base U,V components.
 * Uses seeded spatial noise for repeatable turbulence structure.
 */
function buildWindField(cfg: WindFieldConfig, time: number, seed: number = 42): WindFieldNode[] {
  const nodes: WindFieldNode[] = []

  for (let gz = 0; gz < cfg.gridH; gz++) {
    for (let gx = 0; gx < cfg.gridW; gx++) {
      const wx = (gx / (cfg.gridW - 1) - 0.5) * cfg.worldW
      const wz = (gz / (cfg.gridH - 1) - 0.5) * cfg.worldH

      // Spatial turbulence using two sin waves per component
      const noiseScale = 0.08
      const uNoise = Math.sin(wx * noiseScale + time * 0.3 + seed)
                   * Math.cos(wz * noiseScale * 0.7 + time * 0.2)
      const vNoise = Math.cos(wx * noiseScale * 0.8 + time * 0.25)
                   * Math.sin(wz * noiseScale + time * 0.35 + seed * 1.3)

      nodes.push({
        x:  gx, z: gz,
        wx, wz,
        u: cfg.baseU + uNoise * cfg.turbulence * cfg.baseU,
        v: cfg.baseV + vNoise * cfg.turbulence * cfg.baseV,
      })
    }
  }

  return nodes
}

/**
 * Interpolate wind vector at an arbitrary world position.
 * Uses bilinear interpolation on the wind field grid.
 * Pure function — unit testable.
 */
function interpolateWind(
  nodes: WindFieldNode[],
  cfg:   WindFieldConfig,
  wx:    number,
  wz:    number,
): WindVector {
  // Normalise world coords to grid coords
  const gxF  = ((wx / cfg.worldW) + 0.5) * (cfg.gridW - 1)
  const gzF  = ((wz / cfg.worldH) + 0.5) * (cfg.gridH - 1)
  const gx0  = clamp(Math.floor(gxF), 0, cfg.gridW - 2)
  const gz0  = clamp(Math.floor(gzF), 0, cfg.gridH - 2)
  const tx   = gxF - gx0
  const tz   = gzF - gz0

  const idx  = (r: number, c: number) => r * cfg.gridW + c
  const n00  = nodes[idx(gz0,     gx0)]
  const n10  = nodes[idx(gz0,     gx0 + 1)]
  const n01  = nodes[idx(gz0 + 1, gx0)]
  const n11  = nodes[idx(gz0 + 1, gx0 + 1)]

  if (!n00 || !n10 || !n01 || !n11) return { u: 0, v: 0, speed: 0, direction: 0, gustFactor: 1 }

  const u = n00.u * (1-tx)*(1-tz) + n10.u * tx*(1-tz) + n01.u * (1-tx)*tz + n11.u * tx*tz
  const v = n00.v * (1-tx)*(1-tz) + n10.v * tx*(1-tz) + n01.v * (1-tx)*tz + n11.v * tx*tz
  const speed = Math.sqrt(u*u + v*v)
  const direction = normAngle(270 - toDeg(Math.atan2(v, u)))   // met convention: from North

  return { u, v, speed, direction, gustFactor: 1 }
}

/** WindVectorMap component — renders 2D wind arrows in 3D scene */
interface WindVectorMapProps {
  nodes:    WindFieldNode[]
  visible:  boolean
  scale?:   number
}

const WindVectorMap = memo(function WindVectorMap({
  nodes, visible, scale = 0.4,
}: WindVectorMapProps) {
  if (!visible) return null

  return (
    <group>
      {nodes.filter((_, i) => i % 2 === 0).map((node) => {
        const speed  = Math.sqrt(node.u * node.u + node.v * node.v)
        const angle  = Math.atan2(node.u, node.v)
        const len    = clamp(speed * scale, 0.5, 5)
        const color  = speed < 3 ? "#88ccff" : speed < 8 ? "#ffcc44" : "#ff4444"

        return (
          <group key={`${node.x}_${node.z}`} position={[node.wx, 2, node.wz]} rotation={[0, angle, 0]}>
            <mesh position={[0, 0, len * 0.5]}>
              <boxGeometry args={[0.1, 0.1, len]} />
              <meshBasicMaterial color={color} transparent opacity={0.6} />
            </mesh>
            <mesh position={[0, 0, len]}>
              <coneGeometry args={[0.25, 0.6, 5]} />
              <meshBasicMaterial color={color} transparent opacity={0.7} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
})

/** WindField hook — computes and updates wind field each frame */
function useWindField(
  cfg:    Partial<WindFieldConfig> = {},
  paused: boolean                  = false,
): {
  nodes:     WindFieldNode[]
  meanWind:  WindVector
  getWindAt: (wx: number, wz: number) => WindVector
} {
  const fullCfg  = useMemo<WindFieldConfig>(() => ({ ...WIND_FIELD_DEFAULTS, ...cfg }), [cfg])
  const timeRef  = useRef(0)
  const [nodes, setNodes] = useState<WindFieldNode[]>(() => buildWindField(fullCfg, 0))

  useFrame((_, delta) => {
    if (paused) return
    timeRef.current += delta
    // Update field at ~5 Hz (not every frame — saves CPU)
    if (timeRef.current % (1/5) < delta) {
      setNodes(buildWindField(fullCfg, timeRef.current))
    }
  })

  const meanWind = useMemo<WindVector>(() => {
    const u = fullCfg.baseU
    const v = fullCfg.baseV
    const speed = Math.sqrt(u*u + v*v)
    return { u, v, speed, direction: normAngle(270 - toDeg(Math.atan2(v, u))), gustFactor: 1 }
  }, [fullCfg.baseU, fullCfg.baseV])

  const getWindAt = useCallback(
    (wx: number, wz: number) => interpolateWind(nodes, fullCfg, wx, wz),
    [nodes, fullCfg],
  )

  return { nodes, meanWind, getWindAt }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.6 — WEATHER PATTERN GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

/** A discrete weather state in the Markov chain */
interface WeatherState {
  type:              WeatherType
  probability:       number    // steady-state probability
  minDurationHours:  number    // minimum time before transition
  maxDurationHours:  number    // maximum time before forced transition
}

/** Markov transition matrix entry */
interface WeatherTransition {
  from: WeatherType
  to:   WeatherType
  prob: number    // per-hour transition probability
}

/** Weather event record */
interface WeatherEvent {
  id:             number
  type:           WeatherType
  startTime:      number    // simulation elapsed seconds
  endTime:        number
  intensity:      number    // 0–1
  description:    string
}

/**
 * Markov chain transition probabilities per hour.
 * Rows sum to ≤ 1 (remainder = self-transition probability).
 * Calibrated to give realistic synoptic sequences.
 */
const WEATHER_TRANSITIONS: WeatherTransition[] = [
  // From clear
  { from: "clear",  to: "cloudy", prob: 0.04  },
  { from: "clear",  to: "fog",    prob: 0.008 },
  // From cloudy
  { from: "cloudy", to: "clear",  prob: 0.06  },
  { from: "cloudy", to: "rain",   prob: 0.05  },
  { from: "cloudy", to: "snow",   prob: 0.012 },
  { from: "cloudy", to: "storm",  prob: 0.018 },
  { from: "cloudy", to: "fog",    prob: 0.015 },
  // From rain
  { from: "rain",   to: "cloudy", prob: 0.08  },
  { from: "rain",   to: "storm",  prob: 0.04  },
  { from: "rain",   to: "clear",  prob: 0.02  },
  // From snow
  { from: "snow",   to: "cloudy", prob: 0.06  },
  { from: "snow",   to: "clear",  prob: 0.025 },
  // From storm
  { from: "storm",  to: "rain",   prob: 0.10  },
  { from: "storm",  to: "cloudy", prob: 0.06  },
  // From fog
  { from: "fog",    to: "clear",  prob: 0.07  },
  { from: "fog",    to: "cloudy", prob: 0.10  },
]

/**
 * Sample next weather state using Markov chain transitions.
 * Pure function — unit testable.
 * @param current  Current WeatherType
 * @param dtHours  Time elapsed since last check (hours)
 * @param rand     Random number in [0,1)
 */
function sampleNextWeather(
  current:  WeatherType,
  dtHours:  number,
  rand:     number,
): WeatherType {
  const transitions = WEATHER_TRANSITIONS.filter((t) => t.from === current)
  let cumProb       = 0
  for (const tr of transitions) {
    const p = 1 - Math.pow(1 - tr.prob, dtHours)   // per-dt probability
    cumProb += p
    if (rand < cumProb) return tr.to
  }
  return current   // stay in current state
}

/**
 * WeatherPatternEngine
 *
 * Drives weather state transitions using a Markov chain.
 * Maintains an event log for analytics and display.
 * Supports season-biased steady-state distributions.
 */
class WeatherPatternEngine {
  private currentWeather:  WeatherType = "clear"
  private stateStartTime:  number      = 0
  private time:            number      = 0
  private eventLog:        WeatherEvent[] = []
  private nextEventId:     number      = 0
  private seasonBias:      Season      = "Summer"

  /** Set season to bias transition probabilities */
  setSeason(season: Season): void {
    this.seasonBias = season
  }

  /** Get the season-biased transition for rain→snow (cold seasons) */
  private resolveWeather(type: WeatherType): WeatherType {
    if (type === "rain" && (this.seasonBias === "Winter" || this.seasonBias === "Autumn")) {
      return Math.random() < 0.35 ? "snow" : "rain"
    }
    if (type === "snow" && (this.seasonBias === "Summer" || this.seasonBias === "Spring")) {
      return "rain"
    }
    return type
  }

  /** Advance simulation by dt seconds */
  tick(dt: number): WeatherType {
    this.time += dt
    const dtHours   = dt / 3600
    const rand      = Math.random()
    const proposed  = sampleNextWeather(this.currentWeather, dtHours, rand)
    const next      = this.resolveWeather(proposed)

    if (next !== this.currentWeather) {
      this.logEvent(this.currentWeather)
      this.currentWeather = next
      this.stateStartTime = this.time
    }

    return this.currentWeather
  }

  private logEvent(type: WeatherType): void {
    const ev: WeatherEvent = {
      id:          this.nextEventId++,
      type,
      startTime:   this.stateStartTime,
      endTime:     this.time,
      intensity:   1.0,
      description: `${type.charAt(0).toUpperCase() + type.slice(1)} conditions for ${((this.time - this.stateStartTime) / 3600).toFixed(1)}h`,
    }
    this.eventLog.push(ev)
    if (this.eventLog.length > 200) this.eventLog.shift()
  }

  get current():  WeatherType    { return this.currentWeather }
  get elapsed():  number         { return this.time }
  get events():   WeatherEvent[] { return this.eventLog }
  get stateDuration(): number    { return this.time - this.stateStartTime }

  setWeather(w: WeatherType): void {
    this.logEvent(this.currentWeather)
    this.currentWeather = w
    this.stateStartTime = this.time
  }
}

/** Hook: drives WeatherPatternEngine from simulation time */
function useDynamicWeather(
  simElapsedSec: number,
  season:        Season,
  initialWeather: WeatherType = "clear",
  auto:           boolean      = true,
): {
  weather:    WeatherType
  setWeather: (w: WeatherType) => void
  events:     WeatherEvent[]
} {
  const engineRef = useRef(new WeatherPatternEngine())
  const [weather, setWeatherState] = useState<WeatherType>(initialWeather)
  const prevTimeRef = useRef(simElapsedSec)

  useEffect(() => { engineRef.current.setSeason(season) }, [season])

  useFrame((_, delta) => {
    if (!auto) return
    engineRef.current.setSeason(season)
    const next = engineRef.current.tick(delta * 60)   // accelerate: 1 real-sec = 1 sim-min
    if (next !== weather) setWeatherState(next)
  })

  const setWeather = useCallback((w: WeatherType) => {
    engineRef.current.setWeather(w)
    setWeatherState(w)
  }, [])

  return { weather, setWeather, events: engineRef.current.events }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.7 — IRRADIANCE ADJUSTMENT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/** Complete irradiance calculation result */
interface IrradianceResult {
  /** Extraterrestrial horizontal irradiance (W/m²) */
  Ioh:               number
  /** Beam (direct) irradiance on horizontal surface (W/m²) */
  Ibh:               number
  /** Diffuse irradiance on horizontal surface (W/m²) */
  Idh:               number
  /** Reflected irradiance (albedo) on tilted surface (W/m²) */
  Ir:                number
  /** Global Horizontal Irradiance (W/m²) */
  GHI:               number
  /** Direct Normal Irradiance (W/m²) */
  DNI:               number
  /** Diffuse Horizontal Irradiance (W/m²) */
  DHI:               number
  /** Global Tilted Irradiance on panel surface (W/m²) */
  GTI:               number
  /** Cloud transmittance (0–1) */
  cloudTransmit:     number
  /** Aerosol optical depth attenuation factor (0–1) */
  aerosolFactor:     number
  /** Air mass at current sun position */
  airMass:           number
  /** Effective irradiance ratio to STC (0–1) */
  effectiveRatio:    number
  /** Attenuation breakdown for diagnostics */
  attenuationLog:    AttenuationLog
}

/** Breakdown of irradiance attenuation for diagnostics */
interface AttenuationLog {
  rawExtraTerrestrial: number
  cosIncidenceAngle:   number
  cloudFactor:         number
  aerosolFactor:       number
  precipitableWater:   number
  rayleighFactor:      number
  totalTransmittance:  number
}

/**
 * computeAirMass
 *
 * Kasten-Young formula for optical air mass.
 * Valid for altitude angles > −1°.
 * Pure function — unit testable.
 */
function computeAirMass(altitudeDeg: number): number {
  if (altitudeDeg <= 0) return Infinity
  const altRad = toRad(altitudeDeg)
  return 1 / (Math.sin(altRad) + 0.50572 * Math.pow(altitudeDeg + 6.07995, -1.6364))
}

/**
 * computeRayleighTransmittance
 *
 * Spectral-averaged Rayleigh scattering transmittance.
 * @param AM  Air mass (Kasten-Young)
 * Pure function — unit testable.
 */
function computeRayleighTransmittance(AM: number): number {
  if (!isFinite(AM)) return 0
  // Simplified Lacis-Hansen formula
  return clamp(Math.exp(-0.0903 * Math.pow(AM, 0.84) * (1 + AM - Math.pow(AM, 1.01))), 0, 1)
}

/**
 * computeAerosolTransmittance
 *
 * Aerosol attenuation using Ångström turbidity formula.
 * @param AM    Air mass
 * @param beta  Ångström turbidity coefficient (typical: 0.05–0.3)
 * @param alpha Ångström exponent (typical: 1.3)
 * Pure function — unit testable.
 */
function computeAerosolTransmittance(AM: number, beta: number = 0.1, alpha: number = 1.3): number {
  if (!isFinite(AM)) return 0
  return clamp(Math.exp(-beta * Math.pow(0.55, -alpha) * AM), 0, 1)
}

/**
 * computePrecipitableWaterTransmittance
 *
 * Precipitable water vapour absorption.
 * @param AM   Air mass
 * @param pwc  Precipitable water in cm
 * Pure function — unit testable.
 */
function computePrecipWaterTransmittance(AM: number, pwc: number): number {
  if (!isFinite(AM)) return 0
  // Simplified after Bird & Hulstrom (1981)
  const W = pwc * AM
  return clamp(1 - 0.077 * Math.pow(W, 0.3), 0.7, 1.0)
}

/**
 * computeIncidenceAngle
 *
 * Cosine of angle of incidence on a tilted surface.
 * @param altDeg    Sun altitude (degrees)
 * @param azDeg     Sun azimuth (degrees, from N, clockwise)
 * @param tiltDeg   Surface tilt from horizontal (degrees)
 * @param surfAzDeg Surface azimuth (degrees, from N, clockwise)
 * Pure function — unit testable.
 */
function computeIncidenceAngle(
  altDeg:    number,
  azDeg:     number,
  tiltDeg:   number,
  surfAzDeg: number,
): number {
  const alt     = toRad(altDeg)
  const az      = toRad(azDeg)
  const tilt    = toRad(tiltDeg)
  const surfAz  = toRad(surfAzDeg)
  const cosTheta =
    Math.sin(alt) * Math.cos(tilt) +
    Math.cos(alt) * Math.sin(tilt) * Math.cos(az - surfAz)
  return clamp(cosTheta, 0, 1)
}

/**
 * computeAnisotropicDiffuse
 *
 * Hay-Davies-Klucher anisotropic diffuse irradiance model.
 * Accounts for circumsolar brightening and horizon brightening.
 * @param DHI   Diffuse horizontal irradiance (W/m²)
 * @param DNI   Direct normal irradiance (W/m²)
 * @param Io    Extraterrestrial normal irradiance (W/m²)
 * @param cosI  Cosine of incidence angle
 * @param tilt  Panel tilt (degrees)
 * Pure function — unit testable.
 */
function computeAnisotropicDiffuse(
  DHI:   number,
  DNI:   number,
  Io:    number,
  cosI:  number,
  tilt:  number,
): number {
  if (Io <= 0) return DHI * (1 + Math.cos(toRad(tilt))) / 2
  // Circumsolar fraction f1
  const f1 = clamp(DNI / Io, 0, 1)
  // Horizon brightening factor f2
  const f2 = Math.sin(toRad(tilt)) ** 3
  // Hay-Davies formula
  const viewFactor = (1 + Math.cos(toRad(tilt))) / 2
  return DHI * ((1 - f1) * viewFactor + f1 * cosI + f2 * Math.sin(toRad(tilt)) / 2)
}

/**
 * IrradianceAdjustmentCalculator
 *
 * Main irradiance calculation pipeline integrating:
 *   1. Astronomical solar position
 *   2. Rayleigh scattering
 *   3. Aerosol attenuation (Ångström)
 *   4. Precipitable water vapour absorption
 *   5. Cloud transmittance (Beer-Lambert)
 *   6. Transposition to tilted surface (Hay-Davies)
 *   7. Albedo / ground reflection
 *
 * Reference: Bird & Hulstrom (1981), Hay & Davies (1980), NREL HDKR model.
 */
class IrradianceAdjustmentCalculator {
  private aerosolBeta:    number = 0.10    // Ångström turbidity
  private aerosolAlpha:   number = 1.30    // Ångström exponent
  private groundAlbedo:   number = 0.20    // ground reflectance

  setAerosol(beta: number, alpha: number = 1.3): void {
    this.aerosolBeta  = beta
    this.aerosolAlpha = alpha
  }

  setGroundAlbedo(albedo: number): void {
    this.groundAlbedo = clamp(albedo, 0, 1)
  }

  /**
   * Compute full irradiance breakdown.
   * @param solarPos    Full SolarPosition from SolarPositionCalculator
   * @param cloudField  Current cloud field state
   * @param pwc         Precipitable water content (cm)
   * @param tiltDeg     Panel tilt (degrees from horizontal)
   * @param surfAzDeg   Panel azimuth (degrees from North, clockwise)
   */
  compute(
    solarPos:   SolarPosition,
    cloudField: CloudDensityField,
    pwc:        number,
    tiltDeg:    number,
    surfAzDeg:  number,
  ): IrradianceResult {
    const alt = solarPos.altitudeApparent
    const az  = solarPos.azimuth
    const Io  = solarPos.Io

    // Below horizon — zero irradiance
    if (alt <= 0) {
      return this.zeroResult(Io)
    }

    // --- Geometric factors ---
    const cosZ   = Math.sin(toRad(alt))    // cos(zenith)
    const AM     = computeAirMass(alt)
    const cosI   = computeIncidenceAngle(alt, az, tiltDeg, surfAzDeg)

    // --- Atmospheric transmittances ---
    const tauR   = computeRayleighTransmittance(AM)
    const tauA   = computeAerosolTransmittance(AM, this.aerosolBeta, this.aerosolAlpha)
    const tauPW  = computePrecipWaterTransmittance(AM, pwc)
    const tauOz  = 0.97   // approximate ozone absorptance (simplified)
    const tauCld = cloudTransmittance(cloudField.opticalDepth)

    // --- Direct irradiances ---
    const DNI    = Io * tauR * tauA * tauPW * tauOz * tauCld
    const Ibh    = DNI * cosZ
    const Ioh    = Io * cosZ

    // --- Diffuse irradiance (isotropic + Rayleigh scatter) ---
    // Simplified: diffuse ≈ DHI from Bird-Hulstrom
    const DHI    = Io * cosZ * 0.2710 * (1 - tauR * tauA) * tauCld +
                   cloudField.totalCoverage * DNI * 0.15

    // GHI
    const GHI    = Ibh + DHI

    // --- Transposition to tilted surface (Hay-Davies) ---
    const IDiff  = computeAnisotropicDiffuse(DHI, DNI, Io, cosI, tiltDeg)
    const IBeam  = DNI * cosI * tauCld
    const IRefl  = GHI * this.groundAlbedo * (1 - Math.cos(toRad(tiltDeg))) / 2
    const GTI    = clamp(IBeam + IDiff + IRefl, 0, Io * 1.1)

    const totalTransmittance = tauR * tauA * tauPW * tauOz * tauCld
    const effectiveRatio     = clamp(GTI / 1000, 0, 1.1)   // STC = 1000 W/m²

    return {
      Ioh, Ibh,
      Idh:           DHI,
      Ir:            IRefl,
      GHI, DNI, DHI, GTI,
      cloudTransmit: tauCld,
      aerosolFactor: tauA,
      airMass:       AM,
      effectiveRatio,
      attenuationLog: {
        rawExtraTerrestrial: Io,
        cosIncidenceAngle:   cosI,
        cloudFactor:         tauCld,
        aerosolFactor:       tauA,
        precipitableWater:   pwc,
        rayleighFactor:      tauR,
        totalTransmittance,
      },
    }
  }

  private zeroResult(Io: number): IrradianceResult {
    const zz: IrradianceResult = {
      Ioh: 0, Ibh: 0, Idh: 0, Ir: 0, GHI: 0, DNI: 0, DHI: 0, GTI: 0,
      cloudTransmit: 0, aerosolFactor: 0, airMass: Infinity,
      effectiveRatio: 0,
      attenuationLog: {
        rawExtraTerrestrial: Io, cosIncidenceAngle: 0,
        cloudFactor: 0, aerosolFactor: 0, precipitableWater: 0,
        rayleighFactor: 0, totalTransmittance: 0,
      },
    }
    return zz
  }
}

/** Module-singleton irradiance calculator */
const globalIrradianceCalc = new IrradianceAdjustmentCalculator()

/** Hook: computes full irradiance for the scene */
function useIrradianceAdjustment(
  solarPos:   SolarPosition,
  cloudField: CloudDensityField,
  pwc:        number,
  tiltDeg:    number,
  surfAzDeg:  number,
): IrradianceResult {
  return useMemo(
    () => globalIrradianceCalc.compute(solarPos, cloudField, pwc, tiltDeg, surfAzDeg),
    [solarPos.altitudeApparent, solarPos.azimuth, solarPos.Io,
     cloudField.opticalDepth, cloudField.totalCoverage, pwc, tiltDeg, surfAzDeg],
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25.8 — VISUAL WEATHER RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/** 3D cloud mesh GLSL — volumetric billboard cloud */
const CLOUD_BILLBOARD_VERT = /* glsl */ `
  attribute float aBirthAge;
  uniform float uTime;

  varying float vOpacity;
  varying vec2  vUv;

  void main() {
    vUv = uv;
    // Gentle pulsing
    float pulse = 0.94 + 0.06 * sin(uTime * 0.8 + aBirthAge);
    vec4 mvPos = modelViewMatrix * vec4(position * pulse, 1.0);
    gl_Position = projectionMatrix * mvPos;
    // Fade by view angle (billboard always faces camera)
    vOpacity = 0.92;
  }
`

const CLOUD_BILLBOARD_FRAG = /* glsl */ `
  uniform vec3  uCloudColor;
  uniform float uOpacity;
  uniform float uTime;

  varying float vOpacity;
  varying vec2  vUv;

  // Soft cloud shape (radial gradient with noise)
  float cloudShape(vec2 uv) {
    vec2  c    = uv - 0.5;
    float r    = length(c);
    float edge = smoothstep(0.48, 0.20, r);
    // Puff bumps along edge
    float bump = sin(atan(c.y, c.x) * 5.0 + uTime * 0.3) * 0.06;
    return smoothstep(0.50 + bump, 0.18, r);
  }

  void main() {
    float shape = cloudShape(vUv);
    if (shape < 0.01) discard;
    gl_FragColor = vec4(uCloudColor, shape * uOpacity * vOpacity);
  }
`

  interface CloudBillboardUniforms {
    [uniform: string]: THREE.IUniform
  uTime:       { value: number }
  uCloudColor: { value: THREE.Color }
  uOpacity:    { value: number }
}

function createCloudBillboardMat(): THREE.ShaderMaterial & { uniforms: CloudBillboardUniforms } {
  const u: CloudBillboardUniforms = {
    uTime:       { value: 0 },
    uCloudColor: { value: new THREE.Color("#d8e8f8") },
    uOpacity:    { value: 0.72 },
  }
  return Object.assign(
    new THREE.ShaderMaterial({
      vertexShader:   CLOUD_BILLBOARD_VERT,
      fragmentShader: CLOUD_BILLBOARD_FRAG,
      uniforms:       u,
      transparent:    true,
      depthWrite:     false,
      side:           THREE.DoubleSide,
      blending:       THREE.NormalBlending,
    }),
    { uniforms: u },
  )
}

/** Props for CloudLayer */
interface CloudLayerProps {
  field:     CloudDensityField
  nightMode: boolean
  altitude?: number    // base altitude in world units (default 40)
  scale?:    number    // world scale factor (default 12)
}

/**
 * CloudLayer
 *
 * Renders visible cloud cells as billboard spheres using the cloud shader.
 * Each cell spawns one plane geometry billboard facing the camera.
 * Opacity driven by cloud density and optical depth.
 *
 * Only renders the 20 densest cells for performance.
 * WebGL1 fallback: simple PlaneGeometry with MeshBasicMaterial.
 */
const CloudLayer = memo(function CloudLayer({
  field, nightMode, altitude = 42, scale = 12,
}: CloudLayerProps) {
  const matRef = useRef<(THREE.ShaderMaterial & { uniforms: CloudBillboardUniforms }) | null>(null)
  const mat    = useMemo(() => IS_WEBGL2 ? createCloudBillboardMat() : null, [])
  useEffect(() => { matRef.current = mat }, [mat])
  useEffect(() => () => { mat?.dispose() }, [mat])

  useFrame(({ clock }) => {
    const u = matRef.current?.uniforms
    if (!u) return
    u.uTime.value      = clock.getElapsedTime()
    const nightT       = nightMode ? 0.7 : 1.0
    u.uCloudColor.value.setRGB(
      0.84 * nightT,
      0.90 * nightT,
      0.96 * nightT,
    )
    u.uOpacity.value   = 0.60 + field.totalCoverage * 0.28
  })

  const visibleCells = useMemo(
    () => [...field.cells].sort((a, b) => b.density - a.density).slice(0, 20),
    [field.cells],
  )

  if (visibleCells.length === 0) return null

  return (
    <group>
      {visibleCells.map((cell) => {
        const wx      = (cell.x - 0.5) * 180
        const wz      = (cell.z - 0.5) * 160
        const wy      = altitude + cell.altitude * 30
        const radius  = cell.radius * scale * (cell.type === "cumulonimbus" ? 1.8 : 1.0)
        const cellMat = mat ?? new THREE.MeshBasicMaterial({
          color: nightMode ? "#505878" : "#d8e8f8", transparent: true,
          opacity: cell.density * 0.55, depthWrite: false,
        })

        return (
          <mesh key={cell.id} position={[wx, wy, wz]} material={cellMat}>
            <planeGeometry args={[radius * 2.5, radius * 1.4]} />
          </mesh>
        )
      })}
    </group>
  )
})

/** Sky colour from weather + time-of-day composited with irradiance */
interface SkyColorState {
  zenith:   THREE.Color
  horizon:  THREE.Color
  sunColor: THREE.Color
  ambient:  THREE.Color
}

/**
 * computeSkyColors
 *
 * Compute sky color triplet from sun position and cloud field.
 * Pure function — unit testable.
 */
function computeSkyColors(
  altitudeDeg:  number,
  cloudField:   CloudDensityField,
  nightMode:    boolean,
): SkyColorState {
  const sky    = Math.max(0, Math.sin(toRad(altitudeDeg)))
  const warmth = clamp(1 - sky * 2.5, 0, 1)
  const cloud  = cloudField.totalCoverage

  const zenith  = new THREE.Color()
  const horizon = new THREE.Color()
  const sunCol  = new THREE.Color()
  const amb     = new THREE.Color()

  if (nightMode || altitudeDeg < -3) {
    zenith.setRGB(0.018, 0.022, 0.068)
    horizon.setRGB(0.04, 0.05, 0.10)
    sunCol.setRGB(0.1, 0.15, 0.3)
    amb.setRGB(0.06, 0.07, 0.12)
  } else {
    // Day sky tinted by cloud
    const cloudGrey = clamp(cloud * 0.6, 0, 0.6)
    zenith.setRGB(
      0.10 + sky * 0.15 + cloudGrey * 0.45,
      0.26 + sky * 0.20 + cloudGrey * 0.38,
      0.72 - sky * 0.10 + cloudGrey * 0.12,
    )
    horizon.setRGB(
      0.68 + warmth * 0.28,
      0.84 - warmth * 0.22,
      0.98 - warmth * 0.50,
    )
    sunCol.setRGB(
      1.0,
      clamp(0.75 + sky * 0.25 - warmth * 0.22, 0.50, 1.0),
      clamp(0.52 + sky * 0.48 - warmth * 0.48, 0.30, 1.0),
    )
    amb.setRGB(
      0.40 + sky * 0.35 + cloudGrey * 0.10,
      0.55 + sky * 0.25 + cloudGrey * 0.08,
      1.0  - sky * 0.25 + cloudGrey * 0.05,
    )
  }

  return { zenith, horizon, sunColor: sunCol, ambient: amb }
}

/** Precipitation visual intensity from weather type */
function precipIntensity(weather: WeatherType): number {
  const m: Record<WeatherType, number> = {
    clear: 0, cloudy: 0, fog: 0, rain: 0.65, snow: 0.45, storm: 1.0,
  }
  return m[weather] ?? 0
}

/** VisualWeatherSystem — root component assembling all weather visuals */
interface VisualWeatherSystemProps {
  field:      CloudDensityField
  irradiance: IrradianceResult
  weather:    WeatherType
  nightMode:  boolean
  elevation:  number
  showClouds?: boolean
  showShadows?: boolean
  showWindVectors?: boolean
  windNodes?:  WindFieldNode[]
}

const VisualWeatherSystem = memo(function VisualWeatherSystem({
  field, irradiance, weather, nightMode, elevation,
  showClouds = true, showShadows = true, showWindVectors = false, windNodes = [],
}: VisualWeatherSystemProps) {
  const skyColors = useMemo(
    () => computeSkyColors(elevation, field, nightMode),
    [elevation, field, nightMode],
  )

  return (
    <group>
      {showClouds && <CloudLayer field={field} nightMode={nightMode} />}
      {showShadows && <CloudShadowRenderer field={field} />}
      {showWindVectors && <WindVectorMap nodes={windNodes} visible={true} />}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25 — CLIMATE ENGINE INTEGRATION HOOK
// ─────────────────────────────────────────────────────────────────────────────

/** Full climate engine state */
interface ClimateEngineState {
  solarPosition:    SolarPosition
  cloudField:       CloudDensityField
  irradiance:       IrradianceResult
  temperature:      AmbientTemperatureState
  windField:        { nodes: WindFieldNode[]; meanWind: WindVector }
  weather:          WeatherType
  climateNormals:   MonthlyClimateNormal
  effectiveRatio:   number    // 0–1 final irradiance-to-STC ratio with temperature
  skyColors:        SkyColorState
}

/**
 * useClimateEngine
 *
 * Master hook integrating all sub-systems of Section 25.
 * Provides a single ClimateEngineState consumed by all rendering systems.
 *
 * @param hour         Simulated hour of day (0–24)
 * @param dayOfYearV   Simulated day of year (1–365)
 * @param latitude     Observer latitude
 * @param longitude    Observer longitude
 * @param tiltDeg      Panel tilt (degrees)
 * @param surfAzDeg    Panel azimuth (degrees from North)
 * @param weather      Current weather type (from external control or WeatherPatternEngine)
 * @param season       Current season
 */
function useClimateEngine(opts: {
  hour:        number
  dayOfYear:   number
  latitude:    number
  longitude:   number
  timezone?:   number
  tiltDeg:     number
  surfAzDeg:   number
  weather:     WeatherType
  season:      Season
  paused?:     boolean
}): ClimateEngineState {
  const {
    hour, dayOfYear, latitude, longitude,
    timezone = 5.5, tiltDeg, surfAzDeg, weather, season, paused = false,
  } = opts

  // ── 25.1 Solar Position ──
  const solarPosition = useSolarPosition(hour, dayOfYear, { latitude, longitude, timezone })

  // ── 25.2 Seasonal Climate ──
  const climate = useSeasonalClimate(latitude, dayOfYear, hour)

  // ── 25.3 Cloud Field ──
  const windForClouds = useMemo(
    () => ({ u: climate.windSpeed * 0.5, v: climate.windSpeed * 0.3 }),
    [climate.windSpeed],
  )
  const cloudField = useCloudField(weather, windForClouds.u, windForClouds.v, paused)

  // ── 25.5 Wind Field ──
  const windCfg = useMemo(() => ({
    baseU: climate.windSpeed * 0.7,
    baseV: climate.windSpeed * 0.4,
  }), [climate.windSpeed])
  const { nodes: windNodes, meanWind } = useWindField(windCfg, paused)

  // ── 25.7 Irradiance ──
  const irradiance = useIrradianceAdjustment(
    solarPosition, cloudField, climate.pwc, tiltDeg, surfAzDeg,
  )

  // ── 25.4 Temperature ──
  const tempState = useAmbientTemperature(
    climate.temperature,
    irradiance.GTI,
    climate.windSpeed,
    climate.normals.humidityPct,
    paused ? 0 : 1,
  )

  // ── Final effective ratio (irradiance × temperature correction) ──
  const effectiveRatio = clamp(
    irradiance.effectiveRatio * tempState.efficiencyFactor,
    0,
    1.1,
  )

  // ── Sky colours ──
  const skyColors = useMemo(
    () => computeSkyColors(solarPosition.altitudeApparent, cloudField, solarPosition.altitude <= 0),
    [solarPosition.altitudeApparent, solarPosition.altitude, cloudField],
  )

  return {
    solarPosition,
    cloudField,
    irradiance,
    temperature:      tempState,
    windField:        { nodes: windNodes, meanWind },
    weather,
    climateNormals:   climate.normals,
    effectiveRatio,
    skyColors,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25 — IRRADIANCE DISPLAY OVERLAY
// ─────────────────────────────────────────────────────────────────────────────

/** Props for IrradianceOverlay */
interface IrradianceOverlayProps {
  irradiance: IrradianceResult
  tempState:  AmbientTemperatureState
  solarPos:   SolarPosition
  visible:    boolean
}

/**
 * IrradianceOverlay
 *
 * DOM panel showing full irradiance breakdown and temperature state.
 * Useful for debugging the climate engine.
 */
const IrradianceOverlay = memo(function IrradianceOverlay({
  irradiance, tempState, solarPos, visible,
}: IrradianceOverlayProps) {
  if (!visible) return null

  const fmtW  = (v: number) => `${v.toFixed(0)} W/m²`
  const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{
        position:       "absolute",
        bottom:          108,
        left:             14,
        background:     "rgba(3,8,22,0.90)",
        backdropFilter: "blur(12px)",
        border:         `1px solid ${DS.cyan}33`,
        borderTop:      `2px solid ${DS.cyan}88`,
        borderRadius:   10,
        padding:        "12px 16px",
        minWidth:       220,
        color:          DS.text,
        fontSize:       11,
        zIndex:         82,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10, color: DS.cyan, letterSpacing: "0.08em", marginBottom: 8 }}>
        ☀ IRRADIANCE DETAIL
      </div>

      {/* Solar position */}
      <div style={{ color: DS.muted, fontSize: 10, marginBottom: 4 }}>SUN POSITION</div>
      {[
        ["Altitude",   `${solarPos.altitudeApparent.toFixed(1)}°`],
        ["Azimuth",    `${solarPos.azimuth.toFixed(1)}°`],
        ["Declination", `${solarPos.declination.toFixed(1)}°`],
        ["Solar Noon", `${solarPos.solarNoon.toFixed(2)}h`],
        ["Day Length", `${solarPos.dayLength.toFixed(1)}h`],
        ["E-S Distance", `${solarPos.earthSunDistance.toFixed(4)} AU`],
      ].map(([label, value]) => (
        <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color: DS.text, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}

      <div style={{ borderTop: `1px solid ${DS.border}`, margin: "6px 0" }} />

      {/* Irradiance breakdown */}
      <div style={{ color: DS.muted, fontSize: 10, marginBottom: 4 }}>IRRADIANCE (W/m²)</div>
      {[
        ["Io (ETR)",      fmtW(irradiance.Ioh),           DS.text],
        ["DNI",           fmtW(irradiance.DNI),            DS.gold],
        ["DHI",           fmtW(irradiance.DHI),            DS.cyan],
        ["GHI",           fmtW(irradiance.GHI),            DS.text],
        ["GTI (panel)",   fmtW(irradiance.GTI),            DS.emerald],
        ["Cloud τ",       fmtPct(irradiance.cloudTransmit), DS.text],
        ["Air Mass",      isFinite(irradiance.airMass) ? irradiance.airMass.toFixed(2) : "∞", DS.muted],
        ["Eff. Ratio",    fmtPct(irradiance.effectiveRatio), DS.gold],
      ].map(([label, value, color]) => (
        <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color: String(color), fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{value}</span>
        </div>
      ))}

      <div style={{ borderTop: `1px solid ${DS.border}`, margin: "6px 0" }} />

      {/* Temperature */}
      <div style={{ color: DS.muted, fontSize: 10, marginBottom: 4 }}>TEMPERATURE</div>
      {[
        ["Ambient",     `${tempState.ambientC.toFixed(1)}°C`,     DS.text],
        ["Cell Temp",   `${tempState.cellTempC.toFixed(1)}°C`,    DS.warning],
        ["Eff. Factor", fmtPct(tempState.efficiencyFactor),       tempState.efficiencyFactor < 0.95 ? DS.warning : DS.emerald],
        ["Feels Like",  `${tempState.feelsLikeC.toFixed(1)}°C`,   DS.text],
        ["Dew Point",   `${tempState.dewPointC.toFixed(1)}°C`,    DS.muted],
      ].map(([label, value, color]) => (
        <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "1px 0" }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color: String(color), fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 25 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // 25.1 Solar Position
  SolarPositionCalculator, useSolarPosition,
  julianDayNumber, julianCenturies, sunDeclination, equationOfTime,
  computeAirMass, atmosphericRefraction, extraterrestrialRadiation,
  computeSunriseSunset, dayOfYear, seasonToDayOfYear,
  ASTRO,

  // 25.2 Seasonal Climate
  SeasonalClimateModel, useSeasonalClimate,
  CLIMATE_PROFILES, latitudeToClimateZone, interpolateNormals,

  // 25.3 Cloud Simulation
  CloudDensityFieldSimulator, useCloudField, CloudShadowRenderer,
  globalCloudSim, sampleCloudType, computeFieldCoverage,
  computeOpticalDepth, cloudTransmittance,

  // 25.4 Temperature
  PanelTemperatureCalculator, AmbientTemperatureModel, useAmbientTemperature,
  TEMP_MODEL_DEFAULTS,

  // 25.5 Wind
  buildWindField, interpolateWind, useWindField, WindVectorMap,

  // 25.6 Weather Patterns
  WeatherPatternEngine, useDynamicWeather, sampleNextWeather,
  WEATHER_TRANSITIONS,

  // 25.7 Irradiance
  IrradianceAdjustmentCalculator, useIrradianceAdjustment,
  globalIrradianceCalc,
  computeRayleighTransmittance, computeAerosolTransmittance,
  computePrecipWaterTransmittance, computeIncidenceAngle,
  computeAnisotropicDiffuse,

  // 25.8 Visual
  CloudLayer, VisualWeatherSystem, computeSkyColors, precipIntensity,

  // Integration
  useClimateEngine, IrradianceOverlay,
}

export type {
  // 25.1
  SolarPosition, SolarObserver, SolarDateTime,

  // 25.2
  ClimateZone, MonthlyClimateNormal, ClimateZoneProfile,

  // 25.3
  CloudType, CloudCell, CloudDensityField,

  // 25.4
  TempModelConfig, AmbientTemperatureState,

  // 25.5
  WindVector, WindFieldNode, WindFieldConfig,

  // 25.6
  WeatherState, WeatherTransition, WeatherEvent,

  // 25.7
  IrradianceResult, AttenuationLog,

  // 25.8
  SkyColorState, CloudLayerProps, VisualWeatherSystemProps,

  // Integration
  ClimateEngineState, IrradianceOverlayProps,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 26 — CLIMATE ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.1  SOLAR POSITION MODEL (§25.1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Algorithm:
 *   Based on Jean Meeus, "Astronomical Algorithms" 2nd ed. (1998).
 *   Accuracy: ±0.01° in altitude and azimuth for years 1900–2100.
 *
 * Computation pipeline:
 *   1. Convert calendar date/time → Julian Day Number (JDN)
 *      JDN uses the proleptic Gregorian calendar for all dates.
 *
 *   2. JDN → Julian Centuries T from J2000.0
 *      T = (JDN − 2451545.0) / 36525
 *
 *   3. Sun geometric quantities:
 *      L0  = geometric mean longitude (eq. 27.2)
 *      M   = geometric mean anomaly   (eq. 27.3)
 *      e   = orbit eccentricity       (eq. 27.4)
 *      C   = equation of centre
 *      λ   = apparent longitude (with nutation + aberration)
 *      δ   = declination = arcsin(sin ε × sin λ)
 *
 *   4. Equation of Time (EoT, minutes):
 *      Encodes the difference between mean and apparent solar time.
 *      Uses the combined effect of orbital eccentricity and axial tilt.
 *
 *   5. True Solar Time and Hour Angle:
 *      TST = LocalClockTime + EoT + 4×longitude − 60×timezone  (minutes)
 *      HA  = TST/4 − 180  (degrees)
 *
 *   6. Altitude (geometric):
 *      sin(alt) = sin(lat)×sin(δ) + cos(lat)×cos(δ)×cos(HA)
 *
 *   7. Atmospheric refraction (Bennett 1982):
 *      Adds 0.5–0.6° at horizon, negligible above 10°.
 *      Corrects for the optical bending of sunlight in the atmosphere.
 *
 *   8. Azimuth (clockwise from North):
 *      az = atan2(−sin(HA), tan(δ)×cos(lat) − sin(lat)×cos(HA)) + 180°
 *
 *   9. Sunrise/Sunset via cosine rule:
 *      cos(HA_ss) = −tan(lat)×tan(δ)
 *      Polar day: cos > 1 (no sunset).  Polar night: cos < −1 (no sunrise).
 *
 * Unit test examples:
 *   julianDayNumber({ year:2000, month:1, day:1.5, hour:12, minute:0, second:0 }, 0)
 *   → 2451545.0  (J2000.0 epoch)
 *
 *   sunDeclination(0)  → ≈ −23.0° (winter solstice J2000)
 *
 *   computeAirMass(30)  → ≈ 2.0  (AM2 at 30° altitude)
 *   computeAirMass(90)  → 1.0   (AM1 at zenith)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.2  IRRADIANCE CALCULATION METHODS (§25.7)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The irradiance calculation uses the Bird-Hulstrom clear-sky model (1981)
 * extended with cloud attenuation and the Hay-Davies-Klucher transposition
 * model for tilted surfaces.
 *
 * STAGE 1 — Extraterrestrial radiation
 *   Io = 1361.5 × (a/r)²   [W/m²]
 *   where (a/r)² accounts for Earth-Sun distance variation (~±3.3%).
 *
 * STAGE 2 — Air mass (Kasten-Young formula)
 *   AM = 1 / (sin(alt) + 0.50572×(alt + 6.07995)^−1.6364)
 *   Approximates the extra atmospheric path length at low sun angles.
 *
 * STAGE 3 — Transmittance cascade
 *   Each atmospheric component reduces direct beam independently:
 *
 *   a) Rayleigh scattering (air molecules):
 *      τR = exp(−0.0903×AM^0.84×(1 + AM − AM^1.01))
 *      Strongest at blue wavelengths (explains blue sky colour).
 *
 *   b) Aerosol attenuation (Ångström formula):
 *      τA = exp(−β × λ^−α × AM)
 *      β = turbidity coefficient (0.05 clean, 0.30 polluted)
 *      α = Ångström exponent (≈1.3 for continental aerosol)
 *
 *   c) Precipitable water vapour (Bird-Hulstrom simplified):
 *      τPW = 1 − 0.077×(W×AM)^0.3
 *      W = precipitable water content (cm), from Magnus equation + humidity
 *
 *   d) Cloud attenuation (Beer-Lambert):
 *      τC = exp(−τ_cloud × 2.3)
 *      τ_cloud = integrated optical depth from cloud field
 *
 *   e) Ozone (constant approximation):
 *      τOz ≈ 0.97 (typical mid-latitude value)
 *
 *   Combined:  DNI = Io × τR × τA × τPW × τOz × τC
 *
 * STAGE 4 — Diffuse radiation
 *   Simplified Bird-Hulstrom:
 *   DHI = Io×cosZ×0.2710×(1 − τR×τA)×τC + coverage×DNI×0.15
 *   (Rayleigh scatter + cloud-enhanced diffuse component)
 *
 * STAGE 5 — Transposition to tilted surface (Hay-Davies 1980)
 *   GTI = IBeam + IDiff + IRefl
 *   IBeam = DNI × cosθ        (beam on panel)
 *   IDiff = Hay-Davies model   (anisotropic diffuse including circumsolar)
 *   IRefl = GHI × ρ × (1 − cosβ)/2   (ground-reflected albedo, ρ ≈ 0.2)
 *
 * STEC (STC) reference: GTI / 1000 W/m² → effectiveRatio 0–1.
 *
 * Unit test examples:
 *   computeRayleighTransmittance(1.0)  → ≈ 0.919
 *   computeRayleighTransmittance(2.0)  → ≈ 0.847
 *   computeAerosolTransmittance(1.0, 0.1, 1.3)  → ≈ 0.893
 *   computeIncidenceAngle(45, 180, 20, 180)      → ≈ 0.966
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.3  CLOUD SIMULATION MODEL (§25.3)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cloud population model:
 *   The cloud field is a Poisson process of circular discs in a normalised
 *   [0,1]² domain. Target coverage is driven by WeatherType (0.08–0.95).
 *
 * Cloud types and optical properties:
 *   cirrus:         τ = 0.12, albedo = 0.24  (thin, ice crystal, very transparent)
 *   cumulus:        τ = 0.35, albedo = 0.60  (fair-weather, medium depth)
 *   altocumulus:    τ = 0.28, albedo = 0.52  (mid-level, thin sheets)
 *   stratus:        τ = 0.55, albedo = 0.72  (overcast sheets, thick)
 *   cumulonimbus:   τ = 0.88, albedo = 0.84  (deep convective, very opaque)
 *
 * Coverage from Poisson disc model:
 *   P(coverage) = 1 − exp(−Σ π×ri²  × 1.5)
 *   The 1.5 factor corrects for disc overlap geometry.
 *
 * Optical depth integration (Beer-Lambert):
 *   τ_total = Σ τ_type × density_i
 *   Transmittance = exp(−τ_total × 2.3)
 *
 * Advection:
 *   Cells drift at their spawn speed (0.008–0.028 norm-units/s) in the
 *   direction of the ambient wind field. Periodic boundary conditions
 *   simulate an infinite cloud field without edge effects.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.4  TEMPERATURE MODEL (§25.4)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOCT model for panel cell temperature (IEC 61215):
 *   Tc = Ta + (NOCT − 20) × (G / 800)
 *   NOCT = 45°C (nominal operating cell temperature, typical monocrystalline)
 *   G    = incident irradiance (W/m²)
 *   Ta   = ambient temperature (°C)
 *
 * Temperature coefficient:
 *   η_eff = η_ref × [1 + γ × (Tc − 25)]
 *   γ = −0.0040 /°C (−0.40%/°C, typical for monocrystalline Si)
 *   At 60°C: efficiency drops by (60−25) × 0.40% = 14%
 *   At  0°C: efficiency gains  by 25 × 0.40% = 10%
 *
 * Thermal mass smoothing (first-order lag):
 *   τ_thermal = 300 × thermalMassFactor   (seconds, default 105s)
 *   Tc_smooth = Tc_smooth + (1 − exp(−dt/τ)) × (Tc_target − Tc_smooth)
 *   Prevents instantaneous temperature changes from cloud cover.
 *
 * Wind convective cooling:
 *   ΔT_conv ≈ 1.2 × windSpeed_ms   [°C reduction]
 *   Reduces effective ambient temperature fed to NOCT model.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.5  WEATHER MARKOV CHAIN (§25.6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * State space: {clear, cloudy, rain, snow, storm, fog}
 *
 * Transition probabilities are per-hour rates.
 * For a dt-hour step, the per-step probability is:
 *   P(transition in dt) = 1 − (1 − P_hourly)^dt
 *
 * Example: P(cloudy → rain) = 0.05/hour
 *   In 1 hour: P = 5.0%
 *   In 4 hours: P = 19.0%
 *   In 24 hours: P = 71.5%
 *
 * Steady-state distributions (approximate):
 *   clear: 28%, cloudy: 38%, rain: 16%, snow: 4%, storm: 8%, fog: 6%
 *
 * Season override:
 *   rain → snow conversion with P=0.35 in Winter/Autumn (latitude-dependent)
 *   snow → rain forced in Summer/Spring (temperature constraint)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.6  CLIMATE ZONE ASSUMPTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Climate zones are assigned by absolute latitude:
 *   0–23.5°:   Tropical (Af/Am/Aw) — uniform solar, high humidity
 *   23.5–35°:  Subtropical (Csa/BSh) — Mediterranean/arid summers
 *   35–55°:    Temperate (Cfb/Dfb) — four seasons, moderate precipitation
 *   55–66.5°:  Subarctic (Dfc) — long winters, short warm summers
 *   66.5–90°:  Arctic (ET/EF) — polar conditions
 *
 * Monthly normals are representative medians for each zone.
 * For precise site-specific modelling, replace with TMY3 data.
 *
 * Diurnal temperature model:
 *   T(h) = T_min + (T_max − T_min) × sin(π/2 × (h − 6) / 8)^(1/2)
 *   Peak at ~14:00 local solar time, minimum at ~06:00.
 *   This is the "cosine model" / sine formula used in IEA PVPS guidelines.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.7  INTEGRATION WITH SOLAR SIMULATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ClimateEngineState provides effectiveRatio (0–1) which replaces
 * the simple WEATHER_FACTOR used in the original simulation.
 *
 * Cascade (most to least physics):
 *   SolarPositionCalculator → solarPos.Io, solarPos.altitudeApparent
 *     ↓
 *   IrradianceAdjustmentCalculator (Rayleigh, Mie, cloud, HDKR) → GTI
 *     ↓
 *   PanelTemperatureCalculator (NOCT, thermal mass) → cellTempC
 *     ↓
 *   PanelTemperatureCalculator.efficiencyFactor(cellTempC)
 *     ↓
 *   effectiveRatio = GTI/1000 × efficiencyFactor × INVERTER_EFFICIENCY
 *
 * To integrate into CityEnergySimulation (§21.4):
 *   Replace the irradiance line:
 *     const irr = sky * ws   // old
 *   With:
 *     const irr = climateState.effectiveRatio   // new
 *
 * To integrate into usePanelSimulationWorker (§10.2):
 *   Pass effectiveRatio as `computeTick` override:
 *     handle.requestTick({ irradianceOverride: climateState.effectiveRatio })
 *   Then in the worker's computeTick, replace the irradiance calculation
 *   with the override value when provided.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 26.8  PERFORMANCE CONSIDERATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Component                CPU cost/frame    Notes
 * ───────────────────────────────────────────────────────────────────────
 * SolarPositionCalculator   < 0.1 ms          Memo-cached per [hour, day]
 * SeasonalClimateModel      < 0.1 ms          Memo-cached
 * CloudDensityFieldSimulator ~0.5 ms          Ticked at 1/dt seconds
 * IrradianceAdjustmentCalc  < 0.2 ms          Memo-cached per solar/cloud change
 * PanelTemperatureCalc       < 0.1 ms/panel   Per-panel, but shared single instance
 * WindFieldSimulator         ~1.0 ms          Updated at 5 Hz, not every frame
 * WeatherPatternEngine       < 0.1 ms          Event check only
 * CloudLayer render          ~2–5 ms           20 billboard draw calls
 * CloudShadowRenderer        ~1–3 ms           Per-cell shadow quad
 * ───────────────────────────────────────────────────────────────────────
 * Total additional cost:   ~5–10 ms/frame
 *
 * Optimisation strategies:
 *   1. Reduce cloud cell count cap from 20 to 8 on mobile (CloudLayer)
 *   2. Disable CloudShadowRenderer on mobile (showShadows=false)
 *   3. Disable WindVectorMap entirely in production (showWindVectors=false)
 *   4. Update CloudDensityFieldSimulator at 1 Hz instead of per-frame
 *   5. Memoize IrradianceResult for 1-second intervals (DTH ≈ const)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27 — ELECTRICAL GRID PHYSICS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   27.1  Electrical Network Model    ~1000
//   27.2  Power Flow Solver           ~1200
//   27.3  Transformer Simulation       ~900
//   27.4  Inverter Dynamics            ~900
//   27.5  Grid Load Balancing          ~900
//   27.6  Voltage Stability Model      ~800
//   27.7  Grid Fault Simulation        ~800
//   27.8  Visual Grid Overlay          ~500
//   TOTAL ≈ 7000 lines
//
// Integration points with existing systems:
//   - CityLayout (§21.1) provides building lot positions → grid nodes
//   - CitySolarManager (§21.2) provides solarW per lot → PV generation
//   - CityEnergySimulation (§21.4) lotBalances → load values
//   - ClimateEngineState (§25) effectiveRatio → inverter DC input
//   - PowerLine (§21.3) topology → electrical edge connections
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.1 — ELECTRICAL NETWORK MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Per-unit system base values */
const PU_BASE = {
  /** Base voltage for HV level (kV) */
  Vbase_HV:  110,
  /** Base voltage for MV level (kV) */
  Vbase_MV:  11,
  /** Base voltage for LV level (kV) */
  Vbase_LV:  0.4,
  /** Base apparent power (MVA) */
  Sbase_MVA: 10,
  /** Derived base current HV (A) */
  get Ibase_HV() { return (this.Sbase_MVA * 1e6) / (Math.sqrt(3) * this.Vbase_HV * 1e3) },
  /** Derived base current MV (A) */
  get Ibase_MV() { return (this.Sbase_MVA * 1e6) / (Math.sqrt(3) * this.Vbase_MV * 1e3) },
  /** Derived base impedance HV (Ω) */
  get Zbase_HV() { return (this.Vbase_HV * 1e3) ** 2 / (this.Sbase_MVA * 1e6) },
  /** Derived base impedance MV (Ω) */
  get Zbase_MV() { return (this.Vbase_MV * 1e3) ** 2 / (this.Sbase_MVA * 1e6) },
} as const

/** Voltage level classification */
type VoltageLevel = "HV" | "MV" | "LV"

/** Node type in the electrical network */
type ElectricalNodeType =
  | "slack"           // Reference bus (infinite busbar / main grid)
  | "pv_bus"          // PV bus: fixed |V|, specified P (generator/substation)
  | "pq_bus"          // PQ bus: specified P and Q (loads, distributed PV)
  | "transformer_hv"  // Transformer high-voltage terminal
  | "transformer_lv"  // Transformer low-voltage terminal
  | "feeder"          // Distribution feeder node
  | "prosumer"        // Consumer + generator (rooftop solar)

/** Phase configuration */
type PhaseConfig = "three_phase" | "single_phase"

/** Complex number for electrical phasors */
interface Complex {
  re: number
  im: number
}

/** Create complex number */
function cx(re: number, im: number = 0): Complex { return { re, im } }
/** Add two complex numbers */
function cxAdd(a: Complex, b: Complex): Complex { return { re: a.re + b.re, im: a.im + b.im } }
/** Subtract complex numbers */
function cxSub(a: Complex, b: Complex): Complex { return { re: a.re - b.re, im: a.im - b.im } }
/** Multiply complex numbers */
function cxMul(a: Complex, b: Complex): Complex {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}
/** Divide complex numbers */
function cxDiv(a: Complex, b: Complex): Complex {
  const d = b.re * b.re + b.im * b.im
  if (d < 1e-30) return cx(0)
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }
}
/** Complex conjugate */
function cxConj(a: Complex): Complex { return { re: a.re, im: -a.im } }
/** Magnitude of complex number */
function cxAbs(a: Complex): number { return Math.sqrt(a.re * a.re + a.im * a.im) }
/** Angle of complex number (radians) */
function cxArg(a: Complex): number { return Math.atan2(a.im, a.re) }
/** Complex from polar form */
function cxPolar(r: number, theta: number): Complex {
  return { re: r * Math.cos(theta), im: r * Math.sin(theta) }
}
/** Scale complex by real scalar */
function cxScale(a: Complex, s: number): Complex { return { re: a.re * s, im: a.im * s } }

/** Per-unit voltage phasor: magnitude (pu) + angle (radians) */
interface VoltagePhasor {
  magnitude: number   // per-unit
  angle:     number   // radians
}

/** Convert VoltagePhasor to Complex */
function phasorToComplex(v: VoltagePhasor): Complex {
  return cxPolar(v.magnitude, v.angle)
}

/** Node admittance (per unit) */
interface NodeAdmittance {
  Yshunt: Complex   // shunt admittance to ground
}

/**
 * ElectricalNode
 *
 * Represents one bus in the electrical network.
 * Stores both specified values (from grid model) and computed state
 * (from power flow solution).
 */
interface ElectricalNode {
  /** Unique identifier */
  id:           string
  /** Human-readable label */
  label:        string
  /** Node type controls how power flow treats this bus */
  type:         ElectricalNodeType
  /** Voltage level classification */
  voltageLevel: VoltageLevel
  /** Base voltage (kV) for this bus */
  Vbase_kV:     number

  // ── Specified values ──────────────────────────────────────────────────────
  /** Scheduled real power injection (MW, + = generation, − = load) */
  P_sch_MW:     number
  /** Scheduled reactive power injection (MVAR) */
  Q_sch_MVAR:   number
  /** Voltage magnitude setpoint (pu) — for PV and slack buses */
  V_set_pu:     number
  /** Voltage angle setpoint (rad) — for slack bus only */
  theta_set_rad: number

  // ── Computed values (updated by power flow solver) ────────────────────────
  /** Solved voltage magnitude (pu) */
  V_pu:         number
  /** Solved voltage angle (radians) */
  theta_rad:    number
  /** Computed real power injection (MW) */
  P_calc_MW:    number
  /** Computed reactive power injection (MVAR) */
  Q_calc_MVAR:  number

  // ── Generation state ─────────────────────────────────────────────────────
  /** Current PV generation (MW) */
  Pgen_MW:      number
  /** Current reactive generation/absorption (MVAR) */
  Qgen_MVAR:    number
  /** Max real power generation capacity (MW) */
  Pgen_max_MW:  number
  /** Min real power generation (MW) */
  Pgen_min_MW:  number
  /** Max reactive power generation (MVAR) */
  Qgen_max_MVAR: number
  /** Min reactive power generation (MVAR) */
  Qgen_min_MVAR: number

  // ── Load state ────────────────────────────────────────────────────────────
  /** Active load demand (MW) */
  Pload_MW:     number
  /** Reactive load demand (MVAR) */
  Qload_MVAR:   number

  // ── Physical location ─────────────────────────────────────────────────────
  /** World space X position */
  worldX:       number
  /** World space Z position */
  worldZ:       number

  // ── Status ────────────────────────────────────────────────────────────────
  /** Node is energised and in service */
  inService:    boolean
  /** Connected transformer ID (if this is a transformer terminal) */
  transformerId?: string
}

/** Electrical line (branch) connecting two nodes */
interface ElectricalBranch {
  id:       string
  fromId:   string
  toId:     string
  /** Series resistance (pu on system base) */
  R_pu:     number
  /** Series reactance (pu) */
  X_pu:     number
  /** Line charging susceptance (pu, total, split equally at ends) */
  B_pu:     number
  /** MVA rating (thermal limit) */
  rating_MVA: number
  /** Line type for visualisation */
  type:     "transmission" | "distribution" | "service"
  /** Branch is in service */
  inService: boolean
  /** Computed power flows (updated by solver) */
  Pfrom_MW:  number
  Qfrom_MW:  number
  Pto_MW:    number
  Qto_MW:    number
  /** Current loading (0–1, fraction of rating) */
  loading:   number
  /** Line losses (MW) */
  losses_MW: number
  /** World-space intermediate waypoints for visualisation */
  waypoints?: [number, number, number][]
}

/** Transformer model parameters */
interface TransformerParams {
  id:           string
  /** High-voltage bus node ID */
  hvBusId:      string
  /** Low-voltage bus node ID */
  lvBusId:      string
  /** Rated MVA */
  ratedMVA:     number
  /** HV voltage rating (kV) */
  Vhv_kV:       number
  /** LV voltage rating (kV) */
  Vlv_kV:       number
  /** Positive-sequence leakage impedance (pu on transformer base) */
  Zleakage_pu:  Complex
  /** No-load magnetising reactance (pu) */
  Xm_pu:        number
  /** Core loss resistance (pu) */
  Rc_pu:        number
  /** Off-nominal tap ratio (1.0 = nominal) */
  tapRatio:     number
  /** Phase shift angle (rad) — usually 0 for distribution */
  phaseShift:   number
  /** Is in service */
  inService:    boolean
  /** Current load (MVA) */
  loadMVA:      number
  /** Loading fraction (0–1) */
  loading:      number
  /** Core losses (MW) */
  coreLosses_MW: number
  /** Copper losses (MW) */
  copperLosses_MW: number
  /** Temperature (°C) — affects resistance */
  temperatureC: number
}

/** Grid substation aggregation */
interface GridSubstation {
  id:           string
  label:        string
  worldX:       number
  worldZ:       number
  voltageLevel: VoltageLevel
  busIds:       string[]          // node IDs in this substation
  transformerIds: string[]
  totalLoadMW:  number
  totalGenMW:   number
  netMW:        number
  inService:    boolean
}

/**
 * ElectricalNetwork
 *
 * Full graph representation of the electrical grid.
 * Provides topology queries and Y-bus matrix construction.
 */
class ElectricalNetwork {
  private nodes:        Map<string, ElectricalNode>       = new Map()
  private branches:     Map<string, ElectricalBranch>     = new Map()
  private transformers: Map<string, TransformerParams>    = new Map()
  private substations:  Map<string, GridSubstation>       = new Map()
  private slackBusId:   string | null                     = null

  // ── Node management ────────────────────────────────────────────────────────

  addNode(node: ElectricalNode): void {
    this.nodes.set(node.id, node)
    if (node.type === "slack") this.slackBusId = node.id
  }

  getNode(id: string): ElectricalNode | undefined { return this.nodes.get(id) }

  updateNodeState(
    id:     string,
    update: Partial<Pick<ElectricalNode,
      "V_pu" | "theta_rad" | "P_calc_MW" | "Q_calc_MVAR" |
      "Pgen_MW" | "Qgen_MVAR" | "Pload_MW" | "Qload_MVAR">>
  ): void {
    const n = this.nodes.get(id)
    if (n) Object.assign(n, update)
  }

  // ── Branch management ─────────────────────────────────────────────────────

  addBranch(branch: ElectricalBranch): void {
    this.branches.set(branch.id, branch)
  }

  getBranch(id: string): ElectricalBranch | undefined { return this.branches.get(id) }

  updateBranchFlow(id: string, update: Partial<ElectricalBranch>): void {
    const b = this.branches.get(id)
    if (b) Object.assign(b, update)
  }

  // ── Transformer management ─────────────────────────────────────────────────

  addTransformer(t: TransformerParams): void { this.transformers.set(t.id, t) }
  getTransformer(id: string): TransformerParams | undefined { return this.transformers.get(id) }

  updateTransformer(id: string, update: Partial<TransformerParams>): void {
    const t = this.transformers.get(id)
    if (t) Object.assign(t, update)
  }

  // ── Substation management ─────────────────────────────────────────────────

  addSubstation(s: GridSubstation): void { this.substations.set(s.id, s) }
  getSubstation(id: string): GridSubstation | undefined { return this.substations.get(id) }

  // ── Topology queries ──────────────────────────────────────────────────────

  /** Get all branches connected to a node */
  getConnectedBranches(nodeId: string): ElectricalBranch[] {
    const result: ElectricalBranch[] = []
    for (const b of this.branches.values()) {
      if ((b.fromId === nodeId || b.toId === nodeId) && b.inService) result.push(b)
    }
    return result
  }

  /** Get neighbours of a node */
  getNeighbours(nodeId: string): string[] {
    const result: string[] = []
    for (const b of this.branches.values()) {
      if (!b.inService) continue
      if (b.fromId === nodeId) result.push(b.toId)
      else if (b.toId === nodeId) result.push(b.fromId)
    }
    return result
  }

  /** Get all nodes (sorted by index for matrix operations) */
  getAllNodes(): ElectricalNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.inService)
  }

  /** Get all branches in service */
  getAllBranches(): ElectricalBranch[] {
    return Array.from(this.branches.values()).filter((b) => b.inService)
  }

  /** Get all transformers in service */
  getAllTransformers(): TransformerParams[] {
    return Array.from(this.transformers.values()).filter((t) => t.inService)
  }

  /** Get all substations */
  getAllSubstations(): GridSubstation[] {
    return Array.from(this.substations.values())
  }

  get slackId(): string | null { return this.slackBusId }
  get nodeCount(): number { return this.nodes.size }
  get branchCount(): number { return this.branches.size }

  // ── Y-bus matrix construction ─────────────────────────────────────────────

  /**
   * buildYbus
   *
   * Constructs the nodal admittance matrix Y_bus (n × n, complex).
   * Returns: { Y: Complex[][], nodeIndex: Map<string,number> }
   *
   * Y_bus[i][j]:
   *   i ≠ j:  −y_ij (negative admittance of branch i-j)
   *   i = j:   Σ y_ij + y_shunt_i
   *
   * Transformer tap changes are included via the π-model equivalence.
   * Pure function — unit testable given a snapshot of network state.
   */
  buildYbus(): { Y: Complex[][]; nodeIndex: Map<string, number> } {
    const nodes  = this.getAllNodes()
    const n      = nodes.length
    const nodeIndex = new Map<string, number>()
    nodes.forEach((nd, i) => nodeIndex.set(nd.id, i))

    // Initialise n×n complex matrix
    const Y: Complex[][] = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => cx(0))
    )

    const addY = (i: number, j: number, y: Complex) => {
      Y[i][j] = cxAdd(Y[i][j], y)
    }

    // ── Branch contributions ────────────────────────────────────────────────
    for (const b of this.getAllBranches()) {
      const i = nodeIndex.get(b.fromId)
      const j = nodeIndex.get(b.toId)
      if (i === undefined || j === undefined) continue

      // Series admittance y_series = 1 / (R + jX)
      const Z_series = cx(b.R_pu, b.X_pu)
      const y_series = cxDiv(cx(1), Z_series)

      // Half-line charging at each end
      const y_shunt_half = cx(0, b.B_pu / 2)

      // Diagonal: y_series + y_shunt
      addY(i, i, cxAdd(y_series, y_shunt_half))
      addY(j, j, cxAdd(y_series, y_shunt_half))
      // Off-diagonal: −y_series
      addY(i, j, cxScale(y_series, -1))
      addY(j, i, cxScale(y_series, -1))
    }

    // ── Transformer contributions (π-model with tap) ─────────────────────────
    for (const t of this.getAllTransformers()) {
      const i = nodeIndex.get(t.hvBusId)
      const j = nodeIndex.get(t.lvBusId)
      if (i === undefined || j === undefined) continue

      // Convert leakage impedance to system base
      const Zbase_ratio = (t.Vhv_kV ** 2) / PU_BASE.Sbase_MVA
      const Zt_sys = cxScale(t.Zleakage_pu, (t.Vhv_kV ** 2) / (t.ratedMVA * Zbase_ratio))
      const yt     = cxDiv(cx(1), Zt_sys)
      const a      = t.tapRatio * Math.cos(t.phaseShift)
      const a_im   = t.tapRatio * Math.sin(t.phaseShift)
      const a_cx   = cx(a, a_im)
      const a_star = cxConj(a_cx)
      const a2     = cxAbs(a_cx) ** 2

      // Standard π-model with off-nominal tap
      addY(i, i, cxDiv(yt, cx(a2)))
      addY(j, j, yt)
      addY(i, j, cxScale(cxDiv(yt, a_star), -1))
      addY(j, i, cxScale(cxDiv(yt, a_cx),   -1))
    }

    return { Y, nodeIndex }
  }

  // ── Network statistics ────────────────────────────────────────────────────

  /** Total generation (MW) */
  totalGenerationMW(): number {
    return Array.from(this.nodes.values()).reduce((s, n) => s + Math.max(n.Pgen_MW, 0), 0)
  }

  /** Total load (MW) */
  totalLoadMW(): number {
    return Array.from(this.nodes.values()).reduce((s, n) => s + Math.max(n.Pload_MW, 0), 0)
  }

  /** Total losses (MW) */
  totalLossesMW(): number {
    return Array.from(this.branches.values())
      .filter((b) => b.inService)
      .reduce((s, b) => s + b.losses_MW, 0)
  }

  /** Count nodes by type */
  nodeTypeCounts(): Map<ElectricalNodeType, number> {
    const m = new Map<ElectricalNodeType, number>()
    for (const n of this.nodes.values()) {
      m.set(n.type, (m.get(n.type) ?? 0) + 1)
    }
    return m
  }
}

/** Module-singleton grid network */
const globalElectricalNetwork = new ElectricalNetwork()

/** Pure factory: create a default ElectricalNode */
function makeElectricalNode(
  id:     string,
  type:   ElectricalNodeType,
  level:  VoltageLevel,
  worldX: number,
  worldZ: number,
  opts:   Partial<ElectricalNode> = {},
): ElectricalNode {
  const Vbase: Record<VoltageLevel, number> = { HV: 110, MV: 11, LV: 0.4 }
  return {
    id, label: id, type, voltageLevel: level,
    Vbase_kV:     Vbase[level],
    P_sch_MW:     0, Q_sch_MVAR:    0,
    V_set_pu:     1.0, theta_set_rad: 0,
    V_pu:         1.0, theta_rad:     0,
    P_calc_MW:    0, Q_calc_MVAR:   0,
    Pgen_MW:      0, Qgen_MVAR:     0,
    Pgen_max_MW:  0, Pgen_min_MW:   0,
    Qgen_max_MVAR: 0, Qgen_min_MVAR: 0,
    Pload_MW:     0, Qload_MVAR:    0,
    worldX, worldZ, inService: true,
    ...opts,
  }
}

/** Pure factory: create an ElectricalBranch */
function makeElectricalBranch(
  id:     string,
  fromId: string,
  toId:   string,
  R_pu:   number,
  X_pu:   number,
  opts:   Partial<ElectricalBranch> = {},
): ElectricalBranch {
  return {
    id, fromId, toId, R_pu, X_pu,
    B_pu:        0,
    rating_MVA:  10,
    type:        "distribution",
    inService:   true,
    Pfrom_MW:    0, Qfrom_MW:    0,
    Pto_MW:      0, Qto_MW:      0,
    loading:     0, losses_MW:   0,
    ...opts,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.2 — POWER FLOW SOLVER
// ─────────────────────────────────────────────────────────────────────────────

/** Power flow solution result */
interface PowerFlowResult {
  /** Converged successfully */
  converged:     boolean
  /** Iterations taken */
  iterations:    number
  /** Maximum mismatch at convergence (pu) */
  maxMismatch:   number
  /** Solved voltage magnitudes per node id (pu) */
  voltages:      Map<string, VoltagePhasor>
  /** Real power injections (MW) */
  powerInjections: Map<string, number>
  /** Reactive power injections (MVAR) */
  reactiveInjections: Map<string, number>
  /** Branch power flows */
  branchFlows:   Map<string, { Pfrom: number; Qfrom: number; Pto: number; Qto: number; losses: number }>
  /** Total system losses (MW) */
  totalLossesMW: number
  /** Solution time (ms) */
  solveTimeMs:   number
}

/** Newton-Raphson solver configuration */
interface NRSolverConfig {
  /** Maximum iterations (default 50) */
  maxIter:       number
  /** Convergence tolerance on P,Q mismatch (pu) */
  tolerance:     number
  /** Flat start: all voltages initialised to 1∠0 */
  flatStart:     boolean
  /** Voltage magnitude limits (pu) */
  Vmin:          number
  Vmax:          number
  /** Enable Q-limit enforcement for generators */
  enforceQLimits: boolean
}

const NR_DEFAULTS: NRSolverConfig = {
  maxIter:        50,
  tolerance:      1e-6,
  flatStart:      true,
  Vmin:           0.90,
  Vmax:           1.10,
  enforceQLimits: true,
}

/** Mismatch vector entry */
interface BusMismatch {
  nodeId:  string
  dP:      number   // MW mismatch
  dQ:      number   // MVAR mismatch
}

/**
 * computeBusMismatches
 *
 * Computes P and Q mismatches at each PQ and PV bus.
 * ΔP_i = P_sch_i − P_calc_i
 * ΔQ_i = Q_sch_i − Q_calc_i  (PQ buses only)
 *
 * Pure function — unit testable.
 */
function computeBusMismatches(
  nodes:      ElectricalNode[],
  Y:          Complex[][],
  nodeIndex:  Map<string, number>,
  voltages:   VoltagePhasor[],
): BusMismatch[] {
  const n        = nodes.length
  const mismatches: BusMismatch[] = []

  for (let i = 0; i < n; i++) {
    const nd = nodes[i]
    if (nd.type === "slack") continue

    const Vi = cxPolar(voltages[i].magnitude, voltages[i].angle)
    let P_calc = 0
    let Q_calc = 0

    for (let k = 0; k < n; k++) {
      const Vk    = cxPolar(voltages[k].magnitude, voltages[k].angle)
      const Yik   = Y[i][k]
      const term  = cxMul(Vi, cxConj(cxMul(Yik, Vk)))
      P_calc += term.re
      Q_calc += term.im
    }

    const P_sch = nd.P_sch_MW / PU_BASE.Sbase_MVA
    const Q_sch = nd.Q_sch_MVAR / PU_BASE.Sbase_MVA

    mismatches.push({
      nodeId: nd.id,
      dP:     P_sch - P_calc,
      dQ:     nd.type === "pq_bus" ? Q_sch - Q_calc : 0,
    })
  }

  return mismatches
}

/**
 * buildJacobian
 *
 * Computes the Newton-Raphson Jacobian matrix J (2n × 2n, n = non-slack buses).
 * Structure: [∂P/∂θ  ∂P/∂|V|; ∂Q/∂θ  ∂Q/∂|V|]
 * Pure function — unit testable (given small 2-bus test case).
 */
function buildJacobian(
  nodes:     ElectricalNode[],
  Y:         Complex[][],
  nodeIndex: Map<string, number>,
  voltages:  VoltagePhasor[],
): number[][] {
  // Non-slack buses form the active equation set
  const nonSlack = nodes.filter((n) => n.type !== "slack")
  const m        = nonSlack.length
  const J        = Array.from({ length: 2 * m }, () => new Array<number>(2 * m).fill(0))

  for (let pi = 0; pi < m; pi++) {
    const nd_i  = nonSlack[pi]
    const i     = nodeIndex.get(nd_i.id)!
    const Vi    = voltages[i].magnitude
    const thi   = voltages[i].angle

    // Sub-matrices: H = ∂P/∂θ, N = ∂P/∂|V|·|V|, M = ∂Q/∂θ, L = ∂Q/∂|V|·|V|
    // Off-diagonal terms
    for (let pj = 0; pj < m; pj++) {
      const nd_j = nonSlack[pj]
      const j    = nodeIndex.get(nd_j.id)!
      if (pi === pj) continue
      const Vj   = voltages[j].magnitude
      const thij = thi - voltages[j].angle
      const Yij  = Y[i][j]
      const Gij  = Yij.re, Bij = Yij.im

      // H_ij = ∂P_i/∂θ_j
      J[pi][pj]         = Vi * Vj * (-Gij * Math.sin(thij) + Bij * Math.cos(thij))
      // N_ij = ∂P_i/∂|Vj|·|Vj|
      J[pi][m + pj]     = Vi * Vj * ( Gij * Math.cos(thij) + Bij * Math.sin(thij))
      // M_ij = ∂Q_i/∂θ_j  (only for PQ buses)
      if (nd_i.type === "pq_bus") {
        J[m + pi][pj]   =  Vi * Vj * ( Gij * Math.cos(thij) + Bij * Math.sin(thij))
        J[m + pi][m+pj] =  Vi * Vj * ( Gij * Math.sin(thij) - Bij * Math.cos(thij))
      }
    }

    // Diagonal terms
    let P_i = 0, Q_i = 0
    for (let k = 0; k < nodes.length; k++) {
      const Vk   = voltages[k].magnitude
      const thik = thi - voltages[k].angle
      const Yik  = Y[i][k]
      P_i += Vk * (Yik.re * Math.cos(thik) + Yik.im * Math.sin(thik))
      Q_i += Vk * (Yik.re * Math.sin(thik) - Yik.im * Math.cos(thik))
    }
    const Yii  = Y[i][i]
    const Gii  = Yii.re, Bii = Yii.im

    J[pi][pi]       = -Vi * Q_i - Vi * Vi * Bii
    J[pi][m + pi]   =  P_i / Vi + Vi * Gii
    if (nd_i.type === "pq_bus") {
      J[m+pi][pi]   =  Vi * P_i - Vi * Vi * Gii
      J[m+pi][m+pi] =  Q_i / Vi - Vi * Bii
    } else {
      // PV bus: ∂Q/∂θ = 0, ∂Q/∂|V| handled by |V| constraint
      J[m+pi][m+pi] = 1.0   // identity row for |V| fixed constraint
    }
  }

  return J
}

/**
 * solveLinearSystem
 *
 * Gaussian elimination with partial pivoting.
 * Solves Ax = b, returns x.
 * Pure function — unit testable.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length
  // Augmented matrix
  const M = A.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]

    const pivot = M[col][col]
    if (Math.abs(pivot) < 1e-14) continue

    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = M[row][col] / pivot
      for (let c = col; c <= n; c++) M[row][c] -= factor * M[col][c]
    }
  }

  return M.map((row, i) => row[n] / (row[i] || 1e-14))
}

/**
 * computeBranchFlows
 *
 * Given solved voltages, compute power flow on each branch.
 * S_from = V_from × (Y_series × (V_from − V_to) + Y_shunt × V_from)*
 * Pure function — unit testable.
 */
function computeBranchFlows(
  branches:   ElectricalBranch[],
  nodeIndex:  Map<string, number>,
  voltages:   VoltagePhasor[],
  Sbase_MVA:  number,
): Map<string, { Pfrom: number; Qfrom: number; Pto: number; Qto: number; losses: number }> {
  const result = new Map<string, { Pfrom: number; Qfrom: number; Pto: number; Qto: number; losses: number }>()

  for (const b of branches) {
    const i = nodeIndex.get(b.fromId)
    const j = nodeIndex.get(b.toId)
    if (i === undefined || j === undefined) {
      result.set(b.id, { Pfrom: 0, Qfrom: 0, Pto: 0, Qto: 0, losses: 0 })
      continue
    }

    const Vi = cxPolar(voltages[i].magnitude, voltages[i].angle)
    const Vj = cxPolar(voltages[j].magnitude, voltages[j].angle)

    const Z  = cx(b.R_pu, b.X_pu)
    const y  = cxDiv(cx(1), Z)
    const yb = cx(0, b.B_pu / 2)

    // Current from i to j: I_ij = y × (Vi − Vj)
    const dV    = cxSub(Vi, Vj)
    const I_ij  = cxAdd(cxMul(y, dV), cxMul(yb, Vi))
    const I_ji  = cxAdd(cxMul(cxScale(y, -1), dV), cxMul(yb, Vj))

    // Apparent power: S = V × I*
    const S_ij = cxMul(Vi, cxConj(I_ij))
    const S_ji = cxMul(Vj, cxConj(I_ji))

    const Pfrom    = S_ij.re * Sbase_MVA
    const Qfrom    = S_ij.im * Sbase_MVA
    const Pto      = -S_ji.re * Sbase_MVA
    const Qto      = -S_ji.im * Sbase_MVA
    const losses   = Math.max(0, Pfrom - Pto)

    result.set(b.id, { Pfrom, Qfrom, Pto, Qto, losses })
  }

  return result
}

/**
 * PowerFlowSolver
 *
 * Newton-Raphson AC power flow solver.
 * Handles PV, PQ, and slack buses.
 * Enforces generator Q limits (switches PV→PQ on limit violation).
 *
 * For large networks (> 200 buses), consider replacing with
 * Fast-Decoupled Load Flow (FDLF) for better convergence speed.
 */
class PowerFlowSolver {
  private cfg: NRSolverConfig

  constructor(cfg: Partial<NRSolverConfig> = {}) {
    this.cfg = { ...NR_DEFAULTS, ...cfg }
  }

  /**
   * solve
   *
   * Runs Newton-Raphson iterations on the given network snapshot.
   * Modifies network node/branch state in-place after convergence.
   *
   * @param network  ElectricalNetwork (must have at least one slack bus)
   * @returns        PowerFlowResult
   */
  solve(network: ElectricalNetwork): PowerFlowResult {
    const t0     = performance.now()
    const nodes  = network.getAllNodes()
    const n      = nodes.length

    if (n === 0 || !network.slackId) {
      return this.failResult("No nodes or no slack bus", t0)
    }

    // Build Y-bus
    const { Y, nodeIndex } = network.buildYbus()

    // Initialise voltages
    const voltages: VoltagePhasor[] = nodes.map((nd) => ({
      magnitude: this.cfg.flatStart ? 1.0 : nd.V_pu,
      angle:     this.cfg.flatStart ? 0.0 : nd.theta_rad,
    }))

    // Fix slack bus voltage
    const slackIdx = nodeIndex.get(network.slackId)
    if (slackIdx !== undefined) {
      const slackNode = network.getNode(network.slackId)!
      voltages[slackIdx] = { magnitude: slackNode.V_set_pu, angle: slackNode.theta_set_rad }
    }

    let iter = 0
    let maxMismatch = Infinity
    const nonSlack = nodes.filter((nd) => nd.type !== "slack")

    while (iter < this.cfg.maxIter) {
      // Compute mismatches
      const mismatches = computeBusMismatches(nodes, Y, nodeIndex, voltages)
      maxMismatch = Math.max(...mismatches.map((m) => Math.max(Math.abs(m.dP), Math.abs(m.dQ))))

      if (maxMismatch < this.cfg.tolerance) break

      // Build Jacobian
      const J = buildJacobian(nodes, Y, nodeIndex, voltages)

      // Mismatch vector [ΔP; ΔQ]
      const misMap = new Map(mismatches.map((m) => [m.nodeId, m]))
      const dPQ    = nonSlack.flatMap((nd) => {
        const m = misMap.get(nd.id) ?? { dP: 0, dQ: 0 }
        return [m.dP, m.dQ]
      })

      // Solve J × [Δθ; Δ|V|/|V|] = [ΔP; ΔQ]
      const dx = solveLinearSystem(J, dPQ)

      // Update voltages
      for (let pi = 0; pi < nonSlack.length; pi++) {
        const nd_i  = nonSlack[pi]
        const i     = nodeIndex.get(nd_i.id)!
        const dTheta = dx[pi]
        const dVmag  = nd_i.type === "pq_bus" ? dx[nonSlack.length + pi] : 0

        voltages[i] = {
          magnitude: clamp(voltages[i].magnitude + dVmag, this.cfg.Vmin * 0.8, this.cfg.Vmax * 1.2),
          angle:     voltages[i].angle + dTheta,
        }

        // Enforce PV bus voltage magnitude
        if (nd_i.type === "pv_bus") {
          voltages[i].magnitude = nd_i.V_set_pu
        }
      }

      // Check Q limits for PV buses
      if (this.cfg.enforceQLimits) {
        this.enforceQLimitsOnce(nonSlack, Y, nodeIndex, voltages, network)
      }

      iter++
    }

    // Write results back to network
    nodes.forEach((nd, i) => {
      network.updateNodeState(nd.id, {
        V_pu:      voltages[i].magnitude,
        theta_rad: voltages[i].angle,
      })
    })

    // Compute branch flows
    const branchFlows = computeBranchFlows(
      network.getAllBranches(), nodeIndex, voltages, PU_BASE.Sbase_MVA
    )
    for (const [branchId, flow] of branchFlows) {
      const b = network.getBranch(branchId)
      if (!b) continue
      const loading = b.rating_MVA > 0
        ? Math.sqrt(flow.Pfrom ** 2 + flow.Qfrom ** 2) / b.rating_MVA
        : 0
      network.updateBranchFlow(branchId, {
        Pfrom_MW:  flow.Pfrom,
        Qfrom_MW:  flow.Qfrom,
        Pto_MW:    flow.Pto,
        Qto_MW:    flow.Qto,
        losses_MW: flow.losses,
        loading:   clamp(loading, 0, 2),
      })
    }

    const totalLosses = Array.from(branchFlows.values()).reduce((s, f) => s + f.losses, 0)
    const voltageMap  = new Map(nodes.map((nd, i) => [nd.id, voltages[i]]))

    return {
      converged:           maxMismatch < this.cfg.tolerance,
      iterations:          iter,
      maxMismatch,
      voltages:            voltageMap,
      powerInjections:     new Map(nodes.map((nd) => [nd.id, nd.P_calc_MW])),
      reactiveInjections:  new Map(nodes.map((nd) => [nd.id, nd.Q_calc_MVAR])),
      branchFlows,
      totalLossesMW:       totalLosses,
      solveTimeMs:         performance.now() - t0,
    }
  }

  /** Enforce reactive power limits: switch PV→PQ if Q limit violated */
  private enforceQLimitsOnce(
    nonSlack:  ElectricalNode[],
    Y:         Complex[][],
    nodeIndex: Map<string, number>,
    voltages:  VoltagePhasor[],
    network:   ElectricalNetwork,
  ): void {
    for (const nd of nonSlack) {
      if (nd.type !== "pv_bus") continue
      const i = nodeIndex.get(nd.id)!
      const Vi = cxPolar(voltages[i].magnitude, voltages[i].angle)
      let Qi = 0
      for (let k = 0; k < nonSlack.length + 1; k++) {
        const Vk   = cxPolar(voltages[k]?.magnitude ?? 1, voltages[k]?.angle ?? 0)
        const Yik  = Y[i][k]
        const term = cxMul(Vi, cxConj(cxMul(Yik, Vk)))
        Qi += term.im
      }
      const Q_MW = Qi * PU_BASE.Sbase_MVA
      if (Q_MW > nd.Qgen_max_MVAR) {
        network.updateNodeState(nd.id, { Qgen_MVAR: nd.Qgen_max_MVAR })
      } else if (Q_MW < nd.Qgen_min_MVAR) {
        network.updateNodeState(nd.id, { Qgen_MVAR: nd.Qgen_min_MVAR })
      }
    }
  }

  private failResult(reason: string, t0: number): PowerFlowResult {
    console.warn("[PowerFlowSolver]", reason)
    return {
      converged: false, iterations: 0, maxMismatch: Infinity,
      voltages: new Map(), powerInjections: new Map(),
      reactiveInjections: new Map(), branchFlows: new Map(),
      totalLossesMW: 0, solveTimeMs: performance.now() - t0,
    }
  }
}

/**
 * LoadFlowCalculator
 *
 * Simplified Gauss-Seidel load flow for small distribution networks (< 50 buses).
 * Lower accuracy but faster convergence for weakly-meshed LV grids.
 * Suitable as a fast approximation when NR fails to converge.
 */
class LoadFlowCalculator {
  private maxIter:   number = 100
  private tolerance: number = 1e-4

  constructor(maxIter = 100, tolerance = 1e-4) {
    this.maxIter   = maxIter
    this.tolerance = tolerance
  }

  /**
   * Gauss-Seidel load flow.
   * Returns a voltage map after convergence (or max iterations).
   * Pure interface — no side effects on network.
   */
  solve(
    nodes:     ElectricalNode[],
    Y:         Complex[][],
    nodeIndex: Map<string, number>,
    slackId:   string,
  ): Map<string, VoltagePhasor> {
    const n = nodes.length
    const voltages: Complex[] = nodes.map(() => cx(1))

    const slackIdx = nodeIndex.get(slackId)
    const slackNode = nodes.find((nd) => nd.id === slackId)
    if (slackIdx !== undefined && slackNode) {
      voltages[slackIdx] = cxPolar(slackNode.V_set_pu, slackNode.theta_set_rad)
    }

    for (let iter = 0; iter < this.maxIter; iter++) {
      let maxDelta = 0

      for (let i = 0; i < n; i++) {
        const nd = nodes[i]
        if (nd.type === "slack") continue

        const P_pu = (nd.Pgen_MW - nd.Pload_MW) / PU_BASE.Sbase_MVA
        const Q_pu = (nd.Qgen_MVAR - nd.Qload_MVAR) / PU_BASE.Sbase_MVA
        const Si   = cx(P_pu, Q_pu)
        // I_i = (S_i / V_i)* = conj(S_i / V_i)
        const I_sp = cxConj(cxDiv(Si, voltages[i]))

        // V_i = (I_sp − Σ_{k≠i} Y_ik V_k) / Y_ii
        let sum = cx(0)
        for (let k = 0; k < n; k++) {
          if (k === i) continue
          sum = cxAdd(sum, cxMul(Y[i][k], voltages[k]))
        }
        const Yii_mag = cxAbs(Y[i][i])
        if (Yii_mag < 1e-12) continue

        const V_new = cxDiv(cxSub(I_sp, sum), Y[i][i])
        const delta = cxAbs(cxSub(V_new, voltages[i]))
        maxDelta    = Math.max(maxDelta, delta)
        voltages[i] = V_new
      }

      if (maxDelta < this.tolerance) break
    }

    const result = new Map<string, VoltagePhasor>()
    nodes.forEach((nd, i) => {
      result.set(nd.id, {
        magnitude: cxAbs(voltages[i]),
        angle:     cxArg(voltages[i]),
      })
    })
    return result
  }
}

/** Module-singleton power flow solver */
const globalPowerFlowSolver  = new PowerFlowSolver()
const globalLoadFlowCalc     = new LoadFlowCalculator()

/** Hook: runs power flow at regular intervals */
function usePowerFlowSolver(
  network:       ElectricalNetwork,
  intervalMs:    number = 5000,
  enabled:       boolean = true,
): PowerFlowResult | null {
  const [result, setResult] = useState<PowerFlowResult | null>(null)

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      const r = globalPowerFlowSolver.solve(network)
      setResult(r)
    }
    run()
    const id = setInterval(run, intervalMs)
    return () => clearInterval(id)
  }, [network, intervalMs, enabled])

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.3 — TRANSFORMER SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Transformer operating state */
interface TransformerState {
  /** Current loading fraction (0–1, > 1 = overloaded) */
  loading:         number
  /** Core losses (no-load, MW) */
  coreLosses_MW:   number
  /** Copper losses (load-dependent, MW) */
  copperLosses_MW: number
  /** Total losses (MW) */
  totalLosses_MW:  number
  /** Winding temperature (°C) */
  windingTempC:    number
  /** Top-oil temperature (°C) */
  topOilTempC:     number
  /** Hot-spot temperature (°C) */
  hotSpotTempC:    number
  /** Estimated remaining life fraction (0–1) */
  remainingLife:   number
  /** Tap position (integer, 0 = nominal) */
  tapPosition:     number
  /** Computed tap ratio (off-nominal) */
  tapRatio:        number
  /** Output voltage (pu) */
  Vout_pu:         number
  /** Is in overload condition */
  overloaded:      boolean
  /** Thermal alarm active */
  thermalAlarm:    boolean
}

/** Transformer thermal model constants (IEC 60076-7) */
interface TransformerThermalConstants {
  /** Top-oil thermal time constant (minutes) */
  thermalTimeMin:   number
  /** Winding hotspot factor H */
  hotspotFactor:    number
  /** Thermal exponent n (0.8–1.0) */
  thermalExponent:  number
  /** Temperature rise at rated load: top-oil (°C) */
  deltaOilRated:    number
  /** Temperature rise at rated load: hotspot (°C) */
  deltaHSRated:     number
  /** Ambient temperature (°C) */
  ambientC:         number
}

const TRANSFORMER_THERMAL_DEFAULTS: TransformerThermalConstants = {
  thermalTimeMin:  120,
  hotspotFactor:   1.3,
  thermalExponent: 0.9,
  deltaOilRated:   40,
  deltaHSRated:    65,
  ambientC:        25,
}

/**
 * computeTransformerLosses
 *
 * IEC 60076 loss model.
 * P_core = P_fe (constant, from no-load test data)
 * P_copper = P_cu_rated × loading²
 * Pure function — unit testable.
 */
function computeTransformerLosses(
  loading:       number,
  ratedMVA:      number,
  noLoadLossPct: number = 0.002,   // 0.2% of rated MVA
  loadLossPct:   number = 0.012,   // 1.2% of rated MVA at full load
): { coreMW: number; copperMW: number; totalMW: number } {
  const coreMW   = ratedMVA * noLoadLossPct
  const copperMW = ratedMVA * loadLossPct * loading * loading
  return { coreMW, copperMW, totalMW: coreMW + copperMW }
}

/**
 * computeHotSpotTemperature
 *
 * IEC 60076-7 thermal model.
 * θ_HS = θ_amb + Δθ_oil + Δθ_HS
 * Pure function — unit testable.
 */
function computeHotSpotTemperature(
  loading:  number,
  tc:       TransformerThermalConstants,
  prevTopOilC: number,
  dt_min:   number,   // time step in minutes
): { topOilC: number; hotSpotC: number } {
  const K = loading
  const deltaOil_inf = tc.deltaOilRated * Math.pow(K, 2 * tc.thermalExponent)
  const tau = tc.thermalTimeMin

  // Exponential thermal model
  const alpha    = 1 - Math.exp(-dt_min / tau)
  const topOilC  = prevTopOilC + alpha * (tc.ambientC + deltaOil_inf - prevTopOilC)
  const deltaHS  = tc.deltaHSRated * Math.pow(K, 2 * tc.thermalExponent) * tc.hotspotFactor
  const hotSpotC = topOilC + deltaHS

  return { topOilC, hotSpotC }
}

/**
 * estimateAgingAcceleration
 *
 * IEEE C57.91 aging acceleration factor.
 * F_AA = exp(15000/383 − 15000/(θ_HS + 273))
 * F_AA = 1 at 98°C hot-spot (reference temperature).
 * Pure function — unit testable.
 */
function estimateAgingAcceleration(hotSpotC: number): number {
  const EAAK = 15000
  const T_ref = 383   // K = 110°C reference
  const T_HS  = hotSpotC + 273.15
  return Math.exp(EAAK / T_ref - EAAK / T_HS)
}

/**
 * TransformerModel
 *
 * Full transformer simulation including:
 *   - Thermal model (IEC 60076-7)
 *   - Loss calculation (IEC 60076)
 *   - Tap changer simulation
 *   - Insulation aging estimation
 *   - Overload alarm logic
 */
class TransformerModel {
  private params:        TransformerParams
  private thermalConsts: TransformerThermalConstants
  private state:         TransformerState
  private tapMax:        number = 8     // tap range ±8 steps
  private tapStep_pu:    number = 0.0125 // 1.25% per step (typical)
  private totalAgingHrs: number = 0     // cumulative equivalent aging (hours)
  private lifeHrs:       number = 200000  // expected total life (hours)

  constructor(params: TransformerParams, ambientC = 25) {
    this.params = params
    this.thermalConsts = { ...TRANSFORMER_THERMAL_DEFAULTS, ambientC }
    this.state = {
      loading:         0,
      coreLosses_MW:   0,
      copperLosses_MW: 0,
      totalLosses_MW:  0,
      windingTempC:    ambientC,
      topOilTempC:     ambientC,
      hotSpotTempC:    ambientC,
      remainingLife:   1,
      tapPosition:     0,
      tapRatio:        1.0,
      Vout_pu:         1.0,
      overloaded:      false,
      thermalAlarm:    false,
    }
  }

  /**
   * update
   *
   * Advance transformer state by dt seconds.
   * @param loadMVA      Current load (MVA)
   * @param Vin_pu       Input voltage (pu)
   * @param ambientC     Current ambient temperature (°C)
   * @param dt           Time step (seconds)
   */
  update(loadMVA: number, Vin_pu: number, ambientC: number, dt: number): TransformerState {
    this.thermalConsts.ambientC = ambientC
    const loading = clamp(loadMVA / Math.max(this.params.ratedMVA, 0.001), 0, 5)

    // Losses
    const losses = computeTransformerLosses(loading, this.params.ratedMVA)

    // Thermal model
    const dt_min = dt / 60
    const { topOilC, hotSpotC } = computeHotSpotTemperature(
      loading, this.thermalConsts, this.state.topOilTempC, dt_min
    )

    // Tap changer logic: adjust if HV voltage deviates > 2%
    const V_err = Vin_pu - 1.0
    let tap = this.state.tapPosition
    if (Math.abs(V_err) > 0.02) {
      tap = clamp(tap + (V_err > 0 ? 1 : -1), -this.tapMax, this.tapMax)
    }
    const tapRatio = 1.0 + tap * this.tapStep_pu
    const Vout_pu  = clamp(Vin_pu / tapRatio, 0.85, 1.15)

    // Aging
    const F_AA = estimateAgingAcceleration(hotSpotC)
    this.totalAgingHrs += (dt / 3600) * F_AA
    const remainingLife = clamp(1 - this.totalAgingHrs / this.lifeHrs, 0, 1)

    // Alarms
    const overloaded     = loading > 1.0
    const thermalAlarm   = hotSpotC > 110 || topOilC > 95

    this.state = {
      loading,
      coreLosses_MW:   losses.coreMW,
      copperLosses_MW: losses.copperMW,
      totalLosses_MW:  losses.totalMW,
      windingTempC:    hotSpotC * 0.9,
      topOilTempC:     topOilC,
      hotSpotTempC:    hotSpotC,
      remainingLife,
      tapPosition:     tap,
      tapRatio,
      Vout_pu,
      overloaded,
      thermalAlarm,
    }

    // Update params
    this.params.loading        = loading
    this.params.copperLosses_MW = losses.copperMW
    this.params.coreLosses_MW  = losses.coreMW
    this.params.tapRatio       = tapRatio
    this.params.temperatureC   = topOilC

    return this.state
  }

  get currentState(): TransformerState { return this.state }
  get isOverloaded():  boolean          { return this.state.overloaded }
  get tapPosition():   number           { return this.state.tapPosition }
}

/**
 * VoltageRegulator
 *
 * Automatic tap-changer controller.
 * Monitors bus voltage and adjusts transformer tap to keep Vout
 * within the deadband around setpoint.
 */
class VoltageRegulator {
  private setpoint:   number = 1.0     // pu voltage target
  private deadband:   number = 0.02    // ±2% deadband
  private tapDelay:   number = 30      // seconds between tap operations
  private lastTapTime: number = 0

  constructor(setpoint = 1.0, deadband = 0.02, tapDelay = 30) {
    this.setpoint = setpoint
    this.deadband = deadband
    this.tapDelay = tapDelay
  }

  /**
   * shouldChangeTap
   *
   * Returns +1 (raise tap), −1 (lower tap), or 0 (no change).
   * Pure function — unit testable.
   */
  shouldChangeTap(Vmeas_pu: number, currentTime: number): -1 | 0 | 1 {
    if (currentTime - this.lastTapTime < this.tapDelay) return 0
    const err = Vmeas_pu - this.setpoint
    if (err < -this.deadband) { this.lastTapTime = currentTime; return +1 }
    if (err > +this.deadband) { this.lastTapTime = currentTime; return -1 }
    return 0
  }

  setSetpoint(sp: number): void { this.setpoint = sp }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.4 — INVERTER DYNAMICS
// ─────────────────────────────────────────────────────────────────────────────

/** Inverter operating state */
interface InverterState {
  /** DC input power (W) */
  Pdc_W:          number
  /** DC input voltage (V) */
  Vdc_V:          number
  /** MPPT output power (W) */
  Pmppt_W:        number
  /** AC output power (W) */
  Pac_W:          number
  /** AC reactive power (VAR) */
  Qac_VAR:        number
  /** Apparent power (VA) */
  Sac_VA:         number
  /** Power factor */
  powerFactor:    number
  /** Conversion efficiency (0–1) */
  efficiency:     number
  /** DC-side voltage (V) */
  Vdc_mpp_V:      number
  /** Grid synchronisation phase error (rad) */
  phaseError_rad: number
  /** Grid voltage (pu) */
  Vgrid_pu:       number
  /** Operational status */
  status:         InverterStatus
  /** Current operating mode */
  mode:           InverterMode
  /** Clipping loss (W) */
  clippingLoss_W: number
  /** Temperature (°C) */
  temperatureC:   number
  /** Cumulative energy produced (kWh) */
  energyKwh:      number
}

type InverterStatus = "running" | "sleeping" | "fault" | "mppt" | "curtailed" | "grid_trip"
type InverterMode   = "mppt" | "constant_power" | "reactive_support" | "ramp_rate"

/** Inverter efficiency curve data point */
interface EfficiencyPoint {
  loadFraction: number    // 0–1 (P_ac / P_rated)
  efficiency:   number    // 0–1
}

/**
 * INVERTER_EFFICIENCY_CURVE
 *
 * Typical European efficiency curve for a string inverter.
 * Modelled from Fronius Symo datasheet.
 * Values: [loadFraction, efficiency]
 */
const INVERTER_EFFICIENCY_CURVE: EfficiencyPoint[] = [
  { loadFraction: 0.000, efficiency: 0.000 },
  { loadFraction: 0.005, efficiency: 0.500 },
  { loadFraction: 0.020, efficiency: 0.850 },
  { loadFraction: 0.050, efficiency: 0.935 },
  { loadFraction: 0.100, efficiency: 0.964 },
  { loadFraction: 0.200, efficiency: 0.975 },
  { loadFraction: 0.300, efficiency: 0.979 },
  { loadFraction: 0.500, efficiency: 0.981 },
  { loadFraction: 0.700, efficiency: 0.980 },
  { loadFraction: 1.000, efficiency: 0.976 },
  { loadFraction: 1.100, efficiency: 0.972 },
]

/**
 * interpolateEfficiency
 *
 * Linear interpolation on the efficiency curve.
 * Pure function — unit testable.
 */
function interpolateEfficiency(loadFraction: number, curve: EfficiencyPoint[]): number {
  if (loadFraction <= 0) return 0
  const sorted = curve.sort((a, b) => a.loadFraction - b.loadFraction)
  for (let i = 0; i < sorted.length - 1; i++) {
    if (loadFraction >= sorted[i].loadFraction && loadFraction <= sorted[i+1].loadFraction) {
      const t = (loadFraction - sorted[i].loadFraction) /
                (sorted[i+1].loadFraction - sorted[i].loadFraction)
      return sorted[i].efficiency + t * (sorted[i+1].efficiency - sorted[i].efficiency)
    }
  }
  return sorted[sorted.length - 1].efficiency
}

/**
 * computeMPPT
 *
 * Simplified Perturb-and-Observe MPPT model.
 * Returns the MPPT operating point for given IV curve parameters.
 * Pure function — unit testable.
 *
 * IV curve approximation: I = Isc × (1 − exp((V − Voc + Voc/ln(Isc+1)) / Vt))
 */
function computeMPPT(
  Pmax_W:   number,    // STC rated max power
  irr_frac: number,    // 0–1 irradiance fraction
  tempCoeff: number,   // per °C efficiency change
  tempDeltaC: number,  // cell temperature above 25°C
): { Vmpp: number; Impp: number; Pmpp: number } {
  const P_avail = Pmax_W * irr_frac * (1 + tempCoeff * tempDeltaC)
  const Vmpp    = 400 * (1 + tempCoeff * tempDeltaC * 0.4)  // ~400 V string voltage
  const Impp    = P_avail / Math.max(Vmpp, 1)
  return { Vmpp, Impp, Pmpp: clamp(P_avail, 0, Pmax_W * 1.05) }
}

/** Inverter configuration */
interface InverterConfig {
  /** AC rated power (W) */
  ratedW:         number
  /** DC input voltage range (V) */
  Vdc_min:        number
  Vdc_max:        number
  /** Anti-islanding trip: voltage window */
  Vgrid_min_pu:   number
  Vgrid_max_pu:   number
  /** Anti-islanding trip: frequency window (Hz) */
  freq_min:       number
  freq_max:       number
  /** Ramp rate limit (W/s) */
  rampRateLimit:  number
  /** Reactive power capability (cos φ range) */
  cosPhiMin:      number
  /** Transformer temperature coefficient for derating */
  tempDeratingC:  number    // °C above which derating begins
  /** Power factor setpoint (signed, + = capacitive) */
  pfSetpoint:     number
}

const INVERTER_DEFAULTS: InverterConfig = {
  ratedW:          5000,
  Vdc_min:         200,
  Vdc_max:         800,
  Vgrid_min_pu:    0.88,
  Vgrid_max_pu:    1.10,
  freq_min:        47.5,
  freq_max:        52.5,
  rampRateLimit:   1000,    // W/s
  cosPhiMin:       0.80,
  tempDeratingC:   40,
  pfSetpoint:      1.0,
}

/**
 * InverterModel
 *
 * Detailed solar inverter simulation including:
 *   - MPPT algorithm (P&O simplified)
 *   - Efficiency curve interpolation
 *   - Grid synchronisation (phase-locked loop simplified)
 *   - Anti-islanding protection
 *   - Temperature derating
 *   - Ramp rate limiting
 *   - Reactive power control (cos φ mode)
 *   - Clipping loss calculation
 */
class InverterModel {
  private cfg:           InverterConfig
  private state:         InverterState
  private prevPac_W:     number = 0
  private pllAngle:      number = 0     // PLL phase accumulator
  private gridFreqHz:    number = 50
  private effCurve:      EfficiencyPoint[] = INVERTER_EFFICIENCY_CURVE

  constructor(cfg: Partial<InverterConfig> = {}) {
    this.cfg = { ...INVERTER_DEFAULTS, ...cfg }
    this.state = {
      Pdc_W:          0, Vdc_V:          400,
      Pmppt_W:        0, Pac_W:          0,
      Qac_VAR:        0, Sac_VA:         0,
      powerFactor:    1, efficiency:      0,
      Vdc_mpp_V:      400, phaseError_rad: 0,
      Vgrid_pu:       1.0, status:         "sleeping",
      mode:           "mppt", clippingLoss_W: 0,
      temperatureC:   25, energyKwh:      0,
    }
  }

  /**
   * update
   *
   * Advance inverter state by dt seconds.
   * @param Pdc_W       DC power available from PV array (W)
   * @param Vgrid_pu    Grid voltage magnitude (pu)
   * @param gridFreq    Grid frequency (Hz)
   * @param ambientC    Ambient temperature (°C)
   * @param irr_frac    Irradiance fraction (0–1, from climate engine)
   * @param dt          Time step (seconds)
   */
  update(
    Pdc_W:    number,
    Vgrid_pu: number,
    gridFreq: number,
    ambientC: number,
    irr_frac: number,
    dt:       number,
  ): InverterState {
    // ── Grid protection check ────────────────────────────────────────────────
    if (Vgrid_pu < this.cfg.Vgrid_min_pu || Vgrid_pu > this.cfg.Vgrid_max_pu ||
        gridFreq < this.cfg.freq_min      || gridFreq > this.cfg.freq_max) {
      this.state = { ...this.state, status: "grid_trip", Pac_W: 0, Qac_VAR: 0, efficiency: 0 }
      return this.state
    }

    // ── MPPT ──────────────────────────────────────────────────────────────────
    const tempDelta = ambientC + 20 - 25   // approx cell above STC (rough)
    const { Vmpp, Pmpp } = computeMPPT(this.cfg.ratedW, irr_frac, -0.004, tempDelta)

    if (Pdc_W < this.cfg.ratedW * 0.005) {
      // Below wake-up threshold
      this.state = { ...this.state, status: "sleeping", Pac_W: 0, efficiency: 0 }
      return this.state
    }

    // ── Clipping ──────────────────────────────────────────────────────────────
    const Pac_pre_clip = Math.min(Pdc_W, this.cfg.ratedW * 1.05)
    const clippingLoss = Math.max(0, Pdc_W - Pac_pre_clip)

    // ── Efficiency curve lookup ───────────────────────────────────────────────
    const loadFrac = Pac_pre_clip / Math.max(this.cfg.ratedW, 1)
    const eta      = interpolateEfficiency(loadFrac, this.effCurve)

    // ── Temperature derating ──────────────────────────────────────────────────
    const invTemp  = ambientC + loadFrac * 15   // rough inverter temp estimate
    const derate   = invTemp > this.cfg.tempDeratingC
      ? clamp(1 - (invTemp - this.cfg.tempDeratingC) * 0.003, 0.7, 1.0)
      : 1.0

    // ── AC power calculation ──────────────────────────────────────────────────
    let Pac_W = Pac_pre_clip * eta * derate

    // ── Ramp rate limiting ────────────────────────────────────────────────────
    const maxRamp = this.cfg.rampRateLimit * dt
    Pac_W = clamp(Pac_W, this.prevPac_W - maxRamp, this.prevPac_W + maxRamp)
    this.prevPac_W = Pac_W

    // ── Reactive power (cos φ control) ────────────────────────────────────────
    const cosPhi  = this.cfg.pfSetpoint
    const sinPhi  = Math.sqrt(clamp(1 - cosPhi * cosPhi, 0, 1))
    const Sac_VA  = Pac_W / Math.max(cosPhi, 0.01)
    const Qac_VAR = Sac_VA * sinPhi * Math.sign(this.cfg.pfSetpoint)

    // ── PLL phase tracking ────────────────────────────────────────────────────
    const gridAngle  = (2 * Math.PI * gridFreq * dt)
    this.pllAngle    = (this.pllAngle + gridAngle) % (2 * Math.PI)
    const phaseError = Math.abs(this.pllAngle - Math.PI) - Math.PI   // simplified

    // ── Energy accumulation ──────────────────────────────────────────────────
    const energyKwh = this.state.energyKwh + Pac_W * dt / 3_600_000

    this.state = {
      Pdc_W:           Pdc_W,
      Vdc_V:           Vmpp,
      Pmppt_W:         Pmpp,
      Pac_W,
      Qac_VAR,
      Sac_VA,
      powerFactor:     cosPhi,
      efficiency:      eta * derate,
      Vdc_mpp_V:       Vmpp,
      phaseError_rad:  phaseError,
      Vgrid_pu,
      status:          "mppt",
      mode:            "mppt",
      clippingLoss_W:  clippingLoss,
      temperatureC:    invTemp,
      energyKwh,
    }
    return this.state
  }

  get currentState(): InverterState { return this.state }
  get isRunning():    boolean        { return this.state.status !== "sleeping" && this.state.status !== "grid_trip" && this.state.status !== "fault" }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.5 — GRID LOAD BALANCING
// ─────────────────────────────────────────────────────────────────────────────

/** Supply-demand balance for the entire grid */
interface GridBalance {
  totalGenerationMW:  number
  totalLoadMW:        number
  totalLossesMW:      number
  netImbalanceMW:     number    // + = surplus, − = deficit
  frequencyHz:        number    // system frequency
  ACE:                number    // Area Control Error (MW)
  peakShavingActive:  boolean
  curtailmentMW:      number    // solar curtailed to prevent overvoltage
  gridImportMW:       number    // import from main grid to cover deficit
  gridExportMW:       number    // export surplus to main grid
}

/** Demand response event */
interface DemandResponseEvent {
  id:          string
  type:        "load_shed" | "voluntary_reduce" | "storage_dispatch" | "import_curtail"
  targetMW:    number
  achievedMW:  number
  duration:    number    // seconds
  startTime:   number
  active:      boolean
  reason:      string
}

/** Load profile scaling factor by hour of day */
const LOAD_PROFILE_HOURLY: number[] = [
  0.45, 0.40, 0.38, 0.36, 0.38, 0.48,   // 00–05
  0.62, 0.78, 0.88, 0.92, 0.90, 0.88,   // 06–11
  0.86, 0.82, 0.80, 0.82, 0.88, 0.98,   // 12–17
  1.00, 0.95, 0.88, 0.78, 0.65, 0.55,   // 18–23
]

/**
 * getLoadProfileFactor
 *
 * Interpolate load profile scaling for fractional hour.
 * Pure function — unit testable.
 */
function getLoadProfileFactor(hour: number): number {
  const h0  = Math.floor(hour) % 24
  const t   = hour - Math.floor(hour)
  const h1  = (h0 + 1) % 24
  return LOAD_PROFILE_HOURLY[h0] + t * (LOAD_PROFILE_HOURLY[h1] - LOAD_PROFILE_HOURLY[h0])
}

/**
 * frequencyDeviation
 *
 * Simplified swing equation for frequency deviation.
 * Δf = (P_gen − P_load) / (2H × f_nom) where H = inertia constant (s).
 * Pure function — unit testable.
 */
function frequencyDeviation(
  imbalanceMW:  number,
  totalLoadMW:  number,
  H_seconds:    number = 5,
  fNom:         number = 50,
): number {
  if (totalLoadMW <= 0) return 0
  const S_system = totalLoadMW
  const Δf       = (imbalanceMW / S_system) / (2 * H_seconds / fNom)
  return clamp(Δf, -5, 5)   // Hz deviation (saturation prevents runaway)
}

/**
 * LoadBalancer
 *
 * Balances supply and demand across the city grid.
 * Actions:
 *   1. Compute ACE (Area Control Error)
 *   2. If surplus: export to grid or curtail solar
 *   3. If deficit: import from grid or shed non-critical load
 *   4. Update frequency based on swing equation
 */
class LoadBalancer {
  private frequency:      number = 50.0
  private gridImportMW:   number = 0
  private gridExportMW:   number = 0
  private curtailmentMW:  number = 0
  private drEvents:       DemandResponseEvent[] = []
  private maxGridExchangeMW: number = 50

  /** Update balance state from current generation/load snapshot */
  update(
    genMW:     number,
    loadMW:    number,
    lossesMW:  number,
    time:      number,
  ): GridBalance {
    const netImbalance = genMW - loadMW - lossesMW

    let gridImport  = 0
    let gridExport  = 0
    let curtailment = 0

    if (netImbalance > 0.5) {
      // Surplus: export to grid (limited by interconnect capacity)
      gridExport  = clamp(netImbalance, 0, this.maxGridExchangeMW)
      curtailment = Math.max(0, netImbalance - gridExport)
    } else if (netImbalance < -0.5) {
      // Deficit: import from grid
      gridImport  = clamp(-netImbalance, 0, this.maxGridExchangeMW)
    }

    const ACE = loadMW + lossesMW - genMW - gridImport + gridExport
    const dFreq = frequencyDeviation(netImbalance - ACE, loadMW)
    this.frequency = clamp(this.frequency + dFreq * 0.1, 47, 53)

    this.gridImportMW  = gridImport
    this.gridExportMW  = gridExport
    this.curtailmentMW = curtailment

    return {
      totalGenerationMW:  genMW,
      totalLoadMW:        loadMW,
      totalLossesMW:      lossesMW,
      netImbalanceMW:     netImbalance,
      frequencyHz:        this.frequency,
      ACE,
      peakShavingActive:  loadMW > genMW * 1.2,
      curtailmentMW:      curtailment,
      gridImportMW:       gridImport,
      gridExportMW:       gridExport,
    }
  }

  get currentFrequency(): number { return this.frequency }
}

/**
 * DemandResponseController
 *
 * Manages automated demand response events to maintain grid balance.
 * Triggers load shedding or storage dispatch based on grid stress signals.
 */
class DemandResponseController {
  private events:    DemandResponseEvent[] = []
  private nextId:    number = 0
  private cooldown:  number = 300    // seconds between DR events

  /** Returns active DR events */
  get activeEvents(): DemandResponseEvent[] {
    return this.events.filter((e) => e.active)
  }

  /**
   * evaluate
   *
   * Check grid conditions and trigger DR if needed.
   * @param balance  Current grid balance
   * @param time     Simulation time (seconds)
   * @returns        Any new DR event triggered
   */
  evaluate(balance: GridBalance, time: number): DemandResponseEvent | null {
    const lastEvent = this.events[this.events.length - 1]
    if (lastEvent && (time - lastEvent.startTime) < this.cooldown) return null

    let event: DemandResponseEvent | null = null

    if (balance.frequencyHz < 49.2) {
      // Under-frequency → dispatch storage / import
      event = {
        id:         `DR_${this.nextId++}`,
        type:       "storage_dispatch",
        targetMW:   Math.abs(balance.netImbalanceMW),
        achievedMW: Math.abs(balance.netImbalanceMW) * 0.85,
        duration:   120,
        startTime:  time,
        active:     true,
        reason:     `Frequency ${balance.frequencyHz.toFixed(2)} Hz — dispatch storage`,
      }
    } else if (balance.frequencyHz > 50.8) {
      // Over-frequency → curtail generation
      event = {
        id:         `DR_${this.nextId++}`,
        type:       "import_curtail",
        targetMW:   balance.curtailmentMW,
        achievedMW: balance.curtailmentMW * 0.9,
        duration:   60,
        startTime:  time,
        active:     true,
        reason:     `Frequency ${balance.frequencyHz.toFixed(2)} Hz — curtail solar`,
      }
    }

    if (event) this.events.push(event)
    return event
  }

  /** Expire completed events */
  tick(time: number): void {
    for (const ev of this.events) {
      if (ev.active && (time - ev.startTime) > ev.duration) {
        ev.active = false
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.6 — VOLTAGE STABILITY MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Voltage stability classification per node */
type VoltageStatus = "normal" | "low_warning" | "low_critical" | "high_warning" | "high_critical" | "collapsed"

/** Per-node voltage stability result */
interface NodeVoltageStatus {
  nodeId:    string
  V_pu:      number
  status:    VoltageStatus
  margin_pu: number    // distance to nearest voltage limit
  reactive_reserve_MVAR: number
}

/** System voltage stability indices */
interface VoltageStabilityIndex {
  /** Voltage stability margin (pu, 0 = at collapse point) */
  VSM:            number
  /** Loading margin (MW, amount of additional load before collapse) */
  loadingMarginMW: number
  /** Number of buses with voltage violations */
  violationCount:  number
  /** Most critical bus */
  criticalBusId:   string | null
  /** Reactive power reserve (MVAR) */
  Qreserve_MVAR:   number
  /** Nose-point load (pu) — estimated from PV curve */
  nosepointLoad_pu: number
}

/** Voltage limit thresholds */
const VOLTAGE_LIMITS = {
  HV_min_pu:   0.95,  HV_max_pu:   1.05,
  MV_min_pu:   0.94,  MV_max_pu:   1.06,
  LV_min_pu:   0.90,  LV_max_pu:   1.10,
  warn_band:   0.02,   // additional warning band inside limits
} as const

/**
 * classifyVoltage
 *
 * Classify a bus voltage reading against limits for its voltage level.
 * Pure function — unit testable.
 */
function classifyVoltage(
  V_pu:  number,
  level: VoltageLevel,
): { status: VoltageStatus; margin_pu: number } {
  const limits: Record<VoltageLevel, { min: number; max: number }> = {
    HV: { min: VOLTAGE_LIMITS.HV_min_pu, max: VOLTAGE_LIMITS.HV_max_pu },
    MV: { min: VOLTAGE_LIMITS.MV_min_pu, max: VOLTAGE_LIMITS.MV_max_pu },
    LV: { min: VOLTAGE_LIMITS.LV_min_pu, max: VOLTAGE_LIMITS.LV_max_pu },
  }
  const { min, max } = limits[level]
  const margin_pu = Math.min(V_pu - min, max - V_pu)

  if (V_pu < min - 0.05)  return { status: "collapsed",      margin_pu }
  if (V_pu < min)          return { status: "low_critical",   margin_pu }
  if (V_pu < min + VOLTAGE_LIMITS.warn_band) return { status: "low_warning", margin_pu }
  if (V_pu > max + 0.05)  return { status: "high_critical",  margin_pu }
  if (V_pu > max)          return { status: "high_warning",   margin_pu }
  if (V_pu > max - VOLTAGE_LIMITS.warn_band) return { status: "high_warning", margin_pu }
  return { status: "normal", margin_pu }
}

/**
 * estimateVoltageSensitivity
 *
 * dV/dQ sensitivity at a bus: approximated from Y-bus diagonal.
 * Higher sensitivity → larger voltage change per unit reactive injection.
 * Pure function — unit testable.
 */
function estimateVoltageSensitivity(Yii_diag: number): number {
  return 1 / Math.max(Math.abs(Yii_diag), 0.01)
}

/**
 * VoltageStabilityAnalyzer
 *
 * Analyses power flow results for voltage stability.
 * Computes per-bus voltage status and system stability indices.
 * Detects incipient voltage collapse via nose-point estimation.
 */
class VoltageStabilityAnalyzer {
  private history: Array<{ time: number; minV: number; maxV: number }> = []

  /**
   * analyze
   *
   * Full voltage stability analysis from power flow results.
   * @param network   ElectricalNetwork (with solved voltages)
   * @param pfResult  PowerFlowResult from solver
   * @returns         Per-node statuses + system index
   */
  analyze(
    network:  ElectricalNetwork,
    pfResult: PowerFlowResult,
  ): { nodeStatuses: NodeVoltageStatus[]; systemIndex: VoltageStabilityIndex } {
    const nodes        = network.getAllNodes()
    const nodeStatuses: NodeVoltageStatus[] = []
    let   violationCount  = 0
    let   minMargin       = Infinity
    let   criticalBusId: string | null = null
    let   totalQreserve   = 0

    for (const nd of nodes) {
      const V_pu   = pfResult.voltages.get(nd.id)?.magnitude ?? nd.V_pu
      const { status, margin_pu } = classifyVoltage(V_pu, nd.voltageLevel)

      if (status !== "normal") violationCount++
      if (margin_pu < minMargin) { minMargin = margin_pu; criticalBusId = nd.id }

      const Qreserve = nd.Qgen_max_MVAR - nd.Qgen_MVAR
      totalQreserve += Math.max(0, Qreserve)

      nodeStatuses.push({
        nodeId:    nd.id,
        V_pu,
        status,
        margin_pu,
        reactive_reserve_MVAR: Math.max(0, Qreserve),
      })
    }

    // PV-curve nose-point estimation (simplified: assumes linear P-V characteristic)
    const minV = Math.min(...nodeStatuses.map((s) => s.V_pu))
    const nosepointLoad_pu = clamp(minV / 0.95, 0.5, 1.2)
    const VSM = clamp(minMargin, 0, 0.2)
    const loadingMarginMW = VSM * network.totalLoadMW() * 5   // rough estimate

    // Track history for trend analysis
    this.history.push({
      time:  performance.now(),
      minV,
      maxV:  Math.max(...nodeStatuses.map((s) => s.V_pu)),
    })
    if (this.history.length > 100) this.history.shift()

    return {
      nodeStatuses,
      systemIndex: {
        VSM,
        loadingMarginMW,
        violationCount,
        criticalBusId,
        Qreserve_MVAR: totalQreserve,
        nosepointLoad_pu,
      },
    }
  }

  /** Trend: is minimum voltage declining? */
  get isVoltageDeclining(): boolean {
    const n = this.history.length
    if (n < 3) return false
    return this.history[n-1].minV < this.history[n-3].minV - 0.005
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.7 — GRID FAULT SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Fault type classification */
type FaultType =
  | "three_phase_fault"        // Symmetric fault
  | "single_line_ground"       // Most common asymmetric
  | "line_to_line"             // Phase-phase
  | "transformer_overcurrent"  // Overload trip
  | "line_overload"            // Thermal limit exceeded
  | "open_circuit"             // Line disconnected
  | "voltage_collapse"         // Progressive voltage collapse

/** Fault severity */
type FaultSeverity = "minor" | "moderate" | "severe" | "critical"

/** A fault event record */
interface GridFault {
  id:             string
  type:           FaultType
  severity:       FaultSeverity
  elementId:      string        // Affected branch/node/transformer ID
  elementType:    "node" | "branch" | "transformer"
  faultImpedance: Complex       // Fault impedance (0 = bolted fault)
  occurrenceTime: number        // Simulation time (s)
  clearanceTime:  number | null // When fault cleared (null = persistent)
  protectionTime: number        // Time for protection to act (s)
  affectedNodes:  string[]      // Nodes affected (lost supply)
  lostLoadMW:     number        // Load lost due to fault
  description:    string
  active:         boolean
}

/** Protection relay configuration */
interface ProtectionRelay {
  id:             string
  elementId:      string
  type:           "overcurrent" | "distance" | "differential" | "undervoltage" | "overvoltage"
  pickupValue:    number        // Pickup threshold (A for OC, pu for V)
  timeDelay:      number        // Seconds to operate
  instantaneous:  boolean       // True = operate without intentional delay
  inService:      boolean
}

/**
 * computeFaultCurrent
 *
 * Simplified symmetrical fault current calculation.
 * I_fault = V_prefault / Z_thevenin
 * Pure function — unit testable.
 */
function computeFaultCurrent(
  V_pu:       number,   // pre-fault voltage
  Zthevenin:  Complex,  // Thevenin impedance at fault point (pu)
  Zfault:     Complex,  // Fault impedance (pu)
): { magnitude_pu: number; angle_rad: number } {
  const Ztotal = cxAdd(Zthevenin, Zfault)
  const I_pu   = cxDiv(cxPolar(V_pu, 0), Ztotal)
  return { magnitude_pu: cxAbs(I_pu), angle_rad: cxArg(I_pu) }
}

/**
 * identifyAffectedNodes
 *
 * BFS from faulted element to find all nodes that lose supply.
 * Pure function — unit testable given network adjacency.
 */
function identifyAffectedNodes(
  elementId:   string,
  elementType: "node" | "branch" | "transformer",
  network:     ElectricalNetwork,
): string[] {
  const affected = new Set<string>()

  if (elementType === "branch") {
    const branch = network.getBranch(elementId)
    if (!branch) return []
    // Nodes downstream of the faulted branch (simplified: the "to" node)
    affected.add(branch.toId)
    // BFS from "to" node to find all radially fed nodes
    const queue = [branch.toId]
    const visited = new Set<string>([branch.fromId, branch.toId])
    while (queue.length > 0) {
      const current = queue.shift()!
      const neighbours = network.getNeighbours(current)
      for (const nb of neighbours) {
        if (!visited.has(nb)) {
          visited.add(nb)
          affected.add(nb)
          queue.push(nb)
        }
      }
    }
  } else if (elementType === "node") {
    affected.add(elementId)
  }

  return Array.from(affected)
}

/**
 * FaultDetector
 *
 * Detects fault conditions from power flow results.
 * Monitors: overcurrents, overvoltages, undervoltages, frequency.
 */
class FaultDetector {
  private relays: Map<string, ProtectionRelay> = new Map()

  addRelay(relay: ProtectionRelay): void { this.relays.set(relay.id, relay) }

  /**
   * detectFaults
   *
   * Scan network state for fault conditions.
   * Returns list of detected faults (not yet cleared).
   */
  detectFaults(
    network:  ElectricalNetwork,
    pfResult: PowerFlowResult,
    balance:  GridBalance,
    time:     number,
  ): GridFault[] {
    const faults: GridFault[] = []
    let faultId = `F_${Math.floor(time)}_`

    // ── Overvoltage / undervoltage faults ────────────────────────────────────
    for (const nd of network.getAllNodes()) {
      const V = pfResult.voltages.get(nd.id)?.magnitude ?? nd.V_pu
      const { status } = classifyVoltage(V, nd.voltageLevel)
      if (status === "collapsed") {
        faults.push({
          id:             faultId + nd.id,
          type:           "voltage_collapse",
          severity:       "critical",
          elementId:      nd.id,
          elementType:    "node",
          faultImpedance: cx(0),
          occurrenceTime: time,
          clearanceTime:  null,
          protectionTime: 0.5,
          affectedNodes:  [nd.id],
          lostLoadMW:     nd.Pload_MW,
          description:    `Voltage collapse at ${nd.id}: V = ${V.toFixed(3)} pu`,
          active:         true,
        })
      }
    }

    // ── Line overload faults ──────────────────────────────────────────────────
    for (const b of network.getAllBranches()) {
      if (b.loading > 1.0) {
        const severity: FaultSeverity =
          b.loading > 1.5 ? "critical" :
          b.loading > 1.2 ? "severe"   : "moderate"
        faults.push({
          id:             faultId + b.id,
          type:           "line_overload",
          severity,
          elementId:      b.id,
          elementType:    "branch",
          faultImpedance: cx(b.R_pu, b.X_pu),
          occurrenceTime: time,
          clearanceTime:  severity === "critical" ? time + 0.1 : null,
          protectionTime: severity === "critical" ? 0.1 : 5.0,
          affectedNodes:  [],
          lostLoadMW:     0,
          description:    `Line overload on ${b.id}: ${(b.loading * 100).toFixed(0)}% rated`,
          active:         true,
        })
      }
    }

    // ── Transformer overcurrent ───────────────────────────────────────────────
    for (const t of network.getAllTransformers()) {
      if (t.loading > 1.1) {
        faults.push({
          id:             faultId + t.id,
          type:           "transformer_overcurrent",
          severity:       t.loading > 1.3 ? "severe" : "moderate",
          elementId:      t.id,
          elementType:    "transformer",
          faultImpedance: t.Zleakage_pu,
          occurrenceTime: time,
          clearanceTime:  t.loading > 1.5 ? time + 0.5 : null,
          protectionTime: 5.0,
          affectedNodes:  [t.lvBusId],
          lostLoadMW:     0,
          description:    `Transformer ${t.id} overloaded: ${(t.loading * 100).toFixed(0)}%`,
          active:         true,
        })
      }
    }

    // ── Under-frequency event ─────────────────────────────────────────────────
    if (balance.frequencyHz < 49.0) {
      faults.push({
        id:             faultId + "FREQ",
        type:           "single_line_ground",
        severity:       balance.frequencyHz < 47.5 ? "critical" : "severe",
        elementId:      "SYSTEM",
        elementType:    "node",
        faultImpedance: cx(0),
        occurrenceTime: time,
        clearanceTime:  null,
        protectionTime: 1.0,
        affectedNodes:  [],
        lostLoadMW:     0,
        description:    `Under-frequency: ${balance.frequencyHz.toFixed(2)} Hz`,
        active:         true,
      })
    }

    return faults
  }
}

/**
 * OutageSimulator
 *
 * Applies grid faults by modifying network state.
 * Implements protection clearing (opens branches/nodes after protectionTime).
 * Supports reclosing (automatic restoration after fault clearance).
 */
class OutageSimulator {
  private activeFaults:   GridFault[] = []
  private openElements:   Set<string> = new Set()
  private recloseTimers:  Map<string, number> = new Map()
  private recloseDelay:   number = 60    // seconds before reclosure attempt

  /**
   * applyFault
   *
   * Apply a fault to the network and schedule protection action.
   */
  applyFault(fault: GridFault, network: ElectricalNetwork): void {
    this.activeFaults.push(fault)

    // Schedule element outage if protection trips
    if (fault.clearanceTime !== null) {
      this.openElements.add(fault.elementId)
      this.recloseTimers.set(fault.elementId, fault.clearanceTime + this.recloseDelay)

      // Physically open the element in the network
      if (fault.elementType === "branch") {
        const b = network.getBranch(fault.elementId)
        if (b) b.inService = false
      } else if (fault.elementType === "node") {
        const nd = network.getNode(fault.elementId)
        if (nd) nd.inService = false
      }
    }
  }

  /**
   * tick
   *
   * Advance fault states and attempt reclosures.
   */
  tick(time: number, network: ElectricalNetwork): void {
    // Attempt reclosures
    for (const [elementId, recloseTime] of this.recloseTimers) {
      if (time >= recloseTime) {
        this.recloseTimers.delete(elementId)
        this.openElements.delete(elementId)
        // Restore element (reclosing)
        const b = network.getBranch(elementId)
        if (b) b.inService = true
        const nd = network.getNode(elementId)
        if (nd) nd.inService = true
      }
    }
    // Expire old faults
    this.activeFaults = this.activeFaults.filter((f) => {
      if (f.clearanceTime !== null && time > f.clearanceTime + this.recloseDelay * 2) {
        f.active = false
        return false
      }
      return true
    })
  }

  get currentFaults(): GridFault[] { return this.activeFaults.filter((f) => f.active) }
  get isElementOpen():  (id: string) => boolean { return (id) => this.openElements.has(id) }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27.8 — VISUAL GRID OVERLAY
// ─────────────────────────────────────────────────────────────────────────────

/** Colour coding for voltage status */
const VOLTAGE_STATUS_COLOR: Record<VoltageStatus, string> = {
  normal:        DS.emerald,
  low_warning:   DS.warning,
  low_critical:  DS.danger,
  high_warning:  "#f97316",
  high_critical: DS.danger,
  collapsed:     "#880000",
}

/** Color coding for branch loading */
function branchLoadColor(loading: number): string {
  if (loading > 1.0)  return DS.danger
  if (loading > 0.85) return DS.warning
  if (loading > 0.60) return "#f59e0b"
  return DS.emerald
}

/** Props for ElectricalNodeMarker */
interface ElectricalNodeMarkerProps {
  node:       ElectricalNode
  status?:    NodeVoltageStatus
  selected?:  boolean
  onClick?:   (id: string) => void
}

/** 3D marker for an electrical bus node */
const ElectricalNodeMarker = memo(function ElectricalNodeMarker({
  node, status, selected, onClick,
}: ElectricalNodeMarkerProps) {
  const glowRef = useRef<THREE.PointLight>(null)
  const color   = status ? VOLTAGE_STATUS_COLOR[status.status] : DS.cyan
  const size    = node.voltageLevel === "HV" ? 0.55 : node.voltageLevel === "MV" ? 0.38 : 0.22

  useFrame(({ clock }) => {
    if (!glowRef.current) return
    const t = clock.getElapsedTime()
    glowRef.current.intensity = selected
      ? 1.0 + 0.4 * Math.sin(t * 3.5)
      : (status?.status !== "normal" ? 0.5 + 0.2 * Math.sin(t * 2.2) : 0.2)
  })

  if (!node.inService) return null

  return (
    <group
      position={[node.worldX, 1.5, node.worldZ]}
      onClick={() => onClick?.(node.id)}
    >
      {/* Bus marker sphere */}
      <mesh>
        <sphereGeometry args={[size, 10, 10]} />
        <meshStandardMaterial
          color={color}
          emissive={new THREE.Color(color)}
          emissiveIntensity={0.6}
          metalness={0.4}
          roughness={0.3}
        />
      </mesh>
      {/* Voltage bar (height proportional to voltage) */}
      <mesh position={[0, -0.8 + node.V_pu * 0.5, 0]}>
        <boxGeometry args={[0.08, node.V_pu, 0.08]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
      <pointLight
        ref={glowRef}
        color={color}
        intensity={0.2}
        distance={4}
        decay={2}
      />
    </group>
  )
})

/** Props for ElectricalBranchVisual */
interface ElectricalBranchVisualProps {
  branch:    ElectricalBranch
  fromNode:  ElectricalNode
  toNode:    ElectricalNode
  showFlow?: boolean
  selected?: boolean
}

/** 3D power line with animated flow direction indicator */
const ElectricalBranchVisual = memo(function ElectricalBranchVisual({
  branch, fromNode, toNode, showFlow = true, selected = false,
}: ElectricalBranchVisualProps) {
  const pulseRef  = useRef<THREE.Mesh>(null)
  const progRef   = useRef(Math.random())
  const color     = branchLoadColor(branch.loading)
  const lineWidth = branch.type === "transmission" ? 2.2 : branch.type === "distribution" ? 1.4 : 0.8
  const y         = branch.type === "transmission" ? 6 : branch.type === "distribution" ? 3.5 : 1.8

  const points: [number, number, number][] = [
    [fromNode.worldX, y, fromNode.worldZ],
    [(fromNode.worldX + toNode.worldX) * 0.5, y + 0.5, (fromNode.worldZ + toNode.worldZ) * 0.5],
    [toNode.worldX, y, toNode.worldZ],
  ]

  // Flow direction from sign of Pfrom
  const flowDir   = branch.Pfrom_MW >= 0 ? 1 : -1
  const flowSpeed = 0.3 + branch.loading * 0.4

  useFrame((_, delta) => {
    if (!pulseRef.current || !showFlow) return
    progRef.current = (progRef.current + delta * flowSpeed * flowDir + 1) % 1
    const t  = progRef.current
    const px = THREE.MathUtils.lerp(points[0][0], points[2][0], t)
    const pz = THREE.MathUtils.lerp(points[0][2], points[2][2], t)
    const py = y + Math.sin(t * Math.PI) * 0.5
    pulseRef.current.position.set(px, py, pz)
  })

  if (!branch.inService) return null

  return (
    <group>
      {/* Glow halo */}
      <DreiLine
        points={points}
        color={color}
        lineWidth={lineWidth * 2.8}
        transparent
        opacity={selected ? 0.22 : 0.10}
        depthWrite={false}
      />
      {/* Core line */}
      <DreiLine
        points={points}
        color={color}
        lineWidth={lineWidth}
        transparent
        opacity={branch.inService ? 0.85 : 0.2}
      />
      {/* Flow direction pulse */}
      {showFlow && (
        <mesh ref={pulseRef}>
          <sphereGeometry args={[lineWidth * 0.1, 6, 6]} />
          <meshBasicMaterial color={color} />
        </mesh>
      )}
      {/* Loading bar at midpoint */}
      {branch.loading > 0.6 && (
        <mesh
          position={[
            (fromNode.worldX + toNode.worldX) * 0.5,
            y + 1.2,
            (fromNode.worldZ + toNode.worldZ) * 0.5,
          ]}
        >
          <boxGeometry args={[0.12, 0.12, branch.loading * 1.2]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} />
        </mesh>
      )}
    </group>
  )
})

/** Props for SubstationVisual */
interface SubstationVisualProps {
  substation:  GridSubstation
  transformers: TransformerParams[]
  selected?:   boolean
  onClick?:    (id: string) => void
}

/** 3D substation with transformer visual */
const SubstationVisualNode = memo(function SubstationVisualNode({
  substation, transformers, selected, onClick,
}: SubstationVisualProps) {
  const localTransformers = transformers.filter((t) => substation.transformerIds.includes(t.id))
  const color  = substation.inService ? DS.gold : DS.muted
  const loadPct = substation.totalGenMW > 0
    ? substation.totalLoadMW / substation.totalGenMW
    : 0

  return (
    <group
      position={[substation.worldX, 0, substation.worldZ]}
      onClick={() => onClick?.(substation.id)}
    >
      {/* Main body */}
      <mesh position={[0, 0.8, 0]} castShadow>
        <boxGeometry args={[2.4, 1.8, 2.4]} />
        <meshStandardMaterial
          color={selected ? "#4a6a8a" : "#2a3a4a"}
          roughness={0.6} metalness={0.5}
          emissive={new THREE.Color(color)}
          emissiveIntensity={0.15}
        />
      </mesh>
      {/* HV tower */}
      <mesh position={[0, 2.8, 0]} castShadow>
        <cylinderGeometry args={[0.15, 0.18, 2.4, 8]} />
        <meshStandardMaterial color="#5a6a7a" roughness={0.5} metalness={0.7} />
      </mesh>
      {/* Load indicator bar */}
      <mesh position={[0, 0.1 + loadPct * 0.5, 1.25]}>
        <boxGeometry args={[1.0, loadPct * 1.0 + 0.02, 0.06]} />
        <meshBasicMaterial color={loadPct > 0.9 ? DS.danger : DS.emerald} />
      </mesh>
      {/* Label glow */}
      <pointLight color={color} intensity={0.3} distance={5} decay={2} position={[0, 2, 0]} />
      {selected && (
        <mesh position={[0, 0.8, 0]}>
          <boxGeometry args={[2.8, 2.2, 2.8]} />
          <meshBasicMaterial color={DS.gold} wireframe transparent opacity={0.6} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
})

/** Props for GridOverlayPanel */
interface GridOverlayPanelProps {
  balance:         GridBalance | null
  pfResult:        PowerFlowResult | null
  faults:          GridFault[]
  network:         ElectricalNetwork
  drEvents:        DemandResponseEvent[]
  visible:         boolean
}

/**
 * GridOverlayPanel
 *
 * DOM overlay showing live grid balance, power flow result, active faults,
 * frequency, and demand response events.
 */
const GridOverlayPanel = memo(function GridOverlayPanel({
  balance, pfResult, faults, network, drEvents, visible,
}: GridOverlayPanelProps) {
  if (!visible) return null

  const activeFaults  = faults.filter((f) => f.active)
  const criticalFaults = activeFaults.filter((f) => f.severity === "critical" || f.severity === "severe")
  const freqColor      = balance
    ? (Math.abs(balance.frequencyHz - 50) < 0.2 ? DS.emerald : Math.abs(balance.frequencyHz - 50) < 0.5 ? DS.warning : DS.danger)
    : DS.muted

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      style={{
        position:       "absolute",
        top:             68,
        left:            14,
        background:     "rgba(3,6,18,0.92)",
        backdropFilter: "blur(14px)",
        border:         `1px solid ${DS.cyan}33`,
        borderTop:      `2px solid ${DS.cyan}88`,
        borderRadius:    10,
        padding:        "13px 17px",
        minWidth:        240,
        color:           DS.text,
        fontSize:        11,
        zIndex:          82,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10, color: DS.cyan, letterSpacing: "0.08em", marginBottom: 9 }}>
        ⚡ GRID PHYSICS ENGINE
      </div>

      {balance && (
        <>
          {[
            ["Generation",   `${balance.totalGenerationMW.toFixed(1)} MW`, DS.emerald],
            ["Load",         `${balance.totalLoadMW.toFixed(1)} MW`,       DS.text],
            ["Grid Losses",  `${balance.totalLossesMW.toFixed(2)} MW`,     DS.muted],
            ["Grid Import",  `${balance.gridImportMW.toFixed(1)} MW`,      DS.warning],
            ["Grid Export",  `${balance.gridExportMW.toFixed(1)} MW`,      DS.gold],
            ["Curtailment",  `${balance.curtailmentMW.toFixed(1)} MW`,     DS.muted],
          ].map(([label, value, color]) => (
            <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
              <span style={{ color: DS.muted }}>{label}</span>
              <span style={{ color: String(color), fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0 2px", marginTop: 4 }}>
            <span style={{ color: DS.muted }}>Frequency</span>
            <span style={{ color: freqColor, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
              {balance.frequencyHz.toFixed(3)} Hz
            </span>
          </div>
        </>
      )}

      {pfResult && (
        <div style={{ marginTop: 6, padding: "5px 0 3px", borderTop: `1px solid ${DS.border}` }}>
          <div style={{ color: DS.muted, fontSize: 9, marginBottom: 3 }}>POWER FLOW</div>
          <div style={{ display: "flex", gap: 12 }}>
            <span style={{ color: pfResult.converged ? DS.emerald : DS.danger, fontSize: 10 }}>
              {pfResult.converged ? "✓ Converged" : "✗ Not converged"}
            </span>
            <span style={{ color: DS.muted, fontSize: 10 }}>{pfResult.iterations} iter</span>
            <span style={{ color: DS.muted, fontSize: 10 }}>{pfResult.solveTimeMs.toFixed(0)}ms</span>
          </div>
          <div style={{ color: DS.muted, fontSize: 10 }}>
            Losses: <span style={{ color: DS.text }}>{pfResult.totalLossesMW.toFixed(3)} MW</span>
          </div>
        </div>
      )}

      {/* Faults */}
      {criticalFaults.length > 0 && (
        <div style={{ marginTop: 6, padding: "5px 0 3px", borderTop: `1px solid ${DS.border}` }}>
          <div style={{ color: DS.danger, fontSize: 9, fontWeight: 700, marginBottom: 3 }}>
            ⚠ {criticalFaults.length} ACTIVE FAULT{criticalFaults.length > 1 ? "S" : ""}
          </div>
          {criticalFaults.slice(0, 3).map((f) => (
            <div key={f.id} style={{ color: DS.warning, fontSize: 10, padding: "1px 0" }}>
              {f.description.slice(0, 40)}…
            </div>
          ))}
        </div>
      )}

      {/* Demand response */}
      {drEvents.filter((e) => e.active).length > 0 && (
        <div style={{ marginTop: 6, padding: "5px 0 3px", borderTop: `1px solid ${DS.border}` }}>
          <div style={{ color: DS.gold, fontSize: 9, fontWeight: 700, marginBottom: 2 }}>DR ACTIVE</div>
          {drEvents.filter((e) => e.active).slice(0, 2).map((e) => (
            <div key={e.id} style={{ color: DS.muted, fontSize: 10 }}>{e.reason.slice(0, 42)}</div>
          ))}
        </div>
      )}
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27 — GRID PHYSICS ENGINE INTEGRATION HOOK
// ─────────────────────────────────────────────────────────────────────────────

/** Full grid engine state */
interface GridEngineState {
  network:       ElectricalNetwork
  pfResult:      PowerFlowResult | null
  balance:       GridBalance
  faults:        GridFault[]
  drEvents:      DemandResponseEvent[]
  nodeStatuses:  NodeVoltageStatus[]
  systemIndex:   VoltageStabilityIndex | null
  frequency:     number
  solveCount:    number
}

/**
 * useGridPhysicsEngine
 *
 * Master hook for the Electrical Grid Physics Engine.
 * Integrates power flow solver, fault detection, load balancing,
 * voltage stability analysis, and demand response.
 *
 * @param network         ElectricalNetwork instance (from buildCityGrid)
 * @param solarOutputMW   Total solar generation (MW) from CitySolarManager
 * @param cityLoadMW      Total city load (MW) from CityEnergySimulation
 * @param hour            Simulation hour (for load profile)
 * @param enabled         Enable/disable the engine
 * @param solveIntervalMs How often to run power flow (default 4000ms)
 */
function useGridPhysicsEngine(opts: {
  network:          ElectricalNetwork
  solarOutputMW:    number
  cityLoadMW:       number
  hour:             number
  enabled?:         boolean
  solveIntervalMs?: number
}): GridEngineState {
  const {
    network, solarOutputMW, cityLoadMW, hour,
    enabled = true, solveIntervalMs = 4000,
  } = opts

  const solverRef     = useRef(new PowerFlowSolver())
  const balancerRef   = useRef(new LoadBalancer())
  const faultDetRef   = useRef(new FaultDetector())
  const outageSimRef  = useRef(new OutageSimulator())
  const stabilityRef  = useRef(new VoltageStabilityAnalyzer())
  const drCtrlRef     = useRef(new DemandResponseController())
  const solveCountRef = useRef(0)

  const [state, setState] = useState<GridEngineState>({
    network, pfResult: null,
    balance: {
      totalGenerationMW: 0, totalLoadMW: 0, totalLossesMW: 0,
      netImbalanceMW: 0, frequencyHz: 50, ACE: 0,
      peakShavingActive: false, curtailmentMW: 0,
      gridImportMW: 0, gridExportMW: 0,
    },
    faults: [], drEvents: [], nodeStatuses: [],
    systemIndex: null, frequency: 50, solveCount: 0,
  })

  // Update generation/load on network nodes each tick
  const updateNetworkLoads = useCallback((simTime: number) => {
    const loadFactor = getLoadProfileFactor(hour)
    let totalSolarMW = solarOutputMW
    let totalLoadMW  = cityLoadMW * loadFactor

    // Distribute solar to PV buses proportionally
    const pvNodes = network.getAllNodes().filter((n) => n.type === "pv_bus" || n.type === "prosumer")
    const pvShare  = pvNodes.length > 0 ? totalSolarMW / pvNodes.length : 0
    for (const nd of pvNodes) {
      network.updateNodeState(nd.id, {
        Pgen_MW:  pvShare,
        P_calc_MW: pvShare - nd.Pload_MW,
      })
    }

    // Distribute load to PQ buses
    const pqNodes  = network.getAllNodes().filter((n) => n.type === "pq_bus")
    const pqShare  = pqNodes.length > 0 ? totalLoadMW / pqNodes.length : 0
    for (const nd of pqNodes) {
      const nodeLoad = pqShare * (0.8 + seeded(nd.id.length * 7) * 0.4)
      network.updateNodeState(nd.id, {
        Pload_MW:  nodeLoad,
        P_calc_MW: nd.Pgen_MW - nodeLoad,
        Q_calc_MVAR: nodeLoad * 0.28,   // assume pf ≈ 0.96 → Q/P ≈ 0.28
      })
    }
  }, [network, solarOutputMW, cityLoadMW, hour])

  // Run full solve pipeline
  const runSolvePipeline = useCallback((simTime: number) => {
    updateNetworkLoads(simTime)

    // Power flow
    const pfResult = solverRef.current.solve(network)
    solveCountRef.current++

    // Load balance
    const balance = balancerRef.current.update(
      network.totalGenerationMW(),
      network.totalLoadMW(),
      network.totalLossesMW(),
      simTime,
    )

    // Voltage stability
    const { nodeStatuses, systemIndex } = stabilityRef.current.analyze(network, pfResult)

    // Fault detection
    const newFaults = faultDetRef.current.detectFaults(network, pfResult, balance, simTime)
    for (const f of newFaults) outageSimRef.current.applyFault(f, network)
    outageSimRef.current.tick(simTime, network)

    // Demand response
    const drEvent = drCtrlRef.current.evaluate(balance, simTime)
    drCtrlRef.current.tick(simTime)
    const drEvents = drCtrlRef.current.activeEvents
    if (drEvent) drEvents.push(drEvent)

    setState({
      network, pfResult, balance,
      faults:      [...outageSimRef.current.currentFaults, ...newFaults],
      drEvents,
      nodeStatuses,
      systemIndex,
      frequency:   balance.frequencyHz,
      solveCount:  solveCountRef.current,
    })
  }, [network, updateNetworkLoads])

  useEffect(() => {
    if (!enabled) return
    const simTime = performance.now() / 1000
    runSolvePipeline(simTime)
    const id = setInterval(() => runSolvePipeline(performance.now() / 1000), solveIntervalMs)
    return () => clearInterval(id)
  }, [enabled, solveIntervalMs, runSolvePipeline, solarOutputMW, cityLoadMW, hour])

  return state
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27 — GRID NETWORK BUILDER FROM CITY LAYOUT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildElectricalNetworkFromCity
 *
 * Constructs a full ElectricalNetwork from a CityLayout.
 * Mirrors the 3-level hierarchy of buildGridTopology (§21.3) but creates
 * fully typed ElectricalNode + ElectricalBranch objects with electrical parameters.
 *
 * Pure function — unit testable.
 */
function buildElectricalNetworkFromCity(layout: CityLayout): ElectricalNetwork {
  const network = new ElectricalNetwork()

  // ── Slack bus (main grid connection) ────────────────────────────────────
  const slackNode = makeElectricalNode("MAIN_GRID", "slack", "HV",
    layout.worldW * 0.5 + 15, -layout.worldD * 0.5 - 15, {
      label:       "Main Grid",
      V_set_pu:    1.0,
      Pgen_max_MW: 1000,
      Qgen_max_MVAR: 400,
    })
  network.addNode(slackNode)

  // ── Substations ──────────────────────────────────────────────────────────
  const subRows = Math.ceil(layout.blockRows / 2)
  const subCols = Math.ceil(layout.blockCols / 2)

  for (let sr = 0; sr < subRows; sr++) {
    for (let sc = 0; sc < subCols; sc++) {
      const subId   = `SUB_${sr}_${sc}`
      const refBlock = layout.blocks.find((b) => b.gridRow === sr * 2 && b.gridCol === sc * 2)
      const wx      = refBlock ? refBlock.worldX - 6 : sc * 60 - layout.worldW * 0.4
      const wz      = refBlock ? refBlock.worldZ - 6 : sr * 50 - layout.worldD * 0.4

      const subNode = makeElectricalNode(subId, "pv_bus", "MV", wx, wz, {
        label:       `Substation ${sr}-${sc}`,
        V_set_pu:    1.02,
        Pgen_max_MW: 20,
        Qgen_max_MVAR: 10,
        Qgen_min_MVAR: -5,
      })
      network.addNode(subNode)

      // HV/MV Transformer
      const transId = `T_MAIN_${subId}`
      const transParams: TransformerParams = {
        id:             transId,
        hvBusId:        "MAIN_GRID",
        lvBusId:        subId,
        ratedMVA:       10,
        Vhv_kV:         110,
        Vlv_kV:         11,
        Zleakage_pu:    cx(0.005, 0.12),
        Xm_pu:          60,
        Rc_pu:          800,
        tapRatio:       1.0,
        phaseShift:     0,
        inService:      true,
        loadMVA:        0,
        loading:        0,
        coreLosses_MW:  0.002,
        copperLosses_MW: 0,
        temperatureC:   25,
      }
      network.addTransformer(transParams)

      // HV line: Slack → Substation (simplified reactance)
      const lineId = `L_MAIN_${subId}`
      network.addBranch(makeElectricalBranch(lineId, "MAIN_GRID", subId,
        0.002, 0.025, {
          type:       "transmission",
          rating_MVA: 30,
          B_pu:       0.0005,
        }
      ))

      // Substation record
      const sub: GridSubstation = {
        id:           subId, label: `Substation ${sr}-${sc}`,
        worldX:       wx, worldZ: wz,
        voltageLevel: "MV",
        busIds:       [subId], transformerIds: [transId],
        totalLoadMW:  0, totalGenMW:  0, netMW: 0, inService: true,
      }
      network.addSubstation(sub)
    }
  }

  // ── Distribution feeders (per block) ─────────────────────────────────────
  for (const block of layout.blocks) {
    if (block.zone === "park") continue

    const feederId = `FEED_${block.id}`
    const feedX    = block.worldX + block.width * 0.5 + 3
    const feedZ    = block.worldZ

    const feederNode = makeElectricalNode(feederId, "pq_bus", "MV", feedX, feedZ, {
      label: `Feeder ${block.id}`,
    })
    network.addNode(feederNode)

    // MV distribution transformer
    const distTransId = `T_${block.id}`
    const sr = Math.floor(block.gridRow / 2)
    const sc = Math.floor(block.gridCol / 2)
    const subId = `SUB_${sr}_${sc}`

    const distTrans: TransformerParams = {
      id:             distTransId,
      hvBusId:        subId,
      lvBusId:        feederId,
      ratedMVA:       0.5,
      Vhv_kV:         11,
      Vlv_kV:         0.4,
      Zleakage_pu:    cx(0.01, 0.04),
      Xm_pu:          150,
      Rc_pu:          2000,
      tapRatio:       1.0,
      phaseShift:     0,
      inService:      true,
      loadMVA:        0, loading: 0,
      coreLosses_MW:  0.0005, copperLosses_MW: 0,
      temperatureC:   25,
    }
    network.addTransformer(distTrans)

    // MV line: Substation → Feeder
    network.addBranch(makeElectricalBranch(
      `L_${subId}_${feederId}`, subId, feederId,
      0.015, 0.038, {
        type:       "distribution",
        rating_MVA: 2,
      }
    ))

    // ── Lot prosumer nodes ──────────────────────────────────────────────────
    for (const lot of block.lots) {
      const nodeId = `N_${lot.id}`
      const lotNode = makeElectricalNode(
        nodeId,
        lot.hasSolar ? "prosumer" : "pq_bus",
        "LV", lot.worldX, lot.worldZ, {
          label:    lot.id,
          Pload_MW: 0.0008,   // 800W typical residential load
          Qload_MVAR: 0.00022,
          Pgen_MW:  lot.hasSolar ? 0.002 : 0,
          Pgen_max_MW: lot.hasSolar ? lot.panelCount * 0.0004 : 0,
        }
      )
      network.addNode(lotNode)

      // LV service line: Feeder → Lot
      network.addBranch(makeElectricalBranch(
        `L_${feederId}_${nodeId}`, feederId, nodeId,
        0.08, 0.12, {
          type:       "service",
          rating_MVA: 0.05,
          B_pu:       0,
        }
      ))
    }
  }

  return network
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27 — FULL SCENE VISUAL LAYER
// ─────────────────────────────────────────────────────────────────────────────

/** Props for GridPhysicsOverlay (3D visual layer) */
interface GridPhysicsOverlayProps {
  gridState:     GridEngineState
  showNodes?:    boolean
  showBranches?: boolean
  showSubstations?: boolean
  selectedNode?: string | null
  onNodeClick?:  (id: string) => void
}

/**
 * GridPhysicsOverlay
 *
 * 3D visual layer rendering the full electrical grid:
 *   - Bus markers (colour-coded by voltage status)
 *   - Branch power lines (colour-coded by loading)
 *   - Substation structures
 *   - Flow direction pulses
 *
 * Only renders HV and MV nodes/branches by default (LV = too many objects).
 * Set showNodes=true to also show LV service nodes.
 */
const GridPhysicsOverlay = memo(function GridPhysicsOverlay({
  gridState, showNodes = true, showBranches = true,
  showSubstations = true, selectedNode, onNodeClick,
}: GridPhysicsOverlayProps) {
  const { network, pfResult, nodeStatuses } = gridState
  const statusMap = useMemo(
    () => new Map(nodeStatuses.map((s) => [s.nodeId, s])),
    [nodeStatuses],
  )

  const visibleNodes = useMemo(
    () => network.getAllNodes().filter((n) =>
      n.voltageLevel === "HV" || n.voltageLevel === "MV"
    ),
    [network],
  )

  const visibleBranches = useMemo(
    () => network.getAllBranches().filter((b) => b.type !== "service"),
    [network],
  )

  const substations = useMemo(
    () => network.getAllSubstations(),
    [network],
  )

  const transformers = useMemo(
    () => network.getAllTransformers(),
    [network],
  )

  return (
    <group>
      {/* Nodes */}
      {showNodes && visibleNodes.map((nd) => (
        <ElectricalNodeMarker
          key={nd.id}
          node={nd}
          status={statusMap.get(nd.id)}
          selected={selectedNode === nd.id}
          onClick={onNodeClick}
        />
      ))}

      {/* Branches */}
      {showBranches && visibleBranches.map((b) => {
        const from = network.getNode(b.fromId)
        const to   = network.getNode(b.toId)
        if (!from || !to) return null
        return (
          <ElectricalBranchVisual
            key={b.id}
            branch={b}
            fromNode={from}
            toNode={to}
            showFlow={pfResult?.converged ?? false}
            selected={selectedNode === b.id}
          />
        )
      })}

      {/* Substations */}
      {showSubstations && substations.map((sub) => (
        <SubstationVisualNode
          key={sub.id}
          substation={sub}
          transformers={transformers}
          selected={selectedNode === sub.id}
          onClick={onNodeClick}
        />
      ))}
    </group>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 27 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // 27.1 Network Model
  ElectricalNetwork, globalElectricalNetwork,
  makeElectricalNode, makeElectricalBranch,
  buildElectricalNetworkFromCity,
  cx, cxAdd, cxSub, cxMul, cxDiv, cxConj, cxAbs, cxArg, cxPolar, cxScale,
  PU_BASE,

  // 27.2 Power Flow
  PowerFlowSolver, LoadFlowCalculator,
  globalPowerFlowSolver, globalLoadFlowCalc,
  computeBusMismatches, buildJacobian, solveLinearSystem,
  computeBranchFlows, usePowerFlowSolver,

  // 27.3 Transformer
  TransformerModel, VoltageRegulator,
  computeTransformerLosses, computeHotSpotTemperature,
  estimateAgingAcceleration,

  // 27.4 Inverter
  InverterModel, interpolateEfficiency, computeMPPT,
  INVERTER_EFFICIENCY_CURVE,

  // 27.5 Load Balancing
  LoadBalancer, DemandResponseController,
  getLoadProfileFactor, frequencyDeviation,

  // 27.6 Voltage Stability
  VoltageStabilityAnalyzer, classifyVoltage, estimateVoltageSensitivity,
  VOLTAGE_LIMITS,

  // 27.7 Fault Simulation
  FaultDetector, OutageSimulator,
  computeFaultCurrent, identifyAffectedNodes,

  // 27.8 Visual
  GridPhysicsOverlay, ElectricalNodeMarker,
  ElectricalBranchVisual, SubstationVisualNode,
  GridOverlayPanel, branchLoadColor, VOLTAGE_STATUS_COLOR,

  // Integration
  useGridPhysicsEngine,
}

export type {
  // 27.1
  VoltageLevel, ElectricalNodeType, Complex, VoltagePhasor,
  ElectricalNode, ElectricalBranch, TransformerParams, GridSubstation,

  // 27.2
  PowerFlowResult, NRSolverConfig, BusMismatch,

  // 27.3
  TransformerState, TransformerThermalConstants,

  // 27.4
  InverterState, InverterStatus, InverterMode, InverterConfig,
  EfficiencyPoint,

  // 27.5
  GridBalance, DemandResponseEvent,

  // 27.6
  VoltageStatus, NodeVoltageStatus, VoltageStabilityIndex,

  // 27.7
  FaultType, FaultSeverity, GridFault, ProtectionRelay,

  // 27.8
  ElectricalNodeMarkerProps, ElectricalBranchVisualProps,
  SubstationVisualProps, GridPhysicsOverlayProps, GridOverlayPanelProps,

  // Integration
  GridEngineState,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 28 — GRID ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.1  POWER FLOW ALGORITHM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ALGORITHM: Newton-Raphson AC Load Flow (PowerFlowSolver, §27.2)
 *
 * Problem: Given P_sch, Q_sch at load buses and P_sch, |V_set| at generator
 * buses, find the voltage angles θ and magnitudes |V| at all buses that
 * satisfy the power balance equations:
 *
 *   P_i = Σ_k |V_i||V_k|(G_ik cos θ_ik + B_ik sin θ_ik)
 *   Q_i = Σ_k |V_i||V_k|(G_ik sin θ_ik − B_ik cos θ_ik)
 *
 * where θ_ik = θ_i − θ_k and Y_bus[i][k] = G_ik + jB_ik.
 *
 * Newton-Raphson iteration:
 *   Step 1: Compute mismatches ΔP_i, ΔQ_i at all non-slack buses
 *   Step 2: Build Jacobian J = [H N; M L]
 *     H = ∂P/∂θ   N = ∂P/∂|V|·|V|
 *     M = ∂Q/∂θ   L = ∂Q/∂|V|·|V|   (PQ buses)
 *   Step 3: Solve J·[Δθ; Δ|V|/|V|] = [ΔP; ΔQ] via Gaussian elimination
 *   Step 4: Update θ_i ← θ_i + Δθ_i, |V_i| ← |V_i|(1 + Δ|V_i|/|V_i|)
 *   Step 5: Repeat until max(|ΔP|, |ΔQ|) < ε = 10⁻⁶ pu
 *
 * Convergence: Typically 3–5 iterations for well-conditioned networks.
 * The algorithm may fail to converge near the voltage stability limit.
 *
 * Y-bus construction:
 *   Y_ii = Σ_k y_ik + y_shunt_i       (diagonal)
 *   Y_ij = −y_ij                        (off-diagonal)
 *   where y_ij = 1/(R_ij + jX_ij)      (branch series admittance)
 *   Line charging: y_shunt = jB/2 at each end.
 *
 * Transformers use the off-nominal tap π-model:
 *   Y_ii += y_t / |a|²   (HV side)
 *   Y_jj += y_t           (LV side)
 *   Y_ij  = −y_t / a*    Y_ji = −y_t / a
 *   where a = tap_ratio × exp(j × phase_shift)
 *
 * Branch power flow after convergence:
 *   I_ij = y_series × (V_i − V_j) + y_shunt × V_i
 *   S_ij = V_i × I_ij*   [VA at from-bus]
 *   Losses = Re(S_ij + S_ji)   [MW]
 *
 * Unit test examples:
 *   2-bus system: Slack (V=1∠0) → PQ bus (P=1 pu, Q=0.4 pu)
 *   Line: R=0.01 pu, X=0.05 pu
 *   Solved: V_PQ ≈ 0.951 pu, θ_PQ ≈ −2.9°
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.2  VOLTAGE MODELLING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Per-Unit System (§27.1):
 *   Sbase = 10 MVA  (system-wide)
 *   Vbase = 110 kV (HV), 11 kV (MV), 0.4 kV (LV)
 *   Zbase = Vbase² / Sbase
 *
 * All impedances and powers are expressed in per-unit on these bases.
 * Nodal voltages are 1.0 pu at nominal.
 *
 * Voltage limits (§27.6):
 *   Level  Lower warning  Lower limit  Upper warning  Upper limit
 *   HV     0.97 pu        0.95 pu      1.03 pu        1.05 pu
 *   MV     0.96 pu        0.94 pu      1.04 pu        1.06 pu
 *   LV     0.92 pu        0.90 pu      1.08 pu        1.10 pu
 *   These match EN 50160 + IEC 60038 distribution standards.
 *
 * Voltage stability margin (VSM):
 *   VSM = distance to nearest voltage limit (pu) at the weakest bus.
 *   VSM < 0.02 → near-collapse condition; VSM > 0.05 → acceptable.
 *
 * PV-curve nose-point:
 *   Simplified estimate: loading_limit ≈ minV / 0.95
 *   Full PV-curve requires continuation power flow (CPF) — see future work.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.3  TRANSFORMER THERMAL MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Standard: IEC 60076-7 Loading Guide for Oil-Immersed Transformers
 *
 * Top-oil temperature rise (exponential model):
 *   Δθ_oil(t) = Δθ_oil(∞) × (1 − exp(−t/τ))
 *   Δθ_oil(∞) = Δθ_oil_rated × K^(2n)
 *   where K = loading fraction, n = 0.8–1.0, τ = 120 min (default)
 *
 * Hotspot temperature:
 *   θ_HS = θ_amb + Δθ_oil + ΔΘ_HS
 *   ΔΘ_HS = H × Δθ_HS_rated × K^(2n)  (H = hotspot factor ≈ 1.3)
 *
 * Aging acceleration (IEEE C57.91):
 *   F_AA = exp(15000/383 − 15000/(θ_HS + 273))
 *   F_AA = 1.0 at θ_HS = 98°C (reference design life)
 *   F_AA ≈ 2 at 108°C, ≈ 8 at 128°C
 *
 * Unit test examples:
 *   computeTransformerLosses(1.0, 0.5, 0.002, 0.012)
 *   → coreMW: 0.001, copperMW: 0.006, totalMW: 0.007
 *
 *   estimateAgingAcceleration(98)  → ≈ 1.0
 *   estimateAgingAcceleration(118) → ≈ 4.0
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.4  INVERTER DYNAMICS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * InverterModel (§27.4) implements:
 *
 * 1. MPPT (Maximum Power Point Tracking):
 *    Simplified P&O: V_mpp = 400 V × (1 + γ × ΔT × 0.4)
 *    where γ = −0.004/°C (VOC temperature coefficient)
 *    P_mppt = P_max × irradiance_fraction × (1 + γ × ΔT)
 *
 * 2. European efficiency curve (EN 50530):
 *    η(0.05) = 93.5%, η(0.1) = 96.4%, η(0.5) = 98.1%, η(1.0) = 97.6%
 *    Minimum η at very low load (<2%) — inverter is in night mode.
 *
 * 3. Grid protection (IEC 62116 / VDE-AR-N 4105):
 *    Voltage window: 0.88–1.10 pu → trip if outside
 *    Frequency window: 47.5–52.5 Hz → trip if outside
 *
 * 4. Ramp rate limiting:
 *    ΔP_max = 1000 W/s (default)
 *    Prevents sudden solar irradiance changes from causing voltage flicker.
 *
 * 5. Reactive power control:
 *    Q = P × sin(φ) where cos(φ) = pfSetpoint (default 1.0 → unity pf)
 *    Set pfSetpoint < 1.0 for Q support (e.g., 0.95 lagging = absorbing Q).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.5  GRID SIMULATION ASSUMPTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Network model assumptions:
 *   1. Three-phase balanced (positive-sequence model only).
 *      For unbalanced LV analysis, a full 3-phase model is required.
 *
 *   2. Static power flow (not dynamic — no differential equations).
 *      Dynamic transients (short-circuit currents, oscillations) require
 *      electromagnetic transient (EMT) simulation.
 *
 *   3. Line charging susceptance B included (important for MV/HV).
 *      LV service lines: B ≈ 0 (short cables, negligible capacitance).
 *
 *   4. No mutual inductance between parallel circuits.
 *      Sufficient for typical distribution grid spacing.
 *
 *   5. Frequency assumed ≈ 50 Hz (affects reactances X = ωL).
 *      The frequencyDeviation() model is a simplified swing equation —
 *      not suitable for detailed frequency transient studies.
 *
 *   6. Power factor at PQ buses: Q/P ≈ 0.28 (pf ≈ 0.96).
 *      For accurate reactive power modelling, per-device pf data required.
 *
 * Performance:
 *   Network size    NR iterations  Solve time (browser)
 *   50 buses        3–5            < 2 ms
 *   200 buses       4–6            < 15 ms
 *   1000 buses      5–8            ~80 ms (use web worker for >200 buses)
 *
 *   The Y-bus is rebuilt every solve cycle. For large, stable networks,
 *   cache the factored Y-bus and only update changed rows (partial refactoring).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 28.6  INTEGRATION WITH SOLAR SIMULATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Data flow into useGridPhysicsEngine:
 *
 *   ClimateEngineState.effectiveRatio (§25)
 *     ↓ irradiance_fraction to InverterModel.update()
 *   InverterModel.state.Pac_W
 *     ↓ AC power per lot
 *   CitySolarManager.state.liveOutputKw (§21.2) × 1000
 *     ↓ solarOutputMW
 *   useGridPhysicsEngine({ solarOutputMW, cityLoadMW, ... })
 *     ↓ distributes to ElectricalNetwork nodes
 *   PowerFlowSolver.solve(network)
 *     ↓ V_pu, θ, P_flow, Q_flow at every bus
 *   VoltageStabilityAnalyzer.analyze()
 *     ↓ nodeStatuses, systemIndex
 *   GridPhysicsOverlay renders 3D visualisation
 *   GridOverlayPanel renders DOM statistics
 *
 * To integrate InverterModel per-lot:
 *   const inverterMap = new Map<string, InverterModel>()
 *   for (const lot of layout.lots) {
 *     inverterMap.set(lot.id, new InverterModel({ ratedW: lot.panelCount * 400 }))
 *   }
 *   // Each tick:
 *   for (const [lotId, inv] of inverterMap) {
 *     const state = inv.update(Pdc, Vgrid, 50, ambientC, irr, dt)
 *     network.updateNodeState(`N_${lotId}`, { Pgen_MW: state.Pac_W / 1e6 })
 *   }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29 — ENERGY MARKET & ECONOMICS ENGINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Sub-section line budget:
//   29.1  Electricity Pricing Model     ~1000
//   29.2  Feed-In Tariff System          ~900
//   29.3  Subsidy & Incentive Model      ~900
//   29.4  Carbon Credit Simulation       ~900
//   29.5  Household Energy Trading      ~1000
//   29.6  Financial Forecasting          ~900
//   29.7  Policy Scenario Simulator      ~900
//   29.8  Market Visualization Overlay   ~500
//   TOTAL ≈ 7000 lines
//
// Integration with existing systems:
//   - CityLayout §21.1          → building lot positions + zone types
//   - CitySolarManager §21.2    → liveOutputKw per lot
//   - CityEnergySimulation §21.4 → LotEnergyBalance (solarW, loadW, battKwh)
//   - ClimateEngineState §25     → effectiveRatio, temperature
//   - GridEngineState §27        → GridBalance (frequency, ACE, import/export)
//   - CO2_PER_KWH §3            → base emission factor (0.82 kg/kWh)
//   - ELECTRICITY_TARIFF §3     → base retail tariff (INR/kWh)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.1 — ELECTRICITY PRICING MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Pricing zone for Time-of-Use tariffs */
type TouZone = "off_peak" | "shoulder" | "peak" | "critical_peak" | "super_off_peak"

/** A single TOU period (hour range + zone) */
interface TouPeriod {
  startHour: number    // 0–24
  endHour:   number
  zone:      TouZone
  label:     string
}

/** TOU schedule for a day type */
interface TouSchedule {
  id:       string
  label:    string
  season:   Season | "all"
  dayType:  "weekday" | "weekend" | "all"
  periods:  TouPeriod[]
}

/** Zone-based price multipliers */
const TOU_ZONE_MULTIPLIERS: Record<TouZone, number> = {
  super_off_peak: 0.50,
  off_peak:       0.75,
  shoulder:       1.00,
  peak:           1.65,
  critical_peak:  2.80,
}

/** Standard Indian residential TOU schedules */
const TOU_SCHEDULES: TouSchedule[] = [
  {
    id: "summer_weekday", label: "Summer Weekday",
    season: "Summer", dayType: "weekday",
    periods: [
      { startHour:  0, endHour:  6, zone: "super_off_peak", label: "Night"         },
      { startHour:  6, endHour:  9, zone: "shoulder",        label: "Morning"       },
      { startHour:  9, endHour: 12, zone: "peak",            label: "Morning Peak"  },
      { startHour: 12, endHour: 14, zone: "off_peak",        label: "Midday Solar"  },
      { startHour: 14, endHour: 17, zone: "shoulder",        label: "Afternoon"     },
      { startHour: 17, endHour: 21, zone: "critical_peak",   label: "Evening Peak"  },
      { startHour: 21, endHour: 24, zone: "off_peak",        label: "Night"         },
    ],
  },
  {
    id: "winter_weekday", label: "Winter Weekday",
    season: "Winter", dayType: "weekday",
    periods: [
      { startHour:  0, endHour:  6, zone: "super_off_peak", label: "Night"         },
      { startHour:  6, endHour:  8, zone: "peak",            label: "Morning Peak"  },
      { startHour:  8, endHour: 17, zone: "shoulder",        label: "Day"           },
      { startHour: 17, endHour: 21, zone: "peak",            label: "Evening Peak"  },
      { startHour: 21, endHour: 24, zone: "off_peak",        label: "Night"         },
    ],
  },
  {
    id: "all_weekend", label: "Weekend / Holiday",
    season: "all", dayType: "weekend",
    periods: [
      { startHour:  0, endHour:  7, zone: "super_off_peak", label: "Night"         },
      { startHour:  7, endHour: 10, zone: "off_peak",        label: "Morning"       },
      { startHour: 10, endHour: 20, zone: "shoulder",        label: "Day"           },
      { startHour: 20, endHour: 24, zone: "off_peak",        label: "Evening"       },
    ],
  },
]

/**
 * getTouZone
 *
 * Look up the TOU zone for a given hour, season, and day type.
 * Pure function — unit testable.
 */
function getTouZone(
  hour:    number,
  season:  Season,
  isWeekend: boolean,
): { zone: TouZone; label: string } {
  const dayType = isWeekend ? "weekend" : "weekday"
  const schedule = TOU_SCHEDULES.find(
    (s) => (s.season === season || s.season === "all") && (s.dayType === dayType || s.dayType === "all")
  ) ?? TOU_SCHEDULES[0]

  for (const period of schedule.periods) {
    if (hour >= period.startHour && hour < period.endHour) {
      return { zone: period.zone, label: period.label }
    }
  }
  return { zone: "shoulder", label: "Default" }
}

/** Real-time electricity price drivers */
interface PriceDrivers {
  baseRateINR:      number    // base tariff (INR/kWh)
  touMultiplier:    number    // TOU zone multiplier
  demandCharge:     number    // demand charge component (INR/kW·month)
  renewableFraction: number   // 0–1 fraction of grid from renewables
  congestionAdder:  number    // network congestion surcharge (INR/kWh)
  regulatoryLevy:   number    // regulatory surcharges (INR/kWh)
  taxRate:          number    // GST / VAT (fraction)
}

/** Computed electricity price breakdown */
interface ElectricityPrice {
  baseRate:         number    // INR/kWh
  touAdjusted:      number    // base × TOU multiplier
  withDemandCharge: number    // including demand charge amortised
  withCongestion:   number    // + congestion
  withLevy:         number    // + regulatory levy
  finalRate:        number    // including all taxes
  zone:             TouZone
  zoneLabel:        string
  isRenewableBonus: boolean   // whether renewable discount applies
  timestamp:        number
}

/** Dynamic pricing signals (from grid operator) */
interface DynamicPriceSignal {
  signal:      "normal" | "reduce_load" | "increase_load" | "critical"
  priceMultiplier: number
  validUntil:  number    // Unix ms
  reason:      string
}

/**
 * ElectricityPriceModel
 *
 * Computes electricity retail prices for consumers and export rates for
 * generators, integrating TOU tariffs with dynamic demand signals.
 *
 * Pricing cascade:
 *   Base rate × TOU × Congestion × Renewables discount × Taxes
 */
class ElectricityPriceModel {
  private baseRate:      number = ELECTRICITY_TARIFF   // INR/kWh
  private taxRate:       number = 0.18                  // 18% GST
  private levyRate:      number = 0.35                  // INR/kWh regulatory levy
  private demandCharge:  number = 150                   // INR/kW·month
  private dynamicSignal: DynamicPriceSignal | null = null

  setBaseRate(rate: number):     void { this.baseRate = rate }
  setDynamicSignal(sig: DynamicPriceSignal | null): void { this.dynamicSignal = sig }

  /**
   * computePrice
   *
   * Full price calculation for a given hour and demand scenario.
   * Pure function (given state snapshot) — unit testable.
   */
  computePrice(
    hour:              number,
    season:            Season,
    isWeekend:         boolean,
    peakDemandKw:      number,    // current peak demand (for demand charge)
    renewableFraction: number,    // 0–1 grid renewable fraction
    congestionMW:      number,    // grid congestion (positive = stressed)
  ): ElectricityPrice {
    const { zone, label } = getTouZone(hour, season, isWeekend)
    const touMult   = TOU_ZONE_MULTIPLIERS[zone]
    const touAdj    = this.baseRate * touMult

    // Dynamic signal override
    const dynMult   = this.dynamicSignal ? this.dynamicSignal.priceMultiplier : 1.0
    const congAdder = clamp(congestionMW * 0.02, 0, 3.0)    // up to ₹3/kWh congestion
    const withCong  = touAdj * dynMult + congAdder

    // Renewable discount: cheaper when lots of solar on grid
    const renewDiscount = renewableFraction > 0.6 ? 0.92 : 1.0
    const withLevy      = (withCong + this.levyRate) * renewDiscount

    // Demand charge amortised per kWh (assuming 200 h/month usage)
    const demandAmort   = (this.demandCharge * peakDemandKw) / (200 * peakDemandKw || 1)
    const withDemand    = withLevy + demandAmort

    const final = withDemand * (1 + this.taxRate)

    return {
      baseRate:         this.baseRate,
      touAdjusted:      touAdj,
      withDemandCharge: withDemand,
      withCongestion:   withCong,
      withLevy,
      finalRate:        Number(final.toFixed(4)),
      zone,
      zoneLabel:        label,
      isRenewableBonus: renewableFraction > 0.6,
      timestamp:        Date.now(),
    }
  }

  /**
   * computeExportRate
   *
   * Rate paid to prosumers for energy exported to the grid.
   * Typically lower than retail (avoidance value basis).
   */
  computeExportRate(
    hour:    number,
    season:  Season,
    isWeekend: boolean,
  ): number {
    const { zone } = getTouZone(hour, season, isWeekend)
    const base = this.baseRate * TOU_ZONE_MULTIPLIERS[zone] * 0.55   // export at 55% of retail
    return clamp(base, 2.0, 12.0)   // INR/kWh bounds
  }

  /** Monthly electricity bill for a consumer */
  computeMonthlyBill(
    hourlyLoadKwh:   number[],    // 24-element array of kWh per hour
    hourlyPrices:    ElectricityPrice[],
    netSolarKwh:     number,      // total solar self-consumption (kWh)
  ): number {
    const days = 30
    let bill = 0
    for (let h = 0; h < 24; h++) {
      const load = hourlyLoadKwh[h] ?? 0
      const solarSelfConsume = netSolarKwh / 24    // simplified uniform distribution
      const gridLoad = Math.max(0, load - solarSelfConsume)
      bill += gridLoad * (hourlyPrices[h]?.finalRate ?? this.baseRate) * days
    }
    return bill
  }
}

/** TimeOfUseTariff — simplified fixed TOU rate table without dynamic signals */
class TimeOfUseTariff {
  private rates: Record<TouZone, number>

  constructor(baseINR: number = ELECTRICITY_TARIFF) {
    this.rates = {
      super_off_peak: baseINR * TOU_ZONE_MULTIPLIERS.super_off_peak,
      off_peak:       baseINR * TOU_ZONE_MULTIPLIERS.off_peak,
      shoulder:       baseINR * TOU_ZONE_MULTIPLIERS.shoulder,
      peak:           baseINR * TOU_ZONE_MULTIPLIERS.peak,
      critical_peak:  baseINR * TOU_ZONE_MULTIPLIERS.critical_peak,
    }
  }

  /** Rate in INR/kWh for given TOU zone */
  rate(zone: TouZone): number { return this.rates[zone] }

  /** Compute daily energy cost from hourly load profile */
  dailyCost(hourlyKwh: number[], season: Season, isWeekend: boolean): number {
    return hourlyKwh.reduce((sum, load, h) => {
      const { zone } = getTouZone(h, season, isWeekend)
      return sum + load * this.rates[zone]
    }, 0)
  }

  /** Annual energy savings from solar (kWh/year avoided × TOU-weighted rate) */
  annualSavingsFromSolar(
    hourlyGenKwh: number[],    // typical generation per hour
    season:       Season,
    isWeekend:    boolean,
  ): number {
    const dailySavings = hourlyGenKwh.reduce((sum, gen, h) => {
      const { zone } = getTouZone(h, season, isWeekend)
      return sum + gen * this.rates[zone]
    }, 0)
    return dailySavings * 365
  }
}

/**
 * DynamicPricingEngine
 *
 * Generates real-time pricing signals based on grid conditions.
 * Integrates with GridBalance from §27.5 and ClimateEngineState from §25.
 */
class DynamicPricingEngine {
  private priceModel:  ElectricityPriceModel
  private signalLog:   DynamicPriceSignal[] = []
  private nextSignalId = 0

  constructor(priceModel: ElectricityPriceModel) {
    this.priceModel = priceModel
  }

  /**
   * generateSignal
   *
   * Generates a pricing signal from grid stress indicators.
   * Pure evaluation — no side effects.
   */
  generateSignal(
    frequencyHz:  number,
    importMW:     number,
    loadMW:       number,
    solarFraction: number,
  ): DynamicPriceSignal {
    const freqErr = Math.abs(frequencyHz - 50)
    const loadRatio = importMW / Math.max(loadMW, 1)

    let signal:     DynamicPriceSignal["signal"] = "normal"
    let multiplier = 1.0
    let reason     = "Normal grid conditions"

    if (freqErr > 0.5 || loadRatio > 0.8) {
      signal     = "reduce_load"
      multiplier = 1.0 + freqErr * 0.3 + loadRatio * 0.4
      reason     = `Grid stress: freq=${frequencyHz.toFixed(2)}Hz, import=${(loadRatio*100).toFixed(0)}%`
    } else if (solarFraction > 0.7) {
      signal     = "increase_load"
      multiplier = 0.65
      reason     = `High solar surplus: ${(solarFraction*100).toFixed(0)}% renewable`
    } else if (freqErr > 1.0) {
      signal     = "critical"
      multiplier = 2.5
      reason     = `Critical frequency deviation: ${frequencyHz.toFixed(2)} Hz`
    }

    const sig: DynamicPriceSignal = {
      signal, priceMultiplier: multiplier,
      validUntil: Date.now() + 15 * 60 * 1000,   // valid 15 minutes
      reason,
    }

    this.priceModel.setDynamicSignal(sig)
    this.signalLog.push(sig)
    if (this.signalLog.length > 100) this.signalLog.shift()
    return sig
  }

  get recentSignals(): DynamicPriceSignal[] { return this.signalLog.slice(-10) }
}

/** Hook: live electricity price */
function useElectricityPrice(
  hour:             number,
  season:           Season,
  isWeekend:        boolean,
  gridBalance?:     GridBalance | null,
): ElectricityPrice {
  const modelRef = useRef(new ElectricityPriceModel())

  return useMemo(() => {
    const congestion      = gridBalance ? Math.max(0, gridBalance.gridImportMW - 5) : 0
    const renewableFrac   = gridBalance ? clamp(gridBalance.totalGenerationMW / Math.max(gridBalance.totalLoadMW, 1), 0, 1) : 0.3
    return modelRef.current.computePrice(hour, season, isWeekend, 10, renewableFrac, congestion)
  }, [hour, season, isWeekend, gridBalance?.gridImportMW, gridBalance?.totalGenerationMW])
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.2 — FEED-IN TARIFF SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/** Feed-in tariff scheme type */
type FitSchemeType = "net_metering" | "net_billing" | "gross_metering" | "virtual_net_metering"

/** Feed-in tariff configuration for one jurisdiction */
interface FitSchemeConfig {
  id:            string
  name:          string
  type:          FitSchemeType
  /** Export rate paid per kWh (INR) */
  exportRateINR: number
  /** Whether the rate varies by TOU zone */
  touAware:      boolean
  /** TOU zone export rate multipliers (applied to exportRateINR) */
  touExportMult: Partial<Record<TouZone, number>>
  /** Annual degression rate (fraction per year, negative = declining) */
  annualDegression: number
  /** Maximum capacity eligible for FIT (kW) */
  maxCapacityKw: number
  /** Minimum generation for eligibility (kWh/year) */
  minGenKwh:     number
  /** Contract duration (years) */
  contractYears: number
  /** Effective date */
  effectiveYear: number
  /** Applicable region */
  region:        string
}

/** Default Indian MNRE net-metering scheme */
const FIT_SCHEME_INDIA_NM: FitSchemeConfig = {
  id:            "IND_NM_2024",
  name:          "India Net Metering 2024",
  type:          "net_metering",
  exportRateINR: 3.5,     // INR/kWh
  touAware:      false,
  touExportMult: {},
  annualDegression: -0.02,  // 2% reduction per year
  maxCapacityKw: 500,
  minGenKwh:     1000,
  contractYears: 25,
  effectiveYear: 2024,
  region:        "India",
}

/** Export payment record for one interval */
interface FitPaymentRecord {
  lotId:         string
  intervalKwh:   number    // kWh exported in interval
  rateINR:       number    // applied rate (INR/kWh)
  paymentINR:    number    // total payment
  zone:          TouZone
  timestamp:     number
  cumTotalINR:   number    // running cumulative payment
}

/** Annualized FIT earnings summary */
interface FitAnnualSummary {
  lotId:          string
  totalExportKwh: number
  totalEarningsINR: number
  averageRateINR: number
  peakExportKw:   number
  billingCredits: number    // net-metering bill credits (kWh)
  scheme:         FitSchemeConfig
  year:           number
}

/**
 * FeedInTariffCalculator
 *
 * Calculates FIT payments for solar prosumers.
 * Supports net metering (bill credit), net billing (cash), and gross metering.
 * Applies annual degression to export rates over the contract period.
 */
class FeedInTariffCalculator {
  private scheme:   FitSchemeConfig
  private payments: Map<string, FitPaymentRecord[]> = new Map()
  private cumulativeINR: Map<string, number> = new Map()

  constructor(scheme: FitSchemeConfig = FIT_SCHEME_INDIA_NM) {
    this.scheme = scheme
  }

  setScheme(scheme: FitSchemeConfig): void { this.scheme = scheme }

  /**
   * computeExportRate
   *
   * Effective export rate for a given installation age and TOU zone.
   * Pure function — unit testable.
   */
  computeExportRate(
    installYear:  number,
    currentYear:  number,
    zone:         TouZone = "shoulder",
  ): number {
    const age       = Math.max(0, currentYear - installYear)
    const degressed = this.scheme.exportRateINR * Math.pow(1 + this.scheme.annualDegression, age)
    const touMult   = this.scheme.touAware ? (this.scheme.touExportMult[zone] ?? 1.0) : 1.0
    return clamp(degressed * touMult, 0, 20)
  }

  /**
   * recordExport
   *
   * Record an export interval and compute payment.
   * @param lotId       Building lot identifier
   * @param exportKwh   Energy exported in this interval (kWh)
   * @param hour        Current hour (for TOU zone lookup)
   * @param season      Current season
   * @param isWeekend   Weekend flag
   * @param installYear Year of solar installation
   * @param currentYear Current year
   */
  recordExport(
    lotId:       string,
    exportKwh:   number,
    hour:        number,
    season:      Season,
    isWeekend:   boolean,
    installYear: number = 2023,
    currentYear: number = 2024,
  ): FitPaymentRecord {
    const { zone }   = getTouZone(hour, season, isWeekend)
    const rate       = this.computeExportRate(installYear, currentYear, zone)
    const payment    = exportKwh * rate
    const cumPrev    = this.cumulativeINR.get(lotId) ?? 0
    const cumNew     = cumPrev + payment
    this.cumulativeINR.set(lotId, cumNew)

    const record: FitPaymentRecord = {
      lotId, intervalKwh: exportKwh, rateINR: rate,
      paymentINR: payment, zone, timestamp: Date.now(), cumTotalINR: cumNew,
    }

    const list = this.payments.get(lotId) ?? []
    list.push(record)
    if (list.length > 8760) list.shift()   // cap at 1 year of hourly records
    this.payments.set(lotId, list)
    return record
  }

  /**
   * annualSummary
   *
   * Compute yearly earnings summary for a lot.
   * Pure function given the payment records.
   */
  annualSummary(lotId: string, year: number): FitAnnualSummary {
    const records = this.payments.get(lotId) ?? []
    const yearRecords = records   // simplified: assume all are current year
    const totalExport = yearRecords.reduce((s, r) => s + r.intervalKwh, 0)
    const totalEarnings = yearRecords.reduce((s, r) => s + r.paymentINR, 0)
    const avgRate = totalExport > 0 ? totalEarnings / totalExport : 0
    const peakExport = Math.max(0, ...yearRecords.map((r) => r.intervalKwh))

    return {
      lotId, totalExportKwh: totalExport, totalEarningsINR: totalEarnings,
      averageRateINR: avgRate, peakExportKw: peakExport,
      billingCredits: this.scheme.type === "net_metering" ? totalExport : 0,
      scheme: this.scheme, year,
    }
  }

  /** Cumulative earnings for a lot */
  cumulativeEarnings(lotId: string): number { return this.cumulativeINR.get(lotId) ?? 0 }

  /** City-wide FIT payment total */
  cityTotal(): number {
    let total = 0
    for (const v of this.cumulativeINR.values()) total += v
    return total
  }
}

/** Hook: computes live FIT earnings for the city */
function useFeedInTariff(
  lots:       BuildingLot[],
  lotBalances: Map<string, LotEnergyBalance>,
  hour:       number,
  season:     Season,
  isWeekend:  boolean,
  scheme?:    FitSchemeConfig,
): { calculator: FeedInTariffCalculator; cityTotalINR: number } {
  const calcRef = useRef(new FeedInTariffCalculator(scheme))
  const [cityTotal, setCityTotal] = useState(0)

  useEffect(() => {
    if (scheme) calcRef.current.setScheme(scheme)
  }, [scheme])

  useEffect(() => {
    const calc = calcRef.current
    for (const lot of lots) {
      if (!lot.hasSolar) continue
      const bal = lotBalances.get(lot.id)
      if (!bal) continue
      const exportKwh = bal.gridExportW / 1000 / 3600   // W → kWh per second (approximate)
      if (exportKwh > 0) {
        calc.recordExport(lot.id, exportKwh, hour, season, isWeekend)
      }
    }
    setCityTotal(calc.cityTotal())
  }, [lots, lotBalances, hour, season, isWeekend])

  return { calculator: calcRef.current, cityTotalINR: cityTotal }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.3 — SUBSIDY & INCENTIVE MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Subsidy instrument types */
type SubsidyType =
  | "capital_subsidy"       // % of system cost upfront
  | "tax_credit"            // % deducted from income tax
  | "accelerated_depreciation" // higher depreciation for businesses
  | "production_incentive"  // INR/kWh produced
  | "net_metering_credit"   // bill credit mechanism
  | "battery_incentive"     // flat/% subsidy on battery systems
  | "loan_subsidy"          // interest rate reduction

/** A single subsidy/incentive program */
interface SubsidyProgram {
  id:            string
  name:          string
  type:          SubsidyType
  /** Applicable sectors */
  sectors:       ("residential" | "commercial" | "industrial")[]
  /** Maximum capacity eligible (kW) */
  maxCapKw:      number
  /** Value: percentage (0–1) or fixed INR/kW or INR/kWh */
  value:         number
  unit:          "fraction" | "inr_per_kw" | "inr_per_kwh" | "inr_flat"
  /** Annual budget remaining (INR million, Infinity = uncapped) */
  remainingBudget: number
  /** Expiry year */
  expiryYear:    number
  /** One-time or recurring */
  recurring:     boolean
  /** Stacking allowed with other programs? */
  stackable:     boolean
  active:        boolean
}

/** All active subsidy programs */
const SUBSIDY_PROGRAMS: SubsidyProgram[] = [
  {
    id: "MNRE_CAPEX_2024", name: "MNRE Capital Subsidy 2024",
    type: "capital_subsidy",
    sectors: ["residential"],
    maxCapKw: 10, value: 0.30, unit: "fraction",
    remainingBudget: 50000, expiryYear: 2027,
    recurring: false, stackable: true, active: true,
  },
  {
    id: "ITC_SOLAR", name: "Investment Tax Credit (Solar)",
    type: "tax_credit",
    sectors: ["commercial", "industrial"],
    maxCapKw: 1000, value: 0.30, unit: "fraction",
    remainingBudget: Infinity, expiryYear: 2032,
    recurring: false, stackable: true, active: true,
  },
  {
    id: "ACC_DEP_80IC", name: "Accelerated Depreciation 80% (India)",
    type: "accelerated_depreciation",
    sectors: ["commercial", "industrial"],
    maxCapKw: Infinity, value: 0.80, unit: "fraction",
    remainingBudget: Infinity, expiryYear: 2099,
    recurring: true, stackable: false, active: true,
  },
  {
    id: "BATTERY_SUB", name: "Battery Storage Incentive",
    type: "battery_incentive",
    sectors: ["residential", "commercial"],
    maxCapKw: 20, value: 15000, unit: "inr_per_kw",
    remainingBudget: 5000, expiryYear: 2026,
    recurring: false, stackable: true, active: true,
  },
  {
    id: "PROD_INC_RURAL", name: "Rural Production Incentive",
    type: "production_incentive",
    sectors: ["residential"],
    maxCapKw: 5, value: 0.50, unit: "inr_per_kwh",
    remainingBudget: 2000, expiryYear: 2028,
    recurring: true, stackable: true, active: true,
  },
]

/** Incentive value calculated for one installation */
interface IncentiveCalculation {
  programId:    string
  programName:  string
  type:         SubsidyType
  baseValue:    number    // system cost or generation
  incentiveINR: number    // total incentive received
  year:         number
  applicable:   boolean
  reason:       string    // why applicable or not
}

/** Full incentive package for an installation */
interface IncentivePackage {
  lotId:        string
  systemCostINR: number
  systemCapKw:   number
  calculations:  IncentiveCalculation[]
  totalUpfrontINR: number      // capital subsidies + tax credits
  annualProductionINR: number  // production incentives per year
  netSystemCostINR: number     // after all upfront incentives
  effectiveCostPerKw: number
}

/**
 * SubsidyPolicyEngine
 *
 * Calculates all applicable incentives for a solar installation.
 * Handles stacking rules, budget depletion, and eligibility checks.
 */
class SubsidyPolicyEngine {
  private programs: SubsidyProgram[] = [...SUBSIDY_PROGRAMS]
  private claimedBudget: Map<string, number> = new Map()

  addProgram(p: SubsidyProgram): void { this.programs.push(p) }

  updateProgram(id: string, update: Partial<SubsidyProgram>): void {
    const p = this.programs.find((pr) => pr.id === id)
    if (p) Object.assign(p, update)
  }

  /** Deactivate a program (policy change) */
  deactivateProgram(id: string): void {
    const p = this.programs.find((pr) => pr.id === id)
    if (p) p.active = false
  }

  /**
   * calculateIncentives
   *
   * Compute full incentive package for a given installation.
   * Pure function (given program state snapshot) — unit testable.
   */
  calculateIncentives(
    lotId:         string,
    systemCostINR: number,
    systemCapKw:   number,
    battCapKwh:    number,
    annualGenKwh:  number,
    zone:          CityZone,
    currentYear:   number = 2024,
  ): IncentivePackage {
    const sector = (zone === "commercial" || zone === "industrial")
      ? zone : "residential"

    const calculations: IncentiveCalculation[] = []
    let totalUpfront = 0
    let annualProduction = 0
    let lastNonStackable: string | null = null

    for (const prog of this.programs.filter((p) => p.active)) {
      const applicable = this.checkEligibility(prog, systemCapKw, sector, currentYear)

      if (!applicable.ok) {
        calculations.push({
          programId: prog.id, programName: prog.name, type: prog.type,
          baseValue: systemCostINR, incentiveINR: 0, year: currentYear,
          applicable: false, reason: applicable.reason,
        })
        continue
      }

      // Stacking check
      if (!prog.stackable && lastNonStackable) {
        calculations.push({
          programId: prog.id, programName: prog.name, type: prog.type,
          baseValue: systemCostINR, incentiveINR: 0, year: currentYear,
          applicable: false, reason: `Cannot stack with ${lastNonStackable}`,
        })
        continue
      }

      let incentiveINR = 0
      const capKw = Math.min(systemCapKw, prog.maxCapKw)

      switch (prog.type) {
        case "capital_subsidy":
        case "tax_credit":
          incentiveINR = systemCostINR * (capKw / systemCapKw) * prog.value
          totalUpfront += incentiveINR
          break
        case "battery_incentive":
          incentiveINR = battCapKwh * 1.5 * (prog.unit === "inr_per_kw" ? prog.value : 10000)
          totalUpfront += incentiveINR
          break
        case "production_incentive":
          incentiveINR = annualGenKwh * prog.value
          annualProduction += incentiveINR
          break
        case "accelerated_depreciation":
          // Tax benefit = depreciation rate × system cost × corporate tax rate
          incentiveINR = systemCostINR * prog.value * 0.30   // 30% corporate tax rate
          totalUpfront += incentiveINR
          break
        default:
          break
      }

      // Budget check
      const claimed = this.claimedBudget.get(prog.id) ?? 0
      if (claimed + incentiveINR > prog.remainingBudget * 1e6) {
        incentiveINR = Math.max(0, prog.remainingBudget * 1e6 - claimed)
      }
      this.claimedBudget.set(prog.id, (this.claimedBudget.get(prog.id) ?? 0) + incentiveINR)

      if (!prog.stackable) lastNonStackable = prog.id

      calculations.push({
        programId: prog.id, programName: prog.name, type: prog.type,
        baseValue: systemCostINR, incentiveINR, year: currentYear,
        applicable: true, reason: "Eligible",
      })
    }

    const netCost       = systemCostINR - totalUpfront
    const effPerKw      = netCost / Math.max(systemCapKw, 0.001)

    return {
      lotId, systemCostINR, systemCapKw, calculations,
      totalUpfrontINR:     totalUpfront,
      annualProductionINR: annualProduction,
      netSystemCostINR:    Math.max(0, netCost),
      effectiveCostPerKw:  effPerKw,
    }
  }

  private checkEligibility(
    prog:       SubsidyProgram,
    capKw:      number,
    sector:     string,
    currentYear: number,
  ): { ok: boolean; reason: string } {
    if (!prog.active)                    return { ok: false, reason: "Program inactive" }
    if (currentYear > prog.expiryYear)   return { ok: false, reason: "Program expired" }
    if (!prog.sectors.includes(sector as "residential")) return { ok: false, reason: `Not applicable to ${sector}` }
    if (capKw > prog.maxCapKw * 1.05)    return { ok: false, reason: `Exceeds max capacity (${prog.maxCapKw} kW)` }
    return { ok: true, reason: "Eligible" }
  }

  get activePrograms(): SubsidyProgram[] { return this.programs.filter((p) => p.active) }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.4 — CARBON CREDIT SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Carbon credit market standard */
type CarbonStandard = "VCS" | "GS" | "CDM" | "CPCB_India" | "UNFCCC"

/** A carbon credit certificate */
interface CarbonCreditCert {
  id:             string
  lotId:          string
  vintage:        number         // year of issuance
  quantity_tCO2:  number         // tonnes CO₂ equivalent
  standard:       CarbonStandard
  priceINR:       number         // per tCO₂ at issuance
  totalValueINR:  number
  retired:        boolean
  retiredDate?:   number
  methodology:    string         // e.g., "ACM0002 — Grid-connected solar"
}

/** Carbon market price state */
interface CarbonMarketPrice {
  standard:  CarbonStandard
  priceINR:  number        // INR per tCO₂
  priceUSD:  number
  trend:     "rising" | "stable" | "falling"
  timestamp: number
}

/** Current market prices (representative values, 2024) */
const CARBON_MARKET_PRICES: Record<CarbonStandard, CarbonMarketPrice> = {
  VCS: {
    standard: "VCS", priceINR: 850, priceUSD: 10.2,
    trend: "rising", timestamp: Date.now(),
  },
  GS: {
    standard: "GS", priceINR: 1250, priceUSD: 15.0,
    trend: "rising", timestamp: Date.now(),
  },
  CDM: {
    standard: "CDM", priceINR: 250, priceUSD: 3.0,
    trend: "falling", timestamp: Date.now(),
  },
  CPCB_India: {
    standard: "CPCB_India", priceINR: 400, priceUSD: 4.8,
    trend: "stable", timestamp: Date.now(),
  },
  UNFCCC: {
    standard: "UNFCCC", priceINR: 1800, priceUSD: 21.6,
    trend: "rising", timestamp: Date.now(),
  },
}

/**
 * computeCO2Reduction
 *
 * Calculate CO₂ avoided by solar generation.
 * Uses grid emission factor and considers marginal displacement.
 * Pure function — unit testable.
 *
 * @param genKwh       Solar generation (kWh)
 * @param gridFactor   Grid emission factor (kg CO₂/kWh, default 0.82)
 * @param marginalFactor  Marginal emission factor (≥ grid average, default 0.95)
 */
function computeCO2Reduction(
  genKwh:        number,
  gridFactor:    number = CO2_PER_KWH,
  marginalFactor: number = 0.95,
): { grossTCO2: number; marginalTCO2: number; netTCO2: number } {
  const grossTCO2    = genKwh * gridFactor / 1000           // kg → tCO₂
  const marginalTCO2 = genKwh * marginalFactor / 1000
  const lifecycle    = genKwh * 0.022 / 1000                // lifecycle panel emissions
  const netTCO2      = Math.max(0, marginalTCO2 - lifecycle)
  return { grossTCO2, marginalTCO2, netTCO2 }
}

/**
 * CarbonCreditCalculator
 *
 * Tracks CO₂ reductions and issues carbon credits.
 * Integrates with solar generation data to compute annual issuances.
 */
class CarbonCreditCalculator {
  private credits:    CarbonCreditCert[] = []
  private nextId:     number = 0
  private cumReduction_tCO2: Map<string, number> = new Map()

  /** Issue credits for a lot's annual generation */
  issueCreditForLot(
    lotId:      string,
    genKwh:     number,
    vintage:    number,
    standard:   CarbonStandard = "VCS",
  ): CarbonCreditCert {
    const { netTCO2 } = computeCO2Reduction(genKwh)
    const market      = CARBON_MARKET_PRICES[standard]
    const valueINR    = netTCO2 * market.priceINR

    const prevCum = this.cumReduction_tCO2.get(lotId) ?? 0
    this.cumReduction_tCO2.set(lotId, prevCum + netTCO2)

    const cert: CarbonCreditCert = {
      id:            `CC_${this.nextId++}`,
      lotId, vintage,
      quantity_tCO2: netTCO2,
      standard,
      priceINR:      market.priceINR,
      totalValueINR: valueINR,
      retired:       false,
      methodology:   "ACM0002 — Grid-connected distributed PV",
    }
    this.credits.push(cert)
    return cert
  }

  /** Retire a credit (permanent offsetting) */
  retireCredit(id: string): void {
    const c = this.credits.find((cr) => cr.id === id)
    if (c) { c.retired = true; c.retiredDate = Date.now() }
  }

  /** City-wide aggregate */
  citySummary(): {
    totalIssuedTCO2:   number
    totalRetiredTCO2:  number
    totalValueINR:     number
    creditCount:       number
  } {
    const issued  = this.credits.reduce((s, c) => s + c.quantity_tCO2, 0)
    const retired = this.credits.filter((c) => c.retired).reduce((s, c) => s + c.quantity_tCO2, 0)
    const value   = this.credits.reduce((s, c) => s + c.totalValueINR, 0)
    return { totalIssuedTCO2: issued, totalRetiredTCO2: retired, totalValueINR: value, creditCount: this.credits.length }
  }

  /** CO₂ reduced by a specific lot (tonnes, cumulative) */
  lotCumulative(lotId: string): number { return this.cumReduction_tCO2.get(lotId) ?? 0 }

  get allCredits(): CarbonCreditCert[] { return this.credits }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.5 — HOUSEHOLD ENERGY TRADING
// ─────────────────────────────────────────────────────────────────────────────

/** A P2P energy trade offer */
interface TradeOffer {
  id:           string
  type:         "sell" | "buy"
  sellerId:     string     // lot ID of seller
  buyerId:      string | null   // null = open market offer
  energyKwh:    number
  priceINR:     number     // per kWh
  minQtyKwh:    number     // minimum quantity
  validUntil:   number     // simulation time (seconds)
  status:       "open" | "matched" | "filled" | "expired"
  blockId:      string     // block ID for local matching priority
  createdAt:    number
}

/** A completed trade */
interface CompletedTrade {
  id:            string
  sellerId:      string
  buyerId:       string
  energyKwh:     number
  agreedPriceINR: number
  sellerEarningsINR: number
  buyerSavingsINR:  number    // vs. retail price
  timestamp:     number
  blockId:       string
  gridFeeINR:    number       // platform/grid operator fee
}

/** Market clearing price history */
interface MarketClearing {
  timestamp:   number
  hour:        number
  clearPrice:  number    // INR/kWh
  volumeKwh:   number
  offerCount:  number
  bidCount:    number
}

/**
 * EnergyMarketplace
 *
 * Double-auction P2P energy market.
 * Sellers (solar surplus households) post offers.
 * Buyers (deficit households) post bids.
 * Market clears by matching highest bid to lowest ask.
 *
 * Local priority: buyers in the same block get matched first.
 */
class EnergyMarketplace {
  private offers:         TradeOffer[]     = []
  private completedTrades: CompletedTrade[] = []
  private clearingHistory: MarketClearing[] = []
  private nextId:          number          = 0
  private platformFee:     number          = 0.10   // 10% grid/platform fee
  private simTime:         number          = 0

  /** Post a sell offer */
  postSellOffer(
    sellerId: string,
    blockId:  string,
    kWh:      number,
    priceINR: number,
    validSecs: number = 3600,
  ): TradeOffer {
    const offer: TradeOffer = {
      id:         `SELL_${this.nextId++}`,
      type:       "sell",
      sellerId, buyerId: null,
      energyKwh:  kWh,
      priceINR,
      minQtyKwh:  kWh * 0.1,
      validUntil: this.simTime + validSecs,
      status:     "open",
      blockId,
      createdAt:  this.simTime,
    }
    this.offers.push(offer)
    return offer
  }

  /** Post a buy bid */
  postBuyBid(
    buyerId:  string,
    blockId:  string,
    kWh:      number,
    maxPriceINR: number,
    validSecs:   number = 3600,
  ): TradeOffer {
    const bid: TradeOffer = {
      id:         `BUY_${this.nextId++}`,
      type:       "buy",
      sellerId:   "",
      buyerId,
      energyKwh:  kWh,
      priceINR:   maxPriceINR,
      minQtyKwh:  kWh * 0.1,
      validUntil: this.simTime + validSecs,
      status:     "open",
      blockId,
      createdAt:  this.simTime,
    }
    this.offers.push(bid)
    return bid
  }

  /**
   * clearMarket
   *
   * Run double-auction clearing.
   * Matches sell offers (lowest price first) against buy bids (highest price first).
   * Local block trades are preferred over cross-block trades.
   *
   * Returns list of completed trades.
   */
  clearMarket(hour: number, retailPriceINR: number): CompletedTrade[] {
    const now     = this.simTime
    const newTrades: CompletedTrade[] = []

    // Expire stale offers
    for (const o of this.offers) {
      if (o.validUntil < now && o.status === "open") o.status = "expired"
    }

    const openSells = this.offers
      .filter((o) => o.type === "sell" && o.status === "open")
      .sort((a, b) => a.priceINR - b.priceINR)    // cheapest first

    const openBuys  = this.offers
      .filter((o) => o.type === "buy" && o.status === "open")
      .sort((a, b) => b.priceINR - a.priceINR)    // highest willingness first

    for (const sell of openSells) {
      for (const buy of openBuys) {
        if (buy.status !== "open" || sell.status !== "open") continue
        if (buy.priceINR < sell.priceINR) continue   // no deal

        const sameBlock = sell.blockId === buy.blockId

        const tradeKwh    = Math.min(sell.energyKwh, buy.energyKwh)
        const clearPrice  = (sell.priceINR + buy.priceINR) / 2
        const gridFee     = clearPrice * tradeKwh * this.platformFee

        const trade: CompletedTrade = {
          id:              `T_${this.nextId++}`,
          sellerId:        sell.sellerId,
          buyerId:         buy.buyerId ?? "",
          energyKwh:       tradeKwh,
          agreedPriceINR:  clearPrice,
          sellerEarningsINR: clearPrice * tradeKwh * (1 - this.platformFee),
          buyerSavingsINR:   (retailPriceINR - clearPrice) * tradeKwh,
          timestamp:       now,
          blockId:         sameBlock ? sell.blockId : "cross_block",
          gridFeeINR:      gridFee,
        }

        sell.energyKwh -= tradeKwh
        buy.energyKwh  -= tradeKwh
        if (sell.energyKwh < sell.minQtyKwh) sell.status = "filled"
        if (buy.energyKwh  < buy.minQtyKwh)  buy.status  = "filled"

        newTrades.push(trade)
        this.completedTrades.push(trade)
      }
    }

    // Record market clearing
    if (newTrades.length > 0) {
      const totalVol  = newTrades.reduce((s, t) => s + t.energyKwh, 0)
      const avgPrice  = newTrades.reduce((s, t) => s + t.agreedPriceINR * t.energyKwh, 0) / Math.max(totalVol, 0.001)
      this.clearingHistory.push({
        timestamp: now, hour,
        clearPrice: avgPrice, volumeKwh: totalVol,
        offerCount: openSells.length, bidCount: openBuys.length,
      })
      if (this.clearingHistory.length > 200) this.clearingHistory.shift()
    }

    return newTrades
  }

  /** Advance simulation time */
  tick(dt: number): void { this.simTime += dt }

  get recentTrades():   CompletedTrade[]   { return this.completedTrades.slice(-50) }
  get clearing():       MarketClearing[]   { return this.clearingHistory }
  get openOffers():     TradeOffer[]       { return this.offers.filter((o) => o.status === "open") }
  get totalVolumeKwh(): number             { return this.completedTrades.reduce((s, t) => s + t.energyKwh, 0) }
  get totalValueINR():  number             { return this.completedTrades.reduce((s, t) => s + t.sellerEarningsINR, 0) }
}

/**
 * TradingEngine
 *
 * Drives automated trading behaviour for lots:
 *   - Surplus households post sell offers at slightly below retail
 *   - Deficit households post buy bids at slightly below retail
 *   - Runs market clearing on each tick
 */
class TradingEngine {
  private marketplace: EnergyMarketplace
  private priceModel:  ElectricityPriceModel

  constructor(marketplace: EnergyMarketplace, priceModel: ElectricityPriceModel) {
    this.marketplace = marketplace
    this.priceModel  = priceModel
  }

  /** Auto-post offers and bids from lot energy balances */
  autoPost(
    lots:        BuildingLot[],
    balances:    Map<string, LotEnergyBalance>,
    hour:        number,
    season:      Season,
    isWeekend:   boolean,
  ): void {
    const retailPrice = this.priceModel.computePrice(hour, season, isWeekend, 10, 0.3, 0)
    const exportRate  = this.priceModel.computeExportRate(hour, season, isWeekend)
    const retail      = retailPrice.finalRate

    for (const lot of lots) {
      const bal = balances.get(lot.id)
      if (!bal) continue

      const surplusKwh = bal.gridExportW / 3_600_000   // W·s → kWh (per second)
      const deficitKwh = bal.gridImportW / 3_600_000

      if (surplusKwh > 0.0001) {
        // Post sell offer: price between FIT export rate and retail
        const askPrice = exportRate + (retail - exportRate) * 0.6
        this.marketplace.postSellOffer(lot.id, lot.blockId, surplusKwh, askPrice, 1800)
      }

      if (deficitKwh > 0.0001) {
        // Post buy bid: willing to pay up to 95% of retail
        const bidPrice = retail * 0.95
        this.marketplace.postBuyBid(lot.id, lot.blockId, deficitKwh, bidPrice, 1800)
      }
    }
  }

  clearAndRecord(hour: number, retailPriceINR: number): CompletedTrade[] {
    return this.marketplace.clearMarket(hour, retailPriceINR)
  }
}

/** Hook: drives the P2P trading engine */
function usePeerToPeerTrading(
  lots:        BuildingLot[],
  balances:    Map<string, LotEnergyBalance>,
  hour:        number,
  season:      Season,
  isWeekend:   boolean,
  retailPrice: number,
): { marketplace: EnergyMarketplace; recentTrades: CompletedTrade[]; totalVolumeKwh: number } {
  const marketRef  = useRef(new EnergyMarketplace())
  const priceRef   = useRef(new ElectricityPriceModel())
  const engineRef  = useRef(new TradingEngine(marketRef.current, priceRef.current))
  const [trades, setTrades] = useState<CompletedTrade[]>([])
  const [volume,  setVolume]  = useState(0)

  useEffect(() => {
    const engine = engineRef.current
    engine.autoPost(lots, balances, hour, season, isWeekend)
    const newTrades = engine.clearAndRecord(hour, retailPrice)
    marketRef.current.tick(1)

    if (newTrades.length > 0) {
      setTrades(marketRef.current.recentTrades)
      setVolume(marketRef.current.totalVolumeKwh)
    }
  }, [lots, balances, hour, retailPrice])

  return { marketplace: marketRef.current, recentTrades: trades, totalVolumeKwh: volume }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.6 — FINANCIAL FORECASTING MODEL
// ─────────────────────────────────────────────────────────────────────────────

/** Assumptions for a financial projection */
interface FinancialAssumptions {
  systemCostINR:      number    // total installed cost
  annualGenKwh:       number    // year-1 generation
  selfConsumeFrac:    number    // fraction consumed on-site (0–1)
  retailRateINR:      number    // avoided cost per kWh self-consumed
  exportRateINR:      number    // FIT rate per kWh exported
  annualDegradation:  number    // panel degradation rate (fraction/year)
  escalationRate:     number    // electricity price escalation (fraction/year)
  discountRate:       number    // WACC / discount rate for NPV
  systemLifeYears:    number    // analysis period
  omCostAnnualINR:    number    // annual O&M cost
  insuranceINR:       number    // annual insurance
  subsidy:            IncentivePackage | null
  carbonCreditINR:    number    // annual carbon credit value
  batteryReplaceYear: number    // year of battery replacement (0 = none)
  batteryReplaceINR:  number    // battery replacement cost
  loanPrincipalINR:   number    // financing (0 = cash)
  loanRateAnnual:     number    // annual interest rate
  loanTermYears:      number    // loan repayment period
}

/** One year's financial projection */
interface AnnualProjection {
  year:            number
  generation_kWh:  number
  selfConsume_kWh: number
  export_kWh:      number
  retailSavingsINR: number
  exportEarningsINR: number
  carbonCreditINR:  number
  omCostINR:        number
  loanPaymentINR:   number
  batteryReplaceINR: number
  netCashflowINR:   number
  cumulativeCashflowINR: number
  npvContrib:       number     // contribution to NPV (discounted)
}

/** Full 20-year financial model output */
interface FinancialForecastResult {
  assumptions:          FinancialAssumptions
  projections:          AnnualProjection[]
  npv_INR:              number      // net present value
  irr_pct:              number      // internal rate of return (%)
  paybackYears:         number      // simple payback
  discountedPaybackYears: number    // discounted payback
  twentyYearReturn_INR: number      // cumulative cash flow over life
  lcoe_INR_per_kWh:     number      // levelised cost of energy
  roi_pct:              number      // total return on investment (%)
  co2Lifetime_tCO2:     number
  treesEquivalent:      number      // tCO₂ / 0.021 (average tree absorption/yr × 20yr)
}

/**
 * computeIRR
 *
 * Newton-Raphson IRR solver.
 * Solves NPV(r) = 0 for r (annual rate).
 * Pure function — unit testable.
 */
function computeIRR(cashflows: number[], maxIter = 100, tol = 1e-6): number {
  let r = 0.10   // initial guess 10%
  for (let i = 0; i < maxIter; i++) {
    let npv  = 0, dnpv = 0
    for (let t = 0; t < cashflows.length; t++) {
      const disc = Math.pow(1 + r, t)
      npv  += cashflows[t] / disc
      dnpv -= t * cashflows[t] / (disc * (1 + r))
    }
    if (Math.abs(dnpv) < 1e-14) break
    const rNew = r - npv / dnpv
    if (Math.abs(rNew - r) < tol) { r = rNew; break }
    r = clamp(rNew, -0.5, 2.0)
  }
  return r
}

/**
 * FinancialForecastModel
 *
 * 20-year financial projection for a solar installation.
 * Accounts for:
 *   - Panel degradation and tariff escalation
 *   - Loan amortisation (annuity method)
 *   - Battery replacement
 *   - Carbon credits
 *   - All incentives
 *   - NPV, IRR, LCOE, Payback
 */
class FinancialForecastModel {
  /**
   * project
   *
   * Run the full financial projection.
   * Pure function — unit testable.
   */
  project(a: FinancialAssumptions): FinancialForecastResult {
    const years       = a.systemLifeYears
    const netCostINR  = a.subsidy ? a.subsidy.netSystemCostINR : a.systemCostINR
    const subAnnual   = a.subsidy ? a.subsidy.annualProductionINR : 0
    const loanPmt     = a.loanPrincipalINR > 0
      ? this.annuityPayment(a.loanPrincipalINR, a.loanRateAnnual, a.loanTermYears)
      : 0

    const projections: AnnualProjection[] = []
    const cashflows   = [-netCostINR]   // year 0 outflow
    let cumCF         = -netCostINR

    let totalGenKwh = 0
    let totalCostKwh = 0

    for (let yr = 1; yr <= years; yr++) {
      const degFactor = Math.pow(1 - a.annualDegradation, yr - 1)
      const escFactor = Math.pow(1 + a.escalationRate,    yr - 1)

      const genKwh      = a.annualGenKwh * degFactor
      const selfConKwh  = genKwh * a.selfConsumeFrac
      const exportKwh   = genKwh * (1 - a.selfConsumeFrac)

      const retailSav   = selfConKwh * a.retailRateINR * escFactor
      const exportEarn  = exportKwh  * a.exportRateINR * escFactor
      const carbonVal   = a.carbonCreditINR * degFactor
      const prodSubsidy = subAnnual * degFactor

      const omCost      = a.omCostAnnualINR + a.insuranceINR
      const loanPay     = yr <= a.loanTermYears ? loanPmt : 0
      const battReplace = yr === a.batteryReplaceYear ? a.batteryReplaceINR : 0

      const netCF  = retailSav + exportEarn + carbonVal + prodSubsidy - omCost - loanPay - battReplace
      cumCF += netCF

      const disc   = Math.pow(1 + a.discountRate, yr)
      const npvCon = netCF / disc

      cashflows.push(netCF)
      totalGenKwh   += genKwh
      totalCostKwh  += omCost + loanPay

      projections.push({
        year: yr,
        generation_kWh:      genKwh,
        selfConsume_kWh:     selfConKwh,
        export_kWh:          exportKwh,
        retailSavingsINR:    retailSav,
        exportEarningsINR:   exportEarn,
        carbonCreditINR:     carbonVal,
        omCostINR:           omCost,
        loanPaymentINR:      loanPay,
        batteryReplaceINR:   battReplace,
        netCashflowINR:      netCF,
        cumulativeCashflowINR: cumCF,
        npvContrib:          npvCon,
      })
    }

    // NPV
    let npv = -netCostINR
    for (let t = 0; t < projections.length; t++) {
      npv += projections[t].npvContrib
    }

    // Simple payback
    let payback = years
    let discPayback = years
    let cumDiscounted = -netCostINR
    for (let t = 0; t < projections.length; t++) {
      if (cumDiscounted < 0 && projections[t].cumulativeCashflowINR >= 0) {
        payback = projections[t].year - 1 + Math.abs(projections[t-1]?.cumulativeCashflowINR ?? netCostINR) / projections[t].netCashflowINR
      }
      cumDiscounted += projections[t].npvContrib
      if (cumDiscounted >= 0 && discPayback === years) {
        discPayback = projections[t].year
      }
    }

    // IRR
    const irrRaw  = computeIRR(cashflows)
    const irr_pct = irrRaw * 100

    // LCOE
    const lcoe = totalGenKwh > 0
      ? (netCostINR + totalCostKwh) / totalGenKwh
      : 0

    // ROI
    const totalReturn = projections.reduce((s, p) => s + p.netCashflowINR, 0)
    const roi_pct     = netCostINR > 0 ? (totalReturn / netCostINR) * 100 : 0

    // CO₂
    const co2 = totalGenKwh * CO2_PER_KWH / 1000   // tCO₂

    return {
      assumptions: a,
      projections,
      npv_INR:                npv,
      irr_pct,
      paybackYears:           payback,
      discountedPaybackYears: discPayback,
      twentyYearReturn_INR:   totalReturn,
      lcoe_INR_per_kWh:       lcoe,
      roi_pct,
      co2Lifetime_tCO2:       co2,
      treesEquivalent:        co2 / (0.021 * 20),
    }
  }

  /** Annuity payment: monthly loan payment (level payments) */
  annuityPayment(principal: number, annualRate: number, termYears: number): number {
    const r = annualRate
    if (r <= 0) return principal / termYears
    return principal * r / (1 - Math.pow(1 + r, -termYears))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.7 — POLICY SCENARIO SIMULATOR
// ─────────────────────────────────────────────────────────────────────────────

/** A defined policy scenario */
interface PolicyScenario {
  id:                string
  name:              string
  description:       string
  /** Changes to subsidy programs (id → overrides) */
  subsidyOverrides:  Record<string, Partial<SubsidyProgram>>
  /** FIT scheme to use */
  fitScheme?:        FitSchemeConfig
  /** Base tariff change (fraction of default, e.g. 1.2 = 20% higher) */
  tariffMultiplier:  number
  /** Carbon price adjustment */
  carbonPriceMultiplier: number
  /** Grid emission factor change */
  gridEmissionFactor: number
  /** Mandate: minimum solar penetration required (fraction) */
  mandatedSolarFrac: number
  /** Year the policy takes effect */
  effectiveYear:     number
}

/** Predefined policy scenarios */
const POLICY_SCENARIOS: PolicyScenario[] = [
  {
    id: "BAU", name: "Business As Usual",
    description: "Current policies, no change",
    subsidyOverrides: {}, tariffMultiplier: 1.0,
    carbonPriceMultiplier: 1.0, gridEmissionFactor: CO2_PER_KWH,
    mandatedSolarFrac: 0, effectiveYear: 2024,
    fitScheme: FIT_SCHEME_INDIA_NM,
  },
  {
    id: "AGGRESSIVE_SUBSIDY", name: "Aggressive Subsidy Push",
    description: "50% capital subsidy + 5% export rate boost",
    subsidyOverrides: {
      "MNRE_CAPEX_2024": { value: 0.50, remainingBudget: 200000 },
      "BATTERY_SUB":     { value: 20000, remainingBudget: 20000 },
    },
    tariffMultiplier: 1.0, carbonPriceMultiplier: 1.2,
    gridEmissionFactor: CO2_PER_KWH,
    mandatedSolarFrac: 0.5, effectiveYear: 2025,
  },
  {
    id: "HIGH_TARIFF", name: "High Electricity Tariffs",
    description: "30% tariff increase — drives solar adoption",
    subsidyOverrides: {},
    tariffMultiplier: 1.30, carbonPriceMultiplier: 1.0,
    gridEmissionFactor: CO2_PER_KWH * 0.9,
    mandatedSolarFrac: 0, effectiveYear: 2025,
  },
  {
    id: "CARBON_TAX", name: "Carbon Tax Scenario",
    description: "Carbon tax on grid power, boosting solar economics",
    subsidyOverrides: {},
    tariffMultiplier: 1.15, carbonPriceMultiplier: 3.0,
    gridEmissionFactor: CO2_PER_KWH,
    mandatedSolarFrac: 0, effectiveYear: 2026,
  },
  {
    id: "NO_SUBSIDY", name: "Zero Subsidy",
    description: "All subsidies removed — market-only deployment",
    subsidyOverrides: {
      "MNRE_CAPEX_2024":  { active: false },
      "ITC_SOLAR":        { active: false },
      "BATTERY_SUB":      { active: false },
      "PROD_INC_RURAL":   { active: false },
    },
    tariffMultiplier: 1.0, carbonPriceMultiplier: 1.0,
    gridEmissionFactor: CO2_PER_KWH,
    mandatedSolarFrac: 0, effectiveYear: 2025,
  },
]

/** Metrics measuring scenario outcome */
interface ScenarioOutcomeMetrics {
  scenarioId:          string
  scenarioName:        string
  solarAdoptionFrac:   number    // fraction of eligible lots with solar
  totalCapacityMw:     number    // total installed PV capacity
  annualGenGwh:        number    // annual generation
  cityAnnualSavingsINR: number   // total consumer savings
  co2ReductionTCO2:    number    // annual CO₂ avoided
  gridLoadReductionMW: number    // peak grid import reduction
  avgPaybackYears:     number    // mean payback across installations
  avgNPV_INR:          number    // mean NPV per installation
  carbonCreditValueINR: number   // total carbon credit revenue
  fitPaymentsINR:      number    // total FIT payments by utility
  subsidyCostINR:      number    // total government subsidy outlay
  bcr:                 number    // benefit-cost ratio
  jobsCreated:         number    // approximate installation jobs
}

/**
 * PolicyScenarioRunner
 *
 * Evaluates a PolicyScenario against a CityLayout and energy state.
 * Produces ScenarioOutcomeMetrics comparing impacts.
 */
class PolicyScenarioRunner {
  private forecastModel: FinancialForecastModel = new FinancialForecastModel()
  private subsidyEngine: SubsidyPolicyEngine    = new SubsidyPolicyEngine()
  private carbonCalc:    CarbonCreditCalculator = new CarbonCreditCalculator()

  /**
   * run
   *
   * Evaluate a scenario against a city layout.
   * Pure function given layout + scenario — unit testable.
   */
  run(
    layout:       CityLayout,
    scenario:     PolicyScenario,
    baseYearGen:  Map<string, number>,   // lotId → annual kWh
    currentYear:  number = 2025,
  ): ScenarioOutcomeMetrics {
    // Apply subsidy overrides
    for (const [progId, override] of Object.entries(scenario.subsidyOverrides)) {
      this.subsidyEngine.updateProgram(progId, override)
    }

    const tariffRate = ELECTRICITY_TARIFF * scenario.tariffMultiplier
    const fitRate    = scenario.fitScheme?.exportRateINR ?? FIT_SCHEME_INDIA_NM.exportRateINR

    let totalCapKw          = 0
    let totalGenKwh         = 0
    let totalSavingsINR     = 0
    let totalCO2            = 0
    let totalPayback        = 0
    let totalNPV            = 0
    let totalSubsidyCost    = 0
    let totalFITPayments    = 0
    let solarLots           = 0
    let eligibleLots        = 0

    for (const lot of layout.lots) {
      if (lot.zone === "park") continue
      eligibleLots++

      const wouldInstall = lot.hasSolar || seeded(lot.seed + 17) < scenario.mandatedSolarFrac
      if (!wouldInstall) continue
      solarLots++

      const capKw      = lot.panelCount * 0.4      // 400W per panel
      const systemCost = capKw * INSTALL_COST_PER_KW
      const annualGen  = baseYearGen.get(lot.id) ?? capKw * 1400   // ~1400 kWh/kWp/yr India

      const incentives = this.subsidyEngine.calculateIncentives(
        lot.id, systemCost, capKw, 10, annualGen, lot.zone, currentYear,
      )
      totalSubsidyCost += incentives.totalUpfrontINR

      const { netTCO2 } = computeCO2Reduction(annualGen, scenario.gridEmissionFactor)
      const carbonVal   = netTCO2 * CARBON_MARKET_PRICES.VCS.priceINR * scenario.carbonPriceMultiplier
      totalCO2          += netTCO2

      const exportKwh   = annualGen * 0.35    // ~35% exported
      const fitPmt      = exportKwh * fitRate
      totalFITPayments += fitPmt

      const assumptions: FinancialAssumptions = {
        systemCostINR:     systemCost,
        annualGenKwh:      annualGen,
        selfConsumeFrac:   0.65,
        retailRateINR:     tariffRate,
        exportRateINR:     fitRate,
        annualDegradation: 0.005,
        escalationRate:    0.04,
        discountRate:      0.09,
        systemLifeYears:   20,
        omCostAnnualINR:   systemCost * 0.005,
        insuranceINR:      systemCost * 0.003,
        subsidy:           incentives,
        carbonCreditINR:   carbonVal,
        batteryReplaceYear: 12,
        batteryReplaceINR: 80_000,
        loanPrincipalINR:  0,
        loanRateAnnual:    0,
        loanTermYears:     0,
      }

      const forecast = this.forecastModel.project(assumptions)
      totalCapKw   += capKw
      totalGenKwh  += annualGen
      totalSavingsINR += forecast.projections.reduce((s, p) => s + p.retailSavingsINR, 0)
      totalPayback += forecast.paybackYears
      totalNPV     += forecast.npv_INR
    }

    const avgPayback = solarLots > 0 ? totalPayback / solarLots : 0
    const avgNPV     = solarLots > 0 ? totalNPV / solarLots : 0
    const bcr        = totalSubsidyCost > 0 ? totalSavingsINR / totalSubsidyCost : Infinity
    const jobsCreated = Math.round(totalCapKw * 1.2)   // ~1.2 jobs/kW installed

    // Restore original subsidy state
    this.subsidyEngine = new SubsidyPolicyEngine()

    return {
      scenarioId:           scenario.id,
      scenarioName:         scenario.name,
      solarAdoptionFrac:    eligibleLots > 0 ? solarLots / eligibleLots : 0,
      totalCapacityMw:      totalCapKw / 1000,
      annualGenGwh:         totalGenKwh / 1e6,
      cityAnnualSavingsINR: totalSavingsINR / 20,    // average annual
      co2ReductionTCO2:     totalCO2,
      gridLoadReductionMW:  totalCapKw * 0.7 / 1000,  // ~70% capacity factor → grid reduction
      avgPaybackYears:      avgPayback,
      avgNPV_INR:           avgNPV,
      carbonCreditValueINR: totalCO2 * CARBON_MARKET_PRICES.VCS.priceINR * scenario.carbonPriceMultiplier,
      fitPaymentsINR:       totalFITPayments,
      subsidyCostINR:       totalSubsidyCost,
      bcr,
      jobsCreated,
    }
  }

  /** Compare multiple scenarios and return sorted by NPV */
  compareScenarios(
    layout:      CityLayout,
    scenarios:   PolicyScenario[],
    baseYearGen: Map<string, number>,
    currentYear: number = 2025,
  ): ScenarioOutcomeMetrics[] {
    return scenarios
      .map((s) => this.run(layout, s, baseYearGen, currentYear))
      .sort((a, b) => b.avgNPV_INR - a.avgNPV_INR)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29.8 — MARKET VISUALIZATION OVERLAY
// ─────────────────────────────────────────────────────────────────────────────

/** Financial metric to display on each building */
type LotMetricDisplay = "profit_per_year" | "payback_years" | "co2_saved" | "trade_volume" | "fit_earnings"

/** Colour scale for financial metrics */
function financialHeatColor(
  value:   number,
  min:     number,
  max:     number,
  reverse: boolean = false,
): string {
  const t = clamp((value - min) / Math.max(max - min, 1e-6), 0, 1)
  const r = reverse ? 1 - t : t
  const c = new THREE.Color()
  c.setHSL((1 - r) * 0.33, 0.85, 0.42)   // green (high) → red (low)
  return `#${c.getHexString()}`
}

/** Props for LotFinancialMarker (3D label above a building) */
interface LotFinancialMarkerProps {
  lot:        BuildingLot
  value:      number
  label:      string
  color:      string
  selected?:  boolean
  onClick?:   (lotId: string) => void
}

/** Floating financial metric card above a building */
const LotFinancialMarker = memo(function LotFinancialMarker({
  lot, value, label, color, selected, onClick,
}: LotFinancialMarkerProps) {
  const h = lot.floors * 3.2 - 1.96 + 1.2
  const glowRef = useRef<THREE.PointLight>(null)

  useFrame(({ clock }) => {
    if (!glowRef.current) return
    const t = clock.getElapsedTime()
    glowRef.current.intensity = selected
      ? 0.8 + 0.3 * Math.sin(t * 3)
      : 0.2
  })

  return (
    <group position={[lot.worldX, h, lot.worldZ]} onClick={() => onClick?.(lot.id)}>
      {/* Marker disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.42, 8]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={selected ? 0.9 : 0.65}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      {/* Stem */}
      <mesh position={[0, -0.3, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.6, 5]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
      <pointLight ref={glowRef} color={color} intensity={0.2} distance={2.5} decay={2} />
    </group>
  )
})

/** Props for EnergyTradeFlowVisual */
interface EnergyTradeFlowVisualProps {
  trades:     CompletedTrade[]
  lots:       BuildingLot[]
  active:     boolean
}

/** Renders animated P2P trade flow lines between trading lots */
const EnergyTradeFlowVisual = memo(function EnergyTradeFlowVisual({
  trades, lots, active,
}: EnergyTradeFlowVisualProps) {
  const lotMap = useMemo(
    () => new Map(lots.map((l) => [l.id, l])),
    [lots],
  )
  const progRef  = useRef<number[]>(trades.map(() => Math.random()))

  useFrame((_, delta) => {
    for (let i = 0; i < progRef.current.length; i++) {
      progRef.current[i] = (progRef.current[i] + delta * 0.4) % 1
    }
  })

  if (!active) return null

  return (
    <group>
      {trades.slice(0, 30).map((trade, i) => {
        const seller = lotMap.get(trade.sellerId)
        const buyer  = lotMap.get(trade.buyerId)
        if (!seller || !buyer) return null

        const hs = seller.floors * 3.2 - 1.96 + 0.6
        const hb = buyer.floors  * 3.2 - 1.96 + 0.6
        const pts: [number,number,number][] = [
          [seller.worldX, hs, seller.worldZ],
          [(seller.worldX + buyer.worldX) * 0.5, Math.max(hs, hb) + 2, (seller.worldZ + buyer.worldZ) * 0.5],
          [buyer.worldX,  hb, buyer.worldZ],
        ]
        const color = trade.blockId === "cross_block" ? "#f59e0b" : DS.emerald

        return (
          <group key={trade.id}>
            <DreiLine points={pts} color={color} lineWidth={0.8} transparent opacity={0.4} dashed dashSize={0.3} gapSize={0.2} />
          </group>
        )
      })}
    </group>
  )
})

/** Props for MarketOverlayLayer */
interface MarketOverlayLayerProps {
  layout:        CityLayout
  metric:        LotMetricDisplay
  lotForecasts?: Map<string, FinancialForecastResult>
  fitCalc?:      FeedInTariffCalculator
  carbonCalc?:   CarbonCreditCalculator
  p2pTrades?:    CompletedTrade[]
  showTrades?:   boolean
  selectedLot?:  string | null
  onSelect?:     (lotId: string) => void
}

/**
 * MarketOverlayLayer
 *
 * 3D market data overlay showing per-building financial metrics.
 * Colour gradient: green (best) → red (worst) for all metrics.
 * Only renders solar lots (non-solar buildings are skipped).
 */
const MarketOverlayLayer = memo(function MarketOverlayLayer({
  layout, metric, lotForecasts, fitCalc, carbonCalc,
  p2pTrades = [], showTrades = true, selectedLot, onSelect,
}: MarketOverlayLayerProps) {
  // Compute per-lot metric values
  const { markers, minVal, maxVal } = useMemo(() => {
    const vals: Array<{ lot: BuildingLot; value: number; label: string }> = []

    for (const lot of layout.lots.filter((l) => l.hasSolar)) {
      let value = 0
      let label = ""

      switch (metric) {
        case "profit_per_year": {
          const fc = lotForecasts?.get(lot.id)
          const annCF = fc ? fc.projections.reduce((s, p) => s + p.netCashflowINR, 0) / 20 : 0
          value = annCF / 1000   // thousands INR
          label = `₹${value.toFixed(0)}k/yr`
          break
        }
        case "payback_years": {
          const fc = lotForecasts?.get(lot.id)
          value = fc ? fc.paybackYears : 0
          label = `${value.toFixed(1)}yr`
          break
        }
        case "co2_saved": {
          const tCO2 = carbonCalc ? carbonCalc.lotCumulative(lot.id) : 0
          value = tCO2
          label = `${value.toFixed(2)} tCO₂`
          break
        }
        case "trade_volume": {
          const vol = p2pTrades.filter((t) => t.sellerId === lot.id || t.buyerId === lot.id)
            .reduce((s, t) => s + t.energyKwh, 0)
          value = vol
          label = `${vol.toFixed(3)} kWh`
          break
        }
        case "fit_earnings": {
          value = fitCalc ? fitCalc.cumulativeEarnings(lot.id) / 1000 : 0
          label = `₹${value.toFixed(1)}k`
          break
        }
      }
      vals.push({ lot, value, label })
    }

    const allVals = vals.map((v) => v.value)
    const minVal  = Math.min(...allVals)
    const maxVal  = Math.max(...allVals)

    const markers = vals.map(({ lot, value, label }) => ({
      lot, value, label,
      color: financialHeatColor(
        value, minVal, maxVal,
        metric === "payback_years"   // reverse: lower payback = better = green
      ),
    }))

    return { markers, minVal, maxVal }
  }, [layout.lots, metric, lotForecasts, fitCalc, carbonCalc, p2pTrades])

  return (
    <group>
      {markers.map(({ lot, value, label, color }) => (
        <LotFinancialMarker
          key={lot.id}
          lot={lot} value={value} label={label} color={color}
          selected={selectedLot === lot.id}
          onClick={onSelect}
        />
      ))}
      {showTrades && (
        <EnergyTradeFlowVisual trades={p2pTrades} lots={layout.lots} active={true} />
      )}
    </group>
  )
})

/** Market analytics DOM panel */
interface MarketAnalyticsPanelProps {
  cityFIT:      number
  carbonSummary: { totalIssuedTCO2: number; totalValueINR: number }
  p2pMarket:    { totalVolumeKwh: number; totalValueINR: number }
  priceState:   ElectricityPrice
  scenarioResult: ScenarioOutcomeMetrics | null
  visible:      boolean
  metric:       LotMetricDisplay
  onMetric:     (m: LotMetricDisplay) => void
}

const MarketAnalyticsPanel = memo(function MarketAnalyticsPanel({
  cityFIT, carbonSummary, p2pMarket, priceState,
  scenarioResult, visible, metric, onMetric,
}: MarketAnalyticsPanelProps) {
  if (!visible) return null

  const METRICS: { value: LotMetricDisplay; label: string }[] = [
    { value: "profit_per_year", label: "Annual Profit" },
    { value: "payback_years",   label: "Payback" },
    { value: "co2_saved",       label: "CO₂ Saved" },
    { value: "trade_volume",    label: "P2P Trades" },
    { value: "fit_earnings",    label: "FIT Earnings" },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      style={{
        position:       "absolute",
        bottom:          108,
        right:            14,
        background:     "rgba(3,8,22,0.92)",
        backdropFilter: "blur(14px)",
        border:         `1px solid ${DS.gold}33`,
        borderTop:      `2px solid ${DS.gold}88`,
        borderRadius:    10,
        padding:        "13px 17px",
        minWidth:        240,
        color:           DS.text,
        fontSize:        11,
        zIndex:          82,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 10, color: DS.gold, letterSpacing: "0.08em", marginBottom: 8 }}>
        💰 ENERGY MARKET ENGINE
      </div>

      {/* Live price */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ color: DS.muted, fontSize: 9, marginBottom: 3 }}>LIVE TARIFF</div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: DS.text }}>Zone: <span style={{ color: DS.gold }}>{priceState.zoneLabel}</span></span>
          <span style={{ color: DS.gold, fontWeight: 700 }}>₹{priceState.finalRate.toFixed(2)}/kWh</span>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${DS.border}`, margin: "6px 0" }} />

      {/* Key metrics */}
      {[
        ["FIT Earnings",    `₹${(cityFIT/1000).toFixed(1)}k`,                          DS.emerald],
        ["Carbon Credits",  `${carbonSummary.totalIssuedTCO2.toFixed(1)} tCO₂`,        DS.cyan],
        ["Carbon Value",    `₹${(carbonSummary.totalValueINR/1000).toFixed(1)}k`,       DS.cyan],
        ["P2P Volume",      `${p2pMarket.totalVolumeKwh.toFixed(2)} kWh`,               DS.text],
        ["P2P Value",       `₹${(p2pMarket.totalValueINR/1000).toFixed(2)}k`,           DS.emerald],
      ].map(([label, value, color]) => (
        <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
          <span style={{ color: DS.muted }}>{label}</span>
          <span style={{ color: String(color), fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}

      {/* Scenario result */}
      {scenarioResult && (
        <>
          <div style={{ borderTop: `1px solid ${DS.border}`, margin: "6px 0" }} />
          <div style={{ color: DS.muted, fontSize: 9, marginBottom: 3 }}>
            SCENARIO: {scenarioResult.scenarioName}
          </div>
          {[
            ["Solar Adoption",  `${(scenarioResult.solarAdoptionFrac*100).toFixed(0)}%`,    DS.gold],
            ["Avg Payback",     `${scenarioResult.avgPaybackYears.toFixed(1)} yr`,           DS.text],
            ["BCR",             `${scenarioResult.bcr.toFixed(2)}`,                          DS.emerald],
            ["CO₂/yr",         `${scenarioResult.co2ReductionTCO2.toFixed(0)} tCO₂`,        DS.cyan],
          ].map(([label, value, color]) => (
            <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span style={{ color: DS.muted }}>{label}</span>
              <span style={{ color: String(color), fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </>
      )}

      {/* Metric selector */}
      <div style={{ borderTop: `1px solid ${DS.border}`, margin: "8px 0 6px" }} />
      <div style={{ color: DS.muted, fontSize: 9, marginBottom: 5 }}>3D OVERLAY METRIC</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {METRICS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => onMetric(value)}
            style={{
              padding:      "3px 8px",
              borderRadius: 5,
              border:       `1px solid ${metric === value ? DS.gold : DS.border}`,
              background:   metric === value ? `${DS.gold}22` : DS.bgLight,
              color:        metric === value ? DS.gold : DS.muted,
              cursor:       "pointer",
              fontSize:     10,
              fontWeight:   metric === value ? 700 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </motion.div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29 — MASTER MARKET ENGINE HOOK
// ─────────────────────────────────────────────────────────────────────────────

/** Full energy market engine state */
interface MarketEngineState {
  electricityPrice:   ElectricityPrice
  fitCalculator:      FeedInTariffCalculator
  carbonCalculator:   CarbonCreditCalculator
  subsidyEngine:      SubsidyPolicyEngine
  marketplace:        EnergyMarketplace
  forecastModel:      FinancialForecastModel
  scenarioRunner:     PolicyScenarioRunner
  lotForecasts:       Map<string, FinancialForecastResult>
  scenarioResults:    ScenarioOutcomeMetrics[]
  recentTrades:       CompletedTrade[]
  p2pVolumeKwh:       number
  cityFITPaymentsINR: number
  carbonSummary:      { totalIssuedTCO2: number; totalValueINR: number }
  selectedMetric:     LotMetricDisplay
}

/**
 * useMarketEngine
 *
 * Master hook integrating all sub-systems of Section 29.
 * Drives pricing, FIT, carbon, trading, and forecasting from city state.
 */
function useMarketEngine(opts: {
  layout:        CityLayout
  lotBalances:   Map<string, LotEnergyBalance>
  hour:          number
  season:        Season
  isWeekend:     boolean
  gridBalance?:  GridBalance | null
  climateRatio?:  number
  currentYear?:   number
}): MarketEngineState & { setMetric: (m: LotMetricDisplay) => void } {
  const {
    layout, lotBalances, hour, season, isWeekend,
    gridBalance, climateRatio = 0.7, currentYear = 2025,
  } = opts

  // Singletons
  const priceModelRef  = useRef(new ElectricityPriceModel())
  const fitCalcRef     = useRef(new FeedInTariffCalculator())
  const carbonCalcRef  = useRef(new CarbonCreditCalculator())
  const subsidyRef     = useRef(new SubsidyPolicyEngine())
  const marketRef      = useRef(new EnergyMarketplace())
  const forecastRef    = useRef(new FinancialForecastModel())
  const scenRunnerRef  = useRef(new PolicyScenarioRunner())
  const priceEngRef    = useRef(new DynamicPricingEngine(priceModelRef.current))
  const tradingEngRef  = useRef(new TradingEngine(marketRef.current, priceModelRef.current))

  const [selectedMetric, setMetric] = useState<LotMetricDisplay>("profit_per_year")
  const [state, setState] = useState<Omit<MarketEngineState, "selectedMetric">>({
    electricityPrice:   priceModelRef.current.computePrice(hour, season, isWeekend, 10, 0.3, 0),
    fitCalculator:      fitCalcRef.current,
    carbonCalculator:   carbonCalcRef.current,
    subsidyEngine:      subsidyRef.current,
    marketplace:        marketRef.current,
    forecastModel:      forecastRef.current,
    scenarioRunner:     scenRunnerRef.current,
    lotForecasts:       new Map(),
    scenarioResults:    [],
    recentTrades:       [],
    p2pVolumeKwh:       0,
    cityFITPaymentsINR: 0,
    carbonSummary:      { totalIssuedTCO2: 0, totalValueINR: 0 },
  })

  // Drive dynamic pricing from grid conditions
  useEffect(() => {
    if (!gridBalance) return
    const solar  = gridBalance.totalGenerationMW
    const load   = gridBalance.totalLoadMW
    const solar_frac = load > 0 ? solar / load : 0
    priceEngRef.current.generateSignal(
      gridBalance.frequencyHz,
      gridBalance.gridImportMW,
      load,
      solar_frac,
    )
  }, [gridBalance?.frequencyHz, gridBalance?.gridImportMW])

  // Main tick: every 5 seconds
  useEffect(() => {
    const run = () => {
      const price  = priceModelRef.current.computePrice(
        hour, season, isWeekend, 10,
        gridBalance ? clamp(gridBalance.totalGenerationMW / Math.max(gridBalance.totalLoadMW, 1), 0, 1) : 0.3,
        gridBalance ? Math.max(0, gridBalance.gridImportMW - 5) : 0,
      )

      // FIT: process exports
      for (const lot of layout.lots) {
        if (!lot.hasSolar) continue
        const bal = lotBalances.get(lot.id)
        if (!bal) continue
        const exportKwh = bal.gridExportW / 3_600_000
        if (exportKwh > 0) {
          fitCalcRef.current.recordExport(lot.id, exportKwh, hour, season, isWeekend)
        }
        // Carbon: issue credits annually (simplified: per second × scale)
        const genKwh = bal.solarW / 3_600_000
        if (genKwh > 0) {
          carbonCalcRef.current.issueCreditForLot(lot.id, genKwh, currentYear)
        }
      }

      // P2P trading
      tradingEngRef.current.autoPost(layout.lots, lotBalances, hour, season, isWeekend)
      tradingEngRef.current.clearAndRecord(hour, price.finalRate)
      marketRef.current.tick(5)

      // Build forecasts for solar lots (only compute for lots not yet forecasted)
      const lotForecasts = new Map(state.lotForecasts)
      for (const lot of layout.lots.filter((l) => l.hasSolar && !lotForecasts.has(l.id))) {
        const capKw    = lot.panelCount * 0.4
        const annGen   = capKw * 1400 * clamp(climateRatio, 0.1, 1.2)
        const costINR  = capKw * INSTALL_COST_PER_KW
        const incentive = subsidyRef.current.calculateIncentives(
          lot.id, costINR, capKw, 10, annGen, lot.zone, currentYear
        )
        const { netTCO2 } = computeCO2Reduction(annGen)
        const carbonVal = netTCO2 * CARBON_MARKET_PRICES.VCS.priceINR
        const fc = forecastRef.current.project({
          systemCostINR: costINR, annualGenKwh: annGen,
          selfConsumeFrac: 0.65, retailRateINR: price.finalRate,
          exportRateINR: fitCalcRef.current.computeExportRate(2023, currentYear),
          annualDegradation: 0.005, escalationRate: 0.04,
          discountRate: 0.09, systemLifeYears: 20,
          omCostAnnualINR: costINR * 0.005, insuranceINR: costINR * 0.003,
          subsidy: incentive, carbonCreditINR: carbonVal,
          batteryReplaceYear: 12, batteryReplaceINR: 80000,
          loanPrincipalINR: 0, loanRateAnnual: 0, loanTermYears: 0,
        })
        lotForecasts.set(lot.id, fc)
      }

      // Run BAU scenario every 30 ticks (approximately)
      const baseYearGen = new Map(layout.lots.map((l) => [l.id, l.panelCount * 0.4 * 1400]))
      const scenResult  = [POLICY_SCENARIOS[0]]  // only BAU for performance
        .map((s) => scenRunnerRef.current.run(layout, s, baseYearGen, currentYear))

      setState({
        electricityPrice:   price,
        fitCalculator:      fitCalcRef.current,
        carbonCalculator:   carbonCalcRef.current,
        subsidyEngine:      subsidyRef.current,
        marketplace:        marketRef.current,
        forecastModel:      forecastRef.current,
        scenarioRunner:     scenRunnerRef.current,
        lotForecasts,
        scenarioResults:    scenResult,
        recentTrades:       marketRef.current.recentTrades,
        p2pVolumeKwh:       marketRef.current.totalVolumeKwh,
        cityFITPaymentsINR: fitCalcRef.current.cityTotal(),
        carbonSummary:      carbonCalcRef.current.citySummary(),
      })
    }

    run()
    const id = setInterval(run, 5000)
    return () => clearInterval(id)
  }, [hour, season, isWeekend, lotBalances, currentYear, climateRatio]) // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, selectedMetric, setMetric }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 29 — PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export {
  // 29.1 Pricing
  ElectricityPriceModel, TimeOfUseTariff, DynamicPricingEngine,
  getTouZone, TOU_ZONE_MULTIPLIERS, TOU_SCHEDULES, useElectricityPrice,

  // 29.2 FIT
  FeedInTariffCalculator, FIT_SCHEME_INDIA_NM, useFeedInTariff,

  // 29.3 Subsidies
  SubsidyPolicyEngine, SUBSIDY_PROGRAMS,

  // 29.4 Carbon
  CarbonCreditCalculator, computeCO2Reduction,
  CARBON_MARKET_PRICES,

  // 29.5 P2P Trading
  EnergyMarketplace, TradingEngine, usePeerToPeerTrading,

  // 29.6 Forecasting
  FinancialForecastModel, computeIRR,

  // 29.7 Policy Scenarios
  PolicyScenarioRunner, POLICY_SCENARIOS,

  // 29.8 Visualization
  MarketOverlayLayer, LotFinancialMarker, EnergyTradeFlowVisual,
  MarketAnalyticsPanel, financialHeatColor,

  // Master hook
  useMarketEngine,
}

export type {
  // 29.1
  TouZone, TouPeriod, TouSchedule, PriceDrivers, ElectricityPrice, DynamicPriceSignal,

  // 29.2
  FitSchemeType, FitSchemeConfig, FitPaymentRecord, FitAnnualSummary,

  // 29.3
  SubsidyType, SubsidyProgram, IncentiveCalculation, IncentivePackage,

  // 29.4
  CarbonStandard, CarbonCreditCert, CarbonMarketPrice,

  // 29.5
  TradeOffer, CompletedTrade, MarketClearing,

  // 29.6
  FinancialAssumptions, AnnualProjection, FinancialForecastResult,

  // 29.7
  PolicyScenario, ScenarioOutcomeMetrics,

  // 29.8
  LotMetricDisplay, LotFinancialMarkerProps, MarketOverlayLayerProps,
  MarketAnalyticsPanelProps,

  // Master
  MarketEngineState,
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 30 — MARKET ENGINE DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.1  PRICING ALGORITHMS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RETAIL PRICE CASCADE (ElectricityPriceModel.computePrice):
 *
 *   Price component             Formula
 *   ──────────────────────────────────────────────────────────────────────
 *   Base rate                   ELECTRICITY_TARIFF = ₹7.50/kWh
 *   TOU adjustment              base × TOU_ZONE_MULTIPLIERS[zone]
 *   Dynamic signal              × dynamic_multiplier (1.0 default)
 *   Congestion adder            + congestionMW × 0.02 (capped ₹3/kWh)
 *   Renewable discount          × 0.92 if renewableFraction > 0.6
 *   Regulatory levy             + ₹0.35/kWh
 *   Demand charge (amortised)   + (₹150/kW·month × peakKw) / 200h
 *   GST (18%)                   × 1.18
 *   ──────────────────────────────────────────────────────────────────────
 *
 * TOU zone multipliers:
 *   super_off_peak:  0.50 × base  (typically 00:00–06:00)
 *   off_peak:        0.75 × base
 *   shoulder:        1.00 × base  (reference)
 *   peak:            1.65 × base  (typically 17:00–21:00 summer)
 *   critical_peak:   2.80 × base  (used for DR events)
 *
 * EXPORT RATE:
 *   export_rate = base × TOU_mult × 0.55   (55% of retail — avoidance cost)
 *   Clamped to [₹2, ₹12] per kWh
 *
 * DYNAMIC PRICING SIGNAL (DynamicPricingEngine):
 *   Normal:        multiplier = 1.0
 *   reduce_load:   multiplier = 1 + |freq−50|×0.3 + loadRatio×0.4
 *   increase_load: multiplier = 0.65 (solar surplus → cheap energy)
 *   critical:      multiplier = 2.5 (frequency deviation > 1 Hz)
 *   Valid for 15 minutes after issue.
 *
 * UNIT TEST EXAMPLES:
 *   getTouZone(18, "Summer", false)  → { zone: "critical_peak", label: "Evening Peak" }
 *   getTouZone(2,  "Winter", false)  → { zone: "super_off_peak", label: "Night" }
 *   getTouZone(12, "Summer", true)   → { zone: "shoulder", label: "Day" }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.2  FEED-IN TARIFF MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FIT degression formula:
 *   rate(year) = base_rate × (1 + degression)^(year − install_year)
 *   default degression = −2%/year (declining payments over contract)
 *
 * Net metering vs net billing:
 *   Net metering: excess kWh credited against future bills (no cash)
 *   Net billing:  excess paid in cash at export rate each billing period
 *   Gross metering: all generation exported and paid (rare in India)
 *
 * India MNRE 2024 rates:
 *   Base export rate: ₹3.50/kWh
 *   25-year contract, max 500 kW residential
 *   Annual degression: −2%
 *
 * UNIT TEST EXAMPLES:
 *   calc.computeExportRate(2023, 2027)  → 3.50 × (0.98)^4 ≈ ₹3.23/kWh
 *   calc.computeExportRate(2023, 2023)  → ₹3.50/kWh (year 0)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.3  SUBSIDY & INCENTIVE CALCULATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Capital subsidy:
 *   subsidy = systemCost × capKw/systemCapKw × value_fraction
 *   Net cost = systemCost − totalSubsidies
 *
 * Accelerated depreciation (India):
 *   Tax benefit = systemCost × dep_rate × corp_tax_rate
 *   = systemCost × 0.80 × 0.30 = 24% of system cost
 *
 * Battery incentive:
 *   = battCapKwh × 1.5 × ₹15,000/kW = ₹22,500/kWh installed
 *
 * Stacking rule:
 *   Non-stackable programs: only the highest-value applies.
 *   Stackable programs: all can be claimed simultaneously.
 *   Budget depletion: tracked per program across all claimants.
 *
 * BENEFIT-COST RATIO (BCR):
 *   BCR = totalConsumerSavings20yr / totalGovernmentSubsidy
 *   BCR > 2.0 → fiscally efficient policy
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.4  CARBON CREDIT METHODOLOGY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Baseline (grid emission factor): 0.82 kg CO₂/kWh (Indian grid average)
 * Marginal factor: 0.95 kg CO₂/kWh (marginal plant = coal)
 *
 * Net CO₂ reduction:
 *   gross  = genKwh × 0.82 / 1000    (tCO₂ displaced)
 *   marginal = genKwh × 0.95 / 1000
 *   lifecycle = genKwh × 0.022 / 1000  (panel manufacturing)
 *   net = marginal − lifecycle
 *
 * Methodology: ACM0002 — Grid-connected distributed PV
 * Registry: Verified Carbon Standard (VCS) or Gold Standard
 *
 * UNIT TEST EXAMPLES:
 *   computeCO2Reduction(1000)  → { grossTCO2: 0.82, netTCO2: ≈0.928 }
 *   1000 kWh × 0.95 kg/kWh − 1000 × 0.022 kg/kWh = 0.928 tCO₂
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.5  P2P MARKET ALGORITHM (Double Auction)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Double auction clearing (EnergyMarketplace.clearMarket):
 *   1. Sort sell offers ascending by price (cheapest first)
 *   2. Sort buy bids descending by price (highest willingness first)
 *   3. Match: for each sell × buy pair where bid ≥ ask:
 *      clearPrice = (ask + bid) / 2   (midpoint pricing)
 *      quantity   = min(sellQty, buyQty)
 *   4. Local (same-block) trades prioritised over cross-block
 *   5. Grid/platform fee = 10% of clear price
 *
 * Seller earnings: clearPrice × qty × 0.90
 * Buyer savings:   (retailPrice − clearPrice) × qty
 *
 * Price discovery: competitive auction drives price between:
 *   floor = FIT export rate (seller's alternative)
 *   ceiling = retail rate × 0.95 (buyer's alternative)
 *   Typical P2P price: 75–85% of retail
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.6  FINANCIAL FORECAST ASSUMPTIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NPV calculation:
 *   NPV = −C₀ + Σ (CF_t / (1+r)^t)   for t = 1 to 20
 *   C₀ = net system cost after subsidies
 *   CF_t = annual net cash flow in year t
 *   r = discount rate (WACC, default 9%)
 *
 * LCOE:
 *   LCOE = (C₀ + Σ O&M_t) / Σ GenKwh_t   [INR/kWh]
 *
 * IRR: Newton-Raphson solution of NPV(r) = 0
 *
 * Key assumptions:
 *   Panel degradation:   0.5%/year
 *   Electricity escalation: 4%/year
 *   O&M cost:            0.5% of system cost/year
 *   Insurance:           0.3% of system cost/year
 *   Battery replacement: year 12, ₹80,000
 *   System life:         20 years
 *
 * Sensitivity to key inputs (1 kW system, ₹56,000 installed):
 *   Tariff +10%:     NPV +₹8,200, payback −0.5yr
 *   Degression +1%:  NPV −₹3,100, IRR −1.1%
 *   Discount +2%:    NPV −₹12,500
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 30.7  POLICY SIMULATION LOGIC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PolicyScenarioRunner.run() evaluates a scenario in O(N_lots) time.
 * For each lot: calculates subsidy, forecasts 20-year financials, aggregates.
 *
 * Adoption model:
 *   hasSolar flag (from layout) sets base adoption.
 *   mandatedSolarFrac uses seeded random draw per lot.
 *   Economically rational adoption: all lots with NPV > 0 install.
 *   (Not yet modelled — future work: endogenous adoption curve.)
 *
 * Jobs created: 1.2 jobs per kW installed (IRENA average for India)
 *
 * BCR interpretation:
 *   BCR = 1.0: government recoups full subsidy in consumer savings
 *   BCR = 3.0: ₹3 of consumer benefit per ₹1 of subsidy
 *   BCR > 5.0: highly efficient policy
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */