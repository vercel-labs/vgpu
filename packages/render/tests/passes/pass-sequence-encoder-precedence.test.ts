import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { material, Mesh } from "@vgpu/render";
import { passSequence, renderTarget } from "@vgpu/render/passes";

test("passSequence step.encoder takes precedence over options.encoder", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const targets = await Promise.all([
    renderTarget({ device, size: [8, 4], label: "one" }),
    renderTarget({ device, size: [8, 4], label: "two" }),
    renderTarget({ device, size: [8, 4], label: "three" }),
  ]);
  const shared = createRecorder();
  const override = createRecorder();

  passSequence([
    { ...scene, target: targets[0] },
    { ...scene, target: targets[1], encoder: override.encoder },
    { ...scene, target: targets[2] },
  ], { device, encoder: shared.encoder });

  expect(shared.beginRenderPass).toHaveBeenCalledTimes(2);
  expect(override.beginRenderPass).toHaveBeenCalledTimes(1);
  expect(shared.views).toEqual([targets[0].gpu.colorAttachment.view, targets[2].gpu.colorAttachment.view]);
  expect(override.views).toEqual([targets[1].gpu.colorAttachment.view]);
  device.destroy();
});

const TEST_VERTEX = /* wgsl */ `
struct VertexIn { @location(0) position: vec3f, @location(1) normal: vec3f };
@vertex fn vs_main(in: VertexIn) -> @builtin(position) vec4f { return vec4f(in.position, 1.0); }
`;
const TEST_FRAGMENT = /* wgsl */ `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`;

function makeScene(device: Device) {
  return {
    material: material({ device, vertex: TEST_VERTEX, fragment: TEST_FRAGMENT, uniforms: {}, vertexLayout: "position-normal", targetFormat: "rgba8unorm", depthFormat: null }),
    mesh: Mesh.box({ device }),
  };
}

function createRecorder() {
  const views: (GPUTextureView | undefined)[] = [];
  const beginRenderPass = vi.fn((descriptor: GPURenderPassDescriptor) => {
    views.push(descriptor.colorAttachments[0]?.view);
    return { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), setViewport: vi.fn(), setScissorRect: vi.fn(), end: vi.fn() } as unknown as GPURenderPassEncoder;
  });
  return {
    encoder: { beginRenderPass, finish: vi.fn(() => ({} as GPUCommandBuffer)) } as unknown as GPUCommandEncoder,
    beginRenderPass,
    views,
  };
}
