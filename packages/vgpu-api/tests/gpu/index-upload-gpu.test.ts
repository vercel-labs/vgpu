import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { init, draw, frame, geometry, target } from "../../src/node.ts";

// Issue #490: odd-length Uint16 index arrays are 2 mod 4 bytes, but WebGPU's writeBuffer needs a
// 4-byte multiple. Index buffers have no copy_src usage, so the upload is verified by drawing it.
const COLORED = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex fn vs_main(@location(0) position: vec2f, @location(1) color: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.color = color;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;

const SIZE = 8;
const GREEN = [0, 1, 0] as const;
const RED = [1, 0, 0] as const;
// 0-2: green lower-left half triangle. 3: red sentinel at the top-right corner; any index that
// reaches it paints red.
const TRIANGLE = vertices([[-1, -1, GREEN], [1, -1, GREEN], [-1, 1, GREEN], [1, 1, RED]]);
// Strip columns: (0,1,2), (1,2,3), (2,3,4) cover the left half and the lower-right triangle.
const STRIP = vertices([[-1, -1, GREEN], [-1, 1, GREEN], [0, -1, GREEN], [0, 1, GREEN], [1, -1, GREEN]]);

type Gpu = Awaited<ReturnType<typeof init>>;
type Pixel = readonly number[];

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu odd-length index upload GPU acceptance", () => {
  test("three Uint16 indices upload without a native error and draw their triangle", async () => {
    const gpu = await init();
    try {
      const pixels = await renderIndexed(gpu, TRIANGLE, new Uint16Array([0, 1, 2]));
      expect(at(pixels, 2, 5)).toEqual([0, 255, 0, 255]);
      expect(at(pixels, 7, 0)).toEqual([0, 0, 0, 255]);
      expect(at(pixels, 6, 6)).toEqual([0, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("a single Uint16 index uploads and draws nothing", async () => {
    const gpu = await init();
    try {
      const pixels = await renderIndexed(gpu, TRIANGLE, new Uint16Array([0]));
      expect(pixels.every((value, i) => value === (i % 4 === 3 ? 255 : 0))).toBe(true);
    } finally {
      gpu.dispose();
    }
  });

  test("five Uint16 strip indices draw all three strip triangles", async () => {
    const gpu = await init();
    try {
      const pixels = await renderIndexed(gpu, STRIP, new Uint16Array([0, 1, 2, 3, 4]), "triangle-strip");
      expect(at(pixels, 1, 1)).toEqual([0, 255, 0, 255]);
      expect(at(pixels, 2, 6)).toEqual([0, 255, 0, 255]);
      expect(at(pixels, 5, 7)).toEqual([0, 255, 0, 255]);
      expect(at(pixels, 7, 0)).toEqual([0, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("an odd-offset Uint16 subarray draws only its viewed indices", async () => {
    const gpu = await init();
    try {
      const backing = Uint16Array.of(3, 0, 1, 2, 3);
      const view = backing.subarray(1, 4);
      expect(view.byteOffset).toBe(2);
      const fromView = await renderIndexed(gpu, TRIANGLE, view);
      const direct = await renderIndexed(gpu, TRIANGLE, new Uint16Array([0, 1, 2]));
      expect(fromView).toEqual(direct);
      for (let i = 0; i < fromView.length; i += 4) expect(fromView[i]).toBe(0);
    } finally {
      gpu.dispose();
    }
  });

  test("4-byte-aligned Uint16 and Uint32 indices still render", async () => {
    const gpu = await init();
    try {
      const quad = await renderIndexed(gpu, TRIANGLE, new Uint16Array([0, 1, 2, 2, 1, 3]));
      expect(at(quad, 2, 5)).toEqual([0, 255, 0, 255]);
      expect(at(quad, 7, 0)[0]).toBeGreaterThan(200);
      const wide = await renderIndexed(gpu, TRIANGLE, new Uint32Array([0, 1, 2]));
      expect(at(wide, 2, 5)).toEqual([0, 255, 0, 255]);
      expect(at(wide, 7, 0)).toEqual([0, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("drawing past the logical index count is rejected before submission", async () => {
    const gpu = await init();
    try {
      const colorTarget = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
      const geo = geometry(gpu, { buffers: [TRIANGLE], indices: new Uint16Array([0, 1, 2]) });
      const drawable = draw(gpu, { shader: prepareShader(COLORED), label: "odd-indices", geometry: geo });
      gpu.device.gpu.pushErrorScope("validation");
      expect(() => drawable.draw({ target: colorTarget, indices: 4 })).toThrowError(/VGPU-MESH-RANGE-INVALID/);
      frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawable)));
      const pixels = await colorTarget.color.read({ mipLevel: 0, region: "all" });
      expect(await gpu.device.gpu.popErrorScope()).toBeNull();
      expect(at(pixels, 2, 5)).toEqual([0, 255, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });
});

/** Builds, draws, and reads one indexed geometry, asserting Dawn reported no validation error. */
async function renderIndexed(gpu: Gpu, buffer: typeof TRIANGLE, indices: Uint16Array | Uint32Array, topology: GPUPrimitiveTopology = "triangle-list"): Promise<Uint8Array> {
  gpu.device.gpu.pushErrorScope("validation");
  const colorTarget = target(gpu, { size: [SIZE, SIZE], format: "rgba8unorm" });
  const geo = geometry(gpu, { topology, buffers: [buffer], indices });
  const drawable = draw(gpu, { shader: prepareShader(COLORED), label: "index-upload", geometry: geo });
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawable)));
  const pixels = await colorTarget.color.read({ mipLevel: 0, region: "all" });
  const error = await gpu.device.gpu.popErrorScope();
  expect(error?.message ?? null).toBeNull();
  return pixels;
}

function vertices(points: readonly (readonly [number, number, readonly [number, number, number]])[]) {
  return {
    data: new Float32Array(points.flatMap(([x, y, color]) => [x, y, ...color])),
    attributes: { position: { format: "float32x2" as const, location: 0 }, color: { format: "float32x3" as const, location: 1 } },
  };
}

function at(pixels: Uint8Array, x: number, y: number): Pixel {
  return [...pixels.slice(4 * (y * SIZE + x), 4 * (y * SIZE + x) + 4)];
}
