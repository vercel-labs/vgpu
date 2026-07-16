import { createRenderBundle } from "./core/render-bundle.ts";
import { InternalDraw, encodeDraw, registerDrawBundle, type BundleBackReference, type BundleStaleEvent, type Draw, type DrawCallOptions } from "./draw.ts";
import { InternalPass, passDraw, type Pass } from "./pass.ts";
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
  private readonly draws = new Set<InternalDraw>();

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
    for (const draw of this.draws) registerDrawBundle(draw, this);
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

  draw(drawable: Draw | Pass, opts: DrawCallOptions = {}): void {
    const draw = drawable instanceof InternalPass ? passDraw(drawable) : drawable as InternalDraw;
    this.bundle.remember(draw);
    encodeDraw(draw, this.encoder, this.bundleTarget(), opts);
  }

  private bundleTarget(): Target {
    return this.bundle.target;
  }
}

type TargetSnapshot = {
  readonly size: readonly [number, number];
  readonly colorFormats: readonly GPUTextureFormat[];
  readonly depthFormat?: GPUTextureFormat;
  readonly sampleCount: 1 | 4;
};

function snapshotTarget(target: Target): TargetSnapshot {
  return {
    size: [target.size[0], target.size[1]],
    colorFormats: target.colors.map((color) => color.format),
    depthFormat: target.depth?.format,
    sampleCount: target.sampleCount,
  };
}

function targetResizeStaleMessage(id: string, before: TargetSnapshot, after: TargetSnapshot): string | undefined {
  if (sameTargetSnapshot(before, after)) return undefined;
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

export function replayBundles(target: Target, bundles: readonly Bundle[], execute: (bundles: readonly GPURenderBundle[]) => void): void {
  const recorded = bundles.map((bundle) => assertRecordedBundle(bundle));
  for (const bundle of recorded) bundle.assertReplayable(target);
  execute(recorded.map((bundle) => bundle.gpu));
}

function assertRecordedBundle(bundle: Bundle): RecordedBundle {
  if (bundle instanceof RecordedBundle) return bundle;
  throw new VGPUError({ code: "VGPU-R3-BUNDLE-INVALID", message: "p.bundles() esperaba bundles creados por gpu.bundle({ target }, cb).", where: "FramePass.bundles" });
}

function sameTargetSnapshot(a: TargetSnapshot, b: TargetSnapshot): boolean {
  return sameSize(a.size, b.size) && a.sampleCount === b.sampleCount && a.depthFormat === b.depthFormat && sameTuple(a.colorFormats, b.colorFormats);
}

function sameSize(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function sameTuple<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
