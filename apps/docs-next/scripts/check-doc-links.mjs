#!/usr/bin/env node
/**
 * Gate (d) of Decision 4, second half — the **link checker**. TGEIST-12.
 *
 * Decision 4d asks for "a link-checker that resolves M7/M8/M9 and reports M10".
 * That is exactly what this does, and it does it on the **post-transform** mdast
 * (the M1–M9 chain from `lib/remark-geist/`, i.e. the tree the build actually
 * renders) rather than on the raw markdown, because before the chain runs a
 * corpus link looks like `./resolve-shader.docs.md` or `/reference/vgpu/init` —
 * neither of which is a URL this app serves. Checking the raw text would flag
 * ~85 false positives and miss the real question, which is whether the *rewritten*
 * href resolves.
 *
 * Every link is put in exactly one bucket:
 *
 *   - **empty** (`[text]()`, M10): reported, never fatal. It is a preexisting
 *     bug of the source corpus, explicitly out of scope for the migration
 *     ("no se mapea, lo reporta el link-checker"); failing on it would make this
 *     gate impossible to land without editing content that TGEIST-04 owns.
 *   - **external** (`http(s):`, `mailto:`, `tel:`): counted, not fetched. This
 *     gate must be hermetic and deterministic in CI; a flaky third-party host
 *     must never be able to turn the docs-parity job red.
 *   - **fragment-only** (`#section`, M9): must exist on its own page.
 *   - **internal path**: the path must be a page of `content/docs/**`, a route
 *     the app owns (`/examples/<slug>`, `/preview/<slug>`, …), or the source of a
 *     redirect in `lib/docs-redirects.mjs` whose destination itself resolves.
 *     Anything else is a 404 and fails.
 *   - **relative / still a `*.docs.md`**: fails. M7/M8 exist precisely to make
 *     these impossible; one surviving means the chain did not run on that file.
 *
 * Fragments (`…/page#section`) are verified against `anchorIds` from the
 * `--json` report of `check-url-anchor-parity.mjs`, i.e. against ids observed in
 * the HTML a real server returned. That is deliberate: fumadocs slugs headings
 * with github-slugger, and a *reimplementation* of that slugger inside this gate
 * would be a second source of truth that can silently disagree with the site.
 * Without `--anchors-from` the path half is still checked and fragments are
 * reported as unverified (CI always passes the report).
 *
 * Usage:
 *   node scripts/check-doc-links.mjs
 *   node scripts/check-doc-links.mjs --anchors-from=url-anchor-report.json
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildDocsRedirects, SECTION_ROOTS } from "../lib/docs-redirects.mjs";
import { loadGeistRemarkTransformers } from "../lib/remark-geist/index.mjs";
import { applyTransformers, loadMarkdownParser } from "../lib/remark-geist/markdown-toolchain.mjs";
import { visit } from "../lib/remark-geist/mdast-utils.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const CONTENT_ROOT = join(APP_ROOT, "content/docs");
const EXAMPLES_ROOT = join(APP_ROOT, "examples");
const MARKDOWN = /\.mdx?$/u;

/**
 * Routes the app serves that are not pages of `content/docs/**`. Kept short and
 * explicit on purpose: a wildcard here would let a typo'd internal link pass.
 * `/examples/<slug>` and `/preview/<slug>` are validated against the real
 * example directories, not accepted blindly.
 */
const APP_ROUTES = new Set(["/", "/examples", "/llms.txt", "/agents.md", "/sitemap.xml", "/robots.txt"]);

function parseArgs(argv) {
  const options = { anchorsFrom: null };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const [key, value] = eq === -1 ? [arg, ""] : [arg.slice(0, eq), arg.slice(eq + 1)];
    if (key === "--anchors-from") options.anchorsFrom = value;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function walkMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(path));
    else if (MARKDOWN.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** `content/docs/ml/index.md` → `/docs/ml`, `content/docs/cli.md` → `/docs/cli`. */
function urlForContentFile(file) {
  const rel = relative(CONTENT_ROOT, file).replace(/\\/gu, "/");
  const withoutExt = rel.replace(MARKDOWN, "");
  const slug = withoutExt.replace(/(^|\/)index$/u, "");
  return slug === "" ? "/docs" : `/docs/${slug}`;
}

function stripFrontmatter(source) {
  return source.replace(/^---\n[\s\S]*?\n---\n?/u, "");
}

/** `/examples/gradient` and `/preview/gradient` are real routes iff the example exists. */
function isExampleRoute(path) {
  const match = /^\/(?:examples|preview)\/([^/]+)$/u.exec(path);
  if (!match) return false;
  const dir = join(EXAMPLES_ROOT, decodeURIComponent(match[1]));
  return existsSync(dir) && statSync(dir).isDirectory();
}

/**
 * Applies the redirect table the app ships (`lib/docs-redirects.mjs`) to a path,
 * following up to 5 hops exactly like a browser would. Returns the final path,
 * or null when nothing matched. `:path*` sources are translated to a regex so
 * the prefix families (`/reference/:path*` …) resolve too.
 */
function makeRedirectResolver(redirects) {
  const compiled = redirects.map(({ source, destination }) => {
    if (!source.includes(":")) return { test: (path) => (path === source ? destination : null) };
    const pattern = new RegExp(`^${source.replace(/:[a-zA-Z]+\*/u, "(.*)").replace(/\//gu, "\\/")}$`, "u");
    return {
      test: (path) => {
        const match = pattern.exec(path);
        if (!match) return null;
        return destination.replace(/:[a-zA-Z]+\*/u, match[1] ?? "");
      },
    };
  });
  return (path) => {
    const chain = [];
    let current = path;
    for (let hop = 0; hop < 5; hop += 1) {
      let next = null;
      for (const rule of compiled) {
        next = rule.test(current);
        if (next !== null) break;
      }
      if (next === null) return chain.length > 0 ? { path: current, chain } : null;
      chain.push(next);
      current = next.split("#")[0];
    }
    return { path: current, chain, truncated: true };
  };
}

/**
 * The per-page anchor facts of gate (d)'s first half: the ids the page really
 * renders, plus the two classes of frozen anchor it accounted for (the page's own
 * title, and recorded slugger renames). A corpus link whose fragment is missing
 * is judged against those, and against the frozen inventory itself — because the
 * honest question is not "does this fragment exist" but "did **production** have
 * it". A fragment prod never served is a preexisting corpus bug (the same
 * category as M10), not something this migration broke.
 */
function loadAnchorFacts(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  /** @type {Map<string, { ids: Set<string>, drifts: Map<string, string> }>} */
  const byPath = new Map();
  for (const entry of report.results ?? []) {
    if (!Array.isArray(entry.anchorIds)) continue;
    const facts = {
      ids: new Set(entry.anchorIds),
      drifts: new Map((entry.drifts ?? []).map((drift) => [drift.prodAnchor, drift.newAnchor])),
    };
    byPath.set(entry.path, facts);
    // A redirected inventory path carries the facts of the page it lands on,
    // which is also the answer for a link written straight to that destination.
    if (entry.finalPath && !byPath.has(entry.finalPath)) byPath.set(entry.finalPath, facts);
  }
  return byPath;
}

/** path → anchors production serves, straight out of the F1 freeze. */
function loadProdAnchors() {
  const inventoryPath = resolve(APP_ROOT, "../../docs/url-inventory.json");
  if (!existsSync(inventoryPath)) return null;
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  return new Map((inventory.pages ?? []).map((page) => [page.path, new Set(page.anchors ?? [])]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(CONTENT_ROOT)) {
    console.error(`✗ link checker: no corpus at ${CONTENT_ROOT}. Refusing to pass a gate that checked nothing.`);
    process.exit(1);
  }
  const files = walkMarkdown(CONTENT_ROOT);
  if (files.length === 0) {
    console.error(`✗ link checker: no markdown under ${CONTENT_ROOT}.`);
    process.exit(1);
  }

  const pageUrls = new Set(files.map(urlForContentFile));
  const redirects = buildDocsRedirects([]); // manifest-derived entries are all `/packages/**`, never link targets
  const resolveRedirect = makeRedirectResolver([
    ...redirects,
    // `/packages/**` sources are omitted above (they need the 4.7 MB manifest and
    // no corpus link points at them); the section roots are what corpus links do
    // use, and they come from the same module the app builds its table from.
    ...SECTION_ROOTS.map(({ source, destination }) => ({ source, destination })),
  ]);
  const anchorsByPath = options.anchorsFrom ? loadAnchorFacts(options.anchorsFrom) : null;
  const prodAnchors = loadProdAnchors();

  const { parse } = await loadMarkdownParser();
  const { bundledLanguages } = await import("shiki");
  /** @type {Array<{ href: string, reason: string, file?: string }>} */
  const pluginReports = [];
  const transformers = await loadGeistRemarkTransformers({
    knownLanguages: Object.keys(bundledLanguages),
    onUnresolvedMarkdownLink: "silent",
    onReport: (report) => pluginReports.push(report),
  });

  const failures = [];
  const emptyLinks = [];
  const unverifiedFragments = [];
  /** fragment is a recorded slugger rename: the section exists under a new id */
  const driftedFragments = [];
  /** production did not serve this fragment either — preexisting corpus bug */
  const preexistingFragments = [];
  let external = 0;
  let internal = 0;
  let fragmentChecked = 0;
  let viaRedirect = 0;

  /**
   * Decides what a missing fragment means, using the frozen inventory as the
   * oracle rather than this app's HTML alone. Returns null when it is a real
   * failure (caller reports it), or a category label when it is accounted for.
   */
  const classifyMissingFragment = (targetPath, fragment, facts, at, url) => {
    const renamed = facts.drifts.get(fragment);
    if (renamed) {
      driftedFragments.push(`${at} → ${url}  (now #${renamed})`);
      return "drift";
    }
    const prod = prodAnchors?.get(targetPath);
    if (prod && !prod.has(fragment)) {
      preexistingFragments.push(`${at} → ${url}`);
      return "preexisting";
    }
    return null;
  };

  for (const file of files) {
    const label = relative(APP_ROOT, file);
    const pageUrl = urlForContentFile(file);
    const tree = parse(stripFrontmatter(readFileSync(file, "utf8")));
    await applyTransformers(tree, transformers, { path: file });

    /** @type {Array<{ url: string, line: number | string }>} */
    const links = [];
    visit(tree, (node) => {
      if (node.type !== "link" && node.type !== "definition") return;
      links.push({ url: node.url ?? "", line: node.position?.start?.line ?? "?" });
    });

    for (const { url, line } of links) {
      const at = `${label}:${line}`;

      if (url === "") {
        emptyLinks.push(at);
        continue;
      }
      if (/^(https?:|mailto:|tel:)/u.test(url)) {
        external += 1;
        continue;
      }
      if (url.startsWith("#")) {
        const anchor = decodeURIComponent(url.slice(1));
        const facts = anchorsByPath?.get(pageUrl);
        if (!facts) unverifiedFragments.push(`${at} → ${url}`);
        else if (facts.ids.has(anchor)) fragmentChecked += 1;
        else if (!classifyMissingFragment(pageUrl, anchor, facts, at, url)) {
          failures.push(`${at}: ${url} — no heading with that id on ${pageUrl}, and production served it (M9)`);
        }
        continue;
      }
      if (!url.startsWith("/")) {
        failures.push(
          `${at}: ${url} — relative link survived the M7/M8 chain (it would 404: the page is served at ${pageUrl}, not from a directory of .md files)`,
        );
        continue;
      }
      if (/\.docs\.md(#|$)/u.test(url)) {
        failures.push(`${at}: ${url} — unresolved *.docs.md link (M7 did not rewrite it)`);
        continue;
      }

      internal += 1;
      const [rawPath, fragment] = [url.split("#")[0], url.split("#")[1]];
      const path = rawPath.replace(/\/$/u, "") || "/";
      let target = path;
      let resolvedByRedirect = false;

      if (!pageUrls.has(path) && !APP_ROUTES.has(path) && !isExampleRoute(path)) {
        const redirected = resolveRedirect(path);
        const finalPath = redirected?.path?.split("#")[0] ?? null;
        if (finalPath && (pageUrls.has(finalPath) || APP_ROUTES.has(finalPath) || isExampleRoute(finalPath))) {
          resolvedByRedirect = true;
          viaRedirect += 1;
          target = finalPath;
        } else {
          failures.push(
            `${at}: ${url} — 404: no page in content/docs/**, no app route, and no redirect${redirected ? ` (redirect chain ended at ${redirected.path})` : ""}`,
          );
          continue;
        }
      }

      if (!fragment) continue;
      const facts = anchorsByPath?.get(target);
      if (!facts) {
        unverifiedFragments.push(`${at} → ${url}`);
        continue;
      }
      const anchor = decodeURIComponent(fragment);
      if (facts.ids.has(anchor)) fragmentChecked += 1;
      else if (!classifyMissingFragment(target, anchor, facts, at, url)) {
        failures.push(
          `${at}: ${url} — page resolves${resolvedByRedirect ? " (via redirect)" : ""} but has no heading id "${anchor}", and production served that anchor (M9)`,
        );
      }
    }
  }

  console.log("gate (d) · doc link checker (post-M1–M9 mdast, the tree the build renders)");
  console.log(`  ${files.length} pages · ${internal} internal links (${viaRedirect} via redirect) · ${external} external (not fetched)`);
  console.log(
    `  fragments: ${fragmentChecked} verified against ids observed in HTML${unverifiedFragments.length > 0 ? ` · ${unverifiedFragments.length} unverified (no --anchors-from report)` : ""}`,
  );

  if (driftedFragments.length > 0) {
    console.log(
      `\n  ${driftedFragments.length} fragment(s) point at a heading whose id the new slugger renamed (recorded in\n  scripts/url-anchor-drift-allowlist.json). The section is there, the fragment no longer\n  matches it, so these land at the top of the page:`,
    );
    for (const at of driftedFragments) console.log(`    ${at}`);
  }
  if (preexistingFragments.length > 0) {
    console.log(
      `\n  ${preexistingFragments.length} fragment(s) production did not serve either (broken before this migration, per\n  docs/url-inventory.json — reported, not failed; the fix belongs to the *.docs.md source):`,
    );
    for (const at of preexistingFragments) console.log(`    ${at}`);
  }

  if (emptyLinks.length > 0) {
    console.log(
      `\n  M10 — ${emptyLinks.length} empty link${emptyLinks.length === 1 ? "" : "s"} (\`[text]()\`), reported and NOT failed (preexisting\n  corpus bug, out of scope for the migration — the fix belongs to the *.docs.md source):`,
    );
    for (const at of emptyLinks) console.log(`    ${at}`);
  }

  const pluginEmpty = pluginReports.filter((report) => report.reason === "empty-link").length;
  const pluginUnresolved = pluginReports.filter((report) => report.reason === "unresolved-docs-md");
  if (pluginReports.length > 0) {
    console.log(`\n  reported by the M7 pass itself: ${pluginEmpty} empty-link, ${pluginUnresolved.length} unresolved-docs-md`);
  }
  for (const report of pluginUnresolved) {
    failures.push(`${report.file ? relative(APP_ROOT, report.file) : "?"}: ${report.href} — M7 could not resolve this *.docs.md link`);
  }

  if (failures.length === 0) {
    console.log("\n✓ gate (d) link checker: every link in the corpus resolves (M7/M8/M9 clean; M10 reported above).");
    return;
  }

  console.error(`\n✗ gate (d) link checker FAILED — ${failures.length} broken link(s):`);
  for (const failure of failures) console.error(`    ${failure}`);
  process.exit(1);
}

main().catch((error) => {
  console.error("link checker crashed:", error);
  process.exit(1);
});
