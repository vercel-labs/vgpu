import { beforeAll, expect, test } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { generateMetalPackage } from "../src/index.ts";
import { compileLibrary, runConsumer } from "./native-support.ts";

let library: Uint8Array;
const loadingGuide = readFileSync(
  new URL(
    "../../../docs/topics/native/macos/metal/native-macos-metal-functions.docs.md",
    import.meta.url
  ),
  "utf8"
);
const swiftSnippets = [
  ...loadingGuide.matchAll(/```swift\n([\s\S]*?)\n```/gu),
].map((match) => match[1]);

beforeAll(async () => {
  library = await compileLibrary(`#include <metal_stdlib>
using namespace metal;
vertex float4 selected_vertex(uint index [[vertex_id]]) { return float4(0, 0, 0, 1); }
fragment float4 selected_fragment() { return float4(1, 0, 0, 1); }
kernel void selected_compute() {}
constant bool required_flag [[function_constant(0)]];
constant bool optional_flag [[function_constant(1)]];
kernel void selected_constant(device uint* output [[buffer(0)]]) { output[0] = uint(required_flag); }
kernel void selected_defaulted_constant(device uint* output [[buffer(0)]]) {
  output[0] = is_function_constant_defined(optional_flag) ? uint(optional_flag) : 7;
}
`);
});

test("a separate Swift application loads render functions on its device and creates its own pipeline", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [
      {
        name: "Triangle",
        functions: { vertex: "selected_vertex", fragment: "selected_fragment" },
      },
    ],
  });
  expect(swiftSnippets).toHaveLength(3);
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
${swiftSnippets[0]}
let functions: Triangle.Functions = triangle
precondition(functions.vertex.name == "selected_vertex")
precondition(functions.fragment.name == "selected_fragment")
precondition(functions.vertex.functionType == .vertex)
precondition(functions.fragment.functionType == .fragment)
precondition(functions.vertex.device === device)
precondition(functions.fragment.device === device)
precondition(pipeline.device === device)
${swiftSnippets[2]}
print("native-loading-passed")
`
  );
  expect(output).toBe("native-loading-passed");
});

test("the documented compute snippet creates the application's native compute pipeline", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [
      { name: "StepParticles", functions: { compute: "selected_compute" } },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
${swiftSnippets[1]}
let functions: StepParticles.Functions = step
precondition(functions.compute.name == "selected_compute")
precondition(functions.compute.functionType == .kernel)
precondition(functions.compute.device === device)
precondition(pipeline.device === device)
print("native-compute-loading-passed")
`
  );
  expect(output).toBe("native-compute-loading-passed");
});

test("independent shader packages coexist with identical program names and partial stage selection", async () => {
  const secondLibrary = await compileLibrary(`#include <metal_stdlib>
using namespace metal;
fragment float4 independently_selected_fragment() { return float4(0, 1, 0, 1); }
`);
  const first = generateMetalPackage({
    moduleName: "FirstShaders",
    library,
    programs: [
      { name: "Triangle", functions: { vertex: "selected_vertex" } },
      { name: "lowercase_2", functions: { compute: "selected_compute" } },
    ],
  });
  const second = generateMetalPackage({
    moduleName: "SecondShaders",
    library: secondLibrary,
    programs: [
      {
        name: "Triangle",
        functions: { fragment: "independently_selected_fragment" },
      },
    ],
  });
  const output = await runConsumer(
    { FirstShaders: first, SecondShaders: second },
    `import Metal
import FirstShaders
import SecondShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
let first: FirstShaders.Triangle.Functions = try FirstShaders.Triangle.load(device: device)
let second: SecondShaders.Triangle.Functions = try SecondShaders.Triangle.load(device: device)
let edgeName: FirstShaders.lowercase_2.Functions = try FirstShaders.lowercase_2.load(device: device)
precondition(first.vertex.functionType == .vertex)
precondition(second.fragment.functionType == .fragment)
precondition(second.fragment.name == "independently_selected_fragment")
precondition(edgeName.compute.functionType == .kernel)
precondition(first.vertex.device === device)
precondition(second.fragment.device === device)
print("independent-packages-passed")
`
  );
  expect(output).toBe("independent-packages-passed");
});

test("the dependency-free package builds with PATH tool guards and runs after its original build tree is moved", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [
      {
        name: "Triangle",
        functions: { vertex: "selected_vertex", fragment: "selected_fragment" },
      },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
${swiftSnippets[0]}
precondition(triangle.vertex.device === device)
precondition(pipeline.device === device)
print("relocated-package-passed")
`,
    undefined,
    { isolatedDistribution: true }
  );
  expect(output).toBe("relocated-package-passed");
});

test("a missing selected function reports its authored program and selected stage", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [
      { name: "Triangle", functions: { fragment: "absent_fragment" } },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Missing function was accepted")
} catch let ShaderLoadError.missingFunction(program, stage) {
  precondition(program == "Triangle")
  precondition(stage == .fragment)
  print("missing-function-rejected")
}
`
  );
  expect(output).toBe("missing-function-rejected");
});

test("a function from the wrong Metal stage is rejected before it reaches an application pipeline", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [
      { name: "Triangle", functions: { fragment: "selected_vertex" } },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Wrong stage was accepted")
} catch let ShaderLoadError.unexpectedFunctionStage(program, stage, actual) {
  precondition(program == "Triangle")
  precondition(stage == .fragment)
  precondition(actual == .vertex)
  print("wrong-stage-rejected")
}
`
  );
  expect(output).toBe("wrong-stage-rejected");
});

test("changed packaged library bytes are rejected before Metal loading", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  });
  const resource = Object.entries(generated.files).find(([name]) =>
    name.endsWith(".metallib")
  );
  expect(resource).toBeDefined();
  resource![1][resource![1].length - 1] ^= 1;
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Changed library was accepted")
} catch ShaderLoadError.libraryIntegrityMismatch {
  print("changed-library-rejected")
}
`
  );
  expect(output).toBe("changed-library-rejected");
});

test("a Metal library creation failure retains the underlying system error", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library: new TextEncoder().encode("not a Metal library"),
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Invalid library was accepted")
} catch let ShaderLoadError.libraryCreationFailed(underlying) {
  let systemError = underlying as NSError
  precondition(!systemError.domain.isEmpty)
  precondition(!(underlying is ShaderLoadError))
  print("library-creation-failed")
}
`
  );
  expect(output).toBe("library-creation-failed");
});

test("a missing library resource inside an intact package bundle has a typed error", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Missing library resource was accepted")
} catch ShaderLoadError.resourceUnavailable {
  print("missing-resource-rejected")
}
`,
    (binaryDirectory) => {
      const resources = readdirSync(binaryDirectory, {
        recursive: true,
      }).filter((name) => String(name).endsWith(".metallib"));
      expect(resources).toHaveLength(1);
      unlinkSync(join(binaryDirectory, String(resources[0])));
    }
  );
  expect(output).toBe("missing-resource-rejected");
});

test("an unreadable library resource retains its Foundation error", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `import Foundation
import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  fatalError("Unreadable library resource was accepted")
} catch let ShaderLoadError.resourceUnreadable(underlying) {
  precondition((underlying as NSError).domain == NSCocoaErrorDomain)
  print("unreadable-resource-rejected")
}
`,
    (binaryDirectory) => {
      const resources = readdirSync(binaryDirectory, {
        recursive: true,
      }).filter((name) => String(name).endsWith(".metallib"));
      expect(resources).toHaveLength(1);
      const resource = join(binaryDirectory, String(resources[0]));
      unlinkSync(resource);
      mkdirSync(resource);
    }
  );
  expect(output).toBe("unreadable-resource-rejected");
});

test("removing the entire SwiftPM bundle is an upstream packaging failure, not a typed loader error", async () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library,
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  });
  await expect(
    runConsumer(
      { AppShaders: generated },
      `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try Triangle.load(device: device)
  print("unexpected-success")
} catch is ShaderLoadError {
  print("unexpected-typed-loader-error")
}
`,
      (binaryDirectory) => {
        const resources = readdirSync(binaryDirectory, {
          recursive: true,
        }).filter((name) => String(name).endsWith(".metallib"));
        expect(resources).toHaveLength(1);
        let bundle = dirname(join(binaryDirectory, String(resources[0])));
        while (!bundle.endsWith(".bundle") && bundle !== binaryDirectory)
          bundle = dirname(bundle);
        expect(bundle.startsWith(`${binaryDirectory}/`)).toBe(true);
        expect(bundle.endsWith(".bundle")).toBe(true);
        rmSync(bundle, { recursive: true });
      }
    )
  ).rejects.toThrow(/could not load resource bundle/u);
});

test.each(["selected_constant", "selected_defaulted_constant"])(
  "remaining function constant metadata is unsupported: %s",
  async (functionName) => {
    const generated = generateMetalPackage({
      moduleName: "AppShaders",
      library,
      programs: [
        { name: "StepParticles", functions: { compute: functionName } },
      ],
    });
    const output = await runConsumer(
      { AppShaders: generated },
      `import Metal
import AppShaders
guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Metal device required") }
do {
  _ = try StepParticles.load(device: device)
  fatalError("Function constant metadata was accepted")
} catch let ShaderLoadError.functionConstantsUnsupported(program, stage) {
  precondition(program == "StepParticles")
  precondition(stage == .compute)
  print("function-constants-rejected")
}
`
    );
    expect(output).toBe("function-constants-rejected");
  }
);
