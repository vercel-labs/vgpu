import type { HalfEdgeKernel } from "./half-edge-kernel.ts";
import type { KernelHandle } from "./types.ts";

export function wrapKernel(kernel: HalfEdgeKernel): KernelHandle {
  return kernel as unknown as KernelHandle;
}

export function unwrapKernel(handle: KernelHandle): HalfEdgeKernel {
  return handle as unknown as HalfEdgeKernel;
}
