import type { Device } from "@vgpu/core";
import type { ShaderSource } from "@vgpu/wgsl";
import { reflectSource, type BindingInfo, type EntryPointInfo, type Reflection } from "@vgpu/wgsl/reflect-source";
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { claimedGroupValidationDone, discardClaimedGroupValidationResults, discardClaimedGroupValidationScopes, discardLastClaimedGroupValidationScope, popLastClaimedGroupValidationScope, preferClaimedGroupValidationResult, pushClaimedGroupValidationScope, submittedWorkDone, type ClaimedGroupValidationContext, type ClaimedGroupValidationResult, type ValidationErrorSink } from "./claim-validation.ts";
import { endRenderPassWithClaimValidation } from "./claim-validation-encode.ts";
import { createSetCore, type BindingIdentityChange, type BindingState, type SetBag, type SetCore } from "./set-core.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, cachedBindGroupLayout, visibilityForEntries, type BindingVisibilityFn } from "./set-layouts.ts";
import type { CompileTarget, Target, TargetSignature } from "./target.ts";
import { normalizeConstantsOptions, normalizeSignature, pipelineKeyOf, selectEntryPoint, signatureKeyOf, validateTargetSignature, createPipelineLayoutCache, createPipelineStore, createShaderModuleCache, type PipelineLayoutCache, type PipelineStore, type ShaderModuleCache } from "./pipeline-store.ts";
import { hasStencilAspect, isTarget } from "./target-utils.ts";
import { blendConstantInvalidError, blendInvalidError, claimedGroupNativeValidationError, colorsInvalidError, cullInvalidError, depthInvalidError, entryInvalidError, frontFaceInvalidError, indirectInvalidError, meshRangeInvalidError, multisampleInvalidError, stencilInvalidError, storageStageLimitError, surfaceNotInFrameError, targetRequiredError, unclippedDepthInvalidError, VGPUError, writeMaskInvalidError } from "./errors.ts";
import { isFrameActive, isSurface } from "./surface.ts";
import { assertDeviceUsable } from "./lifecycle.ts";
import { geometryLayoutResolver, type GeometryLayoutResolvable } from "./draw-protocols.ts";
import { resolveIndirect } from "./indirect.ts";
import type { StorageBuffer } from "./api-types.ts";
import { FRAME_DRAWABLE, type FrameDrawableProtocol } from "./frame-protocols.ts";
import { liveKernel } from "./live-kernel.ts";
import { renderService } from "./render-service.ts";
import { toWgsl } from "./shader-source.ts";
import type { Gpu } from "./kernel.ts";

/**
 * Renderable shader unit of this gpu: a WGSL shader plus its pipeline state, bindings and
 * optional geometry. Encode it with `pass.draw(triangle)` or call `triangle.draw(target)`.
 *
 * Pipelines, bind groups, shader modules and layouts come from the gpu's single render service, so
 * two draws with the same shader and target signature share one compiled pipeline — and an
 * `effect()` shares that same cache set. Nothing here exists until the first render call: `init()`
 * creates no cache.
 */
export function draw(gpu: Gpu, opts: DrawOptions): Draw {
  const kernel = liveKernel(gpu, "draw");
  const render = renderService(kernel);
  const shader = toWgsl(opts.shader);
  return new InternalDraw(
    kernel.device,
    shader,
    { ...opts, shader },
    render.binds,
    undefined,
    render.pipelines,
    render.shaderModules,
    render.pipelineLayouts,
    (error) => kernel.reportError(error),
    (promise) => { void kernel.trackDelivery(promise); },
  );
}

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

export interface DepthOptions {
  /** Whether fragments write depth. Defaults to true. */
  readonly write?: boolean;
  /** Depth comparison that passing fragments satisfy. Defaults to "less-equal". */
  readonly compare?: GPUCompareFunction;
  /** Constant depth bias. Must be an integer (WebGPU depthBias is i32). Defaults to 0. Triangle topologies only. */
  readonly bias?: number;
  /** Depth bias that scales with the fragment's slope. Defaults to 0. Triangle topologies only. */
  readonly biasSlopeScale?: number;
  /** Maximum depth bias of a fragment. Defaults to 0 (no clamp). Triangle topologies only. */
  readonly biasClamp?: number;
}

export interface StencilFaceOptions {
  /** Comparison against the masked stencil value that passing fragments satisfy. Defaults to "always". */
  readonly compare?: GPUCompareFunction;
  /** Operation when the stencil comparison fails. Defaults to "keep". */
  readonly fail?: GPUStencilOperation;
  /** Operation when the stencil comparison passes but the depth comparison fails. Defaults to "keep". */
  readonly depthFail?: GPUStencilOperation;
  /** Operation when both the stencil and depth comparisons pass. Defaults to "keep". */
  readonly pass?: GPUStencilOperation;
}

export interface StencilOptions {
  /** Stencil state for front-facing primitives. Defaults to WebGPU's { compare: "always", fail/depthFail/pass: "keep" }. */
  readonly front?: StencilFaceOptions;
  /** Stencil state for back-facing primitives. Defaults to mirroring the normalized front. */
  readonly back?: StencilFaceOptions;
  /** Bitmask applied to the stencil value before comparisons. Integer in [0, 0xFFFFFFFF]. Defaults to 0xFFFFFFFF. */
  readonly readMask?: number;
  /** Bitmask of stencil bits writable by stencil operations. Integer in [0, 0xFFFFFFFF]. Defaults to 0xFFFFFFFF. */
  readonly writeMask?: number;
  /** Stencil reference value used by "replace" and the compare. Emitted as encoder state (setStencilReference) before this draw; not part of the pipeline. Defaults to the pass default 0. */
  readonly ref?: number;
}

export interface DrawOptions {
  readonly shader: string | ShaderSource;
  readonly geometry?: GeometryLike;
  readonly set?: SetBag;
  readonly label?: string;
  readonly targets?: readonly Target[];
  /** Default instance count for every draw call. Overridden by per-call opts. Use 0 for a valid no-instance draw. */
  readonly instances?: number;
  /** Vertex count when rendering without a geometry. Geometry.vertexCount wins over this default; indexed geometries ignore it and use GeometryLike.indexCount. */
  readonly vertices?: number;
  /** Default firstInstance for every draw call. Overridden by per-call opts. */
  readonly firstInstance?: number;
  /** Blend state applied to every color target of this draw's pipelines. Preset or explicit components. Immutable after construction. */
  readonly blend?: BlendPreset | BlendOptions;
  /** Blend constant used by "constant"/"one-minus-constant" blend factors. Emitted as encoder state before this draw; not part of the pipeline. Immutable after construction. */
  readonly blendConstant?: readonly [number, number, number, number];
  /** Channels written to color targets. Omit to write all (rgba). Empty array writes nothing. */
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
  /** Per-color-target blend/writeMask overrides, aligned by index with the target's color attachments. null or missing entries inherit the top-level blend/writeMask. Immutable after construction. */
  readonly colors?: readonly ({
    readonly blend?: BlendPreset | BlendOptions;
    readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
  } | null)[];
  /** Face culling applied to this draw's pipelines. Defaults to "none". Immutable after construction. */
  readonly cull?: "none" | "front" | "back";
  /** Winding that counts as front-facing. Defaults to "ccw". Immutable after construction. */
  readonly frontFace?: "ccw" | "cw";
  /** Disables depth clipping so geometry outside [near, far] is not clipped. Requires the "depth-clip-control" device feature. Defaults to false. Immutable after construction. */
  readonly unclippedDepth?: boolean;
  /** Depth state for targets with a depth attachment. Pass false to disable depth testing entirely. Defaults to { write: true, compare: "less-equal" }. Immutable after construction. Ignored when the target has no depth. */
  readonly depth?: false | DepthOptions;
  /** Stencil state for targets whose depth format has a stencil aspect. Immutable after construction. */
  readonly stencil?: StencilOptions;
  /** Multisample state for MSAA targets. Immutable after construction. */
  readonly multisample?: {
    /** Converts fragment alpha into a coverage mask. Requires an MSAA target. Defaults to false. */
    readonly alphaToCoverage?: boolean;
    /** Sample bitmask; only the low sampleCount bits matter. Defaults to 0xFFFFFFFF. */
    readonly mask?: number;
  };
  /** Values for WGSL `override` constants, keyed by name (or by numeric id as a string when the override has @id). Immutable after construction. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
  /** Entry points to use when the shader has several. Omitted fields use the first entry point of that stage. Immutable after construction. */
  readonly entry?: { readonly vertex?: string; readonly fragment?: string };
}

export interface DrawCallOptions {
  readonly target?: Target;
  readonly offsets?: readonly number[] | Partial<Record<number, readonly number[]>>;
  /** Instance count precedence: per-call > DrawOptions.instances > geometry.instanceCount > 1. Use 0 for a valid no-instance draw. */
  readonly instances?: number;
  /** Vertex count precedence for non-indexed draws: per-call > geometry.vertexCount > DrawOptions.vertices > 3. Indexed geometries ignore it and use GeometryLike.indexCount. */
  readonly vertices?: number;
  /** Indexed draw count precedence: per-call > geometry.indexCount. */
  readonly indices?: number;
  /** Starting vertex for non-indexed draws. Defaults to geometry.firstVertex or 0. */
  readonly firstVertex?: number;
  /** Indexed first index precedence: per-call > geometry.firstIndex > 0. */
  readonly firstIndex?: number;
  /** Indexed base vertex precedence: per-call > geometry.baseVertex > 0. */
  readonly baseVertex?: number;
  /** First instance precedence: per-call > DrawOptions.firstInstance > 0. */
  readonly firstInstance?: number;
  /** GPU-driven draw: read draw arguments from a buffer instead of CPU-side counts. */
  readonly indirect?: StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };
}

export interface DrawLayoutOptions {
  readonly dynamicOffsets?: boolean;
}

export interface GeometryLike {
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
  readonly blendConstant?: GPUColorDict;
  readonly writeMask?: number;
  readonly colorStates?: readonly (NormalizedColorTargetState | null)[];
  readonly fragmentKey?: string;
  readonly cullMode?: GPUCullMode;
  readonly frontFace?: GPUFrontFace;
  readonly unclippedDepth?: true;
  readonly depthState?: NormalizedDepthState;
  readonly depthKey?: string;
  readonly stencilState?: NormalizedStencilState;
  readonly stencilKey?: string;
  readonly stencilRef?: number;
  readonly multisampleState?: NormalizedMultisampleState;
  readonly multisampleKey?: string;
  readonly constants?: Readonly<Record<string, GPUPipelineConstantValue>>;
  readonly constantsKey?: string;
  readonly entryKey?: string;
};

const drawStates = new WeakMap<Draw, DrawState>();

export interface Draw {
  readonly gpu: GPURenderPipeline | undefined;
  readonly targets: readonly Target[] | undefined;
  set(values: SetBag): this;
  group(n: number, bindGroup: GPUBindGroup): this;
  layout(n: number, opts?: DrawLayoutOptions): GPUBindGroupLayout;
  draw(target?: Target | DrawCallOptions): void;
  /** @throws VGPU-SURFACE-NOT-IN-FRAME when passed a Surface outside frame(gpu). */
  compile(target?: CompileTarget): Promise<this>;
  /** @throws VGPU-SURFACE-NOT-IN-FRAME when passed a Surface outside frame(gpu). */
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
    assertDeviceUsable(device, "Draw.constructor");
    this.label = opts.label ?? "draw";
    const id = nextDrawId++;
    const reflection = reflectSource(source, `${this.label}.wgsl`);
    // Entry selection runs before everything derived from the selected entries — binding visibility,
    // storage-stage limits, bind group layouts, and vertex input layouts all reflect the chosen variant.
    const entryNames = normalizeEntryOptions(this.label, opts.entry);
    const vertexEntry = selectEntryPoint(this.label, reflection.entryPoints, "vertex", entryNames.vertex, "draw");
    const fragmentEntry = selectEntryPoint(this.label, reflection.entryPoints, "fragment", entryNames.fragment, "draw");
    const entryKey = entryKeyFor(reflection, vertexEntry, fragmentEntry);
    const selectedEntries = [vertexEntry, fragmentEntry].filter((entry): entry is EntryPointInfo => !!entry);
    const visibility = visibilityForEntries(reflection.bindings, selectedEntries);
    validateStorageStageLimits(device, this.label, reflection.bindings, selectedEntries, visibility);
    const geometry = opts.geometry as (GeometryLike & Partial<GeometryLayoutResolvable>) | undefined;
    const inputs = vertexEntry?.inputs ?? [];
    const vertexBufferLayouts = geometry && geometryLayoutResolver in geometry ? geometry[geometryLayoutResolver]!(inputs, `${this.label}.geometry`) : geometry?.vertexBufferLayouts;
    const bindGroupLayouts = new Map(bindGroupLayoutsForReflection(device, this.label, reflection, visibility));
    const pipelineLayout = pipelineLayouts.get(bindGroupLayouts);
    const shaderModule = shaderModules.get(source, `${this.label}.shader`);
    const recordedIn = createBundleRegistry();
    const fragmentState = normalizeFragmentState(this.label, opts);
    const blendConstantOptions = normalizeBlendConstantOptions(this.label, opts, fragmentState);
    const primitiveOptions = normalizePrimitiveOptions(device, this.label, opts);
    const depthOptions = normalizeDepthOptions(device, this.label, opts);
    const stencilOptions = normalizeStencilOptions(this.label, opts);
    const multisampleOptions = normalizeMultisampleOptions(this.label, opts);
    const constantsOptions = normalizeConstantsOptions(this.label, opts.constants, reflection.overrides, "draw");
    const setCore = createSetCore({
      device,
      label: this.label,
      drawId: id,
      reflection,
      bindGroupLayouts,
      cache,
      onIdentityChange: (change) => recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change }),
    });
    drawStates.set(this, { id, device, opts, vertexBufferLayouts, cache, defaultTarget, reflection, visibility, vertexEntry: vertexEntry?.name ?? "vs_main", fragmentEntry: fragmentEntry?.name ?? "fs_main", entryKey, setCore, bindGroupLayouts, pipelineLayout, shaderModule, pipelineStore, pipelineLayouts, errorSink, trackSettled, resolvedPipelineKeys: new Set(), recordedIn, ...fragmentState, ...blendConstantOptions, ...primitiveOptions, ...depthOptions, ...stencilOptions, ...multisampleOptions, ...constantsOptions });
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

  /**
   * Frame drawable protocol: a `Frame` encodes through this instead of importing draw.ts, so a
   * program that never draws never pulls this module. The instance is its own protocol object —
   * `encode`, `label` and the depth/stencil metadata below are exactly what a pass needs.
   */
  get [FRAME_DRAWABLE](): FrameDrawableProtocol { return this; }
  /** @internal Frame drawable protocol; see {@link drawWritesDepth}. */
  writesDepth(): boolean { return drawWritesDepth(this); }
  /** @internal Frame drawable protocol; see {@link drawStencilWritingOps}. */
  stencilWritingOps(): readonly string[] { return drawStencilWritingOps(this); }

  set(values: SetBag): this {
    const state = drawState(this);
    assertDeviceUsable(state.device, `${this.label}.set`);
    for (const change of state.setCore.set(values)) state.recordedIn.markStale({ kind: "binding-identity", drawLabel: this.label, ...change });
    return this;
  }

  group(n: number, bindGroup: GPUBindGroup): this {
    const state = drawState(this);
    assertDeviceUsable(state.device, `${this.label}.group`);
    const expectedLayout = this.#dynamicBindGroupLayouts.get(n) ?? this.layout(n);
    const previousIdentity = state.setCore.claimGroup(n, bindGroup, expectedLayout);
    state.recordedIn.markStale({ kind: "group-claim", drawLabel: this.label, group: n, previousIdentity, newIdentity: `claimed-group:${n}` });
    return this;
  }

  layout(n: number, opts: DrawLayoutOptions = {}): GPUBindGroupLayout {
    assertDeviceUsable(drawState(this).device, `${this.label}.layout`);
    if (!opts.dynamicOffsets) return drawState(this).setCore.layout(n);
    return this.#dynamicLayout(n);
  }

  #dynamicLayout(group: number): GPUBindGroupLayout {
    const state = drawState(this);
    state.setCore.layout(group);
    const existing = this.#dynamicBindGroupLayouts.get(group);
    if (existing) return existing;
    const entries = dynamicEntries(this, group);
    const layout = cachedBindGroupLayout(state.device, `${this.label}.group${group}.dynamic.bgl`, entries);
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
    assertDeviceUsable(drawState(this).device, `${this.label}.draw`);
    const opts = isTarget(arg) ? { target: arg } : arg;
    const state = drawState(this);
    const target = opts.target ?? state.defaultTarget;
    if (!target) throw targetRequiredError(`${this.label}.draw`);
    assertSurfaceTargetInFrame(target, `${this.label}.draw`);
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
    assertDeviceUsable(drawState(this).device, `${this.label}.encode`);
    const pipeline = this.pipelineFor(target, true);
    if (!pipeline) return;
    pass.setPipeline(pipeline);
    const state = drawState(this);
    if (state.blendConstant) pass.setBlendConstant(state.blendConstant);
    // Explicit ref always emits — even 0, which restores the pass default after an earlier draw changed it.
    if (state.stencilRef !== undefined) pass.setStencilReference(state.stencilRef);
    for (const binding of state.setCore.bindGroups()) this.#setBindGroup(pass, binding, opts, claimValidation);
    this.#encodeGeometry(pass, opts);
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
    assertDeviceUsable(drawState(this).device, `${this.label}.compile`);
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.compile`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.compile`, signature: signatureKey });
    return promise.then(() => {
      assertDeviceUsable(drawState(this).device, `${this.label}.compile`);
      drawState(this).resolvedPipelineKeys.add(key);
      return this;
    });
  }

  compileSync(target?: CompileTarget): this {
    assertDeviceUsable(drawState(this).device, `${this.label}.compileSync`);
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.compileSync`);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.compileSync`, signature: signatureKey });
    if (pipeline) drawState(this).resolvedPipelineKeys.add(key);
    return this;
  }

  pipelineFor(target: Target | TargetSignature, allowSurface = false): GPURenderPipeline | undefined {
    assertDeviceUsable(drawState(this).device, `${this.label}.pipelineFor`);
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.pipelineFor`, allowSurface);
    const pipeline = drawState(this).pipelineStore.getSync(key, () => this.#createPipeline(signature), { where: `${this.label}.pipelineFor`, signature: signatureKey });
    if (pipeline) drawState(this).resolvedPipelineKeys.add(key);
    return pipeline;
  }

  pipelineForAsync(target: Target | TargetSignature): Promise<GPURenderPipeline> {
    assertDeviceUsable(drawState(this).device, `${this.label}.pipelineForAsync`);
    const { key, signature, signatureKey } = this.#compileKey(target, `${this.label}.pipelineForAsync`);
    const promise = drawState(this).pipelineStore.getAsync(key, () => this.#createPipelineAsync(signature), { where: `${this.label}.pipelineForAsync`, signature: signatureKey });
    return promise.then((pipeline) => {
      assertDeviceUsable(drawState(this).device, `${this.label}.pipelineForAsync`);
      drawState(this).resolvedPipelineKeys.add(key);
      return pipeline;
    });
  }

  #compileKey(target: CompileTarget | undefined, where: string, allowSurface = false): { readonly signature: TargetSignature; readonly signatureKey: string; readonly key: string } {
    const signature = this.#signatureForKeyTarget(target, where, allowSurface);
    const signatureKey = signatureKeyOf(signature);
    return { signature, signatureKey, key: this.#pipelineKey(signature) };
  }

  #signatureForKeyTarget(target: CompileTarget | undefined, where: string, allowSurface = false): TargetSignature {
    const state = drawState(this);
    const resolvedTarget = target ?? state.defaultTarget;
    if (!resolvedTarget) throw targetRequiredError(where);
    if (!allowSurface) assertSurfaceTargetInFrame(resolvedTarget, where);
    const signature = normalizeSignature(resolvedTarget);
    validateTargetSignature(signature, where);
    if (state.colorStates && state.colorStates.length !== signature.colors.length) {
      throw colorsInvalidError(this.label, `expected one entry per color attachment; colors has ${state.colorStates.length}, but the target signature has ${signature.colors.length}.`, where);
    }
    // WebGPU: "If descriptor.alphaToCoverageEnabled is true: descriptor.count > 1." The companion createRenderPipeline
    // rules — targets[0].format must be blendable with an alpha channel, and the fragment stage must not output the
    // sample_mask builtin — depend on format capabilities and shader outputs that WGSL reflection does not expose
    // (EntryPointInfo has no output info), so native validation covers them.
    if (state.multisampleState?.alphaToCoverageEnabled && (signature.sampleCount ?? 1) <= 1) {
      throw multisampleInvalidError(this.label, `alphaToCoverage requires a multisampled target, but the target signature has sampleCount ${signature.sampleCount ?? 1}; create the target with msaa: true.`, where);
    }
    // WebGPU: "If descriptor.stencilFront or descriptor.stencilBack are not the default values: descriptor.format must
    // have a stencil component." The reference is likewise dead without a stencil aspect, so it fails the same check.
    if ((state.stencilState || state.stencilRef !== undefined) && !hasStencilAspect(signature.depth)) {
      throw stencilInvalidError(this.label, `stencil requires a depth format with a stencil aspect, but the target signature has ${signature.depth ? `"${signature.depth}"` : "no depth"}; create the target with depth: "depth24plus-stencil8".`, where);
    }
    return signature;
  }

  #pipelineKey(signature: TargetSignature): string {
    const state = drawState(this);
    const geometry = state.opts.geometry;
    // The key must use the same stripIndexFormat the descriptor derives (primitiveState), or strip geometries that only
    // differ in indexFormat collide on one pipeline.
    return pipelineKeyOf({ module: state.shaderModule, pipelineLayout: state.pipelineLayout, vertexBufferLayouts: state.vertexBufferLayouts, signature, fragmentKey: state.fragmentKey, topology: geometry?.topology, stripIndexFormat: stripIndexFormatFor(geometry), cullMode: state.cullMode, frontFace: state.frontFace, unclippedDepth: state.unclippedDepth, depthKey: state.depthKey, stencilKey: state.stencilKey, multisampleKey: state.multisampleKey, constantsKey: state.constantsKey, entryKey: state.entryKey });
  }

  #encodeGeometry(pass: GPURenderPassEncoder, callOpts: DrawCallOptions = {}): void {
    const geometry = drawState(this).opts.geometry;
    if (geometry?.vertexBuffers) geometry.vertexBuffers.forEach((buffer, index) => pass.setVertexBuffer(index, buffer));
    if (callOpts.indirect !== undefined) return this.#encodeIndirect(pass, geometry, callOpts);
    const counts = resolveDrawCounts(this.label, geometry, drawState(this).opts, callOpts);
    if (!geometry?.indexBuffer) return pass.draw(counts.vertexCount, counts.instanceCount, counts.firstVertex, counts.firstInstance);
    pass.setIndexBuffer(geometry.indexBuffer, geometry.indexFormat ?? "uint32");
    pass.drawIndexed(counts.indexCount, counts.instanceCount, counts.firstIndex, counts.baseVertex, counts.firstInstance);
  }

  /**
   * The GPU reads the draw arguments from the buffer, so per-call counts alongside indirect are dead options and throw.
   * A non-zero firstInstance in the buffered arguments cannot be validated on the CPU; per WebGPU, it "must be 0,
   * unless the 'indirect-first-instance' feature is enabled", otherwise the indirect call "will be treated as a no-op".
   */
  #encodeIndirect(pass: GPURenderPassEncoder, geometry: GeometryLike | undefined, callOpts: DrawCallOptions): void {
    const where = `${this.label}.draw`;
    const conflict = INDIRECT_CONFLICT_FIELDS.find((field) => callOpts[field] !== undefined);
    if (conflict !== undefined) throw indirectInvalidError(this.label, `indirect cannot be combined with ${conflict} in the same call; the GPU reads the draw arguments from the buffer, so the CPU-side value would be ignored.`, where);
    const indexed = !!geometry?.indexBuffer;
    const { buffer, offset } = resolveIndirect(this.label, where, callOpts.indirect!, indexed ? "drawIndexedIndirect" : "drawIndirect");
    if (!indexed) return pass.drawIndirect(buffer, offset);
    pass.setIndexBuffer(geometry!.indexBuffer!, geometry!.indexFormat ?? "uint32");
    pass.drawIndexedIndirect(buffer, offset);
  }

  #createPipeline(signature: TargetSignature): GPURenderPipeline {
    const state = drawState(this);
    // One constants record serves both stages: WebGPU keys constants module-level ("The pipeline-overridable
    // constant is not required to be statically used by entryPoint"), so no per-stage filtering is needed.
    return state.device.gpu.createRenderPipeline({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...(state.vertexBufferLayouts ?? [])], ...(state.constants ? { constants: state.constants } : {}) },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state), ...(state.constants ? { constants: state.constants } : {}) },
      primitive: primitiveState(state.opts.geometry, state.cullMode, state.frontFace, state.unclippedDepth),
      depthStencil: depthStencilState(signature, state),
      multisample: multisampleStateFor(signature, state),
    });
  }

  #createPipelineAsync(signature: TargetSignature): Promise<GPURenderPipeline> {
    const state = drawState(this);
    return state.device.gpu.createRenderPipelineAsync({
      label: `${this.label}.pipeline`,
      layout: state.pipelineLayout,
      vertex: { module: state.shaderModule, entryPoint: state.vertexEntry, buffers: [...(state.vertexBufferLayouts ?? [])], ...(state.constants ? { constants: state.constants } : {}) },
      fragment: { module: state.shaderModule, entryPoint: state.fragmentEntry, targets: fragmentTargets(signature, state), ...(state.constants ? { constants: state.constants } : {}) },
      primitive: primitiveState(state.opts.geometry, state.cullMode, state.frontFace, state.unclippedDepth),
      depthStencil: depthStencilState(signature, state),
      multisample: multisampleStateFor(signature, state),
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

const INDIRECT_CONFLICT_FIELDS = ["vertices", "indices", "instances", "firstVertex", "firstIndex", "baseVertex", "firstInstance"] as const;

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
  return signature.colors.map((format, index) => {
    const overrides = state.colorStates?.[index];
    const blendState = overrides?.blendState ?? state.blendState;
    const writeMask = overrides?.writeMask ?? state.writeMask;
    const target: GPUColorTargetState = { format };
    if (blendState) target.blend = blendState;
    if (writeMask !== undefined) target.writeMask = writeMask;
    return target;
  });
}

function resolveDrawCounts(label: string, geometry: GeometryLike | undefined, drawOpts: DrawOptions, callOpts: DrawCallOptions): DrawCounts {
  validateOptionalDrawCount(label, "DrawOptions.instances", drawOpts.instances);
  validateOptionalDrawCount(label, "DrawOptions.vertices", drawOpts.vertices);
  validateOptionalDrawCount(label, "DrawOptions.firstInstance", drawOpts.firstInstance);
  validateOptionalDrawCount(label, "DrawCallOptions.instances", callOpts.instances);
  validateOptionalGeometryRange(label, "DrawCallOptions.vertices", callOpts.vertices);
  validateOptionalGeometryRange(label, "DrawCallOptions.indices", callOpts.indices);
  validateOptionalGeometryRange(label, "DrawCallOptions.firstVertex", callOpts.firstVertex);
  validateOptionalGeometryRange(label, "DrawCallOptions.firstIndex", callOpts.firstIndex);
  validateOptionalGeometryRange(label, "DrawCallOptions.baseVertex", callOpts.baseVertex);
  validateOptionalDrawCount(label, "DrawCallOptions.firstInstance", callOpts.firstInstance);
  validateOptionalDrawCount(label, "GeometryLike.vertexCount", geometry?.vertexCount);
  validateOptionalDrawCount(label, "GeometryLike.indexCount", geometry?.indexCount);
  validateOptionalDrawCount(label, "GeometryLike.instanceCount", geometry?.instanceCount);
  validateOptionalGeometryRange(label, "GeometryLike.firstVertex", geometry?.firstVertex);
  validateOptionalGeometryRange(label, "GeometryLike.firstIndex", geometry?.firstIndex);
  validateOptionalGeometryRange(label, "GeometryLike.baseVertex", geometry?.baseVertex);
  const indexed = !!geometry?.indexBuffer;
  const sliceParent = (geometry as (GeometryLike & { readonly geometry?: GeometryLike }) | undefined)?.geometry;
  const parent = sliceParent ?? (geometry && geometryLayoutResolver in geometry ? geometry : undefined);
  const firstVertex = callOpts.firstVertex ?? geometry?.firstVertex ?? 0;
  const vertexCount = callOpts.vertices ?? geometry?.vertexCount ?? drawOpts.vertices ?? 3;
  const firstIndex = callOpts.firstIndex ?? geometry?.firstIndex ?? 0;
  const indexCount = callOpts.indices ?? geometry?.indexCount ?? 0;
  const baseVertex = callOpts.baseVertex ?? geometry?.baseVertex ?? 0;
  if (indexed) validateDrawInterval(label, "index", firstIndex, indexCount, parent?.indexCount);
  else if (callOpts.indices !== undefined || callOpts.firstIndex !== undefined || callOpts.baseVertex !== undefined) throw meshRangeInvalidError(`${label}.draw`, "Index range needs an indexed geometry.");
  if (!indexed) validateDrawInterval(label, "vertex", firstVertex, vertexCount, parent?.vertexCount);
  return {
    instanceCount: callOpts.instances ?? drawOpts.instances ?? geometry?.instanceCount ?? 1,
    firstInstance: callOpts.firstInstance ?? drawOpts.firstInstance ?? 0,
    vertexCount,
    firstVertex,
    indexCount,
    firstIndex,
    baseVertex,
  };
}

/** Single source of truth for the descriptor's stripIndexFormat, shared with the pipeline cache key. */
function stripIndexFormatFor(geometry: GeometryLike | undefined): GPUIndexFormat | undefined {
  const topology = geometry?.topology ?? "triangle-list";
  return geometry?.stripIndexFormat ?? (topology.endsWith("strip") ? geometry?.indexFormat : undefined);
}

function primitiveState(geometry: GeometryLike | undefined, cullMode?: GPUCullMode, frontFace?: GPUFrontFace, unclippedDepth?: true): GPUPrimitiveState {
  const topology = geometry?.topology ?? "triangle-list";
  const stripIndexFormat = stripIndexFormatFor(geometry);
  const state: GPUPrimitiveState = stripIndexFormat ? { topology, stripIndexFormat } : { topology };
  if (cullMode !== undefined) state.cullMode = cullMode;
  if (frontFace !== undefined) state.frontFace = frontFace;
  if (unclippedDepth) state.unclippedDepth = true;
  return state;
}

function validateDrawInterval(label: string, kind: "index" | "vertex", first: number, count: number, max: number | undefined): void {
  if (max === undefined || first + count <= max) return;
  throw meshRangeInvalidError(`${label}.draw`, `${kind} range [${first}, ${first + count}) exceeds parent geometry ${kind} count ${max}.`);
}

function validateOptionalGeometryRange(label: string, field: string, value: number | undefined): void {
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

type NormalizedColorTargetState = {
  readonly blendState?: GPUBlendState;
  readonly writeMask?: number;
};

type NormalizedFragmentState = {
  readonly blendState?: GPUBlendState;
  readonly writeMask?: number;
  readonly colorStates?: readonly (NormalizedColorTargetState | null)[];
  readonly fragmentKey?: string;
};

function normalizeFragmentState(label: string, opts: DrawOptions): NormalizedFragmentState {
  const blendState = opts.blend === undefined ? undefined : normalizeBlend(label, opts.blend);
  const writeMask = opts.writeMask === undefined ? undefined : normalizeWriteMask(label, opts.writeMask);
  const colorStates = opts.colors === undefined ? undefined : normalizeColorStates(label, opts.colors);
  const fragmentKey = colorStates
    ? `${fragmentKeyFor(blendState, writeMask)}@${colorStates.map(colorStateKeyFor).join("@")}`
    : blendState || writeMask !== undefined ? fragmentKeyFor(blendState, writeMask) : undefined;
  return { blendState, writeMask, colorStates, fragmentKey };
}

function normalizeColorStates(label: string, value: NonNullable<DrawOptions["colors"]>): readonly (NormalizedColorTargetState | null)[] {
  if (!Array.isArray(value)) throw colorsInvalidError(label, `colors must be an array; received ${preview(value)}.`);
  return value.map((entry, index) => {
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "object" || Array.isArray(entry)) throw colorsInvalidError(label, `colors[${index}] must be null or { blend?, writeMask? }; received ${preview(entry)}.`);
    const blendState = entry.blend === undefined ? undefined : normalizeBlend(`${label}.colors[${index}]`, entry.blend);
    const writeMask = entry.writeMask === undefined ? undefined : normalizeWriteMask(`${label}.colors[${index}]`, entry.writeMask);
    if (!blendState && writeMask === undefined) return null;
    return { blendState, writeMask };
  });
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

type NormalizedBlendConstantOptions = {
  readonly blendConstant?: GPUColorDict;
};

function normalizeBlendConstantOptions(label: string, opts: DrawOptions, fragmentState: NormalizedFragmentState): NormalizedBlendConstantOptions {
  if (opts.blendConstant === undefined) return {};
  const value = opts.blendConstant;
  if (!Array.isArray(value) || value.length !== 4 || value.some((component) => typeof component !== "number" || !Number.isFinite(component))) {
    throw blendConstantInvalidError(label, `received ${preview(value)}; expected [r, g, b, a] finite numbers.`);
  }
  // Constant factors without blendConstant stay legal (the value the pass holds applies); the reverse is a dead option.
  // The check runs against the EFFECTIVE blend state of every color target — the same resolution fragmentTargets() uses,
  // so a constant factor reached only through colors[i].blend counts, and a top-level one overridden on every target does not.
  if (!effectiveBlendStates(fragmentState).some((blend) => blend && usesConstantBlendFactor(blend))) {
    throw blendConstantInvalidError(label, `no color target's effective blend uses a "constant"/"one-minus-constant" factor (colors[i].blend replaces the top-level blend for that target), so blendConstant would have no effect.`);
  }
  return { blendConstant: { r: value[0], g: value[1], b: value[2], a: value[3] } };
}

/** Blend state each color target ends up with: the per-target override when it carries one, else the top-level blend (mirrors fragmentTargets). */
function effectiveBlendStates(fragmentState: NormalizedFragmentState): readonly (GPUBlendState | undefined)[] {
  if (!fragmentState.colorStates) return [fragmentState.blendState];
  return fragmentState.colorStates.map((entry) => entry?.blendState ?? fragmentState.blendState);
}

function usesConstantBlendFactor(blend: GPUBlendState): boolean {
  return [blend.color.srcFactor, blend.color.dstFactor, blend.alpha.srcFactor, blend.alpha.dstFactor]
    .some((factor) => factor === "constant" || factor === "one-minus-constant");
}

function normalizeEntryOptions(label: string, value: DrawOptions["entry"]): { readonly vertex?: string; readonly fragment?: string } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw entryInvalidError(label, `received ${preview(value)}; expected { vertex?, fragment? } entry point names.`);
  return value;
}

// Explicitly naming the first-of-stage entries behaves exactly like an absent option; pipeline cache keys stay byte-identical so they share pipelines.
function entryKeyFor(reflection: Reflection, vertexEntry: EntryPointInfo | undefined, fragmentEntry: EntryPointInfo | undefined): string | undefined {
  const firstVertex = reflection.entryPoints.find((entry) => entry.stage === "vertex");
  const firstFragment = reflection.entryPoints.find((entry) => entry.stage === "fragment");
  if (vertexEntry === firstVertex && fragmentEntry === firstFragment) return undefined;
  return `en~${vertexEntry?.name ?? ""}~${fragmentEntry?.name ?? ""}`;
}

type NormalizedPrimitiveOptions = {
  readonly cullMode?: GPUCullMode;
  readonly frontFace?: GPUFrontFace;
  readonly unclippedDepth?: true;
};

function normalizePrimitiveOptions(device: Device, label: string, opts: DrawOptions): NormalizedPrimitiveOptions {
  const cullMode = opts.cull === undefined ? undefined : normalizeCull(label, opts.cull);
  const frontFace = opts.frontFace === undefined ? undefined : normalizeFrontFace(label, opts.frontFace);
  const unclippedDepth = opts.unclippedDepth === undefined ? undefined : normalizeUnclippedDepth(device, label, opts.unclippedDepth);
  return { cullMode, frontFace, unclippedDepth };
}

function normalizeUnclippedDepth(device: Device, label: string, value: boolean): true | undefined {
  if (typeof value !== "boolean") throw unclippedDepthInvalidError(label, `received ${preview(value)}; expected a boolean.`);
  // An explicit false behaves exactly like an absent option; descriptors and pipeline cache keys stay byte-identical.
  if (!value) return undefined;
  // WebGPU: "If descriptor.unclippedDepth is true: 'depth-clip-control' must be enabled for device."
  if (!device.features.has("depth-clip-control")) {
    throw unclippedDepthInvalidError(label, `the device lacks the "depth-clip-control" feature; request it at init: init({ requiredFeatures: ["depth-clip-control"] }) on an adapter that supports it.`);
  }
  return true;
}

function normalizeCull(label: string, value: "none" | "front" | "back"): GPUCullMode {
  if (value === "none" || value === "front" || value === "back") return value;
  throw cullInvalidError(label, value);
}

function normalizeFrontFace(label: string, value: "ccw" | "cw"): GPUFrontFace {
  if (value === "ccw" || value === "cw") return value;
  throw frontFaceInvalidError(label, value);
}

type NormalizedDepthState = {
  readonly depthWriteEnabled: boolean;
  readonly depthCompare: GPUCompareFunction;
  readonly depthBias?: number;
  readonly depthBiasSlopeScale?: number;
  readonly depthBiasClamp?: number;
};

type NormalizedDepthOptions = {
  readonly depthState?: NormalizedDepthState;
  readonly depthKey?: string;
};

const DEFAULT_DEPTH_STATE: NormalizedDepthState = { depthWriteEnabled: true, depthCompare: "less-equal" };

const DEPTH_COMPARE_FUNCTIONS: readonly GPUCompareFunction[] = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

function depthStencilState(signature: TargetSignature, state: DrawState): GPUDepthStencilState | undefined {
  // A Draw may compile against targets with and without depth; opts.depth only applies when the signature has a depth attachment.
  if (!signature.depth) return undefined;
  // Stencil merges into the depth state (defaulted when the depth option is absent); unset stencil fields stay omitted
  // so the descriptor is byte-identical to today's when the stencil option is absent.
  return { format: signature.depth, ...(state.depthState ?? DEFAULT_DEPTH_STATE), ...(state.stencilState ?? {}) };
}

function normalizeDepthOptions(device: Device, label: string, opts: DrawOptions): NormalizedDepthOptions {
  if (opts.depth === undefined) return {};
  const depthState = normalizeDepth(device, label, opts.depth, opts.geometry?.topology ?? "triangle-list");
  return { depthState, depthKey: depthKeyFor(depthState) };
}

function normalizeDepth(device: Device, label: string, value: false | DepthOptions, topology: GPUPrimitiveTopology): NormalizedDepthState {
  if (value === false) return { depthWriteEnabled: false, depthCompare: "always" };
  if (typeof value !== "object" || value === null) throw depthInvalidError(label, `received ${preview(value)}.`);
  if (value.write !== undefined && typeof value.write !== "boolean") throw depthInvalidError(label, `write must be a boolean; received ${preview(value.write)}.`);
  if (value.compare !== undefined && !DEPTH_COMPARE_FUNCTIONS.includes(value.compare)) throw depthInvalidError(label, `compare must be a GPUCompareFunction; received ${preview(value.compare)}.`);
  if (value.bias !== undefined && !Number.isInteger(value.bias)) throw depthInvalidError(label, `bias must be an integer (WebGPU depthBias is i32); received ${preview(value.bias)}.`);
  // WebGPU depthBias is a GPUDepthBias (i32); out-of-range integers wrap or fail in the native layer instead of biasing.
  if (value.bias !== undefined && (value.bias < I32_MIN || value.bias > I32_MAX)) throw depthInvalidError(label, `bias must fit in the i32 range [${I32_MIN}, ${I32_MAX}] (WebGPU depthBias is i32); received ${preview(value.bias)}.`);
  if (value.biasSlopeScale !== undefined && !Number.isFinite(value.biasSlopeScale)) throw depthInvalidError(label, `biasSlopeScale must be a finite number; received ${preview(value.biasSlopeScale)}.`);
  if (value.biasClamp !== undefined && !Number.isFinite(value.biasClamp)) throw depthInvalidError(label, `biasClamp must be a finite number; received ${preview(value.biasClamp)}.`);
  const bias = value.bias ?? 0;
  const biasSlopeScale = value.biasSlopeScale ?? 0;
  const biasClamp = value.biasClamp ?? 0;
  // WebGPU makes nonzero depth bias a validation error outside triangle topologies.
  if ((bias !== 0 || biasSlopeScale !== 0 || biasClamp !== 0) && !topology.startsWith("triangle")) throw depthInvalidError(label, `bias, biasSlopeScale, and biasClamp must be 0 for "${topology}" topology.`);
  // WebGPU compatibility mode requires depthBiasClamp to be 0.
  if (biasClamp !== 0 && device.isCompatibilityMode) throw depthInvalidError(label, `biasClamp must be 0 on a compatibility-mode device; received ${preview(value.biasClamp)}.`);
  return {
    depthWriteEnabled: value.write ?? true,
    depthCompare: value.compare ?? "less-equal",
    ...(bias !== 0 ? { depthBias: bias } : {}),
    ...(biasSlopeScale !== 0 ? { depthBiasSlopeScale: biasSlopeScale } : {}),
    ...(biasClamp !== 0 ? { depthBiasClamp: biasClamp } : {}),
  };
}

function depthKeyFor(state: NormalizedDepthState): string {
  return `${state.depthWriteEnabled ? 1 : 0}~${state.depthCompare}~${state.depthBias ?? 0}~${state.depthBiasSlopeScale ?? 0}~${state.depthBiasClamp ?? 0}`;
}

type NormalizedStencilState = {
  readonly stencilFront?: GPUStencilFaceState;
  readonly stencilBack?: GPUStencilFaceState;
  readonly stencilReadMask?: number;
  readonly stencilWriteMask?: number;
};

type NormalizedStencilOptions = {
  readonly stencilState?: NormalizedStencilState;
  readonly stencilKey?: string;
  readonly stencilRef?: number;
};

const STENCIL_OPERATIONS: readonly GPUStencilOperation[] = ["keep", "zero", "replace", "invert", "increment-clamp", "decrement-clamp", "increment-wrap", "decrement-wrap"];

function normalizeStencilOptions(label: string, opts: DrawOptions): NormalizedStencilOptions {
  if (opts.stencil === undefined) return {};
  const value = opts.stencil;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw stencilInvalidError(label, `received ${preview(value)}; expected { front?, back?, readMask?, writeMask?, ref? }.`);
  const front = value.front === undefined ? undefined : normalizeStencilFace(label, "front", value.front);
  const back = value.back === undefined ? undefined : normalizeStencilFace(label, "back", value.back);
  validateStencilValue(label, "readMask", value.readMask);
  validateStencilValue(label, "writeMask", value.writeMask);
  validateStencilValue(label, "ref", value.ref);
  const stencilState: NormalizedStencilState = {
    ...(front ? { stencilFront: front } : {}),
    // Omitted back mirrors the normalized front so both faces behave the same; with neither given, both keep the WebGPU defaults.
    ...(back ?? front ? { stencilBack: back ?? { ...front! } } : {}),
    ...(value.readMask !== undefined ? { stencilReadMask: value.readMask } : {}),
    ...(value.writeMask !== undefined ? { stencilWriteMask: value.writeMask } : {}),
  };
  const hasPipelineState = stencilState.stencilFront !== undefined || stencilState.stencilBack !== undefined || stencilState.stencilReadMask !== undefined || stencilState.stencilWriteMask !== undefined;
  // An all-defaults object behaves exactly like an absent option; keep the pipeline key byte-identical so they share.
  if (!hasPipelineState && value.ref === undefined) return {};
  return {
    ...(hasPipelineState ? { stencilState, stencilKey: stencilKeyFor(stencilState) } : {}),
    // The reference is encoder state (setStencilReference), not pipeline state; it stays out of the pipeline key.
    ...(value.ref !== undefined ? { stencilRef: value.ref } : {}),
  };
}

function normalizeStencilFace(label: string, field: "front" | "back", value: StencilFaceOptions): GPUStencilFaceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw stencilInvalidError(label, `${field} must be a { compare?, fail?, depthFail?, pass? } object; received ${preview(value)}.`);
  if (value.compare !== undefined && !DEPTH_COMPARE_FUNCTIONS.includes(value.compare)) throw stencilInvalidError(label, `${field}.compare must be a GPUCompareFunction; received ${preview(value.compare)}.`);
  for (const [name, op] of [["fail", value.fail], ["depthFail", value.depthFail], ["pass", value.pass]] as const) {
    if (op !== undefined && !STENCIL_OPERATIONS.includes(op)) throw stencilInvalidError(label, `${field}.${name} must be a GPUStencilOperation; received ${preview(op)}.`);
  }
  return { compare: value.compare ?? "always", failOp: value.fail ?? "keep", depthFailOp: value.depthFail ?? "keep", passOp: value.pass ?? "keep" };
}

// WebGPU GPUStencilValue is [EnforceRange] unsigned long; masks, the reference, and clear values share the u32 range.
function validateStencilValue(label: string, field: "readMask" | "writeMask" | "ref", value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
    throw stencilInvalidError(label, `${field} must be an integer in [0, 0xFFFFFFFF] (WebGPU GPUStencilValue is u32); received ${preview(value)}.`);
  }
}

function stencilKeyFor(state: NormalizedStencilState): string {
  return `st~${stencilFaceKeyFor(state.stencilFront)}~${stencilFaceKeyFor(state.stencilBack)}~${state.stencilReadMask ?? 0xFFFFFFFF}~${state.stencilWriteMask ?? 0xFFFFFFFF}`;
}

function stencilFaceKeyFor(face: GPUStencilFaceState | undefined): string {
  if (!face) return "default";
  return `${face.compare},${face.failOp},${face.depthFailOp},${face.passOp}`;
}

type NormalizedMultisampleState = {
  readonly alphaToCoverageEnabled?: boolean;
  readonly mask?: number;
};

type NormalizedMultisampleOptions = {
  readonly multisampleState?: NormalizedMultisampleState;
  readonly multisampleKey?: string;
};

function multisampleStateFor(signature: TargetSignature, state: DrawState): GPUMultisampleState {
  // Fields stay omitted when unset so the descriptor is byte-identical to the plain { count } emitted without the option.
  return { count: signature.sampleCount ?? 1, ...(state.multisampleState ?? {}) };
}

function normalizeMultisampleOptions(label: string, opts: DrawOptions): NormalizedMultisampleOptions {
  if (opts.multisample === undefined) return {};
  const value = opts.multisample;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw multisampleInvalidError(label, `received ${preview(value)}; expected { alphaToCoverage?, mask? }.`);
  if (value.alphaToCoverage !== undefined && typeof value.alphaToCoverage !== "boolean") throw multisampleInvalidError(label, `alphaToCoverage must be a boolean; received ${preview(value.alphaToCoverage)}.`);
  // WebGPU GPUSampleMask is [EnforceRange] unsigned long. Bits above the target's sampleCount are legal and ignored.
  if (value.mask !== undefined && (typeof value.mask !== "number" || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 0xFFFFFFFF)) {
    throw multisampleInvalidError(label, `mask must be an integer in [0, 0xFFFFFFFF] (WebGPU GPUSampleMask is u32); received ${preview(value.mask)}.`);
  }
  const multisampleState: NormalizedMultisampleState = {
    ...(value.alphaToCoverage !== undefined ? { alphaToCoverageEnabled: value.alphaToCoverage } : {}),
    ...(value.mask !== undefined ? { mask: value.mask } : {}),
  };
  // An all-defaults object behaves exactly like an absent option; keep the pipeline key byte-identical so they share.
  if (multisampleState.alphaToCoverageEnabled === undefined && multisampleState.mask === undefined) return {};
  return { multisampleState, multisampleKey: multisampleKeyFor(multisampleState) };
}

function multisampleKeyFor(state: NormalizedMultisampleState): string {
  return `ms~${state.alphaToCoverageEnabled ? 1 : 0}~${state.mask ?? 0xFFFFFFFF}`;
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
  return `${blendKeyFor(blend)};${mask ?? 15}`;
}

function blendKeyFor(blend: GPUBlendState | undefined): string {
  if (!blend) return "none;none";
  const c = blend.color;
  const a = blend.alpha;
  return `${c.srcFactor},${c.dstFactor},${c.operation};${a.srcFactor},${a.dstFactor},${a.operation}`;
}

// "inherit" markers keep per-entry keys distinct from explicit state so an entry inheriting the top-level fallback never collides with one that pins it.
function colorStateKeyFor(state: NormalizedColorTargetState | null): string {
  if (!state) return "inherit";
  return `${state.blendState ? blendKeyFor(state.blendState) : "inherit"};${state.writeMask ?? "inherit"}`;
}

function preview(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export function drawReflection(draw: Draw): Reflection { return drawState(draw).reflection; }

export function drawBindingState(draw: Draw, name: string): BindingState | undefined { return drawState(draw).setCore.bindingState(name); }

export function registerDrawBundle(draw: Draw, bundle: BundleBackReference): void { drawState(draw).recordedIn.add(bundle); }

/** Render bundle encoders cannot set the pass blend constant; bundle uses this to reject such draws at recording. */
export function drawUsesBlendConstant(draw: Draw): boolean { return drawState(draw).blendConstant !== undefined; }

/** Render bundle encoders cannot set the pass stencil reference; bundle uses this to reject such draws at recording. */
export function drawUsesStencilReference(draw: Draw): boolean { return drawState(draw).stencilRef !== undefined; }

/**
 * FramePass uses this to pre-validate draws against read-only depth passes. Mirrors the WebGPU
 * [[writesDepth]] pipeline slot: "If depthStencil.depthWriteEnabled is provided: Set
 * pipeline.[[writesDepth]] to depthStencil.depthWriteEnabled." — vgpu always provides it on depth
 * targets, defaulting to true.
 */
export function drawWritesDepth(draw: Draw): boolean {
  return (drawState(draw).depthState ?? DEFAULT_DEPTH_STATE).depthWriteEnabled;
}

/**
 * Stencil ops that make this draw write stencil, e.g. `front.pass: "replace"`; empty when the draw
 * cannot write stencil. FramePass uses this to pre-validate draws against read-only stencil passes.
 * Mirrors the WebGPU [[writesStencil]] computation: only when "depthStencil.stencilWriteMask is not 0",
 * a face op is "not \"keep\"", and the face is not culled ("If cullMode is not \"front\", and any of
 * stencilFront.passOp, stencilFront.depthFailOp, or stencilFront.failOp is not \"keep\"" — and the
 * mirrored rule for stencilBack with "back") does the pipeline write stencil.
 */
export function drawStencilWritingOps(draw: Draw): readonly string[] {
  const state = drawState(draw);
  const stencil = state.stencilState;
  if (!stencil || stencil.stencilWriteMask === 0) return [];
  const cullMode = state.cullMode ?? "none";
  const ops: string[] = [];
  const collect = (faceName: "front" | "back", face: GPUStencilFaceState | undefined): void => {
    if (!face) return;
    for (const [name, op] of [["fail", face.failOp], ["depthFail", face.depthFailOp], ["pass", face.passOp]] as const) {
      if (op !== undefined && op !== "keep") ops.push(`${faceName}.${name}: "${op}"`);
    }
  };
  if (cullMode !== "front") collect("front", stencil.stencilFront);
  if (cullMode !== "back") collect("back", stencil.stencilBack);
  return ops;
}

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
    assertDeviceUsable(state.device, `${label}.validation`);
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

function assertSurfaceTargetInFrame(target: CompileTarget, where: string): void {
  if (isSurface(target) && !isFrameActive()) throw surfaceNotInFrameError(where);
}
