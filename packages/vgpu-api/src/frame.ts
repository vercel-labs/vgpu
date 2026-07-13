import type { Device } from "@vgpu/core";
import { Draw, type DrawCallOptions } from "./draw.ts";
import { Pass } from "./pass.ts";
import type { Target } from "./target.ts";
import { missingScreenError } from "./errors.ts";

export interface FramePassOptions {
  readonly target?: Target;
  readonly clear?: GPUColor | readonly [number, number, number, number];
}

export interface FrameLoopHandle { stop(): void }
export type FrameLoopCallback = (frame: Frame) => void;

export class Frame {
  private readonly encoder: GPUCommandEncoder;
  private submitted = false;
  constructor(private readonly device: Device, private readonly defaultTarget?: Target) {
    this.encoder = device.gpu.createCommandEncoder({ label: "vgpu.frame" });
  }

  pass(opts: FramePassOptions, cb: (pass: FramePass) => void): void {
    const target = opts.target ?? this.defaultTarget;
    if (!target) throw missingScreenError();
    const encoder = this.encoder.beginRenderPass(target.renderPassDescriptor(opts.clear));
    try { cb(new FramePass(encoder, target)); }
    finally { encoder.end(); }
  }

  submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.device.gpu.queue.submit([this.encoder.finish()]);
  }
}

export class FramePass {
  constructor(private readonly encoder: GPURenderPassEncoder, readonly target: Target) {}
  draw(drawable: Draw | Pass, opts: DrawCallOptions = {}): void {
    if (drawable instanceof Pass) drawable.encode(this.encoder, this.target, opts);
    else drawable.encode(this.encoder, this.target, opts);
  }
}

export class FrameRunner {
  constructor(private readonly createFrame: () => Frame, private readonly advance: () => void) {}
  frame(cb?: (frame: Frame) => void): Frame {
    this.advance();
    const frame = this.createFrame();
    if (cb) {
      try { cb(frame); }
      finally { frame.submit(); }
    }
    return frame;
  }
  loop(cb: FrameLoopCallback): FrameLoopHandle {
    let stopped = false;
    const request = globalThis.requestAnimationFrame ?? ((fn: FrameRequestCallback) => setTimeout(() => fn(performance.now()), 16) as unknown as number);
    const cancel = globalThis.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));
    let id = 0;
    const tick = () => {
      if (stopped) return;
      const frame = this.frame();
      try { cb(frame); }
      finally { frame.submit(); }
      id = request(tick);
    };
    id = request(tick);
    return { stop() { stopped = true; cancel(id); } };
  }
}
