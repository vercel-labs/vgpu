import type { Device } from "@vgpu/core";
import { reflectSource, type Reflection } from "@vgpu/wgsl/runtime";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { bindGroupLayoutsForReflection, createSetCore, pipelineLayoutFor, type SetBag, type SetCore } from "./set-core.ts";
import type { Target } from "./target.ts";
import { unsupportedError } from "./errors.ts";

export interface DrawOptions {
  readonly shader: string;
  readonly mesh?: MeshLike;
  readonly set?: SetBag;
  readonly label?: string;
  readonly targets?: readonly Target[];
}

export interface DrawCallOptions {
  readonly target?: Target;
  readonly offsets?: readonly number[] | Partial<Record<number, readonly number[]>>;
}

export interface MeshLike {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly vertexBuffers?: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
}

export interface BundleBackReference {
  readonly id: string;
  markStale(reason: string): void;
}

/** Bundle back-reference hook frozen for Lane D; set()/group() mark registered bundles stale. */
export interface BundleBackReferenceRegistry {
  add(bundle: BundleBackReference): void;
  delete(bundle: BundleBackReference): void;
  list(): readonly BundleBackReference[];
  markStale(reason: string): void;
}

let nextDrawId = 1;

export class Draw {
  readonly id = nextDrawId++;
  readonly label: string;
  readonly reflection: Reflection;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly __recordedIn: BundleBackReferenceRegistry;
  private readonly pipelineCache = new Map<string, GPURenderPipeline>();

  constructor(readonly device: Device, readonly source: string, readonly opts: DrawOptions, private readonly cache: BindGroupCache = createBindGroupCache(), private readonly defaultTarget?: Target) {
    this.label = opts.label ?? "draw";
    this.reflection = reflectSource(source, `${this.label}.wgsl`);
    this.bindGroupLayouts = bindGroupLayoutsForReflection(device, this.label, this.reflection);
    this.pipelineLayout = pipelineLayoutFor(device, this.bindGroupLayouts);
    this.shaderModule = device.gpu.createShaderModule({ label: `${this.label}.shader`, code: source });
    this.setCore = createSetCore({ device, label: this.label, drawId: this.id, reflection: this.reflection, bindGroupLayouts: this.bindGroupLayouts, cache: this.cache });
    this.__recordedIn = createBundleRegistry();
    if (opts.set) this.set(opts.set);
    for (const target of opts.targets ?? []) this.pipelineFor(target);
  }

  get gpu(): GPURenderPipeline | undefined { return this.pipelineCache.values().next().value; }
  get targets(): readonly Target[] | undefined { return this.opts.targets; }

  set(values: SetBag): this { this.setCore.set(values); this.__recordedIn.markStale(`set() rebind en '${this.label}'`); return this; }
  group(n: number, bindGroup: GPUBindGroup): this { this.setCore.claimGroup(n, bindGroup); this.__recordedIn.markStale(`group(${n}) rebind en '${this.label}'`); return this; }
  layout(n: number): GPUBindGroupLayout { return this.setCore.layout(n); }

  draw(opts: DrawCallOptions = {}): void {
    const target = opts.target ?? this.defaultTarget;
    if (!target) throw unsupportedError(`${this.label}.draw`, "Draw.draw() one-shot requiere opts.target cuando gpu.screen no existe; usá gpu.frame.pass({ target }, p => p.draw(draw)).");
    const encoder = this.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass(target.renderPassDescriptor());
    this.encode(pass, target, opts);
    pass.end();
    this.device.gpu.queue.submit([encoder.finish()]);
  }

  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}): void {
    pass.setPipeline(this.pipelineFor(target));
    for (const binding of this.setCore.bindGroups()) {
      pass.setBindGroup(binding.group, binding.bindGroup, offsetsForGroup(opts.offsets, binding.group, binding.offsets));
    }
    const mesh = this.opts.mesh;
    if (mesh?.vertexBuffers) mesh.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    if (mesh?.indexBuffer) {
      pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat ?? "uint32");
      pass.drawIndexed(mesh.indexCount ?? 0);
      return;
    }
    pass.draw(mesh?.vertexCount ?? 3);
  }

  pipelineFor(target: Target): GPURenderPipeline {
    const key = `${target.colors.map((color) => color.format).join(",")}:${target.depth?.format ?? "none"}:${target.sampleCount}`;
    let pipeline = this.pipelineCache.get(key);
    if (pipeline) return pipeline;
    const entries = this.reflection.entryPoints;
    const vertex = entries.find((entry) => entry.stage === "vertex")?.name ?? "vs_main";
    const fragment = entries.find((entry) => entry.stage === "fragment")?.name ?? "fs_main";
    pipeline = this.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: this.pipelineLayout,
      vertex: { module: this.shaderModule, entryPoint: vertex, buffers: [...(this.opts.mesh?.vertexBufferLayouts ?? [])] },
      fragment: { module: this.shaderModule, entryPoint: fragment, targets: target.colors.map((color) => ({ format: color.format })) },
      primitive: { topology: "triangle-list" },
      depthStencil: target.depth ? { format: target.depth.format, depthWriteEnabled: true, depthCompare: "less" } : undefined,
      multisample: { count: target.sampleCount },
    });
    this.pipelineCache.set(key, pipeline);
    return pipeline;
  }
}

export function createBundleRegistry(): BundleBackReferenceRegistry {
  const set = new Set<BundleBackReference>();
  return {
    add(bundle) { set.add(bundle); },
    delete(bundle) { set.delete(bundle); },
    list() { return [...set]; },
    markStale(reason) { for (const bundle of set) bundle.markStale(reason); },
  };
}

function offsetsForGroup(offsets: DrawCallOptions["offsets"], group: number, fallback: readonly number[]): readonly number[] {
  if (!offsets) return fallback;
  if (Array.isArray(offsets)) return offsets;
  const byGroup = offsets as Partial<Record<number, readonly number[]>>;
  return byGroup[group] ?? fallback;
}
