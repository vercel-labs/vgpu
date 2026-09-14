import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import { compileLibrary, runConsumer } from "./native-support.ts";
import {
  bindingMSL,
  bindingPackageInput,
  renderSetup,
} from "./metal-bindings-fixture.ts";

let library: Uint8Array;
beforeAll(async () => {
  library = await compileLibrary(bindingMSL);
});

test("generated bindings render a nonzero uniform region in both stages without replacing native vertex data", async () => {
  const generated = generateMetalPackage(bindingPackageInput(library));
  const output = await runConsumer(
    { AppShaders: generated },
    `${renderSetup}
let layout = Gradient.Uniforms.params
let uniforms = device.makeBuffer(length: 32, options: .storageModeShared)!
try layout.pack(Gradient.Params(color: SIMD4<Float>(0, 1, 0, 1)), into: UnsafeMutableRawBufferPointer(start: uniforms.contents(), count: 16))
try layout.pack(Gradient.Params(color: SIMD4<Float>(1, 0, 0, 1)), into: UnsafeMutableRawBufferPointer(start: uniforms.contents().advanced(by: 16), count: 16))
let bindings = Gradient.Bindings(params: ShaderBufferRange(buffer: uniforms, offset: 16, length: layout.byteCount))
let pixels = try render { encoder in
  try gradient.bind(bindings, to: encoder)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
}
precondition(pixels == Array(repeating: [UInt8](arrayLiteral: 255, 0, 0, 255), count: 16).flatMap { $0 })
print("MAPPED_UNIFORM_RENDERED")
`
  );
  expect(output).toContain("MAPPED_UNIFORM_RENDERED");
});

test("invalid native ranges are rejected without overflowing containment arithmetic", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(bindingPackageInput(library)) },
    `import Metal
import AppShaders
let device = MTLCreateSystemDefaultDevice()!
let gradient = try Gradient.load(device: device)
let buffer = device.makeBuffer(length: 64, options: .storageModeShared)!
for (offset, length) in [(-1, 16), (0, -1), (65, 0), (64, 1), (Int.max, Int.max), (16, Int.max)] {
  let bindings = Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: offset, length: length))
  do {
    try gradient.validate(bindings)
    fatalError("invalid range accepted")
  } catch ShaderBindingError.invalidRange(let binding, let actualOffset, let actualLength, let bufferLength) {
    precondition(binding == "params" && actualOffset == offset && actualLength == length && bufferLength == 64)
  }
}
print("INVALID_RANGES_REJECTED")
`
  );
  expect(output).toContain("INVALID_RANGES_REJECTED");
});

test("uniform-visible ranges must cover the full binding layout", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(bindingPackageInput(library)) },
    `import Metal
import AppShaders
let device = MTLCreateSystemDefaultDevice()!
let gradient = try Gradient.load(device: device)
let buffer = device.makeBuffer(length: 64, options: .storageModeShared)!
for length in [0, 15] {
  do {
    try gradient.validate(Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 16, length: length)))
    fatalError("undersized range accepted")
  } catch ShaderBindingError.insufficientRange(let binding, let required, let actual) {
    precondition(binding == "params" && required == 16 && actual == length)
  }
}
try gradient.validate(Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 16, length: 48)))
print("VISIBLE_LENGTH_VALIDATED")
`
  );
  expect(output).toContain("VISIBLE_LENGTH_VALIDATED");
});

test("offset alignment uses the shader layout and the Apple GPU minimum, not WebGPU's 256 bytes", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(bindingPackageInput(library)) },
    `import Metal
import AppShaders
let device = MTLCreateSystemDefaultDevice()!
precondition(device.supportsFamily(.apple1))
let gradient = try Gradient.load(device: device)
let buffer = device.makeBuffer(length: 64, options: .storageModeShared)!
for offset in [1, 4, 8, 12] {
  do {
    try gradient.validate(Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: offset, length: 16)))
    fatalError("misaligned range accepted")
  } catch ShaderBindingError.misalignedOffset(let binding, let required, let actual) {
    precondition(binding == "params" && required == 16 && actual == offset)
  }
}
try gradient.validate(Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 16, length: 16)))
print("LAYOUT_ALIGNMENT_VALIDATED")
`
  );
  expect(output).toContain("LAYOUT_ALIGNMENT_VALIDATED");

  const scalarLibrary = await compileLibrary(
    bindingMSL
      .replaceAll("constant float4& params", "constant float& params")
      .replace("params.w", "params")
      .replace("return params;", "return float4(params, 0.0, 0.0, 1.0);")
  );
  const input = bindingPackageInput(scalarLibrary);
  const uniform = input.programs[0]!.uniforms![0]!;
  const generated = generateMetalPackage({
    ...input,
    programs: [
      {
        ...input.programs[0]!,
        uniforms: [
          {
            ...uniform,
            byteCount: 4,
            alignment: 4,
            members: [{ name: "color", type: "f32", offset: 0 }],
          },
        ],
      },
    ],
  });
  const pixels = await runConsumer(
    { AppShaders: generated },
    `${renderSetup}
let buffer = device.makeBuffer(length: 8, options: .storageModeShared)!
memset(buffer.contents(), 0, 8)
try Gradient.Uniforms.params.pack(Gradient.Params(color: 1), into: UnsafeMutableRawBufferPointer(start: buffer.contents().advanced(by: 4), count: 4))
let bindings = Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 4, length: 4))
try gradient.validate(bindings)
let pixels = try render { encoder in
  try gradient.bind(bindings, to: encoder)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
}
precondition(pixels == Array(repeating: [UInt8](arrayLiteral: 255, 0, 0, 255), count: 16).flatMap { $0 })
print("FOUR_BYTE_NATIVE_OFFSET_RENDERED")
`
  );
  expect(pixels).toContain("FOUR_BYTE_NATIVE_OFFSET_RENDERED");
});

test("a later invalid binding leaves every previously encoded buffer unchanged", async () => {
  const twoBufferMSL = bindingMSL
    .replace(
      "constant float4& params [[buffer(3)]])",
      "constant float4& params [[buffer(3)]], constant float4& zeta [[buffer(4)]])"
    )
    .replace("return params;", "return params + zeta;");
  const input = bindingPackageInput(await compileLibrary(twoBufferMSL));
  const params = input.programs[0]!.uniforms![0]!;
  const generated = generateMetalPackage({
    ...input,
    programs: [
      {
        ...input.programs[0]!,
        uniforms: [
          params,
          { ...params, name: "zeta", slots: [{ stage: "fragment", index: 4 }] },
        ],
      },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `${renderSetup}
let layout = Gradient.Uniforms.params
let buffer = device.makeBuffer(length: 48, options: .storageModeShared)!
// A vertex-only mutation degenerates the triangle; a fragment-only mutation turns it green.
for (offset, color) in [(0, SIMD4<Float>(1, 0, 0, 1)), (16, SIMD4<Float>(0, 1, 0, 0)), (32, SIMD4<Float>(0, 0, 0, 0))] {
  try layout.pack(Gradient.Params(color: color), into: UnsafeMutableRawBufferPointer(start: buffer.contents().advanced(by: offset), count: 16))
}
let original = Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 0, length: 16), zeta: ShaderBufferRange(buffer: buffer, offset: 32, length: 16))
let replacement = Gradient.Bindings(params: ShaderBufferRange(buffer: buffer, offset: 16, length: 16), zeta: ShaderBufferRange(buffer: buffer, offset: 32, length: 0))
var rejected = false
let pixels = try render { encoder in
  try gradient.bind(original, to: encoder)
  do {
    try gradient.bind(replacement, to: encoder)
  } catch ShaderBindingError.insufficientRange(let binding, let required, let actual) {
    rejected = binding == "zeta" && required == 16 && actual == 0
  }
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
}
let unchanged = pixels == Array(repeating: [UInt8](arrayLiteral: 255, 0, 0, 255), count: 16).flatMap { $0 }
print("ATOMIC:\\(rejected):\\(unchanged)")
`
  );
  expect(output).toBe("ATOMIC:true:true");
});

test("the guide's direct slot metadata produces the same pixels as rebinding through the helper", async () => {
  const guide = readFileSync(
    new URL(
      "../../../docs/topics/native/macos/metal/native-macos-metal-bindings.docs.md",
      import.meta.url
    ),
    "utf8"
  );
  const snippets = [...guide.matchAll(/```swift\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1]
  );
  expect(snippets).toHaveLength(3);
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(bindingPackageInput(library)) },
    `${renderSetup}
let layout = Gradient.Uniforms.params
let uniforms = device.makeBuffer(length: 32, options: .storageModeShared)!
for (offset, color) in [(0, SIMD4<Float>(1, 0, 0, 1)), (16, SIMD4<Float>(0, 1, 0, 1))] {
  try layout.pack(Gradient.Params(color: color), into: UnsafeMutableRawBufferPointer(start: uniforms.contents().advanced(by: offset), count: 16))
}
let original = Gradient.Bindings(params: ShaderBufferRange(buffer: uniforms, offset: 0, length: 16))
let bindings = Gradient.Bindings(params: ShaderBufferRange(buffer: uniforms, offset: 16, length: 16))
let helperPixels = try render { encoder in
  try gradient.bind(original, to: encoder)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  ${snippets[1]}
}
let manualPixels = try render { encoder in
  try gradient.bind(original, to: encoder)
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
  ${snippets[2]}
  encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
}
precondition(layout.slots.map { "\\($0.stage.rawValue):\\($0.index)" } == ["vertex:5", "fragment:3"])
precondition(helperPixels == manualPixels)
precondition(helperPixels == Array(repeating: [UInt8](arrayLiteral: 0, 255, 0, 255), count: 16).flatMap { $0 })
print("NATIVE_SLOTS_MATCH_HELPER")
`
  );
  expect(output).toContain("NATIVE_SLOTS_MATCH_HELPER");
});

test("ranges, binding sets, and generated slots expose immutable properties to Swift consumers", async () => {
  const pending = runConsumer(
    { AppShaders: generateMetalPackage(bindingPackageInput(library)) },
    `import Metal
import AppShaders
let device = MTLCreateSystemDefaultDevice()!
let buffer = device.makeBuffer(length: 32, options: .storageModeShared)!
var range = ShaderBufferRange(buffer: buffer, offset: 0, length: 16)
var bindings = Gradient.Bindings(params: range)
var layout = Gradient.Uniforms.params
var slot = layout.slots[0]
range.offset = 16
bindings.params = range
layout.slots = []
slot.index = 8
`
  );
  await expect(pending).rejects.toThrow(/'offset' is a 'let' constant/);
  await expect(pending).rejects.toThrow(/'params' is a 'let' constant/);
  await expect(pending).rejects.toThrow(/'slots' is a 'let' constant/);
  await expect(pending).rejects.toThrow(/'index' is a 'let' constant/);
});
