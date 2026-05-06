import { isMockGPUBuffer } from "./mockGpu.js";
import type { Device } from "./device.js";
import type { BufferOptions, BufferWriteData } from "./types.js";

export class Buffer {
  private destroyed = false;

  constructor(
    private readonly device: Device,
    readonly gpu: GPUBuffer,
    readonly options: BufferOptions,
  ) {}

  write(data: BufferWriteData, offset = 0): void {
    this.assertAlive();
    this.device.queue.writeBuffer(this.gpu, offset, data);
  }

  async read(byteLength: number, offset = 0): Promise<ArrayBuffer> {
    this.assertAlive();
    return this.device.readback.read(this.gpu, byteLength, offset);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!isMockGPUBuffer(this.gpu)) this.gpu.destroy();
  }

  dispose(): void {
    this.destroy();
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("Buffer is destroyed");
  }
}
