import { Device, VGPUError, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";
import { resolveWebGPU, type WebGPUModule } from "./dawn-loader.ts";
type NodeAdapterFlags = { readonly backendFlags?: readonly string[] };
type NodeAdapterRetryOptions = { readonly adapterRequestRetryCount?: number; readonly adapterRequestRetryBaseDelayMs?: number };
type RequestDeviceOptions = CreateDeviceOptions & NodeAdapterFlags & NodeAdapterRetryOptions & { readonly backend?: "opengl" | "webgpu" };
type DawnAdapterOptions = GPURequestAdapterOptions & { readonly featureLevel?: "compatibility" };
const defaultAdapterRequestRetryCount = 3;
const defaultAdapterRequestRetryBaseDelayMs = 100;
let dawnGPU: GPU | null = null;
let dawnFlagsUsed: readonly string[] | null = null;
let loadedWebGPU: WebGPUModule | null = null;
let hostGlibcVersion: string | null | undefined;

export function createNodeAdapter(): VGPUAdapter {
  return { requestDevice };
}

export async function createNodeDevice(opts?: RequestDeviceOptions): Promise<Device> {
  return requestDevice(opts);
}

async function requestDevice(opts: RequestDeviceOptions = {}): Promise<Device> {
  const webgpu = await loadWebGPU();
  Object.assign(globalThis, webgpu.globals);
  const options = adapterOptions(opts);
  const adapter = await requestAdapterWithRetry(getDawnGPU(opts, webgpu), options as GPURequestAdapterOptions, opts);
  const device = await adapter.requestDevice({ requiredFeatures: opts.requiredFeatures, requiredLimits: opts.requiredLimits });
  if (opts.label) device.label = opts.label;
  return new Device(device, adapter.info ?? null, { isCompatibilityMode: options.featureLevel === "compatibility" });
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

    if (attempt < maxAttempts) {
      await sleep(baseDelayMs * 3 ** (attempt - 1));
    }
  }

  const tried = JSON.stringify(options);
  throw new VGPUError({
    code: "VGPU-NODE-NO-ADAPTER",
    message: `No WebGPU adapter available after ${maxAttempts} attempts with requestAdapter(${tried}) and Dawn flags [${dawnFlagsUsed?.join(",") ?? ""}].`,
    fix: "Check the Mesa/driver version, Vulkan ICD (VK_ICD_FILENAMES), and display variables (DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR). Use VGPU_DAWN_FLAGS to select a Dawn backend explicitly.",
    where: "createNodeAdapter",
    cause: lastError,
  });
}

function shouldRetryAdapterRequestError(error: unknown): boolean {
  return !/AbortError/i.test(String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDawnGPU(opts: RequestDeviceOptions, webgpu: WebGPUModule): GPU {
  const flags = backendFlags(opts);
  if (dawnGPU) {
    if (!flagsEqual(flags, dawnFlagsUsed)) {
      console.warn(
        `[@vgpu/adapter-node] Dawn already initialized with flags [${dawnFlagsUsed?.join(",") ?? ""}], ` +
          `ignoring requested flags [${flags.join(",")}]. Re-init causes SIGSEGV in Dawn.`,
      );
    }
    return dawnGPU;
  }
  dawnGPU = webgpu.create([...flags]);
  dawnFlagsUsed = [...flags];
  return dawnGPU;
}

async function loadWebGPU(): Promise<WebGPUModule> {
  if (loadedWebGPU) return loadedWebGPU;
  loadedWebGPU = await resolveWebGPU();
  return loadedWebGPU;
}

function backendFlags(opts: RequestDeviceOptions): readonly string[] {
  const envFlags = process.env.VGPU_DAWN_FLAGS?.split(/\s+/).filter(Boolean);
  if (envFlags && envFlags.length > 0) return envFlags;
  if (opts.backendFlags) return opts.backendFlags;
  if (opts.backend === "opengl") return ["backend=opengl"];
  if (process.platform === "linux" && opts.backend !== "webgpu" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return ["backend=opengl"];
  return [];
}

function adapterOptions(opts: RequestDeviceOptions): DawnAdapterOptions {
  return {
    powerPreference: opts.powerPreference,
    ...(process.platform === "linux" && opts.backend !== "webgpu" ? { featureLevel: "compatibility" as const } : {}),
  };
}

function flagsEqual(a: readonly string[], b: readonly string[] | null): boolean {
  return b !== null && a.length === b.length && a.every((flag, index) => flag === b[index]);
}
