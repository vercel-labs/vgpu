import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { UniformPool } from "../../src/core.ts";
import { init, bundle, draw, effect, frame, target } from "../../src/node.ts";

const SOLID_GREEN = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.0, 1.0, 0.0, 1.0);
}
`;

const RIGHT_RED = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (uv.x < 0.5) { discard; }
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`;

const COPY = `
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureLoad(src, vec2u(vec2f(uv) * vec2f(4.0, 4.0)), 0);
}
`;

const OFFSET_COLOR = `
struct Globals { tint: f32 }
struct Obj { value: f32 }
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> obj: Obj;
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> Out {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: Out;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(obj.value * globals.tint, 0.0, 0.0, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu bundle GPU acceptance", () => {
  test("§9 bundle replay and dynamic draw coexist in one pass", async () => {
    const gpu = await init();
    try {
      const scene = target(gpu, { size: [8, 8], format: "rgba8unorm" });
      const floor = effect(gpu, prepareShader(SOLID_GREEN), { label: "floor" });
      const player = effect(gpu, prepareShader(RIGHT_RED), { label: "player" });
      const staticScene = bundle(gpu, { target: scene, label: "staticScene" }, (b) => b.draw(floor));

      frame(gpu, (f) => f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => {
        p.bundles(staticScene);
        p.draw(player);
      }));

      const pixels = await scene.color.read({ mipLevel: 0, region: "all" });
      const left = rgbaAt(pixels, 8, 2, 4);
      const right = rgbaAt(pixels, 8, 6, 4);
      expect(left[1]).toBeGreaterThan(200);
      expect(left[0]).toBeLessThan(40);
      expect(right[0]).toBeGreaterThan(200);
      expect(right[1]).toBeLessThan(40);
    } finally {
      gpu.dispose();
    }
  });

  test("R4 wraps native async validation for raw claimed bind groups without metadata", async () => {
    const gpu = await init();
    try {
      const cube = draw(gpu, { shader: prepareShader(OFFSET_COLOR), label: "cube", set: { globals: { tint: 1 } } });
      const colorTarget = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const rawBuffer = gpu.device.gpu.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM });
      const rawLayout = gpu.device.gpu.createBindGroupLayout({
        label: "raw.static-layout",
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 4 } }],
      });
      const rawBindGroup = gpu.device.gpu.createBindGroup({
        label: "raw.static-bind-group",
        layout: rawLayout,
        entries: [{ binding: 0, resource: { buffer: rawBuffer, offset: 0, size: 4 } }],
      });

      cube.layout(1, { dynamicOffsets: true });
      cube.group(1, rawBindGroup);
      const errors: unknown[] = [];
      gpu.onError((error) => errors.push(error));
      const currentFrame = frame(gpu, (f) => f.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (p) => p.draw(cube, { offsets: { 1: [0] } })));

      await expect(currentFrame.done).resolves.toBeUndefined();
      expect(errors).toEqual([
        expect.objectContaining({
          code: "VGPU-R4-GROUP-VALIDATION",
          message: expect.stringContaining("WebGPU rejected claimed group 1 in 'cube'"),
          where: "cube.draw",
          detail: { drawLabel: "cube", group: 1 },
        }),
      ]);
    } finally {
      gpu.dispose();
    }
  });

  test("§10 UniformPool dynamic offsets can draw 1000 pushed objects and sample selected offsets", async () => {
    const gpu = await init();
    try {
      const cube = draw(gpu, { shader: prepareShader(OFFSET_COLOR), label: "cube", set: { globals: { tint: 1 } } });
      const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
      const slot = pool.alloc({
        size: 4,
        bindGroupLayout: cube.layout(1, { dynamicOffsets: true }),
        encode(value: number, dst: ArrayBuffer, byteOffset: number) { new DataView(dst).setFloat32(byteOffset, value, true); },
      });
      cube.group(1, slot.bindGroup);

      pool.beginFrame(1);
      const offsets = Array.from({ length: 1000 }, (_, index) => pool.push(slot, index / 999));
      pool.endFrame();

      const colorTarget = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      frame(gpu, (f) => f.pass({ target: colorTarget, clear: [0, 0, 0, 1] }, (p) => {
        for (const offset of offsets) p.draw(cube, { offsets: { 1: [offset] } });
      }));

      const pixel = rgbaAt(await colorTarget.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2);
      expect(pixel[0]).toBeGreaterThan(240);
    } finally {
      gpu.dispose();
    }
  });

  test("§9 ping-pong with bundles uses two stable effects without staleness", async () => {
    const gpu = await init();
    try {
      let read = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      let write = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const seed = effect(gpu, prepareShader(SOLID_GREEN), { label: "seed" });
      frame(gpu, (f) => f.pass({ target: read, clear: [0, 0, 0, 1] }, (p) => p.draw(seed)));

      const evenEffect = effect(gpu, prepareShader(COPY), { label: "sim-even", set: { src: read } });
      const even = bundle(gpu, { target: write, label: "even" }, (b) => b.draw(evenEffect));
      [read, write] = [write, read];
      const oddEffect = effect(gpu, prepareShader(COPY), { label: "sim-odd", set: { src: read } });
      const odd = bundle(gpu, { target: write, label: "odd" }, (b) => b.draw(oddEffect));
      [read, write] = [write, read];

      frame(gpu, (f) => f.pass({ target: write }, (p) => p.bundles(even)));
      [read, write] = [write, read];
      frame(gpu, (f) => f.pass({ target: write }, (p) => p.bundles(odd)));
      [read, write] = [write, read];

      const pixel = rgbaAt(await read.color.read({ mipLevel: 0, region: "all" }), 4, 2, 2);
      expect(pixel[1]).toBeGreaterThan(200);
    } finally {
      gpu.dispose();
    }
  });

  test("§9 rebinding one effect while recording another bundle stales the older bundle", async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const first = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const second = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const shared = effect(gpu, prepareShader(COPY), { label: "shared-sim", set: { src: first } });
      const older = bundle(gpu, { target: output, label: "older" }, (b) => b.draw(shared));
      bundle(gpu, { target: output, label: "newer" }, (b) => {
        shared.set({ src: second });
        b.draw(shared);
      });

      expect(() => frame(gpu, (f) => f.pass(output, (p) => p.bundles(older)))).toThrowError(
        expect.objectContaining({
          code: "VGPU-R3-BUNDLE-STALE",
          message:
            "bundle 'older' is stale: binding `src` (@group(0) @binding(0)) of draw\n" +
            "  'shared-sim' changed resource after recording. Bundles freeze commands and bind groups.\n" +
            "  Fix: re-record it → older = bundle(gpu, { target: scene }, ...)\n" +
            "  (re-recording is always your responsibility; the library only detects this).",
        }),
      );
    } finally {
      gpu.dispose();
    }
  });
});

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}
