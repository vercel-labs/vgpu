import { bufferUsageFlags } from "./gpuConstants.ts";
import { isMockGPUBuffer, type MockGPUBuffer, type MockGPUTexture } from "./mock-gpu-storage.ts";

export function createMockGPUDevice(): GPUDevice {
  return {
    createBuffer: createMockBuffer,
    createTexture(desc: GPUTextureDescriptor): MockGPUTexture {
      const size = textureSize(desc.size);
      const bytes = new Uint8Array(size.width * size.height * 4);
      return {
        __vgpuMockBytes: bytes,
        label: desc.label ?? "",
        width: size.width,
        height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers,
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: "2d",
        format: desc.format,
        usage: desc.usage,
        createView: () => ({}) as GPUTextureView,
        destroy() {},
      // Mock WebGPU texture: only fields touched by core/render tests are implemented.
      } as unknown as MockGPUTexture;
    },
    createShaderModule: () => ({}) as GPUShaderModule,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createBindGroup: () => ({}) as GPUBindGroup,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createCommandEncoder() {
      return {
        copyBufferToBuffer() {},
        copyTextureToBuffer() {},
        // Mock render pass encoder: only pipeline/draw/end are exercised by these tests.
        beginRenderPass: () => ({ setPipeline() {}, draw() {}, end() {} }) as unknown as GPURenderPassEncoder,
        finish: () => ({}),
      // Mock command encoder: only copy/render/finish methods used by core are implemented.
      } as unknown as GPUCommandEncoder;
    },
    destroy() {},
    queue: {
      submit() {},
      writeBuffer(buffer: GPUBuffer, offset: number, data: BufferSource, dataOffset = 0, size?: number) {
        if (isMockGPUBuffer(buffer)) buffer.__vgpuMockBytes.set(bytesFrom(data).subarray(dataOffset, size ? dataOffset + size : undefined), offset);
      },
      onSubmittedWorkDone: async () => undefined,
    },
  // Mock device: shape is intentionally partial but covers every member used by adapters/tests.
  } as unknown as GPUDevice;
}

export function mockBufferDescriptor(size: number): GPUBufferDescriptor {
  return { size, usage: bufferUsageFlags(["copy_src", "copy_dst"]) };
}

function createMockBuffer(desc: GPUBufferDescriptor): MockGPUBuffer {
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
  // Mock WebGPU buffer: byte storage plus map/destroy methods are enough for read/write tests.
  } as unknown as MockGPUBuffer;
}

function textureSize(size: GPUExtent3DStrict): Required<GPUExtent3DDict> {
  if (Array.isArray(size)) return { width: size[0], height: size[1] ?? 1, depthOrArrayLayers: size[2] ?? 1 };
  const dict = size as GPUExtent3DDict;
  return { width: dict.width, height: dict.height ?? 1, depthOrArrayLayers: dict.depthOrArrayLayers ?? 1 };
}

function bytesFrom(data: BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
