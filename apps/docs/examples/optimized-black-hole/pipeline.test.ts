import { expect, test, vi } from "vitest";

import { createNoiseVolume } from "./noise-volume.mjs";
import { createEffects, createTargets, destroyTargets } from "./pipeline";

function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("sampler construction failure happens before the raw noise texture is allocated", () => {
  const failure = new Error("sampler creation failed");
  const createTexture = vi.fn();
  const sampler = vi
    .fn()
    .mockReturnValueOnce({ marker: "post sampler" })
    .mockImplementationOnce(() => {
      throw failure;
    });
  const vgpu = {
    effect: vi.fn(() => ({})),
    sampler,
  };
  const gpu = {
    device: { createTexture },
  };

  expect(captureThrow(() => createEffects(vgpu as never, gpu as never))).toBe(
    failure
  );
  expect(sampler).toHaveBeenCalledTimes(2);
  expect(createTexture).not.toHaveBeenCalled();
});

test("noise upload failure destroys its texture and preserves the upload error", () => {
  const failure = new Error("texture upload failed");
  const texture = {
    destroy: vi.fn(() => {
      throw new Error("texture cleanup failed");
    }),
    gpu: { marker: "texture" },
  };
  const gpu = {
    device: { createTexture: vi.fn(() => texture) },
    gpu: {
      queue: {
        writeTexture: vi.fn(() => {
          throw failure;
        }),
      },
    },
  };

  expect(captureThrow(() => createNoiseVolume(gpu as never, 4))).toBe(failure);
  expect(texture.destroy).toHaveBeenCalledOnce();
});

test("partial target allocation tries every rollback and preserves the allocation error", () => {
  const allocationFailure = new Error("target allocation failed");
  const first = { destroy: vi.fn() };
  const second = {
    destroy: vi.fn(() => {
      throw new Error("target rollback failed");
    }),
  };
  const target = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second)
    .mockImplementationOnce(() => {
      throw allocationFailure;
    });

  expect(
    captureThrow(() =>
      createTargets({ target } as never, {} as never, [320, 180])
    )
  ).toBe(allocationFailure);
  expect(target).toHaveBeenCalledTimes(3);
  expect(second.destroy).toHaveBeenCalledOnce();
  expect(first.destroy).toHaveBeenCalledOnce();
});

test("target graph teardown tries every target and reports the first cleanup error", () => {
  const firstFailure = new Error("first target cleanup failed");
  const targets = Array.from({ length: 9 }, (_, index) => ({
    destroy: vi.fn(() => {
      if (index === 0) throw firstFailure;
      if (index === 2) throw new Error("later target cleanup failed");
    }),
  }));

  expect(
    captureThrow(() =>
      destroyTargets({
        gbuffer: targets[0],
        aa: targets[1],
        scene: targets[2],
        bloom0: targets[3],
        bloomPing0: targets[4],
        bloom1: targets[5],
        bloomPing1: targets[6],
        bloom2: targets[7],
        bloomPing2: targets[8],
      } as never)
    )
  ).toBe(firstFailure);
  for (const target of targets) expect(target.destroy).toHaveBeenCalledOnce();
});
