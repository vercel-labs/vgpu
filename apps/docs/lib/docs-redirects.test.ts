import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildDocsRedirects, SECTION_ROOTS } from "./docs-redirects.mjs";

const CONTENT_ROOT = resolve(import.meta.dirname, "../content/docs");
type Redirect = { source: string; destination: string };
type SectionRoot = Redirect & { dir: string };

describe("API reference package roots", () => {
  it("redirects every package card to an existing topic page", () => {
    const index = readFileSync(resolve(CONTENT_ROOT, "reference/index.mdx"), "utf8");
    const packagesSection = index.slice(index.indexOf("## Packages"));
    const cardHrefs = new Set(
      [...packagesSection.matchAll(/\bhref="(\/docs\/reference\/[^"]+)"/gu)].map((match) => match[1]),
    );
    const redirects = new Map(
      (buildDocsRedirects([]) as Redirect[]).map(({ source, destination }) => [source, destination]),
    );

    expect([...cardHrefs].sort()).toEqual(
      (SECTION_ROOTS as SectionRoot[]).map(({ source }) => source).sort(),
    );

    for (const href of cardHrefs) {
      const destination = redirects.get(href);
      expect(destination, `${href} needs a redirect`).toBeDefined();
      expect(
        existsSync(resolve(CONTENT_ROOT, `${destination?.replace(/^\/docs\//u, "")}.md`)),
        `${href} must redirect to an emitted page`,
      ).toBe(true);
    }
  });
});
