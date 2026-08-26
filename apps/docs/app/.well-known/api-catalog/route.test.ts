import { describe, expect, it } from "vitest";
import { API_CATALOG_PROFILE } from "../../../lib/api-catalog";
import { GET, HEAD } from "./route";

describe("RFC 9727 API catalog", () => {
  it("links the existing examples API to its machine and human descriptions", async () => {
    const response = GET();
    const document = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      `application/linkset+json; profile="${API_CATALOG_PROFILE}"`,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      response.headers.get("access-control-expose-headers")?.toLowerCase().split(/\s*,\s*/u),
    ).toContain("link");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("link")).toBe(
      '<https://vgpu.sh/.well-known/api-catalog>; rel="api-catalog"',
    );
    expect(document).toEqual({
      linkset: expect.arrayContaining([
        expect.objectContaining({
          anchor: "https://vgpu.sh/.well-known/api-catalog",
          item: [{ href: "https://vgpu.sh/.well-known/vgpu-examples.json", type: "application/json" }],
        }),
        expect.objectContaining({
          anchor: "https://vgpu.sh/.well-known/vgpu-examples.json",
          "service-desc": [{ href: "https://vgpu.sh/openapi.json", type: "application/json" }],
          "service-doc": [{ href: "https://vgpu.sh/docs/examples-api", type: "text/html" }],
        }),
      ]),
    });
  });

  it("returns GET-equivalent headers without a HEAD body", async () => {
    const get = GET();
    const head = HEAD();

    expect(head.status).toBe(get.status);
    for (const header of [
      "access-control-allow-origin",
      "access-control-expose-headers",
      "cache-control",
      "content-length",
      "content-type",
      "link",
      "x-content-type-options",
    ]) {
      expect(head.headers.get(header), header).toBe(get.headers.get(header));
    }
    expect(head.headers.get("link")).toContain('rel="api-catalog"');
    expect(await head.text()).toBe("");
  });
});
