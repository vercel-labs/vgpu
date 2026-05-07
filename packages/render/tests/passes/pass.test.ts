import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { material, Mesh } from "@vgpu/render";
import { pass, renderTarget } from "@vgpu/render/passes";

interface RecordingPass {
  readonly setViewport: ReturnType<typeof vi.fn>;
  readonly setScissorRect: ReturnType<typeof vi.fn>;
  readonly setPipeline: ReturnType<typeof vi.fn>;
  readonly setBindGroup: ReturnType<typeof vi.fn>;
  readonly setVertexBuffer: ReturnType<typeof vi.fn>;
  readonly setIndexBuffer: ReturnType<typeof vi.fn>;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly drawIndexed: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

interface Recorder {
  readonly pass: RecordingPass;
  readonly beginRenderPass: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.spyOn>;
  descriptor(): GPURenderPassDescriptor;
}

test("pass with RenderTarget renders to correct attachment", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const target = await renderTarget({ device, size: [8, 4] });
  const recorder = installRecorder(device);

  pass({ ...scene, target });

  const descriptor = recorder.descriptor();
  expect(descriptor.colorAttachments[0]?.view).toBe(target.gpu.colorAttachment.view);
  expect(descriptor.colorAttachments[0]?.resolveTarget).toBeUndefined();
  expect(descriptor.depthStencilAttachment).toBeUndefined();
  device.destroy();
});

test("pass with Texture target renders directly", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const texture = device.createTexture({ size: [8, 4], format: "rgba8unorm", usage: ["render_attachment"] });
  const view = { label: "texture.view" } as GPUTextureView;
  vi.spyOn(texture.gpu, "createView").mockReturnValue(view);
  const recorder = installRecorder(device);

  pass({ ...scene, target: texture });

  expect(recorder.descriptor().colorAttachments[0]?.view).toBe(view);
  expect(recorder.descriptor().depthStencilAttachment).toBeUndefined();
  device.destroy();
});

test("pass with GPUTextureView target renders directly", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const view = { label: "raw.view" } as GPUTextureView;
  const recorder = installRecorder(device);

  pass({ ...scene, target: view, viewport: [1, 2, 3, 4] });

  expect(recorder.descriptor().colorAttachments[0]?.view).toBe(view);
  expect(recorder.pass.setViewport).toHaveBeenCalledWith(1, 2, 3, 4, 0, 1);
  device.destroy();
});

test("pass with caller-provided encoder defers submit", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const recorder = createRecorder();
  const submit = vi.spyOn(device.queue.gpu, "submit");

  pass({ ...scene, target: { label: "raw.view" } as GPUTextureView, encoder: recorder.encoder });

  expect(submit).not.toHaveBeenCalled();
  expect(recorder.beginRenderPass).toHaveBeenCalled();
  device.destroy();
});

test("pass with depth target renders depth attachment", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const color = device.createTexture({ size: [8, 4], format: "rgba8unorm", usage: ["render_attachment"] });
  const depth = device.createTexture({ size: [8, 4], format: "depth24plus", usage: ["render_attachment"] });
  const depthView = { label: "depth.view" } as GPUTextureView;
  vi.spyOn(depth.gpu, "createView").mockReturnValue(depthView);
  const recorder = installRecorder(device);

  pass({ ...scene, target: color, depthTarget: depth });

  expect(recorder.descriptor().depthStencilAttachment).toMatchObject({
    view: depthView,
    depthLoadOp: "clear",
    depthStoreOp: "store",
    depthClearValue: 1,
  });
  device.destroy();
});

test("pass without depth omits depth attachment", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const target = device.createTexture({ size: [8, 4], format: "rgba8unorm", usage: ["render_attachment"] });
  const recorder = installRecorder(device);

  pass({ ...scene, target });

  expect(recorder.descriptor().depthStencilAttachment).toBeUndefined();
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

function installRecorder(device: Device): Recorder {
  const recorder = createRecorder();
  vi.spyOn(device.gpu, "createCommandEncoder").mockReturnValue(recorder.encoder);
  const submit = vi.spyOn(device.queue.gpu, "submit");
  return { ...recorder, submit };
}

function createRecorder() {
  let descriptor: GPURenderPassDescriptor | undefined;
  const passEncoder = {
    setViewport: vi.fn(), setScissorRect: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(),
  } as unknown as RecordingPass;
  const beginRenderPass = vi.fn((desc: GPURenderPassDescriptor) => { descriptor = desc; return passEncoder as unknown as GPURenderPassEncoder; });
  const finish = vi.fn(() => ({} as GPUCommandBuffer));
  return {
    encoder: { beginRenderPass, finish } as unknown as GPUCommandEncoder,
    pass: passEncoder,
    beginRenderPass,
    finish,
    descriptor: () => descriptor as GPURenderPassDescriptor,
  };
}
