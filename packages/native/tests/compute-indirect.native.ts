import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import { runConsumer } from "./native-support.ts";

const dispatchGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md",
    import.meta.url
  ),
  "utf8"
);
const indirectGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-indirect-dispatch.docs.md",
    import.meta.url
  ),
  "utf8"
);
const wgsl = [...dispatchGuide.matchAll(/```wgsl\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);
const dispatchSwift = [
  ...dispatchGuide.matchAll(/```swift\n([\s\S]*?)\n```/gu),
].map((match) => match[1]);
const indirectSwift = [
  ...indirectGuide.matchAll(/```swift\n([\s\S]*?)\n```/gu),
].map((match) => match[1]);
const configuration = JSON.parse(
  [...dispatchGuide.matchAll(/```json\n([\s\S]*?)\n```/gu)][0][1]
);
const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("the exact indirect guide executes and replays CPU-encoded commands with prepared 28 and 52 byte views", async () => {
  expect(wgsl).toHaveLength(1);
  expect(dispatchSwift).toHaveLength(4);
  expect(indirectSwift).toHaveLength(3);
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": wgsl[0] },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let count = try Count.load(device: device)
${dispatchSwift[1]}
let queue = device.makeCommandQueue()!
var results: [[UInt32]] = []
for length in [28, 52] {
  ${dispatchSwift[2].replace("length: 28", "length: length")}
  ${indirectSwift[0]}
  ${indirectSwift[1]}
  for _ in 0..<2 {
    // Clear completed output so replay cannot pass by reading the previous result.
    for index in 0..<2 {
      outputBuffer.contents().storeBytes(of: UInt32.max, toByteOffset: index * 4, as: UInt32.self)
    }
    ${indirectSwift[2]}
    results.append((0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian })
  }
}
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`
  );
  expect(JSON.parse(output)).toEqual([
    [2, 202],
    [2, 202],
    [4, 404],
    [4, 404],
  ]);
});

test("a completed indirect command can be reset and re-encoded with a new prepared range and owned uploads", async () => {
  const resetIndex = indirectSwift[1].indexOf("indirect.reset()");
  expect(resetIndex).toBeGreaterThan(0);
  const generated = await compileMetalPackage({
    ...configuration,
    modules: { "shaders/count.wgsl": wgsl[0] },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let count = try Count.load(device: device)
${dispatchSwift[1]}
${dispatchSwift[2]}
${indirectSwift[0].replace("let prepared =", "var prepared =")}
${indirectSwift[1].slice(0, resetIndex)}
let queue = device.makeCommandQueue()!
var results: [[UInt32]] = []
for length in [28, 52, 28] {
  ${dispatchSwift[2].replace("length: 28", "length: length")}
  prepared = try count.prepare(bindings)
  // The same command is reset only after the previous submissions completed.
  ${indirectSwift[1].slice(resetIndex)}
  for _ in 0..<2 {
    for index in 0..<2 {
      outputBuffer.contents().storeBytes(of: UInt32.max, toByteOffset: index * 4, as: UInt32.self)
    }
    ${indirectSwift[2]}
    results.append((0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian })
  }
}
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`
  );
  expect(JSON.parse(output)).toEqual([
    [2, 202],
    [2, 202],
    [4, 404],
    [4, 404],
    [2, 202],
    [2, 202],
  ]);
});
