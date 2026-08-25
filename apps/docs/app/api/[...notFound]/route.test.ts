import { describe, expect, it } from "vitest";
import * as route from "./route";

const expectedError = {
  error: {
    code: "VGPU-API-NOT-FOUND",
    message: "API endpoint not found",
    resolution: "Use the OpenAPI document to find a supported endpoint.",
    documentationUrl: "https://vgpu.sh/openapi.json",
  },
};

const request = (path: string, method = "GET") =>
  new Request(`https://vgpu.sh${path}`, { method });

describe("unmatched API route", () => {
  it.each([
    ["GET", route.GET],
    ["POST", route.POST],
    ["PUT", route.PUT],
    ["PATCH", route.PATCH],
    ["DELETE", route.DELETE],
    ["OPTIONS", route.OPTIONS],
  ] as const)("returns the same structured JSON 404 for %s", async (method, handler) => {
    const response = handler(request("/api/definitely-missing", method));

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await response.json()).toEqual(expectedError);
  });

  it("preserves the JSON headers and content length for HEAD without a body", async () => {
    const get = route.GET(request("/api/definitely-missing"));
    const head = route.HEAD(request("/api/definitely-missing", "HEAD"));

    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
    expect(await head.text()).toBe("");
  });
});
