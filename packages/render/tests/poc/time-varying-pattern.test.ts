import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { degToRad, material, Mesh, perspectiveCamera, RapidRenderer, type Mat4, type Vec3 } from "@vgpu/render";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SNAPSHOT_DIR = "packages/render/tests/poc/__snapshots__";

const vertex = `
struct VertexIn { @location(0) position: vec3f, @location(1) normal: vec3f };
struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f };
@vertex fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.viewProjection * uniforms.model * vec4f(input.position, 1.0);
  out.normal = input.normal;
  return out;
}`;
const fragment = `
@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let color = vec3f(sin(uniforms.time), cos(uniforms.time), 0.5);
  let shade = 0.55 + 0.45 * max(dot(normalize(input.normal), normalize(vec3f(0.4, 0.6, 0.7))), 0.0);
  return vec4f(color * shade, 1.0);
}`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("material box renders a time uniform pattern", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const color = device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"] });
  const depth = device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });
  const mat = material({ device, vertex, fragment, uniforms: { viewProjection: "mat4x4f", model: "mat4x4f", time: "f32" }, vertexLayout: "position-normal", targetFormat: FORMAT, depthFormat: "depth24plus" });
  const camera = perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: vec3([2, 2, 3]), target: vec3([0, 0, 0]) });
  mat.writeUniforms({ viewProjection: camera.viewProjectionMatrix, model: identity(), time: 0 });
  await new RapidRenderer(device).draw({ material: mat, mesh: Mesh.box({ device }), target: color.createView(), depthTarget: depth.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 } });
  await expect(await color.read()).toMatchImageSnapshot({ testName: "time-varying-pattern", width: WIDTH, height: HEIGHT, threshold: 0, snapshotDir: SNAPSHOT_DIR });
  mat.dispose(); depth.destroy(); color.destroy(); device.destroy();
});

function vec3(values: [number, number, number]): Vec3 { return new Float32Array(values) as Vec3; }
function identity(): Mat4 { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4; }
