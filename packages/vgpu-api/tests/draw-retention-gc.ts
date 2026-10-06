import { bindGroupCacheTestState, createBindGroupCache } from "../src/bind-cache.ts";
import { bindingTextureView, bindingViewCacheTestState } from "../src/binding-views.ts";
import { bundle, compute, draw, effect, frame, init, target, texture } from "../src/mock.ts";
import { effectDraw } from "../src/effect.ts";

const SAMPLED = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;
const SAMPLED_DRAW = `
@group(0) @binding(0) var source: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;
const UNIFORM = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main() -> @location(0) vec4f { return vec4f(params.value); }
`;
const STORAGE = `
@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(1) fn main() { values[0] += 1u; }
`;

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!gc) throw new Error("draw retention probe requires process.execPath --expose-gc");

const gpu = await init();
try {
  const output = target(gpu, { size: [4, 4] });
  const source = target(gpu, { size: [4, 4] });
  const uniformBuffer = gpu.device.createBuffer({ size: 16, usage: ["uniform", "copy_dst"] });
  const storageBuffer = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"] });
  const uniformAlignment = gpu.gpu.limits.minUniformBufferOffsetAlignment;
  const storageAlignment = gpu.gpu.limits.minStorageBufferOffsetAlignment;
  const rawUniformBuffer = gpu.gpu.createBuffer({ size: uniformAlignment * 2, usage: 0x40 | 0x08 });
  const rawStorageBuffer = gpu.gpu.createBuffer({ size: storageAlignment * 2, usage: 0x80 | 0x08 });
  const rawView = source.color.view;
  let textureListeners = 0;
  let targetListeners = 0;
  let bufferListeners = 0;
  let recreateListeners = 0;
  const textureOnDestroy = source.color.onDestroy.bind(source.color);
  source.color.onDestroy = (callback) => { textureListeners += 1; return textureOnDestroy(callback); };
  const targetOnDestroy = source.onDestroy.bind(source);
  source.onDestroy = (callback) => { targetListeners += 1; return targetOnDestroy(callback); };
  const bufferOnDestroy = uniformBuffer.onDestroy.bind(uniformBuffer);
  uniformBuffer.onDestroy = (callback) => { bufferListeners += 1; return bufferOnDestroy(callback); };
  const recreate = source.onTexturesRecreated!.bind(source);
  source.onTexturesRecreated = (callback) => { recreateListeners += 1; return recreate(callback); };

  const refs = [
    ...makeDraws(64),
    ...makeEffects(80),
    ...makeComputes(64),
    ...makeDraws(16, true),
    ...makeEffects(16, true),
    ...makeComputes(16, true),
    ...makeRawEffects(),
    ...makeRawComputes(),
  ];
  const pending = frame(gpu);
  const pendingRefs = [
    ...makePendingEffect(pending),
    ...makePendingEffect(pending, true),
    ...makePendingRawEffect(pending),
    ...makePendingRawEffect(pending, true),
    ...makePendingRawCompute(pending),
    ...makePendingRawCompute(pending, true),
  ];
  refs.push(...pendingRefs);
  const {
    retainedDisposedFacades,
    releasedMetadataRefs,
    computeConstructorSetRef,
    retainedDisposedBundle,
    disposedBundleConsumerRefs,
  } = makeDisposedMetadataControls();
  refs.push(...disposedBundleConsumerRefs);
  await gpu.settled();

  const retained = effect(gpu, SAMPLED, { label: "retained-control", set: { source } });
  const retainedRef = new WeakRef(retained);
  const { cacheControl, ownerShardRef, bindGroupRef } = makeCacheControl();
  const { viewTextures, defaultViewRefs, generatedViewRefs, serviceRefs, sharedVariant } = makeIndependentViewServiceControl();

  let collected = 0;
  let ownerShardCollected = false;
  let bindGroupCollected = false;
  let releasedDisposedMetadata = false;
  let releasedDisposedComputeConstructorSet = false;
  let viewServicesCollected = false;
  let generatedViewWrappersCollected = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = refs.filter((reference) => reference.deref() === undefined).length;
    ownerShardCollected = ownerShardRef.deref() === undefined;
    bindGroupCollected = bindGroupRef.deref() === undefined;
    releasedDisposedMetadata = releasedMetadataRefs.every((reference) => reference.deref() === undefined);
    releasedDisposedComputeConstructorSet = computeConstructorSetRef.deref() === undefined;
    viewServicesCollected = serviceRefs.every(reference => reference.deref() === undefined);
    generatedViewWrappersCollected = generatedViewRefs.every(reference => reference.deref() === undefined);
    if (collected === refs.length && ownerShardCollected && bindGroupCollected && releasedDisposedMetadata && releasedDisposedComputeConstructorSet && viewServicesCollected && generatedViewWrappersCollected) break;
  }

  if (collected !== refs.length || !ownerShardCollected || !bindGroupCollected || !releasedDisposedMetadata || !releasedDisposedComputeConstructorSet || !viewServicesCollected || !generatedViewWrappersCollected) {
    throw new Error(
      `GC probe inconclusive after bounded pressure: consumers ${collected}/${refs.length}; ` +
      `owner shard ${ownerShardCollected}; bind group ${bindGroupCollected}; ` +
      `disposed metadata ${releasedDisposedMetadata}; ` +
      `disposed Compute constructor set ${releasedDisposedComputeConstructorSet}; ` +
      `independent view services ${viewServicesCollected}; ` +
      `generated view wrappers ${generatedViewWrappersCollected}`,
    );
  }
  const viewMetadataFinite = viewTextures.every(viewTexture => bindingViewCacheTestState(viewTexture).variants <= 1);
  if (!sharedVariant || !viewMetadataFinite) {
    throw new Error("independent services did not share finite texture-wide generated descriptor metadata");
  }
  for (const viewTexture of viewTextures) viewTexture.destroy();
  let viewWrappersCollected = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    viewWrappersCollected = [...defaultViewRefs, ...generatedViewRefs].every(reference => reference.deref() === undefined);
    if (viewWrappersCollected) break;
  }
  if (!viewWrappersCollected) throw new Error("destroyed texture retained generated/default view wrappers after bounded pressure");
  const disposedRetained = retainedDisposedFacades.every((facade) => {
    facade.dispose();
    return true;
  });
  if (retainedRef.deref() !== retained) throw new Error("retained control was collected");
  frame(gpu, current => current.pass(output, pass => pass.draw(retained)));
  pending.submit();
  await pending.done;
  cacheControl.dispose();

  process.stdout.write(`${JSON.stringify({
    collected,
    pendingCollected: pendingRefs.every((reference) => reference.deref() === undefined),
    retained: retainedRef.deref() === retained,
    disposedRetained,
    releasedDisposedMetadata,
    releasedDisposedComputeConstructorSet,
    retainedDisposedBundle: retainedDisposedBundle.gpu !== undefined,
    ownerShardCollected,
    bindGroupCollected,
    viewServicesCollected,
    generatedViewWrappersCollected,
    viewMetadataFinite,
    viewWrappersCollected,
    textureListeners,
    targetListeners,
    bufferListeners,
    recreateListeners,
  })}\n`);

  function makeDraws(count: number, dispose = false): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const sourceValue = index % 3 === 0 ? source : index % 3 === 1 ? source.color : rawView;
      const drawable = draw(gpu, { shader: SAMPLED_DRAW, label: `draw-${index}`, set: { source: sourceValue } });
      if (index % 2 === 0) frame(gpu, current => current.pass(output, pass => pass.draw(drawable)));
      if (dispose) drawable.dispose();
      return new WeakRef(drawable);
    });
  }

  function makeEffects(count: number, dispose = false): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const variant = index % 5;
      const drawable = variant === 3
        ? effect(gpu, UNIFORM, { label: `effect-buffer-${index}`, set: { params: uniformBuffer } })
        : variant === 4
          ? effect(gpu, UNIFORM, { label: `effect-packed-${index}`, set: { params: { value: index } } })
          : effect(gpu, SAMPLED, { label: `effect-${index}`, set: { source: variant === 0 ? source : variant === 1 ? source.color : rawView } });
      if (index % 2 === 0) frame(gpu, current => current.pass(output, pass => pass.draw(drawable)));
      const underlying = effectDraw(drawable);
      if (dispose) drawable.dispose();
      return [new WeakRef(drawable), new WeakRef(underlying)];
    }).flat();
  }

  function makeComputes(count: number, dispose = false): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const pipeline = compute(gpu, STORAGE, { label: `compute-${index}`, set: { values: storageBuffer } });
      if (index % 2 === 0) pipeline.dispatch(1);
      if (dispose) pipeline.dispose();
      return new WeakRef(pipeline);
    });
  }

  function makePendingEffect(pendingFrame: ReturnType<typeof frame>, dispose = false): WeakRef<object>[] {
    const drawable = effect(gpu, UNIFORM, { label: dispose ? "pending-disposed-effect" : "pending-effect", set: { params: { value: 1 } } });
    pendingFrame.pass(output, pass => pass.draw(drawable));
    const underlying = effectDraw(drawable);
    if (dispose) drawable.dispose();
    return [new WeakRef(drawable), new WeakRef(underlying)];
  }

  function makeRawEffects(): WeakRef<object>[] {
    return [
      { descriptor: false, encode: false, dispose: false },
      { descriptor: true, encode: true, dispose: false },
      { descriptor: false, encode: true, dispose: true },
      { descriptor: true, encode: false, dispose: true },
    ].flatMap(({ descriptor, encode, dispose }, index) => {
      const params = descriptor ? { buffer: rawUniformBuffer, offset: uniformAlignment, size: 4 } : rawUniformBuffer;
      const drawable = effect(gpu, UNIFORM, { label: `raw-effect-${index}`, set: { params } });
      if (encode) frame(gpu, current => current.pass(output, drawable));
      const underlying = effectDraw(drawable);
      if (dispose) drawable.dispose();
      return [new WeakRef(drawable), new WeakRef(underlying)];
    });
  }

  function makeRawComputes(): WeakRef<object>[] {
    return [
      { descriptor: false, encode: false, dispose: false },
      { descriptor: true, encode: true, dispose: false },
      { descriptor: false, encode: true, dispose: true },
      { descriptor: true, encode: false, dispose: true },
    ].map(({ descriptor, encode, dispose }, index) => {
      const values = descriptor ? { buffer: rawStorageBuffer, offset: storageAlignment, size: 4 } : rawStorageBuffer;
      const pipeline = compute(gpu, STORAGE, { label: `raw-compute-${index}`, set: { values } });
      if (encode) pipeline.dispatch(1);
      if (dispose) pipeline.dispose();
      return new WeakRef(pipeline);
    });
  }

  function makePendingRawEffect(pendingFrame: ReturnType<typeof frame>, dispose = false): WeakRef<object>[] {
    const drawable = effect(gpu, UNIFORM, {
      label: dispose ? "pending-disposed-raw-effect" : "pending-raw-effect",
      set: { params: { buffer: rawUniformBuffer, offset: uniformAlignment, size: 4 } },
    });
    pendingFrame.pass(output, drawable);
    const underlying = effectDraw(drawable);
    if (dispose) drawable.dispose();
    return [new WeakRef(drawable), new WeakRef(underlying)];
  }

  function makePendingRawCompute(pendingFrame: ReturnType<typeof frame>, dispose = false): WeakRef<object>[] {
    const pipeline = compute(gpu, STORAGE, {
      label: dispose ? "pending-disposed-raw-compute" : "pending-raw-compute",
      set: { values: { buffer: rawStorageBuffer, offset: storageAlignment, size: 4 } },
    });
    pendingFrame.computePass(pass => pass.dispatch(pipeline, 1));
    if (dispose) pipeline.dispose();
    return [new WeakRef(pipeline)];
  }

  function makeDisposedMetadataControls(): {
    retainedDisposedFacades: { dispose(): void }[];
    releasedMetadataRefs: WeakRef<object>[];
    computeConstructorSetRef: WeakRef<object>;
    retainedDisposedBundle: ReturnType<typeof bundle>;
    disposedBundleConsumerRefs: WeakRef<object>[];
  } {
    const geometry = { vertexBufferLayouts: [] };
    const geometryOwner = draw(gpu, { shader: SAMPLED_DRAW, label: "disposed-geometry", geometry });
    const geometryRef = new WeakRef(geometry);
    geometryOwner.dispose();

    const claimed = {} as GPUBindGroup;
    const claimedOwner = draw(gpu, { shader: SAMPLED_DRAW, label: "disposed-claim" });
    claimedOwner.group(0, claimed);
    const claimedRef = new WeakRef(claimed);
    claimedOwner.dispose();

    const rawView = {} as GPUTextureView;
    const resourceOwner = effect(gpu, SAMPLED, { label: "disposed-resource", set: { source: rawView } });
    const resourceRef = new WeakRef(rawView);
    resourceOwner.dispose();

    const packedValue = { value: 3 };
    const valueOwner = effect(gpu, UNIFORM, { label: "disposed-value", set: { params: packedValue } });
    const valueRef = new WeakRef(packedValue);
    valueOwner.dispose();

    const computeConstructorSet = gpu.device.createBuffer({ size: 16, usage: ["storage"] });
    const computeOwner = compute(gpu, STORAGE, {
      label: "disposed-compute-constructor-set",
      set: { values: computeConstructorSet },
    });
    const computeConstructorSetRef = new WeakRef(computeConstructorSet);
    computeOwner.dispose();

    const bundleOwner = effect(gpu, SAMPLED, {
      label: "disposed-retained-bundle-owner",
      set: { source },
    });
    const bundleDraw = effectDraw(bundleOwner);
    const retainedDisposedBundle = bundle(gpu, { target: output }, recorder => recorder.draw(bundleOwner));
    const disposedBundleConsumerRefs = [new WeakRef(bundleOwner), new WeakRef(bundleDraw)];
    bundleOwner.dispose();

    return {
      retainedDisposedFacades: [geometryOwner, claimedOwner, resourceOwner, valueOwner, computeOwner],
      releasedMetadataRefs: [geometryRef, claimedRef, resourceRef, valueRef],
      computeConstructorSetRef,
      retainedDisposedBundle,
      disposedBundleConsumerRefs,
    };
  }

  function makeCacheControl() {
    const cacheControl = createBindGroupCache();
    const owner = {};
    const layout = {} as GPUBindGroupLayout;
    const bindGroup = {} as GPUBindGroup;
    cacheControl.getOrCreate(owner, 0, layout, [{ binding: 0, key: "resource" }], ["resource"], () => bindGroup);
    const ownerShard = bindGroupCacheTestState(cacheControl).ownerShard(owner)!;
    return { cacheControl, ownerShardRef: new WeakRef(ownerShard), bindGroupRef: new WeakRef(bindGroup) };
  }

  function makeIndependentViewServiceControl() {
    const viewTextures: ReturnType<typeof texture>[] = [];
    const serviceRefs: WeakRef<object>[] = [];
    const defaultViewRefs: WeakRef<object>[] = [];
    const generatedViewRefs: WeakRef<object>[] = [];
    let sharedVariant = true;

    makeControl(12, false, false);
    makeControl(1, true, false);
    makeControl(1, false, true);
    return { viewTextures, defaultViewRefs, generatedViewRefs, serviceRefs, sharedVariant };

    function makeControl(count: number, preexistingMarker: boolean, disposeCache: boolean): void {
      const viewTexture = texture(gpu, {
        kind: "2d",
        size: [4, 4],
        mipLevelCount: 3,
        format: "rgba8unorm",
        usage: ["storage_binding"],
      });
      viewTextures.push(viewTexture);
      defaultViewRefs.push(new WeakRef(viewTexture.view));
      let shared: GPUTextureView | undefined;
      for (let index = 0; index < count; index += 1) {
        const independent = createBindGroupCache();
        if (preexistingMarker) {
          independent.marker(viewTexture, viewTexture.resourceIdentity, callback => viewTexture.onDestroy(callback));
        }
        const variant = bindingTextureView(viewTexture, { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }, independent, gpu.device).view;
        shared ??= variant;
        sharedVariant &&= shared === variant;
        serviceRefs.push(new WeakRef(independent), new WeakRef(independent.lifetime));
        if (disposeCache) independent.dispose();
      }
      generatedViewRefs.push(new WeakRef(shared!));
    }
  }
} finally {
  gpu.dispose();
}
