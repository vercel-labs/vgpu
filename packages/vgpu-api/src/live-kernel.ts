/**
 * Entry guard shared by the gpu-first factories.
 *
 * Every free function starts the same way: resolve the private kernel of the `Gpu` it was handed
 * and refuse to build anything on a disposed one — after `gpu.dispose()` the device and every
 * resource it owned are gone, so a factory would hand back a handle that can only fail later,
 * usually inside a driver call with no useful stack.
 *
 * It lives in its own module (instead of `kernel.ts`) so the kernel keeps zero knowledge of the
 * feature families, and so the guard costs one tiny function in any bundle that uses a factory.
 */
import { VGPUError } from "./errors.ts";
import { kernelOf, type Gpu, type Kernel, type Release } from "./kernel.ts";
import type { QueryHostOptions } from "./query-ring.ts";

/**
 * Kernel of `gpu`, or a thrown error when the gpu is disposed (`VGPU-GPU-DISPOSED`) or was not
 * created by `init()` (`VGPU-GPU-FOREIGN`, from `kernelOf`).
 *
 * @internal
 */
export function liveKernel(gpu: Gpu, where: string): Kernel {
  const kernel = kernelOf(gpu);
  if (kernel.disposed) throw gpuDisposedError(where);
  return kernel;
}

/** @internal */
export function gpuDisposedError(where: string): VGPUError {
  return new VGPUError({
    code: "VGPU-GPU-DISPOSED",
    message: `${where}() ran after gpu.dispose(); the device and everything it owned are gone.`,
    fix: "Create resources before disposing the gpu, or init() a new one.",
    where,
  });
}

/** Anything the kernel can tear down in the `resource` phase and that reports its own disposal back. */
interface DisposableFeature {
  dispose(): void;
}

/**
 * Builds a query-backed feature (`timer()`, `visibility()`) wired to the kernel: readbacks join
 * `gpu.settled()`, dropped readbacks reach `gpu.onError`, and the feature goes down with the gpu in
 * the `resource` phase — before caches and the device, after the schedulers stopped.
 *
 * The registration is released when the feature disposes itself, so a long-lived gpu that creates
 * and disposes timers per scene does not accumulate dead disposers.
 *
 * @internal
 */
export function ownQueryFeature<T extends DisposableFeature>(kernel: Kernel, create: (host: QueryHostOptions) => T): T {
  let release: Release = () => undefined;
  const feature = create({
    trackSettled: (promise) => { void kernel.trackDelivery(promise); },
    errorSink: (error) => kernel.reportError(error),
    onDispose: () => { release(); },
  });
  release = kernel.own("resource", () => feature.dispose());
  return feature;
}

/**
 * Registers a resource whose lifetime ends with the gpu, returning it. `destroy` runs in the
 * `resource` phase; `onDestroyed` (when the resource can be destroyed by hand) drops the
 * registration so manual destruction does not leave a dead disposer behind.
 *
 * @internal
 */
export function ownResource<T>(kernel: Kernel, resource: T, destroy: (resource: T) => void, onDestroyed?: (cb: () => void) => void): T {
  const release = kernel.own("resource", () => destroy(resource));
  onDestroyed?.(release);
  return resource;
}
