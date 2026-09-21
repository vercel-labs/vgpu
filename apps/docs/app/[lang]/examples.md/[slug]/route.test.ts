import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET, generateStaticParams } from "./route";

describe("example Markdown", () => {
  it("serves a README with the verified download command", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/gradient.md"), {
      params: Promise.resolve({ lang: "en", slug: "gradient" }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toMatch(/\bAccept\b/iu);
    expect(response.headers.get("link")).toContain(
      '<https://vgpu.sh/examples/gradient>; rel="canonical"',
    );
    expect(body).toContain("# Simple Gradient");
    expect(body).toContain(
      "Map screen coordinates to color with a tiny fullscreen fragment shader.",
    );
    expect(body).toContain(
      "npx vgpu examples pull gradient --out ./gradient",
    );
    expect(body).toContain("https://vgpu.sh/examples/gradient");
    expect(body).toContain("- `shader.wgsl`");
  });

  it("pre-renders every example in every language", () => {
    const params = generateStaticParams();

    expect(params).toContainEqual({ lang: "en", slug: "gradient" });
    expect(params).toContainEqual({ lang: "cn", slug: "three-tsl" });
  });

  it("returns a useful Markdown 404 for an unknown internal slug", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/unknown.md"), {
      params: Promise.resolve({ lang: "en", slug: "unknown" }),
    });
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(body).toContain("# Page Not Found");
    expect(body).toContain("/examples/gradient.md");
  });
});
