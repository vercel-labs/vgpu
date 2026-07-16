import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type Reflection } from "@vgpu/wgsl/runtime";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, discardLastClaimedGroupValidationScope, popLastClaimedGroupValidationScope, pushClaimedGroupValidationScope, type ClaimedGroupValidationContext, type ClaimedGroupValidationResult } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, createSetCore, pipelineLayoutFor, type BindingIdentityChange, type BindingState, type SetBag, type SetCore } from "./set-core.ts";
import type { Target } from "./target.ts";
import { claimedGroupNativeValidationError, targetRequiredError, unsupportedError, VGPUError } from "./errors.ts";

export interface DrawOptions {
  readonly shader: string | ShaderSource;
  readonly mesh?: MeshLike;
  readonly set?: SetBag;
  readonly label?: string;
  readonly targets?: readonly Target[];
  /** Default instance count for every draw call. Overridden by per-call opts. Use 0 for a valid no-instance draw. */
  readonly instances?: number;
  /** Vertex count when rendering without a mesh. Mesh.vertexCount wins over this default; indexed meshes ignore it and use MeshLike.indexCount. */
  readonly vertices?: number;
  /** Default firstInstance for every draw call. Overridden by per-call opts. */
  readonly firstInstance?: number;
}

export interface DrawCallOptions {
  readonly target?: Target;
  readonly offsets?: readonly number[] | Partial<Record<number, readonly number[]>>;
  /** Instance count precedence: per-call > DrawOptions.instances > 1. Use 0 for a valid no-instance draw. */
  readonly instances?: number;
  /** Vertex count precedence for non-indexed draws: per-call > mesh.vertexCount > DrawOptions.vertices > 3. Indexed meshes ignore it and use MeshLike.indexCount. */
  readonly vertices?: number;
  /** Starting vertex for non-indexed draws. Defaults to 0; indexed meshes ignore it and use firstIndex/baseVertex = 0. */
  readonly firstVertex?: number;
  /** First instance precedence: per-call > DrawOptions.firstInstance > 0. */
  readonly firstInstance?: number;
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

type DrawState = {
  readonly id: number;
  readonly device: Device;
  readonly opts: DrawOptions;
  readonly cache: BindGroupCache;
  readonly defaultTarget?: Target;
  readonly reflection: Reflection;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: Map<number, GPUBindGroupLayout>;
  pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly recordedIn: BundleBackReferenceRegistry;
};

const drawStates = new WeakMap<Draw, DrawState>();

export interface Draw {
  readonly gpu: GPURenderPipeline | undefined;
  readonly targets: readonly Target[] | undefined;
  set(values: SetBag): this;
  group(n: number, bindGroup: GPUBindGroup): this;
  layout(n: number, opts?: DrawLayoutOptions): GPUBindGroupLayout;
  draw(opts?: DrawCallOptions): Promise<void>;
}

/** Renderable shader unit with explicit bind layouts, set() ownership, pipeline cache, and R4 group hooks. */
export class InternalDraw implements Draw {
  readonly label: string;
  private readonly dynamicBindGroupLayouts = new Map<number, GPUBindGroupLayout>();
  private readonly pipelineCache = new Map<string, GPURenderPipeline>();

  constructor(device: Device, readonly source: string, opts: DrawOptions, cache: BindGroupCache = createBindGroupCache(), defaultTarget?: Target) {
    this.label = opts.label ?? "draw";
    const id = nextDrawId++;
    const reflection = reflectSource(source, `${this.label}.wgsl`);
    const bindGroupLayouts = new Map(bindGroupLayoutsForReflection(device, this.label, reflection));
    const pipelineLayout = pipelineLayoutFor(device, bindGroupLayouts);
    const shaderModule = device.gpu.createShaderModule({ label: `${this.label}.shader`, code: source });
    const setCore = createSetCore({ device, label: this.label, drawId: id, reflection, bindGroupLayouts, cache });
    drawStates.set(this, { id, device, opts, cache, defaultTarget, reflection, setCore, bindGroupLayouts, pipelineLayout, shaderModule, recordedIn: createBundleRegistry() });
    if (opts.set) this.set(opts.set);
    for (const target of opts.targets ?? []) this.pipelineFor(target);
  }

  get gpu(): GPURenderPipeline | undefined { return this.pipelineCache.values().next().value; }
  get targets(): readonly Target[] | undefined { return drawState(this).opts.targets; }

  set(values: SetBag): this {
    const state = drawState(this);
    for (const change of state.setCore.set(values)) state.recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change });
    return this;
  }

  group(n: number, bindGroup: GPUBindGroup): this {
    const state = drawState(this);
    const expectedLayout = this.dynamicBindGroupLayouts.get(n) ?? this.layout(n);
    const previousIdentity = state.setCore.claimGroup(n, bindGroup, expectedLayout);
    state.recordedIn.markStale({ kind: "group-claim", drawLabel: this.label, group: n, previousIdentity, newIdentity: `claimed-group:${n}` });
    return this;
  }

  layout(n: number, opts: DrawLayoutOptions = {}): GPUBindGroupLayout {
    if (!opts.dynamicOffsets) return drawState(this).setCore.layout(n);
    return this.dynamicLayout(n);
  }

  private dynamicLayout(group: number): GPUBindGroupLayout {
    const state = drawState(this);
    state.setCore.layout(group);
    const existing = this.dynamicBindGroupLayouts.get(group);
    if (existing) return existing;
    const entries = dynamicEntries(this, group);
    const rawLayout = state.device.gpu.createBindGroupLayout({ label: `${this.label}.group${group}.dynamic.bgl`, entries });
    const layout = attachBindGroupLayoutMetadata(rawLayout, { entries });
    this.dynamicBindGroupLayouts.set(group, layout);
    state.bindGroupLayouts.set(group, layout);
    state.pipelineLayout = pipelineLayoutFor(state.device, state.bindGroupLayouts);
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
    const state = drawState(this);
    const target = opts.target ?? state.defaultTarget;
    if (!target) throw targetRequiredError(`${this.label}.draw`);
    const encoder = state.device.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass(target.renderPassDescriptor());
    const validations: ClaimedGroupValidationResult[] = [];
    try { this.encode(pass, target, opts, (result) => validations.push(result)); }
    catch (error) {
      discardClaimedGroupValidationResults(validations);
      discardClaimedGroupValidationScopes(state.device);
      try { pass.end(); } catch { /* ignore cleanup failure after encode failure */ }
      throw error;
    }
    endRenderPassWithClaimValidation(state.device, pass, validations, validations[0]?.context);
    let commandBuffer: GPUCommandBuffer;
    const finishContext = validations[0]?.context;
    if (finishContext) pushClaimedGroupValidationScope(state.device, finishContext);
    try { commandBuffer = encoder.finish(); }
    catch (error) {
      const result = finishContext ? popLastClaimedGroupValidationScope(state.device) : undefined;
      discardClaimedGroupValidationResults(validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? finishContext;
      if (context) throw claimedGroupNativeValidationError(context.label, context.group, error);
      throw error;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result) validations.push(result);
    }
    const submitContext = validations[0]?.context;
    if (submitContext) pushClaimedGroupValidationScope(state.device, submitContext);
    try { state.device.gpu.queue.submit([commandBuffer]); }
    catch (error) {
      const result = submitContext ? popLastClaimedGroupValidationScope(state.device) : undefined;
      discardClaimedGroupValidationResults(validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (context) return Promise.reject(claimedGroupNativeValidationError(context.label, context.group, error));
      throw error;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result) validations.push(result);
    }
    return claimedGroupValidationDone(state.device, validations);
  }

  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    pass.setPipeline(this.pipelineFor(target));
    for (const binding of drawState(this).setCore.bindGroups()) this.setBindGroup(pass, binding, opts, claimValidation);
    this.encodeMesh(pass, opts);
  }

  private setBindGroup(pass: GPURenderPassEncoder, binding: BindGroupBinding, opts: DrawCallOptions, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    const offsets = offsetsForGroup(opts.offsets, binding.group, binding.offsets);
    if (!binding.claimValidation || !claimValidation) {
      pass.setBindGroup(binding.group, binding.bindGroup, offsets);
      return;
    }
    pushClaimedGroupValidationScope(drawState(this).device, binding.claimValidation);
    try { pass.setBindGroup(binding.group, binding.bindGroup, offsets); }
    catch (error) {
      discardLastClaimedGroupValidationScope(drawState(this).device);
      throw claimedGroupNativeValidationError(binding.claimValidation.label, binding.claimValidation.group, error);
    }
    const result = popLastClaimedGroupValidationScope(drawState(this).device);
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

  private encodeMesh(pass: GPURenderPassEncoder, callOpts: DrawCallOptions = {}): void {
    const mesh = drawState(this).opts.mesh;
    if (mesh?.vertexBuffers) mesh.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    const counts = resolveDrawCounts(this.label, mesh, drawState(this).opts, callOpts);
    if (!mesh?.indexBuffer) return pass.draw(counts.vertexCount, counts.instanceCount, counts.firstVertex, counts.firstInstance);
    // Indexed meshes intentionally use their indexCount with firstIndex/baseVertex = 0; vertices/firstVertex only apply to non-indexed draws.
    pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat ?? "uint32");
    pass.drawIndexed(mesh.indexCount ?? 0, counts.instanceCount, 0, 0, counts.firstInstance);
  }

  private createPipeline(target: Target): GPURenderPipeline {
    const state = drawState(this);
    const entries = state.reflection.entryPoints;
    const vertex = entries.find((entry) => entry.stage === "vertex")?.name ?? "vs_main";
    const fragment = entries.find((entry) => entry.stage === "fragment")?.name ?? "fs_main";
    return state.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: vertex, buffers: [...(state.opts.mesh?.vertexBufferLayouts ?? [])] },
      fragment: { module: state.shaderModule, entryPoint: fragment, targets: target.colors.map((color) => ({ format: color.format })) },
      primitive: { topology: "triangle-list" },
      depthStencil: target.depth ? { format: target.depth.format, depthWriteEnabled: true, depthCompare: "less" } : undefined,
      multisample: { count: target.sampleCount },
    });
  }
}

type DrawCounts = {
  readonly instanceCount: number;
  readonly firstInstance: number;
  readonly vertexCount: number;
  readonly firstVertex: number;
};

function resolveDrawCounts(label: string, mesh: MeshLike | undefined, drawOpts: DrawOptions, callOpts: DrawCallOptions): DrawCounts {
  validateOptionalDrawCount(label, "DrawOptions.instances", drawOpts.instances);
  validateOptionalDrawCount(label, "DrawOptions.vertices", drawOpts.vertices);
  validateOptionalDrawCount(label, "DrawOptions.firstInstance", drawOpts.firstInstance);
  validateOptionalDrawCount(label, "DrawCallOptions.instances", callOpts.instances);
  validateOptionalDrawCount(label, "DrawCallOptions.vertices", callOpts.vertices);
  validateOptionalDrawCount(label, "DrawCallOptions.firstVertex", callOpts.firstVertex);
  validateOptionalDrawCount(label, "DrawCallOptions.firstInstance", callOpts.firstInstance);
  validateOptionalDrawCount(label, "MeshLike.vertexCount", mesh?.vertexCount);
  validateOptionalDrawCount(label, "MeshLike.indexCount", mesh?.indexCount);
  return {
    instanceCount: callOpts.instances ?? drawOpts.instances ?? 1,
    firstInstance: callOpts.firstInstance ?? drawOpts.firstInstance ?? 0,
    vertexCount: callOpts.vertices ?? mesh?.vertexCount ?? drawOpts.vertices ?? 3,
    firstVertex: callOpts.firstVertex ?? 0,
  };
}

function validateOptionalDrawCount(label: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (Number.isInteger(value) && value >= 0) return;
  throw new VGPUError({
    code: "VGPU-R1-DRAW-COUNT",
    message: `${field} de '${label}' debe ser un entero >= 0; recibí ${String(value)}. Usá 0 solo cuando quieras emitir un draw válido sin vértices/instancias.`,
    where: `${label}.draw`,
  });
}

export function drawReflection(draw: Draw): Reflection { return drawState(draw).reflection; }

export function drawBindingState(draw: Draw, name: string): BindingState | undefined { return drawState(draw).setCore.bindingState(name); }

export function registerDrawBundle(draw: Draw, bundle: BundleBackReference): void { drawState(draw).recordedIn.add(bundle); }

export function encodeDraw(draw: InternalDraw, pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
  draw.encode(pass, target, opts, claimValidation);
}

function drawState(draw: Draw): DrawState {
  const state = drawStates.get(draw);
  if (!state) throw new TypeError("Invalid Draw instance");
  return state;
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

function dynamicEntries(draw: InternalDraw, group: number): GPUBindGroupLayoutEntry[] {
  return bindGroupLayoutEntriesForGroup(drawState(draw).reflection.bindings, group).map(dynamicEntry);
}

function dynamicEntry(entry: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  if (!entry.buffer) return entry;
  return { ...entry, buffer: { ...entry.buffer, hasDynamicOffset: true } };
}
