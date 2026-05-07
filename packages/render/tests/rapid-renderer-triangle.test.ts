import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, Device } from "@vgpu/core";
import { createRenderPipeline, RapidRenderer, type Material } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

const TRIANGLE_WGSL = `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(0.0,  0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, -0.5)
  );
  var colors = array<vec3f, 3>(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0)
  );
  var out: VSOut;
  out.pos = vec4f(positions[vi], 0.0, 1.0);
  out.color = colors[vi];
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(
  "renders hello triangle via RapidRenderer.draw byte-equal to plain-WGSL snapshot",
  async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const target = device.createTexture({ size: [256, 256], format: "rgba8unorm", usage: ["render_attachment", "copy_src"] });
    const shader = device.createShader(compile(TRIANGLE_WGSL));
    const pipeline = createRenderPipeline(device, {
      shader,
      vertex: { entry: "vs_main" },
      fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });

    await new RapidRenderer(device).draw({ material: materialFor(pipeline), pipeline, target: target.createView(), vertexCount: 3 });

    const pixels = await target.read();
    const expected = PNG.sync.read(await readFile(join(process.cwd(), "packages/render/tests/__snapshots__/hello-triangle.png")));
    const actual = new PNG({ width: 256, height: 256 });
    actual.data.set(pixels);
    const mismatched = pixelmatch(actual.data, expected.data, null, 256, 256, { threshold: 0.001 });
    expect(mismatched).toBe(0);
    device.destroy();
  },
);

test("RapidRenderer.draw uses public core Device without raw Dawn assumptions", async () => {
  const recorder = createRecordingDevice();
  const device = new Device(recorder.gpu, null);
  const renderer = new RapidRenderer(device);

  await renderer.draw({ material: materialFor(recorder.pipeline), pipeline: recorder.pipeline, target: recorder.target, vertexCount: 3 });

  expect(recorder.calls).toEqual(["createCommandEncoder", "beginRenderPass", "setPipeline", "setBindGroup", "draw", "end", "finish", "submit"]);
  expect(recorder.propertyReads).toEqual(["queue", "createCommandEncoder", "submit"]);
  expect(recorder.colorAttachment()?.view).toBe(recorder.target);
  expect(recorder.colorAttachment()?.clearValue).toEqual([0, 0, 0, 1]);
});

interface RecordingDevice {
  readonly gpu: GPUDevice;
  readonly pipeline: GPURenderPipeline;
  readonly target: GPUTextureView;
  readonly calls: string[];
  readonly propertyReads: string[];
  colorAttachment(): GPURenderPassColorAttachment | undefined;
}

function createRecordingDevice(): RecordingDevice {
  const calls: string[] = [];
  const propertyReads: string[] = [];
  let passDescriptor: GPURenderPassDescriptor | undefined;
  const pipeline = {} as GPURenderPipeline;
  const target = {} as GPUTextureView;
  const commandBuffer = {} as GPUCommandBuffer;
  const queue = new Proxy({ submit: () => calls.push("submit") }, { get: recordProperty(propertyReads) }) as unknown as GPUQueue;
  const pass = {
    setPipeline: () => calls.push("setPipeline"),
    setBindGroup: () => calls.push("setBindGroup"),
    draw: () => calls.push("draw"),
    end: () => calls.push("end"),
  } as unknown as GPURenderPassEncoder;
  const encoder = {
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder {
      calls.push("beginRenderPass");
      passDescriptor = descriptor;
      return pass;
    },
    finish(): GPUCommandBuffer {
      calls.push("finish");
      return commandBuffer;
    },
  } as unknown as GPUCommandEncoder;
  const base = {
    createCommandEncoder(): GPUCommandEncoder {
      calls.push("createCommandEncoder");
      return encoder;
    },
    destroy() {},
    queue,
  };
  const gpu = new Proxy(base, { get: recordProperty(propertyReads) }) as unknown as GPUDevice;
  return { gpu, pipeline, target, calls, propertyReads, colorAttachment: () => passDescriptor?.colorAttachments[0] ?? undefined };
}

function materialFor(pipeline: GPURenderPipeline): Material {
  return { pipeline, params: { baseColor: [0, 0, 0] as const, metallic: 0, roughness: 0 } } as Material;
}

function recordProperty(propertyReads: string[]) {
  return (target: object, property: string | symbol, receiver: unknown): unknown => {
    if (typeof property === "string") propertyReads.push(property);
    return Reflect.get(target, property, receiver);
  };
}
