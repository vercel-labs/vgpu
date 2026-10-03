import { prepareShader } from "@vgpu/wgsl/prepare";
import { bundle, draw, effect, init, target, type Bundle } from "../../src/mock.ts";
import { createBundleRegistry, type BundleBackReference } from "../../src/draw.ts";

const SAMPLED = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;

const SOLID_DRAW = `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!gc) throw new Error("bundle retention probe requires process.execPath --expose-gc");

const gpu = await init();
try {
  const output = target(gpu, { size: [4, 4] });
  const source = target(gpu, { size: [4, 4] });
  const replacement = target(gpu, { size: [4, 4] });
  const sampled = effect(gpu, prepareShader(SAMPLED), { label: "retention-probe", set: { source: source.color } });
  const originalOnDestroy = source.color.onDestroy.bind(source.color);
  let activeBundleSubscriptions = 0;
  source.color.onDestroy = (callback) => {
    activeBundleSubscriptions += 1;
    const off = originalOnDestroy(callback);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      activeBundleSubscriptions -= 1;
      off();
    };
  };

  const retained = bundle(gpu, { target: output, label: "retained-control" }, (recorder) => recorder.draw(sampled));
  const retainedRef = new WeakRef(retained);
  const droppedRefs = makeDroppedBundles(128);
  const registry = createBundleRegistry();
  const registryControl: BundleBackReference = { id: "registry-control", markStale() {} };
  registry.add(registryControl);
  const registryDroppedRefs = makeDroppedRegistryEntries(registry, 128);
  const { staleBundle, lateDrawRef } = makeStaleBundleWithLateDraw();
  if (activeBundleSubscriptions !== droppedRefs.length + 1) {
    throw new Error(`probe setup expected ${droppedRefs.length + 1} bundle subscriptions, observed ${activeBundleSubscriptions}`);
  }

  let collected = 0;
  let registryCollected = 0;
  let lateDrawCollected = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // WeakRef targets are kept alive through the job that creates or dereferences them. Yield before
    // each forced collection so this probe tests reverse ownership rather than that JS guarantee.
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = droppedRefs.filter((reference) => reference.deref() === undefined).length;
    registryCollected = registryDroppedRefs.filter((reference) => reference.deref() === undefined).length;
    lateDrawCollected = lateDrawRef.deref() === undefined;
    if (collected === droppedRefs.length && registryCollected === registryDroppedRefs.length && lateDrawCollected && activeBundleSubscriptions === 1) break;
  }

  if (collected !== droppedRefs.length || registryCollected !== registryDroppedRefs.length || !lateDrawCollected || activeBundleSubscriptions !== 1) {
    throw new Error(
      `GC probe inconclusive after bounded collection pressure: collected ${collected}/${droppedRefs.length}; ` +
      `registry collected ${registryCollected}/${registryDroppedRefs.length}; ` +
      `late draw collected ${lateDrawCollected}; ` +
      `active bundle subscriptions ${activeBundleSubscriptions} (expected retained control only)`,
    );
  }
  if (retainedRef.deref() !== retained) throw new Error("deliberately retained control was collected");

  const registryEntries = registry.list();
  if (registryEntries.length !== 1 || registryEntries[0] !== registryControl) {
    throw new Error(`weak registry prune left ${registryEntries.length} entries instead of its retained control`);
  }

  sampled.set({ source: replacement.color });
  if (activeBundleSubscriptions !== 0) {
    throw new Error(`draw-registry prune/stale cleanup left ${activeBundleSubscriptions} active subscription(s)`);
  }

  process.stdout.write(`${JSON.stringify({ collected, registryEntries: registryEntries.length, retained: retainedRef.deref() === retained, staleBundle: staleBundle.id, lateDrawCollected, activeBundleSubscriptions })}\n`);

  function makeDroppedBundles(count: number): WeakRef<Bundle>[] {
    return Array.from({ length: count }, (_, index) => {
      const recorded = bundle(gpu, { target: output, label: `dropped-${index}` }, (recorder) => recorder.draw(sampled));
      return new WeakRef(recorded);
    });
  }

  function makeDroppedRegistryEntries(registry: ReturnType<typeof createBundleRegistry>, count: number): WeakRef<BundleBackReference>[] {
    return Array.from({ length: count }, (_, index) => {
      const entry: BundleBackReference = { id: `registry-dropped-${index}`, markStale() {} };
      registry.add(entry);
      return new WeakRef(entry);
    });
  }

  function makeStaleBundleWithLateDraw(): { staleBundle: Bundle; lateDrawRef: WeakRef<ReturnType<typeof draw>> } {
    const staleSource = target(gpu, { size: [4, 4] });
    const first = effect(gpu, prepareShader(SAMPLED), { label: "stale-first", set: { source: staleSource.color } });
    const late = draw(gpu, { shader: prepareShader(SOLID_DRAW), label: "late-after-stale" });
    const lateDrawRef = new WeakRef(late);
    const staleBundle = bundle(gpu, { target: output, label: "retained-stale" }, (recorder) => {
      recorder.draw(first);
      staleSource.color.destroy();
      recorder.draw(late);
    });
    return { staleBundle, lateDrawRef };
  }
} finally {
  gpu.dispose();
}
