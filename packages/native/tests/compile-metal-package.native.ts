import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compileMetalPackage } from "../src/compile.ts";
import { runConsumer } from "./native-support.ts";

const guide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/native-macos-metal-rendering.docs.md",
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
const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("invalid imported WGSL reports native validation diagnostics without invented authored locations", async () => {
  const failure = await compileMetalPackage({
    ...configuration,
    workerPath,
    modules: {
      "shaders/palette.wgsl": wgsl[0].replace(
        "return vec4f(1.0, 0.0, 0.0, 1.0);",
        "return vec3f(1.0);"
      ),
      "shaders/triangle.wgsl": wgsl[1],
    },
  }).then(
    () => {
      throw new Error("unexpected generated package");
    },
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
    .diagnostics) {
    expect(diagnostic.location).not.toHaveProperty("origin");
  }
});

test("independent builds produce identical package bytes regardless of program or module order", async () => {
  const programs = ["Second", "First"].map((name) => ({
    ...configuration.programs[0],
    name,
  }));
  const modules = {
    "shaders/palette.wgsl": wgsl[0],
    "shaders/triangle.wgsl": wgsl[1],
  };
  const first = await compileMetalPackage({
    moduleName: "AppShaders",
    programs,
    modules,
    workerPath,
  });
  const second = await compileMetalPackage({
    moduleName: "AppShaders",
    programs: programs.slice().reverse(),
    modules: Object.fromEntries(Object.entries(modules).reverse()),
    workerPath,
  });
  const fingerprints = (files: Record<string, Uint8Array>) =>
    Object.entries(files).map(([path, bytes]) => [
      path,
      createHash("sha256").update(bytes).digest("hex"),
    ]);
  expect(fingerprints(second.files)).toEqual(fingerprints(first.files));
});

test("shared imported helpers coexist across both stages and multiple programs", async () => {
  const modules = {
    "shaders/shared.wgsl":
      "export fn shared(v: vec2f) -> vec2f { return v * 0.5; }",
    "shaders/main.wgsl": `import { shared } from "./shared.wgsl";
@vertex fn vertex_main(@location(0) position: vec2f) -> @builtin(position) vec4f { return vec4f(shared(position), 0.0, 1.0); }
@fragment fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f { return vec4f(shared(position.xy), 0.0, 1.0); }`,
  };
  const generated = await compileMetalPackage({
    moduleName: "SharedShaders",
    workerPath,
    modules,
    programs: ["First", "Second"].map((name) => ({
      name,
      source: "shaders/main.wgsl",
      entryPoints: { vertex: "vertex_main", fragment: "fragment_main" },
    })),
  });
  const output = await runConsumer(
    { SharedShaders: generated },
    `import Metal
import SharedShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal required") }
let first = try First.load(device: device)
let second = try Second.load(device: device)
precondition(first.vertex.name != second.vertex.name)
precondition(first.fragment.name != second.fragment.name)
precondition(Set([first.vertex.name, first.fragment.name, second.vertex.name, second.fragment.name]).count == 4)
print("shared helpers loaded")
`
  );
  expect(output).toBe("shared helpers loaded");
});

test("active storage resources fail explicitly at native validation", async () => {
  await expect(
    compileMetalPackage({
      ...configuration,
      workerPath,
      modules: {
        "shaders/palette.wgsl": wgsl[0],
        "shaders/triangle.wgsl": `${wgsl[1].replace(
          "return color();",
          "return params.color;"
        )}\nstruct Params { color: vec4f }\n@group(0) @binding(0) var<storage, read> params: Params;`,
      },
    }).then(() => "unexpected package")
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("resource bindings"),
  });
});

test("active overrides fail explicitly even when the WGSL supplies a default", async () => {
  await expect(
    compileMetalPackage({
      ...configuration,
      workerPath,
      modules: {
        "shaders/palette.wgsl": wgsl[0],
        "shaders/triangle.wgsl": `${wgsl[1].replace(
          "return color();",
          "return color() * multiplier;"
        )}\noverride multiplier: f32 = 1.0;`,
      },
    }).then(() => "unexpected package")
  ).rejects.toMatchObject({
    stage: "validation",
    message: expect.stringContaining("overrides"),
  });
});

test("compilation snapshots caller configuration before asynchronous work", async () => {
  const input = {
    ...structuredClone(configuration),
    modules: {
      "shaders/palette.wgsl": wgsl[0],
      "shaders/triangle.wgsl": wgsl[1],
    },
    workerPath,
  };
  const pending = compileMetalPackage(input);
  input.moduleName = "ChangedShaders";
  input.programs[0].name = "ChangedProgram";
  input.programs[0].entryPoints.fragment = "not_an_entry";
  input.modules["shaders/triangle.wgsl"] = "invalid source";
  const generated = await pending;
  expect(Object.keys(generated.files)).toContain(
    "Sources/AppShaders/Shaders.generated.swift"
  );
});

test.each([
  { label: "red", palette: wgsl[0], pixel: [255, 0, 0, 255] },
  {
    label: "green after changing only the imported helper",
    palette: wgsl[0].replace(
      "vec4f(1.0, 0.0, 0.0, 1.0)",
      "vec4f(0.0, 1.0, 0.0, 1.0)"
    ),
    pixel: [0, 255, 0, 255],
  },
])(
  "the exact imported-WGSL guide renders $label pixels with caller-owned Metal commands",
  async ({ palette, pixel }) => {
    expect(wgsl).toHaveLength(2);
    expect(swift).toHaveLength(3);
    const generated = await compileMetalPackage({
      ...configuration,
      modules: {
        "shaders/palette.wgsl": palette,
        "shaders/triangle.wgsl": wgsl[1],
      },
      workerPath,
    });
    const output = await runConsumer(
      { AppShaders: generated },
      `import Foundation
import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
${swift[0]}
${swift[1]}
let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 4, height: 4, mipmapped: false)
textureDescriptor.storageMode = .private
textureDescriptor.usage = [.renderTarget]
guard let texture = device.makeTexture(descriptor: textureDescriptor),
      let readback = device.makeBuffer(length: 1024, options: .storageModeShared),
      let queue = device.makeCommandQueue(),
      let commandBuffer = queue.makeCommandBuffer() else { fatalError("Metal allocation failed") }
let pass = MTLRenderPassDescriptor()
pass.colorAttachments[0].texture = texture
pass.colorAttachments[0].loadAction = .clear
pass.colorAttachments[0].storeAction = .store
pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 1, alpha: 1)
guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { fatalError("Metal encoder required") }
${swift[2]}
encoder.endEncoding()
guard let blit = commandBuffer.makeBlitCommandEncoder() else { fatalError("Metal blit required") }
blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: 4, height: 4, depth: 1), to: readback, destinationOffset: 0, destinationBytesPerRow: 256, destinationBytesPerImage: 1024)
blit.endEncoding()
commandBuffer.commit()
commandBuffer.waitUntilCompleted()
if let error = commandBuffer.error { throw error }
precondition(commandBuffer.status == .completed)
let bytes = readback.contents().assumingMemoryBound(to: UInt8.self)
let pixels = (0..<4).flatMap { y in (0..<16).map { x in Int(bytes[y * 256 + x]) } }
let result = try JSONSerialization.data(withJSONObject: pixels)
print(String(decoding: result, as: UTF8.self))
`
    );
    expect(JSON.parse(output)).toEqual(
      Array.from({ length: 16 }, () => pixel).flat()
    );
  }
);
