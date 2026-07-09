import type { Device } from "@vgpu/core";
import { invalidUsage, shaderVisibility } from "../uniform-pool-internals.ts";
import type { Material, MaterialGpu } from "./material.ts";
import { alignUniforms, isWgslUniformType, wgslType, writeUniformField, type UniformField, type WgslUniformType } from "./wgsl-alignment.ts";
import { wgslDeclarations } from "./material-bindings.ts";
import { materialTextureState } from "./material-textures.ts";
import type { MaterialSamplerSpec, MaterialTextureSpec, WriteTextureValues } from "./material-textures-schema.ts";
import { vertexBufferLayout } from "./vertex-layout.ts";

export type { WgslUniformType } from "./wgsl-alignment.ts";
export type { MaterialSamplerSpec, MaterialTextureSpec, SamplerSpec, TextureKind, TextureSpec, TextureValue, WriteTextureValues } from "./material-textures-schema.ts";

export type VertexLayoutKind = "position-only" | "position-normal" | "position-normal-uv" | "position-uv";
export type UniformValue = number | readonly number[] | Float32Array | Uint32Array | Int32Array;

export interface MaterialSpec<
  U extends Record<string, WgslUniformType> = Record<string, WgslUniformType>,
  T extends Record<string, MaterialTextureSpec> = Record<string, never>,
  S extends Record<string, MaterialSamplerSpec> = Record<string, never>,
> {
  readonly device: Device;
  readonly vertex: string;
  readonly fragment: string;
  readonly uniforms: U;
  readonly textures?: T;
  readonly samplers?: S;
  readonly vertexLayout: VertexLayoutKind;
  readonly targetFormat?: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat | null;
  /**
   * When `true`, `material()` prepends generated texture/sampler WGSL declarations.
   * Defaults to `false`; write declarations manually or prepend `getMaterialDeclarations(spec)`.
   * The `Uniforms` struct is still injected whenever `uniforms` is non-empty.
   * @default false
   */
  readonly autoDeclarations?: boolean;
}

export interface FactoryMaterial<
  U extends Record<string, WgslUniformType> = Record<string, WgslUniformType>,
  T extends Record<string, MaterialTextureSpec> = Record<string, never>,
  S extends Record<string, MaterialSamplerSpec> = Record<string, never>,
> extends Material {
  readonly bindGroup: GPUBindGroup;
  readonly uniformOffsets: Readonly<Record<keyof U, number>>;
  readonly textureBindings: Readonly<Record<keyof T, number>>;
  readonly samplerBindings: Readonly<Record<string, number>>;
  readonly gpu: MaterialGpu & { readonly bindGroup: GPUBindGroup; readonly uniformBuffer: GPUBuffer; readonly defaultSampler?: GPUSampler };
  readonly writeUniforms: (values: Record<keyof U, UniformValue>) => void;
  readonly writeTextures: (values: WriteTextureValues<T>) => void;
}

const DEFAULT_TARGET_FORMAT = "bgra8unorm-srgb";

export function material<
  U extends Record<string, WgslUniformType>,
  T extends Record<string, MaterialTextureSpec> = Record<string, never>,
  S extends Record<string, MaterialSamplerSpec> = Record<string, never>,
>(spec: MaterialSpec<U, T, S>): FactoryMaterial<U, T, S> {
  validateSchema(spec.uniforms);
  const layout = alignUniforms(spec.uniforms);
  const textures = materialTextureState(spec.device, spec.textures, spec.samplers, layout.byteSize === 0 ? 0 : 1);
  const combinedWgsl = `${header(layout.fields)}\n${spec.vertex}\n${spec.fragment}`;
  const textureWgsl = spec.autoDeclarations === true ? wgslDeclarations(spec.textures, textures.textureBindings, textures.samplerBindings) : "";
  const code = textureWgsl === "" ? combinedWgsl : `${textureWgsl}\n${combinedWgsl}`;
  const shader = createShader(spec.device, code);
  const bindGroupLayout = spec.device.gpu.createBindGroupLayout({
    label: "material.bgl",
    entries: [...uniformLayoutEntries(layout.byteSize), ...textures.layoutEntries],
  });
  const uniformBuffer = spec.device.createBuffer({ label: "material.uniforms", size: Math.max(16, layout.byteSize), usage: ["uniform", "copy_dst", "copy_src"] });
  let activeBindGroup = createBindGroup(spec.device, bindGroupLayout, uniformBuffer.gpu, layout.byteSize, textures.entries);
  const pipeline = createPipeline(spec, shader.gpu, bindGroupLayout);
  const gpu = { pipeline, uniformBuffer: uniformBuffer.gpu, defaultSampler: textures.defaultSampler, get bindGroup() { return activeBindGroup; } };
  return Object.freeze({
    pipeline, bindGroupLayout, get bindGroup() { return activeBindGroup; }, shader, uniformByteSize: layout.byteSize,
    uniformOffsets: layout.offsets as Readonly<Record<keyof U, number>>, textureBindings: textures.textureBindings, samplerBindings: textures.samplerBindings,
    params: { baseColor: [0, 0, 0] as const, metallic: 0, roughness: 0 }, gpu,
    writeUniforms: (values: Record<keyof U, UniformValue>) => writeUniforms(spec.device, uniformBuffer.gpu, layout.fields, values as Record<string, UniformValue>),
    writeTextures: (values: WriteTextureValues<T>) => { activeBindGroup = createBindGroup(spec.device, bindGroupLayout, uniformBuffer.gpu, layout.byteSize, textures.writeTextures(values)); },
    dispose: () => { uniformBuffer.destroy(); textures.dispose(); },
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

function uniformLayoutEntries(byteSize: number): readonly GPUBindGroupLayoutEntry[] {
  return byteSize === 0 ? [] : [{ binding: 0, visibility: shaderVisibility(), buffer: { type: "uniform", minBindingSize: byteSize } }];
}

function createBindGroup(device: Device, layout: GPUBindGroupLayout, buffer: GPUBuffer, byteSize: number, entries: readonly GPUBindGroupEntry[]): GPUBindGroup {
  return device.gpu.createBindGroup({ label: "material.bindGroup", layout, entries: [...uniformEntries(buffer, byteSize), ...entries] });
}

function uniformEntries(buffer: GPUBuffer, byteSize: number): readonly GPUBindGroupEntry[] {
  return byteSize === 0 ? [] : [{ binding: 0, resource: { buffer, size: byteSize } }];
}

function createShader(device: Device, code: string): ReturnType<Device["createShader"]> {
  try { return device.createShader(code); }
  catch (error) { throw invalidUsage("material", `WGSL error: ${messageOf(error)}`); }
}

function createPipeline(spec: MaterialSpec<Record<string, WgslUniformType>, Record<string, MaterialTextureSpec>, Record<string, MaterialSamplerSpec>>, module: GPUShaderModule, bindGroupLayout: GPUBindGroupLayout): GPURenderPipeline {
  try {
    return spec.device.gpu.createRenderPipeline({
      label: "material.pipeline", layout: spec.device.gpu.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: "vs_main", buffers: [vertexBufferLayout(spec.vertexLayout)] },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: spec.targetFormat ?? DEFAULT_TARGET_FORMAT }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: spec.depthFormat === null ? undefined : { format: spec.depthFormat ?? "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
  } catch (error) { throw invalidUsage("material", `WGSL error: ${messageOf(error)}`); }
}

function writeUniforms(device: Device, buffer: GPUBuffer, fields: readonly UniformField[], values: Record<string, UniformValue>): void {
  const keys = new Set(Object.keys(values));
  for (const field of fields) if (!keys.delete(field.name)) throw invalidUsage("material.writeUniforms", `Missing uniform '${field.name}'.`);
  const extra = keys.values().next().value as string | undefined;
  if (extra) throw invalidUsage("material.writeUniforms", `Unknown uniform '${extra}'.`);
  const size = fields.length === 0 ? 0 : Math.max(...fields.map((field) => field.offset + field.size));
  const bytes = new Uint8Array(Math.max(16, size));
  const view = new DataView(bytes.buffer);
  for (const field of fields) writeField(view, field, values[field.name]);
  device.gpu.queue.writeBuffer(buffer, 0, bytes);
}

function writeField(view: DataView, field: UniformField, value: UniformValue): void {
  writeUniformField(view, field, value, { where: "material.writeUniforms" });
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
