import type { Device } from "@vgpu/core";
import { reflectSource } from "@vgpu/wgsl/reflect-source";
import { InternalDraw, encodeDraw, type BlendOptions, type BlendPreset, type Draw, type DrawCallOptions } from "./draw.ts";
import type { ClaimedGroupValidationResult, ValidationErrorSink } from "./claim-validation.ts";
import type { BindGroupCache } from "./bind-cache.ts";
import type { PipelineLayoutCache, PipelineStore, ShaderModuleCache } from "./pipeline-store.ts";
import type { SetBag } from "./set-core.ts";
import type { CompileTarget, Target } from "./target.ts";
import { isTarget } from "./target-utils.ts";

export interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
  /** Blend state applied to every color target of this effect's pipelines. Preset or explicit components. Immutable after construction. */
  readonly blend?: BlendPreset | BlendOptions;
  /** Channels written to color targets. Omit to write all (rgba). Empty array writes nothing. */
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
}

const effectImpls = new WeakMap<Effect, InternalDraw>();

export interface Effect {
  readonly gpu: GPURenderPipeline | undefined;
  set(values: SetBag): this;
  draw(target?: Target | DrawCallOptions): void;
  compile(target?: CompileTarget): Promise<this>;
  compileSync(target?: CompileTarget): this;
}

export class InternalEffect implements Effect {
  get gpu(): GPURenderPipeline | undefined { return effectImpl(this).gpu; }

  constructor(device: Device, source: string, opts: EffectOptions = {}, cache?: BindGroupCache, defaultTarget?: Target, pipelineStore?: PipelineStore, shaderModules?: ShaderModuleCache, pipelineLayouts?: PipelineLayoutCache, errorSink?: ValidationErrorSink, trackSettled?: (promise: Promise<unknown>) => void) {
    const shader = fullscreenSource(source);
    const impl = new InternalDraw(device, shader, { shader, set: opts.set, label: opts.label ?? "effect", blend: opts.blend, writeMask: opts.writeMask }, cache, defaultTarget, pipelineStore, shaderModules, pipelineLayouts, errorSink, trackSettled);
    effectImpls.set(this, impl);
  }

  set(values: SetBag): this { effectImpl(this).set(values); return this; }
  draw(target: Target | DrawCallOptions = {}): void { effectImpl(this).draw(isTarget(target) ? { target } : target); }
  compile(target?: CompileTarget): Promise<this> { return effectImpl(this).compile(target).then(() => this); }
  compileSync(target?: CompileTarget): this { effectImpl(this).compileSync(target); return this; }

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
  var uv = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0));
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
