import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { material, Mesh, RapidRenderer } from "@vgpu/render";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const SNAPSHOT_DIR = "packages/render/tests/poc/__snapshots__";

const vertex = `
struct VertexIn { @location(0) position: vec3f };
struct VertexOut { @builtin(position) position: vec4f, @location(0) clip: vec2f };
@vertex fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(input.position.xy, 0.0, 1.0);
  out.clip = input.position.xy;
  return out;
}`;
const fragment = `
fn sdf(point: vec3f) -> f32 { return length(point) - 0.3; }
@fragment fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let uv = (fragCoord.xy / uniforms.resolution) * 2.0 - vec2f(1.0, 1.0);
  let ro = vec3f(0.0, 0.0, 1.2);
  let rd = normalize(vec3f(uv, -1.0));
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < 28; i = i + 1) {
    let p = ro + rd * t;
    let d = sdf(p);
    if (d < 0.001) { hit = true; break; }
    t = t + d;
    if (t > 3.0) { break; }
  }
  if (!hit) { return vec4f(0.02, 0.03, 0.05, 1.0); }
  let p = ro + rd * t;
  let n = normalize(p);
  let light = max(dot(n, normalize(vec3f(0.5, 0.7, 0.4))), 0.0);
  return vec4f(vec3f(0.1, 0.4, 0.9) * (0.25 + 0.75 * light), 1.0);
}`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("fullscreen quad renders a raymarched sphere", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const color = device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"] });
  const mat = material({ device, vertex, fragment, uniforms: { time: "f32", resolution: "vec2f" }, vertexLayout: "position-only", targetFormat: FORMAT, depthFormat: null });
  mat.writeUniforms({ time: 0, resolution: [WIDTH, HEIGHT] });
  await new RapidRenderer(device).draw({ material: mat, mesh: Mesh.fullscreenQuad({ device }), target: color.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 } });
  await expect(await color.read()).toMatchImageSnapshot({ testName: "raymarched-sphere", width: WIDTH, height: HEIGHT, threshold: 0, snapshotDir: SNAPSHOT_DIR });
  mat.dispose(); color.destroy(); device.destroy();
});
