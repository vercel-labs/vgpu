import { createRenderBundle } from "./core/render-bundle.ts";
import { InternalDraw, encodeDraw, registerDrawBundle, type BundleBackReference, type BundleStaleEvent, type Draw, type DrawCallOptions } from "./draw.ts";
import { InternalEffect, effectDraw, type Effect } from "./effect.ts";
import type { CompileTarget, Target, TargetSignature } from "./target.ts";
import { normalizeSignature, signatureKeyOf, validateTargetSignature } from "./pipeline-store.ts";
import { VGPUError } from "./errors.ts";

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
  const signature = normalizeBundleSignature(opts.target);
  const bundle = new RecordedBundle(device, id, signature);
  bundle.record(record);
  return bundle;
}

class RecordedBundle implements Bundle, BundleBackReference {
  gpu!: GPURenderBundle;
  private staleEvent?: BundleStaleEvent;
  private readonly signatureKey: string;
  private readonly draws = new Set<InternalDraw>();

  constructor(private readonly device: { readonly gpu: GPUDevice }, readonly id: string, readonly signature: TargetSignature) {
    this.signatureKey = signatureKeyOf(signature);
  }

  record(record: (recorder: BundleRecorder) => void): void {
    this.gpu = createRenderBundle(this.device, {
      label: this.id,
      colorFormats: this.signature.colors,
      depthStencilFormat: this.signature.depth,
      sampleCount: this.signature.sampleCount ?? 1,
      record: (recorder) => this.recordCommands(record, recorder.gpu as unknown as GPURenderPassEncoder),
    });
    for (const draw of this.draws) registerDrawBundle(draw, this);
  }

  markStale(event: BundleStaleEvent): void {
    if (recordingDepth > 0) return;
    this.staleEvent ??= event;
  }

  assertReplayable(target: Target): void {
    const actual = normalizeBundleSignature(target);
    const actualKey = signatureKeyOf(actual);
    if (this.signatureKey !== actualKey) throw bundleStaleError(this.id, targetSignatureStaleMessage(this.id, this.signatureKey, actualKey));
    if (this.staleEvent) throw bundleStaleError(this.id, staleEventMessage(this.id, this.staleEvent));
  }

  remember(draw: InternalDraw): void {
    this.draws.add(draw);
  }

  private recordCommands(record: (recorder: BundleRecorder) => void, encoder: GPURenderPassEncoder): void {
    recordingDepth += 1;
    try { record(new ExplicitBundleRecorder(this, encoder)); }
    finally { recordingDepth -= 1; }
  }
}

class ExplicitBundleRecorder implements BundleRecorder {
  constructor(private readonly bundle: RecordedBundle, private readonly encoder: GPURenderPassEncoder) {}

  draw(drawable: Draw | Effect, opts: DrawCallOptions = {}): void {
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
  return `bundle '${id}' está stale: la firma del target de replay no coincide con la firma grabada. Los bundles congelan formato/depth/sampleCount y bind groups.\n  Firma grabada: ${recordedKey}\n  Firma actual: ${actualKey}\n  Fix: re-grabá el bundle para este target → ${id} = gpu.bundle({ target: scene }, ...)\n  (la re-grabación es siempre tuya; la lib solo detecta).`;
}

function staleEventMessage(id: string, event: BundleStaleEvent): string {
  if (event.kind === "group-claim") {
    return `bundle '${id}' está stale: el grupo ${event.group} del draw\n  '${event.drawLabel}' cambió de bind group después de la grabación. Los bundles congelan comandos y bind groups.\n  Fix: re-grabalo → ${id} = gpu.bundle({ target: scene }, ...)\n  (la re-grabación es siempre tuya; la lib solo detecta).`;
  }
  return `bundle '${id}' está stale: el binding \`${event.bindingName}\` (@group(${event.group}) @binding(${event.binding})) del draw\n  '${event.drawLabel}' cambió de recurso después de la grabación. Los bundles congelan comandos y bind groups.\n  Fix: re-grabalo → ${id} = gpu.bundle({ target: scene }, ...)\n  (la re-grabación es siempre tuya; la lib solo detecta).`;
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
  throw new VGPUError({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() esperaba bundles creados por gpu.bundle({ target }, cb).", where: "FramePass.bundles" });
}
