import { Draw } from "./draw.ts";
import { bindGroupLayoutEntriesForGroup, pipelineLayoutFor } from "./set-layouts.ts";

export interface GroupClaim {
  readonly draw: Draw;
  readonly group: number;
  readonly bindGroup: GPUBindGroup;
}

type MutableDrawInternals = {
  bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  pipelineLayout: GPUPipelineLayout;
  pipelineCache: Map<string, GPURenderPipeline>;
};

const dynamicLayouts = new WeakMap<Draw, Map<number, GPUBindGroupLayout>>();
const originalLayout = Draw.prototype.layout;

/** Claims a reflected bind group on a Draw. Dynamic offsets still belong to p.draw(draw, { offsets }). */
export function claimGroup(draw: Draw, group: number, bindGroup: GPUBindGroup): GroupClaim {
  draw.layout(group);
  draw.group(group, bindGroup);
  return { draw, group, bindGroup };
}

function installDynamicGroupLayouts(): void {
  Draw.prototype.layout = function layout(group: number): GPUBindGroupLayout {
    originalLayout.call(this, group);
    return dynamicLayoutFor(this, group);
  };
}

function dynamicLayoutFor(draw: Draw, group: number): GPUBindGroupLayout {
  const layouts = dynamicLayoutsFor(draw);
  const existing = layouts.get(group);
  if (existing) return existing;
  const layout = draw.device.gpu.createBindGroupLayout({
    label: `${draw.label}.group${group}.dynamic.bgl`,
    entries: dynamicEntries(draw, group),
  });
  layouts.set(group, layout);
  installLayout(draw, group, layout);
  return layout;
}

function dynamicLayoutsFor(draw: Draw): Map<number, GPUBindGroupLayout> {
  let layouts = dynamicLayouts.get(draw);
  if (!layouts) {
    layouts = new Map();
    dynamicLayouts.set(draw, layouts);
  }
  return layouts;
}

function installLayout(draw: Draw, group: number, layout: GPUBindGroupLayout): void {
  const internals = draw as unknown as MutableDrawInternals;
  const next: ReadonlyMap<number, GPUBindGroupLayout> = new Map(internals.bindGroupLayouts).set(group, layout);
  internals.bindGroupLayouts = next;
  internals.pipelineLayout = pipelineLayoutFor(draw.device, next);
  internals.pipelineCache.clear();
}

function dynamicEntries(draw: Draw, group: number): GPUBindGroupLayoutEntry[] {
  return bindGroupLayoutEntriesForGroup(draw.reflection.bindings, group).map(dynamicEntry);
}

function dynamicEntry(entry: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  if (!entry.buffer) return entry;
  return { ...entry, buffer: { ...entry.buffer, hasDynamicOffset: true } };
}

installDynamicGroupLayouts();
