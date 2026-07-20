import { afterEach, describe, expect, test, vi } from "vitest";
import { init } from "../../src/mock.ts";

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
    const sim = gpu.compute(ALIASING_SHADER, { label: "sim" });
    const buffer = gpu.storage(16);
    sim.set({ src: buffer, dst: buffer });
    expect(() => sim.dispatch(1)).toThrowError("`src` and writable `dst` alias. Fix: alternate them with gpu.pingPongStorage().");
  });

  test("read + read aliasing passes without warnings", async () => {
    gpu = await init();
    const sim = gpu.compute(READ_ONLY_SHADER, { label: "sim" });
    const buffer = gpu.storage(32, "read");
    const dst = gpu.storage(32);
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
    const sim = gpu.compute(shader, { label: "inactive-alias" });
    const buffer = gpu.storage(16);
    sim.set({ used: buffer, unused: buffer });
    expect(() => sim.dispatch(1)).not.toThrow();
  });

  test("storage access mode reflects in bind group layout entries", async () => {
    gpu = await init();
    const device = gpu.device.gpu as GPUDevice;
    const spy = vi.spyOn(device, "createBindGroupLayout");
    gpu.compute(ALIASING_SHADER, { label: "sim" });
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
