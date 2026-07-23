import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Device, VGPUError, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";
import { resolveWebGPU, type WebGPUModule } from "./dawn-loader.ts";
import { createPrivateSoftwareRendererCopy, getCachedSoftwareRenderer } from "./software-renderer-cache.ts";
type NodeAdapterFlags = { readonly backendFlags?: readonly string[] };
type NodeAdapterRetryOptions = { readonly adapterRequestRetryCount?: number; readonly adapterRequestRetryBaseDelayMs?: number };
type RequestDeviceOptions = CreateDeviceOptions & NodeAdapterFlags & NodeAdapterRetryOptions & { readonly backend?: "opengl" | "webgpu" };
type DawnAdapterOptions = GPURequestAdapterOptions & { readonly featureLevel?: "compatibility" };
export type NodeAdapterMode = "auto" | "hardware" | "software";
export type CreateNodeAdapterOptions = { readonly adapter?: NodeAdapterMode };
export type NodeAdapterInfo = { readonly name: string; readonly type: "gpu" | "cpu" };

export function nodeAdapterEnvironmentOverride(): NodeAdapterMode | undefined {
  const value = process.env.VGPU_ADAPTER;
  if (value === undefined || value === "") return undefined;
  if (value !== "software" && value !== "hardware") throw new VGPUError({
    code: "VGPU-NODE-ADAPTER-INVALID",
    message: `Invalid VGPU_ADAPTER=${JSON.stringify(value)}; expected "software" or "hardware".`,
    fix: "Unset VGPU_ADAPTER or set it to software or hardware.",
    where: "init",
  });
  if (!announcedAdapterOverrides.has(value)) {
    announcedAdapterOverrides.add(value);
    console.error(`vgpu: adapter overridden by VGPU_ADAPTER=${value}`);
  }
  return value;
}
export function describeNodeAdapter(info: GPUAdapterInfo | null): NodeAdapterInfo {
  const details = info as (GPUAdapterInfo & { adapterType?: string; type?: string }) | null;
  const name = String(details?.description || details?.device || details?.vendor || "unknown adapter");
  return { name, type: details?.adapterType === "cpu" || details?.type === "cpu" || /llvmpipe|lavapipe|swiftshader|software|cpu/iu.test(name) ? "cpu" : "gpu" };
}

const defaultAdapterRequestRetryCount = 3;
const defaultAdapterRequestRetryBaseDelayMs = 100;
let dawnGPU: GPU | null = null;
let dawnFlagsUsed: readonly string[] | null = null;
let loadedWebGPU: WebGPUModule | null = null;
let softwareOperation = Promise.resolve();
const announcedAdapterOverrides = new Set<string>();

export function createNodeAdapter(options: CreateNodeAdapterOptions = {}): VGPUAdapter {
  return { requestDevice: (deviceOptions) => requestDevice(deviceOptions, options.adapter ?? "auto") };
}

export async function createNodeDevice(opts?: RequestDeviceOptions): Promise<Device> {
  return requestDevice(opts, "auto");
}

async function requestDevice(opts: RequestDeviceOptions = {}, mode: NodeAdapterMode): Promise<Device> {
  const webgpu = await loadWebGPU();
  Object.assign(globalThis, webgpu.globals);
  const options = adapterOptions(opts);
  const vendorIcdPresent = hasVendorVulkanIcd();
  let adapter: GPUAdapter;
  let software = false;

  if (mode === "software") {
    const icd = requireCachedSoftwareRenderer();
    adapter = await withSoftwareIcd(icd, () => {
      dawnGPU = null;
      dawnFlagsUsed = null;
      return requestAdapterWithRetry(getDawnGPU(opts, webgpu, true), options as GPURequestAdapterOptions, opts);
    });
    software = true;
  } else {
    const gpu = getDawnGPU(opts, webgpu);
    try {
      adapter = await requestAdapterWithRetry(gpu, options as GPURequestAdapterOptions, opts);
      if (mode === "hardware" && isSoftwareAdapter(adapter.info)) {
        throw noAdapterError(new Error("Only a CPU software adapter was discovered."), "A real GPU was required by adapter: \"hardware\". Install or repair the vendor GPU driver, or choose adapter: \"auto\".");
      }
    } catch (error) {
      if (mode === "hardware" || !isNoAdapterError(error)) throw error;
      const icd = getCachedSoftwareRenderer();
      if (!icd) throw noAdapterError(error, "Install the portable CPU renderer with `npx vgpu install-software-renderer`, then retry. Check the Mesa/driver version, Vulkan ICD (VK_ICD_FILENAMES), and display variables. To diagnose the environment, run: npx vgpu doctor");
      console.error(vendorIcdPresent
        ? "vgpu: a vendor Vulkan driver is present but failed to initialize — using CPU software renderer (lavapipe). Run `npx vgpu doctor` for details."
        : "vgpu: no GPU adapter found — using CPU software renderer (lavapipe)");
      adapter = await withSoftwareIcd(icd, () => {
        // Vulkan ICD discovery is fixed when Dawn creates its native instance.
        // The hardware instance found nothing, so replace it for the consented retry.
        dawnGPU = null;
        dawnFlagsUsed = null;
        return requestAdapterWithRetry(getDawnGPU(opts, webgpu, true), options as GPURequestAdapterOptions, opts);
      });
      software = true;
    }
  }

  const device = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  if (opts.label) device.label = opts.label;
  const info = software
    ? Object.assign({}, adapter.info, { description: adapter.info?.description || "lavapipe", adapterType: "cpu" }) as unknown as GPUAdapterInfo
    : adapter.info ?? null;
  return new Device(device, info, { isCompatibilityMode: options.featureLevel === "compatibility" });
}

async function requestAdapterWithRetry(gpu: GPU, options: GPURequestAdapterOptions, retryOptions: NodeAdapterRetryOptions): Promise<GPUAdapter> {
  let lastError: unknown = new Error("requestAdapter returned null");
  const maxAttempts = Math.max(1, retryOptions.adapterRequestRetryCount ?? defaultAdapterRequestRetryCount);
  const baseDelayMs = Math.max(0, retryOptions.adapterRequestRetryBaseDelayMs ?? defaultAdapterRequestRetryBaseDelayMs);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const adapter = await gpu.requestAdapter(options);
      if (adapter) return adapter;
      lastError = new Error("requestAdapter returned null");
    } catch (error) {
      if (!shouldRetryAdapterRequestError(error)) throw error;
      lastError = error;
    }
    if (attempt < maxAttempts) await sleep(baseDelayMs * 3 ** (attempt - 1));
  }
  throw noAdapterError(lastError);
}

function noAdapterError(cause: unknown, fix = "Check the Mesa/driver version, Vulkan ICD (VK_ICD_FILENAMES), and display variables (DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR). Use VGPU_DAWN_FLAGS to select a Dawn backend explicitly. Install a portable CPU renderer with `npx vgpu install-software-renderer`. To diagnose the environment, run: npx vgpu doctor"): VGPUError {
  return new VGPUError({
    code: "VGPU-NODE-NO-ADAPTER",
    message: `No WebGPU adapter available with Dawn flags [${dawnFlagsUsed?.join(",") ?? ""}].`,
    fix,
    where: "createNodeAdapter",
    cause,
  });
}
function isNoAdapterError(error: unknown): boolean { return error instanceof VGPUError && error.code === "VGPU-NODE-NO-ADAPTER"; }
function isSoftwareAdapter(info: GPUAdapterInfo | null | undefined): boolean {
  if (!info) return false;
  const details = info as GPUAdapterInfo & { adapterType?: string; type?: string };
  const name = `${details.description ?? ""} ${details.device ?? ""} ${details.vendor ?? ""}`;
  return details.adapterType === "cpu" || details.type === "cpu" || /llvmpipe|lavapipe|swiftshader|software|cpu/iu.test(name);
}
function requireCachedSoftwareRenderer(): string {
  const icd = getCachedSoftwareRenderer();
  if (icd) return icd;
  throw new VGPUError({
    code: "VGPU-NODE-SOFTWARE-RENDERER-MISSING",
    message: "The portable CPU software renderer is not installed.",
    fix: "Run `npx vgpu install-software-renderer`, then retry.",
    where: "createNodeAdapter",
  });
}
async function withSoftwareIcd<T>(icd: string, operation: () => Promise<T>): Promise<T> {
  const run = softwareOperation.then(async () => {
    const privateCopy = createPrivateSoftwareRendererCopy(icd);
    const previousIcd = process.env.VK_ICD_FILENAMES;
    const previousDrivers = process.env.VK_DRIVER_FILES;
    process.env.VK_ICD_FILENAMES = privateCopy.path;
    delete process.env.VK_DRIVER_FILES;
    try { return await operation(); }
    finally {
      if (previousIcd === undefined) delete process.env.VK_ICD_FILENAMES; else process.env.VK_ICD_FILENAMES = previousIcd;
      if (previousDrivers === undefined) delete process.env.VK_DRIVER_FILES; else process.env.VK_DRIVER_FILES = previousDrivers;
      privateCopy.cleanup();
    }
  });
  softwareOperation = run.then(() => undefined, () => undefined);
  return run;
}
function hasVendorVulkanIcd(): boolean {
  if (process.env.VK_ICD_FILENAMES || process.env.VK_DRIVER_FILES) return true;
  try { return readdirSync("/usr/share/vulkan/icd.d").some((name) => name.endsWith(".json")); } catch { return false; }
}
function shouldRetryAdapterRequestError(error: unknown): boolean { return !/AbortError/i.test(String(error)); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function getDawnGPU(opts: RequestDeviceOptions, webgpu: WebGPUModule, forceSoftware = false): GPU {
  const flags = forceSoftware ? [] : backendFlags(opts);
  if (dawnGPU) {
    if (!flagsEqual(flags, dawnFlagsUsed)) console.warn(`[@vgpu/adapter-node] Dawn already initialized with flags [${dawnFlagsUsed?.join(",") ?? ""}], ignoring requested flags [${flags.join(",")}]. Re-init causes SIGSEGV in Dawn.`);
    return dawnGPU;
  }
  dawnGPU = webgpu.create([...flags]);
  dawnFlagsUsed = [...flags];
  return dawnGPU;
}
async function loadWebGPU(): Promise<WebGPUModule> { if (loadedWebGPU) return loadedWebGPU; loadedWebGPU = await resolveWebGPU(); return loadedWebGPU; }
function backendFlags(opts: RequestDeviceOptions): readonly string[] {
  const envFlags = process.env.VGPU_DAWN_FLAGS?.split(/\s+/).filter(Boolean);
  if (envFlags && envFlags.length > 0) return envFlags;
  if (opts.backendFlags) return opts.backendFlags;
  if (opts.backend === "opengl") return ["backend=opengl"];
  if (process.platform === "linux" && opts.backend !== "webgpu" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return ["backend=opengl"];
  return [];
}
function adapterOptions(opts: RequestDeviceOptions): DawnAdapterOptions { return { powerPreference: opts.powerPreference, ...(process.platform === "linux" && opts.backend !== "webgpu" ? { featureLevel: "compatibility" as const } : {}) }; }
function flagsEqual(a: readonly string[], b: readonly string[] | null): boolean { return b !== null && a.length === b.length && a.every((flag, index) => flag === b[index]); }
