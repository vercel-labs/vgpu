import GUI from "lil-gui";
import { clock, frameLoop, surface, type Gpu, type Surface } from "vgpu";
import { orbit } from "vgpu/scene";

import {
  createOceanCamera,
  resizeOceanCamera,
  updateOceanCamera,
  type OceanCamera,
} from "./camera";
import { installOrbitInput } from "./orbit-input";
import { buildOcean, OCEAN_CAMERA, type OceanScene } from "./scene";

interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
}

interface ViewSettings {
  autoRotate: boolean;
  rotateSpeed: number;
}

export function createRenderer({ canvas }: RendererOptions) {
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let output: Surface | undefined;
  let scene: OceanScene | undefined;
  let camera: OceanCamera | undefined;
  let input: ReturnType<typeof installOrbitInput> | undefined;
  let gui: GUI | undefined;
  let loop: { stop(): void } | undefined;
  let unsubscribeResize: (() => void) | undefined;
  const view: ViewSettings = { autoRotate: false, rotateSpeed: 0.12 };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    runCleanups([
      () => loop?.stop(),
      () => unsubscribeResize?.(),
      () => input?.dispose(),
      () => gui?.destroy(),
      () => gpu?.dispose(),
    ]);
  }

  function fail(error: unknown): never {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the render, resize, or initialization error.
    }
    throw error;
  }

  function guard<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      return fail(error);
    }
  }

  function resizeScene(): void {
    guard(() => {
      if (!scene || !camera || !output) return;
      scene.resize(output.size);
      resizeOceanCamera(camera, output.size[0] / output.size[1]);
    });
  }

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }

    gpu = nextGpu;
    output = surface(gpu, canvas, { dpr: [1, 2] });
    scene = buildOcean(gpu, output.size);
    camera = createOceanCamera({
      ...OCEAN_CAMERA,
      aspect: output.size[0] / output.size[1],
    });
    input = installOrbitInput(canvas, camera.goal);
    const container = canvas.parentElement ?? undefined;
    gui = new GUI({ title: "Ocean", container });
    configureGui(gui, scene, view, () => guard(() => scene?.rebuildSpectrum()));
    unsubscribeResize = output.onResize(resizeScene);

    const time = clock(gpu);
    loop = frameLoop(gpu, (currentFrame) => {
      guard(() => {
        if (disposed || !output || !scene || !camera || !input) return;
        const dt = time.deltaTime;
        if (view.autoRotate) {
          orbit(camera.goal, dt * view.rotateSpeed, 0, {
            minPitch: -0.05,
            maxPitch: 1.35,
            minDistance: 20,
            maxDistance: 700,
          });
        }
        updateOceanCamera(camera, dt);
        scene.simulate(dt);
        scene.updateCamera(camera.viewProjection, camera.pose.position);
        currentFrame.pass({ target: scene.hdr, clear: scene.clear }, (pass) => {
          pass.draw(scene!.skydome);
          pass.draw(scene!.ocean);
        });
        currentFrame.pass(output, scene.composite);
      });
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}

export function configureGui(
  gui: GUI,
  scene: OceanScene,
  view: ViewSettings,
  rebuild: () => void
): void {
  Object.assign(gui.domElement.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "10",
    maxHeight: "calc(100% - 16px)",
    overflowY: "auto",
  });
  const p = scene.params;
  const waves = gui.addFolder("Waves");
  waves.add(p, "windSpeed", 2, 60, 0.5).name("wind speed").onChange(rebuild);
  waves.add(p, "windAngle", 0, 360, 1).name("wind angle").onChange(rebuild);
  waves.add(p, "amplitude", 0.2, 16, 0.1).onChange(rebuild);
  waves
    .add(p, "patchSize", 60, 600, 1)
    .name("patch size (m)")
    .onChange(rebuild);

  const look = gui.addFolder("Look");
  look.add(p, "heightScale", 0, 80, 0.5).name("height");
  look.add(p, "choppyScale", 0, 40, 0.5).name("choppiness");
  look.add(p, "foamScale", 0.05, 1.2, 0.01).name("foam");

  const sun = gui.addFolder("Sun");
  sun.add(p, "sunElevation", -2, 60, 0.5).name("elevation");
  sun.add(p, "sunAzimuth", 0, 360, 1).name("azimuth");

  const sim = gui.addFolder("Sim");
  sim.add(p, "timeScale", 0, 3, 0.05).name("speed");
  sim.add(view, "autoRotate").name("auto-rotate");
  sim.add(view, "rotateSpeed", 0.02, 0.6, 0.01).name("rotate speed");
}

function runCleanups(cleanups: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}
