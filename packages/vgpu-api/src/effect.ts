import type { Device } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { InternalDraw, encodeDraw, type Draw, type DrawCallOptions } from "./draw.ts";
import type { ClaimedGroupValidationResult } from "./claim-validation.ts";
import type { BindGroupCache } from "./bind-cache.ts";
import type { SetBag } from "./set-core.ts";
import type { Target } from "./target.ts";

export interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
}

const effectImpls = new WeakMap<Effect, InternalDraw>();

export interface Effect {
  readonly gpu: GPURenderPipeline | undefined;
  set(values: SetBag): this;
  draw(opts?: DrawCallOptions & { readonly target?: Target }): void;
}

export class InternalEffect implements Effect {
  readonly gpu: GPURenderPipeline | undefined;

  constructor(device: Device, source: string, opts: EffectOptions = {}, cache?: BindGroupCache, defaultTarget?: Target) {
    const shader = fullscreenSource(source);
    const impl = new InternalDraw(device, shader, { shader, set: opts.set, label: opts.label ?? "effect" }, cache, defaultTarget);
    effectImpls.set(this, impl);
    this.gpu = impl.gpu;
  }

  set(values: SetBag): this { effectImpl(this).set(values); return this; }
  draw(opts: DrawCallOptions & { readonly target?: Target } = {}): void { effectImpl(this).draw(opts); }

  /** @internal FramePass delegates here; not part of the frozen public Effect surface. */
  encode(pass: GPURenderPassEncoder, target: Target, opts: DrawCallOptions = {}, claimValidation?: (result: ClaimedGroupValidationResult) => void): void {
    encodeDraw(effectImpl(this), pass, target, opts, claimValidation);
  }
}

export function effectDraw(effect: Effect): InternalDraw { return effectImpl(effect); }

function effectImpl(effect: Effect): InternalDraw {
  const impl = effectImpls.get(effect);
  if (!impl) throw new TypeError("Invalid Effect instance");
  return impl;
}

export function fullscreenSource(source: string): string {
  if (hasVertexEntry(source)) return source;
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

function hasVertexEntry(source: string): boolean {
  return reflectSource(source, "effect.wgsl").entryPoints.some((entry) => entry.stage === "vertex");
}
