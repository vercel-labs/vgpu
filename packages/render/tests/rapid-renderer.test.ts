import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { App, Device } from "@vgpu/core";
import { RapidRenderer, type DrawSpec, type Material } from "@vgpu/render";

test("constructs against a mock-adapter device", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const renderer = new RapidRenderer(device);

  expect(renderer.gpu).toBe(device.gpu);
  device.destroy();
});

test("issues a render pass for the given pipeline and target", async () => {
  const recorder = createRecordingDevice();
  const device = new Device(recorder.gpu, null);
  const renderer = new RapidRenderer(device);

  await renderer.draw({ material: recorder.material, pipeline: recorder.pipeline, target: recorder.target, vertexCount: 3, clearValue: [0.1, 0.2, 0.3, 1] });

  expect(recorder.calls.map((call) => call.name)).toEqual([
    "createCommandEncoder",
    "beginRenderPass",
    "setPipeline",
    "setBindGroup",
    "draw",
    "end",
    "finish",
    "submit",
  ]);
  expect(recorder.colorAttachment()?.clearValue).toEqual([0.1, 0.2, 0.3, 1]);
});

test("awaits draw and resolves once commands are submitted", async () => {
  const recorder = createRecordingDevice();
  const device = new Device(recorder.gpu, null);
  const renderer = new RapidRenderer(device);

  await expect(renderer.draw({ material: recorder.material, pipeline: recorder.pipeline, target: recorder.target, vertexCount: 6 })).resolves.toBeUndefined();

  expect(recorder.calls.at(-1)?.name).toBe("submit");
});

test("defaults clear value to opaque black when omitted", async () => {
  const recorder = createRecordingDevice();
  const device = new Device(recorder.gpu, null);
  const renderer = new RapidRenderer(device);

  await renderer.draw({ material: recorder.material, pipeline: recorder.pipeline, target: recorder.target, vertexCount: 3 });

  expect(recorder.colorAttachment()?.clearValue).toEqual([0, 0, 0, 1]);
});

test("reaches no Dawn-specific properties", async () => {
  const recorder = createRecordingDevice();
  const device = new Device(recorder.gpu, null);
  const renderer = new RapidRenderer(device);

  await renderer.draw({ material: recorder.material, pipeline: recorder.pipeline, target: recorder.target, vertexCount: 3 });

  expect(recorder.propertiesRead).toEqual(["queue"]);
});

interface RecordedCall {
  readonly name: string;
}

interface RecordingDevice {
  readonly gpu: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly material: Material;
  readonly target: GPUTextureView;
  readonly calls: RecordedCall[];
  readonly propertiesRead: string[];
  colorAttachment(): GPURenderPassColorAttachment | undefined;
}

function createRecordingDevice(): RecordingDevice {
  const calls: RecordedCall[] = [];
  const propertiesRead: string[] = [];
  let passDescriptor: GPURenderPassDescriptor | undefined;
  const pipeline = {} as GPURenderPipeline;
  const material = { pipeline, params: { baseColor: [0, 0, 0] as const, metallic: 0, roughness: 0 } } as Material;
  const target = {} as GPUTextureView;
  const commandBuffer = {} as GPUCommandBuffer;
  const queue = { submit: () => calls.push({ name: "submit" }) } as unknown as GPUQueue;
  const pass = {
    setPipeline: () => calls.push({ name: "setPipeline" }),
    setBindGroup: () => calls.push({ name: "setBindGroup" }),
    draw: () => calls.push({ name: "draw" }),
    end: () => calls.push({ name: "end" }),
  } as unknown as GPURenderPassEncoder;
  const encoder = {
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
      calls.push({ name: "beginRenderPass" });
      passDescriptor = descriptor;
      return pass;
    },
    finish(): GPUCommandBuffer {
      calls.push({ name: "finish" });
      return commandBuffer;
    },
  } as unknown as GPUCommandEncoder;
  const base = {
    createCommandEncoder(): GPUCommandEncoder {
      calls.push({ name: "createCommandEncoder" });
      return encoder;
    },
    destroy() {},
  };
  const gpu = new Proxy(base, {
    get(targetDevice, property, receiver): unknown {
      if (property === "queue") {
        propertiesRead.push("queue");
        return queue;
      }
      return Reflect.get(targetDevice, property, receiver);
    },
  }) as unknown as GPUDevice;
  return { gpu, pipeline, material, target, calls, propertiesRead, colorAttachment: () => passDescriptor?.colorAttachments[0] ?? undefined };
}

function acceptsDrawSpec(spec: DrawSpec): DrawSpec {
  return spec;
}

void acceptsDrawSpec;
