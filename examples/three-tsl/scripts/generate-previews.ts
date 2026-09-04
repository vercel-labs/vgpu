// Generates previews/lava.png by running the three.js demo scene headless
// in Node on vgpu's Dawn-backed device — no browser involved.
//
//   pnpm --filter @vgpu/example-three-tsl previews
//
// vgpu/node creates the WebGPU device (see @vgpu/adapter-node's system
// requirements for the Vulkan ICD setup), three's WebGPURenderer is handed
// that same GPUDevice plus a stubbed canvas context, and the frame is read
// back from a RenderTarget through an output-transform-only chain.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const SIZE = 768;
const FRAME_TIME = 8;
const OUT_DIR = fileURLToPath(new URL("../previews/", import.meta.url));

// three's renderer touches a few browser globals at startup; stub the
// minimum before any three module loads.
function stubBrowserGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.self ??= globalThis;
  globals.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16);
  globals.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  globals.VideoFrame ??= class VideoFrame {};
  globals.ImageBitmap ??= class ImageBitmap {};
  globals.OffscreenCanvas ??= class OffscreenCanvas {};
  globals.HTMLCanvasElement ??= class HTMLCanvasElement {};
  globals.HTMLImageElement ??= class HTMLImageElement {};
  globals.HTMLVideoElement ??= class HTMLVideoElement {};
  globals.ProgressEvent ??= class ProgressEvent {
    readonly type: string;
    readonly lengthComputable: boolean;
    readonly loaded: number;
    readonly total: number;
    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
      this.type = type;
      this.lengthComputable = init.lengthComputable ?? false;
      this.loaded = init.loaded ?? 0;
      this.total = init.total ?? 0;
    }
  };
}

function setNavigatorGpu(): void {
  const stub = { gpu: { getPreferredCanvasFormat: () => "rgba8unorm" as GPUTextureFormat } };
  try {
    Object.defineProperty(globalThis, "navigator", { value: stub, configurable: true });
  } catch {
    (globalThis.navigator as unknown as Record<string, unknown>).gpu = stub.gpu;
  }
}

async function main(): Promise<void> {
  stubBrowserGlobals();
  setNavigatorGpu();

  const { init } = await import("vgpu/node");
  const THREE = await import("three/webgpu");
  const { float } = await import("three/tsl");
  const { createDemoCamera, createDemoScene } = await import("../src/scenes.ts");
  const { createOutputPipeline } = await import("../src/post.ts");

  // vgpu owns the device; three renders on it.
  const gpu = await init();
  const fakeContext = {
    configure() {},
    unconfigure() {},
    getCurrentTexture(): never { throw new Error("previews render offscreen only"); },
  };
  const fakeCanvas = {
    style: {},
    width: SIZE,
    height: SIZE,
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => null,
  };
  const renderer = new THREE.WebGPURenderer({
    device: gpu.gpu,
    context: fakeContext as unknown as GPUCanvasContext,
    canvas: fakeCanvas as unknown as HTMLCanvasElement,
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();

  const { scene } = await createDemoScene({ renderer, mesh: "sphere", timeNode: float(FRAME_TIME) });
  const camera = createDemoCamera(1);

  // The readback goes through the post chain so it carries the full output
  // transform (tone mapping + sRGB); render targets are otherwise linear
  // intermediates in three.
  const target = new THREE.RenderTarget(SIZE, SIZE);
  renderer.setRenderTarget(target);
  // Dawn's swiftshader backend rejects multisampled rgba16float, so the
  // scene pass runs single-sampled here; the preview size hides the AA.
  const postProcessing = createOutputPipeline(renderer, scene, camera, { samples: 1 });
  await postProcessing.renderAsync();
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE)) as Uint8Array;

  const png = new PNG({ width: SIZE, height: SIZE });
  // WebGPU framebuffers are top-left origin: rows come back top-down already.
  png.data.set(pixels.subarray(0, SIZE * SIZE * 4));
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}lava.png`;
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file}`);

  target.dispose();
  renderer.dispose();
  gpu.dispose();
}

await main();
