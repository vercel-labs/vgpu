import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import { runConsumer } from "./native-support.ts";
import { uniformPackageInput as packageInput } from "./uniform-fixture.ts";

test("the guide's Swift value packs vec3 and scalar fields using WGSL offsets", async () => {
  const guide = readFileSync(new URL(
    "../../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md",
    import.meta.url,
  ), "utf8");
  const snippet = [...guide.matchAll(/```swift\n([\s\S]*?)```/g)][0]?.[1];
  expect(snippet).toBeDefined();
  const output = await runConsumer({ AppShaders: generateMetalPackage(packageInput()) }, `
${snippet}
precondition(layout.byteCount == 32)
precondition(layout.alignment == 16)
precondition(bytes == [
  0x33, 0x33, 0xb3, 0x3e, 0xcd, 0xcc, 0x0c, 0x3f,
  0x00, 0x00, 0x80, 0x3f, 0xcd, 0xcc, 0x4c, 0x3f,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0
])
print("WGSL_PACKED")
`);
  expect(output).toContain("WGSL_PACKED");
});

test("short destination spans fail with the documented error before changing bytes", async () => {
  const output = await runConsumer({ AppShaders: generateMetalPackage(packageInput()) }, `
import AppShaders
let layout = Gradient.Uniforms.params
let value = Gradient.Params(accent: SIMD3<Float>(1, 2, 3), gain: 4, phase: SIMD2<Float>(5, 6))
for count in [0, 31] {
  var bytes = [UInt8](repeating: 0xa5, count: count)
  do {
    try bytes.withUnsafeMutableBytes { try layout.pack(value, into: $0) }
    fatalError("short destination accepted")
  } catch ShaderPackingError.destinationTooSmall(let required, let actual) {
    precondition(required == 32 && actual == count)
  }
  precondition(bytes == [UInt8](repeating: 0xa5, count: count))
}
print("SHORT_SPANS_UNCHANGED")
`);
  expect(output).toContain("SHORT_SPANS_UNCHANGED");
});

test("a shared Swift value is packed using each binding's own physical layout", async () => {
  const input = packageInput();
  const uniform = input.programs[0]!.uniforms![0]!;
  const generated = generateMetalPackage({ ...input, programs: [{
    ...input.programs[0]!,
    uniforms: [uniform, {
      ...uniform, name: "alternate", byteCount: 64, alignment: 32,
      members: uniform.members.map((member) => member.name === "phase" ? { ...member, offset: 32 } : member),
    }],
  }] });
  const output = await runConsumer({ AppShaders: generated }, `
import AppShaders
let value = Gradient.Params(accent: SIMD3<Float>(1, 2, 3), gain: 4, phase: SIMD2<Float>(5, 6))
var primary = [UInt8](repeating: 0xa5, count: Gradient.Uniforms.params.byteCount)
var alternate = [UInt8](repeating: 0xa5, count: Gradient.Uniforms.alternate.byteCount)
try primary.withUnsafeMutableBytes { try Gradient.Uniforms.params.pack(value, into: $0) }
try alternate.withUnsafeMutableBytes { try Gradient.Uniforms.alternate.pack(value, into: $0) }
precondition(primary.count == 32 && alternate.count == 64)
precondition(Array(primary[0..<16]) == Array(alternate[0..<16]))
precondition(Array(primary[16..<24]) == [0, 0, 0xa0, 0x40, 0, 0, 0xc0, 0x40])
precondition(Array(alternate[32..<40]) == Array(primary[16..<24]))
precondition(alternate[16..<32].allSatisfy { $0 == 0 })
precondition(alternate[40..<64].allSatisfy { $0 == 0 })
print("BINDING_SPECIFIC_LAYOUTS")
`);
  expect(output).toContain("BINDING_SPECIFIC_LAYOUTS");
});

test("packing an unaligned larger span preserves its surrounding bytes and scalar bit patterns", async () => {
  const input = packageInput();
  const generated = generateMetalPackage({ ...input, programs: [{ ...input.programs[0]!, uniforms: [{
    name: "params", typeName: "Params", byteCount: 16, alignment: 16,
    members: [{ name: "color", type: "vec4f", offset: 0 }],
  }] }] });
  const output = await runConsumer({ AppShaders: generated }, `
import AppShaders
let value = Gradient.Params(color: SIMD4<Float>(
  Float(bitPattern: 0x80000000), Float(bitPattern: 0x7fc00001),
  Float(bitPattern: 0x7f800000), Float(bitPattern: 0xff800000)
))
var bytes = [UInt8](repeating: 0xa5, count: 41)
try bytes.withUnsafeMutableBytes { allocation in
  let destination = UnsafeMutableRawBufferPointer(start: allocation.baseAddress!.advanced(by: 1), count: 40)
  try Gradient.Uniforms.params.pack(value, into: destination)
}
precondition(bytes[0] == 0xa5)
precondition(Array(bytes[1..<17]) == [
  0, 0, 0, 0x80, 1, 0, 0xc0, 0x7f,
  0, 0, 0x80, 0x7f, 0, 0, 0x80, 0xff
])
precondition(bytes[17..<41].allSatisfy { $0 == 0xa5 })
print("UNALIGNED_SPAN_PACKED")
`);
  expect(output).toContain("UNALIGNED_SPAN_PACKED");
});
