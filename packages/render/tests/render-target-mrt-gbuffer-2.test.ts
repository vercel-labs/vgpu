import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device, type Texture } from "@vgpu/core";
import { Mesh, type Material } from "@vgpu/render";
import { pass, renderTargetMulti } from "@vgpu/render/passes";

const W = 128, H = 128, FORMAT: GPUTextureFormat = "rgba8unorm";
const VERTEX = `struct In { @location(0) position: vec3f }; struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }; @vertex fn vs_main(i: In) -> Out { var o: Out; o.pos = vec4f(i.position, 1); o.uv = i.position.xy * vec2f(.5, -.5) + vec2f(.5); return o; }`;
const GBUFFER = `struct G { @location(0) color: vec4f, @location(1) normal: vec4f }; ${VERTEX} @fragment fn fs_main(i: Out) -> G { let d = distance(i.uv, vec2f(.5)); let mask = select(.25, 1.0, d < .34); let n = normalize(vec3f(i.uv * 2 - 1, 1)); return G(vec4f(i.uv.x * mask, .25, i.uv.y * mask, 1), vec4f(n.xy * .5 + .5, .8, 1)); }`;
const SAMPLE = `${VERTEX} @group(0) @binding(0) var s: sampler; @group(0) @binding(1) var a: texture_2d<f32>; @group(0) @binding(2) var b: texture_2d<f32>; @fragment fn fs_main(i: Out) -> @location(0) vec4f { let c = textureSample(a, s, i.uv); let n = textureSample(b, s, i.uv); return select(vec4f(n.rg, .2, 1), c, i.uv.x < .5); }`;
const COPY = `${VERTEX} @group(0) @binding(0) var s: sampler; @group(0) @binding(1) var t: texture_2d<f32>; @fragment fn fs_main(i: Out) -> @location(0) vec4f { return textureSample(t, s, i.uv); }`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("2-attachment GBuffer snapshots color, normal, and composite", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const quad = Mesh.fullscreenQuad({ device });
  const gbuffer = await renderTargetMulti({ device, size: [W, H], colors: [{ format: FORMAT, label: "gbuffer.color" }, { format: FORMAT, label: "gbuffer.normal" }] });
  pass({ mesh: quad, material: mrtMaterial(device, GBUFFER, [FORMAT, FORMAT]), target: gbuffer });
  await snapshot(device, quad, sampleMaterial(device, SAMPLE, [gbuffer.colors[0], gbuffer.colors[1]]), "render-target-mrt-gbuffer-2");
  await snapshot(device, quad, sampleMaterial(device, COPY, [gbuffer.colors[0]]), "render-target-mrt-gbuffer-2-color");
  await snapshot(device, quad, sampleMaterial(device, COPY, [gbuffer.colors[1]]), "render-target-mrt-gbuffer-2-normal");
  gbuffer.colors.forEach((t) => t.destroy());
  device.destroy();
});

async function snapshot(device: Device, mesh: Mesh, mat: Material, name: string) {
  const out = device.createTexture({ size: [W, H], format: FORMAT, usage: ["render_attachment", "copy_src"], label: name });
  pass({ mesh, material: mat, target: out });
  // Existing matcher uses pixelmatch threshold 0.1 and a 0.001 mismatch-ratio budget.
  await expect(await out.read()).toMatchImageSnapshot({ testName: name, width: W, height: H, threshold: 0.001 });
  out.destroy();
}

function mrtMaterial(device: Device, code: string, formats: GPUTextureFormat[]): Material {
  const shader = device.createShader(code);
  const layout = device.gpu.createBindGroupLayout({ entries: [] });
  return materialFrom(device, shader, layout, undefined, formats);
}

function sampleMaterial(device: Device, code: string, textures: readonly Texture[]): Material {
  const shader = device.createShader(code);
  const entries: GPUBindGroupLayoutEntry[] = [{ binding: 0, visibility: frag(), sampler: { type: "filtering" } }];
  textures.forEach((_, i) => entries.push({ binding: i + 1, visibility: frag(), texture: { sampleType: "float" } }));
  const layout = device.gpu.createBindGroupLayout({ entries });
  const bindGroup = device.gpu.createBindGroup({ layout, entries: [
    { binding: 0, resource: device.gpu.createSampler({ magFilter: "nearest", minFilter: "nearest" }) },
    ...textures.map((t, i) => ({ binding: i + 1, resource: t.gpu.createView() })),
  ] });
  return materialFrom(device, shader, layout, bindGroup, [FORMAT]);
}

function materialFrom(device: Device, shader: ReturnType<Device["createShader"]>, layout: GPUBindGroupLayout, bindGroup: GPUBindGroup | undefined, formats: GPUTextureFormat[]): Material {
  return { pipeline: device.gpu.createRenderPipeline({ layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] }, fragment: { module: shader.gpu, entryPoint: "fs_main", targets: formats.map((format) => ({ format })) }, primitive: { topology: "triangle-list" } }), bindGroupLayout: layout, bindGroup, shader, uniformByteSize: 0, params: { baseColor: [1, 1, 1], metallic: 0, roughness: 0 } };
}

function frag(): GPUShaderStageFlags { return (globalThis.GPUShaderStage?.FRAGMENT ?? 2) as GPUShaderStageFlags; }
