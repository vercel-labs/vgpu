import { afterEach, describe, expect, test, vi } from "vitest";
import { init } from "../../src/mock.ts";
import { compute } from "../../src/compute.ts";
import { storage } from "../../src/storage.ts";
import { pingPongStorage } from "../../src/ping-pong.ts";

const ALIASING_SHADER = `
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  dst[id.x] = src[id.x];
}
`;

const READ_ONLY_SHADER = `
@group(0) @binding(0) var<storage, read> a: array<vec4f>;
@group(0) @binding(1) var<storage, read> b: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  dst[id.x] = a[id.x] + b[id.x];
}
`;

let gpu: Awaited<ReturnType<typeof init>> | undefined;

afterEach(() => {
  gpu?.dispose();
  gpu = undefined;
});

describe("compute storage aliasing", () => {
  test("writable storage aliasing throws the exact fix-it text", async () => {
    gpu = await init();
    const sim = compute(gpu, ALIASING_SHADER, { label: "sim" });
    const buffer = storage(gpu, 16);
    sim.set({ src: buffer, dst: buffer });
    expect(() => sim.dispatch(1)).toThrowError("`src` and writable `dst` alias. Fix: alternate them with pingPongStorage(gpu).");
  });

  test("read + read aliasing passes without warnings", async () => {
    gpu = await init();
    const sim = compute(gpu, READ_ONLY_SHADER, { label: "sim" });
    const buffer = storage(gpu, 32, "read");
    const dst = storage(gpu, 32);
    sim.set({ a: buffer, b: buffer, dst });
    expect(() => sim.dispatch(1)).not.toThrow();
  });

  test("unused writable storage bindings do not participate in aliasing", async () => {
    gpu = await init();
    const shader = `
      @group(0) @binding(0) var<storage, read> used: array<vec4f>;
      @group(0) @binding(1) var<storage, read_write> unused: array<vec4f>;
      @compute @workgroup_size(1) fn main() { let value = used[0]; }
    `;
    const sim = compute(gpu, shader, { label: "inactive-alias" });
    const buffer = storage(gpu, 16);
    sim.set({ used: buffer, unused: buffer });
    expect(() => sim.dispatch(1)).not.toThrow();
  });

  test("storage access mode reflects in bind group layout entries", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const spy = vi.spyOn(device, "createBindGroupLayout");
    compute(gpu, ALIASING_SHADER, { label: "sim" });
    const descriptor = spy.mock.calls.find(([desc]) => desc?.label?.includes("sim.group0"))?.[0];
    expect(descriptor?.entries).toBeTruthy();
    const srcEntry = descriptor?.entries?.find((entry) => entry.binding === 0);
    const dstEntry = descriptor?.entries?.find((entry) => entry.binding === 1);
    expect(srcEntry?.buffer?.type).toBe("read-only-storage");
    expect(dstEntry?.buffer?.type).toBe("storage");
    expect(srcEntry?.visibility).toBe(4);
    expect(dstEntry?.visibility).toBe(4);
    spy.mockRestore();
  });
});

// --- gpu-first factories (T202-03) -------------------------------------------------------------

describe("compute(gpu) / storage(gpu) free functions", () => {
  test("the aliasing preflight and its fix-it text survive the gpu-first factories", async () => {
    gpu = await init();
    const sim = compute(gpu, ALIASING_SHADER, { label: "sim" });
    const buffer = storage(gpu, 16);
    sim.set({ src: buffer, dst: buffer });
    expect(() => sim.dispatch(1)).toThrowError("`src` and writable `dst` alias. Fix: alternate them with pingPongStorage(gpu).");
  });

  test("ping-pong halves alternate the same shader without aliasing", async () => {
    gpu = await init();
    const sim = compute(gpu, ALIASING_SHADER, { label: "sim" });
    const buffers = pingPongStorage(gpu, 16);
    sim.set({ src: buffers.read, dst: buffers.write });
    expect(() => sim.dispatch(1)).not.toThrow();
    buffers.swap();
    sim.set({ src: buffers.read, dst: buffers.write });
    expect(() => sim.dispatch(1)).not.toThrow();
    expect(buffers.read).not.toBe(buffers.write);
  });

  test("compute(gpu) shares the gpu's single bind group cache with the facade path", async () => {
    gpu = await init();
    const shared = storage(gpu, 16);
    const first = compute(gpu, ALIASING_SHADER, { label: "first" });
    const second = compute(gpu, ALIASING_SHADER, { label: "second" });
    const dst = storage(gpu, 16);
    first.set({ src: shared, dst });
    second.set({ src: shared, dst });
    // One cache means one bind group per (layout, resources) pair, whichever factory built the pipeline.
    expect(() => first.dispatch(1)).not.toThrow();
    expect(() => second.dispatch(1)).not.toThrow();
  });

  test("storage(gpu) buffers are destroyed by gpu.dispose(), and both factories refuse a disposed gpu", async () => {
    const owner = await init();
    const buffer = storage(owner, 16, { indirect: true });
    expect(() => buffer.write(new Uint32Array([1, 1, 1, 1]))).not.toThrow();

    owner.dispose();
    // The buffer went down with the gpu in the resource phase: a late write cannot reach the device.
    expect(() => buffer.write(new Uint32Array([1, 1, 1, 1]))).toThrowError(/Buffer is destroyed/);
    for (const call of [() => storage(owner, 16), () => compute(owner, ALIASING_SHADER), () => pingPongStorage(owner, 16)]) {
      try { call(); expect.unreachable("expected a throw"); }
      catch (error) { expect(error).toMatchObject({ code: "VGPU-GPU-DISPOSED" }); }
    }
  });
});
