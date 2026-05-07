import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device, type Texture } from "@vgpu/core";
import { Mesh, type Material } from "@vgpu/render";
import { pass, renderTargetMulti } from "@vgpu/render/passes";

const W = 128, H = 128, FORMAT: GPUTextureFormat = "rgba8unorm";
const VERTEX = `struct In { @location(0) position: vec3f }; struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }; @vertex fn vs_main(i: In) -> Out { var o: Out; o.pos = vec4f(i.position, 1); o.uv = i.position.xy * vec2f(.5, -.5) + vec2f(.5); return o; }`;
const COPY = `${VERTEX} @group(0) @binding(0) var s: sampler; @group(0) @binding(1) var t: texture_2d<f32>; @fragment fn fs_main(i: Out) -> @location(0) vec4f { return textureSample(t, s, i.uv); }`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("MRT color plus rgba8unorm entity-id picking snapshots", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const leftMesh = Mesh.fullscreenQuad({ device });
  const rightMesh = Mesh.fullscreenQuad({ device });
  const picking = await renderTargetMulti({ device, size: [W, H], colors: [
    { format: FORMAT, label: "picking.color", clearColor: [0, 0, 0, 1] },
    { format: FORMAT, label: "picking.entity-id", clearColor: [0, 0, 0, 1] },
  ] });
  pass({ mesh: leftMesh, material: entityMaterial(device, [1, .1, .05], 1), target: picking, scissor: [0, 0, W / 2, H] });
  pass({ mesh: rightMesh, material: entityMaterial(device, [.05, .25, 1], 2), target: picking, colorLoadOp: "load", scissor: [W / 2, 0, W / 2, H] });
  await snapshot(device, leftMesh, copyMaterial(device, picking.colors[0]), "render-target-mrt-picking-color");
  await snapshot(device, leftMesh, copyMaterial(device, picking.colors[1]), "render-target-mrt-picking-entity-id");
  picking.colors.forEach((t) => t.destroy());
  device.destroy();
});

async function snapshot(device: Device, mesh: Mesh, mat: Material, name: string) {
  const out = device.createTexture({ size: [W, H], format: FORMAT, usage: ["render_attachment", "copy_src"], label: name });
  pass({ mesh, material: mat, target: out });
  // Existing matcher uses pixelmatch threshold 0.1 and a 0.001 mismatch-ratio budget.
  await expect(await out.read()).toMatchImageSnapshot({ testName: name, width: W, height: H, threshold: 0.001 });
  out.destroy();
}

function entityMaterial(device: Device, color: readonly [number, number, number], id: number): Material {
  const shader = device.createShader(`struct O { @location(0) color: vec4f, @location(1) id: vec4f }; ${VERTEX} @fragment fn fs_main() -> O { return O(vec4f(${color[0]}, ${color[1]}, ${color[2]}, 1), vec4f(${id / 255}, 0, 0, 1)); }`);
  const layout = device.gpu.createBindGroupLayout({ entries: [] });
  return materialFrom(device, shader, layout, undefined, [FORMAT, FORMAT]);
}

function copyMaterial(device: Device, texture: Texture): Material {
  const shader = device.createShader(COPY);
  const layout = device.gpu.createBindGroupLayout({ entries: [
    { binding: 0, visibility: frag(), sampler: { type: "filtering" } },
    { binding: 1, visibility: frag(), texture: { sampleType: "float" } },
  ] });
  const bindGroup = device.gpu.createBindGroup({ layout, entries: [
    { binding: 0, resource: device.gpu.createSampler({ magFilter: "nearest", minFilter: "nearest" }) },
    { binding: 1, resource: texture.gpu.createView() },
  ] });
  return materialFrom(device, shader, layout, bindGroup, [FORMAT]);
}

function materialFrom(device: Device, shader: ReturnType<Device["createShader"]>, layout: GPUBindGroupLayout, bindGroup: GPUBindGroup | undefined, formats: GPUTextureFormat[]): Material {
  return { pipeline: device.gpu.createRenderPipeline({ layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] }, fragment: { module: shader.gpu, entryPoint: "fs_main", targets: formats.map((format) => ({ format })) }, primitive: { topology: "triangle-list" } }), bindGroupLayout: layout, bindGroup, shader, uniformByteSize: 0, params: { baseColor: [1, 1, 1], metallic: 0, roughness: 0 } };
}

function frag(): GPUShaderStageFlags { return (globalThis.GPUShaderStage?.FRAGMENT ?? 2) as GPUShaderStageFlags; }
