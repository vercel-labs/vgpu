import { expect, test } from "vitest";

const dockerGpuTest = test.skipIf(process.env.VGPU_DOCKER_TEST !== "1");

dockerGpuTest("renders an adapted function on the GPUDevice supplied by vgpu", async () => {
  const restoreBrowserGlobals = stubBrowserGlobals();

  try {
    const { init } = await import("vgpu/node");
    const THREE = await import("three/webgpu");
    const { vec3 } = await import("three/tsl");
    const { tslExports } = await import("vgpu/three");

    const gpu = await init();
    const fakeContext = {
      configure() {},
      unconfigure() {},
      getCurrentTexture(): never {
        throw new Error("renderer smoke test is offscreen-only");
      },
    };
    const fakeCanvas = {
      style: {},
      width: 4,
      height: 4,
      addEventListener() {},
      removeEventListener() {},
      getContext: () => null,
    };
    const renderer = new THREE.WebGPURenderer({
      device: gpu.gpu,
      context: fakeContext as unknown as GPUCanvasContext,
      canvas: fakeCanvas as unknown as HTMLCanvasElement,
    });
    const target = new THREE.RenderTarget(4, 4);
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = new THREE.MeshBasicNodeMaterial();

    try {
      await renderer.init();

      const { shadeColor } = tslExports(
        `
fn shadeColor(baseColor: vec3f) -> vec3f {
  return baseColor * vec3f(0.8, 0.6, 0.4);
}
`,
      )("shadeColor");
      material.colorNode = shadeColor({ baseColor: vec3(1, 1, 1) });

      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(geometry, material));
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
      camera.position.z = 1;

      renderer.setRenderTarget(target);
      gpu.gpu.pushErrorScope("validation");
      let pixels: Uint8Array;
      try {
        await renderer.renderAsync(scene, camera);
        pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 4, 4) as Uint8Array;
        await gpu.gpu.queue.onSubmittedWorkDone();
      } finally {
        expect(await gpu.gpu.popErrorScope()).toBeNull();
      }

      expect(pixels.byteLength).toBeGreaterThanOrEqual(4 * 4 * 4);
      expect(pixels.some((channel) => channel !== 0)).toBe(true);
    } finally {
      geometry.dispose();
      material.dispose();
      target.dispose();
      renderer.dispose();
      renderer.onDeviceLost = () => {};
      gpu.dispose();
    }
  } finally {
    restoreBrowserGlobals();
  }
});

function stubBrowserGlobals(): () => void {
  const names = [
    "self",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "VideoFrame",
    "ImageBitmap",
    "OffscreenCanvas",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "HTMLVideoElement",
    "ProgressEvent",
    "navigator",
  ] as const;
  const originalDescriptors = new Map(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
  );
  const globals = globalThis as Record<string, unknown>;

  globals.self ??= globalThis;
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => (
    setTimeout(() => callback(performance.now()), 16)
  );
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
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: { getPreferredCanvasFormat: () => "rgba8unorm" as GPUTextureFormat } },
    configurable: true,
  });

  return () => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
