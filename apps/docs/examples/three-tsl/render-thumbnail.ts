import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { effect, sampler, type Gpu, type Target } from "vgpu";
import { createDemoCamera, createDemoScene } from "./scenes";
import { createOutputPipeline } from "./post";

/**
 * Thumbnails for this example are the one place the two renderers have to meet.
 *
 * Everywhere else three.js owns its own device and its own canvas. Here the
 * harness hands us a vgpu `Gpu` and a vgpu `Target`, so we:
 *
 *   1. build three's `WebGPURenderer` on the *harness's* `GPUDevice`, so both
 *      libraries allocate from one device and no cross-device copy is needed;
 *   2. let three render into a `RenderTarget` it owns (three keeps control of
 *      format, depth and MSAA — nothing here reaches into its internals);
 *   3. blit that texture into the vgpu target with a vgpu `effect`, binding
 *      three's `GPUTexture` straight into the bind group.
 *
 * Step 3 is why this is a blit and not a direct render into `target`: the
 * harness's texture is `render_attachment | texture_binding | copy_src` with no
 * `copy_dst`, so it can be drawn into but not copied into — and three cannot be
 * pointed at a foreign attachment without patching its texture bookkeeping.
 * Sampling three's output instead keeps both public APIs intact and costs one
 * fullscreen pass with no CPU roundtrip.
 */
const PRESENT_WGSL = `
@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var src_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(src_tex, src_samp, uv);
}
`;

/**
 * three.js reaches for browser globals during construction even when it never
 * paints to a canvas. These are the exact four it touches on this path, stubbed
 * narrowly rather than pulling in a DOM shim: `navigator.gpu` decides WebGPU vs
 * the WebGL2 fallback, `self` + `requestAnimationFrame` back its animation loop
 * (which we never start), and `VideoFrame` is an `instanceof` target in the
 * texture size probe.
 */
function installHeadlessGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.self ??= globalThis;
  globals.requestAnimationFrame ??= () => 0;
  globals.cancelAnimationFrame ??= () => {};
  globals.VideoFrame ??= class VideoFrame {};
  if (globalThis.navigator && (globalThis.navigator as { gpu?: unknown }).gpu === undefined) {
    Object.defineProperty(globalThis.navigator, "gpu", {
      value: {
        getPreferredCanvasFormat: () => "bgra8unorm",
        // The renderer is always constructed with an explicit `device`, so
        // three never requests an adapter on this path; vgpu's Node adapter
        // descriptor is not a GPUAdapter, so there is nothing truthful to
        // return here. null makes three report "WebGPU is not available"
        // instead of crashing on a wrong-shaped object if that ever changes.
        requestAdapter: async () => null,
      },
      configurable: true,
    });
  }
}

/** Minimal stand-in for the canvas three wants but never presents to. */
function headlessCanvas(width: number, height: number): unknown {
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
          throw new Error("three-tsl thumbnails render offscreen, never to a swapchain.");
        },
      };
    },
  };
}

/**
 * The HDRI is a static asset rather than a baked-in fixture, so the thumbnail
 * reads the same file the browser fetches. `thumbs`, `thumbs:check` and
 * `render:proof` all run with the docs package as cwd, which the first
 * candidate covers. The `import.meta.url` candidates cover a non-docs cwd for
 * both places this module can execute from: the harness's esbuild bundle at
 * apps/docs/.thumbs-cache/renderers.mjs (one level below the docs root) and
 * this source file itself (two levels below it).
 */
async function readHdri(): Promise<ArrayBuffer> {
  const relative = path.join("public", "examples", "three-tsl", "sunset.exr");
  const moduleDir = fileURLToDir(import.meta.url);
  const candidates = [
    path.resolve(process.cwd(), relative),
    path.resolve(moduleDir, "..", relative),
    path.resolve(moduleDir, "..", "..", relative),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const buffer = await readFile(candidate);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ) as ArrayBuffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `three-tsl thumbnail could not read ${relative} (looked in ${candidates.join(", ")}): ${String(lastError)}`
  );
}

function fileURLToDir(url: string): string {
  return path.dirname(new URL(url).pathname);
}

interface ThumbnailOptions {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
}

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  opts: ThumbnailOptions = {}
): Promise<void> {
  const device = gpu.gpu as GPUDevice;
  // three/webgpu is already evaluated at module load (scenes.ts imports it
  // statically), which is safe in r180 — nothing gpu- or DOM-touching runs at
  // its module scope. What actually needs the globals below in place is
  // WebGPURenderer *construction*, which happens after this call.
  installHeadlessGlobals();

  const [width, height] = output.color.size as readonly [number, number];

  let renderer: THREE.WebGPURenderer | undefined;
  let scene: Awaited<ReturnType<typeof createDemoScene>> | undefined;
  let renderTarget: THREE.RenderTarget<THREE.Texture> | undefined;
  let post: ReturnType<typeof createOutputPipeline> | undefined;
  let primaryError: unknown;
  let failed = false;

  try {
    renderer = new THREE.WebGPURenderer({
      canvas: headlessCanvas(width, height) as HTMLCanvasElement,
      device,
      antialias: false,
    });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // The harness destroys the device once it has read the pixels back, which
    // three would otherwise report as a device-loss error on every snapshot.
    // The loss is expected teardown here, not a failure.
    renderer.onDeviceLost = async () => {};
    await renderer.init();

    // Decode the HDRI from bytes: `loadAsync` goes through FileLoader, which
    // needs a fetchable URL, and Node's fetch has no `file://` support. `parse`
    // returns raw texel data rather than a Texture, so wrap it the way
    // DataTextureLoader would have.
    const exr = new EXRLoader().parse(await readHdri()) as {
      data: Uint16Array | Float32Array;
      width: number;
      height: number;
      format?: THREE.PixelFormat;
      type?: THREE.TextureDataType;
      colorSpace?: string;
      flipY?: boolean;
    };
    const hdri = new THREE.DataTexture(exr.data, exr.width, exr.height);
    if (exr.format !== undefined) hdri.format = exr.format;
    if (exr.type !== undefined) hdri.type = exr.type;
    if (exr.colorSpace !== undefined) hdri.colorSpace = exr.colorSpace;
    if (exr.flipY !== undefined) hdri.flipY = exr.flipY;
    hdri.magFilter = THREE.LinearFilter;
    hdri.minFilter = THREE.LinearFilter;
    hdri.generateMipmaps = false;
    hdri.needsUpdate = true;

    // A constant time node freezes the material so the snapshot is byte-stable.
    const time = opts.time ?? 2.1;
    const dt = opts.dt ?? 1 / 60;
    const frozen = time + dt * Math.max(1, opts.warmupFrames ?? 3);
    scene = await createDemoScene({ renderer, timeNode: float(frozen), hdriTexture: hdri });

    const camera = createDemoCamera(width / height);
    renderTarget = new THREE.RenderTarget(width, height, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    // No MSAA on the still: the CPU/SwiftShader adapters these snapshots run
    // on do not consistently support multisampling on intermediate formats.
    post = createOutputPipeline(renderer, scene.scene, camera, { samples: 0 });

    // PostProcessing renders its fullscreen quad into whatever target the
    // renderer currently has bound, so setting it here is what redirects the
    // scene pass and output transform offscreen.
    renderer.setRenderTarget(renderTarget);
    await post.renderAsync();
    await device.queue.onSubmittedWorkDone();

    // `backend.get` is three's internal resource map; it is the only way to
    // reach the GPUTexture behind a RenderTarget, and is not on the public
    // Backend type.
    const backend = renderer.backend as unknown as {
      get(value: unknown): { texture: GPUTexture };
    };
    const source = backend.get(renderTarget.texture).texture;
    effect(gpu, PRESENT_WGSL, { label: "three-tsl-present" })
      .set({
        src_tex: source.createView(),
        src_samp: sampler(gpu, { magFilter: "linear", minFilter: "linear" }),
      })
      .draw(output);
  } catch (error) {
    primaryError = error;
    failed = true;
  }

  const barriers = await Promise.allSettled([
    Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
    Promise.resolve().then(() => gpu.settled()),
  ]);
  const rejected = barriers.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  let cleanupError = rejected?.reason;
  let cleanupFailed = rejected !== undefined;
  // One dispose throwing (e.g. against dead backend state after a device
  // error) must not strand the ones after it; the first failure is reported.
  for (const step of [post, renderTarget, scene, renderer]) {
    try {
      step?.dispose();
    } catch (error) {
      if (!cleanupFailed) cleanupError = error;
      cleanupFailed = true;
    }
  }

  if (failed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
}
