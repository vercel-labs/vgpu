import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { agent, nav, navbarVariant } from "./geistdocs";
import { AGENT_INSTRUCTIONS, AGENT_USE_CASES } from "./lib/agent-guidance";
import { buildMetaFiles } from "../../packages/vgpu/lib/docs/generate/generate-geistdocs.js";

const docsContent = (path: string) => readFileSync(new URL(`content/docs/${path}`, import.meta.url), "utf8");
const nativeContract = (path: string) => readFileSync(
  new URL(`../../docs/plans/native/contracts/${path}`, import.meta.url),
  "utf8",
);

describe("agent readiness metadata", () => {
  it("keeps project trust links out of the primary navigation", () => {
    expect(nav.map((item) => item.label)).toEqual(["Docs", "Examples"]);
    expect(navbarVariant).toBe("standard");
  });

  it("advertises the real developer resources and public MCP endpoint", () => {
    expect(agent.product.category).toBe("Developer tools");
    expect(agent.api?.openApiUrl).toBe("https://vgpu.sh/openapi.json");
    expect(agent.api?.errorsUrl).toContain("/docs/examples-api#errors");
    expect(agent.links?.map((link) => link.href)).toEqual(expect.arrayContaining([
      "https://github.com/vercel-labs/vgpu",
      "https://www.npmjs.com/package/vgpu",
      "https://vgpu.sh/docs/cli",
      "https://vgpu.sh/.well-known/vgpu-examples.json",
      "https://vgpu.sh/api/mcp",
    ]));
    expect(agent.mcp).toEqual({
      manifestUrl: "/.well-known/mcp.json",
      servers: [
        {
          name: "vgpu MCP",
          url: "https://vgpu.sh/api/mcp",
          description: "Stateless modern MCP tools for searching VGPU documentation and verified examples.",
        },
      ],
    });
  });

  it("uses the centralized best-fit guidance", () => {
    expect(agent.product.useCases).toEqual(AGENT_USE_CASES);
    expect(agent.instructions).toEqual(AGENT_INSTRUCTIONS);
    const instructions = agent.instructions?.join("\n") ?? "";
    expect(instructions).toContain("npx vgpu mcp --output-dir /absolute/path");
    expect(instructions).toContain("relative `destination`");
    expect(instructions).toContain("configured output directory");
  });

  it("makes MCP a first-class docs and agent-onboarding destination", () => {
    const pages = JSON.parse(docsContent("meta.json")).pages as string[];
    const cli = pages.indexOf("cli");
    expect(pages.slice(cli, cli + 3)).toEqual(["cli", "mcp", "ml"]);

    const index = docsContent("index.mdx");
    expect(index.indexOf("[CLI](/docs/cli)")).toBeLessThan(index.indexOf("[MCP](/docs/mcp)"));
    expect(index.indexOf("[MCP](/docs/mcp)")).toBeLessThan(index.indexOf("[ML](/docs/ml)"));

    const agents = docsContent("get-started/agents.mdx");
    expect(agents).toContain("https://vgpu.sh/api/mcp");
    expect(agents).toContain("[MCP reference](/docs/mcp)");
    expect(agents.indexOf("## Point your agent at the docs")).toBeLessThan(
      agents.indexOf("## Install the skill"),
    );
    expect(agents.indexOf("## Install the skill")).toBeLessThan(
      agents.indexOf("## Connect the hosted MCP server"),
    );

    const mcp = docsContent("mcp.md");
    expect(mcp).toContain("## Quick setup");
    expect(mcp).toContain("npx -y add-mcp https://vgpu.sh/api/mcp -g");
    expect(mcp).toContain("## What is VGPU MCP?");
    expect(mcp).toContain("claude mcp add --transport http vgpu https://vgpu.sh/api/mcp");
    expect(mcp).toContain("codex mcp add vgpu --url https://vgpu.sh/api/mcp");
    expect(mcp).toContain("## Try it");
    expect(mcp).toContain("## Hosted HTTP");
    expect(mcp).toContain("https://vgpu.sh/api/mcp");
    expect(mcp).toContain("## Local stdio");
    expect(mcp).toContain("## Security");
    expect(mcp).toContain("## Troubleshooting");
  });

  it("makes Native a top-level documentation section", () => {
    const pages = JSON.parse(docsContent("meta.json")).pages as string[];
    expect(pages[pages.indexOf("ml") + 1]).toBe("native");

    const nativePages = JSON.parse(docsContent("native/meta.json")).pages as string[];
    expect(nativePages).toEqual(["macos", "..."]);

    const macosPages = JSON.parse(docsContent("native/macos/meta.json")).pages as string[];
    expect(macosPages).toEqual([
      "metal",
      "programs",
      "bindings",
      "resources",
      "rendering",
      "gpu-driven-drawing",
      "views",
      "lifecycle",
      "artifacts",
      "build",
      "compare",
      "...",
    ]);

    const metalPages = JSON.parse(docsContent("native/macos/metal/meta.json")).pages as string[];
    expect(metalPages).toEqual(["functions", "rendering", "uniforms", "bindings", "render", "compute", "tooling", "..."]);
    const renderPages = JSON.parse(docsContent("native/macos/metal/render/meta.json")).pages as string[];
    expect(renderPages).toEqual(["targets", "..."]);
    const computePages = JSON.parse(docsContent("native/macos/metal/compute/meta.json")).pages as string[];
    expect(computePages).toEqual(["dispatch", "prepared-bindings", "..."]);
    const toolingPages = JSON.parse(docsContent("native/macos/metal/tooling/meta.json")).pages as string[];
    expect(toolingPages).toEqual(["configuration", "sources", "build", "..."]);

    const macos = docsContent("native/macos/index.md");
    expect(macos).toContain("let gpu = try VGPU.metal(device: device)");
    expect(macos).toContain("import VGPUMetal");
    expect(macos).toContain("Apple silicon and macOS 14 or later as the supported application target");
    expect(macos).toContain("does not include Intel-based Macs or Intel and AMD GPUs");
    expect(macos).toContain("If the closure throws before submission, the frame cancels");
    expect(macos).not.toContain("VGPUKit");
    expect(macos).toContain("let scene = try gpu.target");
    expect(macos).toContain("try gpu.frame { frame in");
    expect(macos).not.toContain("Gradient.View(");

    const rendering = docsContent("native/macos/rendering.md");
    expect(rendering).toContain("VGPU.metal(commandQueue: commandQueue)");
    expect(rendering).toContain("the backend-neutral `VGPUSurface` handle has no global actor annotation");
    expect(rendering).toContain("public enum VGPUFramePassResult: Sendable");
    expect(rendering).toContain("throws -> VGPUSubmission");
    expect(rendering).toContain("let submission = try update.dispatch");
    expect(rendering).toContain("blocks inside `submitCompute`");
    expect(rendering).toContain("do not expose an Apple-silicon mode");
    expect(rendering).toContain("Await each actor-owned instance in order");
    expect(rendering).not.toContain("The first native API is isolated to `@MainActor`");

    const gpuDrivenDrawing = docsContent("native/macos/gpu-driven-drawing.md");
    expect(gpuDrivenDrawing).toContain("additionalUsage: [.indirect]");
    expect(gpuDrivenDrawing).toContain("slice(bytes: 16..<32)");
    expect(gpuDrivenDrawing).toContain("Do not await the compute submission");
    expect(gpuDrivenDrawing).toContain("`VGPU-INDIRECT-INVALID`");
    expect(gpuDrivenDrawing).toContain("`VGPUError.contextMismatch`");
    expect(gpuDrivenDrawing).not.toContain("VGPUIndirectArguments");

    const views = docsContent("native/macos/views.md");
    expect(views).toContain("`@MainActor` is a contract of the view adapter");
    expect(views).toContain("The handle itself has no global actor annotation");
    expect(views).toContain("Call them explicitly: a normal deinitializer cannot safely clear the delegate");

    const resources = docsContent("native/macos/resources.md");
    expect(resources).toContain("import VGPUMetalInterop");
    expect(resources).toContain("Only one vgpu wrapper may claim the same exact `MTLResource`");
    expect(resources).toContain("not zero-copy access or a particular Metal storage mode");
    expect(resources.indexOf("try importedBuffer.dispose()")).toBeLessThan(
      resources.indexOf("await firstGPU.settled()"),
    );

    const lifecycle = docsContent("native/macos/lifecycle.md");
    expect(lifecycle).toContain("@escaping @isolated(any) @Sendable (VGPUError) -> Void");
    expect(lifecycle).not.toContain("sending @escaping");
    expect(lifecycle).toContain("public struct VGPUErrorCode: RawRepresentable, Hashable, Sendable");
    expect(lifecycle).toContain("public struct VGPUSubmission: Sendable");
    expect(lifecycle).toContain("Do not await every submission in an animation loop");
    expect(lifecycle).toContain("gpu.settled()` snapshots all work already known to the context");
    expect(lifecycle).toContain("VGPU-NATIVE-CONCURRENT-ACCESS");
    expect(lifecycle).toContain("isolation: isolated (any Actor)? = #isolation");
    expect(lifecycle).toContain("The first release does not rely on Swift 6.2 `isolated deinit`");

    const artifacts = docsContent("native/macos/artifacts.md");
    expect(artifacts).toContain("vgpu-native-semantic/v1");
    expect(artifacts).toContain("vgpu-native-metal-projection/v1");
    expect(artifacts).toContain("Metal compiler target triple");
    expect(artifacts).toContain("Intel-based Macs and Intel or AMD GPUs remain outside that matrix");
    expect(artifacts).toContain("it does not remove compute functions already packaged");
    expect(artifacts).not.toContain("VGPUKit");

    const build = docsContent("native/macos/build.md");
    expect(build).toContain("compiles the generated layout conformance from a separate SwiftPM package");
    expect(build).toContain("one additional typed Metal process");
    expect(build).toContain("one external generated `VGPUComputeProgram`");
    expect(build).toContain("depends only on `VGPUABI`");
    expect(build).toContain("a racing `gpu.settled()` sees the registered work");
    expect(build).toContain("requires byte-identical reports");

    const index = docsContent("index.mdx");
    expect(index).toContain("[Review the native API proposal](/docs/native)");
  });

  it("documents fixed-prefix runtime arrays as explicit immutable binding views", () => {
    const resources = docsContent("native/macos/resources.md");
    expect(resources).toContain("Values.self");
    expect(resources).toContain("capacity: 4");
    expect(resources).toContain("try values.writePrefix(.init(prefix: 88))");
    expect(resources).toContain("try values.writeElements(replacementParticles, at: 2)");
    expect(resources).toContain("let firstTwo = try values.binding(elementCount: 2)");
    expect(resources).toContain("let allFour = try values.binding(elementCount: 4)");
    expect(resources).toContain("starts with `tailOffset + elementCount × stride`");
    expect(resources).toContain("Padding is valid when it stays inside the requested count's byte interval");
    expect(resources).toContain("makes `3` the first valid count");
    expect(resources).toContain("this profile accepts only even counts");
    expect(resources).not.toContain("values.updatePrefix");

    const bindings = docsContent("native/macos/bindings.md");
    expect(bindings).toContain("public enum Values: VGPURuntimeArrayLayout");
    expect(bindings).toContain("omitted from the WGSL excerpt");
    expect(bindings).toContain("underscored descriptor and packer witnesses");
    expect(bindings).toContain("public typealias Binding = VGPURuntimeStorageBinding<Values>");
    expect(bindings).toContain("public var values: VGPURuntimeStorageBinding<Values>");
    expect(bindings).toContain("let visibleValues = try values.binding(elementCount: 2)");
    expect(bindings).toContain(
      "A root runtime array such as `array<Particle>` remains `VGPUStorage<Particle>`",
    );
    expect(bindings).toContain(
      "`Values` has a 4-byte prefix and a 12-byte trailing-element stride",
    );
    expect(bindings).toContain("views expose 28 and 52 bytes");
    expect(bindings).toContain("writes `[2, 202]` and `[4, 404]`");
  });

  it("derives nested Native metadata from navigation groups", () => {
    const files = buildMetaFiles({
      sections: [
        {
          title: "Native",
          href: "/native",
          groups: [
            {
              title: "Linux",
              items: [
                { title: "Get started", href: "/native/linux" },
                { title: "Programs", href: "/native/linux/programs" },
              ],
            },
          ],
        },
      ],
    }, [
      { path: "native/index.md" },
      { path: "native/linux/index.md" },
      { path: "native/linux/programs.md" },
    ]);

    expect(JSON.parse(files.get("native/meta.json")!)).toEqual({
      title: "Native",
      pages: ["linux", "..."],
    });
    expect(JSON.parse(files.get("native/linux/meta.json")!)).toEqual({
      title: "Linux",
      pages: ["programs", "..."],
    });
  });

  it("rejects duplicate navigation groups for one Native platform", () => {
    expect(() => buildMetaFiles({
      sections: [
        {
          title: "Native",
          href: "/native",
          groups: [
            { title: "Linux basics", items: [{ title: "Programs", href: "/native/linux/programs" }] },
            { title: "Linux advanced", items: [{ title: "Build", href: "/native/linux/build" }] },
          ],
        },
      ],
    }, [])).toThrow('Native navigation has multiple groups for platform directory "linux"');
  });

  it("keeps Native topic folders navigable in curated order", () => {
    const files = buildMetaFiles({
      sections: [{
        title: "Native",
        href: "/native",
        groups: [{
          title: "macOS",
          items: [
            { title: "Get started", href: "/native/macos" },
            { title: "Functions", href: "/native/macos/metal/functions" },
            { title: "Programs", href: "/native/macos/programs" },
            { title: "Bindings", href: "/native/macos/metal/bindings" },
            { title: "Metal overview", href: "/native/macos/metal" },
            { title: "Setup", href: "/native/macos/metal/build/setup" },
          ],
        }],
      }],
    }, [
      { path: "native/index.md" },
      { path: "native/macos/index.md" },
      { path: "native/macos/programs.md" },
      { path: "native/macos/metal/index.md" },
      { path: "native/macos/metal/functions.md" },
      { path: "native/macos/metal/bindings.md" },
      { path: "native/macos/metal/build/setup.md" },
    ]);

    expect(JSON.parse(files.get("native/macos/meta.json")!)).toEqual({
      title: "macOS",
      pages: ["metal", "programs", "..."],
    });
    expect(JSON.parse(files.get("native/macos/metal/meta.json")!)).toEqual({
      title: "Metal",
      pages: ["functions", "bindings", "build", "..."],
    });
    expect(JSON.parse(files.get("native/macos/metal/build/meta.json")!)).toEqual({
      title: "Build",
      pages: ["setup", "..."],
    });
    expect(files.has("native/macos/metal/functions/meta.json")).toBe(false);
  });

  it("distinguishes semantic, Metal, Swift runner, and GPU architecture identities", () => {
    const semantic = nativeContract("semantic-v1.schema.json");
    const semanticSchema = JSON.parse(semantic);
    const projection = nativeContract("metal-projection-v1.schema.json");
    const projectionSchema = JSON.parse(projection);
    const runnerRequest = nativeContract("metal-runner-request-v1.schema.json");
    const runnerResponse = nativeContract("metal-runner-response-v1.schema.json");

    expect(() => JSON.parse(semantic)).not.toThrow();
    expect(() => JSON.parse(projection)).not.toThrow();
    expect(() => JSON.parse(runnerRequest)).not.toThrow();
    expect(() => JSON.parse(runnerResponse)).not.toThrow();
    expect(semantic).toContain('"layoutModel"');
    expect(semantic).toContain('"wgsl-host-shareable-v1"');
    expect(semantic).toContain('"languageFeatures"');
    expect(semanticSchema.$defs.layout.properties.addressSpace).toBeUndefined();
    expect(semanticSchema.$defs.bufferBinding.properties.addressSpace).toBeDefined();
    expect(projection).toContain('"vgpu-metal-binding-slots-v1"');
    expect(projection).toContain('"immediateDataLayoutModel"');
    expect(projectionSchema.required).toContain("immediateDataLayoutModel");
    expect(projectionSchema.properties.immediateDataLayoutModel.pattern).toBe(
      "^vgpu-metal-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$",
    );
    expect(projection).toContain('"internalBindings"');
    expect(projection).toContain('"metalCompilerTargetTriple"');
    expect(projection).not.toContain('"targetTriple"');
    expect(runnerRequest).toContain("Swift runner target triple");
    expect(runnerResponse).toContain('"gpuArchitecture"');
    expect(runnerResponse).not.toContain('"architecture":');
  });

  it("keeps the native artifact proposal aligned with the validated C3 boundaries", () => {
    const macos = docsContent("native/macos/index.md");
    const programs = docsContent("native/macos/programs.md");
    const artifacts = docsContent("native/macos/artifacts.md");
    const build = docsContent("native/macos/build.md");
    const compare = docsContent("native/macos/compare.md");
    const semantic = nativeContract("semantic-v1.schema.json");

    expect(macos).toContain('.upToNextMinor(from: "<version>")');
    expect(programs).toContain("transitive type and layout closure");
    expect(programs).toContain("unrelated types or layouts do not");
    expect(artifacts).toContain("vgpu-native-program/v1");
    expect(artifacts).toContain("transitively reached elemental layout");
    expect(artifacts).toContain("separate runner-build fingerprint");
    expect(artifacts).toContain("vgpu-metal-immediate-data-layout-v1");
    expect(artifacts).toContain("Support for `immediateDataLayoutModel`");
    expect(artifacts).toContain("Support for `storageBufferSizeModel`");
    expect(artifacts).toContain("its emission policy remains open");
    expect(build).toContain("C3a passed the current structural artifact fixture");
    expect(build).toContain("intentionally invalid UTF-8 text");
    expect(build).toContain("C3b now passes");
    expect(build).toContain("unknown immediate-data layout model");
    expect(build).toContain("unknown storage-buffer-size model");
    expect(build).toContain("does not implement the compare request and response protocol");
    expect(compare).toContain("`single-json-eof` framing");
    expect(compare).toContain("`AppShadersC3MetalProbe`");
    expect(compare).toContain("whether generation always emits the runner");
    expect(compare).not.toContain(
      "The generated package includes an `AppShadersMetalRunner` executable target used only by tests",
    );
    expect(semantic).toContain("referenced WGSL input IDs and content hashes");
    expect(semantic).toContain("transitively reachable types and intrinsic layouts");
  });
});
