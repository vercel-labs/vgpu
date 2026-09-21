import { describe, expect, it } from "vitest";
import { createUnmatchedMarkdownNotFoundResponse } from "./markdown-not-found";

const options = { defaultLanguage: "en", languages: ["en", "cn"] } as const;

describe("unmatched Markdown responses", () => {
  it("returns a recoverable Markdown 404 for an unknown agent request", async () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/definitely-missing-agent-readiness", {
        headers: { Accept: "text/markdown" },
      }),
      options,
    );

    expect(response).not.toBeNull();
    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("text/markdown");
    expect(response?.headers.get("vary")?.toLowerCase().split(/\s*,\s*/u)).toContain("accept");
    expect(response?.headers.get("x-robots-tag")).toContain("noindex");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");

    const body = await response?.text();
    expect(body).toContain("# Page Not Found");
    expect(body).toContain("/llms.txt");
    expect(body).toContain("/llms-full.txt");
    expect(body).toContain("/sitemap.md");
  });

  it("localizes recovery links", async () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/cn/definitely-missing", {
        headers: { Accept: "text/markdown" },
      }),
      options,
    );
    const body = await response?.text();

    expect(response?.status).toBe(404);
    expect(body).toContain("/cn/llms.txt");
    expect(body).toContain("/cn/llms-full.txt");
    expect(body).toContain("/cn/sitemap.md");
  });

  it("serves the same recovery to a recognized AI agent without an Accept header", () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/definitely-missing", {
        headers: { "User-Agent": "ClaudeBot" },
      }),
      options,
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("text/markdown");
  });

  it.each([
    "/",
    "/about",
    "/about/",
    "/cn/contact",
    "/examples",
    "/cn/examples/",
    "/examples/triangle-led-front",
    "/examples/triangle-led-front/download",
    "/examples/triangle-led-front/v0.json",
    "/docs/get-started",
    "/llms.txt",
    "/cn/llms-full.txt",
  ])("preserves the valid HTML or route-handler response for %s", (path) => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request(`https://vgpu.sh${path}`, {
        headers: { Accept: "text/markdown" },
      }),
      options,
    );

    expect(response).toBeNull();
  });

  it("does not treat an unknown example slug as a valid app page", () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/examples/not-a-real-example", {
        headers: { Accept: "text/markdown" },
      }),
      options,
    );

    expect(response?.status).toBe(404);
    expect(response?.headers.get("content-type")).toContain("text/markdown");
  });

  it("preserves default-locale canonicalization before the fallback", () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/en/definitely-missing", {
        headers: { Accept: "text/markdown" },
      }),
      options,
    );

    expect(response).toBeNull();
  });

  it("preserves the normal HTML not-found flow", () => {
    const response = createUnmatchedMarkdownNotFoundResponse(
      new Request("https://vgpu.sh/definitely-missing", {
        headers: { Accept: "text/html" },
      }),
      options,
    );

    expect(response).toBeNull();
  });
});
