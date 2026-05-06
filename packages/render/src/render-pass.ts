import { VGPUError, type Device, type Texture } from "@vgpu/core";
import type { Pipeline } from "./pipeline.ts";

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

  setPipeline(pipeline: Pipeline): void {
    this.gpu.setPipeline(pipeline.gpu);
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.gpu.draw(vertexCount, instanceCount, firstVertex, firstInstance);
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

function isVGPUTexture(view: Texture | GPUTextureView): view is Texture {
  return Boolean((view as { readonly [textureBrand]?: true })[textureBrand]);
}
