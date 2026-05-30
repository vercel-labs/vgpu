import { Buffer, VGPUError, type Device, type Texture } from "@vgpu/core";

const textureBrand = Symbol.for("vgpu/Texture");

export interface RenderPassOptions {
  readonly colorAttachments: readonly ColorAttachment[];
  readonly depthStencilAttachment?: DepthStencilAttachment;
  readonly label?: string;
}

export interface ColorAttachment {
  readonly view: Texture | GPUTextureView;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly clearValue?: GPUColor;
}

export interface DepthStencilAttachment {
  readonly view: Texture | GPUTextureView;
  readonly depthClearValue?: number;
  readonly depthLoadOp?: GPULoadOp;
  readonly depthStoreOp?: GPUStoreOp;
  readonly depthReadOnly?: boolean;
  readonly stencilClearValue?: GPUStencilValue;
  readonly stencilLoadOp?: GPULoadOp;
  readonly stencilStoreOp?: GPUStoreOp;
  readonly stencilReadOnly?: boolean;
}

export interface RenderPassDrawOptions {
  readonly vertexCount: number;
  readonly instanceCount?: number;
  readonly firstVertex?: number;
  readonly firstInstance?: number;
}

export type RenderPassDynamicOffsets = readonly GPUBufferDynamicOffset[] | Uint32Array;

interface RenderPassEncoderSource {
  readonly encoder: GPUCommandEncoder;
  readonly submitOnEnd: boolean;
}

const renderPassEncoderSources = new WeakMap<RenderPassOptions, RenderPassEncoderSource>();

export class RenderPass {
  private readonly encoder: GPUCommandEncoder;
  private readonly submitOnEnd: boolean;
  private passEncoder: GPURenderPassEncoder | null;

  constructor(private readonly device: Device, opts: RenderPassOptions) {
    const source = renderPassEncoderSources.get(opts);
    renderPassEncoderSources.delete(opts);
    this.encoder = source?.encoder ?? device.gpu.createCommandEncoder({ label: opts.label });
    this.submitOnEnd = source?.submitOnEnd ?? true;
    this.passEncoder = this.encoder.beginRenderPass(renderPassDescriptor(opts));
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

  executeBundles(bundles: Iterable<GPURenderBundle>): void {
    this.gpu.executeBundles(bundles);
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
    if (this.submitOnEnd) this.device.queue.gpu.submit([this.encoder.finish()]);
  }

  dispose(): void {
    this.end();
  }
}

export function createRenderPassOnEncoder(device: Device, opts: RenderPassOptions, encoder: GPUCommandEncoder): RenderPass {
  renderPassEncoderSources.set(opts, { encoder, submitOnEnd: false });
  return new RenderPass(device, opts);
}

function renderPassDescriptor(opts: RenderPassOptions): GPURenderPassDescriptor {
  return {
    label: opts.label,
    colorAttachments: opts.colorAttachments.map(colorAttachment),
    depthStencilAttachment: opts.depthStencilAttachment ? depthStencilAttachment(opts.depthStencilAttachment) : undefined,
  };
}

function colorAttachment(attachment: ColorAttachment): GPURenderPassColorAttachment {
  return {
    view: textureView(attachment.view),
    loadOp: attachment.loadOp,
    storeOp: attachment.storeOp,
    clearValue: attachment.clearValue,
  };
}

function depthStencilAttachment(attachment: DepthStencilAttachment): GPURenderPassDepthStencilAttachment {
  return {
    view: textureView(attachment.view),
    depthClearValue: attachment.depthClearValue,
    depthLoadOp: attachment.depthLoadOp,
    depthStoreOp: attachment.depthStoreOp,
    depthReadOnly: attachment.depthReadOnly,
    stencilClearValue: attachment.stencilClearValue,
    stencilLoadOp: attachment.stencilLoadOp,
    stencilStoreOp: attachment.stencilStoreOp,
    stencilReadOnly: attachment.stencilReadOnly,
  };
}

function textureView(view: Texture | GPUTextureView): GPUTextureView {
  return isVGPUTexture(view) ? view.createView() : view;
}

function gpuBuffer(buffer: Buffer | GPUBuffer | null): GPUBuffer | null {
  return buffer instanceof Buffer ? buffer.gpu : buffer;
}

function isVGPUTexture(view: Texture | GPUTextureView): view is Texture {
  return Boolean((view as { readonly [textureBrand]?: true })[textureBrand]);
}
