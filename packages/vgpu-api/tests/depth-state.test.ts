import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init, draw, frame, target } from "../src/mock.ts";
import { pipelineKeyOf } from "../src/pipeline-store.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

test("omitted depth defaults to write with less-equal on depth targets", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  draw(gpu, { shader: DRAW_SHADER, label: "depth-default" }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.depthStencil).toEqual({ format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" });
  gpu.dispose();
});

test("depth false disables testing via always compare without writes", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  draw(gpu, { shader: DRAW_SHADER, label: "depth-off", depth: false }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.depthStencil).toEqual({ format: "depth24plus", depthWriteEnabled: false, depthCompare: "always" });
  gpu.dispose();
});

test("each depth field threads into the pipeline depthStencil state", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  draw(gpu, { shader: DRAW_SHADER, label: "depth-full", depth: { write: false, compare: "greater", bias: 2, biasSlopeScale: 1.5, biasClamp: 0.25 } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "depth-partial", depth: { compare: "less" } }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "depth-empty", depth: {} }).draw(colorTarget);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-3)?.depthStencil).toEqual({ format: "depth24plus", depthWriteEnabled: false, depthCompare: "greater", depthBias: 2, depthBiasSlopeScale: 1.5, depthBiasClamp: 0.25 });
  expect(descs.at(-2)?.depthStencil).toEqual({ format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" });
  expect(descs.at(-1)?.depthStencil).toEqual({ format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" });
  gpu.dispose();
});

test("targets without depth keep depthStencil undefined regardless of depth options", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  draw(gpu, { shader: DRAW_SHADER, label: "no-depth", depth: { compare: "greater", bias: 4 } }).draw(colorTarget);

  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.depthStencil).toBeUndefined();
  gpu.dispose();
});

test("depth participates in pipeline keys", () => {
  const parts = { module: {} as GPUShaderModule, pipelineLayout: {} as GPUPipelineLayout, signature: { colors: ["rgba8unorm"] as const, depth: "depth24plus" as const } };
  expect(pipelineKeyOf({ ...parts, depthKey: "1~less-equal~0~0~0" })).not.toBe(pipelineKeyOf(parts));
  expect(pipelineKeyOf({ ...parts, depthKey: "1~less-equal~0~0~0" })).not.toBe(pipelineKeyOf({ ...parts, depthKey: "0~always~0~0~0" }));
  expect(pipelineKeyOf({ ...parts, depthKey: undefined })).toBe(pipelineKeyOf(parts));
});

test("invalid depth options fail at draw construction", async () => {
  const gpu = await init();
  const expectInvalid = (label: string, depth: unknown): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, depth: depth as never })).toThrowError(/VGPU-DEPTH-INVALID|Invalid depth/);
  };
  expectInvalid("depth-true", true);
  expectInvalid("depth-null", null);
  expectInvalid("depth-string", "less");
  expectInvalid("depth-bad-write", { write: "yes" });
  expectInvalid("depth-bad-compare", { compare: "sometimes" });
  expectInvalid("depth-float-bias", { bias: 1.5 });
  expectInvalid("depth-nan-slope", { biasSlopeScale: Number.NaN });
  expectInvalid("depth-inf-clamp", { biasClamp: Number.POSITIVE_INFINITY });
  gpu.dispose();
});

test("depth bias outside the i32 range fails at draw construction", async () => {
  const gpu = await init();
  const expectInvalid = (label: string, bias: number): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, depth: { bias } })).toThrowError(/VGPU-DEPTH-INVALID|Invalid depth/);
  };
  expectInvalid("bias-over-i32", 2147483648);
  expectInvalid("bias-under-i32", -2147483649);
  expectInvalid("bias-huge", 1e12);
  // The i32 bounds themselves stay legal.
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bias-i32-max", depth: { bias: 2147483647 } })).not.toThrow();
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bias-i32-min", depth: { bias: -2147483648 } })).not.toThrow();
  gpu.dispose();
});

test("nonzero depth bias is rejected for non-triangle topologies", async () => {
  const gpu = await init();
  const expectInvalid = (label: string, topology: GPUPrimitiveTopology, depth: unknown): void => {
    expect(() => draw(gpu, { shader: DRAW_SHADER, label, geometry: { topology }, depth: depth as never })).toThrowError(/VGPU-DEPTH-INVALID|Invalid depth/);
  };
  expectInvalid("bias-line-list", "line-list", { bias: 1 });
  expectInvalid("slope-line-strip", "line-strip", { biasSlopeScale: 0.5 });
  expectInvalid("clamp-point-list", "point-list", { biasClamp: 0.5 });
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "zero-bias-lines", geometry: { topology: "line-list" }, depth: { bias: 0, compare: "less" } })).not.toThrow();
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "bias-strip", geometry: { topology: "triangle-strip", stripIndexFormat: "uint16" }, depth: { bias: 1 } })).not.toThrow();
  gpu.dispose();
});

test("frame.pass clearDepth threads into the depth attachment", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearDepth: 0 }, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, () => undefined));

  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", depthClearValue: 0 });
  expect(descriptors[1]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", depthClearValue: 1 });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("frame.pass validates clearDepth range and rejects it with clear false", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2], depth: true });
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearDepth: 2 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARDEPTH-INVALID|clearDepth/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearDepth: -0.5 }, () => undefined))).toThrowError(/VGPU-PASS-CLEARDEPTH-INVALID|clearDepth/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clearDepth: Number.NaN }, () => undefined))).toThrowError(/VGPU-PASS-CLEARDEPTH-INVALID|clearDepth/);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: false, clearDepth: 0 }, () => undefined))).toThrowError(/VGPU-PASS-PRESERVE-CLEARDEPTH|preserves depth/);
  gpu.dispose();
});

test("combined depth-stencil formats emit stencil ops on the attachment", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: "depth24plus-stencil8" });

  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: false }, () => undefined));

  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear", depthClearValue: 1, stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: 0 });
  expect(descriptors[1]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "load", stencilLoadOp: "load", stencilStoreOp: "store" });
  expect(descriptors[1]?.depthStencilAttachment?.stencilClearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("depth-only formats keep stencil ops off the attachment", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, () => undefined));

  expect(descriptors[0]?.depthStencilAttachment?.stencilLoadOp).toBeUndefined();
  expect(descriptors[0]?.depthStencilAttachment?.stencilStoreOp).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("stencil-only depth formats are rejected at target creation", async () => {
  const gpu = await init();
  expect(() => target(gpu, { size: [2, 2], depth: "stencil8" })).toThrowError(/VGPU-TARGET-DEPTH-STENCIL-ONLY|stencil-only/);
  gpu.dispose();
});

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
