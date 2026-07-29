import { expect, test, vi } from "vitest";
import { init, draw, effect, frame, target } from "../src/mock.ts";

const EFFECT_SHADER = `
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.5, 1.0);
}
`;

const DRAW_SHADER = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VertexOut;
  out.position = vec4f(pos[vertex], 0.0, 1.0);
  out.color = vec4f(0.2, 0.4, 0.8, 1.0);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  return in.color;
}
`;

test("frame.pass accepts a bare target with a callback", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const colorTarget = target(gpu, { size: [4, 4] });
    const shader1 = effect(gpu, EFFECT_SHADER, { label: "target-callback" });

    frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, (pass) => pass.draw(shader1)));

    expect(drawCalls).toEqual([[3, 1, 0, 0]]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("frame.pass routes Effect and Draw shortcut bodies through FramePass.draw", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const effectTarget = target(gpu, { size: [4, 4] });
    const drawTarget = target(gpu, { size: [4, 4] });
    const shader1 = effect(gpu, EFFECT_SHADER, { label: "shortcut-effect" });
    const drawable = draw(gpu, { shader: DRAW_SHADER, label: "shortcut-draw", vertices: 3 });

    frame(gpu, (currentFrame) => currentFrame.pass(effectTarget, shader1));
    frame(gpu, (currentFrame) => currentFrame.pass(drawTarget, drawable));

    expect(drawCalls).toEqual([
      [3, 1, 0, 0],
      [3, 1, 0, 0],
    ]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("frame.pass keeps option bags and honors clear with an Effect shortcut", async () => {
  const gpu = await init();
  const renderPasses = spyRenderPassDescriptors(gpu.device.gpu);
  try {
    const colorTarget = target(gpu, { size: [4, 4] });
    const shader1 = effect(gpu, EFFECT_SHADER, { label: "clear-shortcut" });

    frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, clear: [1, 0, 0, 1] }, shader1));

    expect(renderPasses[0]?.colorAttachments?.[0]?.clearValue).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("effect.draw accepts a bare target and keeps DrawCallOptions bags", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const colorTarget = target(gpu, { size: [4, 4] });
    const shader1 = effect(gpu, EFFECT_SHADER, { label: "effect-overload" });

    shader1.draw(colorTarget);
    shader1.draw({ target: colorTarget, instances: 2 });

    expect(drawCalls).toEqual([
      [3, 1, 0, 0],
      [3, 2, 0, 0],
    ]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("draw.draw accepts a bare target and keeps DrawCallOptions bags", async () => {
  const gpu = await init();
  const drawCalls = spyRenderPassDraws(gpu.device.gpu);
  try {
    const colorTarget = target(gpu, { size: [4, 4] });
    const drawable = draw(gpu, { shader: DRAW_SHADER, label: "draw-overload", vertices: 3 });

    drawable.draw(colorTarget);
    drawable.draw({ target: colorTarget, instances: 2 });
    await gpu.settled();

    expect(drawCalls).toEqual([
      [3, 1, 0, 0],
      [3, 2, 0, 0],
    ]);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("frame.pass overloads preserve existing target and drawable validation errors", async () => {
  const gpu = await init();
  try {
    const colorTarget = target(gpu, { size: [4, 4] });

    expectThrown(() => frame(gpu, (currentFrame) => currentFrame.pass({} as never, () => {})), { code: "VGPU-TARGET-REQUIRED" });
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, {} as never))).toThrowError(/Invalid Effect instance/);
  } finally {
    gpu.dispose();
  }
});

function expectThrown(fn: () => unknown, shape: Record<string, unknown>): void {
  try {
    fn();
    throw new Error("Expected function to throw");
  } catch (error) {
    expect(error).toMatchObject(shape);
  }
}

function spyRenderPassDraws(device: GPUDevice): unknown[][] {
  const drawCalls: unknown[][] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        const pass = originalBeginRenderPass(renderPassDescriptor);
        const originalDraw = pass.draw.bind(pass);
        return {
          ...pass,
          draw(...args: Parameters<GPURenderPassEncoder["draw"]>): void {
            drawCalls.push([...args]);
            originalDraw(...args);
          },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return drawCalls;
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
