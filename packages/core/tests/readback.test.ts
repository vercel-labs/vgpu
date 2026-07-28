import { expect, test, vi } from "vitest";
import { Readback } from "../src/readback.ts";

interface CopyRecord {
  readonly bytesPerRow: number | undefined;
  readonly rowsPerImage: number | undefined;
}

interface StagingSpy {
  readonly buffer: GPUBuffer;
  readonly calls: string[];
}

interface StubOptions {
  /** Rejects mapAsync, as a lost device does. */
  readonly failMap?: boolean;
  /** Throws from unmap, as a lost/destroyed buffer does. */
  readonly failUnmap?: boolean;
  /** Fills the mapped range with `index % 256` instead of a constant, so row unpadding is observable. */
  readonly pattern?: boolean;
}

/**
 * Minimal non-mock GPUDevice stub: Readback.read short-circuits real mock buffers through
 * __vgpuMockBytes, so exercising the staging path needs a plain stub.
 */
function createStubDevice(options: StubOptions = {}): { device: GPUDevice; staging: StagingSpy[]; copies: CopyRecord[] } {
  const staging: StagingSpy[] = [];
  const copies: CopyRecord[] = [];
  const device = {
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
      const calls: string[] = [];
      const bytes = new Uint8Array(descriptor.size);
      if (options.pattern) for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
      else bytes.fill(7);
      const buffer = {
        size: descriptor.size,
        mapAsync: () => {
          calls.push("mapAsync");
          return options.failMap ? Promise.reject(new Error("device lost")) : Promise.resolve(undefined);
        },
        getMappedRange: () => {
          calls.push("getMappedRange");
          return bytes.buffer;
        },
        unmap: () => {
          calls.push("unmap");
          if (options.failUnmap) throw new Error("buffer already destroyed");
        },
        destroy: () => { calls.push("destroy"); },
      } as unknown as GPUBuffer;
      staging.push({ buffer, calls });
      return buffer;
    },
    createCommandEncoder: () => ({
      copyBufferToBuffer: () => undefined,
      copyTextureToBuffer: (_source: unknown, destination: GPUTexelCopyBufferInfo) => {
        copies.push({ bytesPerRow: destination.bytesPerRow, rowsPerImage: destination.rowsPerImage });
      },
      finish: () => ({}) as GPUCommandBuffer,
    }) as unknown as GPUCommandEncoder,
    queue: { submit: () => undefined } as unknown as GPUQueue,
  } as unknown as GPUDevice;
  return { device, staging, copies };
}

const source = {} as GPUBuffer;
const texture = {} as GPUTexture;

test("read() unmaps and destroys the staging buffer on the happy path", async () => {
  const { device, staging } = createStubDevice();
  const bytes = new Uint8Array(await new Readback(device).read(source, 4, 0));

  expect([...bytes]).toEqual([7, 7, 7, 7]);
  expect(staging).toHaveLength(1);
  expect(staging[0]!.calls).toEqual(["mapAsync", "getMappedRange", "unmap", "destroy"]);
});

test("read() still destroys the staging buffer when mapAsync rejects on device loss", async () => {
  const { device, staging } = createStubDevice({ failMap: true });

  await expect(new Readback(device).read(source, 4, 0)).rejects.toThrowError(/device lost/);
  // Without the finally the staging buffer leaked one map_read buffer per failed read.
  expect(staging[0]!.calls).toEqual(["mapAsync", "destroy"]);
});

test("read() treats unmap as best-effort and still returns the copied bytes", async () => {
  const { device, staging } = createStubDevice({ failUnmap: true });
  const bytes = new Uint8Array(await new Readback(device).read(source, 2, 0));

  expect([...bytes]).toEqual([7, 7]);
  expect(staging[0]!.calls).toEqual(["mapAsync", "getMappedRange", "unmap", "destroy"]);
});

test("readTexture() destroys the staging buffer on success, on a failed map, and on a failed unmap", async () => {
  const size = [2, 2] as const;
  const ok = createStubDevice();
  const pixels = await new Readback(ok.device).readTexture(texture, size, "rgba8unorm");
  expect(pixels).toHaveLength(2 * 2 * 4);
  expect(ok.staging[0]!.calls).toEqual(["mapAsync", "getMappedRange", "unmap", "destroy"]);

  const failedMap = createStubDevice({ failMap: true });
  await expect(new Readback(failedMap.device).readTexture(texture, size, "rgba8unorm")).rejects.toThrowError(/device lost/);
  expect(failedMap.staging[0]!.calls).toEqual(["mapAsync", "destroy"]);

  const failedUnmap = createStubDevice({ failUnmap: true });
  await expect(new Readback(failedUnmap.device).readTexture(texture, size, "rgba8unorm")).resolves.toHaveLength(2 * 2 * 4);
  expect(failedUnmap.staging[0]!.calls).toEqual(["mapAsync", "getMappedRange", "unmap", "destroy"]);
});

test("readTexture() rejects unsupported formats before allocating a staging buffer", async () => {
  const { device, staging } = createStubDevice();
  // Depth/stencil needs aspect selection, so it stays outside the readback format table.
  await expect(new Readback(device).readTexture(texture, [1, 1], "depth24plus")).rejects.toMatchObject({ code: "VGPU-CORE-UNSUPPORTED-FORMAT" });
  expect(staging).toEqual([]);
  vi.restoreAllMocks();
});

test("readTexture() sizes the staging copy from the format's bytesPerPixel and strips row padding", async () => {
  // rgba16float is 8 bytes per texel: a 3-wide row is 24 bytes, padded to the 256-byte copy alignment.
  const { device, staging, copies } = createStubDevice({ pattern: true });
  const pixels = await new Readback(device).readTexture(texture, [3, 2], "rgba16float");

  expect(copies).toEqual([{ bytesPerRow: 256, rowsPerImage: 2 }]);
  expect(staging[0]!.buffer.size).toBe(256 * 2);
  expect(pixels).toHaveLength(3 * 2 * 8);
  // Row 0 is bytes 0..23 of the mapped range, row 1 starts at the padded offset 256.
  expect([...pixels.subarray(0, 24)]).toEqual([...Array(24).keys()].map((i) => i % 256));
  expect([...pixels.subarray(24, 48)]).toEqual([...Array(24).keys()].map((i) => (256 + i) % 256));
});

test("readTexture() returns float bytes verbatim: 16 bytes per rgba32float texel, no clamping", async () => {
  const { device } = createStubDevice({ pattern: true });
  const pixels = await new Readback(device).readTexture(texture, [2, 1], "rgba32float");

  expect(pixels).toHaveLength(2 * 16);
  expect([...pixels]).toEqual([...Array(32).keys()]);
});
