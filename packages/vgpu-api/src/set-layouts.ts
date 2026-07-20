import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { BindingInfo, EntryPointInfo, ReflectedBindingLayout, Reflection } from "@vgpu/wgsl/reflect-source";
import { unsupportedError } from "./errors.ts";

/** Builds explicit WebGPU BGL entries from the frozen ReflectionFacade bindingLayout metadata. */
export type BindingVisibilityFn = (binding: BindingInfo) => GPUShaderStageFlags;

const bindGroupLayoutCaches = new WeakMap<GPUDevice, Map<string, GPUBindGroupLayout>>();

export function visibilityForEntries(bindings: readonly BindingInfo[], entries: readonly EntryPointInfo[]): BindingVisibilityFn {
  const masks = new Map<string, number>();
  for (const entry of entries) {
    const stage = entry.stage === "vertex" ? 1 : entry.stage === "fragment" ? 2 : 4;
    for (const binding of entry.bindings ?? bindings) {
      const key = `${binding.group}:${binding.binding}`;
      masks.set(key, (masks.get(key) ?? 0) | stage);
    }
  }
  return (binding) => masks.get(`${binding.group}:${binding.binding}`) ?? 0;
}

export function bindGroupLayoutEntriesForGroup(
  bindings: readonly BindingInfo[],
  group: number,
  visibility: BindingVisibilityFn = defaultVisibility,
): GPUBindGroupLayoutEntry[] {
  return bindings.flatMap((binding) => {
    if (binding.group !== group) return [];
    const mask = visibility(binding);
    return mask === 0 ? [] : [{ binding: binding.binding, visibility: mask, ...layoutEntry(binding) }];
  });
}

export function bindGroupLayoutsForReflection(
  device: Device,
  label: string,
  reflection: Reflection,
  visibility: (binding: BindingInfo) => GPUShaderStageFlags = defaultVisibility,
): ReadonlyMap<number, GPUBindGroupLayout> {
  const map = new Map<number, GPUBindGroupLayout>();
  const groups = [...new Set(reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
  for (const group of groups) map.set(group, createBindGroupLayout(device, label, reflection, group, visibility));
  return map;
}

export function pipelineLayoutFor(device: Device, bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUPipelineLayout {
  return device.gpu.createPipelineLayout({ bindGroupLayouts: contiguousLayouts(bindGroupLayouts) });
}

function createBindGroupLayout(
  device: Device,
  label: string,
  reflection: Reflection,
  group: number,
  visibility: BindingVisibilityFn = defaultVisibility,
): GPUBindGroupLayout {
  const entries = bindGroupLayoutEntriesForGroup(reflection.bindings, group, visibility);
  let cache = bindGroupLayoutCaches.get(device.gpu);
  if (!cache) { cache = new Map(); bindGroupLayoutCaches.set(device.gpu, cache); }
  const key = JSON.stringify(entries);
  const cached = cache.get(key);
  if (cached) return cached;
  const layout = attachBindGroupLayoutMetadata(device.gpu.createBindGroupLayout({ label: `${label}.group${group}.bgl`, entries }), { entries });
  cache.set(key, layout);
  return layout;
}

function contiguousLayouts(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUBindGroupLayout[] {
  const maxGroup = Math.max(-1, ...bindGroupLayouts.keys());
  const layouts: GPUBindGroupLayout[] = [];
  for (let i = 0; i <= maxGroup; i++) layouts.push(requiredLayout(bindGroupLayouts, i));
  return layouts;
}

function requiredLayout(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>, group: number): GPUBindGroupLayout {
  const layout = bindGroupLayouts.get(group);
  if (!layout) throw unsupportedError("pipelineLayout", `Bind groups must be contiguous for pipeline layout; missing group(${group}).`);
  return layout;
}

function layoutEntry(binding: BindingInfo): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  const reflected = binding.bindingLayout;
  if (!reflected) throw unsupportedError("bindGroupLayout", `Binding '${binding.name}' does not have a reflected bindingLayout.`);
  return reflectedToWebGPU(reflected);
}

function reflectedToWebGPU(layout: ReflectedBindingLayout): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  switch (layout.kind) {
    case "buffer": return { buffer: { ...layout.buffer } };
    case "sampler": return { sampler: { ...layout.sampler } };
    case "texture": return { texture: { ...layout.texture } };
    case "storageTexture": return { storageTexture: { ...layout.storageTexture as GPUStorageTextureBindingLayout } };
    case "externalTexture": return { externalTexture: {} };
  }
}

function defaultVisibility(binding: BindingInfo): GPUShaderStageFlags {
  const stages = globalThis.GPUShaderStage as unknown as Record<string, number> | undefined;
  const vertex = stages?.VERTEX ?? 1;
  const fragment = stages?.FRAGMENT ?? 2;
  const compute = stages?.COMPUTE ?? 4;
  return binding.kind === "buffer" ? (vertex | fragment | compute) : (fragment | compute);
}
