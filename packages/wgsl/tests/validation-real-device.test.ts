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

/**
 * Fixture for the "the returned artifact is the validated artifact" guarantee, using a leading-dot
 * float literal: `.5` is valid WGSL (the device accepts this source verbatim), but the whitespace
 * minifier currently splits it into `. 5`, which the device rejects.
 */
const DOT_FIVE_WGSL = "@group(0) @binding(0) var<storage, read_write> out_buf: array<f32>;\n@compute @workgroup_size(1) fn main() {\n  out_buf[0] = .5;\n}\n";

async function resolveDotFiveWhitespaceMinified() {
  return await resolveShader({ entry: "/dot-five.wgsl", validate: "require", minify: { whitespace: true }, modules: { "/dot-five.wgsl": DOT_FIVE_WGSL } });
}

test.skipIf(!hasDevice)("whitespace-only minification never returns WGSL the device has not accepted", async () => {
  // The durable guarantee, written so it survives a whitespace-minifier fix: with `validate` on,
  // `resolveShader` either throws, or returns WGSL that the device really validated. What it must
  // never do is resolve successfully while handing back text that fails `createShaderModule` —
  // before this was fixed, whitespace-only output was never validated at all and did exactly that.
  const outcome = await resolveDotFiveWhitespaceMinified().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  if (!outcome.ok) {
    expect(outcome.error).toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN" });
    return;
  }
  expect(outcome.value.validation).toMatchObject({ mode: "require", attempted: true, ok: true });
  // Re-validating the returned string on its own is the strongest form of the claim: what the
  // caller got compiles. (Reached once the whitespace minifier stops splitting `.5`.)
  const roundTrip = await resolveShader({ entry: "/round-trip.wgsl", validate: "require", modules: { "/round-trip.wgsl": outcome.value.wgsl } });
  expect(roundTrip.validation).toMatchObject({ attempted: true, ok: true });
});

test.skipIf(!hasDevice)("a `.5` literal split by whitespace minification is caught instead of shipped", async () => {
  // Pinned to today's minifier behaviour: `.5` -> `. 5` is a live printer bug, so the *correct*
  // outcome for this input right now is a loud naga diagnostic. Fixing the printer flips this test
  // — replace the body with `await expect(resolveDotFiveWhitespaceMinified()).resolves.toMatchObject(
  // { validation: { ok: true } })` and keep the test above unchanged; it already covers both worlds.
  await expect(resolveDotFiveWhitespaceMinified()).rejects.toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN" });
});

test.skipIf(!hasDevice)("whitespace-only minification reports attempted/ok for output the device accepts", async () => {
  const result = await resolveShader({ entry: "/ws.wgsl", validate: "require", minify: { whitespace: true }, modules: { "/ws.wgsl": "// comment\n@compute @workgroup_size(1) fn main(){\n  let x = 0.5;\n}\n" } });
  expect(result.validation).toEqual({ mode: "require", attempted: true, ok: true });
  expect(result.wgsl).not.toContain("\n");
  expect(result.wgsl).toContain("0.5");
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
