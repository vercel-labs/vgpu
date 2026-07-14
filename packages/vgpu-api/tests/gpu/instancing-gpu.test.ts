import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";

const INSTANCED_QUADS = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOut {
  let quad = array<vec2f, 6>(
    vec2f(-0.25, -0.35), vec2f(0.25, -0.35), vec2f(-0.25, 0.35),
    vec2f(-0.25, 0.35), vec2f(0.25, -0.35), vec2f(0.25, 0.35),
  );
  let centers = array<vec2f, 2>(vec2f(-0.45, 0.0), vec2f(0.45, 0.0));
  var out: VertexOut;
  out.position = vec4f(quad[vertex] + centers[instance], 0.0, 1.0);
  out.color = vec4f(0.0, 1.0, f32(instance), 1.0);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return in.color;
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu instancing GPU acceptance", () => {
  test("instanced quads render more than one visible copy", async () => {
    const gpu = await init({ size: [32, 16] });
    try {
      const target = gpu.target({ size: [32, 16], format: "rgba8unorm" });
      const quads = gpu.draw({ shader: INSTANCED_QUADS, label: "instanced-quads", vertices: 6, instances: 2 });

      gpu.frame((frame) => frame.pass({ target, clear: [0, 0, 0, 1] }, (pass) => pass.draw(quads)));

      const pixels = await target.read();
      const left = pixelAt(pixels, 32, 8, 8);
      const right = pixelAt(pixels, 32, 23, 8);

      expect(left[1]).toBeGreaterThan(200);
      expect(left[2]).toBeLessThan(50);
      expect(right[1]).toBeGreaterThan(200);
      expect(right[2]).toBeGreaterThan(200);
    } finally {
      gpu.dispose();
    }
  });
});

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): readonly number[] {
  return [...pixels.slice(4 * (y * width + x), 4 * (y * width + x) + 4)];
}
