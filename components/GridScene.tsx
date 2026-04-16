"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import type { ThreeElements } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useRef } from "react";
import * as THREE from "three";

declare global {
  namespace JSX {
    interface IntrinsicElements extends ThreeElements {}
  }
}

type Vec3 = [number, number, number];

interface HouseProps {
  position: Vec3;
  color: THREE.ColorRepresentation;
}

interface FlowProps {
  start: Vec3;
  end: Vec3;
  color: THREE.ColorRepresentation;
}

interface GridSceneProps {
  data: unknown;
}

/* ---------------- HOUSE ---------------- */
function House({ position, color }: HouseProps) {
  return (
    <group position={position}>
      {/* base */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[2, 1, 2]} />
        <meshStandardMaterial color={color} />
      </mesh>

      {/* roof */}
      <mesh position={[0, 1.3, 0]}>
        <coneGeometry args={[1.5, 1, 4]} />
        <meshStandardMaterial color="#222" />
      </mesh>
    </group>
  );
}

/* ---------------- ENERGY FLOW ---------------- */
function Flow({ start, end, color }: FlowProps) {
  const ref = useRef<
    THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null
  >(null);

  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(...start),
    new THREE.Vector3(
      (start[0] + end[0]) / 2,
      3,
      (start[2] + end[2]) / 2
    ),
    new THREE.Vector3(...end),
  ]);

  useFrame((state) => {
    const t = (Math.sin(state.clock.elapsedTime * 2) + 1) / 2;
    const point = curve.getPoint(t);

    if (ref.current) {
      ref.current.position.set(point.x, point.y, point.z);
    }
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.2, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={2}
      />
    </mesh>
  );
}

/* ---------------- MAIN SCENE ---------------- */
export default function GridScene({ data }: GridSceneProps) {
  const hasData = data !== null && data !== undefined;

  return (
    <Canvas camera={{ position: [8, 6, 8] as Vec3, fov: 50 }}>
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} />

      <OrbitControls />

      {/* Houses */}
      <House position={[-3, 0, 0]} color="#4ade80" /> {/* A */}
      <House position={[3, 0, 2]} color="#60a5fa" /> {/* B */}
      <House position={[3, 0, -2]} color="#60a5fa" /> {/* C */}

      {/* FLOWS (only when result exists) */}
      {hasData ? (
        <>
          <Flow start={[-3, 1, 0]} end={[3, 1, 2]} color="#00f5ff" />
          <Flow start={[-3, 1, 0]} end={[3, 1, -2]} color="#00f5ff" />
          <Flow start={[6, 1, 0]} end={[3, 1, 2]} color="#f59e0b" />
        </>
      ) : null}
    </Canvas>
  );
}
