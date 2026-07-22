import { createRenderBundle } from "./core/render-bundle.ts";
import { InternalDraw, encodeDraw, registerDrawBundle, type BundleBackReference, type BundleStaleEvent, type Draw, type DrawCallOptions } from "./draw.ts";
import { InternalEffect, effectDraw, type Effect } from "./effect.ts";
import type { CompileTarget, Target, TargetSignature } from "./target.ts";
import { normalizeSignature, signatureKeyOf, validateTargetSignature } from "./pipeline-store.ts";
import { surfaceNotInFrameError, VGPUError } from "./errors.ts";
import { isFrameActive, isSurface } from "./surface.ts";

export interface BundleOptions {
  readonly target: CompileTarget;
  readonly label?: string;
}

export interface BundleRecorder {
  draw(drawable: Draw | Effect, opts?: DrawCallOptions): void;
}

export interface Bundle {
  readonly id: string;
  readonly gpu: GPURenderBundle;
}

let nextBundleId = 1;
let recordingDepth = 0;

/** Records explicit WebGPU render bundles and keeps the R3 stale signature checked at replay time. */
export function createBundle(device: { readonly gpu: GPUDevice }, opts: BundleOptions, record: (recorder: BundleRecorder) => void): Bundle {
  const id = opts.label ?? `bundle${nextBundleId++}`;
  if (isSurface(opts.target) && !isFrameActive()) throw surfaceNotInFrameError("gpu.bundle");
  const signature = normalizeBundleSignature(opts.target);
  const bundle = new RecordedBundle(device, id, signature);
  bundle.record(record);
  return bundle;
}

class RecordedBundle implements Bundle, BundleBackReference {
  gpu!: GPURenderBundle;
  #staleEvent?: BundleStaleEvent;
  readonly #signatureKey: string;
  readonly #draws = new Set<InternalDraw>();

  constructor(private readonly device: { readonly gpu: GPUDevice }, readonly id: string, readonly signature: TargetSignature) {
    this.#signatureKey = signatureKeyOf(signature);
  }

  record(record: (recorder: BundleRecorder) => void): void {
    this.gpu = createRenderBundle(this.device, {
      label: this.id,
      colorFormats: this.signature.colors,
      depthStencilFormat: this.signature.depth,
      sampleCount: this.signature.sampleCount ?? 1,
      record: (recorder) => this.#recordCommands(record, recorder.gpu as unknown as GPURenderPassEncoder),
    });
    for (const draw of this.#draws) registerDrawBundle(draw, this);
  }

  markStale(event: BundleStaleEvent): void {
    if (recordingDepth > 0) return;
    this.#staleEvent ??= event;
  }

  assertReplayable(target: Target): void {
    const actual = normalizeBundleSignature(target);
    const actualKey = signatureKeyOf(actual);
    if (this.#signatureKey !== actualKey) throw bundleStaleError(this.id, targetSignatureStaleMessage(this.id, this.#signatureKey, actualKey));
    if (this.#staleEvent) throw bundleStaleError(this.id, staleEventMessage(this.id, this.#staleEvent));
  }

  remember(draw: InternalDraw): void {
    this.#draws.add(draw);
  }

  #recordCommands(record: (recorder: BundleRecorder) => void, encoder: GPURenderPassEncoder): void {
    recordingDepth += 1;
    try { record(new ExplicitBundleRecorder(this, encoder)); }
    finally { recordingDepth -= 1; }
  }
}

class ExplicitBundleRecorder implements BundleRecorder {
  constructor(private readonly bundle: RecordedBundle, private readonly encoder: GPURenderPassEncoder) {}

  draw(drawable: Draw | Effect, opts: DrawCallOptions = {}): void {
    // Blend/writeMask are constructor-only draw pipeline state. If they ever become mutable or per-call,
    // bundles need a new staleness dimension beyond the target signature checked at replay.
    const draw = drawable instanceof InternalEffect ? effectDraw(drawable) : drawable as InternalDraw;
    this.bundle.remember(draw);
    encodeDraw(draw, this.encoder, this.bundle.signature, opts);
  }
}

function normalizeBundleSignature(target: CompileTarget): TargetSignature {
  const signature = normalizeSignature(target);
  validateTargetSignature(signature, "gpu.bundle");
  return signature;
}

function targetSignatureStaleMessage(id: string, recordedKey: string, actualKey: string): string {
  return `bundle '${id}' is stale: the replay target signature does not match the recorded signature. Bundles freeze format/depth/sampleCount and bind groups.\n  Recorded signature: ${recordedKey}\n  Actual signature: ${actualKey}\n  Fix: re-record the bundle for this target → ${id} = gpu.bundle({ target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
}

function staleEventMessage(id: string, event: BundleStaleEvent): string {
  if (event.kind === "group-claim") {
    return `bundle '${id}' is stale: group ${event.group} of draw\n  '${event.drawLabel}' changed bind group after recording. Bundles freeze commands and bind groups.\n  Fix: re-record it → ${id} = gpu.bundle({ target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
  }
  return `bundle '${id}' is stale: binding \`${event.bindingName}\` (@group(${event.group}) @binding(${event.binding})) of draw\n  '${event.drawLabel}' changed resource after recording. Bundles freeze commands and bind groups.\n  Fix: re-record it → ${id} = gpu.bundle({ target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
}

function bundleStaleError(id: string, message: string): VGPUError {
  return new VGPUError({ code: "VGPU-R3-BUNDLE-STALE", message, where: `bundle '${id}' replay` });
}

export function replayBundles(target: Target, bundles: readonly Bundle[], execute: (bundles: readonly GPURenderBundle[]) => void): void {
  const recorded = bundles.map((bundle) => assertRecordedBundle(bundle));
  for (const bundle of recorded) bundle.assertReplayable(target);
  execute(recorded.map((bundle) => bundle.gpu));
}

function assertRecordedBundle(bundle: Bundle): RecordedBundle {
  if (bundle instanceof RecordedBundle) return bundle;
  throw new VGPUError({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() expected bundles created by gpu.bundle({ target }, cb).", where: "FramePass.bundles" });
}
