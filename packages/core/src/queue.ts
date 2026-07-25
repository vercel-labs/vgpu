import type { BufferWriteData } from "./types.ts";

export class Queue {
  constructor(readonly gpu: GPUQueue, private readonly assertUsable: (where: string) => void = () => undefined) {}

  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferWriteData): void {
    this.assertUsable("Queue.writeBuffer");
    this.gpu.writeBuffer(buffer, offset, data);
  }

  async flush(): Promise<void> {
    this.assertUsable("Queue.flush");
    await this.gpu.onSubmittedWorkDone?.();
    this.assertUsable("Queue.flush");
  }
}
