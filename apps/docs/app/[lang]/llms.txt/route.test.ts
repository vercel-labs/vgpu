import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("llms.txt index", () => {
  it("publishes a concise v2 index of canonical agent resources", async () => {
    const response = await GET(new Request("https://vgpu.sh/llms.txt"), {
      params: Promise.resolve({ lang: "en" }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("link")).toContain('<https://vgpu.sh/llms.txt>; rel="canonical"');
    expect(body.startsWith("# vgpu\n\n> ")).toBe(true);
    expect(body).toContain("## When to use vgpu");
    for (const guidance of [
      "Render to a canvas in the browser or headless through Dawn in Node.js",
      "Import and compose .wgsl shader modules like TypeScript",
      "Prefer `npx vgpu examples` for discovering and copying examples.",
    ]) {
      expect(body).toContain(guidance);
    }
    expect(body.length).toBeLessThan(30_000);
    for (const expected of [
      "/docs/get-started/agents.md",
      "/docs/get-started/web.md",
      "/docs/get-started/node.md",
      "/docs/cli.md",
      "/docs/examples-api.md",
      "/agents.md",
      "/openapi.json",
      "/.well-known/api-catalog",
      "/sitemap.md",
      "/llms-full.txt",
    ]) {
      expect(body).toContain(expected);
    }
    expect(body).not.toContain("```\n");
    expect(body).not.toContain("That's the whole instruction");
  });

  it("localizes documentation links for non-default languages", async () => {
    const response = await GET(new Request("https://vgpu.sh/cn/llms.txt"), {
      params: Promise.resolve({ lang: "cn" }),
    });
    const body = await response.text();

    expect(response.headers.get("link")).toContain('<https://vgpu.sh/cn/llms.txt>; rel="canonical"');
    expect(body).toContain("https://vgpu.sh/cn/docs/get-started/agents.md");
    expect(body).toContain("https://vgpu.sh/cn/llms-full.txt");
    expect(body).toContain("https://vgpu.sh/openapi.json");
  });
});
