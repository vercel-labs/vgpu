import { describe, expect, test } from "vitest";
import { draw, effect, frame, init, sampler, target } from "../../src/node.ts";

const WRITE_DEPTH = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -3), vec2f(-1, 1), vec2f(3, 1));
  return vec4f(p[vi], 0.25, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
`;

// vgpu/node runs Dawn in compatibility mode, where depth textures only accept comparison samplers.
const READ_DEPTH = `
@group(0) @binding(0) var sceneDepth: texture_depth_2d;
@group(0) @binding(1) var depthCompare: sampler_comparison;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // "less" passes when the reference is less than the stored depth (0.25).
  let refAbove = textureSampleCompare(sceneDepth, depthCompare, uv, 0.5);
  let refBelow = textureSampleCompare(sceneDepth, depthCompare, uv, 0.1);
  return vec4f(refAbove, refBelow, 0.0, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("sampleable depth on Dawn", () => {
  test("depth written by a draw is read back by a later effect", async () => {
    const gpu = await init();
    try {
      const scene = target(gpu, { size: [8, 8], format: "rgba8unorm", depth: true, label: "scene" });
      const output = target(gpu, { size: [8, 8], format: "rgba8unorm", label: "output" });
      const geometry = draw(gpu, { shader: WRITE_DEPTH, vertices: 3, targets: [scene] });
      const fog = effect(gpu, READ_DEPTH, { label: "fog", set: { sceneDepth: scene, depthCompare: sampler(gpu, { compare: "less" }) } });
      frame(gpu, (current) => {
        current.pass({ target: scene, clear: [0, 0, 0, 1] }, (pass) => pass.draw(geometry));
        current.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => pass.draw(fog));
      });
      const pixels = await output.read();
      // Clip-space z = 0.25 is stored: reference 0.5 is not less than it, reference 0.1 is.
      // A depth buffer left at its clear value (1.0) would pass both references.
      expect(pixels[0]).toBe(0);
      expect(pixels[1]).toBe(255);
      expect(pixels[(7 * 8 + 7) * 4]).toBe(0);
      expect(pixels[(7 * 8 + 7) * 4 + 1]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });
});
