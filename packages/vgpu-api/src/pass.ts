import type { Device } from "@vgpu/core";
import { Draw, type DrawCallOptions } from "./draw.ts";
import type { BindGroupCache } from "./bind-cache.ts";
import type { SetBag } from "./set-core.ts";
import type { Target } from "./target.ts";

export interface PassOptions {
  readonly set?: SetBag;
  readonly label?: string;
}

export class Pass {
  /** @internal Draw-backed implementation so FramePass can encode fullscreen passes without exposing R4 on Pass. */
  readonly drawImpl: Draw;
  readonly gpu: GPURenderPipeline | undefined;

  constructor(device: Device, source: string, opts: PassOptions = {}, cache?: BindGroupCache, defaultTarget?: Target) {
    const shader = fullscreenSource(source);
    this.drawImpl = new Draw(device, shader, { shader, set: opts.set, label: opts.label ?? "pass" }, cache, defaultTarget);
    this.gpu = this.drawImpl.gpu;
  }

  set(values: SetBag): this { this.drawImpl.set(values); return this; }
  draw(opts: DrawCallOptions & { readonly target?: Target } = {}): void { this.drawImpl.draw(opts); }

  /** @internal FramePass delegates here; not part of the frozen public Pass surface. */
  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}): void { this.drawImpl.encode(pass, target, opts); }
}

export function fullscreenSource(source: string): string {
  if (/@vertex\s+fn\s+/.test(source)) return source;
  return `
struct VgpuFullscreenVertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vgpu_fullscreen_vs(@builtin(vertex_index) vi: u32) -> VgpuFullscreenVertexOut {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var uv = array<vec2f, 3>(vec2f(0.0, 0.0), vec2f(2.0, 0.0), vec2f(0.0, 2.0));
  var out: VgpuFullscreenVertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
${source}`;
}
