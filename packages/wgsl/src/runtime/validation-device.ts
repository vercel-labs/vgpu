import { wgslErrorWithFix } from "./errors.ts";

/**
 * Memoized across validations: `resolveShader` calls this up to twice per invocation (once before
 * minification, once after safe identifier renaming), and consecutive `resolveShader` calls in a
 * build script share one device instead of paying adapter discovery each time. A device-less
 * environment therefore warns/throws exactly once.
 *
 * The device is destroyed once no validation has needed it for `idleReleaseDelayMs`, because a live
 * Dawn device keeps ref'd handles on the Node event loop: without this, any script that resolved a
 * shader with validation on would never exit on its own. Re-acquiring afterwards is safe (Dawn's
 * *instance* is adapter-node's process-lifetime singleton and is not re-created; only the device
 * is), and a failed acquisition is kept memoized so the failure is attempted and reported once.
 */
let devicePromise: Promise<GPUDevice> | undefined;
let leases = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const idleReleaseDelayMs = 250;

/** The slice of `@vgpu/adapter-node` this module uses. */
type AdapterNodeModule = {
  createNodeAdapter(): { requestDevice(): Promise<{ readonly gpu: GPUDevice }> };
};
type AdapterNodeError = { code?: string; fix?: string; message?: string; detail?: { nativeStderr?: string } };

/**
 * Takes a lease on the shared validation device. Every call must be paired with
 * `releaseValidationDevice()` — including when this rejects.
 */
export function acquireValidationDevice(): Promise<GPUDevice> {
  retainValidationDevice();
  devicePromise ??= acquire();
  return devicePromise;
}

/**
 * Takes a lease *without* acquiring, so a caller that validates more than once (`resolveShader`
 * validates before and after safe identifier minification) keeps one device across the whole call
 * instead of letting the idle release destroy it in between. Pair with `releaseValidationDevice()`.
 */
export function retainValidationDevice(): void {
  leases++;
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

/** Drops a lease, scheduling the idle destroy once nothing holds the device. */
export function releaseValidationDevice(): void {
  leases = Math.max(0, leases - 1);
  if (leases > 0 || idleTimer !== undefined || devicePromise === undefined) return;
  // Unref'd: this timer must never be the reason a process stays alive. It still fires while the
  // live Dawn device keeps the loop busy, which is precisely when it has work to do.
  idleTimer = setTimeout(destroyIdleDevice, idleReleaseDelayMs);
  idleTimer.unref?.();
}

function destroyIdleDevice(): void {
  idleTimer = undefined;
  const pending = devicePromise;
  if (leases > 0 || pending === undefined) return;
  void pending.then(
    (device) => {
      // Re-check: a validation may have taken a lease while the promise settled.
      if (leases > 0 || devicePromise !== pending) return;
      devicePromise = undefined;
      device.destroy();
    },
    // A failed acquisition stays memoized: one attempt and one warning per process.
    () => undefined,
  );
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
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = undefined;
  leases = 0;
  devicePromise = undefined;
}
