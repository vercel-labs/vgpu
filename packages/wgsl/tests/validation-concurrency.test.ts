import { beforeEach, expect, test, vi } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { acquireValidationDevice } from "../src/runtime/validation-device.ts";

vi.mock("../src/runtime/validation-device.ts", () => ({ acquireValidationDevice: vi.fn(), retainValidationDevice: vi.fn(), releaseValidationDevice: vi.fn(), __resetValidationDeviceForTests: vi.fn() }));

/**
 * A fake device that models the two spec details the cross-talk bug lived in: error scopes are a
 * stack *on the device* (so a pop takes whatever is on top, not "my" scope), and `createShaderModule`
 * reports into whichever scope is on top at that moment. `getCompilationInfo` resolves on a later
 * macrotask and reports no messages, so a bad shader is observable only through its error scope —
 * the fallback path in validation.ts where the bug surfaced — and the gap between a push and its pop
 * is a real interleaving point rather than a simulated one.
 */
function stackedDevice(): { device: GPUDevice; maxDepth: () => number } {
  const scopes: { error: { message: string } | null }[] = [];
  let maxDepth = 0;
  const device = {
    pushErrorScope: () => {
      scopes.push({ error: null });
      maxDepth = Math.max(maxDepth, scopes.length);
    },
    popErrorScope: async () => scopes.at(-1) === undefined ? null : scopes.pop()?.error ?? null,
    createShaderModule: ({ code }: { code: string }) => {
      const marker = /bad_marker_\w+/.exec(code)?.[0];
      const top = scopes.at(-1);
      if (marker && top && top.error === null) top.error = { message: `cannot convert value for ${marker}` };
      return {
        getCompilationInfo: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return { messages: [] };
        },
      };
    },
  } as unknown as GPUDevice;
  return { device, maxDepth: () => maxDepth };
}

const goodShader = (id: number) => `@compute @workgroup_size(1) fn main(){ let ok_${id}: u32 = ${id}u; }`;
const badShader = (id: number) => `@compute @workgroup_size(1) fn main(){ let bad_marker_${id}: u32 = ${id}u; }`;

beforeEach(() => {
  vi.mocked(acquireValidationDevice).mockReset();
});

test("concurrent validations keep their own diagnostics on the shared device", async () => {
  // The regression: every concurrent validation shares one memoized device, so before the error
  // scopes were serialized, the good shader that popped while the bad one's scope was on top failed
  // with the bad shader's message — and the bad one passed, because its error had been popped away.
  const { device, maxDepth } = stackedDevice();
  vi.mocked(acquireValidationDevice).mockResolvedValue(device);
  const codes = [goodShader(0), badShader(1), goodShader(2), goodShader(3)];

  const settled = await Promise.allSettled(codes.map((code, id) => resolveShader({ entry: `/s${id}.wgsl`, validate: "require", modules: { [`/s${id}.wgsl`]: code } })));

  // Exactly one failure, and it is the shader that actually contains the bad marker.
  expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  const rejection = settled[1] as PromiseRejectedResult;
  expect(rejection.reason).toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN", message: "cannot convert value for bad_marker_1" });
  for (const index of [0, 2, 3]) expect((settled[index] as PromiseFulfilledResult<{ validation: unknown }>).value.validation).toMatchObject({ mode: "require", attempted: true, ok: true });
  // The invariant that makes the above true rather than lucky: never two open scopes at once.
  expect(maxDepth()).toBe(1);
});

test("a rejected validation does not strand the ones queued behind it", async () => {
  // The queue chains on both settle paths; if it only chained on fulfilment, one invalid shader would
  // leave every later validation pending forever.
  const { device } = stackedDevice();
  vi.mocked(acquireValidationDevice).mockResolvedValue(device);

  await expect(resolveShader({ entry: "/first.wgsl", validate: "require", modules: { "/first.wgsl": badShader(9) } })).rejects.toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN" });
  await expect(resolveShader({ entry: "/second.wgsl", validate: "require", modules: { "/second.wgsl": goodShader(9) } })).resolves.toMatchObject({ validation: { ok: true } });
});
