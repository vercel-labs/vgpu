import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";

const SOLID = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}
`;

const TEXTURE = `
@group(0) @binding(0) var src: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureLoad(src, vec2u(0, 0), 0);
}
`;

test("gpu.bundle can record against a target signature and replay on a compatible target", async () => {
  const gpu = await init();
  const scene = gpu.target({ size: [4, 4], format: "rgba8unorm" });
  const effect = gpu.effect(SOLID, { label: "signatureFx" });

  const bundle = gpu.bundle({ target: { colors: ["rgba8unorm"] }, label: "signatureBundle" }, (b) => b.draw(effect));

  expect(() => gpu.frame((frame) => frame.pass({ target: scene }, (p) => p.bundles(bundle)))).not.toThrow();
  gpu.dispose();
});

test("bundle replay target signature mismatches throw R3 stale with recorded and actual keys", async () => {
  const gpu = await init();
  const scene = gpu.target({ size: [4, 4], format: "bgra8unorm" });
  const effect = gpu.effect(SOLID, { label: "mismatchFx" });
  const bundle = gpu.bundle({ target: { colors: ["rgba8unorm"] }, label: "signatureMismatch" }, (b) => b.draw(effect));

  expect(() => gpu.frame((frame) => frame.pass({ target: scene }, (p) => p.bundles(bundle)))).toThrowError(
    "bundle 'signatureMismatch' is stale: the replay target signature does not match the recorded signature. Bundles freeze format/depth/sampleCount and bind groups.\n" +
      "  Recorded signature: rgba8unorm:none:1\n" +
      "  Actual signature: bgra8unorm:none:1\n" +
      "  Fix: re-record the bundle for this target → signatureMismatch = gpu.bundle({ target: scene }, ...)\n" +
      "  (re-recording is always your responsibility; the library only detects this).",
  );
  gpu.dispose();
});

test("gpu.bundle validates malformed signatures at record time", async () => {
  const gpu = await init();
  const effect = gpu.effect(SOLID);

  expect(() => gpu.bundle({ target: { colors: [] }, label: "badSignature" }, (b) => b.draw(effect))).toThrowError(/VGPU-COMPILE-SIGNATURE-INVALID|colors/);
  gpu.dispose();
});

test("bundle replay survives resize of the replay target when the signature is unchanged", async () => {
  const gpu = await init();
  const scene = gpu.target({ size: [4, 4], format: "rgba8unorm" });
  const effect = gpu.effect(SOLID, { label: "resizeFx" });
  const bundle = gpu.bundle({ target: scene, label: "resizeBundle" }, (b) => b.draw(effect));

  scene.resize([8, 8]);

  expect(() => gpu.frame((frame) => frame.pass({ target: scene }, (p) => p.bundles(bundle)))).not.toThrow();
  gpu.dispose();
});

test("precompiled draws record into signature bundles without sync pipeline creation", async () => {
  const gpu = await init();
  const effect = gpu.effect(SOLID, { label: "precompiledFx" });
  const signature = { colors: ["rgba8unorm"] as const };
  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);

  await effect.compile(signature);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);

  gpu.bundle({ target: signature, label: "precompiledBundle" }, (b) => b.draw(effect));

  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  gpu.dispose();
});

test("signature bundle recording still requires draw resources to be set", async () => {
  const gpu = await init();
  const post = gpu.effect(TEXTURE, { label: "post" });

  expect(() => gpu.bundle({ target: { colors: ["rgba8unorm"] }, label: "unsetTextureBundle" }, (b) => b.draw(post))).toThrowError(/VGPU-R1-BINDING-NEVER-SET|was never set/);
  gpu.dispose();
});

test("cold signature bundle recording uses the sync pipeline path and reports failures through gpu.onError", async () => {
  const gpu = await init();
  const effect = gpu.effect(SOLID, { label: "coldFailure" });
  const nativeError = new Error("sync pipeline failed during bundle recording");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));
  vi.spyOn(gpu.device.gpu, "createRenderPipeline").mockImplementation(() => { throw nativeError; });

  expect(() => gpu.bundle({ target: { colors: ["rgba8unorm"] }, label: "coldFailureBundle" }, (b) => b.draw(effect))).not.toThrow();
  await gpu.settled();

  expect(errors).toEqual([
    expect.objectContaining({
      code: "VGPU-COMPILE-FAILED",
      where: "coldFailure.pipelineFor",
      cause: nativeError,
      detail: { signature: "rgba8unorm:none:1" },
    }),
  ]);
  gpu.dispose();
});
