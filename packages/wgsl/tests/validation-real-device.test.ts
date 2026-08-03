import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

/**
 * Real device, no mocks: `VGPU_DOCKER_TEST=1` is this repo's "this runner has a WebGPU device"
 * marker (see validation.test.ts, representative-shaders.test.ts). The docker-gpu CI job runs this
 * file with `VGPU_VALIDATE=require` so a device regression fails loudly instead of skipping.
 */
const hasDevice = process.env.VGPU_DOCKER_TEST === "1";

test.skipIf(!hasDevice)("require mode validates a correct shader against the real device", async () => {
  const result = await resolveShader({ entry: "/ok.wgsl", validate: "require", modules: { "/ok.wgsl": "@compute @workgroup_size(1) fn main(){}" } });
  expect(result.validation).toMatchObject({ mode: "require", attempted: true, ok: true });
});

test.skipIf(!hasDevice)("require mode throws the naga diagnostic for an invalid shader on the real device", async () => {
  await expect(resolveShader({ entry: "/bad.wgsl", validate: "require", modules: { "/bad.wgsl": "@compute @workgroup_size(1) fn main(){ let x: u32 = 1.0; }" } })).rejects.toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN" });
});

test.skipIf(!hasDevice)("concurrent validations keep their own diagnostics on the real device", async () => {
  // Error scopes are a stack on the device every concurrent validation shares, so this is the case
  // that used to mis-attribute: a valid shader failing with its neighbour's message, or the invalid
  // one passing because a neighbour popped its error. The bad shader's type is unique to it, so a
  // mis-attributed diagnostic cannot masquerade as the right one.
  const codes = ["@compute @workgroup_size(1) fn main(){ let ok0: u32 = 0u; }", "@compute @workgroup_size(1) fn main(){ let bad1: vec2<u32> = 1.0; }", "@compute @workgroup_size(1) fn main(){ let ok2: u32 = 2u; }", "@compute @workgroup_size(1) fn main(){ let ok3: u32 = 3u; }"];
  const settled = await Promise.allSettled(codes.map((code, id) => resolveShader({ entry: `/c${id}.wgsl`, validate: "require", modules: { [`/c${id}.wgsl`]: code } })));

  expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  expect((settled[1] as PromiseRejectedResult).reason).toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN", message: expect.stringContaining("vec2<u32>") });
  for (const index of [0, 2, 3]) expect((settled[index] as PromiseFulfilledResult<{ validation: unknown }>).value.validation).toMatchObject({ mode: "require", attempted: true, ok: true });
});
