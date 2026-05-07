import type { Device } from "@vgpu/core";
import { invalidUsage, shaderVisibility } from "../uniform-pool-internals.ts";
import type { Material, MaterialGpu } from "./material.ts";
import { alignUniforms, isWgslUniformType, wgslType, type WgslUniformType, type UniformField } from "./wgsl-alignment.ts";
import { vertexBufferLayout } from "./vertex-layout.ts";

export type { WgslUniformType } from "./wgsl-alignment.ts";

export type VertexLayoutKind = "position-only" | "position-normal" | "position-normal-uv" | "position-uv";
export type UniformValue = number | readonly number[] | Float32Array | Uint32Array | Int32Array;

export interface MaterialSpec {
  readonly device: Device;
  readonly vertex: string;
  readonly fragment: string;
  readonly uniforms: Record<string, WgslUniformType>;
  readonly vertexLayout: VertexLayoutKind;
  readonly targetFormat?: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat | null;
}

export interface FactoryMaterial extends Material {
  readonly bindGroup: GPUBindGroup;
  readonly uniformOffsets: Readonly<Record<string, number>>;
  readonly gpu: MaterialGpu & { readonly bindGroup: GPUBindGroup; readonly uniformBuffer: GPUBuffer };
  readonly writeUniforms: (values: Record<string, UniformValue>) => void;
}

const DEFAULT_TARGET_FORMAT = "bgra8unorm-srgb";

export function material(spec: MaterialSpec): FactoryMaterial {
  validateSchema(spec.uniforms);
  const layout = alignUniforms(spec.uniforms);
  const code = `${header(layout.fields)}\n${spec.vertex}\n${spec.fragment}`;
  const shader = createShader(spec.device, code);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "material.bgl",
    entries: layout.byteSize === 0 ? [] : [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: layout.byteSize } }],
  });
  const uniformBuffer = spec.device.createBuffer({
    label: "material.uniforms",
    size: Math.max(16, layout.byteSize),
    usage: ["uniform", "copy_dst", "copy_src"],
  });
  const bindGroup = spec.device.gpu.createBindGroup({
    label: "material.bindGroup",
    layout: bindGroupLayout,
    entries: layout.byteSize === 0 ? [] : [{ binding: 0, resource: { buffer: uniformBuffer.gpu, size: layout.byteSize } }],
  });
  const pipeline = createPipeline(spec, shader.gpu, bindGroupLayout);
  const gpu = Object.freeze({ pipeline, bindGroup, uniformBuffer: uniformBuffer.gpu });
  return Object.freeze({
    pipeline, bindGroupLayout, bindGroup, shader, uniformByteSize: layout.byteSize, uniformOffsets: layout.offsets,
    params: { baseColor: [0, 0, 0] as const, metallic: 0, roughness: 0 }, gpu,
    writeUniforms: (values: Record<string, UniformValue>) => writeUniforms(spec.device, uniformBuffer.gpu, layout.fields, values),
    dispose: () => uniformBuffer.destroy(),
  });
}

function validateSchema(schema: Record<string, unknown>): void {
  for (const [name, type] of Object.entries(schema)) {
    if (name === "uniforms") throw invalidUsage("material", "Uniform name must not be 'uniforms'.");
    if (!isWgslUniformType(type)) throw invalidUsage("material", `Unsupported uniform type for '${name}'.`);
  }
}

function header(fields: readonly UniformField[]): string {
  if (fields.length === 0) return "";
  const lines = fields.map((field) => `  ${field.name}: ${wgslType(field.type)},`);
  return [`struct Uniforms {`, ...lines, `};`, `@group(0) @binding(0) var<uniform> uniforms: Uniforms;`].join("\n");
}

function createShader(device: Device, code: string): ReturnType<Device["createShader"]> {
  try { return device.createShader(code); }
  catch (error) { throw invalidUsage("material", `WGSL error: ${messageOf(error)}`); }
}

function createPipeline(spec: MaterialSpec, module: GPUShaderModule, bindGroupLayout: GPUBindGroupLayout): GPURenderPipeline {
  try {
    return spec.device.gpu.createRenderPipeline({
      label: "material.pipeline",
      layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main", buffers: [vertexBufferLayout(spec.vertexLayout)] },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: spec.targetFormat ?? DEFAULT_TARGET_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: spec.depthFormat === null ? undefined : { format: spec.depthFormat ?? "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
  } catch (error) { throw invalidUsage("material", `WGSL error: ${messageOf(error)}`); }
}

function writeUniforms(device: Device, buffer: GPUBuffer, fields: readonly UniformField[], values: Record<string, UniformValue>): void {
  const keys = new Set(Object.keys(values));
  for (const field of fields) {
    if (!keys.delete(field.name)) throw invalidUsage("material.writeUniforms", `Missing uniform '${field.name}'.`);
  }
  const extra = keys.values().next().value as string | undefined;
  if (extra) throw invalidUsage("material.writeUniforms", `Unknown uniform '${extra}'.`);
  const size = fields.length === 0 ? 0 : Math.max(...fields.map((field) => field.offset + field.size));
  const bytes = new Uint8Array(Math.max(16, size));
  const view = new DataView(bytes.buffer);
  for (const field of fields) writeField(view, field, values[field.name]);
  device.gpu.queue.writeBuffer(buffer, 0, bytes);
}

function writeField(view: DataView, field: UniformField, value: UniformValue): void {
  const data = typeof value === "number" ? [value] : Array.from(value);
  const setter = field.type === "u32" || field.type.endsWith("u") ? "setUint32" : field.type === "i32" || field.type.endsWith("i") ? "setInt32" : "setFloat32";
  const needed = field.type === "mat3x3f" ? 9 : field.type === "mat4x4f" ? 16 : field.size / 4;
  if (data.length < needed) throw invalidUsage("material.writeUniforms", `Uniform '${field.name}' needs ${needed} value(s).`);
  if (field.type === "mat3x3f") { for (let column = 0; column < 3; column++) for (let row = 0; row < 3; row++) set(view, setter, field.offset + column * 16 + row * 4, data[column * 3 + row]!); return; }
  for (let index = 0; index < needed; index++) set(view, setter, field.offset + index * 4, data[index]!);
}

function set(view: DataView, setter: "setFloat32" | "setUint32" | "setInt32", offset: number, value: number): void {
  view[setter](offset, value, true);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
