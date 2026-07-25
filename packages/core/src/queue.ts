import type { BufferWriteData } from "./types.ts";

export class Queue {
  private readonly guard: (where: string) => void;
  constructor(gpu: GPUQueue);
  constructor(readonly gpu: GPUQueue, guard: (where: string) => void = () => undefined) { this.guard = guard; }

  writeBuffer(buffer: GPUBuffer, offset: number, data: BufferWriteData): void {
    this.guard("Queue.writeBuffer");
    this.gpu.writeBuffer(buffer, offset, data);
  }

  async flush(): Promise<void> {
    this.guard("Queue.flush");
    await this.gpu.onSubmittedWorkDone?.();
    this.guard("Queue.flush");
  }
}
