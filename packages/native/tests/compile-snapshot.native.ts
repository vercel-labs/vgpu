import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureShaderGraph,
  type ShaderGraphSnapshot,
} from "@vgpu/wgsl/runtime";
import { afterEach, expect, test } from "vitest";
import { checkMetalPackage, compileMetalPackage } from "../src/compile.ts";
import type { GeneratedMetalPackage } from "../src/index.ts";
import { runConsumer } from "./native-support.ts";

const sourceGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/tooling/native-macos-metal-tooling-sources.docs.md",
    import.meta.url
  ),
  "utf8"
);
const wgsl = [...sourceGuide.matchAll(/```wgsl\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);
const computeGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/compute/native-macos-metal-compute-dispatch.docs.md",
    import.meta.url
  ),
  "utf8"
);
const swift = [...computeGuide.matchAll(/```swift\n([\s\S]*?)\n```/gu)].map(
  (match) => match[1]
);
const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

test("the exact source guide checks and compiles a serialized snapshot after deleting all source files", async () => {
  expect(wgsl).toHaveLength(2);
  const { rootDir, snapshot } = await countProject();
  const owned: ShaderGraphSnapshot = JSON.parse(JSON.stringify(snapshot));
  await rm(rootDir, { recursive: true });
  const input = countInput(owned);
  expect(await checkMetalPackage(input)).toEqual({
    moduleName: "AppShaders",
    programs: [{ name: "Count", stages: ["compute"] }],
  });
  expect(await executeCount(await compileMetalPackage(input))).toEqual([
    100, 101,
  ]);
});

test("a captured installed-package type alias preserves authored Swift uniforms and native pixels", async () => {
  const guide = readFileSync(
    new URL(
      "../../../docs/topics/native/macos/metal/native-macos-metal-uniforms.docs.md",
      import.meta.url
    ),
    "utf8"
  );
  const source = [...guide.matchAll(/```wgsl\n([\s\S]*?)\n```/gu)][0][1];
  const snippets = [...guide.matchAll(/```swift\n([\s\S]*?)\n```/gu)].map(
    (match) => match[1]
  );
  expect(snippets).toHaveLength(3);
  const rootDir = await mkdtemp(
    join(tmpdir(), "vgpu-native-snapshot-uniform-")
  );
  temporary.push(rootDir);
  const pkg = join(rootDir, "node_modules/shader-types");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "shader-types", exports: { ".": "./types.wgsl" } })
  );
  const split = source.indexOf("@group");
  await writeFile(join(pkg, "types.wgsl"), `export ${source.slice(0, split)}`);
  const entry = join(rootDir, "gradient.wgsl");
  await writeFile(
    entry,
    `import { Params as LocalParams } from "shader-types";\n${source
      .slice(split)
      .replace(": Params;", ": LocalParams;")}`
  );
  const snapshot = await captureShaderGraph({
    rootDir,
    entries: { Gradient: entry },
  });
  await rm(rootDir, { recursive: true });
  const generated = await compileMetalPackage({
    moduleName: "AppShaders",
    programs: [
      {
        name: "Gradient",
        source: snapshot.entries.Gradient,
        entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
      },
    ],
    snapshot,
    workerPath,
  });
  const pixels = await executeUniform(generated, snippets);
  expect(pixels).toHaveLength(4);
  pixels.forEach((value, index) =>
    expect(value).toBeCloseTo([0.28, 0.44, 0.8, 1][index], 6)
  );
});

test("relocation and caller mutation cannot change the checked or compiled source snapshot", async () => {
  const first = await countProject();
  const relocated = await countProject();
  expect(relocated.rootDir).not.toBe(first.rootDir);
  const expected = await compileMetalPackage(countInput(first.snapshot));
  const checkInput = countInput(JSON.parse(JSON.stringify(relocated.snapshot)));
  const checking = checkMetalPackage(checkInput);
  corruptCallerInput(checkInput);
  expect(await checking).toEqual({
    moduleName: "AppShaders",
    programs: [{ name: "Count", stages: ["compute"] }],
  });
  const buildInput = countInput(JSON.parse(JSON.stringify(relocated.snapshot)));
  const building = compileMetalPackage(buildInput);
  corruptCallerInput(buildInput);
  const actual = await building;
  const fingerprint = (generated: GeneratedMetalPackage) =>
    Object.entries(generated.files).map(([name, bytes]) => [
      name,
      createHash("sha256").update(bytes).digest("hex"),
    ]);
  expect(fingerprint(actual)).toEqual(fingerprint(expected));
  for (const bytes of Object.values(actual.files)) {
    expect(Buffer.from(bytes).includes(Buffer.from(first.rootDir))).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from(relocated.rootDir))).toBe(
      false
    );
  }
});

test("snapshot shader diagnostics expose resolved virtual provenance without physical checkout paths", async () => {
  const { rootDir } = await countProject();
  await writeFile(
    join(rootDir, "shaders/count.wgsl"),
    wgsl[0].replace("100u + index", "vec2u(100u)")
  );
  const snapshot = await captureShaderGraph({
    rootDir,
    entries: { Count: join(rootDir, "shaders/count.wgsl") },
  });
  await rm(rootDir, { recursive: true });
  const failure = await checkMetalPackage(countInput(snapshot)).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toMatchObject({
    stage: "validation",
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        phase: "wgsl",
        location: expect.objectContaining({
          kind: "generated-wgsl",
          virtualPath: "Intermediate/resolved.wgsl",
        }),
      }),
    ]),
  });
  for (const diagnostic of (failure as { diagnostics: { location?: object }[] })
    .diagnostics)
    expect(diagnostic.location).not.toHaveProperty("origin");
  expect(String(failure) + JSON.stringify(failure)).not.toContain(rootDir);
});

async function countProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vgpu-native-snapshot-"));
  temporary.push(rootDir);
  await mkdir(join(rootDir, "shaders"));
  await writeFile(join(rootDir, "shaders/count.wgsl"), wgsl[0]);
  await writeFile(join(rootDir, "shaders/dimensions.wgsl"), wgsl[1]);
  const snapshot = await captureShaderGraph({
    rootDir,
    entries: { Count: join(rootDir, "shaders/count.wgsl") },
  });
  return { rootDir, snapshot };
}

function countInput(snapshot: ShaderGraphSnapshot) {
  return {
    moduleName: "AppShaders",
    programs: [
      {
        name: "Count",
        source: snapshot.entries.Count,
        entryPoints: { compute: "count_main" },
      },
    ],
    snapshot,
    workerPath,
  };
}

function corruptCallerInput(input: ReturnType<typeof countInput>): void {
  input.workerPath = "/missing/changed-worker";
  input.programs[0].source = "changed.wgsl";
  input.programs[0].entryPoints.compute = "changed_main";
  const snapshot = input.snapshot as any;
  snapshot.entries.Count = "changed.wgsl";
  snapshot.modules["modules/0000.wgsl"].source = "invalid caller mutation";
  snapshot.modules["modules/0000.wgsl"].imports = {};
  snapshot.inputs[0].sha256 = "changed";
}

async function executeCount(
  generated: GeneratedMetalPackage
): Promise<number[]> {
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${swift[0]}
precondition(Count.workgroupSize.width == 2 && Count.workgroupSize.height == 1 && Count.workgroupSize.depth == 1)
let outputBuffer = device.makeBuffer(length: 8, options: .storageModeShared)!
let bindings = Count.Bindings(output: ShaderBufferRange(buffer: outputBuffer, offset: 0, length: 8))
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let encoder = command.makeComputeCommandEncoder()!
${swift[3]}
encoder.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
let values = (0..<2).map { outputBuffer.contents().load(fromByteOffset: $0 * 4, as: UInt32.self).littleEndian }
print(String(data: try JSONSerialization.data(withJSONObject: values), encoding: .utf8)!)
`
  );
  return JSON.parse(output);
}

async function executeUniform(
  generated: GeneratedMetalPackage,
  snippets: string[]
): Promise<number[]> {
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
${snippets[0]}
${snippets[1]}
let functions = try Gradient.load(device: device)
let vertices = MTLVertexDescriptor()
vertices.attributes[0].format = .float2
vertices.attributes[0].offset = 0
vertices.attributes[0].bufferIndex = 0
vertices.layouts[0].stride = 8
vertices.layouts[0].stepFunction = .perVertex
let descriptor = MTLRenderPipelineDescriptor()
descriptor.vertexFunction = functions.vertex
descriptor.fragmentFunction = functions.fragment
descriptor.vertexDescriptor = vertices
descriptor.colorAttachments[0].pixelFormat = .rgba32Float
let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
let positions: [Float] = [-1, -1, 3, -1, -1, 3]
let vertexBuffer = positions.withUnsafeBufferPointer { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count * 4, options: .storageModeShared)! }
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: 1, height: 1, mipmapped: false)
textureDescriptor.storageMode = .private
textureDescriptor.usage = [.renderTarget]
let texture = device.makeTexture(descriptor: textureDescriptor)!
let readback = device.makeBuffer(length: 256, options: .storageModeShared)!
let command = device.makeCommandQueue()!.makeCommandBuffer()!
let pass = MTLRenderPassDescriptor()
pass.colorAttachments[0].texture = texture
pass.colorAttachments[0].loadAction = .clear
pass.colorAttachments[0].storeAction = .store
let encoder = command.makeRenderCommandEncoder(descriptor: pass)!
encoder.setRenderPipelineState(pipeline)
encoder.setVertexBuffer(vertexBuffer, offset: 0, index: 0)
${snippets[2]}
encoder.endEncoding()
let blit = command.makeBlitCommandEncoder()!
blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 1, height: 1, depth: 1), to: readback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 256)
blit.endEncoding()
command.commit()
command.waitUntilCompleted()
precondition(command.status == .completed, String(describing: command.error))
let pixels = (0..<4).map { readback.contents().load(fromByteOffset: $0 * 4, as: Float.self) }
print(String(data: try JSONSerialization.data(withJSONObject: pixels), encoding: .utf8)!)
`
  );
  return JSON.parse(output);
}
