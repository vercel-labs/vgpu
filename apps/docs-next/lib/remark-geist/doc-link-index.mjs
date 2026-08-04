/**
 * The URL logic of the old docs app (`apps/docs`), ported off React and off the
 * request path so a remark plugin can apply it at build time (TGEIST-05, M7/M8).
 *
 * Two functions are ported, both read from `origin/main`:
 *
 *  - `resolveMarkdownHref` (`apps/docs/lib/manifest.ts:192`) — turns a
 *    `*.docs.md` href (relative or virtual-absolute) into the logical page path
 *    of the record it documents. Ported verbatim, including its regex and its
 *    "guides first, then any record by symbol or by virtual path" lookup order.
 *  - `docsHref` (`apps/docs/lib/nav.ts:29`) — applies the `/docs` prefix exactly
 *    once, with the `/examples` subtree exception (examples are a top-level
 *    route, not a docs page).
 *
 * Supporting helpers (`referencePackageName`, `slugifyPackage`, `symbolToSlug`,
 * `topicHrefForRecord`, `recordHref`) are ported from the same file so the
 * emitted URLs are identical to the ones production serves today — that is the
 * point of the exercise: `docs/url-inventory.json` (TGEIST-02) is frozen from
 * prod, and TGEIST-12 link-checks the new tree against it.
 *
 * One deliberate deviation, documented so review can catch it: when a record
 * carries a `websitePath` (5 guides do, e.g. `/cli`), that path wins over
 * `/guides/<symbol>`. `websitePath` IS the canonical URL prod serves for those
 * pages and the one `nav.json`/`content/docs/**` mirror; the old
 * `resolveMarkdownHref` ignored it and relied on `/guides/:path*` also
 * existing. Pass `preferWebsitePath: false` to get the old behaviour byte for
 * byte.
 */

/** @typedef {import("./mdast-utils.mjs").MdastNode} MdastNode */

/**
 * @typedef {Object} DocsRecord
 * @property {string} package
 * @property {string} symbol
 * @property {"api"|"guide"} kind
 * @property {string} virtualPath
 * @property {string} anchor
 * @property {string} topic
 * @property {string} [websitePath]
 */

/**
 * @typedef {Object} DocLinkIndex
 * @property {(slug: string) => DocsRecord | null} findRecord
 * @property {(record: DocsRecord) => string} hrefForRecord
 * @property {number} size
 */

/** Ported verbatim from `apps/docs/lib/manifest.ts` (`referencePackageName`). */
export function referencePackageName(record) {
  if (record.package === "vgpu" || record.package === "vgpu/core" || record.package === "vgpu/scene") {
    return record.package;
  }
  if (record.package.startsWith("@vgpu/wgsl-std")) return "@vgpu/wgsl-std";
  if (record.package.startsWith("@vgpu/wgsl")) return "@vgpu/wgsl";
  if (record.package.startsWith("@vgpu/render")) return "@vgpu/render";
  return record.package;
}

/** Ported verbatim from `apps/docs/lib/manifest.ts` (`slugifyPackage`). */
export function slugifyPackage(packageName) {
  if (packageName === "guides") return "guides";
  if (packageName === "@vgpu/wgsl") return "wgsl";
  if (packageName === "@vgpu/wgsl-std") return "wgsl-std";
  if (packageName === "@vgpu/render") return "render";
  return packageName.replace(/^@/u, "").replace(/[/@]/gu, "-");
}

/** Ported verbatim from `apps/docs/lib/manifest.ts` (`symbolToSlug`). */
export function symbolToSlug(symbol) {
  return encodeURIComponent(symbol);
}

/** Ported verbatim from `apps/docs/lib/manifest.ts` (`topicHrefForRecord`). */
export function topicHrefForRecord(record) {
  const packageName = referencePackageName(record);
  return `/reference/${slugifyPackage(packageName)}/${encodeURIComponent(record.topic)}`;
}

/**
 * Ported from `apps/docs/lib/manifest.ts` (`recordHref`), plus the
 * `websitePath` preference documented at the top of this file.
 *
 * @param {DocsRecord} record
 * @param {{ preferWebsitePath?: boolean }} [options]
 */
export function recordHref(record, options = {}) {
  const preferWebsitePath = options.preferWebsitePath ?? true;
  if (preferWebsitePath && typeof record.websitePath === "string" && record.websitePath.length > 0) {
    return record.websitePath;
  }
  if (record.kind === "guide") return `/guides/${symbolToSlug(record.symbol)}`;
  return `${topicHrefForRecord(record)}#${record.anchor}`;
}

/**
 * Ported verbatim from `apps/docs/lib/nav.ts:29` (`docsHref`), comment and all:
 * nav data, frontmatter and the manifest store paths WITHOUT the `/docs`
 * segment; the prefix is applied exactly once, here. `/examples` is the one
 * subtree that is not under `/docs` — matching the whole subtree (not the bare
 * string) is what keeps `/examples/air-painting` from becoming
 * `/docs/examples/air-painting`.
 *
 * @param {string} href
 */
export function docsHref(href) {
  return href.startsWith("/examples") ? href : `/docs${href}`;
}

const DOCS_MD_HREF = /(?:^|\/)\.?(?:\/)?([^/]+)\.docs\.md(?:#(.*))?$/u;

/** True when `href` points at a `*.docs.md` file (M7's domain). */
export function isMarkdownDocHref(href) {
  return typeof href === "string" && DOCS_MD_HREF.test(href);
}

/**
 * Builds the slug → record lookup used by M7.
 *
 * Preserves the lookup order of the original `resolveMarkdownHref`: guides are
 * matched first by symbol, then any record is matched by `symbol === slug` or
 * `virtualPath.endsWith('/<slug>.docs.md')`, with the earliest record in
 * manifest order winning (the original used a single `Array.prototype.find`).
 *
 * @param {DocsRecord[]} records
 * @param {{ preferWebsitePath?: boolean }} [options]
 * @returns {DocLinkIndex}
 */
export function buildDocLinkIndex(records, options = {}) {
  /** @type {Map<string, DocsRecord>} */
  const guidesBySymbol = new Map();
  /** @type {Map<string, DocsRecord>} */
  const bySlug = new Map();

  for (const record of records) {
    if (record.kind === "guide" && !guidesBySymbol.has(record.symbol)) {
      guidesBySymbol.set(record.symbol, record);
    }
    if (!bySlug.has(record.symbol)) bySlug.set(record.symbol, record);
    const match = /\/([^/]+)\.docs\.md$/u.exec(record.virtualPath ?? "");
    if (match && !bySlug.has(match[1])) bySlug.set(match[1], record);
  }

  return {
    size: bySlug.size,
    findRecord(slug) {
      return guidesBySymbol.get(slug) ?? bySlug.get(slug) ?? null;
    },
    hrefForRecord(record) {
      return recordHref(record, options);
    },
  };
}

/**
 * Ported from `apps/docs/lib/manifest.ts:192` (`resolveMarkdownHref`), with the
 * index injected instead of importing the 4.7 MB manifest module directly.
 *
 * Returns the **logical** path (no `/docs` prefix) plus the original hash, or
 * `null` when the href is not a `*.docs.md` link or its slug is unknown. The
 * caller decides what to do with `null` (the plugin leaves the link alone and
 * records it, so the gate can report it instead of silently emitting a 404).
 *
 * @param {string} href
 * @param {DocLinkIndex} index
 * @returns {string | null}
 */
export function resolveMarkdownHref(href, index) {
  if (!href) return null;
  if (/^(https?:|mailto:|#)/u.test(href)) return null;

  const match = DOCS_MD_HREF.exec(href);
  if (!match) return null;

  const [, slug, hash] = match;
  const record = index.findRecord(slug);
  if (!record) return null;
  return `${index.hrefForRecord(record)}${hash ? `#${hash}` : ""}`;
}

/**
 * Locates and loads `packages/vgpu/lib/generated/docs-manifest.generated.js`
 * (committed, ~4.7 MB) without turning it into a static import: a bare
 * `import` of a relative path outside the app would be inlined into the bundled
 * `source.config.ts`, and `apps/docs-next` deliberately does not depend on
 * `@vgpu/cli` during the dual-run window (Decision 1′). Resolved lazily, from
 * the module URL first and `process.cwd()` second, so it works from the app
 * root, from the repo root and from a test.
 *
 * @param {{ manifestPath?: string, cwd?: string }} [options]
 * @returns {Promise<{ records: DocsRecord[], path: string }>}
 */
export async function loadDocsManifestRecords(options = {}) {
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { resolve: resolvePath } = await import("node:path");

  const cwd = options.cwd ?? process.cwd();
  const relativeToModule = new URL(
    "../../../../packages/vgpu/lib/generated/docs-manifest.generated.js",
    import.meta.url,
  );
  const candidates = options.manifestPath
    ? [options.manifestPath]
    : [
        relativeToModule.pathname,
        resolvePath(cwd, "../../packages/vgpu/lib/generated/docs-manifest.generated.js"),
        resolvePath(cwd, "packages/vgpu/lib/generated/docs-manifest.generated.js"),
      ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, { encoding: "utf8", flag: "r" });
    } catch {
      continue;
    }
    const module = await import(pathToFileURL(candidate).href);
    const records = module?.docsManifest?.records;
    if (!Array.isArray(records)) {
      throw new Error(`docs manifest at ${candidate} has no \`docsManifest.records\` array`);
    }
    return { records, path: candidate };
  }

  throw new Error(
    `Could not locate docs-manifest.generated.js. Looked in:\n  ${candidates.join("\n  ")}\n` +
      "M7 (relative *.docs.md links) cannot be resolved without it; see TGEIST-05.",
  );
}
