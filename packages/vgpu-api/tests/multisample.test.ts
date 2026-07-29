import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, draw, frame, target } from "../src/mock.ts";

const SOLID = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 0.5); }
`;

test("alphaToCoverage and mask reach the render pipeline multisample state", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4], msaa: true });

  draw(gpu, { shader: SOLID, label: "a2c", multisample: { alphaToCoverage: true, mask: 0b0101 } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.multisample).toEqual({ count: 4, alphaToCoverageEnabled: true, mask: 5 });
  gpu.dispose();
});

test("unset multisample fields stay omitted; absent option keeps byte-identical descriptors", async () => {
  const gpu = await init();
  const msaa = target(gpu, { size: [4, 4], msaa: true });
  const plain = target(gpu, { size: [4, 4] });

  // mask works without MSAA (out-of-count bits are legal WebGPU; the spec ignores them).
  draw(gpu, { shader: SOLID, label: "mask-only", multisample: { mask: 0b11 } }).draw(msaa);
  draw(gpu, { shader: SOLID, label: "mask-single", multisample: { mask: 0xffffffff } }).draw(plain);
  draw(gpu, { shader: SOLID, label: "absent" }).draw(msaa);
  draw(gpu, { shader: SOLID, label: "absent-single" }).draw(plain);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-4)?.multisample).toEqual({ count: 4, mask: 3 });
  expect(descs.at(-3)?.multisample).toEqual({ count: 1, mask: 0xffffffff });
  expect(descs.at(-2)?.multisample).toEqual({ count: 4 });
  expect(descs.at(-1)?.multisample).toEqual({ count: 1 });
  gpu.dispose();
});

test("invalid multisample options fail at draw construction", async () => {
  const gpu = await init();
  expect(() => draw(gpu, { shader: SOLID, label: "not-object", multisample: "msaa" as never })).toThrowError(/VGPU-MULTISAMPLE-INVALID|expected \{ alphaToCoverage\?, mask\? \}/);
  expect(() => draw(gpu, { shader: SOLID, label: "array", multisample: [true] as never })).toThrowError(/VGPU-MULTISAMPLE-INVALID|expected \{ alphaToCoverage\?, mask\? \}/);
  expect(() => draw(gpu, { shader: SOLID, label: "bad-a2c", multisample: { alphaToCoverage: "yes" } as never })).toThrowError(/VGPU-MULTISAMPLE-INVALID|alphaToCoverage must be a boolean/);
  for (const mask of [1.5, -1, 0x1_0000_0000, Number.NaN, "3"]) {
    expect(() => draw(gpu, { shader: SOLID, label: "bad-mask", multisample: { mask } as never })).toThrowError(/VGPU-MULTISAMPLE-INVALID|mask must be an integer/);
  }
  gpu.dispose();
});

test("alphaToCoverage requires an MSAA target signature", async () => {
  const gpu = await init();
  const msaa = target(gpu, { size: [4, 4], msaa: true });
  const plain = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: SOLID, label: "needs-msaa", multisample: { alphaToCoverage: true } });

  expect(() => drawable.draw(plain)).toThrowError(/VGPU-MULTISAMPLE-INVALID|msaa: true/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"] })).toThrowError(/VGPU-MULTISAMPLE-INVALID|msaa: true/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], sampleCount: 4 })).not.toThrow();
  expect(() => drawable.draw(msaa)).not.toThrow();
  // targets: [...] compiles at construction, so the mismatch surfaces from draw itself.
  expect(() => draw(gpu, { shader: SOLID, label: "eager-needs-msaa", targets: [plain], multisample: { alphaToCoverage: true } })).toThrowError(/VGPU-MULTISAMPLE-INVALID|msaa: true/);
  gpu.dispose();
});

test("alphaToCoverage disabled explicitly compiles against non-MSAA targets", async () => {
  const gpu = await init();
  const plain = target(gpu, { size: [4, 4] });

  draw(gpu, { shader: SOLID, label: "a2c-off", multisample: { alphaToCoverage: false, mask: 1 } }).draw(plain);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.multisample).toEqual({ count: 1, alphaToCoverageEnabled: false, mask: 1 });
  gpu.dispose();
});

test("MSAA target with alphaToCoverage renders through a frame pass with resolve intact", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4], depth: true, msaa: true });
  const drawable = draw(gpu, { shader: SOLID, label: "msaa-a2c", multisample: { alphaToCoverage: true } });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget }, (pass) => pass.draw(drawable)));

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.multisample).toEqual({ count: 4, alphaToCoverageEnabled: true });
  const passDesc = colorTarget.renderPassDescriptor();
  expect(passDesc.colorAttachments[0]?.resolveTarget).toBeDefined();
  gpu.dispose();
});
