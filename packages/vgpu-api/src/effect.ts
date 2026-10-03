import type { Device } from "@vgpu/core";
import { InternalDraw, encodeDraw, type BlendOptions, type BlendPreset, type Draw, type DrawCallOptions } from "./draw.ts";
import type { ClaimedGroupValidationResult, ValidationErrorSink } from "./claim-validation.ts";
import type { BindGroupCache } from "./bind-cache.ts";
import type { PipelineLayoutCache, PipelineStore, ShaderModuleCache } from "./pipeline-store.ts";
import type { SetBag } from "./set-core.ts";
import type { CompileTarget, Target } from "./target.ts";
import { isTarget } from "./target-utils.ts";
import { FRAME_DRAWABLE, type FrameDrawableProtocol } from "./frame-protocols.ts";
import { liveKernel } from "./live-kernel.ts";
import { renderService } from "./render-service.ts";
import { snapshotShaderSource, type PreparedShaderSnapshot } from "./shader-source.ts";
import { entryInvalidError, unsupportedError } from "./errors.ts";
import type { ShaderSource } from "@vgpu/wgsl";
import type { Gpu } from "./kernel.ts";
import { FULLSCREEN_VERTEX_ENTRY, FULLSCREEN_VERTEX_SOURCE } from "./fullscreen-stage.ts";

/**
 * Fullscreen shader pass of this gpu: the fragment shader is enough, the fullscreen triangle
 * vertex stage is generated when the source has no vertex entry point.
 *
 * An effect is a draw with a fixed vertex stage, so it shares the gpu's single render service with
 * `draw()`: same pipeline store, same bind group cache, same shader module and layout caches.
 */
export function effect(gpu: Gpu, source: ShaderSource, opts: EffectOptions = {}): Effect {
  // Vertex buffers belong to the generated fullscreen stage, so geometry here would silently do
  // nothing. Reject the option instead of ignoring it.
  if ("geometry" in (opts as Record<string, unknown>)) throw unsupportedError("effect", "effect() never accepts vertex buffers; use draw(gpu, { shader, geometry: geometry(gpu, descriptor) }).");
  const kernel = liveKernel(gpu, "effect");
  const render = renderService(kernel);
  return new InternalEffect(
    kernel.device,
    snapshotShaderSource(source),
    opts,
    render.binds,
    undefined,
    render.pipelines,
    render.shaderModules,
    render.pipelineLayouts,
    (error) => kernel.reportError(error),
    (promise) => { void kernel.trackDelivery(promise); },
  );
}

export interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
  /** Immutable fragment selection. Defaults to fs_main when declared, otherwise the first fragment entry. */
  readonly entry?: { readonly fragment?: string };
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
  /** Prepares a pipeline for a target; a live Surface is accepted without acquiring its current texture. */
  compile(target?: CompileTarget): Promise<this>;
  /** Synchronously prepares a pipeline; a live Surface is accepted outside a frame. */
  compileSync(target?: CompileTarget): this;
}

export class InternalEffect implements Effect {
  get gpu(): GPURenderPipeline | undefined { return effectImpl(this).gpu; }

  constructor(device: Device, shader: PreparedShaderSnapshot, opts: EffectOptions = {}, cache?: BindGroupCache, defaultTarget?: Target, pipelineStore?: PipelineStore, shaderModules?: ShaderModuleCache, pipelineLayouts?: PipelineLayoutCache, errorSink?: ValidationErrorSink, trackSettled?: (promise: Promise<unknown>) => void) {
    const entry = opts.entry;
    if (entry && typeof entry === "object" && "vertex" in entry) {
      throw entryInvalidError(opts.label ?? "effect", "effect does not support vertex entry overrides.", "effect");
    }
    // InternalDraw validates the entry container and fragment name, and resolves it at construction.
    const builtinVertex = shader.reflection.entryPoints.some(item => item.stage === "vertex")
      ? undefined
      : { source: FULLSCREEN_VERTEX_SOURCE, entry: FULLSCREEN_VERTEX_ENTRY };
    const impl = new InternalDraw(device, shader, { entry, set: opts.set, label: opts.label ?? "effect", blend: opts.blend, writeMask: opts.writeMask }, cache, defaultTarget, pipelineStore, shaderModules, pipelineLayouts, errorSink, trackSettled, builtinVertex);
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

  /**
   * Frame drawable protocol: an effect is encoded as its underlying draw, so it reuses that draw's
   * protocol object — same encode path, same depth/stencil metadata for read-only passes.
   */
  get [FRAME_DRAWABLE](): FrameDrawableProtocol { return effectImpl(this)[FRAME_DRAWABLE]; }
}

export function effectDraw(effect: Effect): InternalDraw { return effectImpl(effect); }

function effectImpl(effect: Effect): InternalDraw {
  const impl = effectImpls.get(effect);
  if (!impl) throw new TypeError("Invalid Effect instance");
  return impl;
}
