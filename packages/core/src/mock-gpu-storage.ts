export interface MockGPUBuffer extends GPUBuffer {
  readonly __vgpuMockBytes: Uint8Array;
}

export interface MockGPUTexture extends GPUTexture {
  readonly __vgpuMockBytes: Uint8Array;
}

export function isMockGPUBuffer(buffer: GPUBuffer): buffer is MockGPUBuffer {
  return "__vgpuMockBytes" in buffer;
}

export function isMockGPUTexture(texture: GPUTexture): texture is MockGPUTexture {
  return "__vgpuMockBytes" in texture;
}
