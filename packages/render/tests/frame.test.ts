import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, getMockGPUDeviceInstrumentation, type Device, type Shader } from "@vgpu/core";
import { beginFrame, createRenderBundle, createRenderPipeline } from "@vgpu/render";

interface RecordedRenderPass {
  readonly setPipeline: ReturnType<typeof vi.fn>;
  readonly setBindGroup: ReturnType<typeof vi.fn>;
  readonly setVertexBuffer: ReturnType<typeof vi.fn>;
  readonly executeBundles: ReturnType<typeof vi.fn>;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

test("encodes multiple render passes on one encoder and submits once", async () => {
  const { commandEncoder, device, passEncoders, submit } = await createFrameFixture();
  const frame = beginFrame(device, { label: "hero.frame" });

  frame.renderPass({ label: "light", colorAttachments: [colorAttachment()] }, (pass) => {
    pass.draw(3);
  });
  frame.renderPass({ label: "composite", colorAttachments: [colorAttachment()] }, (pass) => {
    pass.draw({ vertexCount: 6, instanceCount: 2 });
  });
  frame.submit();

  expect(device.gpu.createCommandEncoder).toHaveBeenCalledTimes(1);
  expect(commandEncoder.beginRenderPass).toHaveBeenCalledTimes(2);
  expect(commandEncoder.beginRenderPass).toHaveBeenNthCalledWith(1, expect.objectContaining({ label: "light" }));
  expect(commandEncoder.beginRenderPass).toHaveBeenNthCalledWith(2, expect.objectContaining({ label: "composite" }));
  expect(passEncoders[0]?.draw).toHaveBeenCalledWith(3, 1, 0, 0);
  expect(passEncoders[1]?.draw).toHaveBeenCalledWith(6, 2, 0, 0);
  expect(passEncoders[0]?.end).toHaveBeenCalledTimes(1);
  expect(passEncoders[1]?.end).toHaveBeenCalledTimes(1);
  expect(commandEncoder.finish).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(["frame-command-buffer"]);
  device.destroy();
});

test("keeps pass order in user-authored order", async () => {
  const { device, order } = await createFrameFixture();
  const frame = beginFrame(device);

  frame.renderPass({ label: "first", colorAttachments: [colorAttachment()] }, () => {
    order.push("first callback");
  });
  frame.gpu.copyBufferToBuffer({} as GPUBuffer, 0, {} as GPUBuffer, 0, 4);
  frame.renderPass({ label: "second", colorAttachments: [colorAttachment()] }, () => {
    order.push("second callback");
  });

  expect(order).toEqual(["begin first", "first callback", "end first", "copy", "begin second", "second callback", "end second"]);
  device.destroy();
});

test("exposes the raw command encoder as frame.gpu", async () => {
  const { commandEncoder, device } = await createFrameFixture();
  const frame = beginFrame(device);
  const querySet = {} as GPUQuerySet;

  frame.gpu.writeTimestamp(querySet, 0);

  expect(frame.gpu).toBe(commandEncoder);
  expect(commandEncoder.writeTimestamp).toHaveBeenCalledWith(querySet, 0);
  device.destroy();
});

test("copyBufferToBuffer unwraps buffers and writes to the frame encoder", async () => {
  const { commandEncoder, device } = await createFrameFixture();
  const src = device.createBuffer({ size: 16, usage: ["copy_src"] });
  const dst = device.createBuffer({ size: 16, usage: ["copy_dst"] });
  const frame = beginFrame(device);

  frame.copyBufferToBuffer(src, dst, 8, 4, 2);

  expect(commandEncoder.copyBufferToBuffer).toHaveBeenCalledWith(src.gpu, 4, dst.gpu, 2, 8);
  device.destroy();
});

test("homepage-grade frame keeps setup resources out of the per-frame hot path", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const shader = { gpu: device.gpu.createShaderModule({ label: "hero.shader", code: "" }) } as Shader;
  const pipeline = createRenderPipeline(device, {
    label: "hero.pipeline",
    shader,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
  });
  const buffers = Array.from({ length: 2 }, (_, index) => device.createBuffer({ label: `hero.buffer.${index}`, size: 16, usage: ["vertex"] }));
  const bindGroups = Array.from({ length: 2 }, (_, index) => device.gpu.createBindGroup({ label: `hero.bindGroup.${index}`, layout: {} as GPUBindGroupLayout, entries: [] }));
  const bundles = Array.from({ length: 5 }, (_, index) => createRenderBundle(device, {
    label: `hero.bundle.${index}`,
    colorFormats: ["rgba8unorm"],
    record(bundle) {
      bundle.setPipeline(pipeline);
      bundle.setBindGroup(0, bindGroups[index % bindGroups.length] ?? null);
      bundle.setVertexBuffer(0, buffers[index % buffers.length]?.gpu ?? null);
      bundle.draw(3);
    },
  }));
  const setupCounts = { ...getMockGPUDeviceInstrumentation(device.gpu).calls };
  const passEncoders: RecordedRenderPass[] = [];
  const commandEncoder = {
    beginRenderPass: vi.fn(() => {
      const passEncoder: RecordedRenderPass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        executeBundles: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(),
      };
      passEncoders.push(passEncoder);
      return passEncoder as unknown as GPURenderPassEncoder;
    }),
    copyBufferToBuffer: vi.fn(),
    finish: vi.fn(() => "hero-command-buffer" as unknown as GPUCommandBuffer),
  } as unknown as GPUCommandEncoder & { readonly beginRenderPass: ReturnType<typeof vi.fn>; readonly copyBufferToBuffer: ReturnType<typeof vi.fn>; readonly finish: ReturnType<typeof vi.fn> };
  device.gpu.createCommandEncoder = vi.fn(() => commandEncoder);
  const submit = vi.fn();
  device.queue.gpu.submit = submit;

  const frame = beginFrame(device, { label: "hero.frame" });
  frame.renderPass({ label: "light", colorAttachments: [colorAttachment()] }, (pass) => pass.executeBundles([bundles[0]!, bundles[1]!]));
  frame.gpu.copyBufferToBuffer(buffers[0]!.gpu, 0, buffers[1]!.gpu, 0, 16);
  frame.renderPass({ label: "scene", colorAttachments: [colorAttachment()] }, (pass) => pass.executeBundles([bundles[2]!, bundles[3]!]));
  frame.renderPass({ label: "composite", colorAttachments: [colorAttachment()] }, (pass) => pass.executeBundles([bundles[4]!]));
  frame.submit();

  const frameCounts = getMockGPUDeviceInstrumentation(device.gpu).calls;
  expect(device.gpu.createCommandEncoder).toHaveBeenCalledTimes(1);
  expect(commandEncoder.beginRenderPass).toHaveBeenCalledTimes(3);
  const executedBundleCount = passEncoders.reduce((count, pass) => {
    const [executedBundles] = pass.executeBundles.mock.calls[0] ?? [];
    return count + ((executedBundles as GPURenderBundle[] | undefined)?.length ?? 0);
  }, 0);
  expect(executedBundleCount).toBe(5);
  expect(commandEncoder.copyBufferToBuffer).toHaveBeenCalledWith(buffers[0]!.gpu, 0, buffers[1]!.gpu, 0, 16);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(frameCounts.createRenderPipeline).toBe(setupCounts.createRenderPipeline);
  expect(frameCounts.createBuffer).toBe(setupCounts.createBuffer);
  expect(frameCounts.createBindGroup).toBe(setupCounts.createBindGroup);
  expect(frameCounts.createRenderBundleEncoder).toBe(setupCounts.createRenderBundleEncoder);
  device.destroy();
});

test("prevents encoding after frame submit", async () => {
  const { device } = await createFrameFixture();
  const frame = beginFrame(device);

  frame.submit();

  expect(() => frame.renderPass({ colorAttachments: [colorAttachment()] }, () => {})).toThrow(/Frame cannot encode/);
  expect(() => frame.submit()).toThrow(/Frame cannot encode/);
  device.destroy();
});

test("ends a frame render pass when the callback throws", async () => {
  const { device, passEncoders } = await createFrameFixture();
  const frame = beginFrame(device);
  const error = new Error("record failed");

  expect(() => frame.renderPass({ colorAttachments: [colorAttachment()] }, () => {
    throw error;
  })).toThrow(error);

  expect(passEncoders[0]?.end).toHaveBeenCalledTimes(1);
  device.destroy();
});

async function createFrameFixture(): Promise<{
  readonly commandEncoder: GPUCommandEncoder & {
    readonly beginRenderPass: ReturnType<typeof vi.fn>;
    readonly copyBufferToBuffer: ReturnType<typeof vi.fn>;
    readonly finish: ReturnType<typeof vi.fn>;
    readonly writeTimestamp: ReturnType<typeof vi.fn>;
  };
  readonly device: Device;
  readonly order: string[];
  readonly passEncoders: RecordedRenderPass[];
  readonly submit: ReturnType<typeof vi.fn>;
}> {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const order: string[] = [];
  const passEncoders: RecordedRenderPass[] = [];
  const commandEncoder = {
    beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
      order.push(`begin ${descriptor.label ?? "pass"}`);
      const passEncoder: RecordedRenderPass = {
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        setVertexBuffer: vi.fn(),
        executeBundles: vi.fn(),
        draw: vi.fn(),
        end: vi.fn(() => order.push(`end ${descriptor.label ?? "pass"}`)),
      };
      passEncoders.push(passEncoder);
      return passEncoder as unknown as GPURenderPassEncoder;
    }),
    copyBufferToBuffer: vi.fn(() => order.push("copy")),
    finish: vi.fn(() => "frame-command-buffer" as unknown as GPUCommandBuffer),
    writeTimestamp: vi.fn(),
  } as unknown as GPUCommandEncoder & {
    readonly beginRenderPass: ReturnType<typeof vi.fn>;
    readonly copyBufferToBuffer: ReturnType<typeof vi.fn>;
    readonly finish: ReturnType<typeof vi.fn>;
    readonly writeTimestamp: ReturnType<typeof vi.fn>;
  };
  device.gpu.createCommandEncoder = vi.fn(() => commandEncoder);
  const submit = vi.fn();
  device.queue.gpu.submit = submit;
  return { commandEncoder, device, order, passEncoders, submit };
}

function colorAttachment(): GPURenderPassColorAttachment {
  return { view: {} as GPUTextureView, loadOp: "clear", storeOp: "store" };
}
