import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET, generateStaticParams } from "./route";

describe("example v0 registry route", () => {
  it("serves a complete registry item", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/gradient/v0.json"), {
      params: Promise.resolve({ lang: "en", slug: "gradient" }),
    });
    const item = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(item).toMatchObject({ name: "vgpu-gradient", type: "registry:block" });
    expect(item.files[0]).toMatchObject({
      path: "app/page.tsx",
      type: "registry:page",
      target: "app/page.tsx",
    });
    expect(
      item.files.find((file: { path: string }) => file.path === "examples/gradient/index.tsx"),
    ).toMatchObject({ type: "registry:component" });
    expect(item.files.map((file: { path: string }) => file.path)).toContain(
      "examples/gradient/shader.wgsl",
    );
    expect(item.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining(["next.config.mjs", "wgsl-env.d.ts"]),
    );
  });

  it("pre-renders every example in every language", () => {
    expect(generateStaticParams()).toContainEqual({ lang: "cn", slug: "three-tsl" });
  });

  it("returns JSON for an unknown slug", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/unknown/v0.json"), {
      params: Promise.resolve({ lang: "en", slug: "unknown" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Example not found" });
  });
});
