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
      "programs",
      "bindings",
      "resources",
      "rendering",
      "views",
      "lifecycle",
      "artifacts",
      "build",
      "compare",
      "...",
    ]);

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
    expect(rendering).toContain("do not expose an Apple-silicon mode");
    expect(rendering).toContain("Await each actor-owned instance in order");
    expect(rendering).not.toContain("The first native API is isolated to `@MainActor`");

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

    const index = docsContent("index.mdx");
    expect(index).toContain("[Review the native API proposal](/docs/native)");
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

  it("distinguishes semantic, Metal, Swift runner, and GPU architecture identities", () => {
    const semantic = nativeContract("semantic-v1.schema.json");
    const semanticSchema = JSON.parse(semantic);
    const projection = nativeContract("metal-projection-v1.schema.json");
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
    expect(projection).toContain('"internalBindings"');
    expect(projection).toContain('"metalCompilerTargetTriple"');
    expect(projection).not.toContain('"targetTriple"');
    expect(runnerRequest).toContain("Swift runner target triple");
    expect(runnerResponse).toContain('"gpuArchitecture"');
    expect(runnerResponse).not.toContain('"architecture":');
  });
});
