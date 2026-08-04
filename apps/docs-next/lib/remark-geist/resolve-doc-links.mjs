/**
 * M7 / M8 / M9 / M10 of the mapping inventory (Decision 2.4): links.
 *
 *  - M7 (**obligatory**, 52 links): relative / virtual-absolute `*.docs.md`
 *    hrefs → the page they document, e.g.
 *    `getting-started.docs.md` → `/docs/guides/getting-started`,
 *    `/@vgpu/wgsl/runtime/resolve-shader.docs.md` →
 *    `/docs/reference/wgsl/resolve-shader#resolveshader`.
 *  - M8 (**obligatory**, 33 links): absolute *logical* hrefs with no `/docs`
 *    prefix (`/reference/vgpu/frame#framepass`, `/ml/browser`) → `/docs/...`,
 *    honouring `docsHref`'s `/examples` exception.
 *  - M9 (31 links): anchor-only hrefs (`#framepass`) are **not touched**. There
 *    is a test that pins this, because the redirect surface of prod depends on
 *    those anchors surviving untouched (Decision 2.3).
 *  - M10: the one empty `]()` link is left exactly as it is and reported; it is
 *    a pre-existing content bug for the link-checker of TGEIST-12, not something
 *    to paper over here.
 *
 * **Why this is an AST plugin and never a regex.** The corpus contains
 *
 *     [`resolveShader` reference](/@vgpu/wgsl/runtime/resolve-shader.docs.md) (`npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md`)
 *
 * on a single line (`docs/topics/no-bundler.docs.md:53`): a real link whose href
 * must be rewritten, immediately followed by the *same string* inside a
 * code-span that must NOT be rewritten, because it is a command a reader copies
 * and runs. Visiting `link` / `definition` nodes touches the first and cannot
 * see the second; `inlineCode` values are never inspected. There is a test for
 * exactly that line.
 */

import { docsHref, isMarkdownDocHref, resolveMarkdownHref } from "./doc-link-index.mjs";
import { visit } from "./mdast-utils.mjs";

/**
 * Root-relative prefixes that are NOT docs pages, so `/docs` must not be
 * prepended. `/examples` comes from `docsHref` itself (the examples gallery is
 * a top-level route); the rest are the app's own non-content routes, kept
 * explicit so an href to an API endpoint in prose never gets mangled.
 */
export const DEFAULT_NON_DOCS_PREFIXES = Object.freeze([
  "/examples",
  "/docs",
  "/api/",
  "/_next/",
  "/.well-known/",
]);

/** Schemes and shapes that are not app-internal paths at all. */
const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu;

/**
 * @typedef {Object} ResolveDocLinksOptions
 * @property {import("./doc-link-index.mjs").DocLinkIndex} [index] Slug → record lookup (M7).
 * @property {() => Promise<import("./doc-link-index.mjs").DocLinkIndex>} [loadIndex]
 *   Alternative to `index`: called once, lazily, on the first file compiled.
 *   Used by `source.config.ts` so the 4.7 MB docs manifest is loaded when the
 *   MDX pipeline actually runs a transform instead of forcing a top-level await
 *   into the bundled config.
 * @property {ReadonlyArray<string>} [nonDocsPrefixes]
 * @property {"error"|"warn"|"silent"} [onUnresolvedMarkdownLink] What to do when a
 *   `*.docs.md` href has no matching record. Default `error`: an unresolved M7
 *   link is a 404 in production, and risk #6 of the design is specifically
 *   "M7/M8 forgotten produces 85 broken links", so it fails the build loudly.
 * @property {(report: { href: string, reason: string, file?: string }) => void} [onReport]
 *   Called for every link that was deliberately left alone (unresolved M7, the
 *   empty M10 link). Used by the parity/link gate.
 */

/**
 * Whether a root-relative href is a docs page that still needs the `/docs`
 * prefix (M8). Exported because the parity gate asserts the *post-condition*
 * with it: after the chain, no href may still satisfy this predicate. Sharing
 * the predicate is the point — a gate with its own second opinion about what
 * "needs a prefix" means can pass while the build ships 404s.
 *
 * @param {string} href
 * @param {ReadonlyArray<string>} [nonDocsPrefixes]
 */
export function needsDocsPrefix(href, nonDocsPrefixes = DEFAULT_NON_DOCS_PREFIXES) {
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  for (const prefix of nonDocsPrefixes) {
    // A prefix written without a trailing slash matches the *subtree*: the page
    // itself (`/examples`), anything under it (`/examples/air-painting`), and
    // nothing else. This is the one deliberate tightening of the ported
    // `docsHref`, whose `href.startsWith('/examples')` would also swallow a
    // hypothetical `/examples-archive/old` and silently leave it un-prefixed
    // (i.e. a 404). No such path exists in the corpus, so on today's content the
    // two behave identically — there is a test pinning both.
    if (prefix.endsWith("/")) {
      if (href.startsWith(prefix)) return false;
      continue;
    }
    if (href === prefix || href.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

/**
 * remark plugin: resolves docs links (M7/M8) and leaves M9/M10 alone.
 *
 * @param {ResolveDocLinksOptions} options
 */
export function remarkResolveDocLinks(options) {
  if (!options?.index && !options?.loadIndex) {
    throw new Error(
      "remarkResolveDocLinks requires `index` or `loadIndex` (see buildDocLinkIndex / loadDocsManifestRecords)",
    );
  }
  const nonDocsPrefixes = options.nonDocsPrefixes ?? DEFAULT_NON_DOCS_PREFIXES;
  const onUnresolved = options.onUnresolvedMarkdownLink ?? "error";
  const report = options.onReport;

  /** @type {import("./doc-link-index.mjs").DocLinkIndex | null} */
  let eager = options.index ?? null;
  /** @type {Promise<import("./doc-link-index.mjs").DocLinkIndex> | null} */
  let pending = null;

  /**
   * @param {import("./mdast-utils.mjs").MdastNode} tree
   * @param {import("./doc-link-index.mjs").DocLinkIndex} index
   * @param {string | undefined} filePath
   */
  const run = (tree, index, filePath) => {
    /** @type {string[]} */
    const unresolved = [];

    visit(tree, (node) => {
      // `link` covers inline links, `definition` covers reference-style
      // definitions (`[label]: ./x.docs.md`). `inlineCode` / `code` are never
      // visited: that is the whole point (see the header comment).
      if (node.type !== "link" && node.type !== "definition") return;
      const href = node.url;
      if (typeof href !== "string") return;

      if (href.length === 0) {
        // M10: the single empty link in the corpus. Reported, not rewritten.
        report?.({ href, reason: "empty-link", file: filePath });
        return;
      }

      // M9 (anchor-only), protocol-relative, and anything with a scheme:
      // untouched. This is evaluated **before** the M7 branch because the
      // original `resolveMarkdownHref` opens with the same test
      // (`/^(https?:|mailto:|#)/`) and returns such hrefs unchanged: a link to
      // someone else's repo that happens to end in `.docs.md`
      // (`https://github.com/o/r/blob/main/x.docs.md`) is a perfectly good
      // external link, not a broken internal one. Testing M7 first made it fail
      // the build as an "unresolved *.docs.md link", which is both a divergence
      // from the ported logic and a thoroughly misleading message.
      if (EXTERNAL_HREF.test(href)) return;

      // M7 — `*.docs.md`.
      if (isMarkdownDocHref(href)) {
        const logical = resolveMarkdownHref(href, index);
        if (logical) {
          node.url = docsHref(logical);
          return;
        }
        unresolved.push(href);
        report?.({ href, reason: "unresolved-docs-md", file: filePath });
        return;
      }

      // M8 — absolute logical path. `needsDocsPrefix` already applied the
      // `/examples`-subtree exception that `docsHref` encodes (see the comment
      // there for the one deliberate difference), so the prefix is applied
      // directly rather than through `docsHref`'s looser `startsWith`.
      if (needsDocsPrefix(href, nonDocsPrefixes)) {
        node.url = `/docs${href}`;
        return;
      }

      // Relative non-`.docs.md` links (none in the corpus) stay as authored.
    });

    if (unresolved.length > 0 && onUnresolved !== "silent") {
      const message =
        `remark-geist (M7): ${unresolved.length} \`*.docs.md\` link(s) could not be resolved` +
        `${filePath ? ` in ${filePath}` : ""}: ${unresolved.join(", ")}. ` +
        "Every one of these renders as a 404. Check that the docs manifest is up to date " +
        "(`node packages/vgpu/lib/docs/generate/check-drift.js`).";
      if (onUnresolved === "error") throw new Error(message);
      console.warn(message);
    }
  };

  return (/** @type {import("./mdast-utils.mjs").MdastNode} */ tree, file) => {
    const filePath = file?.path ?? file?.history?.at?.(-1);
    if (eager) {
      run(tree, eager, filePath);
      return undefined;
    }
    // unified awaits a transformer that returns a promise, so the first
    // compiled file pays for loading the manifest and the rest reuse it.
    pending ??= Promise.resolve(options.loadIndex()).then((index) => {
      eager = index;
      return index;
    });
    return pending.then((index) => {
      run(tree, index, filePath);
    });
  };
}

export default remarkResolveDocLinks;
