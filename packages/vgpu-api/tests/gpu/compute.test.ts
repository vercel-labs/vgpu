import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const GRAVITY_COMPUTE = `
struct Sim { dt: f32 }
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&src)) { return; }
  let input = src[id.x];
  dst[id.x] = vec4f(input.xyz + vec3f(0.0, -9.8 * sim.dt, 0.0), input.w);
}
`;

const PING_PONG_PASS = `
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let prev = textureLoad(src, vec2u(uv * vec2f(4, 4)), 0);
  return vec4f(prev.r + 0.25, prev.g, prev.b, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("Lane C GPU compute + ping-pong", () => {
  test("§11 compute ping-pong storage sim updates Y velocity", async () => {
    const gpu = await init({ size: [1, 1] });
    try {
      const COUNT = 4;
      const dt = 0.125;
      const sim = gpu.compute(GRAVITY_COMPUTE, { label: "gravity" });
      const buffers = gpu.pingPongStorage(COUNT * 16);
      const initial = new Float32Array([
        0, 10, 0, 1,
        0, 5, 0, 1,
        0, 0, 0, 1,
        0, -5, 0, 1,
      ]);
      buffers.read.write(initial);
      buffers.write.write(initial);
      for (let step = 0; step < 4; step += 1) {
        sim.set({ sim: { dt }, src: buffers.read, dst: buffers.write });
        sim.dispatch(COUNT);
        buffers.swap();
      }
      const contents = new Float32Array(await buffers.read.read());
      expect(contents[1]).toBeLessThan(9.5);
      const expectedY = 10 - 9.8 * dt * 4;
      expect(Math.abs(contents[1] - expectedY)).toBeLessThan(0.05);
      expect(contents[0]).toBeCloseTo(0, 6);
      expect(contents[3]).toBeCloseTo(1, 6);
    } finally {
      gpu.dispose();
    }
  });

  test("§8 ping-pong render feedback accumulates color on read target", async () => {
    const gpu = await init({ size: [8, 8] });
    try {
      const pingPong = gpu.pingPong(4, 4, { format: "rgba8unorm", label: "pingpong" });
      const feedback = gpu.pass(PING_PONG_PASS, { label: "feedback" });
      for (let frame = 0; frame < 4; frame += 1) {
        gpu.frame((f) => {
          f.pass({ target: pingPong.write, clear: [0, 0, 0, 1] }, (p) => {
            feedback.set({ src: pingPong.read });
            p.draw(feedback);
          });
        });
        pingPong.swap();
      }
      const pixels = await pingPong.read.read();
      const pixel = pixels.slice(0, 4);
      expect(pixel[0]).toBeGreaterThan(240);
      expect(pixel[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });
});
