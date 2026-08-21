import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("homepage Markdown", () => {
  it("publishes the canonical agent entry points with negotiated-response headers", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toMatch(/\bAccept\b/iu);
    expect(response.headers.get("link")).toBe('<https://vgpu.sh/>; rel="canonical"');
    for (const expected of [
      "pnpm add vgpu",
      "npx vgpu",
      "/docs/cli",
      "/examples",
      "/openapi.json",
      "/agents.md",
      "/llms.txt",
      "/sitemap.md",
    ]) {
      expect(body).toContain(expected);
    }
  });
});
