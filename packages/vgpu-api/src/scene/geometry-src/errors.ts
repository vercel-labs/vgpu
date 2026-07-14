import { VGPUError } from "@vgpu/core";

export function invalidUsage(where: string, message: string): VGPUError {
  return new VGPUError({ code: "VGPU-CORE-INVALID-USAGE", message, where });
}
