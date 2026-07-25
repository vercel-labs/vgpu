import type { Buffer, Device } from "@vgpu/core";

export function assertDeviceUsable(device: Device, where: string): void {
  (device as unknown as { assertUsable(where: string): void }).assertUsable(where);
}

export function assertBufferUsable(buffer: Buffer, where: string): void {
  (buffer as unknown as { assertUsable(where: string): void }).assertUsable(where);
}
