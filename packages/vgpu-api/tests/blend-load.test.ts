import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter, init } from "../src/mock.ts";
import { init as initBrowser } from "../src/index.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const EFFECT_SHADER = `
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.0, 1.0); }
`;

test("blend presets are emitted on render pipeline targets", async () => {
  const cases = [
    ["alpha", { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }],
    ["premultiplied", { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }],
    ["additive", { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } }],
  ] as const;

  for (const [preset, expected] of cases) {
    const gpu = await init();
    const target = gpu.target({ size: [2, 2] });
    gpu.draw({ shader: DRAW_SHADER, blend: preset }).draw(target);
    const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
    expect(desc?.fragment?.targets?.[0]).toMatchObject({ format: "rgba8unorm", blend: expected });
    gpu.dispose();
  }
});

test("custom blend defaults op and alpha; writeMask normalizes arrays", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  gpu.draw({ shader: DRAW_SHADER, label: "custom", blend: { color: { src: "one", dst: "zero" } }, writeMask: ["r", "g", "b"] }).draw(target);
  gpu.draw({ shader: DRAW_SHADER, label: "empty-mask", writeMask: [] }).draw(target);
  gpu.draw({ shader: DRAW_SHADER, label: "default-mask" }).draw(target);

  const descs = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors;
  expect(descs.at(-3)?.fragment?.targets?.[0]).toMatchObject({
    blend: { color: { srcFactor: "one", dstFactor: "zero", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" } },
    writeMask: 7,
  });
  expect(descs.at(-2)?.fragment?.targets?.[0]?.writeMask).toBe(0);
  expect(descs.at(-1)?.fragment?.targets?.[0]).toEqual({ format: "rgba8unorm" });
  gpu.dispose();
});

test("invalid blend and writeMask options fail at draw construction", async () => {
  const gpu = await init();
  expect(() => gpu.draw({ shader: DRAW_SHADER, label: "badBlend", blend: "screen" as never })).toThrowError(/VGPU-BLEND-INVALID|Invalid blend/);
  expect(() => gpu.draw({ shader: DRAW_SHADER, label: "badObject", blend: { alpha: { src: "one", dst: "zero" } } as never })).toThrowError(/VGPU-BLEND-INVALID|Invalid blend/);
  expect(() => gpu.draw({ shader: DRAW_SHADER, label: "badMask", writeMask: "rgb" as never })).toThrowError(/VGPU-WRITEMASK-INVALID|Invalid writeMask/);
  expect(() => gpu.draw({ shader: DRAW_SHADER, label: "badChannel", writeMask: ["r", "x"] as never })).toThrowError(/VGPU-WRITEMASK-INVALID|Invalid writeMask/);
  gpu.dispose();
});

test("effect options pass blend and writeMask through to the fullscreen draw", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  gpu.effect(EFFECT_SHADER, { blend: "additive", writeMask: ["a"] }).draw(target);
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.fragment?.targets?.[0]).toMatchObject({
    blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } },
    writeMask: 8,
  });
  gpu.dispose();
});

test("frame.pass clear false preserves color and depth attachments", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const target = gpu.target({ size: [2, 2], depth: true });

  gpu.frame((frame) => frame.pass({ target, clear: false }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]).toMatchObject({ loadOp: "load", storeOp: "store" });
  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toBeUndefined();
  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "load", depthStoreOp: "store" });
  expect(descriptors[0]?.depthStencilAttachment?.depthClearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("frame.pass rejects clear false with MSAA targets", async () => {
  const gpu = await init();
  const msaa = gpu.target({ size: [2, 2], msaa: true });
  expect(() => gpu.frame((frame) => frame.pass({ target: msaa, clear: false }, () => undefined))).toThrowError(/VGPU-PASS-PRESERVE-MSAA|preserve MSAA/);
  gpu.dispose();
});

test("gpu.clearColor defaults, assigns, and drives omitted or true pass clear", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const a = gpu.target({ size: [2, 2] });
  const b = gpu.target({ size: [2, 2] });

  expect(gpu.clearColor).toEqual([0, 0, 0, 1]);
  gpu.frame((frame) => frame.pass(a, () => undefined));
  gpu.clearColor = { r: 0.25, g: 0.5, b: 0.75, a: 1 };
  gpu.frame((frame) => frame.pass({ target: b, clear: true }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  expect(descriptors[1]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("gpu.clearColor validates assignments", async () => {
  const gpu = await init();
  expect(() => { gpu.clearColor = [0, 0, Number.NaN, 1] as never; }).toThrowError(/VGPU-CLEAR-COLOR-INVALID|gpu\.clearColor/);
  expect(() => { gpu.clearColor = { r: 0, g: 0, b: 0 } as never; }).toThrowError(/VGPU-CLEAR-COLOR-INVALID|gpu\.clearColor/);
  gpu.dispose();
});

test("surface render pass descriptors honor clear false within a frame", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const surface = gpu.surface(canvasLike());

  gpu.frame((frame) => frame.pass({ target: surface, clear: false }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]).toMatchObject({ loadOp: "load", storeOp: "store" });
  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("bundles record and replay draws with blend without extending the replay signature", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [2, 2] });
  const draw = gpu.draw({ shader: DRAW_SHADER, blend: "alpha" });

  const bundle = gpu.bundle({ target, label: "blendedBundle" }, (b) => b.draw(draw));

  expect(() => gpu.frame((frame) => frame.pass(target, (p) => p.bundles(bundle)))).not.toThrow();
  const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
  expect(desc?.fragment?.targets?.[0]).toMatchObject({ blend: { color: { srcFactor: "src-alpha" } } });
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

function canvasLike(): HTMLCanvasElement {
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) };
  const canvas = { width: 0, height: 0, clientWidth: 4, clientHeight: 4, getContext: (kind: string) => kind === "webgpu" ? context : null };
  return canvas as unknown as HTMLCanvasElement;
}
