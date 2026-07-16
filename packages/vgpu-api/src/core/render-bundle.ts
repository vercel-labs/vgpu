import { Buffer } from "@vgpu/core";

export interface RenderPassDrawOptions {
  readonly vertexCount: number;
  readonly instanceCount?: number;
  readonly firstVertex?: number;
  readonly firstInstance?: number;
}

export type RenderPassDynamicOffsets = readonly GPUBufferDynamicOffset[] | Uint32Array;

export interface RenderBundleOptions {
  readonly label?: string;
  readonly colorFormats: readonly (GPUTextureFormat | null)[];
  readonly depthStencilFormat?: GPUTextureFormat;
  readonly sampleCount?: number;
  readonly depthReadOnly?: boolean;
  readonly stencilReadOnly?: boolean;
  readonly record: (bundle: RenderBundleRecorder) => void;
}

export class RenderBundleRecorder {
  constructor(readonly gpu: GPURenderBundleEncoder) {}

  setPipeline(pipeline: GPURenderPipeline): void {
    this.gpu.setPipeline(pipeline);
  }

  setBindGroup(index: number, group: GPUBindGroup | null, dynamicOffsets?: RenderPassDynamicOffsets): void {
    this.gpu.setBindGroup(index, group, dynamicOffsets);
  }

  setVertexBuffer(slot: number, buffer: Buffer | GPUBuffer | null, offset = 0, size?: GPUSize64): void {
    this.gpu.setVertexBuffer(slot, gpuBuffer(buffer), offset, size);
  }

  draw(options: RenderPassDrawOptions): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  draw(optionsOrVertexCount: RenderPassDrawOptions | number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    if (typeof optionsOrVertexCount === "number") {
      this.gpu.draw(optionsOrVertexCount, instanceCount, firstVertex, firstInstance);
      return;
    }
    this.gpu.draw(
      optionsOrVertexCount.vertexCount,
      optionsOrVertexCount.instanceCount ?? 1,
      optionsOrVertexCount.firstVertex ?? 0,
      optionsOrVertexCount.firstInstance ?? 0,
    );
  }
}

export function createRenderBundle(device: { readonly gpu: GPUDevice }, opts: RenderBundleOptions): GPURenderBundle {
  const encoder = device.gpu.createRenderBundleEncoder({
    label: opts.label,
    colorFormats: opts.colorFormats,
    depthStencilFormat: opts.depthStencilFormat,
    sampleCount: opts.sampleCount,
    depthReadOnly: opts.depthReadOnly,
    stencilReadOnly: opts.stencilReadOnly,
  });
  opts.record(new RenderBundleRecorder(encoder));
  return encoder.finish({ label: opts.label });
}

function gpuBuffer(buffer: Buffer | GPUBuffer | null): GPUBuffer | null {
  return buffer instanceof Buffer ? buffer.gpu : buffer;
}
