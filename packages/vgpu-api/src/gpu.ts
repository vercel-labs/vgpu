import type { VGPUAdapter } from "@vgpu/core";
import { Device } from "@vgpu/core";
import { createBindGroupCache } from "./bind-cache.ts";
import { Draw, type DrawOptions, type MeshLike } from "./draw.ts";
import { Frame, FrameRunner } from "./frame.ts";
import { Pass, type PassOptions } from "./pass.ts";
import { createSamplerCache } from "./sampler.ts";
import { OffscreenTarget, ScreenTarget, type Target, type TargetOptions } from "./target.ts";
import { unsupportedError } from "./errors.ts";

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
  compute(source: string, opts?: unknown): never;
  storage(opts?: unknown): never;
  pingPong(opts?: unknown): never;
  uniforms(values?: unknown): never;
  bundle(opts?: unknown, cb?: unknown): never;
}

export type AdapterFactory = () => VGPUAdapter;

export async function createGpu(entry: "browser" | "node" | "mock", canvasOrOpts?: HTMLCanvasElement | OffscreenCanvas | InitOptions, maybeOpts: InitOptions = {}, adapterFactory?: AdapterFactory): Promise<Gpu> {
  const hasCanvas = isCanvas(canvasOrOpts);
  const opts = (hasCanvas ? maybeOpts : canvasOrOpts) ?? {};
  let device: Device;
  if (opts.adapter || adapterFactory) {
    device = await (opts.adapter ?? adapterFactory!()).requestDevice(opts);
  } else if (entry === "browser") {
    device = await requestBrowserDevice(opts);
  } else {
    throw unsupportedError("init", `init(${entry}) requiere adapterFactory.`);
  }

  const canvas = hasCanvas ? canvasOrOpts : undefined;
  const screen = canvas ? configureCanvasScreen(device, canvas, opts) : undefined;
  return new RingGpu(device, screen);
}

class RingGpu implements Gpu {
  readonly gpu: GPUDevice;
  time = 0;
  deltaTime = 0;
  frameCount = 0;
  private lastTimeMs = nowMs();
  private readonly cache = createBindGroupCache();
  private readonly samplers;
  private readonly resizeCallbacks = new Set<(size: readonly [number, number]) => void>();
  readonly frame: FrameRunner & ((cb?: (frame: Frame) => void) => Frame);

  constructor(readonly device: Device, readonly screen?: Target) {
    this.gpu = device.gpu;
    this.samplers = createSamplerCache(device);
    const runner = new FrameRunner(() => new Frame(device, screen), () => this.advanceTime());
    const callable = ((cb?: (frame: Frame) => void) => runner.frame(cb)) as FrameRunner & ((cb?: (frame: Frame) => void) => Frame);
    Object.setPrototypeOf(callable, FrameRunner.prototype);
    Object.assign(callable, runner);
    callable.frame = runner.frame.bind(runner);
    callable.loop = runner.loop.bind(runner);
    this.frame = callable;
  }

  pass(source: string, opts: PassOptions = {}): Pass { return new Pass(this.device, source, opts, this.cache, this.screen); }
  draw(opts: DrawOptions): Draw { return new Draw(this.device, opts.shader, opts, this.cache, this.screen); }
  target(opts: TargetOptions = {}): Target { return new OffscreenTarget(this.device, opts); }
  sampler(desc?: GPUSamplerDescriptor): GPUSampler { return this.samplers.sampler(desc); }
  mesh(_geometry: unknown): MeshLike { return {}; }
  onResize(cb: (size: readonly [number, number]) => void): () => void { this.resizeCallbacks.add(cb); return () => { this.resizeCallbacks.delete(cb); }; }
  dispose(): void { this.cache.dispose(); this.device.dispose(); }
  compute(): never { throw unsupportedError("gpu.compute", "gpu.compute queda congelado como nombre; Lane C lo implementa."); }
  storage(): never { throw unsupportedError("gpu.storage", "gpu.storage queda congelado como nombre; Lane C lo implementa."); }
  pingPong(): never { throw unsupportedError("gpu.pingPong", "gpu.pingPong queda congelado como nombre; Lane C lo implementa."); }
  uniforms(): never { throw unsupportedError("gpu.uniforms", "gpu.uniforms queda congelado como nombre; Lane E lo implementa."); }
  bundle(): never { throw unsupportedError("gpu.bundle", "gpu.bundle queda congelado como nombre; Lane D lo implementa."); }

  private advanceTime(): void {
    const next = nowMs();
    this.deltaTime = Math.max(0, (next - this.lastTimeMs) / 1000);
    this.time += this.deltaTime;
    this.lastTimeMs = next;
    this.frameCount += 1;
  }
}

async function requestBrowserDevice(opts: InitOptions): Promise<Device> {
  const nav = globalThis.navigator as Navigator & { gpu?: GPU };
  const adapter = await nav.gpu?.requestAdapter({ powerPreference: opts.powerPreference });
  if (!adapter) throw unsupportedError("init", "navigator.gpu.requestAdapter() devolvió null.");
  const gpuDevice = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  return new Device(gpuDevice, adapter.info ?? null);
}

function configureCanvasScreen(device: Device, canvas: HTMLCanvasElement | OffscreenCanvas, opts: InitOptions): Target {
  const navGpu = (globalThis.navigator as Navigator & { gpu?: GPU }).gpu;
  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw unsupportedError("init", "El canvas no pudo crear contexto webgpu.");
  const format = navGpu?.getPreferredCanvasFormat?.() ?? "bgra8unorm";
  const size = canvasSize(canvas, opts);
  (canvas as { width: number; height: number }).width = size[0];
  (canvas as { width: number; height: number }).height = size[1];
  context.configure({ device: device.gpu, format, alphaMode: "premultiplied" });
  return new ScreenTarget(context, device, format);
}

function canvasSize(canvas: HTMLCanvasElement | OffscreenCanvas, opts: InitOptions): readonly [number, number] {
  if (opts.size) return opts.size;
  const dpr = clampDpr(opts.dpr);
  const anyCanvas = canvas as { clientWidth?: number; clientHeight?: number; width: number; height: number };
  return [Math.max(1, Math.round((anyCanvas.clientWidth ?? anyCanvas.width) * dpr)), Math.max(1, Math.round((anyCanvas.clientHeight ?? anyCanvas.height) * dpr))];
}
function clampDpr(dpr: InitOptions["dpr"]): number {
  const raw = globalThis.devicePixelRatio ?? 1;
  if (Array.isArray(dpr)) return Math.min(dpr[1], Math.max(dpr[0], raw));
  if (typeof dpr === "number") return dpr;
  return raw;
}
function isCanvas(value: unknown): value is HTMLCanvasElement | OffscreenCanvas { return typeof value === "object" && value !== null && "getContext" in value; }
function nowMs(): number { return globalThis.performance?.now?.() ?? Date.now(); }
