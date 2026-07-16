import { Worker } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const RED = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`;

const GREEN_BY_RESOLUTION = `
struct Params { resolution: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let edge = select(0.0, 0.25, params.resolution.x > 10.0);
  return vec4f(edge, 1.0, 0.0, 1.0);
}
`;

const BLUE = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.0, 0.0, 1.0, 1.0);
}
`;

const YELLOW = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 0.0, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("Surface Docker GPU acceptance", () => {
  test("§7.14 surface render, resize, re-render, and readback use the new physical size", async () => {
    const gpu = await init();
    try {
      const canvas = gpuCanvasLike(8, 8, true);
      const surface = gpu.surface(canvas, { dpr: 1, autoResize: false, label: "gpuSurface" });
      const red = gpu.pass(RED, { label: "surfaceRed" });
      gpu.frame((frame) => frame.pass({ target: surface }, (pass) => pass.draw(red)));
      expect(rgbaAt(await surface.read(), 8, 4, 4)).toEqual([255, 0, 0, 255]);

      surface.resize([12, 4]);
      const green = gpu.pass(GREEN_BY_RESOLUTION, { label: "surfaceGreen", set: { resolution: surface.size } });
      gpu.frame((frame) => frame.pass({ target: surface }, (pass) => pass.draw(green)));
      const pixels = await surface.read();
      expect(surface.size).toEqual([12, 4]);
      expect(pixels.byteLength).toBe(12 * 4 * 4);
      const pixel = rgbaAt(pixels, 12, 6, 2);
      expect(pixel[0]).toBeGreaterThan(40);
      expect(pixel[1]).toBeGreaterThan(240);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test("§7.15 worker-style OffscreenCanvas surface resizes manually and updates a derived target", async () => {
    const result = await runWorkerSurfaceScenario();
    expect(result).toMatchObject({ initial: [16, 8], resized: [20, 10], half: [10, 5] });
    expect(result.pixel[2]).toBeGreaterThan(240);
    expect(result.pixel[3]).toBe(255);
  });

  test("§7.16 multi-canvas surfaces render and read back independently", async () => {
    const gpu = await init();
    try {
      const a = gpu.surface(gpuCanvasLike(6, 6, true), { dpr: 1, label: "surfaceA" });
      const b = gpu.surface(gpuCanvasLike(5, 5, true), { dpr: 1, label: "surfaceB" });
      const blue = gpu.pass(BLUE, { label: "blue" });
      const yellow = gpu.pass(YELLOW, { label: "yellow" });

      gpu.frame((frame) => {
        frame.pass({ target: a }, (pass) => pass.draw(blue));
        frame.pass({ target: b }, (pass) => pass.draw(yellow));
      });

      expect(rgbaAt(await a.read(), 6, 3, 3)).toEqual([0, 0, 255, 255]);
      expect(rgbaAt(await b.read(), 5, 2, 2)).toEqual([255, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });
});

function gpuCanvasLike(width: number, height: number, layoutBacked: boolean): HTMLCanvasElement {
  let configured: GPUCanvasConfiguration | undefined;
  let current: GPUTexture | undefined;
  let currentSize: readonly [number, number] | undefined;
  const canvas: Record<string, unknown> = {
    width,
    height,
    getContext(kind: string) {
      if (kind !== "webgpu") return null;
      return {
        configure(desc: GPUCanvasConfiguration) { configured = desc; current = undefined; currentSize = undefined; },
        unconfigure() { current?.destroy(); current = undefined; currentSize = undefined; configured = undefined; },
        getCurrentTexture() {
          if (!configured) throw new Error("Canvas context is not configured");
          const nextSize = [canvas.width as number, canvas.height as number] as const;
          if (!current || !currentSize || currentSize[0] !== nextSize[0] || currentSize[1] !== nextSize[1]) {
            current?.destroy();
            current = configured.device.createTexture({
              size: nextSize,
              format: configured.format,
              usage: configured.usage ?? defaultCanvasUsage(),
            });
            currentSize = nextSize;
          }
          return current;
        },
      } satisfies GPUCanvasContext;
    },
  };
  if (layoutBacked) {
    canvas.clientWidth = width;
    canvas.clientHeight = height;
  }
  return canvas as unknown as HTMLCanvasElement;
}

function defaultCanvasUsage(): GPUTextureUsageFlags {
  return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
}

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}

async function runWorkerSurfaceScenario(): Promise<{ initial: number[]; resized: number[]; half: number[]; pixel: number[] }> {
  const code = `
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { init } = await import(${JSON.stringify(new URL("../../dist/node.js", import.meta.url).href)});
      const gpu = await init();
      try {
        const canvas = (${workerCanvasSource()})(16, 8);
        const surface = gpu.surface(canvas);
        const half = gpu.target({ size: [Math.max(1, surface.size[0] / 2), Math.max(1, surface.size[1] / 2)] });
        const pass = gpu.pass(${JSON.stringify(BLUE)});
        surface.onResize(({ width, height }) => half.resize([width / 2, height / 2]));
        const initial = [...surface.size];
        surface.resize([20, 10]);
        gpu.frame((frame) => frame.pass({ target: half }, (p) => p.draw(pass)));
        const pixels = await half.read();
        const offset = 4 * (2 * half.size[0] + 5);
        parentPort.postMessage({ initial, resized: [...surface.size], half: [...half.size], pixel: [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]] });
      } finally {
        gpu.dispose();
      }
    })().catch((error) => parentPort.postMessage({ error: String(error?.stack || error) }));
  `;
  const worker = new Worker(code, { eval: true });
  return await new Promise((resolve, reject) => {
    worker.once("message", (message) => {
      if (message?.error) reject(new Error(message.error));
      else resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

function workerCanvasSource(): string {
  return `function(width, height) {
    let configured;
    let current;
    let currentSize;
    const usage = () => GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const canvas = {
      width,
      height,
      getContext(kind) {
        if (kind !== "webgpu") return null;
        return {
          configure(desc) { configured = desc; current = undefined; currentSize = undefined; },
          unconfigure() { if (current) current.destroy(); current = undefined; currentSize = undefined; configured = undefined; },
          getCurrentTexture() {
            if (!configured) throw new Error("Canvas context is not configured");
            const nextSize = [canvas.width, canvas.height];
            if (!current || !currentSize || currentSize[0] !== nextSize[0] || currentSize[1] !== nextSize[1]) {
              if (current) current.destroy();
              current = configured.device.createTexture({ size: nextSize, format: configured.format, usage: configured.usage || usage() });
              currentSize = nextSize;
            }
            return current;
          },
        };
      },
    };
    return canvas;
  }`;
}
