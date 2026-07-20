import { expect, test, vi } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { init } from "../src/mock.ts";

const SOLID = `
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }
`;

const MRT = `
struct Out { @location(0) a: vec4f, @location(1) b: vec4f }
@fragment fn fs_main() -> Out {
  var out: Out;
  out.a = vec4f(1.0, 0.0, 0.0, 1.0);
  out.b = vec4f(0.0, 1.0, 0.0, 1.0);
  return out;
}
`;

test("MSAA render pass descriptors resolve color and discard transient attachments while non-MSAA stores", async () => {
  const gpu = await init();
  try {
    const msaa = gpu.target({ size: [4, 4], depth: true, msaa: true });
    const plain = gpu.target({ size: [4, 4], depth: true });

    const msaaDesc = msaa.renderPassDescriptor();
    const plainDesc = plain.renderPassDescriptor();
    const msaaColor = msaaDesc.colorAttachments[0];
    const plainColor = plainDesc.colorAttachments[0];

    expect(msaaColor?.resolveTarget).toBeDefined();
    expect(msaaColor?.storeOp).toBe("discard");
    expect(msaaDesc.depthStencilAttachment?.depthStoreOp).toBe("discard");
    expect(plainColor?.resolveTarget).toBeUndefined();
    expect(plainColor?.storeOp).toBe("store");
    expect(plainDesc.depthStencilAttachment?.depthStoreOp).toBe("store");
  } finally {
    gpu.dispose();
  }
});

test("MSAA targets compile pipelines with sample count 4", async () => {
  const gpu = await init();
  try {
    const target = gpu.target({ size: [4, 4], depth: true, msaa: true });
    const draw = gpu.effect(SOLID, { label: "msaa-solid" });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(draw)));

    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    expect(mock.createRenderPipelineDescriptors.at(-1)?.multisample?.count).toBe(4);
  } finally {
    gpu.dispose();
  }
});

test("invalid runtime msaa values throw VGPU-TARGET-MSAA-INVALID", async () => {
  const gpu = await init();
  try {
    for (const msaa of [2, 8]) {
      expectThrown(() => gpu.target({ size: [4, 4], msaa } as never), { code: "VGPU-TARGET-MSAA-INVALID" });
    }
  } finally {
    gpu.dispose();
  }
});

test("MSAA target with blend keeps resolve descriptor and blend pipeline state", async () => {
  const gpu = await init();
  const renderPasses = spyRenderPassDescriptors(gpu.device.gpu);
  try {
    const target = gpu.target({ size: [4, 4], format: "rgba8unorm", msaa: true });
    const draw = gpu.effect(SOLID, { label: "msaa-blend", blend: "alpha" });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(draw)));

    expect(renderPasses[0]?.colorAttachments[0]?.resolveTarget).toBeDefined();
    expect(renderPasses[0]?.colorAttachments[0]?.storeOp).toBe("discard");
    const mock = getMockGPUDeviceInstrumentation(gpu.device.gpu);
    const descriptor = mock.createRenderPipelineDescriptors.at(-1);
    expect(descriptor?.multisample?.count).toBe(4);
    expect(descriptor?.fragment?.targets[0]?.blend).toBeDefined();
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
  }
});

test("MRT MSAA targets resolve every color and compile all color states with sample count 4", async () => {
  const gpu = await init();
  const renderPasses = spyRenderPassDescriptors(gpu.device.gpu);
  try {
    const target = gpu.target({
      size: [4, 4],
      colors: [{ format: "rgba8unorm" }, { format: "rgba8unorm" }],
      msaa: true,
    });
    const draw = gpu.effect(MRT, { label: "mrt-msaa" });

    gpu.frame((frame) => frame.pass({ target }, (pass) => pass.draw(draw)));

    expect(renderPasses[0]?.colorAttachments).toHaveLength(2);
    for (const attachment of renderPasses[0]?.colorAttachments ?? []) {
      expect(attachment?.resolveTarget).toBeDefined();
      expect(attachment?.storeOp).toBe("discard");
    }
    const descriptor = getMockGPUDeviceInstrumentation(gpu.device.gpu).createRenderPipelineDescriptors.at(-1);
    expect(descriptor?.multisample?.count).toBe(4);
    expect(descriptor?.fragment?.targets).toHaveLength(2);
  } finally {
    gpu.dispose();
    vi.restoreAllMocks();
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
