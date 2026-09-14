import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import { runConsumer } from "./native-support.ts";

const guide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md",
    import.meta.url
  ),
  "utf8"
);
const wgsl = [...guide.matchAll(/```wgsl\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);
const swift = [...guide.matchAll(/```swift\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);
const configuration = JSON.parse(
  [...guide.matchAll(/```json\n([\s\S]*?)\n```/gu)][0][1]
);
const preparedGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-prepared-bindings.docs.md",
    import.meta.url
  ),
  "utf8"
);
const preparedSwift = [
  ...preparedGuide.matchAll(/```swift\n([\s\S]*?)\n```/gu),
].map((match) => match[1]);
const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("the exact compute guide counts the visible 28 and 52 byte views with caller-owned Metal commands", async () => {
  expect(wgsl).toHaveLength(1);
  expect(swift).toHaveLength(4);
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": wgsl[0] },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
${swift[1]}
let queue = device.makeCommandQueue()!
var results: [[UInt32]] = []
for length in [28, 52] {
  ${swift[2].replace("length: 28", "length: length")}
  let command = queue.makeCommandBuffer()!
  let encoder = command.makeComputeCommandEncoder()!
  ${swift[3]}
  encoder.endEncoding()
  command.commit()
  command.waitUntilCompleted()
  precondition(command.status == .completed, String(describing: command.error))
  results.append((0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian })
}
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`
  );
  expect(JSON.parse(output)).toEqual([
    [2, 202],
    [4, 404],
  ]);
});

test("the exact prepared and manual-upload guides preserve the same 28 and 52 byte compute views", async () => {
  expect(preparedSwift).toHaveLength(4);
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": wgsl[0] },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
${swift[1]}
let queue = device.makeCommandQueue()!
var results: [[UInt32]] = []
for manual in [false, true] {
  for length in [28, 52] {
    ${swift[2].replace("length: 28", "length: length")}
    ${preparedSwift[0]}
    let command = queue.makeCommandBuffer()!
    let encoder = command.makeComputeCommandEncoder()!
    var retainedUploads: [any MTLBuffer] = []
    if manual {
      encoder.setComputePipelineState(pipeline)
      ${preparedSwift[2]}
      ${preparedSwift[3]}
      retainedUploads = internalUploads
      encoder.dispatchThreadgroups(MTLSize(width: 1, height: 1, depth: 1), threadsPerThreadgroup: Count.workgroupSize)
    } else {
      ${preparedSwift[1]}
    }
    encoder.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    withExtendedLifetime(retainedUploads) {}
    precondition(command.status == .completed, String(describing: command.error))
    results.append((0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian })
  }
}
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`
  );
  expect(JSON.parse(output)).toEqual([
    [2, 202],
    [4, 404],
    [2, 202],
    [4, 404],
  ]);
});

test("a runtime storage prefix-only shader has no effective internal allocation or payload", async () => {
  const source =
    wgsl[0].slice(0, wgsl[0].indexOf("fn count_main()")) +
    "fn count_main() { output[0] = values.prefix; output[1] = 42u; }";
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": source },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
${swift[1]}
${swift[2]}
let prepared = try count.prepare(bindings)
precondition(prepared.internalData.isEmpty)
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${preparedSwift[1]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
precondition(outputBuffer.contents().load(as: UInt32.self).littleEndian == 99)
precondition(outputBuffer.contents().load(fromByteOffset: 4, as: UInt32.self).littleEndian == 42)
print("PREFIX_ONLY_WITHOUT_INTERNAL_DATA")
`
  );
  expect(output).toBe("PREFIX_ONLY_WITHOUT_INTERNAL_DATA");
});

test("imported constant expressions determine the authenticated complete compute workgroup", async () => {
  const generated = await compileMetalPackage({
    ...configuration,
    workerPath,
    modules: {
      "shaders/dimensions.wgsl": "export const width: u32 = 1u + 1u;",
      "shaders/count.wgsl": `import { width } from "./dimensions.wgsl";
@group(3) @binding(7) var<storage, read_write> output: array<u32, 6>;
@compute @workgroup_size(width, 3)
fn count_main(@builtin(local_invocation_index) index: u32) { output[index] = 100u + index; }`,
    },
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
precondition(Count.workgroupSize.width == 2 && Count.workgroupSize.height == 3 && Count.workgroupSize.depth == 1)
precondition(Count.Storage.output.slots.count == 1 && Count.Storage.output.slots[0].index == 0)
let outputBuffer = device.makeBuffer(length: 24, options: .storageModeShared)!
let prepared = try count.prepare(Count.Bindings(output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 24)))
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${preparedSwift[1]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
let results = (0..<6).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian }
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`
  );
  expect(JSON.parse(output)).toEqual([100, 101, 102, 103, 104, 105]);
});

test("effective size tables retain sparse runtime slots and omit trailing fixed-buffer slots", async () => {
  const source =
    wgsl[0]
      .replace("@group(0) @binding(0)", "@group(3) @binding(4)")
      .replace("@group(0) @binding(1)", "@group(2) @binding(8)")
      .replace("array<u32, 2>", "array<u32, 4>")
      .replace(
        "output[1] = 0u;",
        "output[1] = 0u; output[2] = prefixOnly.prefix + adjustment + trailing; output[3] = values.prefix;"
      ) +
    `
@group(4) @binding(5) var<storage, read> adjustment: u32;
@group(5) @binding(6) var<storage, read> prefixOnly: Values;
@group(6) @binding(7) var<storage, read> trailing: u32;`;
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": source },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
${swift[1].replace("length: 8", "length: 16")}
let adjustment = device.makeBuffer(length: 4, options: .storageModeShared)!
adjustment.contents().storeBytes(of: UInt32(1).littleEndian, as: UInt32.self)
let trailing = device.makeBuffer(length: 4, options: .storageModeShared)!
trailing.contents().storeBytes(of: UInt32(2).littleEndian, as: UInt32.self)
let bindings = Count.Bindings(
  output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 16),
  values: ShaderBufferRange(buffer: valuesBuffer, offset: offset, length: 28),
  adjustment: ShaderBufferRange(buffer: adjustment, offset: 0, length: 4),
  prefixOnly: ShaderBufferRange(buffer: valuesBuffer, offset: offset, length: 52),
  trailing: ShaderBufferRange(buffer: trailing, offset: 0, length: 4)
)
let prepared = try count.prepare(bindings)
let slotIndices: [Int] = [Count.Storage.output.slots[0].index, Count.Storage.values.slots[0].index, Count.Storage.adjustment.slots[0].index, Count.Storage.prefixOnly.slots[0].index, Count.Storage.trailing.slots[0].index]
precondition(slotIndices == [0, 1, 2, 3, 4])
precondition(prepared.internalData.count == 1)
precondition(prepared.internalData[0].bytes.count == 20)
let sizeWords = prepared.internalData[0].bytes.enumerated().reduce(into: [UInt32](repeating: 0, count: 5)) { result, byte in
  result[byte.offset / 4] |= UInt32(byte.element) << ((byte.offset % 4) * 8)
}
precondition(sizeWords == [0, 0, 28, 0, 52])
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${preparedSwift[1]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
let result = (0..<4).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian }
precondition(result == [2, 202, 102, 99])
print("SPARSE_VISIBLE_SIZE_TABLE")
`
  );
  expect(output).toBe("SPARSE_VISIBLE_SIZE_TABLE");
});

test("a visible range may end in incomplete particle bytes without inventing another element", async () => {
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": wgsl[0] },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
${swift[1]}
${swift[2].replace("length: 28", "length: 31")}
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${swift[3]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
precondition(outputBuffer.contents().load(as: UInt32.self).littleEndian == 2)
precondition(outputBuffer.contents().load(fromByteOffset: 4, as: UInt32.self).littleEndian == 202)
print("INCOMPLETE_PARTICLE_IS_NOT_VISIBLE")
`
  );
  expect(output).toBe("INCOMPLETE_PARTICLE_IS_NOT_VISIBLE");
});

test("compute workgroup overrides are rejected even when they have a default value", async () => {
  const source = wgsl[0].replace(
    "@compute @workgroup_size(1)",
    "override lanes: u32 = 1u;\n@compute @workgroup_size(lanes)"
  );
  await expect(
    compileMetalPackage({
      ...configuration,
      modules: { "shaders/count.wgsl": source },
      workerPath,
    })
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("overrides"),
  });
});

test("compute resource profiles do not silently expand to uniform buffers", async () => {
  await expect(
    compileMetalPackage({
      ...configuration,
      workerPath,
      modules: {
        "shaders/count.wgsl": `
@group(0) @binding(0) var<uniform> values: vec4f;
@group(0) @binding(1) var<storage, read_write> output: vec4f;
@compute @workgroup_size(1) fn count_main() { output = values; }`,
      },
    })
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("storage buffers"),
  });
});

test("a resource-free compute program and a render pair coexist in one generated package", async () => {
  const generated = await compileMetalPackage({
    moduleName: "AppShaders",
    workerPath,
    programs: [
      configuration.programs[0],
      {
        name: "Triangle",
        source: "shaders/count.wgsl",
        entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
      },
    ],
    modules: {
      "shaders/count.wgsl": `
@compute @workgroup_size(1) fn count_main() {}
@vertex fn vertex_main() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return vec4f(1.0); }`,
    },
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
let triangle = try Triangle.load(device: device)
precondition(Set([count.compute.name, triangle.vertex.name, triangle.fragment.name]).count == 3)
let renderDescriptor = MTLRenderPipelineDescriptor()
renderDescriptor.vertexFunction = triangle.vertex
renderDescriptor.fragmentFunction = triangle.fragment
renderDescriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
_ = try device.makeRenderPipelineState(descriptor: renderDescriptor)
let prepared = try count.prepare(Count.Bindings())
precondition(prepared.internalData.isEmpty)
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${preparedSwift[1]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
print("COMPUTE_AND_RENDER_COEXIST")
`
  );
  expect(output).toBe("COMPUTE_AND_RENDER_COEXIST");
});

test("active compute textures fail closed at the storage-only profile boundary", async () => {
  await expect(
    compileMetalPackage({
      ...configuration,
      workerPath,
      modules: {
        "shaders/count.wgsl": `
@group(0) @binding(0) var pixels: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> output: vec4f;
@compute @workgroup_size(1) fn count_main() { output = textureLoad(pixels, vec2i(0), 0); }`,
      },
    })
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("storage buffers"),
  });
});

test("own render stage selections remain authoritative over inherited compute properties", async () => {
  const entryPoints = Object.assign(
    Object.create({ compute: "compute_main" }),
    {
      vertex: "vertex_main",
      fragment: "fragment_main",
    }
  );
  const generated = await compileMetalPackage({
    moduleName: "AppShaders",
    workerPath,
    programs: [{ name: "Triangle", source: "shaders/mixed.wgsl", entryPoints }],
    modules: {
      "shaders/mixed.wgsl": `
@compute @workgroup_size(1) fn compute_main() {}
@vertex fn vertex_main() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return vec4f(1.0); }`,
    },
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let triangle = try Triangle.load(device: device)
let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = triangle.vertex
descriptor.fragmentFunction = triangle.fragment
descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
_ = try device.makeRenderPipelineState(descriptor: descriptor)
print("OWN_RENDER_STAGES_SELECTED")
`
  );
  expect(output).toBe("OWN_RENDER_STAGES_SELECTED");
});
