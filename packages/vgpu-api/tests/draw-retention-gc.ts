import { bindGroupCacheTestState, createBindGroupCache } from "../src/bind-cache.ts";
import { compute, draw, effect, frame, init, target } from "../src/mock.ts";
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
  ];
  const pending = frame(gpu);
  const pendingRefs = makePendingEffect(pending);
  refs.push(...pendingRefs);
  await gpu.settled();

  const retained = effect(gpu, SAMPLED, { label: "retained-control", set: { source } });
  const retainedRef = new WeakRef(retained);
  const { cacheControl, ownerShardRef, bindGroupRef } = makeCacheControl();

  let collected = 0;
  let ownerShardCollected = false;
  let bindGroupCollected = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = refs.filter((reference) => reference.deref() === undefined).length;
    ownerShardCollected = ownerShardRef.deref() === undefined;
    bindGroupCollected = bindGroupRef.deref() === undefined;
    if (collected === refs.length && ownerShardCollected && bindGroupCollected) break;
  }

  if (collected !== refs.length || !ownerShardCollected || !bindGroupCollected) {
    throw new Error(
      `GC probe inconclusive after bounded pressure: consumers ${collected}/${refs.length}; ` +
      `owner shard ${ownerShardCollected}; bind group ${bindGroupCollected}`,
    );
  }
  if (retainedRef.deref() !== retained) throw new Error("retained control was collected");
  frame(gpu, current => current.pass(output, pass => pass.draw(retained)));
  pending.submit();
  await pending.done;
  cacheControl.dispose();

  process.stdout.write(`${JSON.stringify({
    collected,
    pendingCollected: pendingRefs.every((reference) => reference.deref() === undefined),
    retained: retainedRef.deref() === retained,
    ownerShardCollected,
    bindGroupCollected,
    textureListeners,
    targetListeners,
    bufferListeners,
    recreateListeners,
  })}\n`);

  function makeDraws(count: number): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const sourceValue = index % 3 === 0 ? source : index % 3 === 1 ? source.color : rawView;
      const drawable = draw(gpu, { shader: SAMPLED_DRAW, label: `draw-${index}`, set: { source: sourceValue } });
      if (index % 2 === 0) frame(gpu, current => current.pass(output, pass => pass.draw(drawable)));
      return new WeakRef(drawable);
    });
  }

  function makeEffects(count: number): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const variant = index % 5;
      const drawable = variant === 3
        ? effect(gpu, UNIFORM, { label: `effect-buffer-${index}`, set: { params: uniformBuffer } })
        : variant === 4
          ? effect(gpu, UNIFORM, { label: `effect-packed-${index}`, set: { params: { value: index } } })
          : effect(gpu, SAMPLED, { label: `effect-${index}`, set: { source: variant === 0 ? source : variant === 1 ? source.color : rawView } });
      if (index % 2 === 0) frame(gpu, current => current.pass(output, pass => pass.draw(drawable)));
      return [new WeakRef(drawable), new WeakRef(effectDraw(drawable))];
    }).flat();
  }

  function makeComputes(count: number): WeakRef<object>[] {
    return Array.from({ length: count }, (_, index) => {
      const pipeline = compute(gpu, STORAGE, { label: `compute-${index}`, set: { values: storageBuffer } });
      if (index % 2 === 0) pipeline.dispatch(1);
      return new WeakRef(pipeline);
    });
  }

  function makePendingEffect(pendingFrame: ReturnType<typeof frame>): WeakRef<object>[] {
    const drawable = effect(gpu, UNIFORM, { label: "pending-effect", set: { params: { value: 1 } } });
    pendingFrame.pass(output, pass => pass.draw(drawable));
    return [new WeakRef(drawable), new WeakRef(effectDraw(drawable))];
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
} finally {
  gpu.dispose();
}
