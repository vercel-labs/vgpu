import { expect, test, vi } from "vitest";
import { Device, VGPUError, createMockGPUDevice, getMockGPUDeviceInstrumentation, type Shader } from "@vgpu/core";
import { createRenderPipeline, createRenderPipelineAsync, createRenderPipelineFromDescriptor, createRenderPipelineFromDescriptorAsync } from "@vgpu/render";
import { __resetCreateRenderPipelineAsyncFallbackWarningForTests } from "../src/pipeline.ts";

function makeDevice(): Device {
  return new Device(createMockGPUDevice(), null);
}

function makeShader(device: Device, _label = "shader"): Shader {
  return device.createShader(`
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(); }
`);
}

test("createRenderPipeline and createRenderPipelineAsync build parity descriptors", async () => {
  const device = makeDevice();
  const shader = makeShader(device);
  const opts = {
    label: "hero.pipeline",
    shader,
    layout: "auto" as const,
    vertex: {
      entry: "vs_main",
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" as const }] }],
    },
    fragment: {
      entry: "fs_main",
      targets: [{ format: "rgba8unorm" as const, blend: { color: { operation: "add" as const, srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const }, alpha: { operation: "add" as const, srcFactor: "one" as const, dstFactor: "one-minus-src-alpha" as const } }, writeMask: 0x1 | 0x2 }],
    },
    primitive: { topology: "triangle-list" as const, cullMode: "back" as const },
    depthStencil: { format: "depth24plus" as const, depthWriteEnabled: true, depthCompare: "less" as const },
    multisample: { count: 4, mask: 0xffffffff, alphaToCoverageEnabled: true },
  };

  createRenderPipeline(device, opts);
  await createRenderPipelineAsync(device, opts);

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.createRenderPipelineDescriptors[0]).toEqual(mock.createRenderPipelineAsyncDescriptors[0]);
  expect(mock.createRenderPipelineDescriptors[0]).toMatchObject({
    label: "hero.pipeline",
    layout: "auto",
    vertex: { module: shader.gpu, entryPoint: "vs_main", buffers: opts.vertex.buffers },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: opts.fragment.targets },
    primitive: opts.primitive,
    depthStencil: opts.depthStencil,
    multisample: opts.multisample,
  });
  device.destroy();
});

test("accepts raw GPUShaderModule and per-stage Shader modules with constants", async () => {
  const device = makeDevice();
  const vertexModule = device.gpu.createShaderModule({ label: "vertex", code: "" });
  const fragmentShader = makeShader(device, "fragment");

  await createRenderPipelineAsync(device, {
    label: "mixed-modules",
    layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [] }),
    vertex: { module: vertexModule, entryPoint: "vs", constants: { scale: 2 } },
    fragment: { shader: fragmentShader, entryPoint: "fs", constants: { enabled: true }, targets: [{ format: "bgra8unorm", writeMask: 0xf }] },
  });

  const [descriptor] = getMockGPUDeviceInstrumentation(device.gpu).createRenderPipelineAsyncDescriptors;
  expect(descriptor.vertex).toMatchObject({ module: vertexModule, entryPoint: "vs", constants: { scale: 2 } });
  expect(descriptor.fragment).toMatchObject({ module: fragmentShader.gpu, entryPoint: "fs", constants: { enabled: true }, targets: [{ format: "bgra8unorm", writeMask: 0xf }] });
  expect(descriptor.layout).not.toBe("auto");
  device.destroy();
});

test("forwards omitted entry points as undefined for WebGPU inference", async () => {
  const device = makeDevice();
  const shader = makeShader(device);

  createRenderPipeline(device, {
    shader,
    vertex: {},
    fragment: { targets: [{ format: "rgba8unorm" }] },
  });

  const [descriptor] = getMockGPUDeviceInstrumentation(device.gpu).createRenderPipelineDescriptors;
  expect(descriptor.vertex.entryPoint).toBeUndefined();
  expect(descriptor.fragment?.entryPoint).toBeUndefined();
  device.destroy();
});

test("throws VGPUError when shader module is missing", () => {
  const device = makeDevice();

  try {
    createRenderPipeline(device, {
      vertex: { entry: "vs" },
      fragment: { entry: "fs", targets: [{ format: "rgba8unorm" }] },
    });
    expect.fail("expected missing shader to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(VGPUError);
    expect(error).toMatchObject({
      code: "VGPU-RENDER-PIPELINE-MISSING-SHADER",
      where: "createRenderPipeline.vertex",
    });
  }
  device.destroy();
});

test("does not cache hidden render pipelines", async () => {
  const device = makeDevice();
  const shader = makeShader(device);
  const opts = { shader, vertex: { entry: "vs" }, fragment: { entry: "fs", targets: [{ format: "rgba8unorm" as const }] } };

  createRenderPipeline(device, opts);
  createRenderPipeline(device, opts);
  await createRenderPipelineAsync(device, opts);
  await createRenderPipelineAsync(device, opts);

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(2);
  expect(mock.calls.createRenderPipelineAsync).toBe(2);
  device.destroy();
});

test("createRenderPipelineAsync falls back to sync once with a diagnostic by default", async () => {
  __resetCreateRenderPipelineAsyncFallbackWarningForTests();
  const gpu = createMockGPUDevice();
  (gpu as { createRenderPipelineAsync?: GPUDevice["createRenderPipelineAsync"] }).createRenderPipelineAsync = undefined;
  const device = new Device(gpu, null);
  const shader = makeShader(device);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await createRenderPipelineAsync(device, { shader, vertex: { entry: "vs" }, fragment: { entry: "fs", targets: [{ format: "rgba8unorm" }] } });
  await createRenderPipelineAsync(device, { shader, vertex: { entry: "vs" }, fragment: { entry: "fs", targets: [{ format: "rgba8unorm" }] } });

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(2);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain("createRenderPipelineAsync");
  warn.mockRestore();
  device.destroy();
});

test("createRenderPipelineFromDescriptor forwards the raw descriptor unchanged", () => {
  const device = makeDevice();
  const shader = makeShader(device);
  const descriptor: GPURenderPipelineDescriptor = {
    label: "raw.pipeline",
    layout: "auto",
    vertex: { module: shader.gpu, entryPoint: "vs_main" },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  };

  createRenderPipelineFromDescriptor(device, descriptor);

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.createRenderPipelineDescriptors[0]).toBe(descriptor);
  device.destroy();
});

test("createRenderPipelineFromDescriptorAsync forwards the raw descriptor to the async path", async () => {
  const device = makeDevice();
  const shader = makeShader(device);
  const descriptor: GPURenderPipelineDescriptor = {
    label: "raw.async.pipeline",
    layout: "auto",
    vertex: { module: shader.gpu, entryPoint: "vs_main" },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
  };

  await createRenderPipelineFromDescriptorAsync(device, descriptor);

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipelineAsync).toBe(1);
  expect(mock.calls.createRenderPipeline).toBe(0);
  expect(mock.createRenderPipelineAsyncDescriptors[0]).toBe(descriptor);
  device.destroy();
});

test("createRenderPipelineFromDescriptorAsync falls back to sync once with a diagnostic by default", async () => {
  __resetCreateRenderPipelineAsyncFallbackWarningForTests();
  const gpu = createMockGPUDevice();
  (gpu as { createRenderPipelineAsync?: GPUDevice["createRenderPipelineAsync"] }).createRenderPipelineAsync = undefined;
  const device = new Device(gpu, null);
  const shader = makeShader(device);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const descriptor: GPURenderPipelineDescriptor = {
    layout: "auto",
    vertex: { module: shader.gpu, entryPoint: "vs_main" },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
  };

  await createRenderPipelineFromDescriptorAsync(device, descriptor);

  const mock = getMockGPUDeviceInstrumentation(device.gpu);
  expect(mock.calls.createRenderPipeline).toBe(1);
  expect(mock.calls.createRenderPipelineAsync).toBe(0);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
  device.destroy();
});

test("createRenderPipelineFromDescriptorAsync throws VGPUError when async is unavailable and fallback is throw", async () => {
  const gpu = createMockGPUDevice();
  (gpu as { createRenderPipelineAsync?: GPUDevice["createRenderPipelineAsync"] }).createRenderPipelineAsync = undefined;
  const device = new Device(gpu, null);
  const shader = makeShader(device);
  const descriptor: GPURenderPipelineDescriptor = {
    layout: "auto",
    vertex: { module: shader.gpu, entryPoint: "vs_main" },
    fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
  };

  await expect(createRenderPipelineFromDescriptorAsync(device, descriptor, "throw")).rejects.toMatchObject({
    name: "VGPUError",
    code: "VGPU-RENDER-PIPELINE-ASYNC-UNAVAILABLE",
    where: "createRenderPipelineFromDescriptorAsync",
  });
  expect(getMockGPUDeviceInstrumentation(device.gpu).calls.createRenderPipeline).toBe(0);
  device.destroy();
});

test("createRenderPipelineAsync throws VGPUError when async is unavailable and fallback is throw", async () => {
  const gpu = createMockGPUDevice();
  (gpu as { createRenderPipelineAsync?: GPUDevice["createRenderPipelineAsync"] }).createRenderPipelineAsync = undefined;
  const device = new Device(gpu, null);
  const shader = makeShader(device);

  await expect(createRenderPipelineAsync(device, {
    fallback: "throw",
    shader,
    vertex: { entry: "vs" },
    fragment: { entry: "fs", targets: [{ format: "rgba8unorm" }] },
  })).rejects.toMatchObject({
    name: "VGPUError",
    code: "VGPU-RENDER-PIPELINE-ASYNC-UNAVAILABLE",
    where: "createRenderPipelineAsync",
  });
  await expect(createRenderPipelineAsync(device, {
    fallback: "throw",
    shader,
    vertex: { entry: "vs" },
    fragment: { entry: "fs", targets: [{ format: "rgba8unorm" }] },
  })).rejects.toBeInstanceOf(VGPUError);
  expect(getMockGPUDeviceInstrumentation(device.gpu).calls.createRenderPipeline).toBe(0);
  device.destroy();
});
