import { wgslErrorWithFix } from "./errors.ts";

/**
 * Memoized for the process lifetime: `resolveShader` calls this up to twice per invocation (once
 * before minification, once after safe identifier renaming) and relies on a single shared outcome
 * so a device-less environment warns/throws exactly once. Never destroyed — this mirrors
 * `@vgpu/adapter-node`'s own process-lifetime Dawn singleton, whose re-initialization SIGSEGVs.
 */
let devicePromise: Promise<GPUDevice> | undefined;

/** The slice of `@vgpu/adapter-node` this module uses. */
type AdapterNodeModule = {
  createNodeAdapter(): { requestDevice(): Promise<{ readonly gpu: GPUDevice }> };
};
type AdapterNodeError = { code?: string; fix?: string; message?: string; detail?: { nativeStderr?: string } };

export function acquireValidationDevice(): Promise<GPUDevice> {
  devicePromise ??= acquire();
  return devicePromise;
}

async function acquire(): Promise<GPUDevice> {
  let adapterNode: AdapterNodeModule;
  try {
    // `@vgpu/adapter-node` is an *optional* peer dependency, imported lazily and through an
    // indirect specifier on purpose: a static import would form a `wgsl -> adapter-node -> core ->
    // wgsl` cycle that `tsc -b` rejects, and would pull a native dependency into every bundle that
    // touches `resolveShader`. Never hoist this to module scope.
    const specifier = "@vgpu/adapter-node";
    adapterNode = (await import(specifier)) as AdapterNodeModule;
  } catch (cause) {
    throw wgslErrorWithFix(
      "VGPU-WGSL-VALIDATE-ADAPTER-MISSING",
      "WGSL validation needs @vgpu/adapter-node to acquire a WebGPU device, but it could not be imported.",
      {
        fix: 'Install @vgpu/adapter-node (pnpm add -D @vgpu/adapter-node), or pass validate: "off" (or set VGPU_VALIDATE=off) to skip device-backed validation.',
        cause,
        where: "resolveShader",
      },
    );
  }
  try {
    const device = await adapterNode.createNodeAdapter().requestDevice();
    return device.gpu;
  } catch (cause) {
    const adapterError = cause as AdapterNodeError | undefined;
    const nativeStderr = adapterError?.detail?.nativeStderr;
    throw wgslErrorWithFix(
      "VGPU-WGSL-VALIDATE-NO-DEVICE",
      `device acquisition failed via @vgpu/adapter-node${adapterError?.code ? ` (${adapterError.code})` : ""}: ${adapterError?.message ?? String(cause)}`,
      {
        // Forwarded verbatim: @vgpu/adapter-node owns the remediation text for device failures, and
        // re-wording it here would let the two drift apart.
        fix: adapterError?.fix ?? "Run `npx vgpu doctor` to diagnose the local WebGPU/Dawn setup.",
        cause,
        where: "resolveShader",
        metadata: {
          ...(adapterError?.code ? { causeCode: adapterError.code } : {}),
          ...(nativeStderr ? { nativeStderr: `[dawn/vulkan] ${nativeStderr}` } : {}),
        },
      },
    );
  }
}

/**
 * @internal test-only — drops the memoized device so each test gets a fresh acquisition attempt.
 * Not reachable from any published entry point (`./runtime` only exports `resolve-shader.js`).
 */
export function __resetValidationDeviceForTests(): void {
  devicePromise = undefined;
}
