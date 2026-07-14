import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import { reflectSource, type Reflection } from "@vgpu/wgsl/runtime";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, discardLastClaimedGroupValidationScope, popLastClaimedGroupValidationScope, pushClaimedGroupValidationScope, type ClaimedGroupValidationContext, type ClaimedGroupValidationResult } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, createSetCore, pipelineLayoutFor, type BindingIdentityChange, type SetBag, type SetCore } from "./set-core.ts";
import type { Target } from "./target.ts";
import { claimedGroupNativeValidationError, unsupportedError } from "./errors.ts";

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

export interface DrawLayoutOptions {
  readonly dynamicOffsets?: boolean;
}

export interface MeshLike {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly vertexBuffers?: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
}

type BindGroupBinding = { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: ClaimedGroupValidationContext };

export type BundleStaleEvent =
  | ({ readonly kind: "binding-identity"; readonly drawLabel: string } & BindingIdentityChange)
  | { readonly kind: "group-claim"; readonly drawLabel: string; readonly group: number; readonly previousIdentity?: string; readonly newIdentity: string };

export interface BundleBackReference {
  readonly id: string;
  markStale(event: BundleStaleEvent): void;
}

/** Bundle back-reference hook frozen for Lane D; only bind-group identity changes emit structured stale events. */
export interface BundleBackReferenceRegistry {
  add(bundle: BundleBackReference): void;
  delete(bundle: BundleBackReference): void;
  list(): readonly BundleBackReference[];
  markStale(event: BundleStaleEvent): void;
}

let nextDrawId = 1;

/** Renderable shader unit with explicit bind layouts, set() ownership, pipeline cache, and R4 group hooks. */
export class Draw {
  readonly id = nextDrawId++;
  readonly label: string;
  readonly reflection: Reflection;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: Map<number, GPUBindGroupLayout>;
  pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly __recordedIn: BundleBackReferenceRegistry;
  private readonly dynamicBindGroupLayouts = new Map<number, GPUBindGroupLayout>();
  private readonly pipelineCache = new Map<string, GPURenderPipeline>();

  constructor(readonly device: Device, readonly source: string, readonly opts: DrawOptions, private readonly cache: BindGroupCache = createBindGroupCache(), private readonly defaultTarget?: Target) {
    this.label = opts.label ?? "draw";
    this.reflection = reflectSource(source, `${this.label}.wgsl`);
    this.bindGroupLayouts = new Map(bindGroupLayoutsForReflection(device, this.label, this.reflection));
    this.pipelineLayout = pipelineLayoutFor(device, this.bindGroupLayouts);
    this.shaderModule = device.gpu.createShaderModule({ label: `${this.label}.shader`, code: source });
    this.setCore = createSetCore({ device, label: this.label, drawId: this.id, reflection: this.reflection, bindGroupLayouts: this.bindGroupLayouts, cache: this.cache });
    this.__recordedIn = createBundleRegistry();
    if (opts.set) this.set(opts.set);
    for (const target of opts.targets ?? []) this.pipelineFor(target);
  }

  get gpu(): GPURenderPipeline | undefined { return this.pipelineCache.values().next().value; }
  get targets(): readonly Target[] | undefined { return this.opts.targets; }

  set(values: SetBag): this {
    for (const change of this.setCore.set(values)) this.__recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change });
    return this;
  }

  group(n: number, bindGroup: GPUBindGroup): this {
    const expectedLayout = this.dynamicBindGroupLayouts.get(n) ?? this.layout(n);
    const previousIdentity = this.setCore.claimGroup(n, bindGroup, expectedLayout);
    this.__recordedIn.markStale({ kind: "group-claim", drawLabel: this.label, group: n, previousIdentity, newIdentity: `claimed-group:${n}` });
    return this;
  }

  layout(n: number, opts: DrawLayoutOptions = {}): GPUBindGroupLayout {
    if (!opts.dynamicOffsets) return this.setCore.layout(n);
    return this.dynamicLayout(n);
  }

  private dynamicLayout(group: number): GPUBindGroupLayout {
    this.setCore.layout(group);
    const existing = this.dynamicBindGroupLayouts.get(group);
    if (existing) return existing;
    const entries = dynamicEntries(this, group);
    const rawLayout = this.device.gpu.createBindGroupLayout({ label: `${this.label}.group${group}.dynamic.bgl`, entries });
    const layout = attachBindGroupLayoutMetadata(rawLayout, { entries });
    this.dynamicBindGroupLayouts.set(group, layout);
    this.bindGroupLayouts.set(group, layout);
    this.pipelineLayout = pipelineLayoutFor(this.device, this.bindGroupLayouts);
    this.pipelineCache.clear();
    return layout;
  }

  /**
   * Encodes and submits this draw as a one-shot render pass.
   *
   * Await the returned promise when using raw claimed bind groups: native
   * validation failures are reported asynchronously as `VGPU-R4-GROUP-VALIDATION`.
   * Ignoring the promise can surface those failures as unhandled rejections.
   */
  draw(opts: DrawCallOptions = {}): Promise<void> {
    const target = opts.target ?? this.defaultTarget;
    if (!target) throw unsupportedError(`${this.label}.draw`, "Draw.draw() one-shot requiere opts.target cuando gpu.screen no existe; usá gpu.frame.pass({ target }, p => p.draw(draw)).");
    const encoder = this.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass(target.renderPassDescriptor());
    const validations: ClaimedGroupValidationResult[] = [];
    try { this.encode(pass, target, opts, (result) => validations.push(result)); }
    catch (error) {
      discardClaimedGroupValidationResults(validations);
      discardClaimedGroupValidationScopes(this.device);
      try { pass.end(); } catch { /* ignore cleanup failure after encode failure */ }
      throw error;
    }
    endRenderPassWithClaimValidation(this.device, pass, validations, validations[0]?.context);
    let commandBuffer: GPUCommandBuffer;
    const finishContext = validations[0]?.context;
    if (finishContext) pushClaimedGroupValidationScope(this.device, finishContext);
    try { commandBuffer = encoder.finish(); }
    catch (error) {
      const result = finishContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (context) throw claimedGroupNativeValidationError(context.label, context.group, error);
      throw error;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) validations.push(result);
    }
    const submitContext = validations[0]?.context;
    if (submitContext) pushClaimedGroupValidationScope(this.device, submitContext);
    try { this.device.gpu.queue.submit([commandBuffer]); }
    catch (error) {
      const result = submitContext ? popLastClaimedGroupValidationScope(this.device) : undefined;
      discardClaimedGroupValidationResults(validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (context) return Promise.reject(claimedGroupNativeValidationError(context.label, context.group, error));
      throw error;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(this.device);
      if (result) validations.push(result);
    }
    return claimedGroupValidationDone(this.device, validations);
  }

  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    pass.setPipeline(this.pipelineFor(target));
    for (const binding of this.setCore.bindGroups()) this.setBindGroup(pass, binding, opts, claimValidation);
    this.encodeMesh(pass);
  }

  private setBindGroup(pass: GPURenderPassEncoder, binding: BindGroupBinding, opts: DrawCallOptions, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    const offsets = offsetsForGroup(opts.offsets, binding.group, binding.offsets);
    if (!binding.claimValidation || !claimValidation) {
      pass.setBindGroup(binding.group, binding.bindGroup, offsets);
      return;
    }
    pushClaimedGroupValidationScope(this.device, binding.claimValidation);
    try { pass.setBindGroup(binding.group, binding.bindGroup, offsets); }
    catch (error) {
      discardLastClaimedGroupValidationScope(this.device);
      throw claimedGroupNativeValidationError(binding.claimValidation.label, binding.claimValidation.group, error);
    }
    const result = popLastClaimedGroupValidationScope(this.device);
    if (result) claimValidation(result);
  }

  pipelineFor(target: Target): GPURenderPipeline {
    const key = `${target.colors.map((color) => color.format).join(",")}:${target.depth?.format ?? "none"}:${target.sampleCount}`;
    let pipeline = this.pipelineCache.get(key);
    if (pipeline) return pipeline;
    pipeline = this.createPipeline(target);
    this.pipelineCache.set(key, pipeline);
    return pipeline;
  }

  private encodeMesh(pass: GPURenderPassEncoder): void {
    const mesh = this.opts.mesh;
    if (mesh?.vertexBuffers) mesh.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    if (!mesh?.indexBuffer) return pass.draw(mesh?.vertexCount ?? 3);
    pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat ?? "uint32");
    pass.drawIndexed(mesh.indexCount ?? 0);
  }

  private createPipeline(target: Target): GPURenderPipeline {
    const entries = this.reflection.entryPoints;
    const vertex = entries.find((entry) => entry.stage === "vertex")?.name ?? "vs_main";
    const fragment = entries.find((entry) => entry.stage === "fragment")?.name ?? "fs_main";
    return this.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: this.pipelineLayout,
      vertex: { module: this.shaderModule, entryPoint: vertex, buffers: [...(this.opts.mesh?.vertexBufferLayouts ?? [])] },
      fragment: { module: this.shaderModule, entryPoint: fragment, targets: target.colors.map((color) => ({ format: color.format })) },
      primitive: { topology: "triangle-list" },
      depthStencil: target.depth ? { format: target.depth.format, depthWriteEnabled: true, depthCompare: "less" } : undefined,
      multisample: { count: target.sampleCount },
    });
  }
}

export function createBundleRegistry(): BundleBackReferenceRegistry {
  const set = new Set<BundleBackReference>();
  return {
    add(bundle) { set.add(bundle); },
    delete(bundle) { set.delete(bundle); },
    list() { return [...set]; },
    markStale(event) { for (const bundle of set) bundle.markStale(event); },
  };
}

function offsetsForGroup(offsets: DrawCallOptions["offsets"], group: number, fallback: readonly number[]): readonly number[] {
  if (!offsets) return fallback;
  if (Array.isArray(offsets)) return offsets;
  const byGroup = offsets as Partial<Record<number, readonly number[]>>;
  return byGroup[group] ?? fallback;
}

function dynamicEntries(draw: Draw, group: number): GPUBindGroupLayoutEntry[] {
  return bindGroupLayoutEntriesForGroup(draw.reflection.bindings, group).map(dynamicEntry);
}

function dynamicEntry(entry: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  if (!entry.buffer) return entry;
  return { ...entry, buffer: { ...entry.buffer, hasDynamicOffset: true } };
}
