import { describe, expect, it, vi } from "vitest";
import type { Gpu } from "vgpu";

import { withWrappedTensors } from "./ort-webgpu";

interface FakeOptions {
  readonly failWrapAt?: number;
  readonly wrapError?: unknown;
  readonly loseIdentityAt?: number;
  readonly flushError?: unknown;
  readonly failDisposeAt?: number;
}

function createFakeGpu(options: FakeOptions = {}) {
  const disposed: number[] = [];
  let wrapped = 0;
  const flush = vi.fn(async () => {
    if (options.flushError) throw options.flushError;
  });
  const gpu = {
    device: {
      wrapBuffer(raw: GPUBuffer) {
        wrapped++;
        if (wrapped === options.failWrapAt) throw options.wrapError;
        const index = wrapped;
        return {
          gpu: index === options.loseIdentityAt ? {} : raw,
          dispose() {
            disposed.push(index);
            if (index === options.failDisposeAt)
              throw new Error("dispose failed");
          },
        };
      },
      queue: { flush },
    },
  } as unknown as Gpu;
  return { gpu, disposed, flush };
}

const raws = [{ size: 16 }, { size: 32 }] as unknown as GPUBuffer[];

describe("temporary ORT GPU tensor wrappers", () => {
  it("flushes consumed work and releases wrappers in reverse order", async () => {
    const { gpu, disposed, flush } = createFakeGpu();
    const result = await withWrappedTensors(
      gpu,
      raws,
      (buffers) => buffers.length
    );

    expect(result).toBe(2);
    expect(flush).toHaveBeenCalledOnce();
    expect(disposed).toEqual([2, 1]);
  });

  it("releases earlier wrappers when a later wrap fails", async () => {
    const failure = new Error("second wrap failed");
    const { gpu, disposed, flush } = createFakeGpu({
      failWrapAt: 2,
      wrapError: failure,
    });

    await expect(withWrappedTensors(gpu, raws, () => undefined)).rejects.toBe(
      failure
    );
    expect(flush).not.toHaveBeenCalled();
    expect(disposed).toEqual([1]);
  });

  it("releases the mismatched wrapper and preserves the identity failure", async () => {
    const { gpu, disposed, flush } = createFakeGpu({ loseIdentityAt: 2 });

    await expect(
      withWrappedTensors(gpu, raws, () => undefined)
    ).rejects.toThrow("wrapBuffer lost GPUBuffer identity.");
    expect(flush).not.toHaveBeenCalled();
    expect(disposed).toEqual([2, 1]);
  });

  it("preserves the primary consume error when wrapper disposal also fails", async () => {
    const failure = new Error("consume failed");
    const { gpu, disposed, flush } = createFakeGpu({ failDisposeAt: 2 });

    await expect(
      withWrappedTensors(gpu, raws, () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(flush).not.toHaveBeenCalled();
    expect(disposed).toEqual([2, 1]);
  });

  it("preserves a flush failure after releasing every wrapper", async () => {
    const failure = new Error("flush failed");
    const { gpu, disposed } = createFakeGpu({ flushError: failure });

    await expect(withWrappedTensors(gpu, raws, () => undefined)).rejects.toBe(
      failure
    );
    expect(disposed).toEqual([2, 1]);
  });
});
