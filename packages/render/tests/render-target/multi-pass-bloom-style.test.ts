import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device } from "@vgpu/core";
import { degToRad, Mesh, perspectiveCamera, srgb, type Material, type Mat4, type Vec3 } from "@vgpu/render";
import { pass, passSequence, renderTarget } from "@vgpu/render/passes";
import {
  LIT_SHADER_SOURCE as PBR_SHADER_SOURCE,
  UNIFORM_OFFSET_BASE_COLOR,
  UNIFORM_OFFSET_CAMERA_POSITION,
  UNIFORM_OFFSET_LIGHT_COLOR,
  UNIFORM_OFFSET_LIGHT_DIRECTION,
  UNIFORM_OFFSET_LIGHT_INTENSITY,
  UNIFORM_OFFSET_METALLIC,
  UNIFORM_OFFSET_MODEL,
  UNIFORM_OFFSET_ROUGHNESS,
  UNIFORM_OFFSET_VIEW_PROJECTION,
  litUniformsByteSize as UNIFORMS_BYTE_SIZE,
  VERTEX_BUFFER_LAYOUT,
} from "../fixtures/lit-material/lit-shader.ts";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
const VERTEX_LAYOUT = VERTEX_BUFFER_LAYOUT;
const POST_SHADER = /* wgsl */ `
@group(0) @binding(0) var sourceSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
struct VertexIn { @location(0) position: vec3f, @location(1) normal: vec3f };
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex
fn vs_main(in: VertexIn) -> VertexOut {
  let p = in.position.xy * 2.0;
  var out: VertexOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = p * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}
@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let scene = textureSample(sourceTexture, sourceSampler, in.uv).rgb;
  let glow = max(max(scene.r, scene.g), scene.b) * vec3f(0.22, 0.12, 0.04);
  return vec4f(scene * vec3f(1.1, 0.72, 0.45) + glow, 1.0);
}
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("multi-pass render target chain renders byte-equal to snapshot", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const sceneTarget = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, depth: true, label: "snapshot.scene" });
  const finalTarget = device.createTexture({
    size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"], label: "snapshot.final.color",
  });
  const mesh = Mesh.box({ device, size: 1 });

  const steps: readonly Parameters<typeof pass>[0][] = [
    { mesh, material: litBoxMaterial(device), target: sceneTarget, clearColor: { r: 0.02, g: 0.02, b: 0.04, a: 1 } },
    { mesh, material: textureTintMaterial(device, sceneTarget.color), target: finalTarget, clearColor: { r: 0, g: 0, b: 0, a: 1 } },
  ];
  passSequence(steps, { device });

  const pixels = await finalTarget.read();
  await expect(pixels).toMatchImageSnapshot({ testName: "render-target-multi-pass-bloom-style", width: WIDTH, height: HEIGHT, threshold: 0.001 });
  sceneTarget.depth?.destroy();
  sceneTarget.color.destroy();
  finalTarget.destroy();
  device.destroy();
});

function litBoxMaterial(device: Device): Material & { readonly bindGroup: GPUBindGroup } {
  const shader = device.createShader(PBR_SHADER_SOURCE);
  const layout = device.gpu.createBindGroupLayout({
    entries: [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: UNIFORMS_BYTE_SIZE } }],
  });
  const uniform = device.createBuffer({ size: UNIFORMS_BYTE_SIZE, usage: ["uniform", "copy_dst"], label: "snapshot.pbr.uniforms" });
  uniform.write(pbrUniforms());
  const bindGroup = device.gpu.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform.gpu } }] });
  return {
    pipeline: device.gpu.createRenderPipeline({
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_LAYOUT] },
      fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    }),
    bindGroupLayout: layout,
    shader,
    uniformByteSize: UNIFORMS_BYTE_SIZE,
    params: { baseColor: srgb(0xcc8844), metallic: 0, roughness: 0.5 },
    bindGroup,
  };
}

function textureTintMaterial(device: Device, source: { readonly gpu: GPUTexture }): Material & { readonly bindGroup: GPUBindGroup } {
  const shader = device.createShader(POST_SHADER);
  const layout = device.gpu.createBindGroupLayout({ entries: [
    { binding: 0, visibility: fragmentVisibility(), sampler: { type: "filtering" } },
    { binding: 1, visibility: fragmentVisibility(), texture: { sampleType: "float" } },
  ] });
  const bindGroup = device.gpu.createBindGroup({ layout, entries: [
    { binding: 0, resource: device.gpu.createSampler({ magFilter: "linear", minFilter: "linear" }) },
    { binding: 1, resource: source.gpu.createView() },
  ] });
  return {
    pipeline: device.gpu.createRenderPipeline({
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [VERTEX_LAYOUT] },
      fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
      primitive: { topology: "triangle-list" },
    }), bindGroupLayout: layout, shader, uniformByteSize: 0, params: { baseColor: [1, 1, 1], metallic: 0, roughness: 0 }, bindGroup,
  };
}

function pbrUniforms(): Float32Array<ArrayBuffer> {
  const camera = perspectiveCamera({ fovYRadians: degToRad(45), aspect: 1, near: 0.1, far: 100, position: vec3([2, 2, 3]), target: vec3([0, 0, 0]) });
  const out = new Float32Array(UNIFORMS_BYTE_SIZE / 4);
  out.set(camera.viewProjectionMatrix, UNIFORM_OFFSET_VIEW_PROJECTION / 4);
  out.set(rotateY(degToRad(30)), UNIFORM_OFFSET_MODEL / 4);
  out.set(camera.position, UNIFORM_OFFSET_CAMERA_POSITION / 4);
  out.set([-1, -1, -1], UNIFORM_OFFSET_LIGHT_DIRECTION / 4);
  out.set([1, 1, 1], UNIFORM_OFFSET_LIGHT_COLOR / 4);
  out[UNIFORM_OFFSET_LIGHT_INTENSITY / 4] = 1;
  out.set(srgb(0xcc8844), UNIFORM_OFFSET_BASE_COLOR / 4);
  out[UNIFORM_OFFSET_METALLIC / 4] = 0;
  out[UNIFORM_OFFSET_ROUGHNESS / 4] = 0.5;
  return out;
}

function vec3(values: [number, number, number]): Vec3 { return new Float32Array(values) as Vec3; }
function rotateY(radians: number): Mat4 {
  const c = Math.cos(radians), s = Math.sin(radians);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]) as Mat4;
}
function shaderVisibility(): GPUShaderStageFlags { return ((globalThis.GPUShaderStage?.VERTEX ?? 1) | (globalThis.GPUShaderStage?.FRAGMENT ?? 2)) as GPUShaderStageFlags; }
function fragmentVisibility(): GPUShaderStageFlags { return (globalThis.GPUShaderStage?.FRAGMENT ?? 2) as GPUShaderStageFlags; }
