import { describe, expect, test } from "vitest";

import { createNodeAdapter } from "@vgpu/adapter-node";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { writeLayoutValue } from "./reflection-test-utils.ts";

const GPU_BUFFER_USAGE = { MAP_READ: 1, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, STORAGE: 128 } as const;
const GPU_TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 } as const;
const GPU_SHADER_STAGE = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } as const;
const GPU_MAP_MODE = { READ: 1 } as const;

type GpuCase = {
  readonly name: string;
  readonly declarations: string;
  readonly binding: string;
  readonly value: unknown;
  readonly reads: readonly string[];
  readonly expected: readonly number[];
};

const gpuCases: readonly GpuCase[] = [
  { name: "f32", declarations: "struct Params { x: f32 }", binding: "var<uniform> params: Params;", value: { x: 1.25 }, reads: ["params.x"], expected: [1.25] },
  { name: "vec2 plus scalar", declarations: "struct Params { xy: vec2f, z: f32 }", binding: "var<uniform> params: Params;", value: { xy: [2, 3], z: 4 }, reads: ["params.xy.x", "params.xy.y", "params.z"], expected: [2, 3, 4] },
  { name: "vec3 tail scalar", declarations: "struct Params { v: vec3f, w: f32 }", binding: "var<uniform> params: Params;", value: { v: [5, 6, 7], w: 8 }, reads: ["params.v.z", "params.w"], expected: [7, 8] },
  { name: "mat3x3 padded columns", declarations: "struct Params { m: mat3x3f }", binding: "var<uniform> params: Params;", value: { m: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, reads: ["params.m[0].z", "params.m[1].y", "params.m[2].x"], expected: [3, 5, 7] },
  { name: "mat3x2 storage", declarations: "struct Params { m: mat3x2f }", binding: "var<storage, read> params: Params;", value: { m: [1, 2, 3, 4, 5, 6] }, reads: ["params.m[0].y", "params.m[2].x"], expected: [2, 5] },
  { name: "uniform array f32 standard-layout natural stride", declarations: "struct Params { values: array<f32, 3> }", binding: "var<uniform> params: Params;", value: { values: [9, 10, 11] }, reads: ["params.values[0]", "params.values[2]"], expected: [9, 11] },
  { name: "storage array f32 stride 4", declarations: "struct Params { values: array<f32, 3> }", binding: "var<storage, read> params: Params;", value: { values: [12, 13, 14] }, reads: ["params.values[1]", "params.values[2]"], expected: [13, 14] },
  { name: "array vec3", declarations: "struct Params { values: array<vec3f, 2> }", binding: "var<storage, read> params: Params;", value: { values: [[1, 2, 3], [4, 5, 6]] }, reads: ["params.values[0].z", "params.values[1].y"], expected: [3, 5] },
  { name: "nested struct", declarations: "struct Inner { a: vec3f, b: f32 } struct Params { x: f32, inner: Inner }", binding: "var<uniform> params: Params;", value: { x: 1, inner: { a: [2, 3, 4], b: 5 } }, reads: ["params.x", "params.inner.a.y", "params.inner.b"], expected: [1, 3, 5] },
  { name: "array of structs", declarations: "struct Inner { a: vec3f, b: f32 } struct Params { items: array<Inner, 2> }", binding: "var<uniform> params: Params;", value: { items: [{ a: [1, 2, 3], b: 4 }, { a: [5, 6, 7], b: 8 }] }, reads: ["params.items[0].b", "params.items[1].a.z"], expected: [4, 7] },
  { name: "explicit align size", declarations: "struct Params { a: f32, @align(32) @size(32) b: f32 }", binding: "var<uniform> params: Params;", value: { a: 15, b: 16 }, reads: ["params.a", "params.b"], expected: [15, 16] },
  { name: "scalar mix", declarations: "struct Params { b: u32, c: i32, d: f32 }", binding: "var<storage, read> params: Params;", value: { b: 17, c: -18, d: 19 }, reads: ["f32(params.b)", "f32(params.c)", "params.d"], expected: [17, -18, 19] },
  { name: "alias vec4", declarations: "alias Real = f32; alias V = vec4<Real>; struct Params { color: V }", binding: "var<uniform> params: Params;", value: { color: [0.25, 0.5, 0.75, 1] }, reads: ["params.color.x", "params.color.z"], expected: [0.25, 0.75] },
  { name: "runtime storage array", declarations: "struct Item { p: vec3f, w: f32 }", binding: "var<storage, read> params: array<Item>;", value: [{ p: [1, 2, 3], w: 4 }, { p: [5, 6, 7], w: 8 }], reads: ["params[0].p.z", "params[1].w"], expected: [3, 8] },
  { name: "mixed hard case", declarations: "struct Inner { n: vec3f, q: f32 } struct Params { t: f32, v: vec2f, inner: Inner, m: mat3x3f, arr: array<vec3f, 2>, @align(32) tail: vec4f }", binding: "var<uniform> params: Params;", value: { t: 1, v: [2, 3], inner: { n: [4, 5, 6], q: 7 }, m: [8, 9, 10, 11, 12, 13, 14, 15, 16], arr: [[17, 18, 19], [20, 21, 22]], tail: [23, 24, 25, 26] }, reads: ["params.t", "params.inner.q", "params.m[2].z", "params.arr[1].y", "params.tail.w"], expected: [1, 7, 16, 21, 26] },
];

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("reflection layouts against GPU compute readback", () => {
  for (const item of gpuCases) test(item.name, async () => runGpuCase(item));
});

async function runGpuCase(item: GpuCase): Promise<void> {
  const source = `${item.declarations}\n@group(0) @binding(0) ${item.binding}\n@group(0) @binding(1) var<storage, read_write> out: array<f32>;\n@compute @workgroup_size(1) fn main() {\n${item.reads.map((expr, i) => `  out[${i}] = ${expr};`).join("\n")}\n}`;
  const reflected = await resolveShader({ entry: `/${item.name}.wgsl`, validate: true, modules: { [`/${item.name}.wgsl`]: source } });
  const layout = reflected.reflection.bindings.find((binding) => binding.name === "params")?.layout;
  if (!layout) throw new Error(`No layout reflected for ${item.name}`);
  const inputBytes = writeLayoutValue(layout, item.value);

  const device = await createNodeAdapter().requestDevice();
  try {
    const input = device.gpu.createBuffer({ size: inputBytes.byteLength, usage: (layout.addressSpace === "uniform" ? GPU_BUFFER_USAGE.UNIFORM : GPU_BUFFER_USAGE.STORAGE) | GPU_BUFFER_USAGE.COPY_DST });
    device.gpu.queue.writeBuffer(input, 0, inputBytes);
    const outputSize = item.expected.length * 4;
    const output = device.gpu.createBuffer({ size: outputSize, usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC });
    const readback = device.gpu.createBuffer({ size: outputSize, usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST });
    const module = device.gpu.createShaderModule({ code: reflected.wgsl });
    const bindGroupLayout = device.gpu.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPU_SHADER_STAGE.COMPUTE, buffer: { type: layout.addressSpace === "uniform" ? "uniform" : "read-only-storage" } },
      { binding: 1, visibility: GPU_SHADER_STAGE.COMPUTE, buffer: { type: "storage" } },
    ] });
    const pipeline = device.gpu.createComputePipeline({ layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }), compute: { module, entryPoint: "main" } });
    const bindGroup = device.gpu.createBindGroup({ layout: bindGroupLayout, entries: [{ binding: 0, resource: { buffer: input } }, { binding: 1, resource: { buffer: output } }] });
    const encoder = device.gpu.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    device.gpu.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPU_MAP_MODE.READ);
    const actual = [...new Float32Array(readback.getMappedRange().slice(0))];
    readback.unmap();
    expect(actual).toEqual(item.expected);
  } finally {
    device.destroy();
  }
}


test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("texture reflection BGL classification validates depth + MRT sampling on GPU", async () => {
  const source = `
    @group(0) @binding(0) var hdr: texture_2d<f32>;
    @group(0) @binding(1) var depthTex: texture_depth_2d;

    struct VertexOut { @builtin(position) position: vec4f }
    struct FragOut { @location(0) color0: vec4f, @location(1) color1: vec4f }

    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
      var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      var out: VertexOut;
      out.position = vec4f(positions[vi], 0.0, 1.0);
      return out;
    }

    @fragment fn fs_main() -> FragOut {
      let c = textureLoad(hdr, vec2i(0, 0), 0);
      var out: FragOut;
      out.color0 = vec4f(c.r, 0.75, 0.0, 1.0);
      out.color1 = vec4f(c.g, 0.0, 0.0, 1.0);
      return out;
    }
  `;
  const reflected = await resolveShader({ entry: "/texture-classification.wgsl", validate: true, modules: { "/texture-classification.wgsl": source } });
  expect(reflected.reflection.bindings.map((binding) => binding.bindingLayout)).toEqual([
    { kind: "texture", texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
    { kind: "texture", texture: { sampleType: "depth", viewDimension: "2d", multisampled: false } },
  ]);

  const device = await createNodeAdapter().requestDevice();
  try {
    const hdr = device.gpu.createTexture({ size: [1, 1], format: "rgba32float", usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.COPY_DST });
    device.gpu.queue.writeTexture({ texture: hdr }, new Float32Array([0.25, 0.5, 0, 1]), { bytesPerRow: 16 }, [1, 1]);
    const depth = device.gpu.createTexture({ size: [1, 1], format: "depth24plus", usage: GPU_TEXTURE_USAGE.TEXTURE_BINDING | GPU_TEXTURE_USAGE.RENDER_ATTACHMENT });
    const out0 = device.gpu.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC });
    const out1 = device.gpu.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC });
    const read0 = device.gpu.createBuffer({ size: 256, usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST });
    const read1 = device.gpu.createBuffer({ size: 256, usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST });
    const module = device.gpu.createShaderModule({ code: reflected.wgsl });
    const bindGroupLayout = device.gpu.createBindGroupLayout({ entries: reflected.reflection.bindings.map((binding) => ({ binding: binding.binding, visibility: GPU_SHADER_STAGE.FRAGMENT, texture: binding.bindingLayout?.kind === "texture" ? binding.bindingLayout.texture : undefined })) });
    const bindGroup = device.gpu.createBindGroup({ layout: bindGroupLayout, entries: [
      { binding: 0, resource: hdr.createView() },
      { binding: 1, resource: depth.createView() },
    ] });
    const pipeline = device.gpu.createRenderPipeline({
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const encoder = device.gpu.createCommandEncoder();
    const clear = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 0.75 } });
    clear.end();
    const pass = encoder.beginRenderPass({ colorAttachments: [
      { view: out0.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
      { view: out1.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
    ] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: out0 }, { buffer: read0, bytesPerRow: 256 }, [1, 1]);
    encoder.copyTextureToBuffer({ texture: out1 }, { buffer: read1, bytesPerRow: 256 }, [1, 1]);
    device.gpu.queue.submit([encoder.finish()]);
    await Promise.all([read0.mapAsync(GPU_MAP_MODE.READ), read1.mapAsync(GPU_MAP_MODE.READ)]);
    const pixel0 = new Uint8Array(read0.getMappedRange().slice(0, 4));
    const pixel1 = new Uint8Array(read1.getMappedRange().slice(0, 4));
    read0.unmap();
    read1.unmap();
    expect([...pixel0]).toEqual([64, 191, 0, 255]);
    expect([...pixel1]).toEqual([128, 0, 0, 255]);
  } finally {
    device.destroy();
  }
});
