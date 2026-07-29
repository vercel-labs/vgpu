import { expect, test, vi } from "vitest";
import { init, draw, frame, target } from "../src/mock.ts";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pos[vi], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

test("viewport is emitted once at pass open with defaults filled", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: DRAW_SHADER, label: "vp" });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: { width: 2, height: 1 } }, (p) => { p.draw(drawable); p.draw(drawable); }));

  // x/y default to 0 and minDepth/maxDepth to 0/1; the viewport is pass state, not per draw.
  expect(ops).toEqual([["setViewport", 0, 0, 2, 1, 0, 1], ["setPipeline"], ["draw"], ["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("viewport passes all fields through and allows fractional floats", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  // setViewport arguments are floats; fractional values and negative x/y are valid.
  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: { x: -0.5, y: 1.25, width: 1.5, height: 0.75, minDepth: 0.25, maxDepth: 0.75 } }, () => undefined));

  expect(ops).toEqual([["setViewport", -0.5, 1.25, 1.5, 0.75, 0.25, 0.75]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("scissor is emitted once at pass open", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: DRAW_SHADER, label: "sc" });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, scissor: [1, 0, 2, 3] }, (p) => p.draw(drawable)));

  expect(ops).toEqual([["setScissorRect", 1, 0, 2, 3], ["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("viewport and scissor together emit viewport first", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: { x: 1, y: 1, width: 2, height: 2 }, scissor: [1, 1, 2, 2] }, () => undefined));

  expect(ops).toEqual([["setViewport", 1, 1, 2, 2, 0, 1], ["setScissorRect", 1, 1, 2, 2]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("passes without viewport or scissor emit neither", async () => {
  const gpu = await init();
  const ops = spyRenderPassOps(gpu.device.gpu);
  const colorTarget = target(gpu, { size: [4, 4] });
  const drawable = draw(gpu, { shader: DRAW_SHADER, label: "plain" });

  frame(gpu, (currentFrame) => {
    currentFrame.pass(colorTarget, (p) => p.draw(drawable));
    currentFrame.pass({ target: colorTarget, clear: false }, (p) => p.draw(drawable));
  });

  expect(ops).toEqual([["setPipeline"], ["draw"], ["setPipeline"], ["draw"]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

test("invalid viewport shapes and values fail at pass open", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const expectInvalid = (viewport: unknown): void => {
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: viewport as never }, () => undefined))).toThrowError(/VGPU-PASS-VIEWPORT-INVALID|Invalid viewport/);
  };
  expectInvalid("full");
  expectInvalid([0, 0, 2, 2]);
  expectInvalid({ height: 2 }); // width required
  expectInvalid({ width: 2 }); // height required
  expectInvalid({ width: "2", height: 2 });
  expectInvalid({ width: Number.NaN, height: 2 });
  expectInvalid({ x: Number.POSITIVE_INFINITY, width: 2, height: 2 });
  expectInvalid({ width: 2, height: 2, minDepth: -0.1 });
  expectInvalid({ width: 2, height: 2, maxDepth: 1.5 });
  expectInvalid({ width: 2, height: 2, minDepth: 0.8, maxDepth: 0.2 }); // minDepth <= maxDepth required
  gpu.dispose();
});

test("viewport bounds mirror device limits, not the target size", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const max = gpu.device.gpu.limits.maxTextureDimension2D;
  const maxViewportRange = max * 2;
  const expectInvalid = (viewport: unknown): void => {
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: viewport as never }, () => undefined))).toThrowError(/VGPU-PASS-VIEWPORT-INVALID|Invalid viewport/);
  };
  expectInvalid({ width: -1, height: 2 }); // 0 <= width
  expectInvalid({ width: max + 1, height: 2 }); // width <= maxTextureDimension2D
  expectInvalid({ width: 2, height: max + 1 }); // height <= maxTextureDimension2D
  expectInvalid({ x: -maxViewportRange - 1, width: 2, height: 2 }); // x >= -2 * maxTextureDimension2D
  expectInvalid({ x: maxViewportRange - 1, width: 1, height: 2 }); // x + width <= 2 * maxTextureDimension2D - 1
  expectInvalid({ y: maxViewportRange - 1, width: 2, height: 1 }); // y + height <= 2 * maxTextureDimension2D - 1
  // Unlike scissor, the viewport may exceed the attachment and reach into negative space.
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: { x: -8, y: -8, width: 16, height: 16 } }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("out-of-limit viewport errors report the target's current pixel size", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [6, 3] });
  const max = gpu.device.gpu.limits.maxTextureDimension2D;
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, viewport: { width: max + 1, height: 2 } }, () => undefined))).toThrowError(/6x3px/);
  gpu.dispose();
});

test("invalid scissor shapes and values fail at pass open", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const expectInvalid = (scissor: unknown): void => {
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, scissor: scissor as never }, () => undefined))).toThrowError(/VGPU-PASS-SCISSOR-INVALID|Invalid scissor/);
  };
  expectInvalid("full");
  expectInvalid({ x: 0, y: 0, width: 2, height: 2 });
  expectInvalid([0, 0, 2]);
  expectInvalid([0, 0, 2, 2, 2]);
  expectInvalid([0, 0, "2", 2]);
  expectInvalid([-1, 0, 2, 2]); // GPUIntegerCoordinate is non-negative
  expectInvalid([0, 0, 1.5, 2]); // integers required
  expectInvalid([0, 0, Number.NaN, 2]);
  gpu.dispose();
});

test("out-of-bounds scissor errors report the target's current pixel size", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 2] });
  const expectOutOfBounds = (scissor: readonly [number, number, number, number]): void => {
    expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, scissor }, () => undefined))).toThrowError(/VGPU-PASS-SCISSOR-INVALID.*4x2px|4x2px/);
  };
  expectOutOfBounds([0, 0, 5, 2]); // x + width <= attachment width
  expectOutOfBounds([2, 0, 3, 2]);
  expectOutOfBounds([0, 1, 4, 2]); // y + height <= attachment height
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, scissor: [0, 0, 4, 2] }, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("scissor bounds re-validate against the target's current size after resize", async () => {
  const gpu = await init();
  const colorTarget = target(gpu, { size: [4, 4] });
  const opts = { target: colorTarget, scissor: [0, 0, 4, 4] } as const;

  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(opts, () => undefined))).not.toThrow();
  colorTarget.resize([2, 2]);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(opts, () => undefined))).toThrowError(/2x2px/);
  colorTarget.resize([8, 8]);
  expect(() => frame(gpu, (currentFrame) => currentFrame.pass(opts, () => undefined))).not.toThrow();
  gpu.dispose();
});

test("scissor does not affect the clear; the pass still clears the full attachment", async () => {
  const gpu = await init();
  const descriptors: GPURenderPassDescriptor[] = [];
  const ops = spyRenderPassOps(gpu.device.gpu, descriptors);
  const colorTarget = target(gpu, { size: [4, 4], depth: true });

  frame(gpu, (currentFrame) => currentFrame.pass({ target: colorTarget, scissor: [1, 1, 2, 2] }, () => undefined));

  // The clear comes from loadOp "clear" on the full attachment at beginRenderPass; the scissor only applies to draws.
  const colorAttachment = [...(descriptors[0]?.colorAttachments ?? [])][0];
  expect(colorAttachment).toMatchObject({ loadOp: "clear" });
  expect(descriptors[0]?.depthStencilAttachment).toMatchObject({ depthLoadOp: "clear" });
  expect(ops).toEqual([["setScissorRect", 1, 1, 2, 2]]);
  gpu.dispose();
  vi.restoreAllMocks();
});

type PassOp = readonly [name: string, ...args: unknown[]];

function spyRenderPassOps(device: GPUDevice, descriptors?: GPURenderPassDescriptor[]): PassOp[] {
  const ops: PassOp[] = [];
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor?: GPUCommandEncoderDescriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    return {
      ...encoder,
      beginRenderPass(renderPassDescriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
        descriptors?.push(renderPassDescriptor);
        const pass = originalBeginRenderPass(renderPassDescriptor);
        return {
          ...pass,
          setPipeline(pipeline: GPURenderPipeline) { ops.push(["setPipeline"]); pass.setPipeline(pipeline); },
          setViewport(...args: Parameters<GPURenderPassEncoder["setViewport"]>) { ops.push(["setViewport", ...args]); pass.setViewport(...args); },
          setScissorRect(...args: Parameters<GPURenderPassEncoder["setScissorRect"]>) { ops.push(["setScissorRect", ...args]); pass.setScissorRect(...args); },
          draw(...args: Parameters<GPURenderPassEncoder["draw"]>) { ops.push(["draw"]); pass.draw(...args); },
        } as GPURenderPassEncoder;
      },
    } as GPUCommandEncoder;
  });
  return ops;
}
