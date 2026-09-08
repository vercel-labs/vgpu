import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import { runConsumer } from "./native-support.ts";

const guide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-rendering.docs.md",
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
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("the exact compute-to-render guide shares one private tracked buffer across ordered passes", async () => {
  expect(wgsl).toHaveLength(3);
  expect(swift).toHaveLength(3);
  const generated = await compileGuide();
  const output = await runConsumer(
    { FrameShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: 4, height: 4, mipmapped: false)
textureDescriptor.storageMode = .shared
textureDescriptor.usage = [.renderTarget]
let target = device.makeTexture(descriptor: textureDescriptor)!
let queue = device.makeCommandQueue()!
${swift[0]}
precondition(byteCount == 16)
precondition(colorBuffer.storageMode == .private && colorBuffer.hazardTrackingMode == .tracked)
precondition(fillBindings.color.buffer === displayBindings.color.buffer)
${swift[1]}
${swift[2]}
// Read only the completed render target, never the private producer buffer.
var pixels = [Float](repeating: 0, count: 64)
pixels.withUnsafeMutableBytes { bytes in
  target.getBytes(bytes.baseAddress!, bytesPerRow: 64, from: MTLRegionMake2D(0, 0, 4, 4), mipmapLevel: 0)
}
print(String(data: try JSONSerialization.data(withJSONObject: pixels), encoding: .utf8)!)
`
  );
  const pixels: number[] = JSON.parse(output);
  expect(pixels).toHaveLength(64);
  pixels.forEach((value, index) =>
    expect(value).toBeCloseTo([0.25, 0.5, 0.75, 1][index % 4], 6)
  );
});

test("application-owned blits compose before and after the generated compute and render passes", async () => {
  const generated = await compileGuide();
  const encoded = swift[2]
    .replace(
      "let compute =",
      `let initialize = commandBuffer.makeBlitCommandEncoder()!
initialize.fill(buffer: colorBuffer, range: 0..<byteCount, value: 0)
initialize.endEncoding()
let compute =`
    )
    .replace(
      "withExtendedLifetime",
      `let readback = commandBuffer.makeBlitCommandEncoder()!
readback.copy(from: colorBuffer, sourceOffset: 0, to: colorReadback, destinationOffset: 0, size: byteCount)
readback.copy(from: target, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 4, height: 4, depth: 1), to: pixelReadback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 1024)
readback.endEncoding()
withExtendedLifetime`
    );
  const output = await runConsumer(
    { FrameShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: 4, height: 4, mipmapped: false)
textureDescriptor.storageMode = .private
textureDescriptor.usage = [.renderTarget]
let target = device.makeTexture(descriptor: textureDescriptor)!
let queue = device.makeCommandQueue()!
${swift[0]}
${swift[1]}
let colorReadback = device.makeBuffer(length: byteCount, options: .storageModeShared)!
let pixelReadback = device.makeBuffer(length: 1024, options: .storageModeShared)!
${encoded}
// Both copies were encoded after rendering; CPU reads only after the one submission completes.
let color = (0..<4).map { colorReadback.contents().load(fromByteOffset: $0 * 4, as: Float.self) }
let pixels = (0..<4).flatMap { y in (0..<16).map { x in
  pixelReadback.contents().load(fromByteOffset: y * 256 + x * 4, as: Float.self)
} }
withExtendedLifetime((colorReadback, pixelReadback)) {}
print(String(data: try JSONSerialization.data(withJSONObject: ["color": color, "pixels": pixels]), encoding: .utf8)!)
`
  );
  const result: { color: number[]; pixels: number[] } = JSON.parse(output);
  expect(result.color).toEqual([0.25, 0.5, 0.75, 1]);
  expect(result.pixels).toHaveLength(64);
  result.pixels.forEach((value, index) =>
    expect(value).toBeCloseTo([0.25, 0.5, 0.75, 1][index % 4], 6)
  );
});

function compileGuide() {
  return compileMetalPackage({
    moduleName: "FrameShaders",
    programs: [
      {
        name: "Fill",
        source: "shaders/fill.wgsl",
        entryPoints: { compute: "fill_main" },
      },
      {
        name: "Display",
        source: "shaders/display.wgsl",
        entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
      },
    ],
    modules: {
      "shaders/color.wgsl": wgsl[0],
      "shaders/fill.wgsl": wgsl[1],
      "shaders/display.wgsl": wgsl[2],
    },
    workerPath,
  });
}
