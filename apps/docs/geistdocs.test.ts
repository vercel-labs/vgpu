import { describe, expect, it } from "vitest";
import { agent } from "./geistdocs";

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
});
