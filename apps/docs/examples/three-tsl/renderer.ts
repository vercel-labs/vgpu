import * as THREE from "three/webgpu";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { createObjectDragControls } from "./object-drag-controls";
import {
  createDemoCamera,
  createDemoScene,
  DEMO_MESH_KINDS,
  type DemoMeshKind,
} from "./scenes";

export interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Positioned ancestor the lil-gui panel mounts into (top-right corner). */
  readonly container: HTMLElement;
}

export interface ExampleRenderer {
  /** Resolves once the first frame has been scheduled; rejects on setup failure. */
  readonly ready: Promise<void>;
  dispose(): void;
}

export function createRenderer({
  canvas,
  container,
}: RendererOptions): ExampleRenderer {
  let disposed = false;
  const cleanups: Array<() => void> = [];

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Run in reverse so the renderer outlives the objects that reference it.
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // A failed teardown step must not strand the ones after it.
      }
    }
  }

  const ready = (async () => {
    // Without this, WebGPURenderer silently falls back to its WebGL2 backend
    // on browsers without WebGPU — where the WGSL-sourced material can never
    // compile, leaving a permanently black canvas with no error. Throwing here
    // rejects `ready`, which the preview host surfaces as its error overlay.
    if (navigator.gpu === undefined) {
      throw new Error("WebGPU is not available in this browser.");
    }
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 1), 1.5));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    await renderer.init();
    if (disposed) {
      renderer.dispose();
      return;
    }
    cleanups.push(() => renderer.dispose());

    const scene = await createDemoScene({ renderer });
    if (disposed) {
      scene.dispose();
      return;
    }
    cleanups.push(() => scene.dispose());

    const camera = createDemoCamera(
      Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1)
    );
    const controls = createObjectDragControls(
      camera,
      scene.rotationRoot,
      canvas
    );
    cleanups.push(() => controls.dispose());

    // lil-gui, mounted inside the example card rather than lil-gui's default
    // fixed document-level placement, so it scrolls and unmounts with the demo.
    const gui = new GUI({ container, title: "lava" });
    gui.domElement.style.position = "absolute";
    gui.domElement.style.top = "0";
    gui.domElement.style.right = "0";
    gui.domElement.style.zIndex = "3";
    const settings: { mesh: DemoMeshKind } = { mesh: "sphere" };
    gui
      .add(settings, "mesh", [...DEMO_MESH_KINDS])
      .onChange((kind: DemoMeshKind) => scene.setMesh(kind));
    cleanups.push(() => gui.destroy());

    const resize = new ResizeObserver(() => {
      const width = Math.max(canvas.clientWidth, 1);
      const height = Math.max(canvas.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    });
    resize.observe(canvas);
    cleanups.push(() => resize.disconnect());

    renderer.setAnimationLoop((time) => {
      controls.update(time);
      renderer.render(scene.scene, camera);
    });
    cleanups.push(() => renderer.setAnimationLoop(null));
  })();

  return { ready, dispose };
}
