import type { Device, Texture } from "@vgpu/core";
import type { Pipeline } from "./pipeline.ts";

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
  readonly gpu: GPURenderPassEncoder;
  private readonly encoder: GPUCommandEncoder;
  private ended = false;

  constructor(private readonly device: Device, opts: RenderPassOptions) {
    this.encoder = device.gpu.createCommandEncoder({ label: opts.label });
    this.gpu = this.encoder.beginRenderPass({
      label: opts.label,
      colorAttachments: opts.colorAttachments.map(colorAttachment),
    });
  }

  setPipeline(pipeline: Pipeline): void {
    this.gpu.setPipeline(pipeline.gpu);
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    this.gpu.draw(vertexCount, instanceCount, firstVertex, firstInstance);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.gpu.end();
    this.device.gpu.queue.submit([this.encoder.finish()]);
  }

  dispose(): void {
    this.end();
  }
}

function colorAttachment(attachment: ColorAttachment): GPURenderPassColorAttachment {
  return {
    view: isTexture(attachment.view) ? attachment.view.createView() : attachment.view,
    loadOp: attachment.loadOp,
    storeOp: attachment.storeOp,
    clearValue: attachment.clearValue,
  };
}

function isTexture(view: Texture | GPUTextureView): view is Texture {
  return "createView" in view && "gpu" in view;
}
