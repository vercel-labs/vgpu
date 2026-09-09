import * as THREE from "three/webgpu";
import type { Node } from "three/webgpu";
import { positionLocal } from "three/tsl";
import { tslExports } from "vgpu/three";

import surfaceModule from "./surface.wgsl";

type SurfaceExports = {
  surfaceColor: {
    position: Node;
  };
};

const { surfaceColor } = tslExports<SurfaceExports>(surfaceModule)(
  "surfaceColor",
);

export interface DemoScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshPhysicalNodeMaterial;
  dispose(): void;
}

export interface ExampleRenderer {
  readonly ready: Promise<void>;
  dispose(): void;
}

export function createScene(aspect: number): DemoScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b18);

  const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 20);
  camera.position.set(0, 0, 3.4);

  const material = new THREE.MeshPhysicalNodeMaterial({
    metalness: 0.1,
    roughness: 0.32,
    clearcoat: 0.4,
  });
  material.colorNode = surfaceColor({ position: positionLocal });

  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.set(-0.25, 0.35, 0);
  scene.add(mesh);

  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(3, 2, 4);
  scene.add(key, new THREE.HemisphereLight(0x86a8ff, 0x261108, 1.2));

  return {
    scene,
    camera,
    mesh,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export function createRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}): ExampleRenderer {
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) cleanup();
  };

  const ready = (async () => {
    if (navigator.gpu === undefined) {
      throw new Error("WebGPU is not available in this browser.");
    }

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(
      Math.max(canvas.clientWidth, 1),
      Math.max(canvas.clientHeight, 1),
      false,
    );
    try {
      await renderer.init();
    } catch (error) {
      renderer.dispose();
      throw error;
    }
    if (disposed) {
      renderer.dispose();
      return;
    }
    cleanups.push(() => renderer.dispose());

    const demo = createScene(
      Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1),
    );
    cleanups.push(() => demo.dispose());

    const resize = () => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      demo.camera.aspect = width / height;
      demo.camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(resize);
    observer?.observe(canvas);
    cleanups.push(() => observer?.disconnect());

    renderer.setAnimationLoop((milliseconds) => {
      demo.mesh.rotation.y = milliseconds * 0.00025;
      renderer.render(demo.scene, demo.camera);
    });
    cleanups.push(() => renderer.setAnimationLoop(null));
  })().catch((error: unknown) => {
    dispose();
    throw error;
  });

  return { ready, dispose };
}
