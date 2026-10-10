import { prepareShader } from "@vgpu/wgsl/prepare";
import { bindGroupCacheTestState } from "../src/bind-cache.ts";
import type { ComputePipeline } from "../src/compute.ts";
import { drawCacheOwnerTestState, type InternalDraw } from "../src/draw.ts";
import { effectDraw } from "../src/effect.ts";
import { compute, draw, effect, frame, geometry, init, target, uniforms, type Draw } from "../src/mock.ts";

// Issue #489 probe: bind group cache hits no longer run lifetime maintenance, so the reverse records
// of dropped draws must be reclaimed by finalization alone while retained controls keep hitting.

const THREE_GROUPS = `struct Frame { viewProjection: mat4x4f }
struct Object { world: mat4x4f }
struct Material { color: vec4f }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> object: Object;
@group(2) @binding(0) var<uniform> material: Material;
@vertex fn vs_main(@location(0) position: vec3f) -> @builtin(position) vec4f { return frame.viewProjection * object.world * vec4f(position, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return material.color; }`;
const SAMPLED = `@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }`;
const STORAGE = `@group(0) @binding(0) var<storage, read_write> values: array<u32>;
@compute @workgroup_size(1) fn main() { values[0] += 1u; }`;

const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
if (!gc) throw new Error("lifetime records probe requires process.execPath --expose-gc");

const gpu = await init();
try {
  const shader = prepareShader(THREE_GROUPS);
  const uniform = (size: number) => gpu.device.createBuffer({ size, usage: ["uniform", "copy_dst"] });
  const frameBuffer = uniform(64);
  const materialBuffer = uniform(16);
  const values = gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"] });
  const shared = uniforms(gpu, { color: [1, 0, 0, 1] });
  const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(9), stride: 12, attributes: { position: { format: "float32x3", offset: 0, location: 0 } } }], vertexCount: 3 });
  const out = target(gpu, { size: [8, 8], depth: true });
  const source = target(gpu, { size: [4, 4] });
  let bufferListeners = 0;
  let targetListeners = 0;
  const bufferOnDestroy = frameBuffer.onDestroy.bind(frameBuffer);
  frameBuffer.onDestroy = (callback) => { bufferListeners += 1; return bufferOnDestroy(callback); };
  const targetOnDestroy = source.onDestroy.bind(source);
  source.onDestroy = (callback) => { targetListeners += 1; return targetOnDestroy(callback); };

  const probe = draw(gpu, { shader, geometry: mesh, label: "probe", set: { frame: frameBuffer, object: uniform(64), material: materialBuffer } });
  const cache = drawCacheOwnerTestState(probe as InternalDraw).cache;
  const lifetime = bindGroupCacheTestState(cache).lifetime;
  probe.dispose();
  const records0 = lifetime.records;

  // Retained controls first: a static draw, a followed-Target effect and a compute, all warm.
  const control = draw(gpu, { shader, geometry: mesh, label: "control", set: { frame: frameBuffer, object: uniform(64), material: materialBuffer } });
  const followed = effect(gpu, prepareShader(SAMPLED), { label: "followed-control", set: { source } });
  const sim = compute(gpu, prepareShader(STORAGE), { label: "compute-control", set: { values } });
  const hits = () => frame(gpu, (f) => {
    f.pass({ target: out }, (p) => p.draw(control));
    f.pass(out, (p) => p.draw(followed));
    f.computePass((p) => p.dispatch(sim, 1));
  });
  for (let index = 0; index < 3; index += 1) hits();
  await gpu.settled();
  const controlRecords = lifetime.records - records0;

  // Abandoned consumers of every kind, each encoded several times so plans and pipeline key memos exist.
  const refs: WeakRef<object>[] = [];
  const owners: WeakRef<object>[] = [];
  // Built in a helper: a suspended async frame would keep its last loop bindings alive.
  const dropRound = () => {
    const keep = (consumer: object, owner: object) => { refs.push(new WeakRef(consumer)); owners.push(new WeakRef(owner)); };
    const draws: Draw[] = Array.from({ length: 24 }, (_, index) => draw(gpu, { shader, geometry: mesh, label: `dropped-${index}`, set: { frame: frameBuffer, object: uniform(64), material: index % 2 ? materialBuffer : shared } }));
    const effects = Array.from({ length: 8 }, (_, index) => effect(gpu, prepareShader(SAMPLED), { label: `dropped-effect-${index}`, set: { source: index % 2 ? source : source.color } }));
    const computes = Array.from({ length: 8 }, (_, index) => compute(gpu, prepareShader(STORAGE), { label: `dropped-compute-${index}`, set: { values: index % 2 ? values : gpu.device.createBuffer({ size: 16, usage: ["storage", "copy_dst"] }) } }));
    for (let encode = 0; encode < 3; encode += 1) {
      frame(gpu, (f) => {
        f.pass({ target: out }, (p) => { for (const item of draws) p.draw(item); });
        f.pass(out, (p) => { for (const item of effects) p.draw(item); });
        f.computePass((p) => { for (const item of computes) p.dispatch(item, 1); });
      });
    }
    for (const item of draws) keep(item, drawCacheOwnerTestState(item as InternalDraw).owner);
    for (const item of effects) keep(item, drawCacheOwnerTestState(effectDraw(item)).owner);
    for (const item of computes) keep(item, (item as ComputePipeline).setCore);
  };
  for (let round = 0; round < 3; round += 1) {
    dropRound();
    await gpu.settled();
  }
  const droppedRecords = lifetime.records - records0 - controlRecords;

  // From here on only cache hits run: no miss registers and nothing sweeps.
  const maintenanceBefore = lifetime.maintenanceVisits;
  const createdBefore = gpu.gpu.createBindGroup;
  let createdDuringHits = 0;
  gpu.gpu.createBindGroup = (descriptor: GPUBindGroupDescriptor) => { createdDuringHits += 1; return createdBefore.call(gpu.gpu, descriptor); };
  let collected = 0;
  let ownersCollected = 0;
  let records = lifetime.records;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    hits();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    collected = refs.filter((reference) => reference.deref() === undefined).length;
    ownersCollected = owners.filter((reference) => reference.deref() === undefined).length;
    records = lifetime.records;
    if (collected === refs.length && ownersCollected === owners.length && records === records0 + controlRecords) break;
  }
  await gpu.settled();
  if (collected !== refs.length || ownersCollected !== owners.length || records !== records0 + controlRecords) {
    throw new Error(`lifetime records probe inconclusive after bounded pressure: consumers ${collected}/${refs.length}; owners ${ownersCollected}/${owners.length}; records ${records} (expected ${records0 + controlRecords})`);
  }
  const maintenanceDuringHits = lifetime.maintenanceVisits - maintenanceBefore;
  hits();
  await gpu.settled();

  process.stdout.write(`${JSON.stringify({
    dropped: refs.length,
    collected,
    ownersCollected: ownersCollected === owners.length,
    droppedRecordsTracked: droppedRecords > 0,
    recordsReturned: records === records0 + controlRecords,
    controlRecordsKept: lifetime.records === records0 + controlRecords,
    maintenanceDuringHits,
    createdDuringHits,
    bufferListeners,
    targetListeners,
  })}\n`);
} finally {
  gpu.dispose();
}
