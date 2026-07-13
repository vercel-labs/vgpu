import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { BindingInfo, ReflectedBindingLayout, Reflection } from "@vgpu/wgsl/runtime";
import { unsupportedError } from "./errors.ts";

/** Builds explicit WebGPU BGL entries from the frozen ReflectionFacade bindingLayout metadata. */
export function bindGroupLayoutEntriesForGroup(bindings: readonly BindingInfo[], group: number): GPUBindGroupLayoutEntry[] {
  return bindings.filter((binding) => binding.group === group).map((binding) => ({
    binding: binding.binding,
    visibility: visibilityForBinding(binding),
    ...layoutEntry(binding),
  }));
}

export function bindGroupLayoutsForReflection(device: Device, label: string, reflection: Reflection): ReadonlyMap<number, GPUBindGroupLayout> {
  const map = new Map<number, GPUBindGroupLayout>();
  const groups = [...new Set(reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
  for (const group of groups) map.set(group, createBindGroupLayout(device, label, reflection, group));
  return map;
}

export function pipelineLayoutFor(device: Device, bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUPipelineLayout {
  return device.gpu.createPipelineLayout({ bindGroupLayouts: contiguousLayouts(bindGroupLayouts) });
}

function createBindGroupLayout(device: Device, label: string, reflection: Reflection, group: number): GPUBindGroupLayout {
  const entries = bindGroupLayoutEntriesForGroup(reflection.bindings, group);
  const layout = device.gpu.createBindGroupLayout({ label: `${label}.group${group}.bgl`, entries });
  return attachBindGroupLayoutMetadata(layout, { entries });
}

function contiguousLayouts(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUBindGroupLayout[] {
  const maxGroup = Math.max(-1, ...bindGroupLayouts.keys());
  const layouts: GPUBindGroupLayout[] = [];
  for (let i = 0; i <= maxGroup; i++) layouts.push(requiredLayout(bindGroupLayouts, i));
  return layouts;
}

function requiredLayout(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>, group: number): GPUBindGroupLayout {
  const layout = bindGroupLayouts.get(group);
  if (!layout) throw unsupportedError("pipelineLayout", `Los grupos de bind deben ser contiguos para pipeline layout; falta group(${group}).`);
  return layout;
}

function layoutEntry(binding: BindingInfo): Omit<GPUBindGroupLayoutEntry, "binding" | "visibility"> {
  const reflected = binding.bindingLayout;
  if (!reflected) throw unsupportedError("bindGroupLayout", `Binding '${binding.name}' no tiene bindingLayout reflejado.`);
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

function visibilityForBinding(binding: BindingInfo): GPUShaderStageFlags {
  const stages = globalThis.GPUShaderStage as unknown as Record<string, number> | undefined;
  const vertex = stages?.VERTEX ?? 1;
  const fragment = stages?.FRAGMENT ?? 2;
  const compute = stages?.COMPUTE ?? 4;
  return binding.kind === "buffer" ? (vertex | fragment | compute) : (fragment | compute);
}
