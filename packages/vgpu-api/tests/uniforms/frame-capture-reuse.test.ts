import { afterEach, expect, test, vi } from "vitest";
import { draw, effect, frame, getMockGPUDeviceInstrumentation, init, target, uniforms, type Frame } from "../../src/mock.ts";
import { CAPTURE_PAGE_KIND, bindGroupCacheTestState, createBindGroupCache, type BindGroupCache, type BindGroupIdentityPart, type BufferRangeIdentity } from "../../src/bind-cache.ts";
import { FrameUniforms, MAX_RETAINED_UNIFORM_PAGES, disposeFrameUniforms } from "../../src/frame-uniforms.ts";
import { liveKernel } from "../../src/live-kernel.ts";
import { renderService } from "../../src/render-service.ts";

type Gpu = Awaited<ReturnType<typeof init>>;

const SHADER = `struct Camera { value:f32 } struct Params { value:f32 }
@group(0) @binding(0) var<uniform> camera:Camera;
@group(1) @binding(0) var<uniform> params:Params;
@fragment fn main() -> @location(0) vec4f { return vec4f(camera.value + params.value); }`;
const PAGE_LABEL = "vgpu.frame.uniforms";
afterEach(() => vi.restoreAllMocks());

const LAYOUT = {} as GPUBindGroupLayout;
/** Caches one bind group for `owner` over a captured range, keyed and tracked like a draw's group. */
function cacheRange(cache: BindGroupCache, owner: object, identity: BindGroupIdentityPart) {
  cache.getOrCreate(owner, 0, LAYOUT, [{ binding: 0, key: identity }], [identity], () => ({}) as GPUBindGroup);
}

/** Records bind groups as they are set, page buffers as they are created/destroyed, and holds queue completion. */
function instrument(gpu: Gpu) {
  const native = gpu.gpu;
  const descriptors = new Map<GPUBindGroup, GPUBindGroupDescriptor>();
  const pages: GPUBuffer[] = [];
  const destroyed = new Set<GPUBuffer>();
  const pending: (() => void)[] = [];
  let bound: { group: number; bindGroup: GPUBindGroup }[] = [];
  let bindGroups = 0;
  let deferred = false;
  let failFinish = false;

  const createBindGroup = native.createBindGroup.bind(native);
  native.createBindGroup = (desc) => {
    bindGroups += 1;
    const bindGroup = createBindGroup(desc);
    descriptors.set(bindGroup, desc);
    return bindGroup;
  };
  const createBuffer = native.createBuffer.bind(native);
  native.createBuffer = (desc) => {
    const buffer = createBuffer(desc);
    if (desc.label === PAGE_LABEL) {
      pages.push(buffer);
      buffer.destroy = () => { destroyed.add(buffer); };
    }
    return buffer;
  };
  const createCommandEncoder = native.createCommandEncoder.bind(native);
  native.createCommandEncoder = (desc) => {
    const encoder = createCommandEncoder(desc);
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDesc) => {
      const pass = beginRenderPass(passDesc);
      pass.setBindGroup = ((group: number, bindGroup: GPUBindGroup) => { bound.push({ group, bindGroup }); }) as GPURenderPassEncoder["setBindGroup"];
      return pass;
    };
    const finish = encoder.finish.bind(encoder);
    encoder.finish = (finishDesc) => {
      if (failFinish) { failFinish = false; throw new Error("finish failed"); }
      return finish(finishDesc);
    };
    return encoder;
  };
  const onSubmittedWorkDone = native.queue.onSubmittedWorkDone.bind(native.queue);
  native.queue.onSubmittedWorkDone = () => deferred ? new Promise<undefined>(resolve => pending.push(() => resolve(undefined))) : onSubmittedWorkDone();

  /** Ranges bound since the last call: the page bytes are this frame's flushed snapshot until a later frame reuses the page. */
  function take() {
    const ranges = bound.map(({ group, bindGroup }) => {
      const resource = [...descriptors.get(bindGroup)!.entries][0]!.resource as GPUBufferBinding;
      const bytes = (resource.buffer as unknown as { __vgpuMockBytes: Uint8Array }).__vgpuMockBytes;
      return { group, buffer: resource.buffer, offset: resource.offset ?? 0, value: new DataView(bytes.buffer, bytes.byteOffset).getFloat32(resource.offset ?? 0, true) };
    });
    bound = [];
    return ranges;
  }

  return {
    take,
    pages,
    destroyed,
    bindGroups: () => bindGroups,
    defer() { deferred = true; },
    /** Completes the oldest outstanding (or the indexed) submission. */
    complete(index = 0) { pending.splice(index, 1)[0]!(); },
    failNextFinish() { failFinish = true; },
  };
}

function scene(gpu: Gpu, count: number) {
  const camera = uniforms(gpu, { value: 0 });
  const draws = Array.from({ length: count }, () => effect(gpu, SHADER, { set: { camera, params: { value: 0 } } }));
  const color = target(gpu, { size: [1, 1] });
  /** Encodes every draw (in `order`) with camera `base` and params `base + index`. */
  const encode = (f: Frame, base: number, order = draws.map((_, index) => index)) => {
    camera.set({ value: base });
    f.pass(color, p => { for (const index of order) { draws[index]!.set({ params: { value: base + index } }); p.draw(draws[index]!); } });
  };
  return { draws, encode };
}

function expectFrameValues(ranges: ReturnType<ReturnType<typeof instrument>["take"]>, base: number, order: readonly number[]) {
  const params = ranges.filter(range => range.group === 1).map(range => range.value);
  expect(params).toEqual(order.map(index => base + index));
  for (const range of ranges.filter(range => range.group === 0)) expect(range.value).toBe(base);
}

test("stable frames reuse their pooled pages and bind groups after warmup", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    const { encode } = scene(gpu, 300);
    const order = [...Array(300).keys()];
    for (let i = 0; i < 2; i++) await frame(gpu, f => encode(f, i * 1000)).done;
    probe.take();
    const bindGroups = probe.bindGroups();
    const pages = probe.pages.length;
    for (let i = 2; i < 12; i++) {
      const f = frame(gpu, f => encode(f, i * 1000));
      expectFrameValues(probe.take(), i * 1000, order);
      await f.done;
    }
    expect(probe.bindGroups()).toBe(bindGroups);
    expect(probe.pages.length).toBe(pages);
    expect(pages).toBeGreaterThan(1);
    expect(probe.destroyed.size).toBe(0);
  } finally { gpu.dispose(); }
});

test("frames in flight never share a page and completed pages return in completion order", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    const writes = vi.spyOn(gpu.gpu.queue, "writeBuffer");
    const { encode } = scene(gpu, 300);
    const order = [...Array(300).keys()];
    probe.defer();
    const sets: Set<GPUBuffer>[] = [];
    const frames: Frame[] = [];
    for (let i = 0; i < 3; i++) {
      frames.push(frame(gpu, f => encode(f, i * 1000)));
      const ranges = probe.take();
      expectFrameValues(ranges, i * 1000, order);
      sets.push(new Set(ranges.map(range => range.buffer)));
    }
    const [a, b, c] = sets as [Set<GPUBuffer>, Set<GPUBuffer>, Set<GPUBuffer>];
    for (const buffer of a) expect(b.has(buffer) || c.has(buffer)).toBe(false);
    for (const buffer of b) expect(c.has(buffer)).toBe(false);

    const written = () => new Set(writes.mock.calls.map(call => call[0]).filter(buffer => buffer.label === PAGE_LABEL));
    probe.complete();
    await frames[0]!.done;
    writes.mockClear();
    let bindGroups = probe.bindGroups();
    const d = frame(gpu, f => encode(f, 3000));
    let ranges = probe.take();
    expectFrameValues(ranges, 3000, order);
    expect(new Set(ranges.map(range => range.buffer))).toEqual(a);
    expect(written()).toEqual(a);
    expect(probe.bindGroups()).toBe(bindGroups);

    // Frame c completes before b: c's pages come back first and b's stay untouched.
    probe.complete(1);
    await frames[2]!.done;
    writes.mockClear();
    bindGroups = probe.bindGroups();
    const e = frame(gpu, f => encode(f, 4000));
    ranges = probe.take();
    expectFrameValues(ranges, 4000, order);
    expect(new Set(ranges.map(range => range.buffer))).toEqual(c);
    expect(written()).toEqual(c);
    expect(probe.bindGroups()).toBe(bindGroups);

    probe.complete(); probe.complete(); probe.complete();
    await Promise.all([frames[1]!.done, d.done, e.done]);
    expect(probe.destroyed.size).toBe(0);
  } finally { gpu.dispose(); }
});

test("canceled and failed frames return their pages without destroying them", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    const { encode } = scene(gpu, 10);
    await frame(gpu, f => encode(f, 0)).done;
    probe.take();
    const pages = probe.pages.length;
    const bindGroups = probe.bindGroups();

    const canceled = frame(gpu);
    encode(canceled, 100);
    canceled.cancel();
    const submitError = new Error("submit failed");
    vi.spyOn(gpu.gpu.queue, "submit").mockImplementationOnce(() => { throw submitError; });
    const failedSubmit = frame(gpu);
    encode(failedSubmit, 200);
    expect(() => failedSubmit.submit()).toThrow(submitError);
    probe.failNextFinish();
    const failedFinish = frame(gpu);
    encode(failedFinish, 300);
    expect(() => failedFinish.submit()).toThrow("finish failed");
    probe.take();

    const f = frame(gpu, f => encode(f, 400));
    expectFrameValues(probe.take(), 400, [...Array(10).keys()]);
    await f.done;
    expect(probe.pages.length).toBe(pages);
    expect(probe.bindGroups()).toBe(bindGroups);
    expect(probe.destroyed.size).toBe(0);
  } finally { gpu.dispose(); }
});

test("distinct revisions get disjoint aligned ranges; the latest revision of an owner is shared", async () => {
  const gpu = await init();
  try {
    const uniformsOfFrame = new FrameUniforms(gpu.device);
    const cache = createBindGroupCache();
    const owners = Array.from({ length: 5 }, () => ({}));
    const value = (owner: object, revision: number) => ({ owner, revision, bytes: new Uint8Array(16).fill(revision) });
    const ranges = owners.map(owner => uniformsOfFrame.capture(value(owner, 1), cache).identity as BufferRangeIdentity);
    expect(ranges.map(range => range.offset)).toEqual([0, 256, 512, 768, 1024]);
    expect(new Set(ranges.map(range => range.id)).size).toBe(1);
    expect(ranges[0]!.kind).toBe(CAPTURE_PAGE_KIND);
    expect(uniformsOfFrame.capture(value(owners[0]!, 1), cache).identity).toBe(ranges[0]);
    const newer = uniformsOfFrame.capture(value(owners[0]!, 3), cache).identity as BufferRangeIdentity;
    const older = uniformsOfFrame.capture(value(owners[0]!, 2), cache).identity as BufferRangeIdentity;
    expect([newer.offset, older.offset]).toEqual([1280, 1536]);
    uniformsOfFrame.release();
  } finally { gpu.dispose(); }
});

test("idle pages are bounded by count and bytes; destroyed pages take their bind groups along", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    (gpu.gpu.limits as { minUniformBufferOffsetAlignment: number }).minUniformBufferOffsetAlignment = 32768;
    const cache = createBindGroupCache();
    const owners: object[] = [];
    const capture = (frameUniforms: FrameUniforms, count: number, bytes = 16) => {
      for (let i = 0; i < count; i++) {
        const { identity } = frameUniforms.capture({ owner: {}, revision: 1, bytes: new Uint8Array(bytes) }, cache);
        cacheRange(cache, owners[i] ??= {}, identity);
      }
    };
    const first = new FrameUniforms(gpu.device);
    capture(first, (MAX_RETAINED_UNIFORM_PAGES + 7) * 2);
    expect(probe.pages.length).toBe(MAX_RETAINED_UNIFORM_PAGES + 7);
    first.release();
    expect(probe.destroyed.size).toBe(7);
    expect(bindGroupCacheTestState(cache).trackedEntries()).toBe(MAX_RETAINED_UNIFORM_PAGES * 2);

    const second = new FrameUniforms(gpu.device);
    capture(second, MAX_RETAINED_UNIFORM_PAGES * 2);
    expect(probe.pages.length).toBe(MAX_RETAINED_UNIFORM_PAGES + 7);
    capture(second, 1);
    expect(probe.pages.length).toBe(MAX_RETAINED_UNIFORM_PAGES + 8);
    second.release();
    expect(probe.destroyed.size).toBe(8);

    // 1 MiB pages: sixteen fill the idle byte budget long before the page count.
    gpu.dispose();
    const large = await init();
    const largeProbe = instrument(large);
    const third = new FrameUniforms(large.device);
    capture(third, 20, 1 << 20);
    third.release();
    expect(largeProbe.pages.length).toBe(20);
    expect(largeProbe.destroyed.size).toBe(4);
    disposeFrameUniforms(large.device);
    expect(largeProbe.destroyed.size).toBe(20);
    large.dispose();
  } finally { gpu.dispose(); }
});

test("gpu.dispose destroys idle pages, and pages of frames still in flight when they complete", async () => {
  const gpu = await init();
  const other = await init();
  try {
    const probe = instrument(gpu);
    const otherProbe = instrument(other);
    const { encode } = scene(gpu, 300);
    const otherScene = scene(other, 10);
    await frame(other, f => otherScene.encode(f, 0)).done;
    otherProbe.take();
    const otherBindGroups = otherProbe.bindGroups();

    await frame(gpu, f => encode(f, 0)).done;
    probe.take();
    probe.defer();
    const inFlight = frame(gpu, f => encode(f, 1000));
    const inFlightPages = new Set(probe.take().map(range => range.buffer));
    const open = frame(gpu);
    encode(open, 2000);
    const openPages = new Set(probe.take().map(range => range.buffer));
    expect(probe.pages.length).toBe(inFlightPages.size + openPages.size);
    gpu.dispose();
    expect(probe.destroyed).toEqual(openPages);
    probe.complete();
    await inFlight.done;
    expect(probe.destroyed.size).toBe(probe.pages.length);

    const f = frame(other, f => otherScene.encode(f, 5));
    expectFrameValues(otherProbe.take(), 5, [...Array(10).keys()]);
    await f.done;
    expect(otherProbe.bindGroups()).toBe(otherBindGroups);
    expect(otherProbe.destroyed.size).toBe(0);
  } finally { gpu.dispose(); other.dispose(); }
});

test("page identities are unique across devices", async () => {
  const a = await init();
  const b = await init();
  try {
    const cache = createBindGroupCache();
    const value = { owner: {}, revision: 1, bytes: new Uint8Array(16) };
    const fa = new FrameUniforms(a.device);
    const fb = new FrameUniforms(b.device);
    const ia = fa.capture(value, cache).identity as BufferRangeIdentity;
    const ib = fb.capture(value, cache).identity as BufferRangeIdentity;
    expect(ia.id).not.toBe(ib.id);
    const owner = {};
    cacheRange(cache, owner, ia);
    cacheRange(cache, owner, ib);
    fa.release();
    fb.release();
    disposeFrameUniforms(a.device);
    expect(bindGroupCacheTestState(cache).trackedEntries()).toBe(1);
  } finally { a.dispose(); b.dispose(); }
});

test("replacing a group's layout recreates its bind groups once, then reuses them", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    const shader = SHADER.replace("@fragment", "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }\n@fragment");
    const d = draw(gpu, { shader, vertices: 3, set: { camera: uniforms(gpu, { value: 0 }), params: { value: 1 } } });
    const color = target(gpu, { size: [1, 1] });
    const descriptors = getMockGPUDeviceInstrumentation(gpu.gpu).createBindGroupDescriptors;
    for (let i = 0; i < 2; i++) await frame(gpu, f => f.pass(color, p => p.draw(d))).done;
    const staticLayout = d.layout(1);
    const dynamic = d.layout(1, { dynamicOffsets: true });
    expect(dynamic).not.toBe(staticLayout);
    const before = probe.bindGroups();
    await frame(gpu, f => f.pass(color, p => p.draw(d, { offsets: { 1: [0] } }))).done;
    expect(probe.bindGroups()).toBeGreaterThan(before);
    expect(descriptors.slice(before).find(desc => desc.label?.endsWith(".group1"))?.layout).toBe(dynamic);
    const after = probe.bindGroups();
    for (let i = 0; i < 2; i++) await frame(gpu, f => f.pass(color, p => p.draw(d, { offsets: { 1: [0] } }))).done;
    expect(probe.bindGroups()).toBe(after);
  } finally { gpu.dispose(); }
});

test("changing draw order and discarded draws keep the cache bounded", async () => {
  const gpu = await init();
  try {
    const probe = instrument(gpu);
    const { draws, encode } = scene(gpu, 40);
    const binds = renderService(liveKernel(gpu, "test")).binds;
    const sizes: number[] = [];
    for (let i = 0; i < 30; i++) {
      const order = draws.map((_, index) => (index + i * 7) % draws.length).filter(index => (index + i) % 10 !== 0);
      const f = frame(gpu, f => {
        encode(f, i * 1000, order);
        // A draw created for one frame only: its bind groups must not outlive the pages' next use.
        const once = effect(gpu, SHADER, { set: { camera: uniforms(gpu, { value: i }), params: { value: 0 } } });
        f.pass(target(gpu, { size: [1, 1] }), once);
      });
      const ranges = probe.take();
      expectFrameValues(ranges.slice(0, order.length * 2), i * 1000, order);
      await f.done;
      sizes.push(bindGroupCacheTestState(binds).trackedEntries());
    }
    expect(Math.max(...sizes.slice(10))).toBeLessThanOrEqual(Math.max(...sizes.slice(0, 10)) + 4);
    expect(Math.max(...sizes)).toBeLessThan(40 * 2 * 3);
  } finally { gpu.dispose(); }
});
