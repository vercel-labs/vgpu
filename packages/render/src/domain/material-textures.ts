import type { Device, Texture } from "@vgpu/core";
import { invalidUsage, shaderVisibility } from "../uniform-pool-internals.ts";
import { DEFAULT_MATERIAL_SAMPLER, isTextureKind, samplerDescriptor, textureWgslType, type MaterialSamplerSpec, type MaterialTextureSpec, type TextureKind, type WriteTextureValues } from "./material-textures-schema.ts";

export interface MaterialTextureState<T extends Record<string, MaterialTextureSpec>, S extends Record<string, MaterialSamplerSpec>> {
  readonly layoutEntries: readonly GPUBindGroupLayoutEntry[];
  readonly entries: readonly GPUBindGroupEntry[];
  readonly textureBindings: Readonly<Record<keyof T, number>>;
  readonly samplerBindings: Readonly<Record<string, number>>;
  readonly defaultSampler?: GPUSampler;
  readonly writeTextures: (values: WriteTextureValues<T>) => readonly GPUBindGroupEntry[];
  readonly dispose: () => void;
}

interface TextureField { readonly name: string; readonly kind: TextureKind; readonly binding: number; }

export function materialTextureState<T extends Record<string, MaterialTextureSpec>, S extends Record<string, MaterialSamplerSpec>>(
  device: Device,
  textures: T | undefined,
  samplers: S | undefined,
  firstBinding: number,
): MaterialTextureState<T, S> {
  const textureFields = textureFieldsOf(textures ?? {}, firstBinding + samplerCount(textures, samplers));
  const samplerEntries = samplersOf(device, textures, samplers, firstBinding);
  validateSamplerRefs(textures ?? {}, Object.keys(samplerEntries.byName));
  const placeholders = textureFields.map((field) => placeholder(device, field.kind));
  const entries = [...samplerEntries.entries, ...textureFields.map((field, i) => ({ binding: field.binding, resource: placeholders[i]!.view }))];
  return {
    layoutEntries: [...samplerEntries.layoutEntries, ...textureFields.map(textureLayoutEntry)],
    entries,
    textureBindings: Object.fromEntries(textureFields.map((field) => [field.name, field.binding])) as Readonly<Record<keyof T, number>>,
    samplerBindings: samplerEntries.byName,
    defaultSampler: samplerEntries.defaultSampler,
    writeTextures: (values) => [...samplerEntries.entries, ...textureEntries(textureFields, values)],
    dispose: () => placeholders.forEach((value) => value.texture.destroy()),
  };
}

function samplerCount(textures: unknown, samplers: Record<string, MaterialSamplerSpec> | undefined): number {
  const explicit = Object.keys(samplers ?? {}).length;
  return explicit > 0 ? explicit : Object.keys((textures ?? {}) as object).length > 0 ? 1 : 0;
}

function samplersOf(device: Device, textures: unknown, samplers: Record<string, MaterialSamplerSpec> | undefined, first: number) {
  const raw = Object.entries(samplers ?? {}) as [string, MaterialSamplerSpec][];
  const specs: [string, MaterialSamplerSpec][] = raw.length > 0 ? raw : Object.keys((textures ?? {}) as object).length > 0 ? [[DEFAULT_MATERIAL_SAMPLER, { mag: "linear", min: "linear", mip: "linear" }]] : [];
  const byName: Record<string, number> = {};
  const gpuSamplers = specs.map(([name, spec], index) => {
    try {
      const gpu = device.gpu.createSampler(samplerDescriptor(spec as MaterialSamplerSpec));
      byName[name] = first + index;
      return { name, gpu, binding: first + index };
    } catch (error) { throw invalidUsage("material", `Invalid sampler '${name}': ${messageOf(error)}`); }
  });
  return {
    byName,
    defaultSampler: raw.length === 0 && gpuSamplers.length > 0 ? gpuSamplers[0]!.gpu : undefined,
    entries: gpuSamplers.map(({ binding, gpu }) => ({ binding, resource: gpu })),
    layoutEntries: gpuSamplers.map(({ binding }) => ({ binding, visibility: shaderVisibility(), sampler: { type: "filtering" as const } })),
  };
}

function textureFieldsOf(schema: Record<string, MaterialTextureSpec>, first: number): readonly TextureField[] {
  return Object.entries(schema).map(([name, spec], index) => {
    const kind = typeof spec === "string" ? spec : spec?.kind;
    if (!isTextureKind(kind)) throw invalidUsage("material", `Unsupported texture kind for '${name}'.`);
    return { name, kind, binding: first + index };
  });
}

function validateSamplerRefs(textures: Record<string, MaterialTextureSpec>, samplerNames: readonly string[]): void {
  for (const [name, spec] of Object.entries(textures)) {
    const sampler = typeof spec === "string" ? undefined : spec.sampler;
    if (sampler && !samplerNames.includes(sampler)) throw invalidUsage("material", `Texture '${name}' references missing sampler '${sampler}'.`);
  }
}

function textureLayoutEntry(field: TextureField): GPUBindGroupLayoutEntry {
  return { binding: field.binding, visibility: shaderVisibility(), texture: { sampleType: "float", viewDimension: viewDimension(field.kind) } };
}

function textureEntries(fields: readonly TextureField[], values: Record<string, Texture | GPUTextureView>): readonly GPUBindGroupEntry[] {
  const keys = new Set(Object.keys(values));
  const entries: GPUBindGroupEntry[] = fields.map((field) => {
    const value = values[field.name];
    if (!keys.delete(field.name) || value === undefined) throw invalidUsage("material.writeTextures", `Missing texture '${field.name}'.`);
    return { binding: field.binding, resource: textureView(value, field.kind) };
  });
  return [...entries, ...extraKey(keys)];
}

function extraKey(keys: Set<string>): readonly GPUBindGroupEntry[] {
  const extra = keys.values().next().value as string | undefined;
  if (extra) throw invalidUsage("material.writeTextures", `Unknown texture '${extra}'.`);
  return [];
}

function textureView(value: Texture | GPUTextureView, kind: TextureKind): GPUTextureView {
  if ("createView" in value) return value.createView({ dimension: viewDimension(kind) });
  return value;
}

function placeholder(device: Device, kind: TextureKind): { readonly texture: GPUTexture; readonly view: GPUTextureView } {
  const texture = device.gpu.createTexture({ label: `material.placeholder.${kind}`, size: { width: 1, height: 1, depthOrArrayLayers: kind === "texture_2d_f32" ? 1 : 6 }, format: "rgba8unorm", usage: 4 });
  return { texture, view: texture.createView({ dimension: viewDimension(kind) }) };
}

function viewDimension(kind: TextureKind): GPUTextureViewDimension {
  return kind === "texture_cube_f32" ? "cube" : kind === "texture_2d_array_f32" ? "2d-array" : "2d";
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
