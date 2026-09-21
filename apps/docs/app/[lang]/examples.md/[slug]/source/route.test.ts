import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { exampleSources } from "../../../../../lib/examples-source.generated";
import { GET, generateStaticParams } from "./route";

describe("example source Markdown", () => {
  it("serves every source file in canonical order", async () => {
    const response = await GET(
      new Request("https://vgpu.sh/examples/gradient/source.md"),
      { params: Promise.resolve({ lang: "en", slug: "gradient" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("vary")).toMatch(/\bAccept\b/iu);
    expect(response.headers.get("link")).toContain(
      '<https://vgpu.sh/examples/gradient>; rel="canonical"',
    );
    expect(body).toContain("# Simple Gradient source");

    let previousFileIndex = -1;
    for (const file of exampleSources.gradient.files) {
      const heading = `## \`${file.path}\``;
      const fileIndex = body.indexOf(heading);
      expect(fileIndex, `${file.path} is missing`).toBeGreaterThan(
        previousFileIndex,
      );
      expect(body).toContain(file.content);
      previousFileIndex = fileIndex;
    }
  });

  it("pre-renders every example in every language", () => {
    const params = generateStaticParams();

    expect(params).toContainEqual({ lang: "en", slug: "gradient" });
    expect(params).toContainEqual({ lang: "cn", slug: "three-tsl" });
  });

  it("makes public asset URLs portable", async () => {
    const response = await GET(
      new Request("https://vgpu.sh/examples/three-tsl/source.md"),
      { params: Promise.resolve({ lang: "en", slug: "three-tsl" }) },
    );
    const body = await response.text();

    expect(body).toContain(
      'HDRI_URL = "https://vgpu.sh/examples/three-tsl/sunset.exr"',
    );
    expect(body).not.toContain(
      'HDRI_URL = "/examples/three-tsl/sunset.exr"',
    );
  });

  it("returns a useful Markdown 404 for an unknown internal slug", async () => {
    const response = await GET(
      new Request("https://vgpu.sh/examples/unknown/source.md"),
      { params: Promise.resolve({ lang: "en", slug: "unknown" }) },
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(body).toContain("# Page Not Found");
    expect(body).toContain("/examples/gradient/source.md");
  });
});
