import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("homepage Markdown", () => {
  it("publishes the canonical agent entry points with negotiated-response headers", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toMatch(/\bAccept\b/iu);
    const link = response.headers.get("link");
    expect(link).toContain('<https://vgpu.sh/>; rel="canonical"');
    expect(link).toContain('<https://vgpu.sh/index.md>; rel="alternate"; type="text/markdown"');
    expect(link).toContain('<https://vgpu.sh/llms.txt>; rel="describedby"; type="text/markdown"');
    expect(link).toContain('<https://vgpu.sh/openapi.json>; rel="service-desc"; type="application/json"');
    expect(link).toContain('<https://vgpu.sh/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"');
    for (const expected of [
      "pnpm add vgpu",
      "npx vgpu",
      "/docs/cli",
      "/examples",
      "/openapi.json",
      "/agents.md",
      "/llms.txt",
      "/llms-full.txt",
      "/sitemap.md",
    ]) {
      expect(body).toContain(expected);
    }
  });
});
