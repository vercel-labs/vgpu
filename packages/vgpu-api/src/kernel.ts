/**
 * Minimal `Gpu` core plus its private kernel.
 *
 * The kernel is the only shared, cross-feature runtime: device handle, error delivery,
 * `settled()` bookkeeping, ownership/teardown ordering and a lazy service registry.
 * It MUST NOT import a feature module (frame, draw, effect, surface, timer, geometry, ...):
 * every service is registered by the feature that owns it, through a token + factory, so a
 * program that never imports the feature never pays for it. See T202-06 negative metafile
 * assertions and the `init-only` bundle budget.
 */
import { Device, validateRequiredFeatures, type RequiredDeviceLimits, type VGPUAdapter } from "@vgpu/core";
import type { GpuErrorListener } from "./api-types.ts";
import { unsupportedError, VGPUError } from "./errors.ts";
// Not a feature module: two structural casts over @vgpu/core's lifecycle guards, no runtime deps.
import { assertDeviceUsable } from "./lifecycle.ts";

/** vgpu requests its own device: it owns the native handle and destroys it on `dispose()`. */
export type RequestedDeviceInitOptions = {
  readonly adapter?: VGPUAdapter;
  readonly device?: never;
  readonly powerPreference?: GPUPowerPreference;
  readonly requiredFeatures?: readonly GPUFeatureName[];
  readonly requiredLimits?: RequiredDeviceLimits;
  readonly label?: string;
};

/** vgpu wraps a device it did not create: it never destroys it, and every entry point re-checks that the owner has not. */
export type ExternalDeviceInitOptions = {
  readonly device: GPUDevice;
  readonly adapter?: never;
  readonly powerPreference?: never;
  readonly requiredFeatures?: never;
  readonly requiredLimits?: never;
  readonly label?: never;
};

export type InitOptions = RequestedDeviceInitOptions | ExternalDeviceInitOptions;

export type AdapterFactory = () => VGPUAdapter;
export type EntryKind = "browser" | "node" | "mock";

/**
 * Ring-1 core shared by browser, node, and mock entrypoints: a device handle, an error
 * channel and a lifetime. Everything else is a free function that takes this object.
 */
export interface Gpu {
  readonly device: Device;
  readonly gpu: GPUDevice;
  /** True once `dispose()` ran. Reads stay legal; new work does not. */
  readonly disposed: boolean;
  onError(cb: GpuErrorListener): () => void;
  settled(): Promise<void>;
  dispose(): void;
}

/** Contributes promises to `gpu.settled()`; queried (not retained) at each call, so it is a snapshot source. */
export type SettledSource = () => readonly Promise<unknown>[];
/** Undo function returned by every kernel registration. Idempotent by contract. */
export type Release = () => void;
export type Disposer = () => void;

/**
 * Teardown order of `gpu.dispose()`. Phases run in declaration order; within a phase,
 * registration order.
 *
 * - `scheduler`: rAF/timer loops. Stopped first — a tick landing mid-teardown would encode
 *   against a dying device.
 * - `resource`: surfaces, query rings, views and anything holding GPU objects.
 * - `service`: caches and stores shared by features (pipelines, bind groups, samplers).
 *
 * The device is disposed after every phase.
 */
export type OwnershipPhase = "scheduler" | "resource" | "service";
const PHASES: readonly OwnershipPhase[] = ["scheduler", "resource", "service"];

declare const SERVICE_TYPE: unique symbol;
/** Nominal handle for a lazily created shared service. Created by the feature that owns the service. */
export interface ServiceToken<T> {
  readonly name: string;
  /** Phantom: carries `T` for inference, never present at runtime. */
  readonly [SERVICE_TYPE]?: T;
}

export function serviceToken<T>(name: string): ServiceToken<T> {
  return { name };
}

/** Private per-`Gpu` runtime. Not exported from any entrypoint; reachable only through `kernelOf`. */
export interface Kernel {
  readonly device: Device;
  readonly disposed: boolean;
  /**
   * Lazily creates (and memoizes) the service behind `token`. The factory lives in the calling
   * feature module, so the kernel never references it statically.
   */
  service<T>(token: ServiceToken<T>, factory: (kernel: Kernel) => T): T;
  /** The instance if it was already created, else undefined. Never runs the factory. */
  peekService<T>(token: ServiceToken<T>): T | undefined;
  /** Registers a teardown callback in `phase`; returns the release that unregisters it. */
  own(phase: OwnershipPhase, disposer: Disposer): Release;
  addErrorListener(cb: GpuErrorListener): Release;
  /** Delivers asynchronously to the listeners (or `console.error`). Never rejects, never throws. */
  reportError(error: VGPUError): Promise<void>;
  /** Adds a promise to the `settled()` set; swallows rejections into `console.error`. */
  trackDelivery(promise: Promise<unknown>): Promise<void>;
  registerSettledSource(source: SettledSource): Release;
  settled(): Promise<void>;
  dispose(): void;
}

const kernels = new WeakMap<Gpu, Kernel>();

/** Internal accessor for the kernel of a `Gpu`. Throws for objects this library did not create. */
export function kernelOf(gpu: Gpu): Kernel {
  const kernel = kernels.get(gpu);
  if (!kernel) {
    throw new VGPUError({
      code: "VGPU-GPU-FOREIGN",
      message: "This object was not created by init(); it has no vgpu kernel.",
      fix: "Pass the gpu returned by init() from vgpu, vgpu/node or vgpu/mock.",
      where: "gpu",
    });
  }
  return kernel;
}

class KernelImpl implements Kernel {
  readonly #services = new Map<ServiceToken<unknown>, unknown>();
  readonly #owners: ReadonlyMap<OwnershipPhase, Set<Disposer>> = new Map(PHASES.map((phase) => [phase, new Set<Disposer>()]));
  readonly #errorListeners = new Set<GpuErrorListener>();
  readonly #pendingDeliveries = new Set<Promise<void>>();
  readonly #settledSources = new Set<SettledSource>();
  #disposed = false;

  constructor(readonly device: Device) {}

  get disposed(): boolean { return this.#disposed; }

  service<T>(token: ServiceToken<T>, factory: (kernel: Kernel) => T): T {
    const existing = this.#services.get(token as ServiceToken<unknown>);
    if (existing !== undefined) return existing as T;
    const created = factory(this);
    this.#services.set(token as ServiceToken<unknown>, created);
    return created;
  }

  peekService<T>(token: ServiceToken<T>): T | undefined {
    return this.#services.get(token as ServiceToken<unknown>) as T | undefined;
  }

  own(phase: OwnershipPhase, disposer: Disposer): Release {
    const set = this.#owners.get(phase)!;
    set.add(disposer);
    return () => { set.delete(disposer); };
  }

  addErrorListener(cb: GpuErrorListener): Release {
    this.#errorListeners.add(cb);
    return () => { this.#errorListeners.delete(cb); };
  }

  reportError(error: VGPUError): Promise<void> {
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
    return this.trackDelivery(delivery);
  }

  trackDelivery(promise: Promise<unknown>): Promise<void> {
    const tracked = Promise.resolve(promise).then(() => undefined, (error) => { console.error(error); });
    this.#pendingDeliveries.add(tracked);
    void tracked.finally(() => this.#pendingDeliveries.delete(tracked));
    return tracked;
  }

  registerSettledSource(source: SettledSource): Release {
    this.#settledSources.add(source);
    return () => { this.#settledSources.delete(source); };
  }

  async settled(): Promise<void> {
    const snapshot = [
      ...this.#pendingDeliveries,
      ...[...this.#settledSources].flatMap((source) => source()),
    ];
    await Promise.allSettled(snapshot);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const phase of PHASES) {
      const set = this.#owners.get(phase)!;
      // Copy: a disposer usually calls its own release(), mutating the set while we walk it.
      for (const disposer of [...set]) disposer();
      set.clear();
    }
    this.#services.clear();
    this.#settledSources.clear();
    this.#errorListeners.clear();
    this.device.dispose();
  }
}

/** Builds the minimal `Gpu` for an already-created device and registers its kernel. */
export function attachKernel(device: Device): Gpu {
  const kernel = new KernelImpl(device);
  const gpu: Gpu = {
    device,
    gpu: device.gpu,
    get disposed(): boolean { return kernel.disposed; },
    onError: (cb: GpuErrorListener) => kernel.addErrorListener(cb),
    settled: () => kernel.settled(),
    dispose: () => { kernel.dispose(); },
  };
  kernels.set(gpu, kernel);
  return gpu;
}

/** Entry-agnostic core constructor: resolve a device, wrap it in the minimal `Gpu`. */
export async function createCoreGpu(entry: EntryKind, opts: InitOptions = {}, adapterFactory?: AdapterFactory): Promise<Gpu> {
  const validated = normalizeInitOptions(opts);
  const device = await createDevice(entry, validated, adapterFactory);
  try {
    assertDeviceUsable(device, "init");
    return attachKernel(device);
  } catch (error) {
    // An already-destroyed external device must not leave a half-built Gpu behind. Disposing a
    // borrowed device only drops our wrapper: Device.dispose() never destroys what it does not own.
    device.dispose();
    throw error;
  }
}

export async function createDevice(entry: EntryKind, opts: InitOptions, adapterFactory?: AdapterFactory): Promise<Device> {
  // An external device short-circuits adapter selection entirely: there is nothing to request.
  if ("device" in opts && opts.device !== undefined) {
    if (!isGPUDeviceShape(opts.device)) throw initError("VGPU-INIT-DEVICE-INVALID", "Invalid external GPUDevice shape.");
    return new (Device as unknown as new (gpu: GPUDevice, adapterInfo: null, ownership: "external") => Device)(opts.device, null, "external");
  }
  if (opts.adapter || adapterFactory) return (opts.adapter ?? adapterFactory!()).requestDevice(opts);
  if (entry === "browser") return requestBrowserDevice(opts);
  throw unsupportedError("init", `init(${entry}) requires adapterFactory.`);
}

/** Validates and narrows raw init options before any device is created. */
export function normalizeInitOptions(value: unknown): InitOptions {
  if (typeof value !== "object" || value === null) throw initError("VGPU-INIT-DEVICE-INVALID", "Invalid init options.");
  const opts = value as Record<string, unknown>;
  try {
    if ("device" in opts) {
      if ("adapter" in opts || "powerPreference" in opts || "requiredFeatures" in opts || "requiredLimits" in opts || "label" in opts) {
        throw initError("VGPU-INIT-OPTIONS-CONFLICT", "External device options cannot be mixed.");
      }
      const device = opts.device;
      if (!isGPUDeviceShape(device)) throw initError("VGPU-INIT-DEVICE-INVALID", "Invalid external GPUDevice shape.");
      return { device };
    }
    const adapter = opts.adapter;
    const powerPreference = opts.powerPreference;
    const requiredFeatures = opts.requiredFeatures;
    const requiredLimits = opts.requiredLimits;
    const label = opts.label;
    return {
      ...(adapter !== undefined ? { adapter: adapter as VGPUAdapter } : {}),
      ...(powerPreference !== undefined ? { powerPreference: powerPreference as GPUPowerPreference } : {}),
      ...(requiredFeatures !== undefined ? { requiredFeatures: requiredFeatures as readonly GPUFeatureName[] } : {}),
      ...(requiredLimits !== undefined ? { requiredLimits: requiredLimits as RequiredDeviceLimits } : {}),
      ...(label !== undefined ? { label: label as string } : {}),
    };
  } catch (error) {
    if (error instanceof VGPUError) throw error;
    throw initError("VGPU-INIT-DEVICE-INVALID", "Invalid init options.");
  }
}

function isGPUDeviceShape(value: unknown): value is GPUDevice {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    const d = value as Partial<GPUDevice>;
    return (typeof d.queue === "object" || typeof d.queue === "function") && d.queue !== null
      && typeof d.createBuffer === "function" && typeof d.createCommandEncoder === "function"
      && !!d.lost && typeof (d.lost as PromiseLike<GPUDeviceLostInfo>).then === "function";
  } catch { return false; }
}

function initError(code: string, message: string): VGPUError { return new VGPUError({ code, message, where: "init" }); }

async function requestBrowserDevice(opts: RequestedDeviceInitOptions): Promise<Device> {
  const nav = globalThis.navigator as Navigator & { gpu?: GPU };
  const adapter = await nav.gpu?.requestAdapter({ powerPreference: opts.powerPreference });
  if (!adapter) throw unsupportedError("init", "navigator.gpu.requestAdapter() returned null.");
  validateRequiredFeatures(adapter.features, opts.requiredFeatures);
  const gpuDevice = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  return new Device(gpuDevice, adapter.info ?? null);
}
