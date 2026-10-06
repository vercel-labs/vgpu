import { createRenderBundle } from "./core/render-bundle.ts";
import { InternalDraw, drawGeometrySnapshot, drawLifecycleToken, drawResourceSnapshots, drawUsesBlendConstant, drawUsesStencilReference, encodeDraw, type BundleBackReference, type BundleStaleEvent, type Draw, type DrawCallOptions, type DrawLifecycleToken } from "./draw.ts";
import { InternalEffect, effectDraw, type Effect } from "./effect.ts";
import type { CompileTarget, Target, TargetSignature } from "./target.ts";
import { normalizeSignature, signatureKeyOf, validateTargetSignature } from "./pipeline-store.ts";
import { bundleBlendConstantError, bundleDisposedError, bundleStencilReferenceError, VGPUError } from "./errors.ts";
import { FRAME_BUNDLE, type FrameBundleProtocol } from "./frame-protocols.ts";
import { liveKernel } from "./live-kernel.ts";
import type { Gpu } from "./kernel.ts";
import { identityKey } from "./bind-cache.ts";
import { geometryLiveness, type GeometryLive } from "./draw-protocols.ts";
import type { BindingResourceSnapshot } from "./set-core.ts";
import type { LifetimeDependent } from "./binding-lifetime.ts";

/**
 * Records an explicit WebGPU render bundle: the draws in `record` are encoded once and replayed
 * with `pass.bundles(bundle)`.
 *
 * A bundle freezes its commands, its bind groups and the target signature it was recorded for; the
 * recorded state is re-checked at replay and a mismatch throws `VGPU-R3-BUNDLE-STALE` instead of
 * drawing something stale. A live `Surface` can supply its configured signature for recording
 * outside a frame without acquiring a presentation texture; replay still belongs inside a frame.
 */
export function bundle(gpu: Gpu, opts: BundleOptions, record: (recorder: BundleRecorder) => void): Bundle {
  return createBundle(liveKernel(gpu, "bundle").device, opts, record);
}

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
  dispose(): void;
}

let nextBundleId = 1;

/** Records explicit WebGPU render bundles and keeps the R3 stale signature checked at replay time. */
export function createBundle(device: { readonly gpu: GPUDevice }, opts: BundleOptions, record: (recorder: BundleRecorder) => void): Bundle {
  const id = opts.label ?? `bundle${nextBundleId++}`;
  const signature = normalizeBundleSignature(opts.target);
  const bundle = new RecordedBundle(device, id, signature);
  bundle.record(record);
  return bundle;
}

class RecordedBundle implements Bundle, BundleBackReference {
  #gpu?: GPURenderBundle;
  #disposed = false;
  #recording = false;
  #staleEvent?: BundleStaleEvent;
  readonly #signatureKey: string;
  readonly #drawTokens = new Set<DrawLifecycleToken>();
  readonly #geometries = new Set<GeometryLive>();
  readonly #snapshots = new Set<CapturedBindingSnapshot>();
  readonly #snapshotKeys = new Map<DrawLifecycleToken, Map<object, Set<string>>>();

  constructor(private readonly device: { readonly gpu: GPUDevice }, readonly id: string, readonly signature: TargetSignature) {
    this.#signatureKey = signatureKeyOf(signature);
  }

  get gpu(): GPURenderBundle {
    if (this.#disposed) throw bundleDisposedError(this.id);
    return this.#gpu!;
  }

  record(record: (recorder: BundleRecorder) => void): void {
    try {
      this.#gpu = createRenderBundle(this.device, {
        label: this.id,
        colorFormats: this.signature.colors,
        depthStencilFormat: this.signature.depth,
        sampleCount: this.signature.sampleCount ?? 1,
        record: (recorder) => this.#recordCommands(record, recorder.gpu as unknown as GPURenderPassEncoder),
      });
    } catch (error) {
      this.#detach();
      throw error;
    }
  }

  /**
   * Frame bundle protocol: `pass.bundles()` replays through this, so `frame.ts` never imports
   * bundle.ts. The recorded bundle is its own protocol object — `gpu` and the staleness check.
   */
  get [FRAME_BUNDLE](): FrameBundleProtocol { return this; }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#gpu = undefined;
    this.#detach();
  }

  markStale(event: BundleStaleEvent): void {
    // Set() while recording may deliberately encode different resources. Destruction of any
    // captured resource is never safe, including during recording or after the Draw was rebound.
    if (this.#recording && event.kind !== "draw-disposed" && !(event.kind === "binding-identity" && event.newIdentity.startsWith("destroyed:"))) return;
    if (this.#staleEvent) return;
    this.#staleEvent = event;
    this.#detach();
  }

  assertReplayable(target: Target): void {
    if (this.#disposed) throw bundleDisposedError(this.id);
    const actual = normalizeBundleSignature(target);
    const actualKey = signatureKeyOf(actual);
    if (this.#signatureKey !== actualKey) throw bundleStaleError(this.id, targetSignatureStaleMessage(this.id, this.#signatureKey, actualKey));
    if (this.#staleEvent) throw bundleStaleError(this.id, staleEventMessage(this.id, this.#staleEvent));
    for (const snapshot of this.#snapshots) snapshot.assertCurrent();
    if (this.#staleEvent) throw bundleStaleError(this.id, staleEventMessage(this.id, this.#staleEvent));
    for (const geometry of this.#geometries) geometry[geometryLiveness](`bundle '${this.id}' replay geometry`);
  }

  remember(draw: InternalDraw): void {
    if (this.#staleEvent || this.#disposed) return;
    const token = drawLifecycleToken(draw);
    if (!this.#drawTokens.has(token)) {
      this.#drawTokens.add(token);
      token.recordedIn.add(this);
    }
    const geometry = drawGeometrySnapshot(draw);
    if (geometry) this.#geometries.add(geometry);
    let keysByLifetime = this.#snapshotKeys.get(token);
    if (!keysByLifetime) this.#snapshotKeys.set(token, keysByLifetime = new Map());
    for (const captured of drawResourceSnapshots(draw)) {
      let keys = keysByLifetime.get(captured.lifetime);
      if (!keys) keysByLifetime.set(captured.lifetime, keys = new Set());
      const key = `${captured.group}:${captured.binding}:${captured.capturedIdentity}`;
      if (keys.has(key)) continue;
      keys.add(key);
      this.#snapshots.add(new CapturedBindingSnapshot(this, token.label, captured));
    }
  }

  #detach(): void {
    for (const token of this.#drawTokens) token.recordedIn.delete(this);
    this.#drawTokens.clear();
    this.#geometries.clear();
    releaseSnapshots(this.#snapshots);
    this.#snapshotKeys.clear();
  }

  #recordCommands(record: (recorder: BundleRecorder) => void, encoder: GPURenderPassEncoder): void {
    this.#recording = true;
    try { record(new ExplicitBundleRecorder(this, encoder)); }
    finally { this.#recording = false; }
  }
}

function releaseSnapshots(snapshots: Set<CapturedBindingSnapshot>): void {
  for (const snapshot of snapshots) snapshot.dispose();
  snapshots.clear();
}

class CapturedBindingSnapshot implements LifetimeDependent {
  readonly #bundle: WeakRef<RecordedBundle>;
  #record?: number;
  #disposed = false;

  constructor(bundle: RecordedBundle, private readonly drawLabel: string, private readonly captured: BindingResourceSnapshot) {
    this.#bundle = new WeakRef(bundle);
    this.#record = captured.lifetime.register(this, captured.markers.map((marker) => marker.dependency));
  }

  invalidateLifetime(): void {
    if (this.#disposed) return;
    this.#bundle.deref()?.markStale(this.#event(`destroyed:${this.captured.capturedIdentity}`));
    this.dispose();
  }

  assertCurrent(): void {
    if (this.#disposed) return;
    if (this.captured.markers.some((marker) => marker.destroyed)) {
      this.#bundle.deref()?.markStale(this.#event(`destroyed:${this.captured.capturedIdentity}`));
      return;
    }
    const followed = this.captured.followedTarget;
    if (!followed) return;
    const selected = followed.depth ? followed.target.depth : followed.target.color;
    if (!selected) {
      this.#bundle.deref()?.markStale(this.#event(`destroyed:${this.captured.capturedIdentity}`));
      return;
    }
    const currentIdentity = identityKey(selected.resourceIdentity);
    if (currentIdentity !== this.captured.capturedIdentity) this.#bundle.deref()?.markStale(this.#event(currentIdentity));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.captured.lifetime.unregister(this.#record);
    this.#record = undefined;
  }

  #event(newIdentity: string): BundleStaleEvent {
    return {
      kind: "binding-identity",
      drawLabel: this.drawLabel,
      group: this.captured.group,
      binding: this.captured.binding,
      bindingName: this.captured.bindingName,
      bindingKind: this.captured.bindingKind,
      previousIdentity: this.captured.capturedIdentity,
      newIdentity,
    };
  }
}

class ExplicitBundleRecorder implements BundleRecorder {
  constructor(private readonly bundle: RecordedBundle, private readonly encoder: GPURenderPassEncoder) {}

  draw(drawable: Draw | Effect, opts: DrawCallOptions = {}): void {
    // Blend/writeMask are constructor-only draw pipeline state. If they ever become mutable or per-call,
    // bundles need a new staleness dimension beyond the target signature checked at replay.
    const draw = drawable instanceof InternalEffect ? effectDraw(drawable) : drawable as InternalDraw;
    draw.assertUsable("draw");
    // The blend constant is render-pass state; GPURenderBundleEncoder has no setBlendConstant, so reject at recording.
    if (drawUsesBlendConstant(draw)) throw bundleBlendConstantError(this.bundle.id, draw.label);
    // Likewise the stencil reference: GPURenderBundleEncoder has no setStencilReference. Stencil pipeline state without ref records fine.
    if (drawUsesStencilReference(draw)) throw bundleStencilReferenceError(this.bundle.id, draw.label);
    this.bundle.remember(draw);
    encodeDraw(draw, this.encoder, this.bundle.signature, opts);
  }
}

function normalizeBundleSignature(target: CompileTarget): TargetSignature {
  const signature = normalizeSignature(target);
  validateTargetSignature(signature, "bundle");
  return signature;
}

function targetSignatureStaleMessage(id: string, recordedKey: string, actualKey: string): string {
  return `bundle '${id}' is stale: the replay target signature does not match the recorded signature. Bundles freeze format/depth/sampleCount and bind groups.\n  Recorded signature: ${recordedKey}\n  Actual signature: ${actualKey}\n  Fix: re-record the bundle for this target → ${id} = bundle(gpu, { target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
}

function staleEventMessage(id: string, event: BundleStaleEvent): string {
  if (event.kind === "draw-disposed") {
    return `Bundle '${id}' is stale: draw '${event.drawLabel}' was disposed. Create a new draw/effect and re-record the bundle.`;
  }
  if (event.kind === "group-claim") {
    return `bundle '${id}' is stale: group ${event.group} of draw\n  '${event.drawLabel}' changed bind group after recording. Bundles freeze commands and bind groups.\n  Fix: re-record it → ${id} = bundle(gpu, { target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
  }
  return `bundle '${id}' is stale: binding \`${event.bindingName}\` (@group(${event.group}) @binding(${event.binding})) of draw\n  '${event.drawLabel}' changed resource after recording. Bundles freeze commands and bind groups.\n  Fix: re-record it → ${id} = bundle(gpu, { target: scene }, ...)\n  (re-recording is always your responsibility; the library only detects this).`;
}

function bundleStaleError(id: string, message: string): VGPUError {
  return new VGPUError({ code: "VGPU-R3-BUNDLE-STALE", message, where: `bundle '${id}' replay` });
}
