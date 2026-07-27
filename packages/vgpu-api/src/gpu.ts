import type { ShaderSource } from "@vgpu/wgsl";
import type { RequiredDeviceLimits, VGPUAdapter } from "@vgpu/core";
import { Device, validateRequiredFeatures } from "@vgpu/core";
import { createBindGroupCache } from "./bind-cache.ts";
import { createBundle, type Bundle, type BundleOptions, type BundleRecorder } from "./bundle.ts";
import { InternalDraw, type Draw, type DrawOptions } from "./draw.ts";
import { Frame, FrameRunner, type FrameLoopHandle } from "./frame.ts";
import { InternalEffect, type Effect, type EffectOptions } from "./effect.ts";
import { createSamplerCache } from "./sampler.ts";
import { createGeometry } from "./scene/geometry-factory.ts";
import { Geometry, type GeometryOptions } from "./scene/geometry-descriptor.ts";
import type { SceneGeometry } from "./scene/geometry.ts";
import { OffscreenTarget, type Target, type TargetOptions, type TargetTextureOptions } from "./target.ts";
import { frameReentrantError, surfaceDuplicateError, unsupportedError, VGPUError } from "./errors.ts";
import { ComputePipeline } from "./compute.ts";
import { createStorageBuffer } from "./storage.ts";
import { createPingPongStorage, createPingPongTargets } from "./ping-pong.ts";
import { toWgsl } from "./shader-source.ts";
import { createSharedUniforms } from "./uniforms.ts";
import { CanvasSurface, type Surface, type SurfaceCanvas, type SurfaceOptions } from "./surface.ts";
import { createTimer, type Timer } from "./timer.ts";
import { createVisibility, type Visibility, type VisibilityOptions } from "./visibility.ts";
import type { ClearColor } from "./target-utils.ts";
import { createPipelineLayoutCache, createPipelineStore, createShaderModuleCache, type PipelineLayoutCache, type PipelineStore, type SettledSource, type ShaderModuleCache } from "./pipeline-store.ts";

export interface InitOptions {
  readonly adapter?: VGPUAdapter;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: RequiredDeviceLimits;
  readonly label?: string;
}

export interface ComputeOptions {
  readonly label?: string;
  readonly set?: Record<string, unknown>;
  /** Values for WGSL `override` constants, keyed by name (or by numeric id as a string when the override has @id). Immutable after construction. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
  /** Compute entry point to use when the shader has several. Defaults to the first @compute entry point. */
  readonly entry?: string;
}
export interface DispatchOptions {
  /** GPU-driven dispatch: read the workgroup counts from a buffer instead of CPU-side counts. */
  readonly indirect: StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };
}
export interface Compute { set(values: Record<string, unknown>): this; dispatch(x: number, y?: number, z?: number): void; dispatch(opts: DispatchOptions): void }
export type StorageAccess = "read" | "read-write";
export interface StorageOptions {
  /** Binding access for shader reflection. Defaults to "read-write". */
  readonly access?: StorageAccess;
  /** Adds the "indirect" buffer usage so the buffer can supply GPU-read draw/dispatch arguments. Defaults to false. */
  readonly indirect?: boolean;
}
export interface StorageBuffer { readonly size: number; readonly access: StorageAccess; read(): Promise<ArrayBuffer>; write(data: BufferSource): void }
export interface PingPongTargets { readonly read: Target; readonly write: Target; swap(): void }
export interface PingPongStorage { readonly read: StorageBuffer; readonly write: StorageBuffer; swap(): void }
export interface SharedUniforms<T extends Record<string, unknown> = Record<string, unknown>> { set(values: Partial<T>): void }
export type GpuErrorListener = (error: VGPUError) => void;
/** Ring-1 facade shared by browser, node, and mock entrypoints. */
export interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  time: number;
  deltaTime: number;
  frameCount: number;
  clearColor: ClearColor;
  surface(canvas: SurfaceCanvas, opts?: SurfaceOptions): Surface;
  effect(source: string | ShaderSource, opts?: EffectOptions): Effect;
  draw(opts: DrawOptions): Draw;
  target(opts: TargetOptions): Target;
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
  geometry(geometry: SceneGeometry): Geometry;
  geometry(options: GeometryOptions): Geometry;
  dispose(): void;
  compute(source: string | ShaderSource, opts?: ComputeOptions): Compute;
  storage(bytes: number, access?: StorageAccess | StorageOptions): StorageBuffer;
  /** GPU pass timing. Needs the "timestamp-query" device feature — request it at init: init({ requiredFeatures: ["timestamp-query"] }). */
  timer(): Timer;
  /** Occlusion query results for visibility culling. Core WebGPU — no device feature required. Pass the instance as FramePassOptions.visibility and wrap proxy draws in pass.occlusion(handle, body). */
  visibility(options?: VisibilityOptions): Visibility;
  pingPong(width: number, height: number, opts?: TargetTextureOptions): PingPongTargets;
  pingPongStorage(bytes: number): PingPongStorage;
  uniforms<T extends Record<string, unknown>>(values: T): SharedUniforms<T>;
  bundle(opts: BundleOptions, cb: (recorder: BundleRecorder) => void): Bundle;
  onError(cb: GpuErrorListener): () => void;
  settled(): Promise<void>;
}

export type AdapterFactory = () => VGPUAdapter;

export async function createGpu(entry: "browser" | "node" | "mock", opts: InitOptions = {}, _unused: InitOptions = {}, adapterFactory?: AdapterFactory): Promise<Gpu> {
  const device = await createDevice(entry, opts, adapterFactory);
  return new RingGpu(device);
}

class RingGpu implements Gpu {
  readonly gpu: GPUDevice;
  time = 0;
  deltaTime = 0;
  frameCount = 0;
  #lastTimeMs = nowMs();
  readonly #cache = createBindGroupCache();
  readonly #pipelineStore: PipelineStore;
  readonly #shaderModules: ShaderModuleCache;
  readonly #pipelineLayouts: PipelineLayoutCache;
  readonly #samplers;
  readonly #surfaces = new Map<SurfaceCanvas, CanvasSurface>();
  readonly #errorListeners = new Set<GpuErrorListener>();
  readonly #pendingDeliveries = new Set<Promise<void>>();
  /** Query-based features created by this gpu, disposed with it (each drops itself on its own dispose()). */
  readonly #timers = new Set<Timer>();
  readonly #visibilities = new Set<Visibility>();
  /** Render loops started through gpu.frame.loop(), stopped with the gpu (each drops itself when it stops on its own). */
  readonly #loops = new Set<FrameLoopHandle>();
  readonly #settledSources = new Set<SettledSource>();
  #disposed = false;
  #advancing = false;
  #clearColorValue: ClearColor = [0, 0, 0, 1];
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);

  constructor(readonly device: Device) {
    this.gpu = device.gpu;
    this.#pipelineStore = createPipelineStore(device, { errorSink: (error) => this.#reportError(error), registerSettledSource: (source) => this.#registerSettledSource(source) });
    this.#shaderModules = createShaderModuleCache(device);
    this.#pipelineLayouts = createPipelineLayoutCache(device);
    this.#samplers = createSamplerCache(device);
    const runner = new FrameRunner(() => new Frame(device, undefined, (error) => this.#reportError(error), (promise) => this.#trackDelivery(promise), () => this.#clearColorValue), () => this.#advanceFrameState(), (handle) => this.#registerLoop(handle));
    this.frame = callableFrameRunner(runner);
  }

  get clearColor(): ClearColor { return this.#clearColorValue; }
  set clearColor(value: ClearColor) {
    const o = value as any, n = Array.isArray(value) ? value : [o?.r, o?.g, o?.b, o?.a];
    if (n.length !== 4 || !n.every(Number.isFinite)) throw new VGPUError({ code: "VGPU-CLEAR-COLOR-INVALID", message: "invalid gpu.clearColor.", where: "gpu.clearColor" });
    this.#clearColorValue = value;
  }

  surface(canvas: SurfaceCanvas, opts: SurfaceOptions = {}): Surface {
    const existing = this.#surfaces.get(canvas);
    if (existing && !existing.disposed) throw surfaceDuplicateError(existing.label);
    const surface = new CanvasSurface(this.device, canvas, opts, (s) => {
      if (this.#surfaces.get(s.canvas) === s) this.#surfaces.delete(s.canvas);
    });
    this.#surfaces.set(canvas, surface);
    return surface;
  }
  effect(source: string | ShaderSource, opts: EffectOptions = {}): Effect {
    if (hasGeometry(opts)) throw unsupportedError("gpu.effect", "gpu.effect() never accepts vertex buffers; use gpu.draw({ shader, geometry: gpu.geometry(descriptor) }).");
    return new InternalEffect(this.device, toWgsl(source), opts, this.#cache, undefined, this.#pipelineStore, this.#shaderModules, this.#pipelineLayouts, (error) => this.#reportError(error), (promise) => this.#trackDelivery(promise));
  }
  draw(opts: DrawOptions): Draw {
    const shader = toWgsl(opts.shader);
    return new InternalDraw(this.device, shader, { ...opts, shader }, this.#cache, undefined, this.#pipelineStore, this.#shaderModules, this.#pipelineLayouts, (error) => this.#reportError(error), (promise) => this.#trackDelivery(promise));
  }
  target(opts: TargetOptions): Target { return new OffscreenTarget(this.device, opts); }
  sampler(desc?: GPUSamplerDescriptor): GPUSampler { return this.#samplers.sampler(desc); }
  geometry(geometry: SceneGeometry): Geometry;
  geometry(options: GeometryOptions): Geometry;
  geometry(input: SceneGeometry | GeometryOptions): Geometry {
    return isGeometryOptions(input) ? new Geometry(this.device, input) : createGeometry(this.device, input);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Stop scheduling first: a loop left running would keep encoding frames against a disposed
    // device (and a rAF tick landing mid-teardown would throw from inside the scheduler).
    for (const loop of [...this.#loops]) loop.stop();
    this.#loops.clear();
    for (const surface of [...this.#surfaces.values()]) surface.dispose();
    // Query features own a query set plus resolve/staging buffers: release them with the gpu that made them.
    for (const timer of [...this.#timers]) timer.dispose();
    for (const visibility of [...this.#visibilities]) visibility.dispose();
    this.#timers.clear();
    this.#visibilities.clear();
    this.#pipelineStore.dispose();
    this.#shaderModules.dispose();
    this.#pipelineLayouts.dispose();
    this.#cache.dispose();
    this.#settledSources.clear();
    this.device.dispose();
  }
  compute(source: string | ShaderSource, opts: ComputeOptions = {}): Compute { return new ComputePipeline(this.device, toWgsl(source), opts, this.#cache); }
  storage(bytes: number, access: StorageAccess | StorageOptions = "read-write"): StorageBuffer {
    const opts = typeof access === "string" ? { access } : access;
    return createStorageBuffer(this.device, bytes, opts.access ?? "read-write", undefined, opts.indirect ?? false);
  }
  timer(): Timer {
    const timer: Timer = createTimer(this.device, {
      trackSettled: (promise) => this.#trackDelivery(promise),
      errorSink: (error) => this.#reportError(error),
      onDispose: () => { this.#timers.delete(timer); },
    });
    this.#timers.add(timer);
    return timer;
  }
  visibility(options: VisibilityOptions = {}): Visibility {
    const visibility: Visibility = createVisibility(this.device, options, () => this.frameCount, {
      trackSettled: (promise) => this.#trackDelivery(promise),
      errorSink: (error) => this.#reportError(error),
      onDispose: () => { this.#visibilities.delete(visibility); },
    });
    this.#visibilities.add(visibility);
    return visibility;
  }
  pingPong(width: number, height: number, opts: TargetTextureOptions = {}): PingPongTargets { return createPingPongTargets(this.device, width, height, opts); }
  pingPongStorage(bytes: number): PingPongStorage { return createPingPongStorage(this.device, bytes); }
  uniforms<T extends Record<string, unknown>>(values: T): SharedUniforms<T> { return createSharedUniforms(this.device, values); }
  bundle(opts: BundleOptions, cb: (recorder: BundleRecorder) => void): Bundle { return createBundle(this.device, opts, cb); }

  onError(cb: GpuErrorListener): () => void {
    this.#errorListeners.add(cb);
    return () => { this.#errorListeners.delete(cb); };
  }

  async settled(): Promise<void> {
    const snapshot = [
      ...this.#pendingDeliveries,
      ...[...this.#settledSources].flatMap((source) => source()),
    ];
    await Promise.allSettled(snapshot);
  }

  #registerLoop(handle: FrameLoopHandle): () => void {
    this.#loops.add(handle);
    return () => { this.#loops.delete(handle); };
  }

  #registerSettledSource(source: SettledSource): () => void {
    this.#settledSources.add(source);
    return () => { this.#settledSources.delete(source); };
  }

  #reportError(error: VGPUError): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const delivery = Promise.resolve().then(() => {
      const listeners = [...this.#errorListeners];
      if (!listeners.length) {
        console.error(error);
        return;
      }
      for (const listener of listeners) {
        try { listener(error); }
        catch (listenerError) { console.error(listenerError); }
      }
    });
    return this.#trackDelivery(delivery);
  }

  #trackDelivery(promise: Promise<unknown>): Promise<void> {
    const tracked = Promise.resolve(promise).then(() => undefined, (error) => { console.error(error); });
    this.#pendingDeliveries.add(tracked);
    void tracked.finally(() => this.#pendingDeliveries.delete(tracked));
    return tracked;
  }

  #advanceFrameState(): void {
    if (this.#advancing) throw frameReentrantError();
    this.#advancing = true;
    try {
      this.#advanceTime();
      for (const surface of this.#surfaces.values()) surface.applyAutoResize();
    } finally {
      this.#advancing = false;
    }
  }

  #advanceTime(): void {
    const next = nowMs();
    this.deltaTime = Math.max(0, (next - this.#lastTimeMs) / 1000);
    this.time += this.deltaTime;
    this.#lastTimeMs = next;
    this.frameCount += 1;
  }
}

async function createDevice(entry: "browser" | "node" | "mock", opts: InitOptions, adapterFactory?: AdapterFactory): Promise<Device> {
  if (opts.adapter || adapterFactory) return (opts.adapter ?? adapterFactory!()).requestDevice(opts);
  if (entry === "browser") return requestBrowserDevice(opts);
  throw unsupportedError("init", `init(${entry}) requires adapterFactory.`);
}

function callableFrameRunner(runner: FrameRunner): FrameRunner & ((cb?: (frame: Frame) => void) => Frame) {
  const callable = ((cb?: (frame: Frame) => void) => runner.frame(cb)) as FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
  Object.setPrototypeOf(callable, FrameRunner.prototype);
  Object.assign(callable, runner);
  callable.frame = runner.frame.bind(runner);
  callable.loop = runner.loop.bind(runner);
  return callable;
}

async function requestBrowserDevice(opts: InitOptions): Promise<Device> {
  const nav = globalThis.navigator as Navigator & { gpu?: GPU };
  const adapter = await nav.gpu?.requestAdapter({ powerPreference: opts.powerPreference });
  if (!adapter) throw unsupportedError("init", "navigator.gpu.requestAdapter() returned null.");
  validateRequiredFeatures(adapter.features, opts.requiredFeatures);
  const gpuDevice = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  return new Device(gpuDevice, adapter.info ?? null);
}

function hasGeometry(opts: EffectOptions): boolean {
  return "geometry" in (opts as Record<string, unknown>);
}

function isGeometryOptions(value: SceneGeometry | GeometryOptions): value is GeometryOptions {
  return typeof value === "object" && value !== null && "buffers" in value;
}

function nowMs(): number { return globalThis.performance?.now?.() ?? Date.now(); }
