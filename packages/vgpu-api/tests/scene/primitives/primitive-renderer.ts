import { PNG } from "pngjs";
import type { Device } from "@vgpu/core";
import type { Camera, Mat4, MeshPrimitive, VertexLayoutKind } from "../../../src/scene/geometry-src/index.ts";

export type PrimitiveMaterialVariant = "pbr" | "normal-debug-32";

export interface RenderPrimitiveFrameSpec {
  readonly device: Device;
  readonly mesh: MeshPrimitive;
  readonly camera: Camera;
  readonly material: PrimitiveMaterialVariant;
  readonly baseColor?: readonly [number, number, number];
  readonly modelMatrix?: Mat4;
}

const WIDTH = 256;
const HEIGHT = 256;
const TARGET_FORMAT = "rgba8unorm-srgb";
const CLEAR_VALUE = { r: 63 / 255, g: 63 / 255, b: 80 / 255, a: 1 };
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as Mat4;

export async function renderPrimitiveFrame(spec: RenderPrimitiveFrameSpec): Promise<Uint8Array> {
  const uniformBuffer = spec.device.gpu.createBuffer({
    label: "primitive-renderer.uniforms",
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const bindGroup = spec.device.gpu.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const pipeline = spec.device.gpu.createRenderPipeline({
    layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: spec.device.gpu.createShaderModule({ code: shader(layoutOf(spec.mesh)) }),
      entryPoint: "vs_main",
      buffers: [vertexBufferLayout(spec.mesh)],
    },
    fragment: {
      module: spec.device.gpu.createShaderModule({ code: shader(layoutOf(spec.mesh)) }),
      entryPoint: "fs_main",
      targets: [{ format: TARGET_FORMAT }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });
  const color = spec.device.createTexture({ size: [WIDTH, HEIGHT], format: TARGET_FORMAT, usage: ["render_attachment", "copy_src"] });
  const depth = spec.device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus", usage: ["render_attachment"] });
  try {
    spec.device.gpu.queue.writeBuffer(uniformBuffer, 0, uniformBytes(spec));
    draw(spec, pipeline, bindGroup, color, depth);
    const png = new PNG({ width: WIDTH, height: HEIGHT });
    png.data.set(await color.read());
    return PNG.sync.write(png);
  } finally {
    uniformBuffer.destroy();
    depth.destroy();
    color.destroy();
  }
}

function uniformBytes(spec: RenderPrimitiveFrameSpec): ArrayBuffer {
  const bytes = new ArrayBuffer(160);
  const floats = new Float32Array(bytes);
  floats.set(spec.camera.viewProjectionMatrix, 0);
  floats.set(spec.modelMatrix ?? IDENTITY, 16);
  floats.set([...(spec.baseColor ?? [0.7, 0.55, 0.45]), 1], 32);
  new DataView(bytes).setUint32(144, spec.material === "normal-debug-32" ? 1 : 0, true);
  return bytes;
}

function draw(
  spec: RenderPrimitiveFrameSpec,
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  color: ReturnType<Device["createTexture"]>,
  depth: ReturnType<Device["createTexture"]>,
): void {
  const encoder = spec.device.gpu.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: color.createView(), loadOp: "clear", storeOp: "store", clearValue: CLEAR_VALUE }],
    depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.setVertexBuffer(0, spec.mesh.vertexBuffer.gpu);
  if (spec.mesh.indexBuffer) {
    pass.setIndexBuffer(spec.mesh.indexBuffer.gpu, spec.mesh.indexFormat ?? "uint16");
    pass.drawIndexed(spec.mesh.indexCount ?? 0, 1, 0, 0, 0);
  } else {
    pass.draw(spec.mesh.vertexCount, 1, 0, 0);
  }
  pass.end();
  spec.device.queue.gpu.submit([encoder.finish()]);
}

function layoutOf(mesh: MeshPrimitive): VertexLayoutKind {
  return mesh.layout === "position-normal" ? "position-normal" : "position-normal-uv";
}

function vertexBufferLayout(mesh: MeshPrimitive): GPUVertexBufferLayout {
  const attrs: GPUVertexAttribute[] = [
    { shaderLocation: 0, offset: mesh.attributes.position.offset, format: mesh.attributes.position.format },
    { shaderLocation: 1, offset: mesh.attributes.normal!.offset, format: mesh.attributes.normal!.format },
  ];
  if (mesh.attributes.uv) attrs.push({ shaderLocation: 2, offset: mesh.attributes.uv.offset, format: mesh.attributes.uv.format });
  return { arrayStride: mesh.attributes.stride, attributes: attrs };
}

function shader(layout: VertexLayoutKind): string {
  const uv = layout === "position-normal-uv" ? "  @location(2) uv: vec2f," : "";
  const outUv = layout === "position-normal-uv" ? "input.uv" : "vec2f(0.0, 0.0)";
  return `
struct Uniforms {
  viewProjectionMatrix: mat4x4f,
  modelMatrix: mat4x4f,
  baseColor: vec4f,
  materialKind: u32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
${uv}
};
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) uv: vec2f,
};
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  let worldPosition = uniforms.modelMatrix * vec4f(input.position, 1.0);
  var output: VertexOutput;
  output.position = uniforms.viewProjectionMatrix * worldPosition;
  output.worldNormal = normalize((uniforms.modelMatrix * vec4f(input.normal, 0.0)).xyz);
  output.uv = ${outUv};
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let normal = normalize(input.worldNormal);
  if (uniforms.materialKind == 1u) {
    return vec4f(normal * 0.5 + 0.5, 1.0);
  }
  let light = normalize(vec3f(0.4, 1.0, 0.6));
  let lit = max(dot(normal, light), 0.0) * 0.9 + 0.1;
  return vec4f(uniforms.baseColor.rgb * lit, uniforms.baseColor.a);
}`;
}
