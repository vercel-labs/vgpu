import type { Buffer, Device } from "@vgpu/core";

export function assertDeviceUsable(device: Device, where: string): void {
  (device as unknown as { assertUsable(where: string): void }).assertUsable(where);
}

/**
 * Non-throwing counterpart of `assertDeviceUsable`, for implicit paths that must not raise over a
 * caller's own intent (see the auto-submit in `FrameRunner.frame`). Device state is private, so the
 * only supported query is the assertion itself.
 */
export function isDeviceUsable(device: Device): boolean {
  try {
    assertDeviceUsable(device, "Device");
    return true;
  } catch {
    return false;
  }
}

export function assertBufferUsable(buffer: Buffer, where: string): void {
  (buffer as unknown as { assertUsable(where: string): void }).assertUsable(where);
}
