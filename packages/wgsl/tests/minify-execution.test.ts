import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { resolveShader } from "@vgpu/wgsl/runtime";

type Modules = Record<string, string>;
type PipelineConstants = Record<string, number>;

interface BufferBinding {
  readonly binding: number;
  readonly size: number;
  readonly data?: Uint32Array;
  readonly usage: GPUBufferUsageFlags;
}

const WebGPUBufferUsage = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} satisfies Record<string, GPUBufferUsageFlags>;

const WebGPUMapMode = {
  READ: 0x0001,
} satisfies Record<string, GPUMapModeFlags>;

interface ComputeCase {
  readonly entry?: string;
  readonly modules: Modules;
  readonly outputBinding?: number;
  readonly outputU32Length: number;
  readonly bindings?: readonly BufferBinding[];
  readonly constants?: PipelineConstants;
  readonly dispatch?: readonly [number, number?, number?];
}

const dockerTest = process.env.VGPU_DOCKER_TEST === "1";

async function resolveBaselineAndMinified(testCase: ComputeCase) {
  const options = { entry: testCase.entry ?? "/main.wgsl", validate: false, modules: testCase.modules };
  const baseline = await resolveShader({ ...options, minify: false });
  const minified = await resolveShader({ ...options, minify: true });
  const minifiedAgain = await resolveShader({ ...options, minify: true });

  expect(minified.wgsl).toBe(minifiedAgain.wgsl);
  expect(minified.wgsl).not.toBe(baseline.wgsl);
  expect(minified.wgsl.length).toBeLessThan(baseline.wgsl.length);

  return { baseline: baseline.wgsl, minified: minified.wgsl };
}

async function expectSameExecution(testCase: ComputeCase, expected: readonly number[], inspect?: (wgsl: { readonly baseline: string; readonly minified: string }) => void | Promise<void>) {
  const wgsl = await resolveBaselineAndMinified(testCase);
  await inspect?.(wgsl);

  const { device } = await App.create({ adapter: createNodeAdapter() });
  try {
    const baselineOutput = await runCompute(device.gpu, wgsl.baseline, testCase);
    const minifiedOutput = await runCompute(device.gpu, wgsl.minified, testCase);

    expect(Array.from(baselineOutput)).toEqual(expected);
    expect(minifiedOutput).toEqual(baselineOutput);
  } finally {
    device.destroy();
  }
}

async function runCompute(gpu: GPUDevice, wgsl: string, testCase: ComputeCase): Promise<Uint32Array> {
  const outputBinding = testCase.outputBinding ?? 0;
  const outputSize = testCase.outputU32Length * Uint32Array.BYTES_PER_ELEMENT;
  const bindings = testCase.bindings ?? [{ binding: outputBinding, size: outputSize, usage: WebGPUBufferUsage.STORAGE }];
  const buffers = new Map<number, GPUBuffer>();

  for (const binding of bindings) {
    const buffer = gpu.createBuffer({
      size: binding.size,
      usage: binding.usage | WebGPUBufferUsage.COPY_SRC | WebGPUBufferUsage.COPY_DST,
    });
    if (binding.data) gpu.queue.writeBuffer(buffer, 0, binding.data);
    buffers.set(binding.binding, buffer);
  }

  const outputBuffer = buffers.get(outputBinding);
  if (!outputBuffer) throw new Error(`missing output buffer binding ${outputBinding}`);

  const readback = gpu.createBuffer({ size: outputSize, usage: WebGPUBufferUsage.MAP_READ | WebGPUBufferUsage.COPY_DST });

  try {
    const pipeline = gpu.createComputePipeline({
      layout: "auto",
      compute: { module: gpu.createShaderModule({ code: wgsl }), entryPoint: "main", constants: testCase.constants },
    });
    const bindGroup = gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: bindings.map((binding) => ({ binding: binding.binding, resource: { buffer: buffers.get(binding.binding)! } })),
    });
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(...(testCase.dispatch ?? [1]));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readback, 0, outputSize);
    gpu.queue.submit([encoder.finish()]);
    await gpu.queue.onSubmittedWorkDone();
    await readback.mapAsync(WebGPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange()).slice();
    return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Uint32Array.BYTES_PER_ELEMENT).slice();
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
    for (const buffer of buffers.values()) buffer.destroy();
  }
}

test.skipIf(!dockerTest)("minified compute locals params and for-loop match baseline execution", async () => {
  const modules = {
    "/main.wgsl": `// locals, params, and for-loop binders should be safe to shorten
struct Out { values: array<u32, 4> }
@group(0) @binding(0) var<storage, read_write> out: Out;

fn mix_value(long_parameter_name: u32, another_parameter: u32) -> u32 {
  var local_accumulator = long_parameter_name;
  for (var loop_index: u32 = 0u; loop_index < 4u; loop_index = loop_index + 1u) {
    let temporary_value = another_parameter + loop_index;
    local_accumulator = local_accumulator + temporary_value;
  }
  return local_accumulator;
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let invocation_index = global_id.x;
  if (invocation_index < 4u) {
    out.values[invocation_index] = mix_value(invocation_index, 3u);
  }
}`,
  };

  await expectSameExecution({ modules, outputU32Length: 4, dispatch: [4] }, [18, 19, 20, 21], ({ minified }) => {
    expect(minified).not.toContain("// locals");
    expect(minified).not.toContain("\n");
    expect(minified).not.toContain("mix_value");
    expect(minified).not.toContain("long_parameter_name");
    expect(minified).not.toContain("another_parameter");
    expect(minified).not.toContain("local_accumulator");
    expect(minified).not.toContain("loop_index");
    expect(minified).not.toContain("temporary_value");
    expect(minified).not.toContain("global_id");
    expect(minified).not.toContain("invocation_index");
    expect(minified).toMatch(/fn [a-z]\(/);
  });
});

test.skipIf(!dockerTest)("minified imported helper graph matches baseline execution", async () => {
  const modules = {
    "/main.wgsl": `import { weighted_helper } from "./math.wgsl";

struct Out { values: array<u32, 2> }
@group(0) @binding(0) var<storage, read_write> out: Out;

@compute @workgroup_size(1)
fn main() {
  out.values[0] = weighted_helper(5u);
  out.values[1] = weighted_helper(9u);
}`,
    "/math.wgsl": `// imported private helper can be shortened once identifier minification supports it
export fn weighted_helper(seed_value: u32) -> u32 {
  var imported_accumulator = seed_value * 2u;
  for (var imported_index: u32 = 1u; imported_index <= 3u; imported_index = imported_index + 1u) {
    imported_accumulator = imported_accumulator + imported_index;
  }
  return imported_accumulator;
}`,
  };

  await expectSameExecution({ modules, outputU32Length: 2 }, [16, 24], ({ baseline, minified }) => {
    const helperName = baseline.match(/fn (_vgsl_[0-9a-f]{8}__weighted_helper)\(/)?.[1];
    expect(helperName).toBeDefined();
    expect(minified).not.toContain(helperName!);
    expect(minified).not.toContain("weighted_helper");
    expect(minified).not.toContain("seed_value");
    expect(minified).not.toContain("imported_accumulator");
    expect(minified).not.toContain("imported_index");
    expect(minified).toMatch(/fn [a-z]\(/);
  });
});

test.skipIf(!dockerTest)("minified uniforms resources and preserved binding names match baseline execution", async () => {
  const modules = {
    "/main.wgsl": `struct Params {
  offset: u32,
  multiplier: u32,
  addend: u32,
  limit: u32,
}
struct Out { values: array<u32, 4> }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output_buffer: Out;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3u) {
  let element_index = global_id.x;
  if (element_index < params.limit) {
    let uniform_adjusted = (element_index + params.offset) * params.multiplier + params.addend;
    output_buffer.values[element_index] = uniform_adjusted;
  }
}`,
  };

  await expectSameExecution({
    modules,
    outputBinding: 1,
    outputU32Length: 4,
    dispatch: [4],
    bindings: [
      { binding: 0, size: 16, usage: WebGPUBufferUsage.UNIFORM, data: new Uint32Array([4, 3, 2, 4]) },
      { binding: 1, size: 16, usage: WebGPUBufferUsage.STORAGE },
    ],
  }, [14, 17, 20, 23], ({ baseline, minified }) => {
    const uniformDecl = baseline.match(/var<uniform>\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/);
    const storageDecl = baseline.match(/var<storage, read_write>\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/);
    expect(uniformDecl).not.toBeNull();
    expect(storageDecl).not.toBeNull();
    const [, uniformName, uniformType] = uniformDecl!;
    const [, storageName, storageType] = storageDecl!;

    expect(uniformName).toMatch(/^_vgsl_[0-9a-f]{8}__params$/);
    expect(uniformType).toMatch(/^_vgsl_[0-9a-f]{8}__Params$/);
    expect(storageName).toMatch(/^_vgsl_[0-9a-f]{8}__output_buffer$/);
    expect(storageType).toMatch(/^_vgsl_[0-9a-f]{8}__Out$/);
    expect(minified).toContain(`var<uniform> ${uniformName}:${uniformType}`);
    expect(minified).toContain(`var<storage,read_write> ${storageName}:${storageType}`);
    expect(minified).not.toContain("params:Params");
    expect(minified).not.toContain("output_buffer:Out");
    expect(minified).not.toContain("element_index");
    expect(minified).not.toContain("uniform_adjusted");
  });
});

test.skipIf(!dockerTest)("minified override constants match baseline execution", async () => {
  const modules = {
    "/main.wgsl": `override SCALE: u32 = 1u;
override BIAS: u32 = 0u;
struct Out { values: array<u32, 2> }
@group(0) @binding(0) var<storage, read_write> out: Out;

@compute @workgroup_size(1)
fn main() {
  let first_value = SCALE * 1u + BIAS;
  let second_value = SCALE * 2u + BIAS;
  out.values[0] = first_value;
  out.values[1] = second_value;
}`,
  };

  await expectSameExecution({ modules, outputU32Length: 2, constants: { SCALE: 7, BIAS: 11 } }, [18, 25], ({ minified }) => {
    expect(minified).toContain("override SCALE:u32=1u");
    expect(minified).toContain("override BIAS:u32=0u");
    expect(minified).not.toContain("first_value");
    expect(minified).not.toContain("second_value");
  });
});

test.skipIf(!dockerTest)("minified shadowing and short-name collision torture matches baseline execution", async () => {
  const modules = {
    "/main.wgsl": `struct Out { values: array<u32, 2> }
@group(0) @binding(0) var<storage, read_write> out: Out;

fn shadow_torture(value: u32) -> u32 {
  var result = value;
  {
    let value = result + 1u;
    var result_inner = value * 2u;
    {
      let value = result_inner + 3u;
      result = value;
    }
  }
  return result + 4u;
}

fn collision_torture(long_value: u32) -> u32 {
  var a = 10u;
  var b = long_value;
  {
    let long_value = a + b;
    var c = long_value + a;
    b = c;
  }
  return a + b;
}

@compute @workgroup_size(1)
fn main() {
  let shadow_result = shadow_torture(2u);
  let collision_result = collision_torture(shadow_result);
  out.values[0] = shadow_result;
  out.values[1] = collision_result;
}`,
  };

  await expectSameExecution({ modules, outputU32Length: 2 }, [13, 43], ({ minified }) => {
    expect(minified).not.toContain("shadow_torture");
    expect(minified).not.toContain("collision_torture");
    expect(minified).not.toContain("shadow_result");
    expect(minified).not.toContain("collision_result");
    expect(minified).not.toContain("result_inner");
    expect(minified).not.toContain("long_value");
  });
});
