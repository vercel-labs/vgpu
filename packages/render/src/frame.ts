import { Buffer, VGPUError, type Device } from "@vgpu/core";
import { createRenderPassOnEncoder, type RenderPass, type RenderPassOptions } from "./render-pass.ts";

export interface FrameOptions {
  readonly label?: string;
}

export type FrameRenderPassCallback = (pass: RenderPass) => void;

export class Frame {
  readonly gpu: GPUCommandEncoder;
  private submitted = false;

  constructor(private readonly device: Device, opts: FrameOptions = {}) {
    this.gpu = device.gpu.createCommandEncoder({ label: opts.label });
  }

  renderPass(opts: RenderPassOptions, record: FrameRenderPassCallback): void {
    this.assertOpen("Frame.renderPass");
    const pass = createRenderPassOnEncoder(this.device, opts, this.gpu);
    try {
      record(pass);
    } finally {
      pass.end();
    }
  }

  copyBufferToBuffer(source: Buffer | GPUBuffer, destination: Buffer | GPUBuffer, size: GPUSize64, sourceOffset = 0, destinationOffset = 0): void {
    this.assertOpen("Frame.copyBufferToBuffer");
    this.gpu.copyBufferToBuffer(gpuBuffer(source), sourceOffset, gpuBuffer(destination), destinationOffset, size);
  }

  submit(): void {
    this.assertOpen("Frame.submit");
    this.submitted = true;
    this.device.queue.gpu.submit([this.gpu.finish()]);
  }

  dispose(): void {
    if (!this.submitted) this.submit();
  }

  private assertOpen(where: string): void {
    if (!this.submitted) return;
    throw new VGPUError({
      code: "VGPU-FRAME-SUBMITTED",
      message: "Frame cannot encode or submit after submit().",
      where,
    });
  }
}

export function beginFrame(device: Device, opts: FrameOptions = {}): Frame {
  return new Frame(device, opts);
}

function gpuBuffer(buffer: Buffer | GPUBuffer): GPUBuffer {
  return buffer instanceof Buffer ? buffer.gpu : buffer;
}
