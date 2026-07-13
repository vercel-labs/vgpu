import { createRenderBundle } from "@vgpu/render";
import { Draw, type BundleBackReference, type BundleStaleEvent, type DrawCallOptions } from "./draw.ts";
import { FramePass } from "./frame.ts";
import { Pass } from "./pass.ts";
import type { Target } from "./target.ts";
import { VGPUError } from "./errors.ts";

export interface BundleOptions {
  readonly target: Target;
  readonly label?: string;
}

export interface BundleRecorder {
  draw(drawable: Draw | Pass, opts?: DrawCallOptions): void;
}

export interface Bundle {
  readonly id: string;
  readonly gpu: GPURenderBundle;
}

declare module "./frame.ts" {
  interface FramePass {
    bundles(...bundles: readonly Bundle[]): void;
  }
}

let nextBundleId = 1;
let recordingDepth = 0;

/** Records explicit WebGPU render bundles and keeps the R3 stale snapshot checked at replay time. */
export function createBundle(device: { readonly gpu: GPUDevice }, opts: BundleOptions, record: (recorder: BundleRecorder) => void): Bundle {
  const id = opts.label ?? `bundle${nextBundleId++}`;
  const bundle = new RecordedBundle(device, id, opts.target);
  bundle.record(record);
  return bundle;
}

class RecordedBundle implements Bundle, BundleBackReference {
  gpu!: GPURenderBundle;
  private staleEvent?: BundleStaleEvent;
  private readonly targetSnapshot: TargetSnapshot;
  private readonly draws = new Set<Draw>();

  constructor(private readonly device: { readonly gpu: GPUDevice }, readonly id: string, readonly target: Target) {
    this.targetSnapshot = snapshotTarget(target);
  }

  record(record: (recorder: BundleRecorder) => void): void {
    this.gpu = createRenderBundle(this.device, {
      label: this.id,
      colorFormats: this.target.colors.map((color) => color.format),
      depthStencilFormat: this.target.depth?.format,
      sampleCount: this.target.sampleCount,
      record: (recorder) => this.recordCommands(record, recorder.gpu as unknown as GPURenderPassEncoder),
    });
    for (const draw of this.draws) draw.__recordedIn.add(this);
  }

  markStale(event: BundleStaleEvent): void {
    if (recordingDepth > 0) return;
    this.staleEvent ??= event;
  }

  assertReplayable(target: Target): void {
    const resizeMessage = targetResizeStaleMessage(this.id, this.targetSnapshot, snapshotTarget(target));
    if (resizeMessage) throw bundleStaleError(this.id, resizeMessage);
    if (this.staleEvent) throw bundleStaleError(this.id, staleEventMessage(this.id, this.staleEvent));
  }

  remember(draw: Draw): void {
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

  draw(drawable: Draw | Pass, opts: DrawCallOptions = {}): void {
    const draw = drawable instanceof Pass ? drawable.drawImpl : drawable;
    this.bundle.remember(draw);
    draw.encode(this.encoder, this.bundleTarget(), opts);
  }

  private bundleTarget(): Target {
    return this.bundle.target;
  }
}

type TargetSnapshot = {
  readonly size: readonly [number, number];
  readonly colorIdentities: readonly string[];
  readonly depthIdentity?: string;
};

function snapshotTarget(target: Target): TargetSnapshot {
  return {
    size: [target.size[0], target.size[1]],
    colorIdentities: target.colors.map((color) => `${color.resourceIdentity.kind}:${color.resourceIdentity.id}`),
    depthIdentity: target.depth ? `${target.depth.resourceIdentity.kind}:${target.depth.resourceIdentity.id}` : undefined,
  };
}

function targetResizeStaleMessage(id: string, before: TargetSnapshot, after: TargetSnapshot): string | undefined {
  if (sameSize(before.size, after.size) && sameTuple(before.colorIdentities, after.colorIdentities) && before.depthIdentity === after.depthIdentity) return undefined;
  return `bundle '${id}' está stale: el target cambió después de la grabación. Los bundles congelan attachments y bind groups.\n  Fix: re-grabá el bundle después de resize → ${id} = gpu.bundle({ target: scene }, ...)\n  (la re-grabación es siempre tuya; la lib solo detecta).`;
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

function replayBundles(pass: FramePass, bundles: readonly Bundle[]): void {
  const internals = pass as unknown as { readonly encoder: GPURenderPassEncoder; readonly target: Target };
  const recorded = bundles.map((bundle) => assertRecordedBundle(bundle));
  for (const bundle of recorded) bundle.assertReplayable(internals.target);
  internals.encoder.executeBundles(recorded.map((bundle) => bundle.gpu));
}

function assertRecordedBundle(bundle: Bundle): RecordedBundle {
  if (bundle instanceof RecordedBundle) return bundle;
  throw new VGPUError({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() esperaba bundles creados por gpu.bundle({ target }, cb).", where: "FramePass.bundles" });
}

function installFramePassBundles(): void {
  const proto = FramePass.prototype as FramePass & { bundles?: (...bundles: readonly Bundle[]) => void };
  proto.bundles ??= function bundles(...items: readonly Bundle[]) { replayBundles(this, items); };
}

function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function sameTuple(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

installFramePassBundles();
