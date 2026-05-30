import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { RenderPass, createRenderBundle } from "@vgpu/render";

interface RecordedBundleEncoder {
  readonly setPipeline: ReturnType<typeof vi.fn>;
  readonly setBindGroup: ReturnType<typeof vi.fn>;
  readonly setVertexBuffer: ReturnType<typeof vi.fn>;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
}

test("records a render bundle at setup time and returns the finished bundle", async () => {
  const { bundle, bundleEncoder, device } = await createBundleFixture();
  const pipeline = {} as GPURenderPipeline;
  const bindGroup = {} as GPUBindGroup;
  const vertexBuffer = {} as GPUBuffer;

  const result = createRenderBundle(device, {
    label: "hero.light-sources.bundle",
    colorFormats: ["rgba8unorm"],
    depthStencilFormat: "depth24plus",
    sampleCount: 1,
    record(recorder) {
      recorder.setPipeline(pipeline);
      recorder.setBindGroup(0, bindGroup);
      recorder.setVertexBuffer(0, vertexBuffer, 16, 32);
      recorder.draw(3);
    },
  });

  expect(result).toBe(bundle);
  expect(device.gpu.createRenderBundleEncoder).toHaveBeenCalledWith({
    label: "hero.light-sources.bundle",
    colorFormats: ["rgba8unorm"],
    depthStencilFormat: "depth24plus",
    sampleCount: 1,
    depthReadOnly: undefined,
    stencilReadOnly: undefined,
  });
  expect(bundleEncoder.setPipeline).toHaveBeenCalledWith(pipeline);
  expect(bundleEncoder.setBindGroup).toHaveBeenCalledWith(0, bindGroup, undefined);
  expect(bundleEncoder.setVertexBuffer).toHaveBeenCalledWith(0, vertexBuffer, 16, 32);
  expect(bundleEncoder.draw).toHaveBeenCalledWith(3, 1, 0, 0);
  expect(bundleEncoder.finish).toHaveBeenCalledWith({ label: "hero.light-sources.bundle" });
  device.destroy();
});

test("executeBundles forwards to the render pass encoder", async () => {
  const { bundle, device } = await createBundleFixture();
  const passEncoder = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    executeBundles: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const commandEncoder = {
    beginRenderPass: vi.fn(() => passEncoder as unknown as GPURenderPassEncoder),
    finish: vi.fn(() => ({} as GPUCommandBuffer)),
  };
  device.gpu.createCommandEncoder = vi.fn(() => commandEncoder as unknown as GPUCommandEncoder);
  device.queue.gpu.submit = vi.fn();
  const pass = new RenderPass(device, { colorAttachments: [{ view: {} as GPUTextureView, loadOp: "clear", storeOp: "store" }] });

  pass.executeBundles([bundle]);

  expect(passEncoder.executeBundles).toHaveBeenCalledWith([bundle]);
  pass.end();
  device.destroy();
});

async function createBundleFixture(): Promise<{
  readonly bundle: GPURenderBundle;
  readonly bundleEncoder: RecordedBundleEncoder;
  readonly device: Device;
}> {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const bundle = {} as GPURenderBundle;
  const bundleEncoder: RecordedBundleEncoder = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw: vi.fn(),
    finish: vi.fn(() => bundle),
  };
  device.gpu.createRenderBundleEncoder = vi.fn(() => bundleEncoder as unknown as GPURenderBundleEncoder);
  return { bundle, bundleEncoder, device };
}
