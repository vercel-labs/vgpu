import { describe, expect, it } from "vitest";
import { SITE_ORIGIN, siteUrl } from "./site";

describe("canonical site URLs", () => {
  it("always resolves against the permanent apex origin", () => {
    expect(SITE_ORIGIN).toBe("https://vgpu.sh");
    expect(siteUrl()).toBe("https://vgpu.sh/");
    expect(siteUrl("/docs/get-started")).toBe("https://vgpu.sh/docs/get-started");
    expect(siteUrl("docs/cli")).toBe("https://vgpu.sh/docs/cli");
  });
});
