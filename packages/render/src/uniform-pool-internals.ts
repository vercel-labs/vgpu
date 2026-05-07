import { VGPUError, type Device } from "@vgpu/core";

export const defaultCapacityBytes = 4 * 1024 * 1024;
export const defaultMinOffsetAlignment = 256;
export const defaultMaxUniformBindingSize = 64 * 1024;
export const uniformUsage = 64;
export const copyDstUsage = 8;

export function roundUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

export function deviceLimit(device: Device, key: keyof GPUSupportedLimits, fallback: number): number {
  const limits = (device.gpu as GPUDevice & { readonly limits?: Partial<Record<keyof GPUSupportedLimits, number>> }).limits;
  return limits?.[key] ?? fallback;
}

export function viewBytes(view: ArrayBufferView<ArrayBuffer>): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function shaderVisibility(): GPUShaderStageFlags {
  const stage = globalThis.GPUShaderStage as Record<"VERTEX" | "FRAGMENT", number> | undefined;
  return ((stage?.VERTEX ?? 1) | (stage?.FRAGMENT ?? 2)) as GPUShaderStageFlags;
}

export function invalidUsage(where: string, message: string): VGPUError {
  return new VGPUError({ code: "VGPU-CORE-INVALID-USAGE", message, where });
}
