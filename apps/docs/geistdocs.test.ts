import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { agent, nav, navbarVariant } from "./geistdocs";
import { AGENT_INSTRUCTIONS, AGENT_USE_CASES } from "./lib/agent-guidance";
import { buildMetaFiles } from "../../packages/vgpu/lib/docs/generate/generate-geistdocs.js";

const docsContent = (path: string) =>
  readFileSync(new URL(`content/docs/${path}`, import.meta.url), "utf8");

describe("agent readiness metadata", () => {
  it("keeps project trust links out of the primary navigation", () => {
    expect(nav.map((item) => item.label)).toEqual(["Docs", "Examples"]);
    expect(navbarVariant).toBe("standard");
  });

  it("advertises the real developer resources and public MCP endpoint", () => {
    expect(agent.product.category).toBe("Developer tools");
    expect(agent.api?.openApiUrl).toBe("https://vgpu.sh/openapi.json");
    expect(agent.api?.errorsUrl).toContain("/docs/examples-api#errors");
    expect(agent.links?.map((link) => link.href)).toEqual(
      expect.arrayContaining([
        "https://github.com/vercel-labs/vgpu",
        "https://www.npmjs.com/package/vgpu",
        "https://vgpu.sh/docs/cli",
        "https://vgpu.sh/.well-known/vgpu-examples.json",
        "https://vgpu.sh/api/mcp",
      ])
    );
    expect(agent.mcp).toEqual({
      manifestUrl: "/.well-known/mcp.json",
      servers: [
        {
          name: "vgpu MCP",
          url: "https://vgpu.sh/api/mcp",
          description:
            "Stateless modern MCP tools for searching VGPU documentation and verified examples.",
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
    expect(index.indexOf("[CLI](/docs/cli)")).toBeLessThan(
      index.indexOf("[MCP](/docs/mcp)")
    );
    expect(index.indexOf("[MCP](/docs/mcp)")).toBeLessThan(
      index.indexOf("[ML](/docs/ml)")
    );

    const agents = docsContent("get-started/agents.mdx");
    expect(agents).toContain("https://vgpu.sh/api/mcp");
    expect(agents).toContain("[MCP reference](/docs/mcp)");
    expect(agents.indexOf("## Point your agent at the docs")).toBeLessThan(
      agents.indexOf("## Install the skill")
    );
    expect(agents.indexOf("## Install the skill")).toBeLessThan(
      agents.indexOf("## Connect the hosted MCP server")
    );

    const mcp = docsContent("mcp.md");
    expect(mcp).toContain("## Quick setup");
    expect(mcp).toContain("npx -y add-mcp https://vgpu.sh/api/mcp -g");
    expect(mcp).toContain("## What is VGPU MCP?");
    expect(mcp).toContain(
      "claude mcp add --transport http vgpu https://vgpu.sh/api/mcp"
    );
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

    const nativePages = JSON.parse(docsContent("native/meta.json"))
      .pages as string[];
    expect(nativePages).toEqual(["macos", "..."]);

    const macosPages = JSON.parse(docsContent("native/macos/meta.json"))
      .pages as string[];
    expect(macosPages).toEqual(["metal", "..."]);

    const metalPages = JSON.parse(docsContent("native/macos/metal/meta.json"))
      .pages as string[];
    expect(metalPages).toEqual([
      "functions",
      "rendering",
      "uniforms",
      "bindings",
      "render",
      "compute",
      "tooling",
      "...",
    ]);
    const renderPages = JSON.parse(
      docsContent("native/macos/metal/render/meta.json")
    ).pages as string[];
    expect(renderPages).toEqual(["targets", "..."]);
    const computePages = JSON.parse(
      docsContent("native/macos/metal/compute/meta.json")
    ).pages as string[];
    expect(computePages).toEqual([
      "dispatch",
      "prepared-bindings",
      "indirect-dispatch",
      "rendering",
      "...",
    ]);
    const toolingPages = JSON.parse(
      docsContent("native/macos/metal/tooling/meta.json")
    ).pages as string[];
    expect(toolingPages).toEqual([
      "configuration",
      "sources",
      "doctor",
      "build",
      "publication",
      "...",
    ]);

    const macos = docsContent("native/macos/index.md");
    expect(macos).toContain(
      "Your application owns the device, pipelines, resources, encoders"
    );
    expect(macos).toContain(
      "[Render WGSL with Metal](/native/macos/metal/rendering)"
    );
    expect(macos).toContain(
      "The generated package has no external Swift dependencies"
    );
    expect(macos).toContain(
      "The application does not require Node.js, Tint, or Xcode at launch"
    );
    expect(macos).not.toContain("try gpu.frame { frame in");

    const retiredPages = [
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
    ];
    for (const page of retiredPages)
      expect(
        existsSync(
          new URL("content/docs/native/macos/" + page + ".md", import.meta.url)
        )
      ).toBe(false);
    expect(macos).not.toContain("Earlier proposals");
    const build = docsContent("native/macos/metal/tooling/build.md");
    expect(build).toContain(
      "Doctor has real local-tarball coverage with an offline installation"
    );
    expect(build).toContain("dependency install scripts disabled");
    expect(build).toContain("The companion remains private and unpublished");
    expect(build).toContain(
      "`check`, `build`, and `verify` are not connected to installed commands yet"
    );
    expect(build).toContain("workflow and release support remain unqualified");

    const index = docsContent("index.mdx");
    expect(index).toContain("[Integrate WGSL with native Metal](/docs/native)");
  });

  it("derives nested Native metadata from navigation groups", () => {
    const files = buildMetaFiles(
      {
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
      },
      [
        { path: "native/index.md" },
        { path: "native/linux/index.md" },
        { path: "native/linux/programs.md" },
      ]
    );

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
    expect(() =>
      buildMetaFiles(
        {
          sections: [
            {
              title: "Native",
              href: "/native",
              groups: [
                {
                  title: "Linux basics",
                  items: [
                    { title: "Programs", href: "/native/linux/programs" },
                  ],
                },
                {
                  title: "Linux advanced",
                  items: [{ title: "Build", href: "/native/linux/build" }],
                },
              ],
            },
          ],
        },
        []
      )
    ).toThrow(
      'Native navigation has multiple groups for platform directory "linux"'
    );
  });

  it("keeps Native topic folders navigable in curated order", () => {
    const files = buildMetaFiles(
      {
        sections: [
          {
            title: "Native",
            href: "/native",
            groups: [
              {
                title: "macOS",
                items: [
                  { title: "Get started", href: "/native/macos" },
                  { title: "Functions", href: "/native/macos/metal/functions" },
                  { title: "Programs", href: "/native/macos/programs" },
                  { title: "Bindings", href: "/native/macos/metal/bindings" },
                  { title: "Metal overview", href: "/native/macos/metal" },
                  { title: "Setup", href: "/native/macos/metal/build/setup" },
                ],
              },
            ],
          },
        ],
      },
      [
        { path: "native/index.md" },
        { path: "native/macos/index.md" },
        { path: "native/macos/programs.md" },
        { path: "native/macos/metal/index.md" },
        { path: "native/macos/metal/functions.md" },
        { path: "native/macos/metal/bindings.md" },
        { path: "native/macos/metal/build/setup.md" },
      ]
    );

    expect(JSON.parse(files.get("native/macos/meta.json")!)).toEqual({
      title: "macOS",
      pages: ["metal", "programs", "..."],
    });
    expect(JSON.parse(files.get("native/macos/metal/meta.json")!)).toEqual({
      title: "Metal",
      pages: ["functions", "bindings", "build", "..."],
    });
    expect(
      JSON.parse(files.get("native/macos/metal/build/meta.json")!)
    ).toEqual({
      title: "Build",
      pages: ["setup", "..."],
    });
    expect(files.has("native/macos/metal/functions/meta.json")).toBe(false);
  });
});
