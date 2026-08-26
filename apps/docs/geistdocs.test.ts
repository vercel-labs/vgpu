import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { agent } from "./geistdocs";

const docsContent = (path: string) => readFileSync(new URL(`content/docs/${path}`, import.meta.url), "utf8");

describe("agent readiness metadata", () => {
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
    expect(mcp).toContain("## Hosted HTTP");
    expect(mcp).toContain("https://vgpu.sh/api/mcp");
    expect(mcp).toContain("## Local stdio");
  });
});
