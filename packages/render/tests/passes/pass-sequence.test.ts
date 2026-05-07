import { expect, test, vi } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, type Device } from "@vgpu/core";
import { material, Mesh } from "@vgpu/render";
import { passSequence, renderTarget } from "@vgpu/render/passes";

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
  readonly encoder: GPUCommandEncoder;
  readonly pass: RecordingPass;
  readonly beginRenderPass: ReturnType<typeof vi.fn>;
  readonly finish: ReturnType<typeof vi.fn>;
  readonly submit: ReturnType<typeof vi.spyOn>;
  descriptors(): readonly GPURenderPassDescriptor[];
}

test("passSequence runs each step in order", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const targets = await Promise.all([
    renderTarget({ device, size: [8, 4], label: "one" }),
    renderTarget({ device, size: [8, 4], label: "two" }),
    renderTarget({ device, size: [8, 4], label: "three" }),
  ]);
  const recorder = installRecorder(device);

  passSequence(targets.map((target) => ({ ...scene, target })));

  expect(recorder.descriptors().map((descriptor) => descriptor.colorAttachments[0]?.view)).toEqual([
    targets[0].gpu.colorAttachment.view,
    targets[1].gpu.colorAttachment.view,
    targets[2].gpu.colorAttachment.view,
  ]);
  device.destroy();
});

test("passSequence with shared device batches into one submit", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const targets = await Promise.all([
    renderTarget({ device, size: [8, 4] }),
    renderTarget({ device, size: [8, 4] }),
  ]);
  const recorder = installRecorder(device);

  passSequence(targets.map((target) => ({ ...scene, target })), { device });

  expect(recorder.submit).toHaveBeenCalledTimes(1);
  expect(recorder.finish).toHaveBeenCalledTimes(1);
  device.destroy();
});

test("passSequence handles 0 steps gracefully", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const createCommandEncoder = vi.spyOn(device.gpu, "createCommandEncoder");
  const submit = vi.spyOn(device.queue.gpu, "submit");

  expect(() => passSequence([])).not.toThrow();
  expect(() => passSequence([], { device })).not.toThrow();

  expect(createCommandEncoder).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  device.destroy();
});

test("passSequence propagates errors from individual passes", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const scene = makeScene(device);
  const targets = await Promise.all([
    renderTarget({ device, size: [8, 4] }),
    renderTarget({ device, size: [8, 4] }),
  ]);
  const recorder = installRecorder(device);
  const steps = [
    { ...scene, target: targets[0] },
    { ...scene, target: 7 as unknown as GPUTextureView },
    { ...scene, target: targets[1] },
  ];

  expect(() => passSequence(steps)).toThrowError(/RenderTarget, Texture, or GPUTextureView/);
  expect(recorder.beginRenderPass).toHaveBeenCalledTimes(1);
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
  const descriptors: GPURenderPassDescriptor[] = [];
  const passEncoder = {
    setViewport: vi.fn(), setScissorRect: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(), end: vi.fn(),
  } as unknown as RecordingPass;
  const beginRenderPass = vi.fn((descriptor: GPURenderPassDescriptor) => {
    descriptors.push(descriptor);
    return passEncoder as unknown as GPURenderPassEncoder;
  });
  const finish = vi.fn(() => ({} as GPUCommandBuffer));
  return {
    encoder: { beginRenderPass, finish } as unknown as GPUCommandEncoder,
    pass: passEncoder,
    beginRenderPass,
    finish,
    descriptors: () => descriptors,
  };
}
