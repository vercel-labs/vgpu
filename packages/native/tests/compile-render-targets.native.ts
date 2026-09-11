import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import { runConsumer } from "./native-support.ts";

const guide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/render/native-macos-metal-render-targets.docs.md",
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

test("the exact multiple-target guide stores both fragment outputs in caller-owned Metal textures", async () => {
  expect(wgsl).toHaveLength(1);
  expect(swift).toHaveLength(3);
  expect(await renderTargets(wgsl[0], swift)).toEqual([
    { firstPixel: [255, 0, 0, 255], everyPixelMatches: true },
    { firstPixel: [0, 255, 0, 255], everyPixelMatches: true },
  ]);
});

test("sparse fragment locations remain at attachment indices one and four", async () => {
  const source = wgsl[0]
    .replace("@location(0) color", "@location(1) color")
    .replace("@location(1) mask", "@location(4) mask");
  const snippets = swift.map((snippet) =>
    snippet.replace(
      /colorAttachments\[([01])\]/gu,
      (_, index: string) => `colorAttachments[${index === "0" ? 1 : 4}]`
    )
  );
  expect(source).toContain("@location(1) color");
  expect(source).toContain("@location(4) mask");
  for (const snippet of [snippets[0], snippets[2]]) {
    const indices = [...snippet.matchAll(/colorAttachments\[(\d+)\]/gu)].map(
      (match) => match[1]
    );
    expect([...new Set(indices)].sort()).toEqual(["1", "4"]);
  }
  expect(await renderTargets(source, snippets)).toEqual([
    { firstPixel: [255, 0, 0, 255], everyPixelMatches: true },
    { firstPixel: [0, 255, 0, 255], everyPixelMatches: true },
  ]);
});

async function renderTargets(
  source: string,
  snippets: string[]
): Promise<unknown> {
  const generated = await compileMetalPackage({
    moduleName: "AppShaders",
    programs: [
      {
        name: "Layers",
        source: "shaders/layers.wgsl",
        entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
      },
    ],
    modules: { "shaders/layers.wgsl": source },
    workerPath,
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice(),
      let queue = device.makeCommandQueue(),
      let commandBuffer = queue.makeCommandBuffer() else { fatalError("Metal device and commands required") }
let vertices = MTLVertexDescriptor()
vertices.attributes[0].format = .float2
vertices.attributes[0].offset = 0
vertices.attributes[0].bufferIndex = 0
vertices.layouts[0].stride = 8
vertices.layouts[0].stepFunction = .perVertex
let positions: [Float] = [-1, -1, 3, -1, -1, 3]
let vertexBuffer = positions.withUnsafeBufferPointer {
  device.makeBuffer(bytes: $0.baseAddress!, length: $0.count * 4, options: .storageModeShared)!
}
${snippets.join("\n")}
let buffers = [color, mask].map { texture -> any MTLBuffer in
  guard let buffer = device.makeBuffer(length: texture.width * texture.height * 4, options: .storageModeShared),
        let blit = commandBuffer.makeBlitCommandEncoder() else { fatalError("Readback resources required") }
  blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0,
            sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: texture.width, height: texture.height, depth: 1),
            to: buffer, destinationOffset: 0,
            destinationBytesPerRow: texture.width * 4,
            destinationBytesPerImage: texture.width * texture.height * 4)
  blit.endEncoding()
  return buffer
}
commandBuffer.commit()
commandBuffer.waitUntilCompleted()
if let error = commandBuffer.error { throw error }
precondition(commandBuffer.status == .completed)
let expected: [[UInt8]] = [[255, 0, 0, 255], [0, 255, 0, 255]]
let results: [[String: Any]] = buffers.enumerated().map { index, buffer in
  let bytes = UnsafeRawBufferPointer(start: buffer.contents(), count: buffer.length)
  return [
    "firstPixel": Array(bytes.prefix(4)),
    "everyPixelMatches": bytes.enumerated().allSatisfy { offset, byte in byte == expected[index][offset % 4] },
  ]
}
print(String(decoding: try JSONSerialization.data(withJSONObject: results), as: UTF8.self))
`
  );
  return JSON.parse(output);
}
