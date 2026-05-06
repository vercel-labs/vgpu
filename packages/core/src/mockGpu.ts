import { bufferUsageFlags } from "./gpuConstants.js";

export interface MockGPUBuffer extends GPUBuffer {
  readonly __vgpuMockBytes: Uint8Array;
}

export function isMockGPUBuffer(buffer: GPUBuffer): buffer is MockGPUBuffer {
  return "__vgpuMockBytes" in buffer;
}

export function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer(desc: GPUBufferDescriptor): MockGPUBuffer {
      const bytes = new Uint8Array(Number(desc.size));
      return {
        __vgpuMockBytes: bytes,
        label: desc.label ?? "",
        size: desc.size,
        usage: desc.usage,
        mapState: "unmapped",
        destroy() {},
        getMappedRange: () => bytes.buffer,
        mapAsync: async () => undefined,
        unmap() {},
      } as unknown as MockGPUBuffer;
    },
    createCommandEncoder() {
      return { copyBufferToBuffer() {}, finish: () => ({}) } as unknown as GPUCommandEncoder;
    },
    destroy() {},
    queue: {
      submit() {},
      writeBuffer(buffer: GPUBuffer, offset: number, data: BufferSource) {
        if (!isMockGPUBuffer(buffer)) return;
        buffer.__vgpuMockBytes.set(bytesFrom(data), offset);
      },
      onSubmittedWorkDone: async () => undefined,
    },
  } as unknown as GPUDevice;
}

export function mockBufferDescriptor(size: number): GPUBufferDescriptor {
  return { size, usage: bufferUsageFlags(["copy_src", "copy_dst"]) };
}

function bytesFrom(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
