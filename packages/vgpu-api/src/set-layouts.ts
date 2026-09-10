import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { BindingInfo, EntryPointInfo, ReflectedBindingLayout, Reflection } from "@vgpu/wgsl/reflect-source";
import { entryMetadata } from "./entry-metadata.ts";
import { unsupportedError } from "./errors.ts";

/** Builds explicit WebGPU BGL entries from the frozen ReflectionFacade bindingLayout metadata. */
export type BindingVisibilityFn = ((binding: BindingInfo) => GPUShaderStageFlags) & {
  readonly filterable?: ReadonlySet<string>;
  /** Samplers paired with depth textures: WebGPU only allows non-filtering (or comparison) samplers there. */
  readonly nonFilteringSamplers?: ReadonlySet<string>;
};

const bindGroupLayoutCaches = new WeakMap<GPUDevice, Map<string, GPUBindGroupLayout>>();

/**
 * Stage visibility mask (plus the filtering-texture set) for the selected entry points.
 *
 * Driven strictly by each entry's reflected `bindings`/`samplingPairs`: a missing field throws
 * rather than falling back to `bindings` (which widened visibility to every declared resource) or
 * to `[]` (which downgraded filterable textures to `unfilterable-float`). `bindings` stays in the
 * signature as the module-wide binding list callers already hold; it is no longer a fallback.
 */
export function visibilityForEntries(bindings: readonly BindingInfo[], entries: readonly EntryPointInfo[]): BindingVisibilityFn {
  const masks = new Map<string, number>();
  const filterable = new Set<string>();
  const nonFilteringSamplers = new Set<string>();
  const depthTextures = new Set(bindings.filter((binding) => binding.bindingLayout?.kind === "texture" && binding.bindingLayout.texture.sampleType === "depth").map((binding) => `${binding.group}:${binding.binding}`));
  for (const entry of entries) {
    const stage = entry.stage === "vertex" ? 1 : entry.stage === "fragment" ? 2 : 4;
    for (const binding of entryMetadata(entry, "bindings", "visibility")) {
      const key = `${binding.group}:${binding.binding}`;
      masks.set(key, (masks.get(key) ?? 0) | stage);
    }
    for (const pair of entryMetadata(entry, "samplingPairs", "visibility")) {
      if (pair.mode !== "filtering") continue;
      const textureKey = `${pair.texture.group}:${pair.texture.binding}`;
      if (depthTextures.has(textureKey)) nonFilteringSamplers.add(`${pair.sampler.group}:${pair.sampler.binding}`);
      else filterable.add(textureKey);
    }
  }
  const policy: BindingVisibilityFn = (binding) => masks.get(`${binding.group}:${binding.binding}`) ?? 0;
  Object.defineProperty(policy, "filterable", { value: filterable });
  Object.defineProperty(policy, "nonFilteringSamplers", { value: nonFilteringSamplers });
  return policy;
}

export function bindGroupLayoutEntriesForGroup(
  bindings: readonly BindingInfo[],
  group: number,
  visibility: BindingVisibilityFn = defaultVisibility,
): GPUBindGroupLayoutEntry[] {
  return bindings.flatMap((binding) => {
    if (binding.group !== group) return [];
    const mask = visibility(binding);
    const key = `${binding.group}:${binding.binding}`;
    return mask === 0 ? [] : [{ binding: binding.binding, visibility: mask, ...layoutEntry(binding, visibility.filterable?.has(key) ?? false, visibility.nonFilteringSamplers?.has(key) ?? false) }];
  });
}

export function bindGroupLayoutsForReflection(
  device: Device,
  label: string,
  reflection: Reflection,
  visibility: (binding: BindingInfo) => GPUShaderStageFlags = defaultVisibility,
): ReadonlyMap<number, GPUBindGroupLayout> {
  const map = new Map<number, GPUBindGroupLayout>();
  const activeGroups = reflection.bindings.filter((binding) => visibility(binding) !== 0).map((binding) => binding.group);
  const maxGroup = Math.max(-1, ...activeGroups);
  for (let group = 0; group <= maxGroup; group++) map.set(group, createBindGroupLayout(device, label, reflection, group, visibility));
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
  return cachedBindGroupLayout(device, `${label}.group${group}.bgl`, bindGroupLayoutEntriesForGroup(reflection.bindings, group, visibility));
}

export function cachedBindGroupLayout(device: Device, label: string, entries: readonly GPUBindGroupLayoutEntry[]): GPUBindGroupLayout {
  let cache = bindGroupLayoutCaches.get(device.gpu);
  if (!cache) { cache = new Map(); bindGroupLayoutCaches.set(device.gpu, cache); }
  const key = JSON.stringify(entries);
  const cached = cache.get(key);
  if (cached) return cached;
  const layout = attachBindGroupLayoutMetadata(device.gpu.createBindGroupLayout({ label, entries }), { entries });
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

function layoutEntry(binding: BindingInfo, filterable: boolean, nonFilteringSampler: boolean): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  const reflected = binding.bindingLayout;
  if (!reflected) throw unsupportedError("bindGroupLayout", `Binding '${binding.name}' does not have a reflected bindingLayout.`);
  if (filterable && reflected.kind === "texture" && reflected.texture.sampleType === "unfilterable-float" && !reflected.texture.multisampled) return { texture: { ...reflected.texture, sampleType: "float" } };
  if (nonFilteringSampler && reflected.kind === "sampler" && reflected.sampler.type === "filtering") return { sampler: { type: "non-filtering" } };
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
