import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { compute, effect, frame, init, storage, target } from "../../src/node.ts";

const UNIFORM_RANGES = `
@group(0) @binding(0) var<uniform> first: vec4f;
@group(0) @binding(1) var<uniform> second: vec4f;
@fragment fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return select(first, second, position.x >= 1.0);
}
`;

const STORAGE_RANGES = `
@group(0) @binding(0) var<storage, read> first: array<u32>;
@group(0) @binding(1) var<storage, read> second: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@compute @workgroup_size(1) fn main() { output[0] = first[0] + second[0]; }
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("raw buffer bindings on Dawn", () => {
  test("aligned uniform ranges render exact pixels and descriptors snapshot on set", async () => {
    const gpu = await init();
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    try {
      const alignment = gpu.gpu.limits.minUniformBufferOffsetAlignment;
      const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 0x40 | 0x08 });
      gpu.gpu.queue.writeBuffer(raw, 0, new Float32Array([1, 0, 0, 1]));
      gpu.gpu.queue.writeBuffer(raw, alignment, new Float32Array([0, 1, 0, 1]));
      const second = { buffer: raw, offset: alignment, size: 16 };
      const output = target(gpu, { size: [2, 1], format: "rgba8unorm" });
      const ranges = effect(gpu, prepareShader(UNIFORM_RANGES), {
        label: "raw-uniform-ranges",
        set: { first: { buffer: raw, offset: 0, size: 16 }, second },
      });
      await ranges.compile(output);
      second.offset = 0;

      const pending = frame(gpu);
      pending.pass(output, ranges);
      ranges.dispose();
      pending.submit();
      await pending.done;
      expect([...(await output.color.read({ mipLevel: 0, region: "all" }))]).toEqual([
        255, 0, 0, 255,
        0, 255, 0, 255,
      ]);

      const peerOutput = target(gpu, { size: [2, 1], format: "rgba8unorm" });
      const peer = effect(gpu, prepareShader(UNIFORM_RANGES), {
        set: { first: { buffer: raw, offset: 0, size: 16 }, second },
      });
      await frame(gpu, current => current.pass(peerOutput, peer)).done;
      expect([...(await peerOutput.color.read({ mipLevel: 0, region: "all" }))]).toEqual([
        255, 0, 0, 255,
        255, 0, 0, 255,
      ]);
      expect(errors).toEqual([]);
    } finally {
      gpu.dispose();
    }
  });

  test("read-only raw storage ranges produce exact data while writable aliases fail before dispatch", async () => {
    const gpu = await init();
    const errors: unknown[] = [];
    gpu.onError(error => errors.push(error));
    try {
      const alignment = gpu.gpu.limits.minStorageBufferOffsetAlignment;
      const raw = gpu.gpu.createBuffer({ size: alignment * 2, usage: 0x80 | 0x08 });
      gpu.gpu.queue.writeBuffer(raw, 0, new Uint32Array([10]));
      gpu.gpu.queue.writeBuffer(raw, alignment, new Uint32Array([32]));
      const output = storage(gpu, 4);
      const ranges = compute(gpu, prepareShader(STORAGE_RANGES), { set: {
        first: { buffer: raw, offset: 0, size: 4 },
        second: { buffer: raw, offset: alignment, size: 4 },
        output,
      } });
      ranges.dispatch(1);
      await gpu.settled();
      expect(new Uint32Array(await output.read())[0]).toBe(42);

      output.write(new Uint32Array([0]));
      await frame(gpu, current => current.computePass(pass => pass.dispatch(ranges, 1))).done;
      expect(new Uint32Array(await output.read())[0]).toBe(42);

      const aliased = compute(gpu, prepareShader(`
        @group(0) @binding(0) var<storage, read> source: array<u32>;
        @group(0) @binding(1) var<storage, read_write> destination: array<u32>;
        @compute @workgroup_size(1) fn main() { destination[0] = source[0]; }
      `), { set: {
        source: { buffer: raw, offset: 0, size: 4 },
        destination: { buffer: raw, offset: alignment, size: 4 },
      } });
      expect(() => aliased.dispatch(1)).toThrowError(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));
      const pending = frame(gpu);
      expect(() => pending.computePass(pass => pass.dispatch(aliased, 1))).toThrowError(expect.objectContaining({ code: "VGPU-R1-STORAGE-ALIASING" }));
      pending.cancel();
      await gpu.settled();
      expect(errors).toEqual([]);

      ranges.dispose();
      output.write(new Uint32Array([0]));
      const peer = compute(gpu, prepareShader(STORAGE_RANGES), { set: {
        first: { buffer: raw, offset: 0, size: 4 },
        second: { buffer: raw, offset: alignment, size: 4 },
        output,
      } });
      peer.dispatch(1);
      await gpu.settled();
      expect(new Uint32Array(await output.read())[0]).toBe(42);
      expect(errors).toEqual([]);
    } finally {
      gpu.dispose();
    }
  });
});
