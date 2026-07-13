import type { VGPUAdapter } from "@vgpu/core";
import { Device } from "@vgpu/core";
import { createBindGroupCache } from "./bind-cache.ts";
import { Draw, type DrawOptions, type MeshLike } from "./draw.ts";
import { Frame, FrameRunner } from "./frame.ts";
import { Pass, type PassOptions } from "./pass.ts";
import { createSamplerCache } from "./sampler.ts";
import { mesh as createSceneMesh } from "./scene/mesh.ts";
import { OffscreenTarget, ScreenTarget, type Target, type TargetOptions } from "./target.ts";
import { unsupportedError } from "./errors.ts";
import { ComputePipeline } from "./compute.ts";
import { createStorageBuffer } from "./storage.ts";
import { createPingPongStorage, createPingPongTargets } from "./ping-pong.ts";
import { createSharedUniforms } from "./uniforms.ts";

export interface InitOptions {
  readonly adapter?: VGPUAdapter;
  readonly size?: readonly [number, number];
  readonly dpr?: number | readonly [number, number];
  readonly autoResize?: boolean;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: Record<string, number>;
  readonly label?: string;
}

export interface ComputeOptions { readonly label?: string; readonly set?: Record<string, unknown> }
export interface Compute { set(values: Record<string, unknown>): this; dispatch(x: number, y?: number, z?: number): void }
export type StorageAccess = "read" | "read-write";
export interface StorageBuffer { readonly size: number; readonly access: StorageAccess; read(): Promise<ArrayBuffer>; write(data: BufferSource): void }
export interface PingPongTargets { readonly read: Target; readonly write: Target; swap(): void }
export interface PingPongStorage { readonly read: StorageBuffer; readonly write: StorageBuffer; swap(): void }
export interface SharedUniforms<T extends Record<string, unknown> = Record<string, unknown>> { set(values: Partial<T>): void }
export interface BundleOptions { readonly target: Target }
export interface BundleRecorder { draw(drawable: Draw | Pass, opts?: unknown): void }
export interface Bundle { readonly id: string }

/** Ring-1 facade shared by browser, node, and mock entrypoints. */
export interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  readonly screen?: Target;
  time: number;
  deltaTime: number;
  frameCount: number;
  pass(source: string, opts?: PassOptions): Pass;
  draw(opts: DrawOptions): Draw;
  target(opts?: TargetOptions): Target;
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
  mesh(geometry: unknown): MeshLike;
  onResize(cb: (size: readonly [number, number]) => void): () => void;
  dispose(): void;
  compute(source: string, opts?: ComputeOptions): Compute;
  storage(bytes: number, access?: StorageAccess): StorageBuffer;
  pingPong(width: number, height: number, opts?: TargetOptions): PingPongTargets;
  pingPongStorage(bytes: number): PingPongStorage;
  uniforms<T extends Record<string, unknown>>(values: T): SharedUniforms<T>;
  bundle(opts: BundleOptions, cb: (recorder: BundleRecorder) => void): Bundle;
}

export type AdapterFactory = () => VGPUAdapter;

type ResizeState = {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly opts: InitOptions;
  readonly autoResize: boolean;
  readonly callbacks: Set<(size: readonly [number, number]) => void>;
};

export async function createGpu(entry: "browser" | "node" | "mock", canvasOrOpts?: HTMLCanvasElement | OffscreenCanvas | InitOptions, maybeOpts: InitOptions = {}, adapterFactory?: AdapterFactory): Promise<Gpu> {
  const hasCanvas = isCanvas(canvasOrOpts);
  const opts = (hasCanvas ? maybeOpts : canvasOrOpts) ?? {};
  const device = await createDevice(entry, opts, adapterFactory);
  const canvas = hasCanvas ? canvasOrOpts : undefined;
  const resizeCallbacks = new Set<(size: readonly [number, number]) => void>();
  const screen = canvas ? configureCanvasScreen(device, canvas, opts, resizeCallbacks) : undefined;
  const resizeState = canvas ? { canvas, opts, autoResize: opts.autoResize ?? true, callbacks: resizeCallbacks } : undefined;
  return new RingGpu(device, screen, resizeState);
}

class RingGpu implements Gpu {
  readonly gpu: GPUDevice;
  time = 0;
  deltaTime = 0;
  frameCount = 0;
  private lastTimeMs = nowMs();
  private readonly cache = createBindGroupCache();
  private readonly samplers;
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);

  constructor(readonly device: Device, readonly screen?: Target, private readonly resizeState?: ResizeState) {
    this.gpu = device.gpu;
    this.samplers = createSamplerCache(device);
    const runner = new FrameRunner(() => new Frame(device, screen), () => this.advanceFrameState());
    this.frame = callableFrameRunner(runner);
  }

  pass(source: string, opts: PassOptions = {}): Pass {
    if (hasMesh(opts)) throw unsupportedError("gpu.pass", "gpu.pass() nunca acepta vertex buffers; usá gpu.draw({ shader, mesh: gpu.mesh(geometry) }).");
    return new Pass(this.device, source, opts, this.cache, this.screen);
  }
  draw(opts: DrawOptions): Draw { return new Draw(this.device, opts.shader, opts, this.cache, this.screen); }
  target(opts: TargetOptions = {}): Target { return new OffscreenTarget(this.device, opts); }
  sampler(desc?: GPUSamplerDescriptor): GPUSampler { return this.samplers.sampler(desc); }
  mesh(geometry: unknown): MeshLike { return createSceneMesh(this.device, geometry as never); }
  onResize(cb: (size: readonly [number, number]) => void): () => void {
    const callbacks = this.resizeState?.callbacks;
    if (!callbacks) return () => undefined;
    callbacks.add(cb);
    return () => { callbacks.delete(cb); };
  }
  dispose(): void { this.cache.dispose(); this.device.dispose(); }
  compute(source: string, opts: ComputeOptions = {}): Compute { return new ComputePipeline(this.device, source, opts, this.cache); }
  storage(bytes: number, access: StorageAccess = "read-write"): StorageBuffer { return createStorageBuffer(this.device, bytes, access); }
  pingPong(width: number, height: number, opts: TargetOptions = {}): PingPongTargets { return createPingPongTargets(this.device, width, height, opts); }
  pingPongStorage(bytes: number): PingPongStorage { return createPingPongStorage(this.device, bytes); }
  uniforms<T extends Record<string, unknown>>(values: T): SharedUniforms<T> { return createSharedUniforms(this.device, values); }
  bundle(_opts: BundleOptions, _cb: (recorder: BundleRecorder) => void): never { throw lanePlaceholder("gpu.bundle", "fase 3 Lane D"); }

  private advanceFrameState(): void {
    this.advanceTime();
    this.applyAutoResize();
  }

  private advanceTime(): void {
    const next = nowMs();
    this.deltaTime = Math.max(0, (next - this.lastTimeMs) / 1000);
    this.time += this.deltaTime;
    this.lastTimeMs = next;
    this.frameCount += 1;
  }

  private applyAutoResize(): void {
    if (!this.screen || !this.resizeState?.autoResize) return;
    const nextSize = canvasSize(this.resizeState.canvas, this.resizeState.opts);
    if (nextSize[0] === this.screen.size[0] && nextSize[1] === this.screen.size[1]) return;
    this.screen.resize(nextSize);
  }
}

async function createDevice(entry: "browser" | "node" | "mock", opts: InitOptions, adapterFactory?: AdapterFactory): Promise<Device> {
  if (opts.adapter || adapterFactory) return (opts.adapter ?? adapterFactory!()).requestDevice(opts);
  if (entry === "browser") return requestBrowserDevice(opts);
  throw unsupportedError("init", `init(${entry}) requiere adapterFactory.`);
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
  if (!adapter) throw unsupportedError("init", "navigator.gpu.requestAdapter() devolvió null.");
  const gpuDevice = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  return new Device(gpuDevice, adapter.info ?? null);
}

function configureCanvasScreen(device: Device, canvas: HTMLCanvasElement | OffscreenCanvas, opts: InitOptions, resizeCallbacks: Set<(size: readonly [number, number]) => void>): Target {
  const navGpu = (globalThis.navigator as (Navigator & { gpu?: GPU }) | undefined)?.gpu;
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw unsupportedError("init", "El canvas no pudo crear contexto webgpu.");
  const format = navGpu?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
  const size = canvasSize(canvas, opts);
  setCanvasSize(canvas, size);
  context.configure({ device: device.gpu, format, alphaMode: "premultiplied" });
  return new ScreenTarget(context, device, format, (nextSize) => {
    for (const cb of resizeCallbacks) cb(nextSize);
  });
}

function canvasSize(canvas: HTMLCanvasElement | OffscreenCanvas, opts: InitOptions): readonly [number, number] {
  if (opts.size) return opts.size;
  const dpr = clampDpr(opts.dpr);
  const anyCanvas = canvas as { clientWidth?: number; clientHeight?: number; width: number; height: number };
  return [Math.max(1, Math.round((anyCanvas.clientWidth ?? anyCanvas.width) * dpr)), Math.max(1, Math.round((anyCanvas.clientHeight ?? anyCanvas.height) * dpr))];
}

function setCanvasSize(canvas: HTMLCanvasElement | OffscreenCanvas, size: readonly [number, number]): void {
  (canvas as { width: number; height: number }).width = size[0];
  (canvas as { width: number; height: number }).height = size[1];
}

function lanePlaceholder(where: string, lane: string): never {
  throw unsupportedError(where, `${where} está reservado y se implementa en ${lane}; Phase 2 congela la firma solamente.`);
}

function hasMesh(opts: PassOptions): boolean {
  return "mesh" in (opts as Record<string, unknown>);
}

function clampDpr(dpr: InitOptions["dpr"]): number {
  const raw = globalThis.devicePixelRatio ?? 1;
  if (Array.isArray(dpr)) return Math.min(dpr[1], Math.max(dpr[0], raw));
  if (typeof dpr === "number") return dpr;
  return raw;
}
function isCanvas(value: unknown): value is HTMLCanvasElement | OffscreenCanvas { return typeof value === "object" && value !== null && "getContext" in value; }
function nowMs(): number { return globalThis.performance?.now?.() ?? Date.now(); }
