import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Device, VGPUError, type CreateDeviceOptions, type VGPUAdapter } from "@vgpu/core";

type WebGPUModule = { create(options: string[]): GPU; globals: Record<string, unknown> };
type NodeAdapterFlags = { readonly backendFlags?: readonly string[] };
type NodeAdapterRetryOptions = { readonly adapterRequestRetryCount?: number; readonly adapterRequestRetryBaseDelayMs?: number };
type RequestDeviceOptions = CreateDeviceOptions & NodeAdapterFlags & NodeAdapterRetryOptions & { readonly backend?: "opengl" | "webgpu" };
type DawnAdapterOptions = GPURequestAdapterOptions & { readonly featureLevel?: "compatibility" };
type BinaryLoadErrorOptions = { readonly detectedGlibcVersion?: string | null };

const require = createRequire(import.meta.url);
const dawnMinimumGlibcVersion = "2.38";
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

  throw new Error(`No WebGPU adapter available for @vgpu/adapter-node after ${maxAttempts} attempts: ${String(lastError)}`);
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
  try {
    loadedWebGPU = require("webgpu") as WebGPUModule;
    return loadedWebGPU;
  } catch (cause) {
    try {
      loadedWebGPU = (await import("webgpu")) as WebGPUModule;
      return loadedWebGPU;
    } catch (importCause) {
      throw formatBinaryLoadError(importCause ?? cause, { detectedGlibcVersion: getHostGlibcVersion() });
    }
  }
}

function backendFlags(opts: RequestDeviceOptions): readonly string[] {
  const envFlags = process.env.VGPU_DAWN_FLAGS?.split(/\s+/).filter(Boolean);
  if (envFlags && envFlags.length > 0) return envFlags;
  if (opts.backendFlags) return opts.backendFlags;
  if (opts.backend === "webgpu") return [];
  return process.platform === "linux" ? ["backend=opengl"] : [];
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

export function formatBinaryLoadError(cause: unknown, options: BinaryLoadErrorOptions = {}): VGPUError {
  const detectedGlibcVersion = options.detectedGlibcVersion ?? null;
  if (process.platform === "linux" && isGlibcLoadFailure(cause)) {
    const versionLine = detectedGlibcVersion
      ? `This host reports GLIBC ${detectedGlibcVersion}.`
      : "This host reports GLIBC older than 2.38.";
    return new VGPUError({
      code: "VGPU-ADAPTER-NODE-BINARY-LOAD",
      message: `@vgpu/adapter-node requires GLIBC ${dawnMinimumGlibcVersion} or newer to load the Dawn WebGPU native binary. ${versionLine}`,
      fix: "Use Docker instead: `pnpm test:docker`, or upgrade your host GLIBC to a compatible version.",
      where: "createNodeAdapter",
      cause,
    });
  }
  return new VGPUError({
    code: "VGPU-ADAPTER-NODE-BINARY-LOAD",
    message: "@vgpu/adapter-node could not load the Dawn WebGPU native binary.",
    fix: "Run inside the pinned vgpu Docker image with Node 22, Debian trixie, and the OpenGL software stack.",
    where: "createNodeAdapter",
    cause,
  });
}

function isGlibcLoadFailure(cause: unknown): boolean {
  return /GLIBC_\d+\.\d+/.test(String(cause));
}

function getHostGlibcVersion(): string | null {
  if (process.platform !== "linux") return null;
  if (hostGlibcVersion !== undefined) return hostGlibcVersion;
  try {
    const output = execFileSync("ldd", ["--version"], { encoding: "utf8" });
    hostGlibcVersion = output.match(/(\d+\.\d+)/)?.[1] ?? null;
  } catch {
    hostGlibcVersion = null;
  }
  return hostGlibcVersion;
}
