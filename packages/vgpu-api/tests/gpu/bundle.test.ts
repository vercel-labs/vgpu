import { describe, expect, test } from "vitest";
import { UniformPool } from "@vgpu/render";
import { init } from "../../src/node.ts";

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
    const gpu = await init({ size: [8, 8] });
    try {
      const scene = gpu.target({ size: [8, 8], format: "rgba8unorm" });
      const floor = gpu.pass(SOLID_GREEN, { label: "floor" });
      const player = gpu.pass(RIGHT_RED, { label: "player" });
      const staticScene = gpu.bundle({ target: scene, label: "staticScene" }, (b) => b.draw(floor));

      gpu.frame((f) => f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => {
        p.bundles(staticScene);
        p.draw(player);
      }));

      const pixels = await scene.read();
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

  test("§10 UniformPool dynamic offsets can draw 1000 pushed objects and sample selected offsets", async () => {
    const gpu = await init({ size: [4, 4] });
    try {
      const cube = gpu.draw({ shader: OFFSET_COLOR, label: "cube", set: { globals: { tint: 1 } } });
      const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
      const slot = pool.alloc({
        size: 4,
        bindGroupLayout: cube.layout(1),
        encode(value: number, dst: ArrayBuffer, byteOffset: number) { new DataView(dst).setFloat32(byteOffset, value, true); },
      });
      cube.group(1, slot.bindGroup);

      pool.beginFrame(1);
      const offsets = Array.from({ length: 1000 }, (_, index) => pool.push(slot, index / 999));
      pool.endFrame();

      for (const index of [0, 500, 999]) {
        const target = gpu.target({ size: [4, 4], format: "rgba8unorm" });
        gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(cube, { offsets: { 1: [offsets[index]!] } })));
        const pixel = rgbaAt(await target.read(), 4, 2, 2);
        expect(pixel[0]).toBeCloseTo(Math.round((index / 999) * 255), 1);
      }
    } finally {
      gpu.dispose();
    }
  });

  test("§9 ping-pong with bundles uses two explicit recordings without staleness", async () => {
    const gpu = await init({ size: [4, 4] });
    try {
      let read = gpu.target({ size: [4, 4], format: "rgba8unorm" });
      let write = gpu.target({ size: [4, 4], format: "rgba8unorm" });
      const seed = gpu.pass(SOLID_GREEN, { label: "seed" });
      const sim = gpu.pass(COPY, { label: "sim" });
      gpu.frame((f) => f.pass({ target: read, clear: [0, 0, 0, 1] }, (p) => p.draw(seed)));

      const even = gpu.bundle({ target: write, label: "even" }, (b) => { sim.set({ src: read }); b.draw(sim); });
      [read, write] = [write, read];
      const odd = gpu.bundle({ target: write, label: "odd" }, (b) => { sim.set({ src: read }); b.draw(sim); });
      [read, write] = [write, read];

      gpu.frame((f) => f.pass({ target: write }, (p) => p.bundles(even)));
      [read, write] = [write, read];
      gpu.frame((f) => f.pass({ target: write }, (p) => p.bundles(odd)));
      [read, write] = [write, read];

      const pixel = rgbaAt(await read.read(), 4, 2, 2);
      expect(pixel[1]).toBeGreaterThan(200);
    } finally {
      gpu.dispose();
    }
  });
});

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}
