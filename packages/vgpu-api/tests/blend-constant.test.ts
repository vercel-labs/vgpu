import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, bundle, draw, frame, target } from "../src/mock.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const CONSTANT_BLEND = { color: { src: "constant", dst: "one-minus-constant" } } as const;

test("blendConstant is emitted after setPipeline and before the one-shot draw", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2] });

  draw(gpu, { shader: DRAW_SHADER, label: "constant", blend: CONSTANT_BLEND, blendConstant: [0.25, 0.5, 0.75, 1] }).draw(colorTarget);

  expect(ops).toEqual([["setPipeline"], ["setBlendConstant", { r: 0.25, g: 0.5, b: 0.75, a: 1 }], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("blendConstant is emitted per draw inside frame passes", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2] });
  const constant = draw(gpu, { shader: DRAW_SHADER, label: "constant", blend: CONSTANT_BLEND, blendConstant: [2, -1, 0.5, 1] });
  const plain = draw(gpu, { shader: DRAW_SHADER, label: "plain" });

  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, (p) => { p.draw(constant); p.draw(plain); }));

  // Out-of-[0, 1] components are legal; the format clamps as needed.
  expect(ops).toEqual([["setPipeline"], ["setBlendConstant", { r: 2, g: -1, b: 0.5, a: 1 }], ["draw"], ["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("constant blend factors without blendConstant draw with no setBlendConstant call", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2] });

  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "default-constant", blend: CONSTANT_BLEND }).draw(colorTarget)).not.toThrow();

  expect(ops).toEqual([["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("invalid blendConstant shapes fail at draw construction", async () => {
  const gpu = await init();
  const expectInvalid = (label: string, blendConstant: unknown): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, blend: CONSTANT_BLEND, blendConstant: blendConstant as never })).toThrowError(/VGPU-BLEND-CONSTANT-INVALID|Invalid blendConstant/);
  };
  expectInvalid("bc-string", "white");
  expectInvalid("bc-object", { r: 0, g: 0, b: 0, a: 1 });
  expectInvalid("bc-short", [0, 0, 1]);
  expectInvalid("bc-long", [0, 0, 1, 1, 1]);
  expectInvalid("bc-non-number", [0, "1", 0, 1]);
  expectInvalid("bc-nan", [0, Number.NaN, 0, 1]);
  expectInvalid("bc-infinity", [0, 0, Number.POSITIVE_INFINITY, 1]);
  gpu.dispose();
});

test("blendConstant without a constant blend factor fails at draw construction", async () => {
  const gpu = await init();
  const expectDead = (label: string, opts: object): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, blendConstant: [0, 0, 0, 1], ...opts })).toThrowError(/VGPU-BLEND-CONSTANT-INVALID|no effect/);
  };
  expectDead("bc-no-blend", {});
  expectDead("bc-preset", { blend: "alpha" });
  expectDead("bc-plain-factors", { blend: { color: { src: "one", dst: "zero" } } });
  // Any constant factor in any src/dst of the color or alpha component makes blendConstant live.
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-color-src", blend: { color: { src: "constant", dst: "zero" } }, blendConstant: [0, 0, 0, 1] })).not.toThrow();
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-color-dst", blend: { color: { src: "one", dst: "one-minus-constant" } }, blendConstant: [0, 0, 0, 1] })).not.toThrow();
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-alpha-only", blend: { color: { src: "one", dst: "zero" }, alpha: { src: "constant", dst: "one" } }, blendConstant: [0, 0, 0, 1] })).not.toThrow();
  gpu.dispose();
});

test("a constant factor reached only through colors[i].blend keeps blendConstant live", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2] });

  // No top-level blend at all: the only blend state in play is the per-target override.
  draw(gpu, { shader: DRAW_SHADER, label: "bc-per-target", colors: [{ blend: CONSTANT_BLEND }], blendConstant: [0.5, 0, 0, 1] }).draw(colorTarget);

  expect(ops).toEqual([["setPipeline"], ["setBlendConstant", { r: 0.5, g: 0, b: 0, a: 1 }], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("blendConstant validates against the effective blend state of each color target", async () => {
  const gpu = await init();
  const expectDead = (label: string, opts: object): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, blendConstant: [0, 0, 0, 1], ...opts })).toThrowError(/VGPU-BLEND-CONSTANT-INVALID|no effect/);
  };
  // A top-level constant factor overridden on every target is dead: no target ever sees it.
  expectDead("bc-overridden", { blend: CONSTANT_BLEND, colors: [{ blend: "alpha" }] });
  expectDead("bc-overridden-mrt", { blend: CONSTANT_BLEND, colors: [{ blend: "alpha" }, { blend: { color: { src: "one", dst: "zero" } } }] });
  // Zero color targets means zero effective blend states.
  expectDead("bc-no-targets", { blend: CONSTANT_BLEND, colors: [] });
  // One surviving target is enough: null entries and blend-less entries inherit the top-level constant blend.
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-one-inherits", blend: CONSTANT_BLEND, colors: [{ blend: "alpha" }, null], blendConstant: [0, 0, 0, 1] })).not.toThrow();
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-writemask-only", blend: CONSTANT_BLEND, colors: [{ writeMask: ["r"] }], blendConstant: [0, 0, 0, 1] })).not.toThrow();
  // A per-target constant factor is live even when the top-level blend has none.
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bc-per-target-mrt", blend: "alpha", colors: [null, { blend: CONSTANT_BLEND }], blendConstant: [0, 0, 0, 1] })).not.toThrow();
  gpu.dispose();
});

test("bundles reject recording draws with blendConstant", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const constant = draw(gpu, { shader: DRAW_SHADER, label: "constant", blend: CONSTANT_BLEND, blendConstant: [0.5, 0.5, 0.5, 1] });
  const plain = draw(gpu, { shader: DRAW_SHADER, label: "plain-constant-factors", blend: CONSTANT_BLEND });

  expect(() => bundle(gpu, { target: colorTarget, label: "constantBundle" }, (b) => b.draw(constant))).toThrowError(/VGPU-BUNDLE-BLEND-CONSTANT|blendConstant/);
  expect(() => bundle(gpu, { target: colorTarget, label: "plainBundle" }, (b) => b.draw(plain))).not.toThrow();
  gpu.dispose();
});

test("blendConstant is encoder state and does not split pipelines", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const a = draw(gpu, { shader: DRAW_SHADER, label: "bc-a", blend: CONSTANT_BLEND, blendConstant: [1, 0, 0, 1] });
  const b = draw(gpu, { shader: DRAW_SHADER, label: "bc-b", blend: CONSTANT_BLEND, blendConstant: [0, 1, 0, 1] });
  const c = draw(gpu, { shader: DRAW_SHADER, label: "bc-none", blend: CONSTANT_BLEND });

  a.draw(colorTarget);
  b.draw(colorTarget);
  c.draw(colorTarget);

  const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
  expect(mock.calls.createShaderModule).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(1);
  gpu.dispose();
});

type PassOp = readonly [name: string, ...args: unknown[]];

function spyRenderPassOps(device: GPUDevice): PassOp[] {
  const ops: PassOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = originalBeginRenderPass(renderPassDescriptor);
        return {
          ...pass,
          setPipeline(pipeline: GPURenderPipeline) { ops.push(["setPipeline"]); pass.setPipeline(pipeline); },
          setBlendConstant(color: GPUColor) { ops.push(["setBlendConstant", color]); pass.setBlendConstant(color); },
          draw(...args: Parameters<GPURenderPassEncoder["draw"]>) { ops.push(["draw"]); pass.draw(...args); },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return ops;
}
