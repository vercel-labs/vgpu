import { describe, expect, test } from "vitest";
import { init } from "../../src/node.ts";
import { box, orbit, perspectiveCamera } from "../../src/scene.ts";

const LIT_WGSL = `
import { lambert } from "@vgpu/wgsl-std/light";

struct Camera { viewProjection: mat4x4f }
struct Model { matrix: mat4x4f }
struct Light { direction: vec3f, color: vec3f, intensity: f32 }

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> light: Light;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
};

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  let world = model.matrix * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = camera.viewProjection * world;
  out.normal = normalize((model.matrix * vec4f(normal, 0.0)).xyz);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let lit = lambert(in.normal, light.direction, light.color, light.intensity);
  return vec4f(lit, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("vgpu/scene Docker GPU acceptance", () => {
  test("lit cube renders non-black lighting over dark clear background", async () => {
    const gpu = await init({ size: [32, 32] });
    try {
      const target = gpu.target({ size: [32, 32], format: "rgba8unorm", depth: true, label: "litCube" });
      const cube = gpu.draw({ shader: LIT_WGSL, mesh: gpu.mesh(box({ size: 1 })), targets: [target] });
      const cam = perspectiveCamera({ fov: 45, aspect: 1, position: [2, 2, 3], target: [0, 0, 0] });

      cube.set({
        camera: { viewProjection: cam.viewProjection },
        model: { matrix: orbit(0, { radius: 0 }) },
        light: { direction: [-1, -1, -1], color: [1, 1, 1], intensity: 1 },
      });
      cube.draw({ target });

      const pixels = await target.read();
      const center = rgbaAt(pixels, 32, 16, 16);
      const corner = rgbaAt(pixels, 32, 1, 1);

      expect(center[0] + center[1] + center[2]).toBeGreaterThan(30);
      expect(corner[0]).toBeLessThan(20);
      expect(corner[1]).toBeLessThan(20);
      expect(corner[2]).toBeLessThan(25);
      expect(center[3]).toBe(255);
    } finally {
      gpu.dispose();
    }
  });
});

function rgbaAt(pixels: Uint8Array, width: number, x: number, y: number): readonly [number, number, number, number] {
  const offset = 4 * (y * width + x);
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!];
}
