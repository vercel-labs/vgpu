import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter, init, bundle, draw, effect, frame, surface, target } from "../src/mock.ts";
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
    const colorTarget = target(gpu, { size: [2, 2] });
    draw(gpu, { shader: DRAW_SHADER, blend: preset }).draw(colorTarget);
    const desc = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
    expect(desc?.fragment?.targets?.[0]).toMatchObject({ format: "rgba8unorm", blend: expected });
    gpu.dispose();
  }
});

test("custom blend defaults op and alpha; writeMask normalizes arrays", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  draw(gpu, { shader: DRAW_SHADER, label: "custom", blend: { color: { src: "one", dst: "zero" } }, writeMask: ["r", "g", "b"] }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "empty-mask", writeMask: [] }).draw(colorTarget);
  draw(gpu, { shader: DRAW_SHADER, label: "default-mask" }).draw(colorTarget);

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
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "badBlend", blend: "screen" as never })).toThrowError(/VGPU-BLEND-INVALID|Invalid blend/);
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "badObject", blend: { alpha: { src: "one", dst: "zero" } } as never })).toThrowError(/VGPU-BLEND-INVALID|Invalid blend/);
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "badMask", writeMask: "rgb" as never })).toThrowError(/VGPU-WRITEMASK-INVALID|Invalid writeMask/);
  expect(() => draw(gpu, { shader: DRAW_SHADER, label: "badChannel", writeMask: ["r", "x"] as never })).toThrowError(/VGPU-WRITEMASK-INVALID|Invalid writeMask/);
  gpu.dispose();
});

test("effect options pass blend and writeMask through to the fullscreen draw", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  effect(gpu, EFFECT_SHADER, { blend: "additive", writeMask: ["a"] }).draw(colorTarget);
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
  const colorTarget = target(gpu, { size: [2, 2], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: false }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]).toMatchObject({ loadOp: "load", storeOp: "store" });
  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toBeUndefined();
  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "load", depthStoreOp: "store" });
  expect(descriptors[0]?.depthStencilAttachment?.depthClearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("frame.pass rejects clear false with MSAA targets", async () => {
  const gpu = await init();
  const msaa = target(gpu, { size: [2, 2], msaa: true });
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: msaa, clear: false }, () => undefined))).toThrowError(/VGPU-PASS-PRESERVE-MSAA|preserve MSAA/);
  gpu.dispose();
});

test("clear color precedence: pass color > target.clearColor > built-in", async () => {
  const gpu = await init();
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const builtIn = target(gpu, { size: [2, 2] });
  const tinted = target(gpu, { size: [2, 2], clearColor: { r: 0.25, g: 0.5, b: 0.75, a: 1 } });

  expect(builtIn.clearColor).toEqual([0, 0, 0, 1]);
  expect(tinted.clearColor).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
  frame(gpu, (currentFrame) => currentFrame.pass(builtIn, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass({ target: tinted, clear: true }, () => undefined));
  frame(gpu, (currentFrame) => currentFrame.pass({ target: tinted, clear: [1, 0, 0, 1] }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  expect(descriptors[1]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0.25, g: 0.5, b: 0.75, a: 1 });
  expect(descriptors[2]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  gpu.dispose();
  vi.restoreAllMocks();
});

test("target.clearColor and surface.clearColor are mutable at runtime and validated", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const offscreen = target(gpu, { size: [2, 2] });
  const canvasSurface = surface(gpu, canvasLike(), { clearColor: [0, 0, 1, 1] });

  frame(gpu, (currentFrame) => currentFrame.pass(canvasSurface, () => undefined));
  offscreen.clearColor = [0.5, 0.5, 0.5, 1];
  canvasSurface.clearColor = { r: 0, g: 1, b: 0, a: 1 };
  frame(gpu, (currentFrame) => {
    currentFrame.pass(offscreen, () => undefined);
    currentFrame.pass(canvasSurface, () => undefined);
  });

  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0, g: 0, b: 1, a: 1 });
  expect(descriptors[1]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  expect(descriptors[2]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0, g: 1, b: 0, a: 1 });

  expect(() => { offscreen.clearColor = [0, 0, Number.NaN, 1] as never; }).toThrowError(/VGPU-CLEAR-COLOR-INVALID|Invalid target\.clearColor/);
  expect(() => { canvasSurface.clearColor = { r: 0, g: 0, b: 0 } as never; }).toThrowError(/VGPU-CLEAR-COLOR-INVALID|Invalid surface\.clearColor/);
  expect(() => target(gpu, { size: [2, 2], clearColor: "black" as never })).toThrowError(/Invalid target\.clearColor/);
  expect(() => surface(gpu, canvasLike(), { clearColor: [0, 0, 0] as never })).toThrowError(/Invalid surface\.clearColor/);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("surface render pass descriptors honor clear false within a frame", async () => {
  const gpu = await initBrowser({ adapter: createMockAdapter() });
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  const canvasSurface = surface(gpu, canvasLike());

  frame(gpu, (currentFrame) => currentFrame.pass({ target: canvasSurface, clear: false }, () => undefined));

  expect(descriptors[0]?.colorAttachments?.[0]).toMatchObject({ loadOp: "load", storeOp: "store" });
  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toBeUndefined();
  gpu.dispose();
  vi.restoreAllMocks();
});

test("bundles record and replay draws with blend without extending the replay signature", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [2, 2] });
  const drawable = draw(gpu, { shader: DRAW_SHADER, blend: "alpha" });

  const recorded = bundle(gpu, { target: colorTarget, label: "blendedBundle" }, (b) => b.draw(drawable));

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, (p) => p.bundles(recorded)))).not.toThrow();
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

test("target clear colors defensively copy inputs and outputs", async () => {
  const gpu = await init();
  const input = [0.1, 0.2, 0.3, 1] as [number, number, number, number];
  const first = target(gpu, { size: [2, 2], clearColor: input });
  const second = target(gpu, { size: [2, 2] });
  input[0] = 0.9;
  (first.clearColor as number[])[1] = 0.9;
  (second.clearColor as number[])[0] = 0.9;
  const descriptors = spyRenderPassDescriptors(gpu.device.gpu);
  frame(gpu, (current) => {
    current.pass(first, () => undefined);
    current.pass(second, () => undefined);
  });
  expect(descriptors[0]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
  expect(descriptors[1]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  gpu.dispose();
});
