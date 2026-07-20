import { bindGroupLayoutMetadata, type Device } from "@vgpu/core";
import type { Target, CompileTarget, TargetSignature } from "./target.ts";
import { isTarget } from "./target-utils.ts";
import { compileDisposedError, compileFailedError, compileSignatureInvalidError, type VGPUError } from "./errors.ts";

export interface ErrorCtx {
  readonly where: string;
  readonly signature?: string;
}

export type ErrorSink = (error: VGPUError) => void | Promise<void>;
export type SettledSource = () => readonly Promise<unknown>[];
export type RegisterSettledSource = (source: SettledSource) => () => void;

export type PipelineEntry = {
  pipeline?: GPURenderPipeline;
  pending?: {
    promise: Promise<GPURenderPipeline>;
    resolve(pipeline: GPURenderPipeline): void;
    reject(error: unknown): void;
  };
};

export interface PipelineStore {
  getReady(key: string): GPURenderPipeline | undefined;
  getSync(key: string, create: () => GPURenderPipeline, ctx: ErrorCtx): GPURenderPipeline | undefined;
  getAsync(key: string, create: () => Promise<GPURenderPipeline>, ctx: ErrorCtx): Promise<GPURenderPipeline>;
  dispose(): void;
}

export interface ShaderModuleCache {
  get(source: string, label: string): GPUShaderModule;
  dispose(): void;
}

export interface PipelineLayoutCache {
  get(layouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUPipelineLayout;
  dispose(): void;
}

export interface PipelineStoreOptions {
  readonly errorSink?: ErrorSink;
  readonly registerSettledSource?: RegisterSettledSource;
}

let nextShaderModuleId = 1;
let nextPipelineLayoutId = 1;

const shaderModuleIds = new WeakMap<GPUShaderModule, number>();
const pipelineLayoutIds = new WeakMap<GPUPipelineLayout, number>();

export function normalizeSignature(arg: CompileTarget): TargetSignature {
  if (isTarget(arg)) {
    return {
      colors: arg.colors.map((color) => color.format),
      depth: arg.depth?.format,
      sampleCount: arg.sampleCount,
    };
  }
  if (typeof arg !== "object" || arg === null) return { colors: [] };
  return {
    colors: Array.isArray(arg.colors) ? [...arg.colors] : (arg.colors as TargetSignature["colors"] | undefined ?? []),
    depth: arg.depth,
    sampleCount: arg.sampleCount ?? 1,
  };
}

export function signatureKeyOf(sig: TargetSignature): string {
  return `${sig.colors.join(",")}:${sig.depth ?? "none"}:${sig.sampleCount ?? 1}`;
}

export function validateTargetSignature(sig: TargetSignature, where: string): void {
  if (!Array.isArray(sig.colors) || sig.colors.length === 0) throw compileSignatureInvalidError(where, "colors must be a non-empty array.");
  const invalidColor = sig.colors.find((format) => typeof format !== "string" || format.length === 0);
  if (invalidColor !== undefined) throw compileSignatureInvalidError(where, `colors must contain only GPUTextureFormat strings; received ${String(invalidColor)}.`);
  if (sig.depth !== undefined && (typeof sig.depth !== "string" || sig.depth.length === 0)) throw compileSignatureInvalidError(where, "depth must be a GPUTextureFormat string.");
  const sampleCount = sig.sampleCount ?? 1;
  if (sampleCount !== 1 && sampleCount !== 4) throw compileSignatureInvalidError(where, `sampleCount must be 1 or 4; received ${String(sampleCount)}.`);
}

export function pipelineKeyOf(parts: {
  readonly module: GPUShaderModule;
  readonly pipelineLayout: GPUPipelineLayout;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly signature: TargetSignature;
  readonly fragmentKey?: string;
  readonly topology?: GPUPrimitiveTopology;
  readonly stripIndexFormat?: GPUIndexFormat;
}): string {
  const base = `${idFor(shaderModuleIds, parts.module, () => nextShaderModuleId++)}|${idFor(pipelineLayoutIds, parts.pipelineLayout, () => nextPipelineLayoutId++)}|${vertexLayoutHash(parts.vertexBufferLayouts ?? [])}|${signatureKeyOf(parts.signature)}`;
  const primitive = parts.topology || parts.stripIndexFormat ? `${base}|${parts.topology ?? "triangle-list"}|${parts.stripIndexFormat ?? "none"}` : base;
  return parts.fragmentKey ? `${primitive}|${parts.fragmentKey}` : primitive;
}

export function createShaderModuleCache(device: Device): ShaderModuleCache {
  const modules = new Map<string, GPUShaderModule>();
  return {
    get(source, label) {
      let module = modules.get(source);
      if (!module) {
        // GPUShaderModule is immutable; the first creator's label wins for byte-identical WGSL.
        module = device.gpu.createShaderModule({ label, code: source });
        modules.set(source, module);
      }
      return module;
    },
    dispose() { modules.clear(); },
  };
}

export function createPipelineLayoutCache(device: Device): PipelineLayoutCache {
  const layouts = new Map<string, GPUPipelineLayout>();
  return {
    get(bindGroupLayouts) {
      const key = pipelineLayoutKeyOf(bindGroupLayouts);
      let layout = layouts.get(key);
      if (!layout) {
        layout = device.gpu.createPipelineLayout({ bindGroupLayouts: contiguousLayouts(bindGroupLayouts) });
        layouts.set(key, layout);
      }
      return layout;
    },
    dispose() { layouts.clear(); },
  };
}

export function createPipelineStore(device: Device, opts: PipelineStoreOptions = {}): PipelineStore {
  return new DevicePipelineStore(device, opts);
}

class DevicePipelineStore implements PipelineStore {
  private readonly entries = new Map<string, PipelineEntry>();
  private readonly tracked = new Set<Promise<unknown>>();
  private readonly errorSink: ErrorSink;
  private readonly unregisterSettledSource?: () => void;
  private disposed = false;

  constructor(private readonly device: Device, opts: PipelineStoreOptions) {
    this.errorSink = opts.errorSink ?? (() => undefined);
    this.unregisterSettledSource = opts.registerSettledSource?.(() => [...this.tracked]);
  }

  getReady(key: string): GPURenderPipeline | undefined {
    return this.entries.get(key)?.pipeline;
  }

  getSync(key: string, create: () => GPURenderPipeline, ctx: ErrorCtx): GPURenderPipeline | undefined {
    this.assertUsable(ctx.where);
    const existing = this.entries.get(key);
    if (existing?.pipeline) return existing.pipeline;
    const entry = existing ?? {};
    if (!existing) this.entries.set(key, entry);
    const pipeline = this.createSyncPipeline(key, entry, create, ctx);
    if (!pipeline) {
      if (!entry.pending) this.entries.delete(key);
      return undefined;
    }
    entry.pipeline = pipeline;
    entry.pending?.resolve(pipeline);
    entry.pending = undefined;
    return pipeline;
  }

  getAsync(key: string, create: () => Promise<GPURenderPipeline>, ctx: ErrorCtx): Promise<GPURenderPipeline> {
    this.assertUsable(ctx.where);
    const existing = this.entries.get(key);
    if (existing?.pipeline) return Promise.resolve(existing.pipeline);
    if (existing?.pending) return existing.pending.promise;

    const entry: PipelineEntry = {};
    const pending = createDeferred();
    entry.pending = pending;
    this.entries.set(key, entry);

    let native: Promise<GPURenderPipeline>;
    try {
      native = create();
    } catch (cause) {
      const error = compileFailedError(ctx.where, cause, ctx.signature);
      pending.reject(error);
      this.entries.delete(key);
      return pending.promise;
    }

    this.track(native);
    native.then(
      (pipeline) => {
        if (this.entries.get(key) !== entry || entry.pipeline || entry.pending !== pending) return;
        entry.pipeline = pipeline;
        entry.pending = undefined;
        pending.resolve(pipeline);
      },
      (cause) => {
        if (this.entries.get(key) !== entry || entry.pipeline || entry.pending !== pending) return;
        entry.pending = undefined;
        this.entries.delete(key);
        pending.reject(compileFailedError(ctx.where, cause, ctx.signature));
      },
    );
    return pending.promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = compileDisposedError("gpu.dispose");
    for (const entry of this.entries.values()) entry.pending?.reject(error);
    this.entries.clear();
    this.tracked.clear();
    this.unregisterSettledSource?.();
  }

  private createSyncPipeline(key: string, entry: PipelineEntry, create: () => GPURenderPipeline, ctx: ErrorCtx): GPURenderPipeline | undefined {
    const gpu = this.device.gpu as GPUDevice & { pushErrorScope?: GPUDevice["pushErrorScope"]; popErrorScope?: GPUDevice["popErrorScope"] };
    const scoped = typeof gpu.pushErrorScope === "function" && typeof gpu.popErrorScope === "function";
    if (scoped) gpu.pushErrorScope("validation");
    try {
      const pipeline = create();
      if (scoped) this.trackSyncErrorScope(key, entry, ctx);
      return pipeline;
    } catch (cause) {
      if (scoped) this.suppressSyncErrorScopePop();
      const error = compileFailedError(ctx.where, cause, ctx.signature);
      void this.errorSink(error);
      return undefined;
    }
  }

  private trackSyncErrorScope(key: string, entry: PipelineEntry, ctx: ErrorCtx): void {
    const pop = this.device.gpu.popErrorScope!()
      .then((nativeError) => {
        if (!nativeError) return;
        const error = compileFailedError(ctx.where, nativeError, ctx.signature);
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return this.errorSink(error);
      }, (cause) => {
        const error = compileFailedError(ctx.where, cause, ctx.signature);
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return this.errorSink(error);
      });
    this.track(pop);
  }

  private suppressSyncErrorScopePop(): void {
    const pop = this.device.gpu.popErrorScope?.();
    if (pop) void pop.catch(() => undefined);
  }

  private assertUsable(where: string): void {
    if (!this.disposed) return;
    throw compileDisposedError(where);
  }

  private track(promise: Promise<unknown>): void {
    this.tracked.add(promise);
    void promise.catch(() => undefined).then(() => this.tracked.delete(promise), () => this.tracked.delete(promise));
  }
}

function createDeferred(): NonNullable<PipelineEntry["pending"]> {
  let resolve!: (value: GPURenderPipeline) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<GPURenderPipeline>((res, rej) => { resolve = res; reject = rej; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function idFor<T extends object>(ids: WeakMap<T, number>, value: T, next: () => number): number {
  let id = ids.get(value);
  if (!id) {
    id = next();
    ids.set(value, id);
  }
  return id;
}

function vertexLayoutHash(layouts: readonly GPUVertexBufferLayout[]): string {
  return JSON.stringify(layouts.map((layout) => ({
    arrayStride: layout.arrayStride,
    stepMode: layout.stepMode ?? "vertex",
    attributes: [...layout.attributes].map((attribute) => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: attribute.format,
    })),
  })));
}

function pipelineLayoutKeyOf(layouts: ReadonlyMap<number, GPUBindGroupLayout>): string {
  return JSON.stringify([...layouts.entries()].map(([group, layout]) => ({ group, entries: layoutEntries(layout) })));
}

function contiguousLayouts(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>): GPUBindGroupLayout[] {
  const maxGroup = Math.max(-1, ...bindGroupLayouts.keys());
  const layouts: GPUBindGroupLayout[] = [];
  for (let i = 0; i <= maxGroup; i++) layouts.push(requiredLayout(bindGroupLayouts, i));
  return layouts;
}

function requiredLayout(bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>, group: number): GPUBindGroupLayout {
  const layout = bindGroupLayouts.get(group);
  if (!layout) throw new Error(`Pipeline bind groups must be contiguous; missing group ${group}.`);
  return layout;
}

function layoutEntries(layout: GPUBindGroupLayout): readonly unknown[] {
  return (bindGroupLayoutMetadata(layout)?.entries ?? []).map((entry) => ({
    binding: entry.binding,
    visibility: entry.visibility,
    buffer: entry.buffer ? { ...entry.buffer } : undefined,
    sampler: entry.sampler ? { ...entry.sampler } : undefined,
    texture: entry.texture ? { ...entry.texture } : undefined,
    storageTexture: entry.storageTexture ? { ...entry.storageTexture } : undefined,
    externalTexture: entry.externalTexture ? { ...entry.externalTexture } : undefined,
  }));
}

export type { CompileTarget, Target, TargetSignature };
