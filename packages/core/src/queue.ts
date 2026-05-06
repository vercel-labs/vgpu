import type { BufferWriteData } from "./types.js";

export class Queue {
  constructor(readonly gpu: GPUQueue) {}

  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferWriteData): void {
    this.gpu.writeBuffer(buffer, offset, data);
  }

  async flush(): Promise<void> {
    await this.gpu.onSubmittedWorkDone?.();
  }
}
