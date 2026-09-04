import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { createLavaMaterial } from "./lava-material";
import { bakeLavaVolumes } from "./bake-lava";
import { applyNightEnvironment } from "./environment";

export type DemoMeshKind = "sphere" | "knot" | "plane";

export const DEMO_MESH_KINDS: readonly DemoMeshKind[] = [
  "sphere",
  "knot",
  "plane",
];

export interface DemoSceneOptions {
  /** Bakes the lava field volumes; required since the material reads them. */
  readonly renderer: THREE.WebGPURenderer;
  readonly mesh?: DemoMeshKind;
  /** Fixed frame time for deterministic stills; defaults to the live clock. */
  readonly timeNode?: Node;
  /** Where to fetch the HDRI from; defaults to the public asset URL. */
  readonly hdriUrl?: string;
  /** Already-decoded HDRI, used by the offline thumbnail run. */
  readonly hdriTexture?: THREE.Texture;
}

export interface DemoScene {
  readonly scene: THREE.Scene;
  readonly mesh: THREE.Mesh;
  /** Parent transformed by automatic spin and pointer orbit. */
  readonly rotationRoot: THREE.Group;
  /** Swap the demo geometry in place; the material and spin state carry over. */
  setMesh(kind: DemoMeshKind): void;
  dispose(): void;
}

/**
 * Geometry per mesh kind, plus the fixed tilt that frames it: the plane reads
 * as a lava floor only when pitched toward the camera; the solids sit level.
 */
function demoGeometry(kind: DemoMeshKind): {
  geometry: THREE.BufferGeometry;
  tiltX: number;
} {
  // Densities sized for the baked material: displacement is one low-frequency
  // volume tap, so the mesh only has to carry the silhouette — the previous
  // counts (96 / 400x64 / 256^2) were paying for per-vertex procedural noise
  // that no longer runs.
  if (kind === "knot")
    return {
      geometry: new THREE.TorusKnotGeometry(0.74, 0.28, 300, 48),
      tiltX: 0,
    };
  if (kind === "plane")
    return {
      geometry: new THREE.PlaneGeometry(4.4, 4.4, 192, 192),
      tiltX: -1.05,
    };
  return { geometry: new THREE.IcosahedronGeometry(1.45, 32), tiltX: 0 };
}

export function buildDemoMesh(
  kind: DemoMeshKind,
  material: THREE.Material
): THREE.Mesh {
  const { geometry, tiltX } = demoGeometry(kind);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = tiltX;
  return mesh;
}

/** The demo camera: slightly above, looking at the origin. */
export function createDemoCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 50);
  camera.position.set(0, 1.2, 4.2);
  camera.lookAt(0, 0, 0);
  return camera;
}

/** Scene, lights, environment, and mesh for the lava demo. */
export async function createDemoScene(
  options: DemoSceneOptions
): Promise<DemoScene> {
  const scene = new THREE.Scene();

  // HDRI ambient (backdrop stays black) plus a soft warm-neutral key; the
  // warm floor bounce fakes the glow lighting the crust back.
  const environment = await applyNightEnvironment(
    scene,
    options.hdriTexture ?? options.hdriUrl
  );
  const key = new THREE.DirectionalLight(0xf2e4d2, 1.8);
  key.position.set(3, 2.2, 2);
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0x3a3230, 0xb33a10, 0.25));

  const volumes = await bakeLavaVolumes(options.renderer, options.timeNode);
  const lava = createLavaMaterial({ volumes, timeNode: options.timeNode });
  const mesh = buildDemoMesh(options.mesh ?? "sphere", lava.material);
  const rotationRoot = new THREE.Group();
  rotationRoot.add(mesh);
  scene.add(rotationRoot);

  return {
    scene,
    mesh,
    rotationRoot,
    setMesh(kind) {
      // Same Mesh and rotation root throughout, so the material and accumulated
      // object orientation stay put; only geometry and framing tilt change.
      const { geometry, tiltX } = demoGeometry(kind);
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      mesh.rotation.x = tiltX;
    },
    dispose() {
      mesh.geometry.dispose();
      lava.material.dispose();
      volumes.dispose();
      environment.dispose();
    },
  };
}
