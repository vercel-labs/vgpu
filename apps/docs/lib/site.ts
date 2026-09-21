export const SITE_ORIGIN = "https://vgpu.sh" as const;
export const SITE_NAME = "vgpu" as const;
export const SITE_DESCRIPTION = "The WebGPU library, designed for agents." as const;
export const SITE_OG_IMAGE_PATH = "/hero/og.webp" as const;
export const SITE_IDENTITY_URLS = [
  "https://github.com/vercel-labs/vgpu",
  "https://www.npmjs.com/package/vgpu",
] as const;

export function siteUrl(path = "/"): string {
  return new URL(path, SITE_ORIGIN).toString();
}

export function localizedSitePath(path: string, lang: string): string {
  return lang === "en" ? path : `/${lang}${path}`;
}

export function localizedSiteUrl(path: string, lang: string): string {
  return siteUrl(localizedSitePath(path, lang));
}

export const homepageDiscoveryLinkHeader = [
  `<${siteUrl("/index.md")}>; rel="alternate"; type="text/markdown"`,
  `<${siteUrl("/llms.txt")}>; rel="describedby"; type="text/markdown"`,
  `<${siteUrl("/sitemap.xml")}>; rel="sitemap"; type="application/xml"`,
  `<${siteUrl("/openapi.json")}>; rel="service-desc"; type="application/json"`,
  `<${siteUrl("/.well-known/api-catalog")}>; rel="api-catalog"; type="application/linkset+json"`,
].join(", ");

export const homepageLinkHeader = `<${siteUrl("/")}>; rel="canonical", ${homepageDiscoveryLinkHeader}`;
