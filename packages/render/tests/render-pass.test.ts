import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";

interface RecordedRenderPass {
  readonly setPipeline: ReturnType<typeof vi.fn>;
  readonly setBindGroup: ReturnType<typeof vi.fn>;
  readonly setVertexBuffer: ReturnType<typeof vi.fn>;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

test("sets bind group at index", async () => {
  const { device, passEncoder } = await createRenderPassFixture();
  const bindGroup = {} as GPUBindGroup;
  const pass = new RenderPass(device, { colorAttachments: [colorAttachment()] });

  pass.setBindGroup(2, bindGroup, [16, 32]);

  expect(passEncoder.setBindGroup).toHaveBeenCalledWith(2, bindGroup, [16, 32]);
  device.destroy();
});

test("sets vertex buffer at slot", async () => {
  const { device, passEncoder } = await createRenderPassFixture();
  const vertexBuffer = {} as GPUBuffer;
  const pass = new RenderPass(device, { colorAttachments: [colorAttachment()] });

  pass.setVertexBuffer(1, vertexBuffer, 64, 128);

  expect(passEncoder.setVertexBuffer).toHaveBeenCalledWith(1, vertexBuffer, 64, 128);
  device.destroy();
});

test("draws from object options", async () => {
  const { device, passEncoder } = await createRenderPassFixture();
  const pass = new RenderPass(device, { colorAttachments: [colorAttachment()] });

  pass.draw({ vertexCount: 3, instanceCount: 2, firstVertex: 1, firstInstance: 4 });

  expect(passEncoder.draw).toHaveBeenCalledWith(3, 2, 1, 4);
  device.destroy();
});

test("prevents encoding after end", async () => {
  const { device } = await createRenderPassFixture();
  const pass = new RenderPass(device, { colorAttachments: [colorAttachment()] });

  pass.end();

  expect(() => pass.setBindGroup(0, {} as GPUBindGroup)).toThrow(/RenderPass\.gpu/);
  try {
    pass.setBindGroup(0, {} as GPUBindGroup);
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-RENDER-PASS-ENDED" });
  }
  device.destroy();
});

async function createRenderPassFixture(): Promise<{ readonly device: Device; readonly passEncoder: RecordedRenderPass }> {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const passEncoder: RecordedRenderPass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const commandEncoder = {
    beginRenderPass: vi.fn(() => passEncoder as unknown as GPURenderPassEncoder),
    finish: vi.fn(() => ({} as GPUCommandBuffer)),
  };
  device.gpu.createCommandEncoder = vi.fn(() => commandEncoder as unknown as GPUCommandEncoder);
  return { device, passEncoder };
}

function colorAttachment(): GPURenderPassColorAttachment {
  return { view: {} as GPUTextureView, loadOp: "clear", storeOp: "store" };
}
