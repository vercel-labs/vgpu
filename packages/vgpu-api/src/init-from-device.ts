/**
 * Adoption of a `GPUDevice` vgpu did not create.
 *
 * Deliberately its own module, and its own entry point rather than an `init()` option: the
 * validation below only makes sense for a device someone else built, and keeping it here means a
 * program that lets vgpu create its own device never bundles it. See the `init-only` budget in
 * package.json, which exists to keep that promise honest.
 */
import { Device } from "@vgpu/core";
import { attachKernel, type Gpu } from "./kernel.ts";
import { assertDeviceUsable } from "./lifecycle.ts";
import { VGPUError } from "./errors.ts";

/**
 * Wraps a device owned by another library (WebLLM, transformers.js, a host engine) so vgpu can
 * render from the same queue without copying through the CPU.
 *
 * vgpu never destroys what it did not create: `gpu.dispose()` drops this wrapper and leaves the
 * native device to its owner. Because that owner can destroy or lose it at any time, every entry
 * point re-checks the device instead of trusting the handle it was given.
 */
export async function initFromDevice(device: GPUDevice): Promise<Gpu> {
  if (!isGPUDeviceShape(device)) throw initError("VGPU-INIT-DEVICE-INVALID", "Invalid external GPUDevice shape.");
  const wrapped = new (Device as unknown as new (gpu: GPUDevice, adapterInfo: null, ownership: "external") => Device)(device, null, "external");
  // Yield once before reporting success: `Device` subscribes to `device.lost` in its constructor
  // and flips state from that microtask, so a device the owner already killed is only visible
  // here. Without this, adopting a dead device would hand back a Gpu that fails on first use.
  await Promise.resolve();
  try {
    assertDeviceUsable(wrapped, "initFromDevice");
    return attachKernel(wrapped);
  } catch (error) {
    // A device that is already gone must not leave a half-built Gpu behind. Disposing a borrowed
    // device only drops our wrapper: Device.dispose() never destroys what it does not own.
    wrapped.dispose();
    throw error;
  }
}

/** Structural, not `instanceof`: the device may come from another realm (worker, iframe, test double). */
function isGPUDeviceShape(value: unknown): value is GPUDevice {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    const d = value as Partial<GPUDevice>;
    return (typeof d.queue === "object" || typeof d.queue === "function") && d.queue !== null
      && typeof d.createBuffer === "function" && typeof d.createCommandEncoder === "function"
      && !!d.lost && typeof (d.lost as PromiseLike<GPUDeviceLostInfo>).then === "function";
  } catch { return false; }
}

/** Local, not shared with kernel.ts: adoption is now the only init path that can fail this way. */
function initError(code: string, message: string): VGPUError { return new VGPUError({ code, message, where: "initFromDevice" }); }
