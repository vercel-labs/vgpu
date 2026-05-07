import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device } from "@vgpu/core";
import { material, Mesh, type Material } from "@vgpu/render";
import { passSequence, renderTarget } from "@vgpu/render/passes";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm";
const SNAPSHOT_DIR = "packages/render/tests/integration/passes-visual/__snapshots__";
const VERT = /* wgsl */ `
struct VertexIn { @location(0) position: vec3f }
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.pos = vec4f(in.position, 1.0);
  out.uv = in.position.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("passes-visual invert red target to cyan", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const quad = Mesh.fullscreenQuad({ device });
  const red = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, label: "passes.invert.red" });
  const final = readableTexture(device, "passes.invert.final");
  passSequence([
    { mesh: quad, material: procedural(device, "return vec4f(1.0, 0.0, 0.0, 1.0);"), target: red },
    { mesh: quad, material: post(device, [red.color], "let s = textureSample(tex0, samp, in.uv); return vec4f(1.0 - s.rgb, 1.0);"), target: final },
  ], { device });
  await snapshot(final, "passes-visual-invert-red-to-cyan");
  cleanup(device, red.color, final);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("passes-visual black circle becomes red on green", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const quad = Mesh.fullscreenQuad({ device });
  const circle = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, label: "passes.black-circle" });
  const final = readableTexture(device, "passes.black-to-red.final");
  const blackCircle = "let d = distance(in.uv, vec2f(0.5)); if (d < 0.28) { return vec4f(0.0, 0.0, 0.0, 1.0); } return vec4f(0.0, 1.0, 0.0, 1.0);";
  const toRed = "let s = textureSample(tex0, samp, in.uv); if (s.r + s.g + s.b < 0.1) { return vec4f(1.0, 0.0, 0.0, 1.0); } return s;";
  passSequence([
    { mesh: quad, material: procedural(device, blackCircle), target: circle },
    { mesh: quad, material: post(device, [circle.color], toRed), target: final },
  ], { device });
  await snapshot(final, "passes-visual-black-circle-to-red");
  cleanup(device, circle.color, final);
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("passes-visual three pass stripe blur composite", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const quad = Mesh.fullscreenQuad({ device });
  const stripe = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, label: "passes.stripe" });
  const blurred = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, label: "passes.stripe.blur" });
  const final = readableTexture(device, "passes.stripe.final");
  const stripeBody = "let on = abs(in.uv.x - 0.5) < 0.025; return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0, 1.0, 0.0, 1.0), on);";
  const blurBody = "let t = 1.0 / f32(textureDimensions(tex0).x); var c = vec3f(0.0); for (var i: i32 = -24; i <= 24; i = i + 1) { c += textureSample(tex0, samp, in.uv + vec2f(f32(i) * t, 0.0)).rgb; } return vec4f(c / 49.0, 1.0);";
  const compositeBody = "let base = textureSample(tex0, samp, in.uv).rgb; let halo = textureSample(tex1, samp, in.uv).rgb; let glow = max(halo.r, halo.g) * vec3f(0.0, 0.35, 2.8); return vec4f(min(base + glow, vec3f(1.0)), 1.0);";
  passSequence([
    { mesh: quad, material: procedural(device, stripeBody), target: stripe },
    { mesh: quad, material: post(device, [stripe.color], blurBody), target: blurred },
    { mesh: quad, material: post(device, [stripe.color, blurred.color], compositeBody), target: final },
  ], { device });
  await snapshot(final, "passes-visual-three-pass-stripe-halo");
  cleanup(device, stripe.color, blurred.color, final);
});

function procedural(device: Device, body: string): Material {
  return material({ device, vertex: VERT, fragment: `@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f { ${body} }`, uniforms: {}, vertexLayout: "position-only", targetFormat: FORMAT, depthFormat: null });
}

function post(device: Device, textures: readonly { readonly gpu: GPUTexture }[], body: string): Material & { readonly bindGroup: GPUBindGroup } {
  const bindings = textures.map((_, i) => `@group(0) @binding(${i + 1}) var tex${i}: texture_2d<f32>;`).join("\n");
  const shader = device.createShader(`@group(0) @binding(0) var samp: sampler;\n${bindings}\n${VERT}\n@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f { ${body} }`);
  const layout = device.gpu.createBindGroupLayout({ entries: [
    { binding: 0, visibility: frag(), sampler: { type: "filtering" } },
    ...textures.map((_, i) => ({ binding: i + 1, visibility: frag(), texture: { sampleType: "float" as const } })),
  ] });
  const bindGroup = device.gpu.createBindGroup({ layout, entries: [
    { binding: 0, resource: device.gpu.createSampler({ magFilter: "linear", minFilter: "linear" }) },
    ...textures.map((tex, i) => ({ binding: i + 1, resource: tex.gpu.createView() })),
  ] });
  return { pipeline: device.gpu.createRenderPipeline({ layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] }, fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: FORMAT }] }, primitive: { topology: "triangle-list" } }), bindGroupLayout: layout, bindGroup, shader, uniformByteSize: 0, params: { baseColor: [0, 0, 0], metallic: 0, roughness: 0 } };
}

function readableTexture(device: Device, label: string) {
  return device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"], label });
}
async function snapshot(texture: ReturnType<typeof readableTexture>, name: string) {
  await expect(await texture.read()).toMatchImageSnapshot({ testName: name, width: WIDTH, height: HEIGHT, threshold: 0, snapshotDir: SNAPSHOT_DIR });
}
function cleanup(device: Device, ...textures: { destroy(): void }[]) { for (const texture of textures) texture.destroy(); device.destroy(); }
function frag(): GPUShaderStageFlags { return (globalThis.GPUShaderStage?.FRAGMENT ?? 2) as GPUShaderStageFlags; }
