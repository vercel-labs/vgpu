import { expect, test } from "vitest";
import { getMockGPUDeviceInstrumentation } from "@vgpu/core";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { resolveShader, type ResolvedShader } from "@vgpu/wgsl/runtime";
import type { HostShareableLayout } from "../src/runtime/reflect.ts";
import { writeLayoutValue } from "./reflection-test-utils.ts";

const GPU_BUFFER_USAGE = { MAP_READ: 1, COPY_DST: 8, COPY_SRC: 4, UNIFORM: 64, STORAGE: 128 } as const;
const GPU_SHADER_STAGE = { FRAGMENT: 2, COMPUTE: 4 } as const;
const GPU_TEXTURE_USAGE = { COPY_SRC: 1, RENDER_ATTACHMENT: 16 } as const;
const GPU_MAP_MODE = { READ: 1 } as const;

const TOY_WGSL = `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vi], 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(params.time * params.speed, 0.0, 0.0, 1.0);
}
`;

test("toy gpu.pass().set() prototype writes reflected uniforms in-place with stable bind groups on mock", async () => {
  const device = await createMockAdapter().requestDevice();
  const reflected = await resolveShader({ entry: "/toy.wgsl", validate: false, modules: { "/toy.wgsl": TOY_WGSL } });
  const pass = new ToyPass(device.gpu, reflected);
  const instrumentation = getMockGPUDeviceInstrumentation(device.gpu);

  pass.set({ time: 1.25, speed: 2 });
  pass.set({ time: 0.5 });

  expect(pass.values).toEqual({ time: 0.5, speed: 2 });
  expect(instrumentation.calls.createBindGroup).toBe(1);
  expect(instrumentation.calls.createBuffer).toBe(1);
  expect(new Float32Array(pass.bytes.slice(0, 8))).toEqual(new Float32Array([0.5, 2]));
  // Mock-mode pixel assertion for this toy shader's deterministic fragment expression.
  expect(pass.cpuPixel()).toEqual([1, 0, 0, 1]);
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("toy gpu.pass().set() prototype renders offscreen using reflected layout on Dawn", async () => {
  const device = await createNodeAdapter().requestDevice();
  try {
    const reflected = await resolveShader({ entry: "/toy.wgsl", validate: true, modules: { "/toy.wgsl": TOY_WGSL } });
    const pass = new ToyPass(device.gpu, reflected);
    pass.set({ time: 0.5, speed: 1 });

    const shader = device.gpu.createShaderModule({ code: reflected.wgsl });
    const pipeline = device.gpu.createRenderPipeline({
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [pass.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const target = device.gpu.createTexture({ size: [4, 4], format: "rgba8unorm", usage: GPU_TEXTURE_USAGE.RENDER_ATTACHMENT | GPU_TEXTURE_USAGE.COPY_SRC });
    const readback = device.gpu.createBuffer({ size: 256 * 4, usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST });
    const encoder = device.gpu.createCommandEncoder();
    const render = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    render.setPipeline(pipeline);
    render.setBindGroup(0, pass.bindGroup);
    render.draw(3);
    render.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [4, 4]);
    device.gpu.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPU_MAP_MODE.READ);
    const pixels = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    const reds = [0, 4, 8, 12].map((x) => pixels[x] ?? 0);
    expect(Math.max(...reds)).toBeGreaterThan(120);
    expect(Math.max(...reds)).toBeLessThan(136);
  } finally {
    device.destroy();
  }
});

class ToyPass {
  readonly layout: HostShareableLayout;
  readonly buffer: GPUBuffer;
  readonly bindGroupLayout: GPUBindGroupLayout;
  readonly bindGroup: GPUBindGroup;
  readonly values: Record<string, unknown> = {};
  bytes: ArrayBuffer;

  constructor(private readonly device: GPUDevice, shader: ResolvedShader) {
    const binding = shader.reflection.bindings.find((item) => item.group === 0 && item.binding === 0 && item.name === "params");
    if (!binding?.layout?.size) throw new Error("ToyPass expected @group(0) @binding(0) var<uniform> params with finite layout");
    this.layout = binding.layout;
    this.bytes = new ArrayBuffer(binding.layout.size);
    this.buffer = device.createBuffer({ size: binding.layout.size, usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST });
    this.bindGroupLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPU_SHADER_STAGE.FRAGMENT, buffer: { type: "uniform" } }] });
    this.bindGroup = device.createBindGroup({ layout: this.bindGroupLayout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
  }

  set(values: Record<string, unknown>): void {
    Object.assign(this.values, values);
    this.bytes = writeLayoutValue(this.layout, this.values);
    this.device.queue.writeBuffer(this.buffer, 0, this.bytes);
  }

  cpuPixel(): readonly [number, number, number, number] {
    return [Number(this.values.time) * Number(this.values.speed), 0, 0, 1];
  }
}
