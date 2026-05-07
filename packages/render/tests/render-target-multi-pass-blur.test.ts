import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device } from "@vgpu/core";
import { material, Mesh, type Material } from "@vgpu/render";
import { pass, passSequence, renderTarget } from "@vgpu/render/passes";

const WIDTH = 256;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm";
const VERTEX = /* wgsl */ `
struct VertexIn { @location(0) position: vec3f }
struct VertexOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.pos = vec4f(in.position, 1.0);
  out.uv = in.position.xy * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}`;
const STRIPE_FRAGMENT = /* wgsl */ `
@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let inside = in.uv.x > 0.34 && in.uv.x < 0.66 && in.uv.y > 0.24 && in.uv.y < 0.76;
  return select(vec4f(0.02, 0.03, 0.12, 1.0), vec4f(1.0, 0.55, 0.0, 1.0), inside);
}`;
const BLUR_SHADER = /* wgsl */ `
@group(0) @binding(0) var sourceSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
${VERTEX}
fn tap(uv: vec2f, px: f32, weight: f32) -> vec3f {
  let texel = vec2f(px / f32(textureDimensions(sourceTexture).x), 0.0);
  return textureSample(sourceTexture, sourceSampler, uv + texel).rgb * weight;
}
@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  var color = tap(in.uv, 0.0, 0.20);
  color += tap(in.uv, 4.0, 0.18) + tap(in.uv, -4.0, 0.18);
  color += tap(in.uv, 8.0, 0.12) + tap(in.uv, -8.0, 0.12);
  color += tap(in.uv, 14.0, 0.07) + tap(in.uv, -14.0, 0.07);
  color += tap(in.uv, 22.0, 0.03) + tap(in.uv, -22.0, 0.03);
  return vec4f(color, 1.0);
}`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("multi-pass render target chain horizontally blurs sharp edges", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const quad = Mesh.fullscreenQuad({ device });
  const sceneTarget = await renderTarget({ device, size: [WIDTH, HEIGHT], format: FORMAT, label: "blur.scene" });
  const finalTarget = device.createTexture({ size: [WIDTH, HEIGHT], format: FORMAT, usage: ["render_attachment", "copy_src"], label: "blur.final" });

  passSequence([
    { mesh: quad, material: stripeMaterial(device), target: sceneTarget },
    { mesh: quad, material: horizontalBlurMaterial(device, sceneTarget.color), target: finalTarget },
  ] satisfies readonly Parameters<typeof pass>[0][], { device });

  await expect(await finalTarget.read()).toMatchImageSnapshot({
    testName: "render-target-multi-pass-blur",
    width: WIDTH,
    height: HEIGHT,
    threshold: 0.001,
  });
  sceneTarget.color.destroy();
  finalTarget.destroy();
  device.destroy();
});

function stripeMaterial(device: Device): Material {
  return material({ device, vertex: VERTEX, fragment: STRIPE_FRAGMENT, uniforms: {}, vertexLayout: "position-only", targetFormat: FORMAT, depthFormat: null });
}

function horizontalBlurMaterial(device: Device, source: { readonly gpu: GPUTexture }): Material & { readonly bindGroup: GPUBindGroup } {
  const shader = device.createShader(BLUR_SHADER);
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
      vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: FORMAT }] },
      primitive: { topology: "triangle-list" },
    }), bindGroupLayout: layout, bindGroup, shader, uniformByteSize: 0, params: { baseColor: [1, 1, 1], metallic: 0, roughness: 0 },
  };
}

function fragmentVisibility(): GPUShaderStageFlags { return (globalThis.GPUShaderStage?.FRAGMENT ?? 2) as GPUShaderStageFlags; }
