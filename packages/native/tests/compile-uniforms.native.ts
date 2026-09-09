import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import type { GeneratedMetalPackage } from "../src/index.ts";
import { runConsumer } from "./native-support.ts";

const guide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md",
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
const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("the exact uniform guide compiles, packs and binds reflected bytes to real Metal pixels", async () => {
  expect(wgsl).toHaveLength(1);
  expect(swift).toHaveLength(3);
  const generated = await compileGuide(wgsl[0]);
  assertPixels(await render(generated), [0.28, 0.44, 0.8, 1]);
});

test("the same compiled program reads different values from another explicit buffer region", async () => {
  const generated = await compileGuide(wgsl[0]);
  assertPixels(await render(generated), [0.28, 0.44, 0.8, 1]);
  const snippets = [
    swift[0].replace("SIMD2<Float>(0.0, 0.0)", "SIMD2<Float>(0.125, 0.25)"),
    swift[1]
      .replace("let offset = 256", "let offset = 512")
      .replace(
        "try layout.pack(",
        "uniforms.contents().initializeMemory(as: UInt8.self, repeating: 0, count: offset + layout.byteCount)\ntry layout.pack("
      ),
    swift[2],
  ];
  assertPixels(await render(generated, snippets), [0.405, 0.69, 0.8, 1]);
});

test("one uniform shared by both stages uses nonidentity stage-local slots", async () => {
  const source = wgsl[0]
    .replace("@group(0) @binding(0)", "@group(2) @binding(9)")
    .replace(
      "vec4f(position, 0.0, 1.0)",
      "vec4f(position * params.gain, 0.0, 1.0)"
    );
  const generated = await compileGuide(source);
  const snippets = [
    swift[0].replace("gain: 0.8", "gain: 1.0"),
    swift[1],
    `precondition(layout.slots.count == 2)
precondition(layout.slots[0].stage == .vertex && layout.slots[0].index == 0)
precondition(layout.slots[1].stage == .fragment && layout.slots[1].index == 0)
${swift[2]}`,
  ];
  // The application deliberately moves its vertex stream away from shader buffer0.
  assertPixels(await render(generated, snippets, 1), [0.35, 0.55, 1, 1]);
});

test("contextual WGSL member size decorations use the reflected padded layout", async () => {
  const generated = await compileGuide(
    wgsl[0].replace("gain: f32", "@size(32) gain: f32")
  );
  const snippets = [
    swift[0].replace("SIMD2<Float>(0.0, 0.0)", "SIMD2<Float>(0.125, 0.25)"),
    swift[1],
    `precondition(layout.byteCount == 64)
precondition(layout.alignment == 16)
${swift[2]}`,
  ];
  assertPixels(await render(generated, snippets), [0.405, 0.69, 0.8, 1]);
});

test("an imported type alias preserves the authored struct name without guessing mangled prefixes", async () => {
  const split = wgsl[0].indexOf("@group");
  const source = `import { Params as LocalParams } from "./types.wgsl";\n${wgsl[0]
    .slice(split)
    .replace(": Params;", ": LocalParams;")}`;
  const generated = await compileGuide(source, {
    "shaders/types.wgsl": `export ${wgsl[0].slice(0, split)}`,
  });
  assertPixels(await render(generated), [0.28, 0.44, 0.8, 1]);
});

test("a scalar-only uniform preserves its reflected four-byte struct layout", async () => {
  const source = `struct Params { gain: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return vec4f(params.gain); }`;
  const generated = await compileGuide(source);
  const snippets = [
    `import AppShaders
let layout = Gradient.Uniforms.params
let params = Gradient.Params(gain: 0.8)`,
    swift[1],
    `precondition(layout.byteCount == 4 && layout.alignment == 4)
${swift[2]}`,
  ];
  assertPixels(await render(generated, snippets), [0.8, 0.8, 0.8, 0.8]);
});

test.each([
  { type: "i32", read: "f32(params.value)" },
  { type: "array<vec4f, 2>", read: "params.value[0].x" },
  { type: "mat2x2f", read: "params.value[0][0]" },
  { type: "Inner", read: "params.value.x" },
])(
  "unsupported uniform member $type fails without emitting guessed packing",
  async ({ type, read }) => {
    const source = `struct Inner { x: f32 }
struct Params { value: ${type} }
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return vec4f(${read}); }`;
    await expect(
      compileGuide(source).then(() => "unexpected package")
    ).rejects.toMatchObject({
      stage: "validation",
      message: expect.stringContaining("Unsupported uniform metadata"),
    });
  }
);

test("texture and sampler resources remain outside the uniform compiler profile", async () => {
  const source = `@group(1) @binding(4) var image: texture_2d<f32>;
@group(1) @binding(5) var imageSampler: sampler;
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(position, 0.0, 1.0); }
@fragment fn fragment_main() -> @location(0) vec4f { return textureSample(image, imageSampler, vec2f(0.5)); }`;
  await expect(
    compileGuide(source).then(() => "unexpected package")
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining(
      "resource bindings must be fixed uniform buffers"
    ),
  });
});

test("a reflected Swift type colliding with its program is a compiler validation failure", async () => {
  await expect(
    compileGuide(wgsl[0].replaceAll("Params", "Gradient")).then(
      () => "unexpected package"
    )
  ).rejects.toMatchObject({
    stage: "validation",
    cause: expect.any(TypeError),
  });
});

function compileGuide(source: string, modules: Record<string, string> = {}) {
  return compileMetalPackage({
    moduleName: "AppShaders",
    programs: [
      {
        name: "Gradient",
        source: "shaders/gradient.wgsl",
        entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
      },
    ],
    modules: { ...modules, "shaders/gradient.wgsl": source },
    workerPath,
  });
}

function assertPixels(pixels: number[], expected: number[]) {
  expect(pixels).toHaveLength(64);
  pixels.forEach((value, index) =>
    expect(value).toBeCloseTo(expected[index % 4], 6)
  );
}

async function render(
  generated: GeneratedMetalPackage,
  snippets = swift,
  streamIndex = 0
): Promise<number[]> {
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
${snippets[0]}
${snippets[1]}
let functions = try Gradient.load(device: device)
let vertices = MTLVertexDescriptor()
vertices.attributes[0].format = .float2
vertices.attributes[0].offset = 0
vertices.attributes[0].bufferIndex = ${streamIndex}
vertices.layouts[${streamIndex}].stride = 8
vertices.layouts[${streamIndex}].stepFunction = .perVertex
let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = functions.vertex
descriptor.fragmentFunction = functions.fragment
descriptor.vertexDescriptor = vertices
descriptor.colorAttachments[0].pixelFormat = .rgba32Float
let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
let positions: [Float] = [-1, -1, 3, -1, -1, 3]
let vertexBuffer = positions.withUnsafeBufferPointer { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count * 4, options: .storageModeShared)! }
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: 4, height: 4, mipmapped: false)
textureDescriptor.storageMode = .private
textureDescriptor.usage = [.renderTarget]
guard let texture = device.makeTexture(descriptor: textureDescriptor),
      let readback = device.makeBuffer(length: 1024, options: .storageModeShared),
      let queue = device.makeCommandQueue(), let commandBuffer = queue.makeCommandBuffer() else { fatalError("Metal allocation failed") }
let pass = MTLRenderPassDescriptor()
pass.colorAttachments[0].texture = texture
pass.colorAttachments[0].loadAction = .clear
pass.colorAttachments[0].storeAction = .store
pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { fatalError("render encoder required") }
encoder.setRenderPipelineState(pipeline)
encoder.setVertexBuffer(vertexBuffer, offset: 0, index: ${streamIndex})
${snippets[2]}
encoder.endEncoding()
guard let blit = commandBuffer.makeBlitCommandEncoder() else { fatalError("blit required") }
blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 4, height: 4, depth: 1), to: readback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 1024)
blit.endEncoding()
commandBuffer.commit()
commandBuffer.waitUntilCompleted()
if let error = commandBuffer.error { throw error }
precondition(commandBuffer.status == .completed)
let floats = readback.contents().assumingMemoryBound(to: Float.self)
let pixels = (0..<4).flatMap { y in (0..<16).map { x in floats[y * 64 + x] } }
print(String(decoding: try JSONSerialization.data(withJSONObject: pixels), as: UTF8.self))
`
  );
  return JSON.parse(output);
}
