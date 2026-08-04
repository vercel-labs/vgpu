/**
 * `remark-geist` — the render half of the double constraint (Decision 2).
 *
 * The generated `content/docs/**.md` bodies are byte-identical to the authored
 * `*.docs.md` sources; every Geist component and every resolved URL is produced
 * here, on the mdast, at build time. Nothing in this directory writes to disk
 * and nothing rewrites a source file.
 *
 * Mapping inventory (Decision 2.4) implemented:
 *
 * | id | pattern                                    | module                     |
 * |----|--------------------------------------------|----------------------------|
 * | M1 | `> Good to know:` blockquote               | `callout-blockquotes.mjs`  |
 * | M2 | `> Warning:` blockquote                   | `callout-blockquotes.mjs`  |
 * | M3 | any other blockquote → untouched (no-op)  | `callout-blockquotes.mjs`  |
 * | M4 | ` ```terminal ` fence (breaks the build)   | `normalize-code-lang.mjs`  |
 * | M5 | `sh`/`typescript`/… alias normalization    | `normalize-code-lang.mjs`  |
 * | M6 | `ts`/`wgsl`/`json` → Shiki, no work        | (nothing to do)            |
 * | M7 | relative `*.docs.md` links                 | `resolve-doc-links.mjs`    |
 * | M8 | absolute logical links without `/docs`     | `resolve-doc-links.mjs`    |
 * | M9 | anchor-only links → untouched (no-op)      | `resolve-doc-links.mjs`    |
 * | M10| the one empty `]()` link → reported        | `resolve-doc-links.mjs`    |
 *
 * M11–M14 are explicit no-ops with no code (tables, `**Returns:**`, badges,
 * mermaid/images), see the decision doc.
 */

export {
  DEFAULT_CALLOUT_PREFIXES,
  remarkCalloutBlockquotes,
} from "./callout-blockquotes.mjs";
export {
  buildDocLinkIndex,
  docsHref,
  isMarkdownDocHref,
  loadDocsManifestRecords,
  recordHref,
  referencePackageName,
  resolveMarkdownHref,
  slugifyPackage,
  symbolToSlug,
  topicHrefForRecord,
} from "./doc-link-index.mjs";
export {
  flattenNode,
  mdastToText,
  mdxJsxFlowElement,
  normalizeWhitespace,
  visit,
  visitPostOrder,
} from "./mdast-utils.mjs";
export {
  DEFAULT_LANGUAGE_ALIASES,
  remarkNormalizeCodeLang,
  SHIKI_SPECIAL_LANGUAGES,
} from "./normalize-code-lang.mjs";
export {
  DEFAULT_NON_DOCS_PREFIXES,
  remarkResolveDocLinks,
} from "./resolve-doc-links.mjs";

import { remarkCalloutBlockquotes } from "./callout-blockquotes.mjs";
import { buildDocLinkIndex, loadDocsManifestRecords } from "./doc-link-index.mjs";
import { remarkNormalizeCodeLang } from "./normalize-code-lang.mjs";
import { remarkResolveDocLinks } from "./resolve-doc-links.mjs";

/**
 * @typedef {Object} GeistRemarkPluginsOptions
 * @property {import("./doc-link-index.mjs").DocsRecord[]} records Docs manifest records (M7).
 * @property {Iterable<string>} [knownLanguages] Shiki's `bundledLanguages` keys (M4).
 * @property {"error"|"warn"|"silent"} [onUnresolvedMarkdownLink]
 * @property {(report: { href: string, reason: string, file?: string }) => void} [onReport]
 * @property {boolean} [preferWebsitePath]
 */

/**
 * The M1–M9 chain as **unified `Pluggable` tuples** (`[attacher, options]`) —
 * the shape `mdxOptions.remarkPlugins` expects.
 *
 * This distinction is not cosmetic and cost a build to learn: unified calls each
 * entry of the plugins array as an *attacher* and uses its return value as the
 * transformer. Passing `remarkNormalizeCodeLang({ … })` (already-called factory,
 * i.e. the transformer itself) makes unified invoke the transformer once with
 * `tree === undefined` at freeze time and register nothing — every plugin
 * silently no-ops and ` ```terminal ` reaches Shiki, which is exactly the
 * `next build` failure M4 exists to prevent. `[factory, options]` is correct
 * because the factories take options and return the transformer.
 *
 * Order matters:
 *
 *  1. `remarkNormalizeCodeLang` — first, and independent of the rest: if a
 *     ` ```terminal ` fence survives to `rehypeCode`, Shiki throws and there is
 *     no build to speak of.
 *  2. `remarkCalloutBlockquotes` — before the link pass, so links that live
 *     inside a `Good to know:` blockquote are visited as children of the
 *     Callout (the array is moved, not copied, so either order works; fixed
 *     here so the behaviour is deterministic and reviewable).
 *  3. `remarkResolveDocLinks` — last, and it must run after M4/M5 so that a
 *     link inside a code fence is still a `code` node (never a `link`) when it
 *     is skipped.
 *
 * @param {Omit<GeistRemarkPluginsOptions, "records"> & {
 *   records?: import("./doc-link-index.mjs").DocsRecord[],
 *   loadIndex?: () => Promise<import("./doc-link-index.mjs").DocLinkIndex>,
 * }} options
 * @returns {Array<[Function, Record<string, unknown>]>}
 */
export function geistRemarkPlugins(options) {
  const index = options.records
    ? buildDocLinkIndex(options.records, { preferWebsitePath: options.preferWebsitePath })
    : undefined;
  return [
    [remarkNormalizeCodeLang, { knownLanguages: options.knownLanguages }],
    [remarkCalloutBlockquotes, {}],
    [
      remarkResolveDocLinks,
      {
        index,
        loadIndex: options.loadIndex,
        onUnresolvedMarkdownLink: options.onUnresolvedMarkdownLink,
        onReport: options.onReport,
      },
    ],
  ];
}

/**
 * The same chain as bare transformers, for callers that drive the tree
 * themselves (the unit tests and `scripts/check-mdast-parity.mjs`). Built from
 * the identical factories and options as `geistRemarkPlugins`, so the gate can
 * never test a different chain than the build runs. Each tuple is simply
 * "called" the way unified would call it.
 *
 * @param {GeistRemarkPluginsOptions} options
 * @returns {Array<(tree: any, file?: any) => unknown>}
 */
export function geistRemarkTransformers(options) {
  return geistRemarkPlugins(options).map(([attacher, pluginOptions]) => attacher(pluginOptions));
}

/**
 * `geistRemarkTransformers`, loading the committed docs manifest itself. Used by
 * `scripts/check-mdast-parity.mjs`.
 *
 * @param {Omit<GeistRemarkPluginsOptions, "records"> & { manifestPath?: string }} [options]
 */
export async function loadGeistRemarkTransformers(options = {}) {
  const { records } = await loadDocsManifestRecords({ manifestPath: options.manifestPath });
  return geistRemarkTransformers({ ...options, records });
}
