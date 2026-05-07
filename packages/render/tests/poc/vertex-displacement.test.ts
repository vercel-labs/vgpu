import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { degToRad, material, Mesh, perspectiveCamera, RapidRenderer, type Mat4, type Vec3 } from "@vgpu/render";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SNAPSHOT_DIR = "packages/render/tests/poc/__snapshots__";

const vertex = `
struct VertexIn { @location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f };
struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f };
fn smoothNoise(p: vec3f) -> f32 {
  let n1 = sin(p.x * 4.1 + p.y * 3.7) * cos(p.z * 5.3);
  let n2 = sin(p.x * 7.3 - p.z * 2.9) * cos(p.y * 6.1) * 0.5;
  let n3 = sin(p.y * 11.7 + p.z * 9.1) * cos(p.x * 8.3) * 0.25;
  return (n1 + n2 + n3) / 1.75;
}
@vertex fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let noise = smoothNoise(input.position * 2.0);
  let displaced = input.position + input.normal * noise * uniforms.displacementAmount;
  out.position = uniforms.viewProjection * uniforms.model * vec4f(displaced, 1.0);
  out.normal = input.normal;
  return out;
}`;
const fragment = `
@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(normalize(input.normal) * 0.5 + 0.5, 1.0);
}`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("indexed sphere renders vertex displacement", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const color = device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"] });
  const depth = device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });
  const mat = material({ device, vertex, fragment, uniforms: { viewProjection: "mat4x4f", model: "mat4x4f", displacementAmount: "f32" }, vertexLayout: "position-normal-uv", targetFormat: FORMAT, depthFormat: "depth24plus" });
  const camera = perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: vec3([0, 0, 2.6]), target: vec3([0, 0, 0]) });
  mat.writeUniforms({ viewProjection: camera.viewProjectionMatrix, model: identity(), displacementAmount: 0.18 });
  await new RapidRenderer(device).draw({ material: mat, mesh: Mesh.sphere({ device, radius: 0.5, widthSegments: 32, heightSegments: 16 }), target: color.createView(), depthTarget: depth.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 } });
  await expect(await color.read()).toMatchImageSnapshot({ testName: "vertex-displacement", width: WIDTH, height: HEIGHT, threshold: 0, snapshotDir: SNAPSHOT_DIR });
  mat.dispose(); depth.destroy(); color.destroy(); device.destroy();
});

function vec3(values: [number, number, number]): Vec3 { return new Float32Array(values) as Vec3; }
function identity(): Mat4 { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4; }
