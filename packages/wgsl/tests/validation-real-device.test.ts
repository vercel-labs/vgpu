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
