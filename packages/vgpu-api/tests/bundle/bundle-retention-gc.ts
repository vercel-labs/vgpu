import { prepareShader } from "@vgpu/wgsl/prepare";
import { bindGroupCacheTestState } from "../../src/bind-cache.ts";
import { bundle, draw, effect, frame, geometry, init, target, type Bundle } from "../../src/mock.ts";
import { createBundleRegistry, drawCacheOwnerTestState, type BundleBackReference } from "../../src/draw.ts";
import { effectDraw } from "../../src/effect.ts";
import { kernelOf } from "../../src/kernel.ts";
import { renderService } from "../../src/render-service.ts";

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

const GEOMETRY_DRAW = `
@vertex fn vs_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!gc) throw new Error("bundle retention probe requires process.execPath --expose-gc");

const gpu = await init();
try {
  const output = target(gpu, { size: [4, 4] });
  const source = target(gpu, { size: [4, 4] });
  const originalOnDestroy = source.color.onDestroy.bind(source.color);
  let resourceSubscriptionCalls = 0;
  source.color.onDestroy = (callback) => {
    resourceSubscriptionCalls += 1;
    return originalOnDestroy(callback);
  };

  const shared = effect(gpu, prepareShader(SAMPLED), { label: "shared-dropped", set: { source: source.color } });
  const retainedEvidence = makeRetainedBundle();
  const followedEvidence = makeFollowedTargetBundle();
  const geometryEvidence = makeGeometryBundle();
  const retainedRef = new WeakRef(retainedEvidence.retained);
  const droppedRefs = makeDroppedBundles(128);
  const registry = createBundleRegistry();
  const registryControl: BundleBackReference = { id: "registry-control", markStale() {} };
  registry.add(registryControl);
  const registryDroppedRefs = makeDroppedRegistryEntries(registry, 128);
  const { staleBundle, lateDrawRef } = makeStaleBundleWithLateDraw();

  let collected = 0;
  let registryCollected = 0;
  let lateDrawCollected = false;
  let retainedEffectCollected = false;
  let retainedDrawCollected = false;
  let retainedOwnerShardCollected = false;
  let followedEffectCollected = false;
  let followedDrawCollected = false;
  let geometryDrawCollected = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = droppedRefs.filter((reference) => reference.deref() === undefined).length;
    registryCollected = registryDroppedRefs.filter((reference) => reference.deref() === undefined).length;
    lateDrawCollected = lateDrawRef.deref() === undefined;
    retainedEffectCollected = retainedEvidence.effectRef.deref() === undefined;
    retainedDrawCollected = retainedEvidence.drawRef.deref() === undefined;
    retainedOwnerShardCollected = retainedEvidence.ownerShardRef.deref() === undefined;
    followedEffectCollected = followedEvidence.effectRef.deref() === undefined;
    followedDrawCollected = followedEvidence.drawRef.deref() === undefined;
    geometryDrawCollected = geometryEvidence.drawRef.deref() === undefined;
    if (collected === droppedRefs.length && registryCollected === registryDroppedRefs.length && lateDrawCollected
      && retainedEffectCollected && retainedDrawCollected && retainedOwnerShardCollected
      && followedEffectCollected && followedDrawCollected && geometryDrawCollected) break;
  }

  if (collected !== droppedRefs.length || registryCollected !== registryDroppedRefs.length || !lateDrawCollected
    || !retainedEffectCollected || !retainedDrawCollected || !retainedOwnerShardCollected
    || !followedEffectCollected || !followedDrawCollected || !geometryDrawCollected) {
    throw new Error(
      `GC probe inconclusive after bounded pressure: bundles ${collected}/${droppedRefs.length}; ` +
      `registry ${registryCollected}/${registryDroppedRefs.length}; late draw ${lateDrawCollected}; ` +
      `retained effect ${retainedEffectCollected}; retained draw ${retainedDrawCollected}; ` +
      `owner shard ${retainedOwnerShardCollected}; followed effect ${followedEffectCollected}; ` +
      `followed draw ${followedDrawCollected}; geometry draw ${geometryDrawCollected}`,
    );
  }
  if (retainedRef.deref() !== retainedEvidence.retained) throw new Error("deliberately retained bundle was collected");

  const cacheState = bindGroupCacheTestState(renderService(kernelOf(gpu)).binds);
  for (let attempt = 0; attempt < 20 && cacheState.lifetime.records > 3; attempt += 1) cacheState.lifetime.maintain();
  const recordsAfterDropped = cacheState.lifetime.records;
  const bucketsAfterDropped = cacheState.lifetime.dependencyBuckets;
  if (recordsAfterDropped !== 3 || bucketsAfterDropped !== 3) {
    throw new Error(`dropped bundle cleanup left records=${recordsAfterDropped}, buckets=${bucketsAfterDropped}; expected 3/3 retained baselines`);
  }

  const registryEntries = registry.list();
  if (registryEntries.length !== 1 || registryEntries[0] !== registryControl) {
    throw new Error(`weak registry prune left ${registryEntries.length} entries instead of its retained control`);
  }

  frame(gpu, current => current.pass(output, pass => pass.bundles(retainedEvidence.retained)));
  source.color.destroy();
  let staleAfterDestroy: string | undefined;
  try { frame(gpu, current => current.pass(output, pass => pass.bundles(retainedEvidence.retained))); }
  catch (error) { staleAfterDestroy = (error as { code?: string }).code; }
  if (staleAfterDestroy !== "VGPU-R3-BUNDLE-STALE") throw new Error(`retained snapshot did not stale after destruction: ${staleAfterDestroy}`);

  frame(gpu, current => current.pass(output, pass => pass.bundles(followedEvidence.retained)));
  followedEvidence.source.resize([8, 8]);
  let staleAfterTargetGeneration: string | undefined;
  try { frame(gpu, current => current.pass(output, pass => pass.bundles(followedEvidence.retained))); }
  catch (error) { staleAfterTargetGeneration = (error as { code?: string }).code; }
  if (staleAfterTargetGeneration !== "VGPU-R3-BUNDLE-STALE") throw new Error(`collected-draw Target snapshot stayed live: ${staleAfterTargetGeneration}`);

  frame(gpu, current => current.pass(output, pass => pass.bundles(geometryEvidence.retained)));
  geometryEvidence.mesh.destroy();
  let staleAfterGeometryDestroy: string | undefined;
  try { frame(gpu, current => current.pass(output, pass => pass.bundles(geometryEvidence.retained))); }
  catch (error) { staleAfterGeometryDestroy = (error as { code?: string }).code; }
  if (staleAfterGeometryDestroy !== "VGPU-MESH-LAYOUT-INVALID") throw new Error(`collected-draw geometry snapshot stayed live: ${staleAfterGeometryDestroy}`);
  const recordsAfterStale = cacheState.lifetime.records;
  const bucketsAfterStale = cacheState.lifetime.dependencyBuckets;
  if (recordsAfterStale !== 0 || bucketsAfterStale !== 0) throw new Error(`stale cleanup left records=${recordsAfterStale}, buckets=${bucketsAfterStale}`);
  if (resourceSubscriptionCalls !== 1) throw new Error(`expected one shared texture listener, observed ${resourceSubscriptionCalls}`);

  process.stdout.write(`${JSON.stringify({
    collected,
    registryEntries: registryEntries.length,
    retained: retainedRef.deref() === retainedEvidence.retained,
    retainedEffectCollected,
    retainedDrawCollected,
    retainedOwnerShardCollected,
    followedEffectCollected,
    followedDrawCollected,
    geometryDrawCollected,
    replayAfterCollection: true,
    staleAfterDestroy,
    staleAfterTargetGeneration,
    staleAfterGeometryDestroy,
    staleBundle: staleBundle.id,
    lateDrawCollected,
    resourceSubscriptionCalls,
    recordsAfterDropped,
    bucketsAfterDropped,
    recordsAfterStale,
    bucketsAfterStale,
  })}\n`);

  function makeRetainedBundle() {
    const drawable = effect(gpu, prepareShader(SAMPLED), { label: "retained-factory-local", set: { source: source.color } });
    const internal = effectDraw(drawable);
    const { cache, owner } = drawCacheOwnerTestState(internal);
    const retained = bundle(gpu, { target: output, label: "retained-control" }, recorder => recorder.draw(drawable));
    const ownerShard = bindGroupCacheTestState(cache).ownerShard(owner)!;
    return {
      retained,
      effectRef: new WeakRef(drawable),
      drawRef: new WeakRef(internal),
      ownerShardRef: new WeakRef(ownerShard),
    };
  }

  function makeFollowedTargetBundle() {
    const followedSource = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SAMPLED), { label: "retained-followed-local", set: { source: followedSource } });
    const internal = effectDraw(drawable);
    const retained = bundle(gpu, { target: output, label: "retained-followed" }, recorder => recorder.draw(drawable));
    return { retained, source: followedSource, effectRef: new WeakRef(drawable), drawRef: new WeakRef(internal) };
  }

  function makeGeometryBundle() {
    const mesh = geometry(gpu, {
      buffers: [{ data: new Float32Array([-1, -1, 1, -1, 0, 1]), attributes: { position: { format: "float32x2", location: 0 } } }],
    });
    const drawable = draw(gpu, { shader: prepareShader(GEOMETRY_DRAW), geometry: mesh, label: "retained-geometry-local" });
    const retained = bundle(gpu, { target: output, label: "retained-geometry" }, recorder => recorder.draw(drawable));
    return { retained, mesh, drawRef: new WeakRef(drawable) };
  }

  function makeDroppedBundles(count: number): WeakRef<Bundle>[] {
    return Array.from({ length: count }, (_, index) => {
      const recorded = bundle(gpu, { target: output, label: `dropped-${index}` }, recorder => recorder.draw(shared));
      return new WeakRef(recorded);
    });
  }

  function makeDroppedRegistryEntries(bundleRegistry: ReturnType<typeof createBundleRegistry>, count: number): WeakRef<BundleBackReference>[] {
    return Array.from({ length: count }, (_, index) => {
      const entry: BundleBackReference = { id: `registry-dropped-${index}`, markStale() {} };
      bundleRegistry.add(entry);
      return new WeakRef(entry);
    });
  }

  function makeStaleBundleWithLateDraw(): { staleBundle: Bundle; lateDrawRef: WeakRef<ReturnType<typeof draw>> } {
    const staleSource = target(gpu, { size: [4, 4] });
    const first = effect(gpu, prepareShader(SAMPLED), { label: "stale-first", set: { source: staleSource.color } });
    const late = draw(gpu, { shader: prepareShader(SOLID_DRAW), label: "late-after-stale" });
    const lateDrawRef = new WeakRef(late);
    const staleBundle = bundle(gpu, { target: output, label: "retained-stale" }, recorder => {
      recorder.draw(first);
      staleSource.color.destroy();
      recorder.draw(late);
    });
    return { staleBundle, lateDrawRef };
  }
} finally {
  gpu.dispose();
}
