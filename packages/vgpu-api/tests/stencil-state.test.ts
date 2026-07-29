import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, bundle, draw, frame, target } from "../src/mock.ts";
import { pipelineKeyOf } from "../src/pipeline-store.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const KEEP_FACE = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" } as const;

test("stencil faces and masks thread into the pipeline depthStencil state", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  draw(gpu, {
    shader: DRAW_SHADER,
    label: "stencil-full",
    stencil: {
      front: { compare: "equal", fail: "zero", depthFail: "invert", pass: "replace" },
      back: { compare: "not-equal", fail: "increment-clamp", depthFail: "decrement-clamp", pass: "increment-wrap" },
      readMask: 0x0F,
      writeMask: 0xF0,
    },
  }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.depthStencil).toEqual({
    format: "depth24plus-stencil8",
    depthWriteEnabled: true,
    depthCompare: "less-equal",
    stencilFront: { compare: "equal", failOp: "zero", depthFailOp: "invert", passOp: "replace" },
    stencilBack: { compare: "not-equal", failOp: "increment-clamp", depthFailOp: "decrement-clamp", passOp: "increment-wrap" },
    stencilReadMask: 0x0F,
    stencilWriteMask: 0xF0,
  });
  gpu.dispose();
});

test("omitted back mirrors the normalized front", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-mirror", stencil: { front: { compare: "equal", pass: "replace" } } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  const face = { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" };
  expect(desc?.depthStencil?.stencilFront).toEqual(face);
  expect(desc?.depthStencil?.stencilBack).toEqual(face);
  gpu.dispose();
});

test("omitted front keeps spec defaults when only back is given", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-back-only", stencil: { back: { fail: "zero" } } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  // WebGPU applies GPUStencilFaceState defaults to the omitted front; the descriptor stays byte-identical there.
  expect(desc?.depthStencil?.stencilFront).toBeUndefined();
  expect(desc?.depthStencil?.stencilBack).toEqual({ compare: "always", failOp: "zero", depthFailOp: "keep", passOp: "keep" });
  gpu.dispose();
});

test("stencil merges with depth options and depth defaults", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-with-depth", depth: { write: false, compare: "greater" }, stencil: { front: {} } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-depth-off", depth: false, stencil: { readMask: 1 } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-no-depth-option", stencil: { writeMask: 2 } }).draw(colorTarget);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-3)?.depthStencil).toEqual({ format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "greater", stencilFront: KEEP_FACE, stencilBack: KEEP_FACE });
  expect(descs.at(-2)?.depthStencil).toEqual({ format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "always", stencilReadMask: 1 });
  // Stencil without a depth option still gets the depth defaults WebGPU requires for a depth-aspect format.
  expect(descs.at(-1)?.depthStencil).toEqual({ format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less-equal", stencilWriteMask: 2 });
  gpu.dispose();
});

test("absent stencil keeps the depthStencil descriptor free of stencil fields", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  draw(gpu, { shader: DRAW_SHADER, label: "stencil-absent" }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.depthStencil).toEqual({ format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less-equal" });
  gpu.dispose();
});

test("stencil ref is emitted as setStencilReference only when provided", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });

  draw(gpu, { shader: DRAW_SHADER, label: "ref-value", stencil: { front: { compare: "equal" }, ref: 3 } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "ref-zero", stencil: { front: { pass: "replace" }, ref: 0 } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "ref-absent", stencil: { front: { compare: "equal" } } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "ref-only", stencil: { ref: 7 } }).draw(colorTarget);

  expect(ops).toEqual([
    ["setPipeline"], ["setStencilReference", 3], ["draw"],
    // Explicit ref 0 still emits — it restores the pass default deterministically.
    ["setPipeline"], ["setStencilReference", 0], ["draw"],
    ["setPipeline"], ["draw"],
    ["setPipeline"], ["setStencilReference", 7], ["draw"],
  ]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("stencil ref is emitted per draw inside frame passes", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const masked = draw(gpu, { shader: DRAW_SHADER, label: "masked", stencil: { front: { compare: "equal" }, ref: 5 } });
  const plain = draw(gpu, { shader: DRAW_SHADER, label: "plain" });

  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, (p) => { p.draw(masked); p.draw(plain); }));

  expect(ops).toEqual([["setPipeline"], ["setStencilReference", 5], ["draw"], ["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("bundles reject recording draws with stencil ref but record ref-less stencil", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const withRef = draw(gpu, { shader: DRAW_SHADER, label: "with-ref", stencil: { front: { compare: "equal" }, ref: 1 } });
  const withoutRef = draw(gpu, { shader: DRAW_SHADER, label: "without-ref", stencil: { front: { compare: "equal" }, writeMask: 0xFF } });

  expect(() => bundle(gpu, { target: colorTarget, label: "refBundle" }, (b) => b.draw(withRef))).toThrowError(/VGPU-BUNDLE-STENCIL-REF|stencil\.ref/);
  expect(() => bundle(gpu, { target: colorTarget, label: "plainBundle" }, (b) => b.draw(withoutRef))).not.toThrow();
  gpu.dispose();
});

test("stencil requires a target signature whose depth format has a stencil aspect", async () => {
  const gpu = await init();
  const stencilTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const depthOnly = target(gpu, { size: [2, 2], depth: true });
  const noDepth = target(gpu, { size: [2, 2] });
  const drawable = draw(gpu, { shader: DRAW_SHADER, label: "needs-stencil", stencil: { front: { compare: "equal" } } });
  const refOnly = draw(gpu, { shader: DRAW_SHADER, label: "ref-needs-stencil", stencil: { ref: 1 } });

  expect(() => drawable.draw(depthOnly)).toThrowError(/VGPU-STENCIL-INVALID|depth24plus-stencil8/);
  expect(() => drawable.draw(noDepth)).toThrowError(/VGPU-STENCIL-INVALID|no depth/);
  expect(() => refOnly.draw(depthOnly)).toThrowError(/VGPU-STENCIL-INVALID|depth24plus-stencil8/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], depth: "depth32float" })).toThrowError(/VGPU-STENCIL-INVALID|stencil aspect/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], depth: "depth16unorm" })).toThrowError(/VGPU-STENCIL-INVALID|stencil aspect/);
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], depth: "depth24plus-stencil8" })).not.toThrow();
  expect(() => drawable.compileSync({ colors: ["rgba8unorm"], depth: "depth32float-stencil8" })).not.toThrow();
  expect(() => drawable.draw(stencilTarget)).not.toThrow();
  // targets: [...] compiles at construction, so the mismatch surfaces from draw itself.
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "eager-needs-stencil", targets: [depthOnly], stencil: { front: { compare: "equal" } } })).toThrowError(/VGPU-STENCIL-INVALID|depth24plus-stencil8/);
  gpu.dispose();
});

test("invalid stencil options fail at draw construction", async () => {
  const gpu = await init();
  const expectInvalid = (label: string, stencil: unknown): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, stencil: stencil as never })).toThrowError(/VGPU-STENCIL-INVALID|Invalid stencil/);
  };
  expectInvalid("st-true", true);
  expectInvalid("st-null", null);
  expectInvalid("st-string", "equal");
  expectInvalid("st-array", [{}]);
  expectInvalid("st-front-string", { front: "equal" });
  expectInvalid("st-front-array", { front: ["equal"] });
  expectInvalid("st-bad-compare", { front: { compare: "sometimes" } });
  expectInvalid("st-bad-fail", { front: { fail: "discard" } });
  expectInvalid("st-bad-depth-fail", { back: { depthFail: "flip" } });
  expectInvalid("st-bad-pass", { back: { pass: "keep-all" } });
  for (const mask of [1.5, -1, 0x1_0000_0000, Number.NaN, "255"]) {
    expectInvalid("st-bad-read-mask", { readMask: mask });
    expectInvalid("st-bad-write-mask", { writeMask: mask });
    expectInvalid("st-bad-ref", { ref: mask });
  }
  gpu.dispose();
});

test("frame.pass clearStencil threads into the depth-stencil attachment", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: 0xAB }, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, () => undefined));

  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ stencilLoadOp: "clear", stencilClearValue: 0xAB });
  expect(descriptors[1]?.depthStencilAttachment).toMatchObject({ stencilLoadOp: "clear", stencilClearValue: 0 });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("frame.pass validates clearStencil range, preserve, and stencil aspect", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });
  const depthOnly = target(gpu, { size: [2, 2], depth: true });
  const noDepth = target(gpu, { size: [2, 2] });
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: 0.5 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|clearStencil/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: -1 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|clearStencil/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: 0x1_0000_0000 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|clearStencil/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: Number.NaN }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|clearStencil/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: false, clearStencil: 1 }, () => undefined))).toThrowError(/VGPU-PASS-PRESERVE-CLEARSTENCIL|preserves stencil/);
  // Dead option: the value is masked to the stencil aspect's bit width, but a missing stencil aspect can never see it.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: depthOnly, clearStencil: 1 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|no stencil aspect/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: noDepth, clearStencil: 1 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARSTENCIL-INVALID|no stencil aspect/);
  // In-u32-range values above the 8-bit aspect width are legal; WebGPU masks them to the LSBs.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearStencil: 0x1FF }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("stencil participates in pipeline keys; ref does not", () => {
  const parts = { module: {} as GPUShaderModule, pipelineLayout: {} as GPUPipelineLayout, signature: { colors: ["rgba8unorm"] as const, depth: "depth24plus-stencil8" as const } };
  const stencilKey = "st~equal,keep,keep,replace~equal,keep,keep,replace~4294967295~4294967295";
  expect(pipelineKeyOf({ ...parts, stencilKey })).not.toBe(pipelineKeyOf(parts));
  expect(pipelineKeyOf({ ...parts, stencilKey })).not.toBe(pipelineKeyOf({ ...parts, stencilKey: "st~default~default~255~4294967295" }));
  expect(pipelineKeyOf({ ...parts, stencilKey: undefined })).toBe(pipelineKeyOf(parts));
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
          setStencilReference(reference: number) { ops.push(["setStencilReference", reference]); pass.setStencilReference(reference); },
          draw(...args: Parameters<GPURenderPassEncoder["draw"]>) { ops.push(["draw"]); pass.draw(...args); },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return ops;
}

function spyRenderPassDescriptors(device: GPUDevice): GPURenderPassDescriptor[] {
  const descriptors: GPURenderPassDescriptor[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        descriptors.push(renderPassDescriptor);
        return originalBeginRenderPass(renderPassDescriptor);
      },
    } as GPUCommandEncoder;
  });
  return descriptors;
}
