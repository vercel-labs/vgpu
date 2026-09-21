import { createNotFoundResponse, shouldServeMarkdown } from "@vercel/agent-readability";
import { isExampleSlug } from "../example-slugs";
import { localizedSitePath } from "../site";

const HTML_ROUTE_PATHS = new Set([
  "/",
  "/.well-known/mcp.json",
  "/about",
  "/agents.md",
  "/contact",
  "/index.md",
  "/llms-full.txt",
  "/llms.txt",
  "/rss.xml",
  "/sitemap.md",
]);

const HTML_ROUTE_PREFIXES = ["/docs/", "/og/"] as const;
const TRAILING_SLASHES = /\/+$/u;

function normalizePathname(pathname: string): string {
  return pathname === "/" ? pathname : pathname.replace(TRAILING_SLASHES, "");
}

function localizedPathname(
  pathname: string,
  languages: readonly string[],
  defaultLanguage: string,
): { language: string; pathname: string } {
  const segments = pathname.split("/").filter(Boolean);
  const candidate = segments[0];

  if (!candidate || !languages.includes(candidate)) {
    return { language: defaultLanguage, pathname: normalizePathname(pathname) };
  }

  return {
    language: candidate,
    pathname: normalizePathname(`/${segments.slice(1).join("/")}`),
  };
}

function isKnownHtmlRoute(pathname: string): boolean {
  const exampleRoute = pathname.match(
    /^\/examples\/([^/]+)(?:\/(?:download|v0\.json))?$/u,
  );

  return (
    HTML_ROUTE_PATHS.has(pathname) ||
    pathname === "/docs" ||
    pathname === "/examples" ||
    (exampleRoute !== null && isExampleSlug(exampleRoute[1])) ||
    HTML_ROUTE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export function createUnmatchedMarkdownNotFoundResponse(
  request: Request,
  options: { defaultLanguage: string; languages: readonly string[] },
): Response | null {
  if (!shouldServeMarkdown(request).serve) return null;

  const url = new URL(request.url);
  const localized = localizedPathname(
    url.pathname,
    options.languages,
    options.defaultLanguage,
  );
  const firstSegment = url.pathname.split("/").filter(Boolean)[0];
  if (firstSegment === options.defaultLanguage) return null;
  if (isKnownHtmlRoute(localized.pathname)) return null;

  return createNotFoundResponse(url.pathname, {
    sitemapUrl: localizedSitePath("/sitemap.md", localized.language),
    indexUrl: localizedSitePath("/llms.txt", localized.language),
    fullContentUrl: localizedSitePath("/llms-full.txt", localized.language),
    exampleUrl: localizedSitePath("/docs/get-started", localized.language),
    headers: {
      "Cache-Control": "private, no-store",
    },
  });
}
