import { describe, expect, it } from "vitest";
import { agent, nav } from "./geistdocs";

describe("agent readiness metadata", () => {
  it("keeps project trust links out of the primary navigation", () => {
    expect(nav.map((item) => item.label)).toEqual(["Docs", "Examples"]);
  });

  it("advertises the real developer resources without claiming MCP support", () => {
    expect(agent.product.category).toBe("Developer tools");
    expect(agent.api?.openApiUrl).toBe("https://vgpu.sh/openapi.json");
    expect(agent.api?.errorsUrl).toContain("/docs/examples-api#errors");
    expect(agent.links?.map((link) => link.href)).toEqual(expect.arrayContaining([
      "https://github.com/vercel-labs/vgpu",
      "https://www.npmjs.com/package/vgpu",
      "https://vgpu.sh/docs/cli",
      "https://vgpu.sh/.well-known/vgpu-examples.json",
    ]));
    expect("mcp" in agent).toBe(false);
  });
});
