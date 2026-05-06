import { mapReadMode } from "./gpuConstants.js";
import { isMockGPUBuffer } from "./mockGpu.js";

export class Readback {
  constructor(private readonly device: GPUDevice) {}

  async read(source: GPUBuffer, byteLength: number, offset: number): Promise<ArrayBuffer> {
    if (isMockGPUBuffer(source)) {
      return source.__vgpuMockBytes.slice(offset, offset + byteLength).buffer;
    }

    const staging = this.device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, offset, staging, 0, byteLength);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(mapReadMode());
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return copy;
  }

  destroy(): void {}
}
