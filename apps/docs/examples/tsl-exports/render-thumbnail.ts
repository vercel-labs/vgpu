import * as THREE from "three/webgpu";
import { effect, sampler, type Gpu, type Target } from "vgpu";

import { createScene } from "./renderer";

const PRESENT_WGSL = `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let linear = textureSample(source_texture, source_sampler, uv).rgb;
  return vec4f(pow(linear, vec3f(1.0 / 2.2)), 1.0);
}
`;

function installHeadlessGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.self ??= globalThis;
  globals.requestAnimationFrame ??= () => 0;
  globals.cancelAnimationFrame ??= () => {};
  globals.VideoFrame ??= class VideoFrame {};
  if ((globalThis.navigator as { gpu?: unknown }).gpu === undefined) {
    Object.defineProperty(globalThis.navigator, "gpu", {
      configurable: true,
      value: {
        getPreferredCanvasFormat: () => "bgra8unorm",
        requestAdapter: async () => null,
      },
    });
  }
}

function headlessCanvas(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getContext() {
      return {
        configure() {},
        unconfigure() {},
        getCurrentTexture() {
          throw new Error("tsl-exports thumbnails render offscreen.");
        },
      };
    },
  } as unknown as HTMLCanvasElement;
}

interface ThumbnailOptions {
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {},
): Promise<void> {
  installHeadlessGlobals();
  const device = gpu.gpu as GPUDevice;
  const [width, height] = output.color.size as readonly [number, number];
  const renderer = new THREE.WebGPURenderer({
    canvas: headlessCanvas(width, height),
    device,
    antialias: false,
  });
  renderer.onDeviceLost = async () => {};

  const failures: unknown[] = [];
  let demo: ReturnType<typeof createScene> | undefined;
  let renderTarget: THREE.RenderTarget | undefined;

  try {
    await renderer.init();
    demo = createScene(width / Math.max(height, 1));
    demo.mesh.rotation.y = (options.time ?? 2.4) * 0.25;
    renderTarget = new THREE.RenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });

    renderer.setRenderTarget(renderTarget);
    await renderer.renderAsync(demo.scene, demo.camera);
    await device.queue.onSubmittedWorkDone();

    const backend = renderer.backend as unknown as {
      get(value: unknown): { texture: GPUTexture };
    };
    const source = backend.get(renderTarget.texture).texture;
    effect(gpu, PRESENT_WGSL, { label: "tsl-exports-present" })
      .set({
        source_texture: source.createView(),
        source_sampler: sampler(gpu, {
          magFilter: "linear",
          minFilter: "linear",
        }),
      })
      .draw(output);
  } catch (error) {
    failures.push(error);
  }

  for (const result of await Promise.allSettled([
    Promise.resolve().then(() => device.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ])) {
    if (result.status === "rejected") failures.push(result.reason);
  }

  for (const cleanup of [
    () => renderTarget?.dispose(),
    () => demo?.dispose(),
    () => renderer.dispose(),
  ]) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) throw failures[0];
}
