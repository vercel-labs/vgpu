import { bufferUsageFlags } from "./gpu-constants.ts";
import { isMockGPUBuffer, type MockGPUBuffer, type MockGPUTexture } from "./mock-gpu-storage.ts";

export interface MockGPUDeviceInstrumentation {
  readonly calls: {
    createBuffer: number;
    createBindGroup: number;
    createCommandEncoder: number;
    createRenderBundleEncoder: number;
    createShaderModule: number;
    createRenderPipeline: number;
    createRenderPipelineAsync: number;
    createComputePipeline: number;
  };
  readonly createBufferDescriptors: GPUBufferDescriptor[];
  readonly createBindGroupDescriptors: GPUBindGroupDescriptor[];
  readonly createCommandEncoderDescriptors: GPUCommandEncoderDescriptor[];
  readonly createRenderBundleEncoderDescriptors: GPURenderBundleEncoderDescriptor[];
  readonly createRenderPipelineDescriptors: GPURenderPipelineDescriptor[];
  readonly createRenderPipelineAsyncDescriptors: GPURenderPipelineDescriptor[];
  readonly createComputePipelineDescriptors: GPUComputePipelineDescriptor[];
}

const mockInstrumentationKey = "__vgpuMockInstrumentation";

type InstrumentedGPUDevice = GPUDevice & { [mockInstrumentationKey]?: MockGPUDeviceInstrumentation };

export function createMockGPUDevice(): GPUDevice {
  const instrumentation = createMockGPUDeviceInstrumentation();
  const device: InstrumentedGPUDevice = {
    [mockInstrumentationKey]: instrumentation,
    limits: createMockSupportedLimits(),
    features: createMockSupportedFeatures(),
    createBuffer(desc: GPUBufferDescriptor): MockGPUBuffer {
      instrumentation.calls.createBuffer += 1;
      instrumentation.createBufferDescriptors.push(desc);
      return createMockBuffer(desc);
    },
    createTexture(desc: GPUTextureDescriptor): MockGPUTexture {
      const size = textureSize(desc.size);
      const bytes = new Uint8Array(size.width * size.height * 4);
      return {
        __vgpuMockBytes: bytes,
        label: desc.label ?? "",
        width: size.width,
        height: size.height,
        depthOrArrayLayers: size.depthOrArrayLayers,
        mipLevelCount: desc.mipLevelCount ?? 1,
        sampleCount: desc.sampleCount ?? 1,
        dimension: desc.dimension ?? "2d",
        format: desc.format,
        usage: desc.usage,
        createView: () => ({}) as GPUTextureView,
        destroy() {},
      // Mock WebGPU texture: only fields touched by core/render tests are implemented.
      } as unknown as MockGPUTexture;
    },
    createShaderModule(): GPUShaderModule {
      instrumentation.calls.createShaderModule += 1;
      return {} as GPUShaderModule;
    },
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createBindGroup(desc: GPUBindGroupDescriptor): GPUBindGroup {
      instrumentation.calls.createBindGroup += 1;
      instrumentation.createBindGroupDescriptors.push(desc);
      return {} as GPUBindGroup;
    },
    createSampler: () => ({}) as GPUSampler,
    createRenderPipeline(desc: GPURenderPipelineDescriptor): GPURenderPipeline {
      instrumentation.calls.createRenderPipeline += 1;
      instrumentation.createRenderPipelineDescriptors.push(desc);
      return {} as GPURenderPipeline;
    },
    async createRenderPipelineAsync(desc: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
      instrumentation.calls.createRenderPipelineAsync += 1;
      instrumentation.createRenderPipelineAsyncDescriptors.push(desc);
      return {} as GPURenderPipeline;
    },
    createComputePipeline(desc: GPUComputePipelineDescriptor): GPUComputePipeline {
      instrumentation.calls.createComputePipeline += 1;
      instrumentation.createComputePipelineDescriptors.push(desc);
      return {
        label: desc.label ?? "",
        getBindGroupLayout: (_groupIndex: number) => ({}) as GPUBindGroupLayout,
      } as unknown as GPUComputePipeline;
    },
    createRenderBundleEncoder(desc: GPURenderBundleEncoderDescriptor): GPURenderBundleEncoder {
      instrumentation.calls.createRenderBundleEncoder += 1;
      instrumentation.createRenderBundleEncoderDescriptors.push(desc);
      return {
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        setIndexBuffer() {},
        draw() {},
        drawIndexed() {},
        finish: () => ({} as GPURenderBundle),
      // Mock render bundle encoder: only state/draw/finish methods used by render tests are implemented.
      } as unknown as GPURenderBundleEncoder;
    },
    createCommandEncoder(desc: GPUCommandEncoderDescriptor = {}): GPUCommandEncoder {
      instrumentation.calls.createCommandEncoder += 1;
      instrumentation.createCommandEncoderDescriptors.push(desc);
      return {
        copyBufferToBuffer() {},
        copyTextureToBuffer() {},
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }) as unknown as GPUComputePassEncoder,
        // Mock render pass encoder: only binding/pipeline/draw/bundle/end methods used by tests are implemented.
        beginRenderPass: () => ({ setBindGroup() {}, setVertexBuffer() {}, setPipeline() {}, executeBundles() {}, draw() {}, end() {} }) as unknown as GPURenderPassEncoder,
        finish: () => ({}),
      // Mock command encoder: only copy/render/finish methods used by core/render are implemented.
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
  } as unknown as InstrumentedGPUDevice;
  return device;
}

export function getMockGPUDeviceInstrumentation(device: GPUDevice): MockGPUDeviceInstrumentation {
  const instrumentation = (device as InstrumentedGPUDevice)[mockInstrumentationKey];
  if (!instrumentation) {
    throw new Error("GPUDevice was not created by createMockGPUDevice()");
  }
  return instrumentation;
}

export function mockBufferDescriptor(size: number): GPUBufferDescriptor {
  return { size, usage: bufferUsageFlags(["copy_src", "copy_dst"]) };
}

function createMockGPUDeviceInstrumentation(): MockGPUDeviceInstrumentation {
  return {
    calls: {
      createBuffer: 0,
      createBindGroup: 0,
      createCommandEncoder: 0,
      createRenderBundleEncoder: 0,
      createShaderModule: 0,
      createRenderPipeline: 0,
      createRenderPipelineAsync: 0,
      createComputePipeline: 0,
    },
    createBufferDescriptors: [],
    createBindGroupDescriptors: [],
    createCommandEncoderDescriptors: [],
    createRenderBundleEncoderDescriptors: [],
    createRenderPipelineDescriptors: [],
    createRenderPipelineAsyncDescriptors: [],
    createComputePipelineDescriptors: [],
  };
}

function createMockSupportedLimits(): GPUSupportedLimits {
  return {
    maxTextureDimension1D: 8192,
    maxTextureDimension2D: 8192,
    maxTextureDimension3D: 2048,
    maxTextureArrayLayers: 256,
    maxBindGroups: 4,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 4,
    maxSampledTexturesPerShaderStage: 16,
    maxSamplersPerShaderStage: 16,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageTexturesPerShaderStage: 4,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 134217728,
    minUniformBufferOffsetAlignment: 256,
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 268435456,
    maxVertexAttributes: 16,
    maxVertexBufferArrayStride: 2048,
    maxInterStageShaderComponents: 60,
    maxInterStageShaderVariables: 16,
    maxColorAttachments: 8,
    maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 16384,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxComputeWorkgroupSizeY: 256,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65535,
  } as unknown as GPUSupportedLimits;
}

function createMockSupportedFeatures(): GPUSupportedFeatures {
  return new Set<GPUFeatureName>() as unknown as GPUSupportedFeatures;
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
