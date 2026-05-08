import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device, type VGPUAdapter } from "@vgpu/core";
import { getMaterialDeclarations, material, wgslDeclarations, type MaterialSamplerSpec, type MaterialTextureSpec } from "@vgpu/render";

const vertex = `
struct VertexIn { @location(0) position: vec3<f32> };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4<f32> { return vec4<f32>(in.position, 1.0); }
`;
const uvVertex = `
struct VertexIn { @location(0) position: vec3<f32>, @location(1) uv: vec2<f32> };
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(in.position, 1.0);
  out.uv = in.uv;
  return out;
}
`;
const fragment = `@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;

test("material does not prepend texture declarations by default", async () => {
  const { device } = await testDevice();
  const mat = material({ device, vertex, fragment, uniforms: {}, textures: { albedo: "texture_2d_f32" }, vertexLayout: "position-only", targetFormat: "rgba8unorm" });
  expect(mat.shader.code).toBe(`\n${vertex}\n${fragment}`);
  expect(mat.shader.code).not.toContain("var albedo:");
  expect(mat.shader.code).not.toContain("var materialSampler:");
  expect(mat.samplerBindings.materialSampler).toBe(0);
  expect(mat.textureBindings.albedo).toBe(1);
  device.destroy();
});

test("default opt-out allows user-authored texture declarations", async () => {
  const { device } = await testDevice();
  const manualFragment = `
@group(0) @binding(0) var materialSampler: sampler;
@group(0) @binding(1) var albedo: texture_2d<f32>;
@fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(albedo, materialSampler, uv);
}`;
  const mat = material({ device, vertex: uvVertex, fragment: manualFragment, uniforms: {}, textures: { albedo: "texture_2d_f32" }, vertexLayout: "position-uv", targetFormat: "rgba8unorm" });
  expect(mat.shader.code).toBe(`\n${uvVertex}\n${manualFragment}`);
  expect(mat.shader.code.match(/var albedo:/g)).toHaveLength(1);
  expect(mat.textureBindings.albedo).toBe(1);
  device.destroy();
});

test("getMaterialDeclarations matches the autoDeclarations prepend", async () => {
  const { device } = await testDevice();
  for (const { textures, samplers, declarations } of declarationCases()) {
    const spec = { uniforms: {}, textures, samplers };
    const decls = getMaterialDeclarations(spec);
    const mat = material({ device, vertex, fragment, uniforms: {}, textures, samplers, vertexLayout: "position-only", targetFormat: "rgba8unorm", autoDeclarations: true });
    expect(decls).toBe(declarations);
    expect(mat.shader.code).toBe(`${decls}\n\n${vertex}\n${fragment}`);
  }
  device.destroy();
});

test("binding maps are identical with and without autoDeclarations", async () => {
  const { device } = await testDevice();
  const textures = { albedo: "texture_2d_f32", normal: { kind: "texture_2d_f32", sampler: "nearestSampler" } } as const;
  const samplers = { nearestSampler: "nearest-clamp" } as const;
  const off = material({ device, vertex, fragment, uniforms: {}, textures, samplers, vertexLayout: "position-only", targetFormat: "rgba8unorm" });
  const on = material({ device, vertex, fragment, uniforms: {}, textures, samplers, vertexLayout: "position-only", targetFormat: "rgba8unorm", autoDeclarations: true });
  expect(on.textureBindings).toEqual(off.textureBindings);
  expect(on.samplerBindings).toEqual(off.samplerBindings);
  device.destroy();
});

test("wgslDeclarations matches getMaterialDeclarations and supports custom groups", () => {
  const textures = { albedo: "texture_2d_f32" } as const;
  const matDecls = getMaterialDeclarations({ uniforms: {}, textures, samplers: undefined });
  expect(wgslDeclarations(textures, { albedo: 1 }, { materialSampler: 0 })).toBe(matDecls);
  expect(wgslDeclarations(textures, { albedo: 1 }, { materialSampler: 0 }, 2)).toBe("@group(2) @binding(1) var albedo: texture_2d<f32>;\n@group(2) @binding(0) var materialSampler: sampler;");
  expect(getMaterialDeclarations({ uniforms: {}, textures: {}, samplers: undefined })).toBe("");
  expect(getMaterialDeclarations({ uniforms: {}, textures: undefined, samplers: undefined })).toBe("");
});

function declarationCases(): readonly { readonly textures: Record<string, MaterialTextureSpec>; readonly samplers?: Record<string, MaterialSamplerSpec>; readonly declarations: string }[] {
  return [
    { textures: { albedo: "texture_2d_f32" }, declarations: "@group(0) @binding(1) var albedo: texture_2d<f32>;\n@group(0) @binding(0) var materialSampler: sampler;" },
    { textures: { albedo: { kind: "texture_2d_f32", sampler: "albedoSampler" } }, samplers: { albedoSampler: "nearest-clamp" }, declarations: "@group(0) @binding(1) var albedo: texture_2d<f32>;\n@group(0) @binding(0) var albedoSampler: sampler;" },
    { textures: { envMap: "texture_cube_f32" }, declarations: "@group(0) @binding(1) var envMap: texture_cube<f32>;\n@group(0) @binding(0) var materialSampler: sampler;" },
    { textures: { tiles: "texture_2d_array_f32" }, declarations: "@group(0) @binding(1) var tiles: texture_2d_array<f32>;\n@group(0) @binding(0) var materialSampler: sampler;" },
    { textures: { albedo: "texture_2d_f32", normal: { kind: "texture_2d_f32", sampler: "nearestSampler" }, envMap: "texture_cube_f32" }, samplers: { nearestSampler: "nearest-clamp" }, declarations: "@group(0) @binding(2) var albedo: texture_2d<f32>;\n@group(0) @binding(0) var materialSampler: sampler;\n@group(0) @binding(3) var normal: texture_2d<f32>;\n@group(0) @binding(1) var nearestSampler: sampler;\n@group(0) @binding(4) var envMap: texture_cube<f32>;" },
  ];
}

function testDevice(): Promise<{ readonly device: Device }> {
  return App.create({ adapter: adapter() });
}

function adapter(): VGPUAdapter {
  return process.env.VGPU_DOCKER_TEST === "1" ? createNodeAdapter() : createMockAdapter();
}
