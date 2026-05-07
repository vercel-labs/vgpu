import { describe, expect, it, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { material, Mesh } from "@vgpu/render";
import { pass, renderTarget } from "@vgpu/render/passes";

describe("pass() spec overrides", () => {
  it("pass with RenderTarget honors spec.colorLoadOp 'load'", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const scene = makeScene(device);
    const target = await renderTarget({ device, size: [8, 4] });
    const descriptor = recordPass(device, () => pass({ ...scene, target, colorLoadOp: "load" }));

    expect(descriptor.colorAttachments[0]?.loadOp).toBe("load");
    device.destroy();
  });

  it("pass with RenderTarget honors spec.clearColor override", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const scene = makeScene(device);
    const target = await renderTarget({ device, size: [8, 4] });
    const clearColor = { r: 0.5, g: 0, b: 0, a: 1 };
    const descriptor = recordPass(device, () => pass({ ...scene, target, clearColor }));

    expect(descriptor.colorAttachments[0]?.clearValue).toEqual(clearColor);
    device.destroy();
  });

  it("pass with depth target honors spec.depthLoadOp 'load'", async () => {
    const { device } = await App.create({ adapter: createMockAdapter() });
    const scene = makeScene(device, "depth24plus");
    const target = await renderTarget({ device, size: [8, 4], depth: true });
    const descriptor = recordPass(device, () => pass({ ...scene, target, depthLoadOp: "load" }));

    expect(descriptor.depthStencilAttachment?.depthLoadOp).toBe("load");
    device.destroy();
  });
});

const TEST_VERTEX = /* wgsl */ `
struct VertexIn { @location(0) position: vec3f, @location(1) normal: vec3f };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.position, 1.0); }
`;
const TEST_FRAGMENT = /* wgsl */ `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;

function makeScene(device: Device, depthFormat: GPUTextureFormat | null = null) {
  return {
    material: material({ device, vertex: TEST_VERTEX, fragment: TEST_FRAGMENT, uniforms: {}, vertexLayout: "position-normal", targetFormat: "rgba8unorm", depthFormat }),
    mesh: Mesh.box({ device }),
  };
}

function recordPass(device: Device, render: () => void) {
  let descriptor: GPURenderPassDescriptor | undefined;
  const encoder = {
    beginRenderPass: vi.fn((next: GPURenderPassDescriptor) => {
      descriptor = next;
      return { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), setViewport: vi.fn(), setScissorRect: vi.fn(), end: vi.fn() } as unknown as GPURenderPassEncoder;
    }),
    finish: vi.fn(() => ({} as GPUCommandBuffer)),
  } as unknown as GPUCommandEncoder;
  vi.spyOn(device.gpu, "createCommandEncoder").mockReturnValue(encoder);
  vi.spyOn(device.queue.gpu, "submit");
  render();
  return descriptor as GPURenderPassDescriptor;
}
