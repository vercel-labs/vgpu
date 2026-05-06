import { Buffer, VGPUError, type Device, type Texture } from "@vgpu/core";

const textureBrand = Symbol.for("vgpu/Texture");

export interface RenderPassOptions {
  readonly colorAttachments: readonly ColorAttachment[];
  readonly label?: string;
}

export interface ColorAttachment {
  readonly view: Texture | GPUTextureView;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly clearValue?: readonly [number, number, number, number];
}

export interface RenderPassDrawOptions {
  readonly vertexCount: number;
  readonly instanceCount?: number;
  readonly firstVertex?: number;
  readonly firstInstance?: number;
}

export type RenderPassDynamicOffsets = readonly GPUBufferDynamicOffset[] | Uint32Array;

export class RenderPass {
  private readonly encoder: GPUCommandEncoder;
  private passEncoder: GPURenderPassEncoder | null;

  constructor(private readonly device: Device, opts: RenderPassOptions) {
    this.encoder = device.gpu.createCommandEncoder({ label: opts.label });
    this.passEncoder = this.encoder.beginRenderPass({
      label: opts.label,
      colorAttachments: opts.colorAttachments.map(colorAttachment),
    });
  }

  get gpu(): GPURenderPassEncoder {
    if (!this.passEncoder) {
      throw new VGPUError({
        code: "VGPU-RENDER-PASS-ENDED",
        message: "RenderPass.gpu cannot be accessed after end().",
        where: "RenderPass.gpu",
      });
    }
    return this.passEncoder;
  }

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

  end(): void {
    if (!this.passEncoder) return;
    const pass = this.passEncoder;
    this.passEncoder = null;
    pass.end();
    this.device.queue.gpu.submit([this.encoder.finish()]);
  }

  dispose(): void {
    this.end();
  }
}

function colorAttachment(attachment: ColorAttachment): GPURenderPassColorAttachment {
  return {
    view: isVGPUTexture(attachment.view) ? attachment.view.createView() : attachment.view,
    loadOp: attachment.loadOp,
    storeOp: attachment.storeOp,
    clearValue: attachment.clearValue,
  };
}

function gpuBuffer(buffer: Buffer | GPUBuffer | null): GPUBuffer | null {
  return buffer instanceof Buffer ? buffer.gpu : buffer;
}

function isVGPUTexture(view: Texture | GPUTextureView): view is Texture {
  return Boolean((view as { readonly [textureBrand]?: true })[textureBrand]);
}
