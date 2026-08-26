import { describe, expect, it } from "vitest";
import {
  homepageDiscoveryLinkHeader,
  homepageLinkHeader,
  SITE_IDENTITY_URLS,
  SITE_ORIGIN,
  localizedSitePath,
  localizedSiteUrl,
  siteUrl,
} from "./site";

describe("canonical site URLs", () => {
  it("always resolves against the permanent apex origin", () => {
    expect(SITE_ORIGIN).toBe("https://vgpu.sh");
    expect(siteUrl()).toBe("https://vgpu.sh/");
    expect(siteUrl("/docs/get-started")).toBe("https://vgpu.sh/docs/get-started");
    expect(siteUrl("docs/cli")).toBe("https://vgpu.sh/docs/cli");
    expect(localizedSitePath("/about", "en")).toBe("/about");
    expect(localizedSitePath("/about", "cn")).toBe("/cn/about");
    expect(localizedSiteUrl("/llms.txt", "en")).toBe("https://vgpu.sh/llms.txt");
    expect(localizedSiteUrl("/llms.txt", "cn")).toBe("https://vgpu.sh/cn/llms.txt");
  });

  it("advertises canonical agent discovery resources", () => {
    expect(homepageLinkHeader).toContain('<https://vgpu.sh/>; rel="canonical"');
    for (const expected of [
      '<https://vgpu.sh/index.md>; rel="alternate"; type="text/markdown"',
      '<https://vgpu.sh/llms.txt>; rel="describedby"; type="text/markdown"',
      '<https://vgpu.sh/sitemap.xml>; rel="sitemap"; type="application/xml"',
      '<https://vgpu.sh/openapi.json>; rel="service-desc"; type="application/json"',
      '<https://vgpu.sh/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
    ]) {
      expect(homepageDiscoveryLinkHeader).toContain(expected);
    }
    expect(SITE_IDENTITY_URLS).toEqual([
      "https://github.com/vercel-labs/vgpu",
      "https://www.npmjs.com/package/vgpu",
    ]);
  });
});
