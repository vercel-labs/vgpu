import { attachBindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, discardLastClaimedGroupValidationScope, popLastClaimedGroupValidationScope, preferClaimedGroupValidationResult, pushClaimedGroupValidationScope, submittedWorkDone, type ClaimedGroupValidationContext, type ClaimedGroupValidationResult, type ValidationErrorSink } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import { createSetCore, type BindingIdentityChange, type BindingState, type SetBag, type SetCore } from "./set-core.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, visibilityForEntries, type BindingVisibilityFn } from "./set-layouts.ts";
import type { CompileTarget, Target, TargetSignature } from "./target.ts";
import { normalizeSignature, pipelineKeyOf, signatureKeyOf, validateTargetSignature, createPipelineLayoutCache, createPipelineStore, createShaderModuleCache, type PipelineLayoutCache, type PipelineStore, type ShaderModuleCache } from "./pipeline-store.ts";
import { isTarget } from "./target-utils.ts";
import { blendInvalidError, claimedGroupNativeValidationError, meshRangeInvalidError, storageStageLimitError, targetRequiredError, VGPUError, writeMaskInvalidError } from "./errors.ts";
import { meshLayoutResolver, type MeshLayoutResolvable } from "./scene/mesh-descriptor.ts";

export type BlendPreset = "alpha" | "additive" | "premultiplied";

export interface BlendComponentOptions {
  readonly src: GPUBlendFactor;
  readonly dst: GPUBlendFactor;
  /** Defaults to "add". */
  readonly op?: GPUBlendOperation;
}

export interface BlendOptions {
  readonly color: BlendComponentOptions;
  /** Defaults to the color component. */
  readonly alpha?: BlendComponentOptions;
}

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
  /** Blend state applied to every color target of this draw's pipelines. Preset or explicit components. Immutable after construction. */
  readonly blend?: BlendPreset | BlendOptions;
  /** Channels written to color targets. Omit to write all (rgba). Empty array writes nothing. */
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
}

export interface DrawCallOptions {
  readonly target?: Target;
  readonly offsets?: readonly number[] | Partial<Record<number, readonly number[]>>;
  /** Instance count precedence: per-call > DrawOptions.instances > mesh.instanceCount > 1. Use 0 for a valid no-instance draw. */
  readonly instances?: number;
  /** Vertex count precedence for non-indexed draws: per-call > mesh.vertexCount > DrawOptions.vertices > 3. Indexed meshes ignore it and use MeshLike.indexCount. */
  readonly vertices?: number;
  /** Indexed draw count precedence: per-call > mesh.indexCount. */
  readonly indices?: number;
  /** Starting vertex for non-indexed draws. Defaults to mesh.firstVertex or 0. */
  readonly firstVertex?: number;
  /** Indexed first index precedence: per-call > mesh.firstIndex > 0. */
  readonly firstIndex?: number;
  /** Indexed base vertex precedence: per-call > mesh.baseVertex > 0. */
  readonly baseVertex?: number;
  /** First instance precedence: per-call > DrawOptions.firstInstance > 0. */
  readonly firstInstance?: number;
}

export interface DrawLayoutOptions {
  readonly dynamicOffsets?: boolean;
}

export interface MeshLike {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount?: number;
  readonly vertexBuffers?: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly topology?: GPUPrimitiveTopology;
  readonly stripIndexFormat?: GPUIndexFormat;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstVertex?: number;
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
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly cache: BindGroupCache;
  readonly defaultTarget?: Target;
  readonly reflection: Reflection;
  readonly visibility: BindingVisibilityFn;
  readonly vertexEntry: string;
  readonly fragmentEntry: string;
  readonly setCore: SetCore;
  readonly bindGroupLayouts: Map<number, GPUBindGroupLayout>;
  pipelineLayout: GPUPipelineLayout;
  readonly shaderModule: GPUShaderModule;
  readonly pipelineStore: PipelineStore;
  readonly pipelineLayouts: PipelineLayoutCache;
  readonly errorSink?: ValidationErrorSink;
  readonly trackSettled?: (promise: Promise<unknown>) => void;
  readonly resolvedPipelineKeys: Set<string>;
  readonly recordedIn: BundleBackReferenceRegistry;
  readonly blendState?: GPUBlendState;
  readonly writeMask?: number;
  readonly fragmentKey?: string;
};

const drawStates = new WeakMap<Draw, DrawState>();

export interface Draw {
  readonly gpu: GPURenderPipeline | undefined;
  readonly targets: readonly Target[] | undefined;
  set(values: SetBag): this;
  group(n: number, bindGroup: GPUBindGroup): this;
  layout(n: number, opts?: DrawLayoutOptions): GPUBindGroupLayout;
  draw(target?: Target | DrawCallOptions): void;
  compile(target?: CompileTarget): Promise<this>;
  compileSync(target?: CompileTarget): this;
}

/** Renderable shader unit with explicit bind layouts, set() ownership, pipeline cache, and R4 group hooks. */
export class InternalDraw implements Draw {
  readonly label: string;
  readonly #dynamicBindGroupLayouts = new Map<number, GPUBindGroupLayout>();

  constructor(
    device: Device,
    readonly source: string,
    opts: DrawOptions,
    cache: BindGroupCache = createBindGroupCache(),
    defaultTarget?: Target,
    pipelineStore: PipelineStore = createPipelineStore(device),
    shaderModules: ShaderModuleCache = createShaderModuleCache(device),
    pipelineLayouts: PipelineLayoutCache = createPipelineLayoutCache(device),
    errorSink?: ValidationErrorSink,
    trackSettled?: (promise: Promise<unknown>) => void,
  ) {
    this.label = opts.label ?? "draw";
    const id = nextDrawId++;
    const reflection = reflectSource(source, `${this.label}.wgsl`);
    const vertexEntry = reflection.entryPoints.find((entry) => entry.stage === "vertex");
    const fragmentEntry = reflection.entryPoints.find((entry) => entry.stage === "fragment");
    const selectedEntries = [vertexEntry, fragmentEntry].filter((entry): entry is EntryPointInfo => !!entry);
    const visibility = visibilityForEntries(reflection.bindings, selectedEntries);
    validateStorageStageLimits(device, this.label, reflection.bindings, selectedEntries, visibility);
    const mesh = opts.mesh as (MeshLike & Partial<MeshLayoutResolvable>) | undefined;
    const inputs = vertexEntry?.inputs ?? [];
    const vertexBufferLayouts = mesh && meshLayoutResolver in mesh ? mesh[meshLayoutResolver]!(inputs, `${this.label}.mesh`) : mesh?.vertexBufferLayouts;
    const bindGroupLayouts = new Map(bindGroupLayoutsForReflection(device, this.label, reflection, visibility));
    const pipelineLayout = pipelineLayouts.get(bindGroupLayouts);
    const shaderModule = shaderModules.get(source, `${this.label}.shader`);
    const recordedIn = createBundleRegistry();
    const fragmentState = normalizeFragmentState(this.label, opts);
    const setCore = createSetCore({
      device,
      label: this.label,
      drawId: id,
      reflection,
      bindGroupLayouts,
      cache,
      onIdentityChange: (change) => recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change }),
    });
    drawStates.set(this, { id, device, opts, vertexBufferLayouts, cache, defaultTarget, reflection, visibility, vertexEntry: vertexEntry?.name ?? "vs_main", fragmentEntry: fragmentEntry?.name ?? "fs_main", setCore, bindGroupLayouts, pipelineLayout, shaderModule, pipelineStore, pipelineLayouts, errorSink, trackSettled, resolvedPipelineKeys: new Set(), recordedIn, ...fragmentState });
    if (opts.set) this.set(opts.set);
    for (const target of opts.targets ?? []) this.compileSync(target);
  }

  get gpu(): GPURenderPipeline | undefined {
    const state = drawState(this);
    for (const key of state.resolvedPipelineKeys) {
      const pipeline = state.pipelineStore.getReady(key);
      if (pipeline) return pipeline;
    }
    return undefined;
  }
  get targets(): readonly Target[] | undefined { return drawState(this).opts.targets; }

  set(values: SetBag): this {
    const state = drawState(this);
    for (const change of state.setCore.set(values)) state.recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change });
    return this;
  }

  group(n: number, bindGroup: GPUBindGroup): this {
    const state = drawState(this);
    const expectedLayout = this.#dynamicBindGroupLayouts.get(n) ?? this.layout(n);
    const previousIdentity = state.setCore.claimGroup(n, bindGroup, expectedLayout);
    state.recordedIn.markStale({ kind: "group-claim", drawLabel: this.label, group: n, previousIdentity, newIdentity: `claimed-group:${n}` });
    return this;
  }

  layout(n: number, opts: DrawLayoutOptions = {}): GPUBindGroupLayout {
    if (!opts.dynamicOffsets) return drawState(this).setCore.layout(n);
    return this.#dynamicLayout(n);
  }

  #dynamicLayout(group: number): GPUBindGroupLayout {
    const state = drawState(this);
    state.setCore.layout(group);
    const existing = this.#dynamicBindGroupLayouts.get(group);
    if (existing) return existing;
    const entries = dynamicEntries(this, group);
    const rawLayout = state.device.gpu.createBindGroupLayout({ label: `${this.label}.group${group}.dynamic.bgl`, entries });
    const layout = attachBindGroupLayoutMetadata(rawLayout, { entries });
    this.#dynamicBindGroupLayouts.set(group, layout);
    state.bindGroupLayouts.set(group, layout);
    state.pipelineLayout = state.pipelineLayouts.get(state.bindGroupLayouts);
    return layout;
  }

  /**
   * Encodes and submits this draw as a one-shot render pass.
   *
   * Raw claimed-bind-group validation failures are delivered asynchronously via
   * `gpu.onError` as `VGPU-R4-GROUP-VALIDATION`.
   */
  draw(arg: Target | DrawCallOptions = {}): void {
    const opts = isTarget(arg) ? { target: arg } : arg;
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
      if (context) {
        void reportDrawValidationError(state, context.label, context.group, error);
        return;
      }
      throw error;
    }
    if (finishContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result) validations[0] = validations[0] ? preferClaimedGroupValidationResult(result, validations[0]) : result;
    }
    const submitContext = validations[0]?.context;
    if (submitContext) pushClaimedGroupValidationScope(state.device, submitContext);
    try { state.device.gpu.queue.submit([commandBuffer]); }
    catch (error) {
      const result = submitContext ? popLastClaimedGroupValidationScope(state.device) : undefined;
      discardClaimedGroupValidationResults(validations);
      if (result) discardClaimedGroupValidationResults([result]);
      const context = result?.context ?? submitContext;
      if (context) {
        void reportDrawValidationError(state, context.label, context.group, error);
        return;
      }
      throw error;
    }
    if (submitContext) {
      const result = popLastClaimedGroupValidationScope(state.device);
      if (result) validations[0] = validations[0] ? preferClaimedGroupValidationResult(result, validations[0]) : result;
    }
    if (validations.length) {
      const done = claimedGroupValidationDone(state.device, validations, { errorSink: state.errorSink });
      state.trackSettled?.(done);
    }
  }

  encode(pass: GPURenderPassEncoder, target: Target | TargetSignature, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    const pipeline = this.pipelineFor(target);
    if (!pipeline) return;
    pass.setPipeline(pipeline);
    for (const binding of drawState(this).setCore.bindGroups()) this.#setBindGroup(pass, binding, opts, claimValidation);
    this.#encodeMesh(pass, opts);
  }

  #setBindGroup(pass: GPURenderPassEncoder, binding: BindGroupBinding, opts: DrawCallOptions, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
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

  compile(target?: CompileTarget): Promise<this> {
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.compile`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.compile`, signature: signatureKey });
    return promise.then(() => {
      drawState(this).resolvedPipelineKeys.add(key);
      return this;
    });
  }

  compileSync(target?: CompileTarget): this {
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.compileSync`);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.compileSync`, signature: signatureKey });
    if (pipeline) drawState(this).resolvedPipelineKeys.add(key);
    return this;
  }

  pipelineFor(target: Target | TargetSignature): GPURenderPipeline | undefined {
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.pipelineFor`);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.pipelineFor`, signature: signatureKey });
    if (pipeline) drawState(this).resolvedPipelineKeys.add(key);
    return pipeline;
  }

  pipelineForAsync(target: Target | TargetSignature): Promise<GPURenderPipeline> {
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.pipelineForAsync`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.pipelineForAsync`, signature: signatureKey });
    void promise.then(() => drawState(this).resolvedPipelineKeys.add(key), () => undefined);
    return promise;
  }

  #compileKey(target: CompileTarget | undefined, where: string): { readonly signature: TargetSignature; readonly signatureKey: string; readonly key: string } {
    const signature = this.#signatureForKeyTarget(target, where);
    const signatureKey = signatureKeyOf(signature);
    return { signature, signatureKey, key: this.#pipelineKey(signature) };
  }

  #signatureForKeyTarget(target: CompileTarget | undefined, where: string): TargetSignature {
    const state = drawState(this);
    const resolvedTarget = target ?? state.defaultTarget;
    if (!resolvedTarget) throw targetRequiredError(where);
    const signature = normalizeSignature(resolvedTarget);
    validateTargetSignature(signature, where);
    return signature;
  }

  #pipelineKey(signature: TargetSignature): string {
    const state = drawState(this);
    const mesh = state.opts.mesh;
    return pipelineKeyOf({ module: state.shaderModule, pipelineLayout: state.pipelineLayout, vertexBufferLayouts: state.vertexBufferLayouts, signature, fragmentKey: state.fragmentKey, topology: mesh?.topology, stripIndexFormat: mesh?.stripIndexFormat });
  }

  #encodeMesh(pass: GPURenderPassEncoder, callOpts: DrawCallOptions = {}): void {
    const mesh = drawState(this).opts.mesh;
    if (mesh?.vertexBuffers) mesh.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    const counts = resolveDrawCounts(this.label, mesh, drawState(this).opts, callOpts);
    if (!mesh?.indexBuffer) return pass.draw(counts.vertexCount, counts.instanceCount, counts.firstVertex, counts.firstInstance);
    pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat ?? "uint32");
    pass.drawIndexed(counts.indexCount, counts.instanceCount, counts.firstIndex, counts.baseVertex, counts.firstInstance);
  }

  #createPipeline(signature: TargetSignature): GPURenderPipeline {
    const state = drawState(this);
    return state.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...(state.vertexBufferLayouts ?? [])] },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state) },
      primitive: primitiveState(state.opts.mesh),
      depthStencil: signature.depth ? { format: signature.depth, depthWriteEnabled: true, depthCompare: "less" } : undefined,
      multisample: { count: signature.sampleCount ?? 1 },
    });
  }

  #createPipelineAsync(signature: TargetSignature): Promise<GPURenderPipeline> {
    const state = drawState(this);
    return state.device.gpu.createRenderPipelineAsync({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...(state.vertexBufferLayouts ?? [])] },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state) },
      primitive: primitiveState(state.opts.mesh),
      depthStencil: signature.depth ? { format: signature.depth, depthWriteEnabled: true, depthCompare: "less" } : undefined,
      multisample: { count: signature.sampleCount ?? 1 },
    });
  }
}

function validateStorageStageLimits(device: Device, label: string, bindings: readonly BindingInfo[], entries: readonly EntryPointInfo[], visibility: BindingVisibilityFn): void {
  const limits = device.limits as unknown as Record<string, number | undefined>;
  for (const [stage, flag, limitName] of [["vertex", 1, "maxStorageBuffersInVertexStage"], ["fragment", 2, "maxStorageBuffersInFragmentStage"]] as const) {
    const entry = entries.find((item) => item.stage === stage);
    if (!entry) continue;
    const used = bindings.filter((binding) => binding.bindingLayout?.kind === "buffer" && binding.bindingLayout.buffer.type !== "uniform" && (visibility(binding) & flag));
    const limit = limits[limitName] ?? limits.maxStorageBuffersPerShaderStage;
    if (limit !== undefined && used.length > limit) throw storageStageLimitError(label, stage, entry.name, used.length, limit, used);
  }
}

type DrawCounts = {
  readonly instanceCount: number;
  readonly firstInstance: number;
  readonly vertexCount: number;
  readonly firstVertex: number;
  readonly indexCount: number;
  readonly firstIndex: number;
  readonly baseVertex: number;
};

function fragmentTargets(signature: TargetSignature, state: DrawState): GPUColorTargetState[] {
  return signature.colors.map((format) => {
    const target: GPUColorTargetState = { format };
    if (state.blendState) target.blend = state.blendState;
    if (state.writeMask !== undefined) target.writeMask = state.writeMask;
    return target;
  });
}

function resolveDrawCounts(label: string, mesh: MeshLike | undefined, drawOpts: DrawOptions, callOpts: DrawCallOptions): DrawCounts {
  validateOptionalDrawCount(label, "DrawOptions.instances", drawOpts.instances);
  validateOptionalDrawCount(label, "DrawOptions.vertices", drawOpts.vertices);
  validateOptionalDrawCount(label, "DrawOptions.firstInstance", drawOpts.firstInstance);
  validateOptionalDrawCount(label, "DrawCallOptions.instances", callOpts.instances);
  validateOptionalMeshRange(label, "DrawCallOptions.vertices", callOpts.vertices);
  validateOptionalMeshRange(label, "DrawCallOptions.indices", callOpts.indices);
  validateOptionalMeshRange(label, "DrawCallOptions.firstVertex", callOpts.firstVertex);
  validateOptionalMeshRange(label, "DrawCallOptions.firstIndex", callOpts.firstIndex);
  validateOptionalMeshRange(label, "DrawCallOptions.baseVertex", callOpts.baseVertex);
  validateOptionalDrawCount(label, "DrawCallOptions.firstInstance", callOpts.firstInstance);
  validateOptionalDrawCount(label, "MeshLike.vertexCount", mesh?.vertexCount);
  validateOptionalDrawCount(label, "MeshLike.indexCount", mesh?.indexCount);
  validateOptionalDrawCount(label, "MeshLike.instanceCount", mesh?.instanceCount);
  validateOptionalMeshRange(label, "MeshLike.firstVertex", mesh?.firstVertex);
  validateOptionalMeshRange(label, "MeshLike.firstIndex", mesh?.firstIndex);
  validateOptionalMeshRange(label, "MeshLike.baseVertex", mesh?.baseVertex);
  const indexed = !!mesh?.indexBuffer;
  const sliceParent = (mesh as (MeshLike & { readonly mesh?: MeshLike }) | undefined)?.mesh;
  const parent = sliceParent ?? (mesh && meshLayoutResolver in mesh ? mesh : undefined);
  const firstVertex = callOpts.firstVertex ?? mesh?.firstVertex ?? 0;
  const vertexCount = callOpts.vertices ?? mesh?.vertexCount ?? drawOpts.vertices ?? 3;
  const firstIndex = callOpts.firstIndex ?? mesh?.firstIndex ?? 0;
  const indexCount = callOpts.indices ?? mesh?.indexCount ?? 0;
  const baseVertex = callOpts.baseVertex ?? mesh?.baseVertex ?? 0;
  if (indexed) validateDrawInterval(label, "index", firstIndex, indexCount, parent?.indexCount);
  else if (callOpts.indices !== undefined || callOpts.firstIndex !== undefined || callOpts.baseVertex !== undefined) throw meshRangeInvalidError(`${label}.draw`, "Index range needs an indexed mesh.");
  if (!indexed) validateDrawInterval(label, "vertex", firstVertex, vertexCount, parent?.vertexCount);
  return {
    instanceCount: callOpts.instances ?? drawOpts.instances ?? mesh?.instanceCount ?? 1,
    firstInstance: callOpts.firstInstance ?? drawOpts.firstInstance ?? 0,
    vertexCount,
    firstVertex,
    indexCount,
    firstIndex,
    baseVertex,
  };
}

function primitiveState(mesh: MeshLike | undefined): GPUPrimitiveState {
  const topology = mesh?.topology ?? "triangle-list";
  const stripIndexFormat = mesh?.stripIndexFormat ?? (topology.endsWith("strip") ? mesh?.indexFormat : undefined);
  return stripIndexFormat ? { topology, stripIndexFormat } : { topology };
}

function validateDrawInterval(label: string, kind: "index" | "vertex", first: number, count: number, max: number | undefined): void {
  if (max === undefined || first + count <= max) return;
  throw meshRangeInvalidError(`${label}.draw`, `${kind} range [${first}, ${first + count}) exceeds parent mesh ${kind} count ${max}.`);
}

function validateOptionalMeshRange(label: string, field: string, value: number | undefined): void {
  if (value === undefined || (Number.isInteger(value) && value >= 0)) return;
  throw meshRangeInvalidError(`${label}.draw`, `${field} must be an integer >= 0; received ${String(value)}.`);
}

function validateOptionalDrawCount(label: string, field: string, value: number | undefined): void {
  if (value === undefined) return;
  if (Number.isInteger(value) && value >= 0) return;
  throw new VGPUError({
    code: "VGPU-R1-DRAW-COUNT",
    message: `${field} of '${label}' must be an integer >= 0; received ${String(value)}. Use 0 only when you want to issue a valid draw with no vertices/instances.`,
    where: `${label}.draw`,
  });
}

type NormalizedFragmentState = {
  readonly blendState?: GPUBlendState;
  readonly writeMask?: number;
  readonly fragmentKey?: string;
};

function normalizeFragmentState(label: string, opts: DrawOptions): NormalizedFragmentState {
  const blendState = opts.blend === undefined ? undefined : normalizeBlend(label, opts.blend);
  const writeMask = opts.writeMask === undefined ? undefined : normalizeWriteMask(label, opts.writeMask);
  const fragmentKey = blendState || writeMask !== undefined ? fragmentKeyFor(blendState, writeMask) : undefined;
  return { blendState, writeMask, fragmentKey };
}

function normalizeBlend(label: string, value: BlendPreset | BlendOptions): GPUBlendState {
  if (value === "alpha") return blendState({ src: "src-alpha", dst: "one-minus-src-alpha" }, { src: "one", dst: "one-minus-src-alpha" });
  if (value === "premultiplied") return blendState({ src: "one", dst: "one-minus-src-alpha" }, { src: "one", dst: "one-minus-src-alpha" });
  if (value === "additive") return blendState({ src: "one", dst: "one" }, { src: "one", dst: "one" });
  if (typeof value !== "object" || value === null || !validBlendComponent(value.color)) throw blendInvalidError(label, value);
  const color = value.color;
  const alpha = value.alpha;
  if (alpha !== undefined && !validBlendComponent(alpha)) throw blendInvalidError(label, value);
  return blendState(color, alpha ?? color);
}

function validBlendComponent(value: unknown): value is BlendComponentOptions {
  return typeof value === "object" && value !== null
    && typeof (value as BlendComponentOptions).src === "string"
    && typeof (value as BlendComponentOptions).dst === "string";
}

function blendState(color: BlendComponentOptions, alpha: BlendComponentOptions): GPUBlendState {
  return { color: blendComponent(color), alpha: blendComponent(alpha) };
}

function blendComponent(component: BlendComponentOptions): GPUBlendComponent {
  return { srcFactor: component.src, dstFactor: component.dst, operation: component.op ?? "add" };
}

function normalizeWriteMask(label: string, value: readonly ("r" | "g" | "b" | "a")[]): number {
  if (!Array.isArray(value)) throw writeMaskInvalidError(label, preview(value));
  let mask = 0;
  for (const channel of value) {
    if (channel === "r") mask |= 1;
    else if (channel === "g") mask |= 2;
    else if (channel === "b") mask |= 4;
    else if (channel === "a") mask |= 8;
    else throw writeMaskInvalidError(label, preview(channel));
  }
  return mask;
}

function fragmentKeyFor(blend: GPUBlendState | undefined, mask: number | undefined): string {
  const writeMask = mask ?? 15;
  if (!blend) return `none;none;${writeMask}`;
  const c = blend.color;
  const a = blend.alpha;
  return `${c.srcFactor},${c.dstFactor},${c.operation};${a.srcFactor},${a.dstFactor},${a.operation};${writeMask}`;
}

function preview(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function drawReflection(draw: Draw): Reflection { return drawState(draw).reflection; }

export function drawBindingState(draw: Draw, name: string): BindingState | undefined { return drawState(draw).setCore.bindingState(name); }

export function registerDrawBundle(draw: Draw, bundle: BundleBackReference): void { drawState(draw).recordedIn.add(bundle); }

export function encodeDraw(draw: InternalDraw, pass: GPURenderPassEncoder, target: Target | TargetSignature, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
  draw.encode(pass, target, opts, claimValidation);
}

function drawState(draw: Draw): DrawState {
  const state = drawStates.get(draw);
  if (!state) throw new TypeError("Invalid Draw instance");
  return state;
}

function reportDrawValidationError(state: DrawState, label: string, group: number, cause: unknown): Promise<void> {
  const delivery = (async () => {
    await submittedWorkDone(state.device);
    const error = claimedGroupNativeValidationError(label, group, cause);
    if (state.errorSink) await state.errorSink(error);
    else console.error(error);
  })();
  state.trackSettled?.(delivery);
  return delivery;
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
  const state = drawState(draw);
  return bindGroupLayoutEntriesForGroup(state.reflection.bindings, group, state.visibility).map(dynamicEntry);
}

function dynamicEntry(entry: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  if (!entry.buffer) return entry;
  return { ...entry, buffer: { ...entry.buffer, hasDynamicOffset: true } };
}
