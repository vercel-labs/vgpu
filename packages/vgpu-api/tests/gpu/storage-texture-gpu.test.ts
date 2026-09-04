import { describe, expect, test } from "vitest";
import { compute, effect, frame, init, sampler, target, texture } from "../../src/node.ts";

const FILL_3D = `
@group(0) @binding(0) var lut: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  textureStore(lut, id, vec4f(f32(id.x) / 3.0, f32(id.y) / 3.0, f32(id.z) / 3.0, 1.0));
}
`;

const SAMPLE_3D = `
@group(0) @binding(0) var lut: texture_3d<f32>;
@group(0) @binding(1) var linear: sampler;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Sample the last depth slice at the texel centres so bilinear filtering returns exact values.
  return textureSample(lut, linear, vec3f(uv, 7.0 / 8.0));
}
`;

const FILL_2D = `
@group(0) @binding(0) var out: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  textureStore(out, id.xy, vec4f(f32(id.x) / 7.0, f32(id.y) / 7.0, 1.0, 1.0));
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("storage textures on Dawn", () => {
  test("compute writes a 2D storage texture that reads back", async () => {
    const gpu = await init();
    try {
      const out = texture(gpu, { size: [8, 8], format: "rgba8unorm", label: "fill-2d" });
      compute(gpu, FILL_2D, { label: "fill-2d", set: { out } }).dispatch(1, 1);
      const pixels = await out.read();
      expect(pixels.length).toBe(8 * 8 * 4);
      // texel (7, 0) -> r = 255, g = 0
      expect(pixels[7 * 4]).toBe(255);
      expect(pixels[7 * 4 + 1]).toBe(0);
      // texel (0, 7) -> r = 0, g = 255
      expect(pixels[7 * 8 * 4]).toBe(0);
      expect(pixels[7 * 8 * 4 + 1]).toBe(255);
      expect(pixels[2]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });

  test("compute writes a 3D storage texture sampled by a fragment shader", async () => {
    const gpu = await init();
    try {
      const lut = texture(gpu, { size: [4, 4, 4], format: "rgba16float", dimension: "3d", label: "lut" });
      compute(gpu, FILL_3D, { label: "fill-3d", set: { lut } }).dispatch(1, 1, 1);
      const output = target(gpu, { size: [4, 4], format: "rgba8unorm" });
      const view = effect(gpu, SAMPLE_3D, { label: "view-3d", set: { lut, linear: sampler(gpu) } });
      frame(gpu, (current) => current.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(view)));
      const pixels = await output.read();
      const at = (x: number, y: number) => [pixels[(y * 4 + x) * 4]!, pixels[(y * 4 + x) * 4 + 1]!, pixels[(y * 4 + x) * 4 + 2]!];
      expect(at(0, 0)).toEqual([0, 0, 255]);
      expect(at(3, 0)).toEqual([255, 0, 255]);
      expect(at(0, 3)).toEqual([0, 255, 255]);
      expect(at(3, 3)).toEqual([255, 255, 255]);
    } finally {
      gpu.dispose();
    }
  });
});
