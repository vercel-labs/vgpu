import { readFile, writeFile } from "node:fs/promises";

const GPU_BUFFER_USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
const GPU_MAP_MODE = { READ: 1 };
const FEATURE = "uniform_buffer_standard_layout";

const [swiftResultsPath, outputPath] = process.argv.slice(2);
if (!swiftResultsPath || !outputPath) {
  throw new Error("usage: gpu-readback <swift-results.json> <output.json>");
}

const swift = JSON.parse(await readFile(swiftResultsPath, "utf8"));
const semanticBytes = new Map(swift.cases.map((item) => [item.id, item.semanticBytesHex]));

const canaries = [
  {
    id: "root-small-struct-intrinsic-size",
    fixtureCase: "uniform-root-small-struct",
    requiresStandardLayout: false,
    declarations: "struct Params { x: f32 }",
    reads: ["params.x"],
    expected: [7.25],
    inputByteLength: 4,
    sentinels: [],
  },
  {
    id: "scalar-array-natural-offsets",
    fixtureCase: "uniform-standard-scalar-array",
    requiresStandardLayout: true,
    declarations: "struct Params { lead: f32, values: array<f32, 3>, tail: f32 }",
    reads: ["params.lead", "params.values[0]", "params.values[1]", "params.values[2]"],
    expected: [1, 2, 3, 4],
    inputByteLength: 32,
    sentinels: [
      { offset: 16, value: 99 },
      { offset: 20, value: 98 },
      { offset: 24, value: 97 },
    ],
  },
  {
    id: "nested-small-natural-offsets",
    fixtureCase: "uniform-standard-nested-small",
    requiresStandardLayout: true,
    declarations: "struct Small { x: f32 }\nstruct Params { lead: f32, small: Small, tail: f32 }",
    reads: ["params.lead", "params.small.x", "params.tail"],
    expected: [1.25, 2.5, 3.75],
    inputByteLength: 48,
    sentinels: [
      { offset: 16, value: 99 },
      { offset: 32, value: 98 },
    ],
  },
  {
    id: "small-struct-array-natural-offsets",
    fixtureCase: "uniform-standard-small-struct-array",
    requiresStandardLayout: true,
    declarations: "struct Small { x: f32 }\nstruct Params { items: array<Small, 2>, tail: f32 }",
    reads: ["params.items[0].x", "params.items[1].x", "params.tail"],
    expected: [4.25, 5.5, 6.75],
    inputByteLength: 48,
    sentinels: [
      { offset: 16, value: 99 },
      { offset: 32, value: 98 },
    ],
  },
];

let webgpu;
try {
  webgpu = await import("webgpu");
} catch {
  await writeResult({ status: "skipped", reason: "webgpu-module-unavailable" });
  process.exit(0);
}

Object.assign(globalThis, webgpu.globals);

let gpu;
try {
  gpu = webgpu.create(["backend=metal"]);
} catch {
  await writeResult({ status: "skipped", reason: "dawn-metal-unavailable" });
  process.exit(0);
}

if (!gpu.wgslLanguageFeatures.has(FEATURE)) {
  await writeResult({ status: "skipped", reason: "wgsl-feature-unavailable" });
  process.exit(0);
}

const adapter = await gpu.requestAdapter();
if (!adapter) {
  await writeResult({ status: "skipped", reason: "metal-adapter-unavailable" });
  process.exit(0);
}

let device;
try {
  device = await adapter.requestDevice();
} catch {
  await writeResult({ status: "skipped", reason: "metal-device-unavailable" });
  process.exit(0);
}

try {
  const results = [];
  for (const item of canaries) results.push(await runCanary(device, item));
  await writeResult({ status: "passed", canaries: results });
} finally {
  device.destroy();
}

async function runCanary(device, item) {
  const packedHex = semanticBytes.get(item.fixtureCase);
  if (typeof packedHex !== "string") throw new Error(`${item.id}: missing semantic bytes`);
  const packed = Uint8Array.from(packedHex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  if (packed.byteLength > item.inputByteLength) {
    throw new Error(`${item.id}: semantic payload exceeds canary input buffer`);
  }

  const inputBytes = new Uint8Array(item.inputByteLength);
  inputBytes.set(packed);
  const inputView = new DataView(inputBytes.buffer);
  for (const sentinel of item.sentinels) inputView.setFloat32(sentinel.offset, sentinel.value, true);

  const shader = `${item.requiresStandardLayout ? `requires ${FEATURE};\n` : ""}${item.declarations}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@compute @workgroup_size(1) fn main() {
${item.reads.map((read, index) => `  output[${index}] = ${read};`).join("\n")}
}`;
  const module = device.createShaderModule({ code: shader });
  const compilation = await module.getCompilationInfo();
  const errors = [...compilation.messages].filter((message) => message.type === "error");
  if (errors.length) throw new Error(`${item.id}: shader rejected: ${errors.map((error) => error.message).join("; ")}`);

  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
  const input = device.createBuffer({
    size: inputBytes.byteLength,
    usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
  });
  const outputSize = item.expected.length * 4;
  const output = device.createBuffer({
    size: outputSize,
    usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: outputSize,
    usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
  });

  try {
    device.queue.writeBuffer(input, 0, inputBytes);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPU_MAP_MODE.READ);
    const actual = [...new Float32Array(readback.getMappedRange().slice(0))];
    readback.unmap();
    if (!sameNumbers(actual, item.expected)) {
      throw new Error(`${item.id}: expected ${item.expected.join(",")}, received ${actual.join(",")}`);
    }
    return {
      id: item.id,
      fixtureCase: item.fixtureCase,
      requiresStandardLayout: item.requiresStandardLayout,
      expected: item.expected,
      actual,
      inputByteLength: item.inputByteLength,
      sentinels: item.sentinels,
    };
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
  }
}

function sameNumbers(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

async function writeResult(payload) {
  const result = {
    schemaVersion: 1,
    backend: "dawn-metal",
    feature: FEATURE,
    canaries: canaries.map(({ id, fixtureCase, requiresStandardLayout, expected, inputByteLength, sentinels }) => ({
      id,
      fixtureCase,
      requiresStandardLayout,
      expected,
      inputByteLength,
      sentinels,
    })),
    ...payload,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}
