"use client";

import { useRef, useState, useCallback, useMemo, Suspense } from "react";
import type { ComponentProps } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  PerspectiveCamera,
  Billboard,
  Text,
} from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

// --- Types ---

interface ModuleConfig {
  id: number;
  name: string;
  shortName: string;
  desc: string;
  angle: number;
  orbitRadius: number;
  color: string;
  colorHex: number;
  emissiveHex: number;
  cardIcon: string;
  cardDesc: string;
}

interface NodeProps {
  config: ModuleConfig;
  isHovered: boolean;
  onHover: (id: number | null) => void;
  orbitAngle: number;
  orbitRadius: number;
  time: number;
}

interface TooltipProps {
  module: ModuleConfig | null;
}

interface InfoCardsProps {
  hoveredId: number | null;
}

// --- Constants ---

const DEFAULT_ORBIT_RADIUS = 3.25;
const ORBIT_SPEED = 0.0008;
const FONT_URL =
  "https://fonts.gstatic.com/s/spacegrotesk/v15/V8mQoQDjQSkFtoMM3T6r8E7mF71Q-gozuFaPOMjozpy3.woff2";

type TextProps = ComponentProps<typeof Text>;

function SafeText({ font, ...props }: TextProps) {
  return (
    <Suspense fallback={null}>
      <Text font={font ?? FONT_URL} {...props} />
    </Suspense>
  );
}

const MODULES: ModuleConfig[] = [
  {
    id: 0,
    name: "F.S SCORE",
    shortName: "F.S SCORE",
    desc: "Analyzes rooftop size, solar irradiance, electricity usage, ROI, payback period, and lifetime savings to compute a viability score.",
    angle: Math.PI * 1.92,
    orbitRadius: 3.1,
    color: "#ff6e00",
    colorHex: 0xff6e00,
    emissiveHex: 0xff3300,
    cardIcon: "layers",
    cardDesc:
      "Scores solar feasibility across rooftop size, irradiance, electricity cost, ROI, and payback period.",
  },
  {
    id: 1,
    name: "FUTURE POTENTIAL",
    shortName: "FUTURE POTENTIAL",
    desc: "10-20 year electricity inflation modeling, carbon offset projections, and long-term ROI forecasting with live scenario analysis.",
    angle: Math.PI * 0.18,
    orbitRadius: 3.55,
    color: "#00d4aa",
    colorHex: 0x00d4aa,
    emissiveHex: 0x009977,
    cardIcon: "chart",
    cardDesc:
      "Projects 10-20 year savings, carbon offsets, and ROI with adjustable inflation modeling.",
  },
  {
    id: 2,
    name: "GOV. SUBSIDY",
    shortName: "GOV. SUBSIDY",
    desc: "Detects eligibility for PM Surya Ghar Yojana, calculates subsidy slabs, net metering credits, and guides documentation.",
    angle: Math.PI * 0.92,
    orbitRadius: 3.05,
    color: "#3b8fff",
    colorHex: 0x3b8fff,
    emissiveHex: 0x0044cc,
    cardIcon: "document",
    cardDesc:
      "Detects PM Surya Ghar eligibility, calculates subsidy slabs, and guides documentation.",
  },
  {
    id: 3,
    name: "ROOFTOP ANALYSIS",
    shortName: "ROOFTOP ANALYSIS",
    desc: "Performs roof orientation analysis, shadow detection, structural load capacity checks, and AI-optimized solar panel layout.",
    angle: Math.PI * 0.65,
    orbitRadius: 3.25,
    color: "#a855f7",
    colorHex: 0xa855f7,
    emissiveHex: 0x7020cc,
    cardIcon: "roof",
    cardDesc:
      "Roof orientation, shadow detection, load capacity checks, and AI-optimized panel layout.",
  },
];

const NODE_HEIGHTS: Record<number, number> = {
  0: 0.18,
  1: 0.06,
  2: -0.52,
  3: 0.26,
};

const LABEL_CONFIG: Record<
  number,
  { offset: [number, number, number]; align: "left" | "right" | "center" }
> = {
  0: { offset: [0.92, 0.2, 0], align: "left" },
  1: { offset: [1.05, -0.05, 0], align: "left" },
  2: { offset: [0, -1.05, 0], align: "center" },
  3: { offset: [-1.1, 0.25, 0], align: "right" },
};

// --- Utilities ---

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function nodePosition(angle: number, radius: number, time: number, id: number): THREE.Vector3 {
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const bob = Math.sin(angle * 1.6) * 0.18 + Math.sin(time * 0.6 + id * 1.1) * 0.05;
  const y = bob + (NODE_HEIGHTS[id] ?? 0);
  return new THREE.Vector3(x, y, z);
}

// --- Tooltip Overlay ---

function Tooltip({ module }: TooltipProps) {
  if (!module) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: "24px",
        right: "24px",
        width: "260px",
        background: "linear-gradient(140deg, rgba(8,8,12,0.92), rgba(12,12,18,0.92))",
        border: `1px solid ${module.color}`,
        borderRadius: "14px",
        padding: "16px 16px 18px",
        boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
        pointerEvents: "none",
        backdropFilter: "blur(6px)",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          letterSpacing: "3px",
          textTransform: "uppercase",
          color: module.color,
          marginBottom: "10px",
          fontWeight: 700,
        }}
      >
        Active Module
      </div>
      <div
        style={{
          fontSize: "16px",
          fontWeight: 800,
          letterSpacing: "0.08em",
          color: "#ffffff",
          textTransform: "uppercase",
          marginBottom: "8px",
        }}
      >
        {module.name}
      </div>
      <div
        style={{
          fontSize: "12px",
          lineHeight: 1.6,
          color: "rgba(255,255,255,0.6)",
          marginBottom: "12px",
        }}
      >
        {module.desc}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "2px",
          color: "rgba(255,255,255,0.4)",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "999px",
            background: module.color,
            boxShadow: `0 0 8px ${module.color}`,
            display: "inline-block",
          }}
        />
        {module.cardDesc}
      </div>
    </div>
  );
}

// --- Solar Sphere (center) ---

function SolarSphere({ isAnyHovered }: { isAnyHovered: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const halo1 = useRef<THREE.Mesh>(null!);
  const halo2 = useRef<THREE.Mesh>(null!);
  const ring1 = useRef<THREE.Mesh>(null!);
  const ring2 = useRef<THREE.Mesh>(null!);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pulse = 0.6 + 0.4 * Math.sin(t * Math.PI);
    if (meshRef.current) {
      const mat = meshRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = lerp(mat.emissiveIntensity, isAnyHovered ? 0.5 : pulse, 0.05);
      meshRef.current.rotation.y = t * 0.14;
    }
    if (halo1.current) halo1.current.scale.setScalar(1 + 0.07 * Math.sin(t * 1.5));
    if (halo2.current) halo2.current.scale.setScalar(1 + 0.05 * Math.sin(t * 1.5 + 1));
    if (ring1.current) ring1.current.rotation.y = t * 0.08;
    if (ring2.current) {
      ring2.current.rotation.z += 0.0009;
      ring2.current.rotation.y += 0.0004;
    }
  });

  return (
    <group>
      {/* Core */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[0.95, 48, 48]} />
        <meshStandardMaterial
          color="#ff7a00"
          emissive="#ff4a00"
          emissiveIntensity={0.95}
          roughness={0.15}
          metalness={0.1}
        />
      </mesh>

      {/* Outer halo layers */}
      <mesh ref={halo1}>
        <sphereGeometry args={[1.25, 16, 16]} />
        <meshBasicMaterial
          color="#ff5500"
          transparent
          opacity={0.04}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={halo2}>
        <sphereGeometry args={[1.65, 16, 16]} />
        <meshBasicMaterial
          color="#ff4400"
          transparent
          opacity={0.025}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Orbit ring 1 */}
      <mesh ref={ring1} rotation={[Math.PI / 2.6, 0, 0]}>
        <torusGeometry args={[1.9, 0.024, 10, 100]} />
        <meshBasicMaterial
          color="#ff7700"
          transparent
          opacity={0.45}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Orbit ring 2 */}
      <mesh ref={ring2} rotation={[Math.PI / 2, 0, Math.PI / 4.5]}>
        <torusGeometry args={[2.5, 0.015, 10, 100]} />
        <meshBasicMaterial
          color="#ffaa00"
          transparent
          opacity={0.2}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Center label */}
      <Billboard position={[0, -1.25, 0]}>
        <SafeText
          fontSize={0.11}
          color="#ff9940"
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.12}
        >
          SOLAR DECISION ENGINE
        </SafeText>
      </Billboard>
    </group>
  );
}

// --- Connection Lines ---

function ConnectionLine({
  start,
  end,
  color,
  isHovered,
  idx,
}: {
  start: THREE.Vector3;
  end: THREE.Vector3;
  color: number;
  isHovered: boolean;
  idx: number;
}) {
  const lineRef = useRef<THREE.Line>(null!);

  const points = useMemo(() => [start, end], [start.x, start.y, start.z, end.x, end.y, end.z]);
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    return geo;
  }, [points]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (lineRef.current) {
      const mat = lineRef.current.material as THREE.LineBasicMaterial;
      const baseOpacity = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.7 + idx * 1.15));
      mat.opacity = lerp(mat.opacity, isHovered ? 1.0 : baseOpacity, 0.08);
    }
  });

  return (
    <primitive object={new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }))} ref={lineRef} />
  );
}

// --- FS Score Node ---

function FSScoreNode({ isHovered, color, emissive }: { isHovered: boolean; color: number; emissive: number }) {
  const groupRef = useRef<THREE.Group>(null!);
  const heights = [0.11, 0.1, 0.09, 0.09, 0.08];
  const widths = [0.76, 0.65, 0.54, 0.43, 0.32];

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.position.y = Math.sin(t * 1.1) * 0.1;
    }
  });

  let y = -0.32;
  return (
    <group ref={groupRef}>
      {heights.map((h, j) => {
        const posY = y + h / 2;
        y += h + 0.055;
        return (
          <mesh key={j} position={[0, posY, 0]}>
            <boxGeometry args={[widths[j], h, widths[j] * 0.62]} />
            <meshStandardMaterial
              color={color}
              emissive={emissive}
              emissiveIntensity={isHovered ? 0.7 + j * 0.1 : 0.15 + j * 0.07}
              roughness={0.3}
              metalness={0.7}
            />
          </mesh>
        );
      })}
    </group>
  );
}

// --- Future Potential Node ---

function FuturePotentialNode({ isHovered, color, emissive }: { isHovered: boolean; color: number; emissive: number }) {
  const barRefs = useRef<THREE.Mesh[]>([]);
  const barHeights = [0.25, 0.44, 0.68, 0.94, 1.24];

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    barRefs.current.forEach((bar, j) => {
      if (!bar) return;
      const f = 1 + 0.14 * Math.sin(t * 1.6 + j * 0.55);
      bar.scale.y = f;
      bar.position.y = (barHeights[j] * f) / 2 - 0.48;
    });
  });

  return (
    <group>
      {barHeights.map((h, j) => (
        <mesh
          key={j}
          ref={(el) => { if (el) barRefs.current[j] = el; }}
          position={[-0.36 + j * 0.18, h / 2 - 0.48, 0]}
        >
          <boxGeometry args={[0.13, h, 0.13]} />
          <meshStandardMaterial
            color={color}
            emissive={emissive}
            emissiveIntensity={isHovered ? 0.8 + j * 0.06 : 0.2 + j * 0.055}
            roughness={0.2}
            metalness={0.8}
          />
        </mesh>
      ))}
      {/* Base platform */}
      <mesh position={[0, -0.52, 0]}>
        <boxGeometry args={[0.96, 0.045, 0.3]} />
        <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.1} roughness={0.5} metalness={0.6} />
      </mesh>
    </group>
  );
}

// --- Gov Subsidy Node ---

function GovSubsidyNode({ isHovered, color, emissive }: { isHovered: boolean; color: number; emissive: number }) {
  const stampRef = useRef<THREE.Mesh>(null!);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (stampRef.current) {
      stampRef.current.position.y = 0.5 + Math.abs(Math.sin(t * 1.9)) * 0.35;
      stampRef.current.rotation.y = t * 0.9;
      const mat = stampRef.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = isHovered ? 1.4 : 0.9 + 0.4 * Math.sin(t * 3.5);
    }
  });

  const slabWidths = [0.88, 0.84, 0.80, 0.92];
  const slabDepths = [0.64, 0.60, 0.56, 0.68];

  return (
    <group>
      {slabWidths.map((w, j) => (
        <mesh
          key={j}
          position={[0, j * 0.11 - 0.33, 0]}
          rotation={[0, j % 2 === 0 ? 0.06 : -0.06, 0]}
        >
          <boxGeometry args={[w, 0.065, slabDepths[j]]} />
          <meshStandardMaterial
            color={color}
            emissive={emissive}
            emissiveIntensity={isHovered ? 0.45 : 0.07 + j * 0.04}
            roughness={0.4}
            metalness={0.6}
          />
        </mesh>
      ))}
      {/* Stamp */}
      <mesh ref={stampRef} position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.12, 0.12, 0.05, 20]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={1.0}
          roughness={0.1}
          metalness={0.9}
        />
      </mesh>
    </group>
  );
}

// --- Rooftop Node ---

function RooftopNode({ isHovered, color, emissive }: { isHovered: boolean; color: number; emissive: number }) {
  const panelRefs = useRef<THREE.Mesh[]>([]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    panelRefs.current.forEach((p, i) => {
      if (!p) return;
      const mat = p.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = isHovered
        ? 0.9 + 0.3 * Math.sin(t * 2.5 + i * 0.4)
        : 0.4 + 0.25 * Math.sin(t * 2.2 + i * 0.6);
    });
  });

  const panels: Array<{ x: number; y: number; z: number; rx: number }> = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      panels.push({ x: -0.2 + c * 0.22, y: 0.32 - r * 0.15, z: -0.14 + r * 0.2, rx: -0.45 });
    }
  }

  return (
    <group>
      {/* Roof base */}
      <mesh position={[0, 0.06, 0]} rotation={[0, Math.PI / 4, 0]}>
        <coneGeometry args={[0.72, 0.72, 4, 1]} />
        <meshStandardMaterial
          color={color}
          emissive={emissive}
          emissiveIntensity={isHovered ? 0.25 : 0.08}
          roughness={0.72}
          metalness={0.2}
        />
      </mesh>
      {/* Solar panels */}
      {panels.map((p, i) => (
        <mesh
          key={i}
          ref={(el) => { if (el) panelRefs.current[i] = el; }}
          position={[p.x, p.y, p.z]}
          rotation={[p.rx, 0, 0]}
        >
          <boxGeometry args={[0.19, 0.02, 0.12]} />
          <meshStandardMaterial
            color={0x040a16}
            emissive={emissive}
            emissiveIntensity={0.5}
            roughness={0.1}
            metalness={0.95}
          />
        </mesh>
      ))}
    </group>
  );
}

// --- Module Node (orbital wrapper) ---

function ModuleNode({ config, isHovered, onHover, orbitAngle, orbitRadius, time }: NodeProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const ringRef = useRef<THREE.Mesh>(null!);

  const targetPos = nodePosition(orbitAngle, orbitRadius, time, config.id);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.position.lerp(targetPos, 0.06);
      const targetScale = isHovered ? 1.15 : 1.0;
      groupRef.current.scale.lerp(
        new THREE.Vector3(targetScale, targetScale, targetScale),
        0.09
      );
      groupRef.current.lookAt(0, groupRef.current.position.y, 0);
    }
    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = lerp(mat.opacity, isHovered ? 0.9 : 0.4, 0.06);
      ringRef.current.rotation.z = t * 0.6 + config.id;
    }
  });

  const nodeMap: Record<number,React.ReactNode> = {
    0: <FSScoreNode isHovered={isHovered} color={config.colorHex} emissive={config.emissiveHex} />,
    1: <FuturePotentialNode isHovered={isHovered} color={config.colorHex} emissive={config.emissiveHex} />,
    2: <GovSubsidyNode isHovered={isHovered} color={config.colorHex} emissive={config.emissiveHex} />,
    3: <RooftopNode isHovered={isHovered} color={config.colorHex} emissive={config.emissiveHex} />,
  };

  const labelConfig = LABEL_CONFIG[config.id] ?? { offset: [0, 1.05, 0], align: "center" };
  const anchorX =
    labelConfig.align === "left"
      ? "left"
      : labelConfig.align === "right"
      ? "right"
      : "center";

  return (
    <group ref={groupRef} position={targetPos}>
      {/* Glow ring beneath */}
      <mesh ref={ringRef} position={[0, -0.8, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.55, 0.035, 8, 52]} />
        <meshBasicMaterial
          color={config.colorHex}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* Module geometry */}
      {nodeMap[config.id]}

      {/* Hover hitbox (invisible) */}
      <mesh
        onPointerEnter={() => onHover(config.id)}
        onPointerLeave={() => onHover(null)}
      >
        <sphereGeometry args={[0.9, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Billboard label */}
      <Billboard position={labelConfig.offset}>
        <SafeText
          fontSize={0.14}
          color="rgba(255,255,255,0.95)"
          anchorX={anchorX}
          anchorY="middle"
          letterSpacing={0.14}
          textAlign={anchorX}
          outlineWidth={0.002}
          outlineColor="rgba(0,0,0,0.6)"
        >
          {config.shortName}
        </SafeText>
        <SafeText
          fontSize={0.095}
          color="rgba(255,255,255,0.45)"
          anchorX={anchorX}
          anchorY="middle"
          position={[0, -0.2, 0]}
          letterSpacing={0.06}
          textAlign={anchorX}
        >
          {config.id === 0 ? "Benefit Analysis" :
           config.id === 1 ? "Forecast" :
           config.id === 2 ? "Eligibility Intel" : "Technical Optimizer"}
        </SafeText>
      </Billboard>
    </group>
  );
}

// --- Orbital Angles Manager ---

function OrbitalSystem({ hoveredId, onHover }: { hoveredId: number | null; onHover: (id: number | null) => void }) {
  const anglesRef = useRef(MODULES.map((m) => m.angle));
  const timeRef = useRef(0);
  const [, forceUpdate] = useState(0);
  const positionsRef = useRef(
    MODULES.map((m) => nodePosition(m.angle, m.orbitRadius ?? DEFAULT_ORBIT_RADIUS, 0, m.id))
  );
  const tick = useRef(0);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    timeRef.current = t;
    anglesRef.current = anglesRef.current.map((a) => a + ORBIT_SPEED);
    positionsRef.current = anglesRef.current.map((a, i) =>
      nodePosition(a, MODULES[i].orbitRadius ?? DEFAULT_ORBIT_RADIUS, t, MODULES[i].id)
    );
    tick.current++;
    if (tick.current % 1 === 0) forceUpdate((n) => n + 1);
  });

  return (
    <>
      {MODULES.map((mod, i) => (
        <group key={mod.id}>
          <ModuleNode
            config={mod}
            isHovered={hoveredId === mod.id}
            onHover={onHover}
            orbitAngle={anglesRef.current[i]}
            orbitRadius={mod.orbitRadius ?? DEFAULT_ORBIT_RADIUS}
            time={timeRef.current}
          />
          <ConnectionLine
            start={new THREE.Vector3(0, 0, 0)}
            end={positionsRef.current[i]}
            color={mod.colorHex}
            isHovered={hoveredId === mod.id}
            idx={i}
          />
        </group>
      ))}
    </>
  );
}

// --- Camera Controller ---

function CameraController({ hoveredId }: { hoveredId: number | null }) {
  const { camera } = useThree();
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const targetZ = hoveredId !== null ? 7.1 : 8.4;
    const driftX = Math.sin(t * 0.12) * 0.35;
    const driftY = Math.sin(t * 0.1 + 1.2) * 0.08;
    const targetX = -1.4 + driftX;
    const targetY = 3.15 + driftY;
    camera.position.x = lerp(camera.position.x, targetX, 0.02);
    camera.position.z = lerp(camera.position.z, targetZ, 0.02);
    camera.position.y = lerp(camera.position.y, targetY, 0.02);
    camera.lookAt(0, 0.1, 0);
  });

  return null;
}

// --- Scene Environment ---

function SceneEnvironment() {
  const particlePos = useMemo(() => {
    const count = 1200;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 36;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 24;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 24;
    }
    return arr;
  }, []);

  const particleGeo = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(particlePos, 3));
    return geo;
  }, [particlePos]);

  const grid = useMemo(() => {
    const helper = new THREE.GridHelper(26, 30, 0x1a0a00, 0x0a0e1a);
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.transparent = true;
    mat.opacity = 0.22;
    return helper;
  }, []);

  return (
    <>
      {/* Lights */}
      <ambientLight intensity={0.95} color="#0a0a16" />
      <directionalLight position={[4, 7, 4]} intensity={1.1} color="#ffffff" />
      <pointLight position={[-5, 1, -5]} intensity={3.2} color="#ff6e00" distance={18} decay={2} />
      <pointLight position={[5, -2, 5]} intensity={1.05} color="#1e40af" distance={14} decay={2} />

      {/* Starfield */}
      <primitive
        object={new THREE.Points(particleGeo, new THREE.PointsMaterial({
          color: 0xffffff,
          size: 0.018,
          transparent: true,
          opacity: 0.22,
          sizeAttenuation: true,
        }))}
      />

      {/* Grid floor */}
      <primitive object={grid} position={[0, -3.05, 0]} />
    </>
  );
}

// --- Info Cards ---

function InfoCards({ hoveredId }: InfoCardsProps) {
  return (
    <div
      style={{
        padding: "42px 24px 80px",
        background: "#050505",
      }}
    >
      <div
        style={{
          maxWidth: "1120px",
          margin: "0 auto 24px",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            letterSpacing: "4px",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.35)",
          }}
        >
          Module Intelligence
        </div>
        <div
          style={{
            fontSize: "22px",
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginTop: "10px",
          }}
        >
          Decision Layer Highlights
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
          maxWidth: "1120px",
          margin: "0 auto",
        }}
      >
        {MODULES.map((mod) => {
          const isActive = hoveredId === mod.id;
          return (
            <div
              key={mod.id}
              style={{
                borderRadius: "16px",
                padding: "18px 18px 20px",
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${isActive ? mod.color : "rgba(255,255,255,0.08)"}`,
                boxShadow: isActive ? `0 12px 24px rgba(0,0,0,0.45), 0 0 18px ${mod.color}22` : "0 10px 20px rgba(0,0,0,0.35)",
                transform: isActive ? "translateY(-4px)" : "translateY(0)",
                transition: "transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "10px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    letterSpacing: "3px",
                    textTransform: "uppercase",
                    color: mod.color,
                    fontWeight: 700,
                  }}
                >
                  {mod.shortName}
                </div>
                <div
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "999px",
                    background: mod.color,
                    boxShadow: `0 0 8px ${mod.color}`,
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "rgba(255,255,255,0.6)",
                  lineHeight: 1.7,
                }}
              >
                {mod.cardDesc}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Main Export ---

export default function SolarDecisionOverview() {
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const handleHover = useCallback((id: number | null) => {
    setHoveredId(id);
  }, []);

  const hoveredModule = hoveredId !== null ? MODULES[hoveredId] : null;

  return (
    <div
      style={{
        background: "#050505",
        color: "#ffffff",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        width: "100%",
        minHeight: "100vh",
        overflowX: "hidden",
      }}
    >
      {/* -- Hero -- */}
      <div
        style={{
          padding: "72px 24px 52px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: "10px",
            letterSpacing: "5px",
            textTransform: "uppercase",
            color: "#ff6e00",
            marginBottom: "16px",
            fontWeight: 600,
            opacity: 0.85,
          }}
        >
          3D Architecture Visualization
        </div>
        <h1
          style={{
            fontSize: "clamp(32px, 5.5vw, 68px)",
            fontWeight: 900,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            lineHeight: 0.95,
            color: "#ffffff",
            marginBottom: "20px",
          }}
        >
          INTELLIGENT{" "}
          <span style={{ color: "#ff6e00" }}>SOLAR</span>
          <br />
          DECISION LAYERS
        </h1>
        <p
          style={{
            fontSize: "13px",
            color: "rgba(255,255,255,0.4)",
            maxWidth: "480px",
            margin: "0 auto",
            lineHeight: 1.75,
          }}
        >
          From feasibility scoring to subsidy optimization - everything required
          to deploy rooftop solar intelligently.
        </p>
        <div
          style={{
            width: "48px",
            height: "2px",
            background: "#ff6e00",
            margin: "28px auto 0",
            opacity: 0.55,
          }}
        />
      </div>

      {/* -- 3D Canvas -- */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "520px",
          background: "#050505",
        }}
      >
        <Canvas
          style={{ display: "block", width: "100%", height: "100%" }}
          gl={{ antialias: true, alpha: false }}
          onCreated={({ gl }) => gl.setClearColor("#050505", 1)}
        >
          <PerspectiveCamera makeDefault position={[0, 3.4, 8.6]} fov={48} near={0.1} far={120} />
          <CameraController hoveredId={hoveredId} />

          <SceneEnvironment />
          <SolarSphere isAnyHovered={hoveredId !== null} />
          <OrbitalSystem hoveredId={hoveredId} onHover={handleHover} />

          <EffectComposer>
            <Bloom
              intensity={0.55}
              luminanceThreshold={0.18}
              luminanceSmoothing={0.8}
              mipmapBlur
            />
            <Vignette eskil={false} offset={0.15} darkness={0.7} />
          </EffectComposer>
        </Canvas>

        {/* Tooltip overlay */}
        <Tooltip module={hoveredModule} />

        {/* Hover hint */}
        <div
          style={{
            position: "absolute",
            bottom: "16px",
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: "9px",
            letterSpacing: "2px",
            color: "rgba(255,255,255,0.2)",
            textTransform: "uppercase",
            pointerEvents: "none",
          }}
        >
          Hover a module node to inspect
        </div>
      </div>

      {/* -- Info Cards -- */}
      <InfoCards hoveredId={hoveredId} />
    </div>
  );
}
