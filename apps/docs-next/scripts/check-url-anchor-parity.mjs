#!/usr/bin/env node
/**
 * Gate (d) of Decision 4 — **URL + anchor parity against production**. TGEIST-12.
 *
 * `docs/url-inventory.json` was frozen during F1 by crawling the live site
 * (https://vgpu.sh): every URL it serves under `/docs/**` and, per URL, every
 * anchor that really exists as an `id=` in the HTML prod returns. That file is
 * the oracle here, and this script is the only thing standing between the
 * cutover and a silently broken URL space: `next build` is perfectly happy to
 * ship a tree where 11 live URLs 404, because from the build's point of view
 * nothing is missing — every page it was asked to render rendered.
 *
 * For each frozen page:
 *
 *   1. GET the path off a real server (`next start` on the production build, so
 *      `next.config.ts` redirects and the geistdocs i18n proxy are both in the
 *      loop — a static-export diff would see neither).
 *   2. Follow redirects **manually**, recording the chain. A 3xx landing on a
 *      200 counts as resolved: a redirect is a URL that still works, which is
 *      the property prod readers care about. The chain is always printed, so a
 *      redirect is never invisible.
 *   3. Require the ids of the final HTML to be a superset of the frozen anchors.
 *      Extra ids are fine (the new layout mints its own); missing ones are
 *      classified — see below — and anything unclassifiable fails.
 *
 * ## Why anchors need classification instead of plain equality
 *
 * The old app and geistdocs slug headings with different code. The old app used
 * `slugifyHeading` over the heading's *plain* text (`apps/docs/lib/concepts.ts:185`,
 * ported below); fumadocs uses github-slugger over the heading's *rendered*
 * text. Three consequences, all of them visible in the frozen inventory:
 *
 *   - inline code counted: `Type \`.wgsl\` imports in TypeScript` was
 *     `#type-imports-in-typescript`, is now `#type-wgsl-imports-in-typescript`;
 *   - `-+` no longer collapses: `Headless / no-bundler variant` was
 *     `#headless-no-bundler-variant`, is now `#headless--no-bundler-variant`;
 *   - duplicate-heading counters restart per page, where the old reference pages
 *     shared a slugger across a whole package (hence prod's `#import-29`), and
 *     headings whose text was entirely code slugged to the empty string and came
 *     out as prod's `#-2`, `#-3`, …
 *
 * A gate that only diffed sets would report all of that as "94 anchors lost" and
 * be permanently red, which in practice means switched off. A gate that ignored
 * missing anchors would miss the thing that actually matters: a **heading that
 * disappeared**. So every missing anchor is matched back to a heading of the
 * page it should be on, by recomputing the OLD slug from the NEW HTML (with and
 * without code spans, modulo the dedup counter):
 *
 *   - matches the page's own `<h1>` (the frontmatter title, rendered without an
 *     `id` by the Geist layout)  →  **fail**. Decision 2.3 requires the title to
 *     carry `id={slugifyHeading(page.data.title)}`, which the adapter renders
 *     from `lib/title-anchor.mjs`, so these anchors are supposed to exist for
 *     real. An earlier revision of this gate accepted them by rule instead ("the
 *     reader still lands on the page"); that was a design deviation, and it also
 *     left the 276 `#anchor` destinations of the redirect table pointing at
 *     nothing. The class is kept only to name the cause when it regresses.
 *   - matches a body heading → `drift`: the section is still there, its id
 *     changed. Accepted **only if recorded** in
 *     `scripts/url-anchor-drift-allowlist.json`, with the new id *and* the
 *     heading text. A drift that is not in the file fails; a recorded drift whose
 *     new id or heading text changed fails; a recorded drift that no longer
 *     happens fails as stale. So the known renames cannot grow silently, and no
 *     entry can hide a lost heading — the heading has to still exist, and still
 *     be the heading the entry claims, for the entry to match.
 *   - matches nothing → **fail**: content is gone (or a plugin ate it).
 *
 * Two more assertions ride along, both of them things a set-diff cannot see:
 * **no id is rendered twice** on a page (an ambiguous anchor, and the specific
 * way the title anchor could collide with a body heading), and every
 * **destination** of the redirect table lands on an id that exists — graded
 * against the frozen inventory, so a deep link that was already dead in prod is
 * reported while a real regression fails.
 *
 * ## Usage
 *
 *   node scripts/check-url-anchor-parity.mjs                  # starts `next start` itself
 *   node scripts/check-url-anchor-parity.mjs --base-url=http://localhost:3000
 *   node scripts/check-url-anchor-parity.mjs --json=report.json
 *   node scripts/check-url-anchor-parity.mjs --write-allowlist # re-record the drifts
 *
 * Needs a production build in `.next` (CI runs it right after `next build`, in
 * the same job). Exits non-zero with an itemized list of gaps.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDocsRedirects, SECTION_ROOTS } from "../lib/docs-redirects.mjs";
// The app renders the page-title anchor from this same module (Decision 2.3), so
// the gate cannot grade a slug the app does not emit, or vice versa.
import { slugifyHeading } from "../lib/title-anchor.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(APP_ROOT, "../..");
const INVENTORY_PATH = join(REPO_ROOT, "docs/url-inventory.json");
const CONTENT_ROOT = join(APP_ROOT, "content/docs");
const ALLOWLIST_PATH = join(SCRIPT_DIR, "url-anchor-drift-allowlist.json");
const DEAD_ANCHORS_PATH = join(SCRIPT_DIR, "redirect-dead-anchors.json");
const MAX_REDIRECT_HOPS = 5;
const READY_TIMEOUT_MS = 120_000;

/** Drops the trailing duplicate-heading counter (`import-29` → `import`, `-2` → ``). */
function withoutDedupCounter(anchor) {
  return anchor.replace(/-\d+$/u, "");
}

function parseArgs(argv) {
  const options = { baseUrl: null, json: null, writeAllowlist: false };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const [key, value] = eq === -1 ? [arg, ""] : [arg.slice(0, eq), arg.slice(eq + 1)];
    if (key === "--base-url") options.baseUrl = value.replace(/\/$/u, "");
    else if (key === "--json") options.json = value;
    else if (key === "--write-allowlist") options.writeAllowlist = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`\`next start\` exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const response = await fetch(`${baseUrl}/docs`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${baseUrl} did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function startServer() {
  const bin = join(APP_ROOT, "node_modules/.bin/next");
  if (!existsSync(bin)) throw new Error(`cannot find the next binary at ${bin} — run pnpm install`);
  if (!existsSync(join(APP_ROOT, ".next"))) {
    throw new Error(
      `no production build at ${join(APP_ROOT, ".next")} — this gate grades a real server, run \`pnpm --filter docs-next build\` first`,
    );
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ["start", "--port", String(port)], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  try {
    await waitForServer(baseUrl, child);
  } catch (error) {
    child.kill("SIGKILL");
    console.error(log.join(""));
    throw error;
  }
  return { baseUrl, stop: () => child.kill("SIGTERM") };
}

/** Every `id="…"` in the document. Extra ids are not a failure, missing ones are. */
function extractIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\sid="([^"]*)"/gu)) ids.add(match[1]);
  return ids;
}

function decodeEntities(text) {
  return text
    .replace(/&#x27;|&apos;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x2F;/gu, "/")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&");
}

function htmlToText(html) {
  return decodeEntities(html.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
}

/** `htmlToText` with `<code>` elements removed first — the old app's heading text. */
function htmlToTextWithoutCode(html) {
  return htmlToText(html.replace(/<code\b[^>]*>[\s\S]*?<\/code>/giu, " "));
}

/**
 * Heading tags, tolerating `>` inside quoted attribute values (Tailwind emits
 * arbitrary variants like `[&>code]:…`, which a plain `[^>]*` would truncate).
 * `h1` is included on purpose: the reference pages open every symbol with a
 * level-1 markdown heading, so most body anchors on `/docs/reference/**` live on
 * an `<h1 id="…">`. The layout's own title is the one `h1` with no `id`.
 */
const HEADING_RE = /<h([1-6])((?:"[^"]*"|[^>])*)>([\s\S]*?)<\/h\1>/giu;

/**
 * Body headings of the served page, each with the two candidate legacy slugs:
 * how `slugifyHeading` would have slugged its text with, and without, the text
 * of its inline-code spans (prod dropped it, github-slugger keeps it).
 */
function extractHeadings(html) {
  const headings = [];
  for (const match of html.matchAll(HEADING_RE)) {
    const [, level, attributes, inner] = match;
    const idMatch = /\sid="([^"]*)"/u.exec(attributes);
    if (!idMatch) continue;
    const text = htmlToText(inner);
    const textWithoutCode = htmlToTextWithoutCode(inner);
    headings.push({
      level: Number(level),
      id: idMatch[1],
      text,
      legacySlugs: new Set([slugifyHeading(text), slugifyHeading(textWithoutCode)]),
    });
  }
  return headings;
}

/**
 * The layout's page title: the first `h1` **without** an `id`. The `id` is what
 * separates it from a body heading — `content/docs/reference/**` opens each
 * symbol with a level-1 markdown heading, and those get slugged ids like any
 * other heading, while the title comes from frontmatter and gets none.
 */
function extractTitle(html) {
  for (const match of html.matchAll(HEADING_RE)) {
    const [, level, attributes, inner] = match;
    if (level !== "1" || /\sid="/u.test(attributes)) continue;
    const text = htmlToText(inner);
    return { text, legacySlugs: new Set([slugifyHeading(text), slugifyHeading(htmlToTextWithoutCode(inner))]) };
  }
  return null;
}

/**
 * Ids that appear more than once in the document, restricted to ids that are
 * anchor targets (heading ids and the page-title anchor). An ambiguous anchor is
 * a real bug and this gate would otherwise be blind to it: ids are collected into
 * a Set, so a duplicate looks exactly like a match. It is also the specific way
 * the Decision 2.3 title anchor could go wrong — the reference pages open every
 * symbol with a level-1 heading, so on `/docs/reference/vgpu/gpu` the title and a
 * body heading slug to the same string, and `titleAnchorId` has to suppress the
 * title id there. This is the assertion that proves it does.
 *
 * Framework ids (`nd-*`, `radix-*`, `_R*`) are excluded: they are not anchor
 * targets and React/radix mint them per render.
 */
function duplicateAnchorIds(html, headingIds, title) {
  const targets = new Set(headingIds);
  if (title) for (const slug of title.legacySlugs) targets.add(slug);
  const counts = new Map();
  for (const match of html.matchAll(/\sid="([^"]*)"/gu)) {
    const id = match[1];
    if (!targets.has(id) || /^(?:nd-|radix-|_R)/u.test(id)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id, count]) => `${id} ×${count}`);
}

/**
 * Gate on the **destinations** of the redirect table, not just its sources.
 *
 * `lib/docs-redirects.mjs` ships 302 rules and 276 of them end in an `#anchor`:
 * the API reference deep links (`/packages/vgpu/Pass` →
 * `/docs/reference/vgpu/effect#effect`) are all derived from the manifest's
 * `record.anchor`, which was slugged by the *old* app. A redirect whose path
 * resolves but whose anchor does not exist is a half-broken URL — the reader
 * lands on the right page at the wrong place — and the source-side check cannot
 * see it, because these sources are not in `docs/url-inventory.json` at all (the
 * F1 freeze only walked `/docs/**`, never `/packages/**`).
 *
 * Same judgement as everywhere else in this gate: the frozen inventory decides.
 * If prod served that anchor on that page, a missing one here is a **regression**
 * and fails. If prod did not, the deep link was already dead before this
 * migration (the old redirect pointed at an anchor the old page never rendered)
 * and it is reported as preexisting — fixing those means changing
 * `record.anchor`, which is the generator's business, not this gate's.
 *
 * @param {{ baseUrl: string, idsByPath: Map<string, Set<string>>, frozenByPath: Map<string, Set<string>> }} context
 */
async function checkRedirectDestinations({ baseUrl, idsByPath, frozenByPath }) {
  const redirects = await loadDocsRedirects();
  const withAnchor = redirects
    .map(({ source, destination }) => {
      const hash = destination.indexOf("#");
      if (hash === -1) return null;
      return { source, path: destination.slice(0, hash), anchor: destination.slice(hash + 1) };
    })
    .filter((entry) => entry !== null && entry.anchor !== "" && !entry.path.includes(":"));

  // Fetch the destinations the inventory pass did not already cover. Distinct
  // paths only: 276 anchors live on far fewer pages.
  for (const path of new Set(withAnchor.map((entry) => entry.path))) {
    if (idsByPath.has(path)) continue;
    const resolved = await resolvePage(baseUrl, path);
    idsByPath.set(path, resolved.status === 200 && resolved.html ? extractIds(resolved.html) : null);
  }

  const regressions = [];
  const preexisting = [];
  let resolvedCount = 0;
  for (const entry of withAnchor) {
    const ids = idsByPath.get(entry.path);
    if (!ids) {
      regressions.push({ ...entry, reason: "destination page does not resolve" });
      continue;
    }
    if (ids.has(decodeURIComponent(entry.anchor))) {
      resolvedCount += 1;
      continue;
    }
    const frozen = frozenByPath.get(entry.path);
    if (frozen?.has(entry.anchor)) {
      regressions.push({ ...entry, reason: "production served this anchor on that page" });
    } else {
      preexisting.push(entry);
    }
  }
  return { total: withAnchor.length, resolved: resolvedCount, regressions, preexisting };
}

function matchesLegacySlug(candidate, anchor) {
  if (candidate.legacySlugs.has(anchor)) return true;
  // Duplicate-heading counters are not comparable across the two sluggers (the
  // old reference pages shared one slugger across a whole package), so they are
  // stripped from both sides before matching.
  const base = withoutDedupCounter(anchor);
  for (const slug of candidate.legacySlugs) {
    if (withoutDedupCounter(slug) === base) return true;
  }
  return false;
}

async function resolvePage(baseUrl, path) {
  const chain = [];
  let current = path;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const response = await fetch(`${baseUrl}${current}`, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { status: response.status, chain, finalPath: current, html: null, error: "3xx with no Location header" };
      }
      chain.push({ from: current, status: response.status, to: location });
      current = location.startsWith("http")
        ? new URL(location).pathname + new URL(location).search
        : location;
      continue;
    }
    const html = response.status === 200 ? await response.text() : null;
    return { status: response.status, chain, finalPath: current, html };
  }
  return { status: 508, chain, finalPath: current, html: null, error: `more than ${MAX_REDIRECT_HOPS} redirect hops` };
}

/**
 * The section-root redirects point at "the first page of the section". That is a
 * fact about `meta.json`, not a constant, so it is re-derived here (descending
 * into subdirectories, since `/docs/reference`'s first entry is a package
 * folder): a reordering that leaves `lib/docs-redirects.mjs` stale must fail CI
 * rather than quietly redirect readers into the middle of a section.
 */
function firstPageOf(dir) {
  const metaPath = join(CONTENT_ROOT, dir, "meta.json");
  if (!existsSync(metaPath)) return { error: `no ${dir}/meta.json to derive the first page from` };
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const pages = Array.isArray(meta.pages) ? meta.pages : [];
  // Skip fumadocs separators (`---Label---`), catch-alls (`...`) and link
  // entries (`[Label](/href)`); the first survivor is the landing entry.
  const first = pages.find((entry) => typeof entry === "string" && !/^(---|\.\.\.|\[)/u.test(entry));
  if (!first) return { error: `${dir}/meta.json has no concrete first page` };
  const asDir = join(CONTENT_ROOT, dir, first);
  if (existsSync(asDir) && existsSync(join(asDir, "meta.json"))) return firstPageOf(join(dir, first));
  return { path: `/docs/${join(dir, first)}` };
}

function checkSectionRootTargets() {
  const problems = [];
  for (const { source, destination, dir } of SECTION_ROOTS) {
    const first = firstPageOf(dir);
    if (first.error) {
      problems.push(`${source}: ${first.error}`);
      continue;
    }
    if (destination !== first.path) {
      problems.push(
        `${source} redirects to ${destination} but the first page of the section is now ${first.path} — update SECTION_ROOTS in lib/docs-redirects.mjs`,
      );
    }
  }
  return problems;
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { entries: [] };
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

/**
 * The frozen list of redirect destinations whose `#anchor` production did not
 * serve either — dead deep links inherited from the old app's table.
 *
 * Printing that number was not enough, and the review proved it: mutating all 255
 * symbol destinations to `#<anchor>-MUTANT` kept the gate GREEN, because every
 * mutated destination just moved from "resolves" into this bucket, whose only
 * consequence was a counter going 117 → 275. A bucket that absorbs regressions
 * silently is a hole in the gate, and the fix is the one this suite already uses
 * twice — for the drift allowlist and for the nav curation snapshot: freeze the
 * expected set, fail on the diff. Growth means a destination stopped resolving
 * (repointed rule, or a heading that disappeared); shrinkage means one got fixed
 * and the list has to shrink with it, in the same PR.
 */
function loadDeadAnchors() {
  if (!existsSync(DEAD_ANCHORS_PATH)) return null;
  const parsed = JSON.parse(readFileSync(DEAD_ANCHORS_PATH, "utf8"));
  return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
}

function writeDeadAnchors(preexisting) {
  const payload = {
    $comment: [
      "TGEIST-12, gate (d). Redirect destinations whose `#anchor` production did not serve",
      "either: the manifest's `record.anchor` never matched a heading on the destination page,",
      "so these deep links were already landing at the top of the page before the migration.",
      "Frozen because the bucket used to be report-only, and a report-only bucket absorbs",
      "regressions: repointing all 255 symbol destinations at nonexistent anchors kept the gate",
      "green while this number went 117 → 275. Now any addition fails (a destination stopped",
      "resolving) and any entry that no longer applies fails as stale (it got fixed — shrink the",
      "list in the same PR). Fixing one for real means fixing `record.anchor` in the generator,",
      "or the heading it should point at. Regenerate with",
      "`node scripts/check-url-anchor-parity.mjs --write-allowlist` and review the diff.",
    ].join(" "),
    entries: preexisting
      .map(({ source, path, anchor }) => ({ source, destination: `${path}#${anchor}` }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.destination.localeCompare(b.destination)),
  };
  writeFileSync(DEAD_ANCHORS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeAllowlist(drifts) {
  const payload = {
    $comment: [
      "TGEIST-12, gate (d). Anchors that production serves and the new tree renames because",
      "fumadocs slugs headings with github-slugger where the old app used slugifyHeading",
      "(inline code counted, `-+` no longer collapsed, per-page duplicate counters). Every",
      "entry is machine-verified by scripts/check-url-anchor-parity.mjs: the heading must",
      "still exist on the page and must still produce `newAnchor`, so an entry can never hide",
      "a heading that disappeared. A drift that is not listed here fails the gate; an entry",
      "that no longer applies fails as stale. Regenerate with",
      "`node scripts/check-url-anchor-parity.mjs --write-allowlist` and review the diff.",
    ].join(" "),
    entries: drifts
      .map(({ path, prodAnchor, newAnchor, heading }) => ({ path, prodAnchor, newAnchor, heading }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.prodAnchor.localeCompare(b.prodAnchor)),
  };
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(INVENTORY_PATH)) {
    console.error(`✗ gate (d): no frozen inventory at ${INVENTORY_PATH}. This gate has no oracle without it.`);
    process.exit(1);
  }
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
  const pages = Array.isArray(inventory.pages) ? inventory.pages : [];
  if (pages.length === 0) {
    console.error("✗ gate (d): docs/url-inventory.json lists no pages. Refusing to pass a gate that checked nothing.");
    process.exit(1);
  }

  let server = null;
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    server = await startServer();
    baseUrl = server.baseUrl;
  }

  const results = [];
  /** final path → every id its HTML carries. Feeds the redirect-destination gate. */
  const idsByPath = new Map();
  /** @type {{ total: number, resolved: number, regressions: Array<object>, preexisting: Array<object> } | null} */
  let destinationProblems = null;
  try {
    for (const page of pages) {
      const resolved = await resolvePage(baseUrl, page.path);
      const frozenAnchors = Array.isArray(page.anchors) ? page.anchors : [];
      const entry = {
        path: page.path,
        status: resolved.status,
        via: resolved.chain.length > 0 ? resolved.chain.map((hop) => `${hop.status} → ${hop.to}`).join(" ") : null,
        finalPath: resolved.finalPath,
        frozenAnchors: frozenAnchors.length,
        /**
         * Anchors that are the page's own title and have no `id` behind them.
         * Decision 2.3 requires the title to carry
         * `id={slugifyHeading(page.data.title)}` (rendered by
         * `app/[lang]/docs/[[...slug]]/page.tsx` via `lib/title-anchor.mjs`), so
         * this list existing at all means that anchor regressed: it is a
         * **failure**, not an accepted class. It is kept as its own bucket only
         * to name the cause precisely instead of reporting "content lost".
         */
        missingTitleAnchors: [],
        /** ids that appear more than once in the page — an ambiguous anchor */
        duplicateIds: [],
        /** anchors whose heading is still there under a new id */
        drifts: [],
        /** anchors with no heading behind them at all — the real failures */
        lostAnchors: [],
        /**
         * Every id the page really renders that can be an anchor target: heading
         * ids **and** the Decision 2.3 page-title anchor, which lives on a
         * zero-height element rather than on the `<h1>` (see
         * `lib/title-anchor.mjs`).
         *
         * Exactly that, nothing else. An earlier revision filtered a blocklist of
         * framework prefixes (`nd-*`, `radix-*`, `_R*`) out of *all* ids instead,
         * which let fumadocs' 56 `sidebar-*` ids per page through — 5389 of the
         * report's 6609 ids were navigation chrome, and the report weighed 472 KB.
         * Nothing pointed at them, so no fragment passed on one, but
         * `check-doc-links.mjs` verifies fragments against this set, and a set
         * that contains ids no heading owns is a set that can say yes for the
         * wrong reason. Allowlisting the two things that *are* anchor targets
         * cannot.
         *
         * Written to the `--json` report so `check-doc-links.mjs` can validate
         * every `#fragment` in the corpus against ids observed in HTML instead of
         * reimplementing github-slugger and hoping the two agree.
         */
        anchorIds: [],
        error: resolved.error ?? null,
      };

      if (resolved.status === 200 && resolved.html) {
        const ids = extractIds(resolved.html);
        const title = extractTitle(resolved.html);
        const headings = extractHeadings(resolved.html);
        const headingIds = headings.map((heading) => heading.id);
        // headings ∪ {the page-title anchor}, which is the one anchor target that
        // is not a heading. It is whichever legacy slug of the title the app
        // actually rendered — `titleAnchorId` suppresses it on collision, and then
        // the id is a heading's anyway.
        const titleAnchor = title ? [...title.legacySlugs].filter((slug) => ids.has(slug)) : [];
        entry.anchorIds = [...new Set([...headingIds, ...titleAnchor])].sort();
        entry.duplicateIds = duplicateAnchorIds(resolved.html, headingIds, title);
        idsByPath.set(resolved.finalPath, ids);
        for (const anchor of frozenAnchors) {
          if (ids.has(anchor)) continue;
          // The title branch matches **exactly**, never modulo the dedup counter.
          // `withoutDedupCounter` exists for body headings, where prod's counters
          // came from a slugger shared across a whole package; applying it here
          // would let `#cli-7` — which in prod was a *different* heading that
          // happened to slug to the title's base — be waved through as "the page
          // title". Numbered anchors go down the drift path, where the heading
          // they belong to has to be produced and recorded.
          if (title && title.legacySlugs.has(anchor)) {
            entry.missingTitleAnchors.push(anchor);
            continue;
          }
          const heading = headings.find((candidate) => matchesLegacySlug(candidate, anchor));
          if (heading) {
            entry.drifts.push({ path: page.path, prodAnchor: anchor, newAnchor: heading.id, heading: heading.text });
            continue;
          }
          entry.lostAnchors.push(anchor);
        }
      }
      results.push(entry);
    }
    // Same server, same build: the destinations of the redirect table are graded
    // here, while it is still up.
    destinationProblems = await checkRedirectDestinations({
      baseUrl,
      idsByPath,
      frozenByPath: new Map(pages.map((page) => [page.path, new Set(page.anchors ?? [])])),
    });
  } finally {
    server?.stop();
  }

  const unresolved = results.filter((entry) => entry.status !== 200);
  const viaRedirect = results.filter((entry) => entry.status === 200 && entry.via);
  const direct = results.length - viaRedirect.length - unresolved.length;
  const allDrifts = results.flatMap((entry) => entry.drifts);
  const lost = results.filter((entry) => entry.lostAnchors.length > 0);
  const frozenAnchorCount = results.reduce((sum, entry) => sum + entry.frozenAnchors, 0);
  const missingTitleAnchorCount = results.reduce((sum, entry) => sum + entry.missingTitleAnchors.length, 0);
  const lostAnchorCount = results.reduce((sum, entry) => sum + entry.lostAnchors.length, 0);
  const presentAnchorCount = frozenAnchorCount - missingTitleAnchorCount - allDrifts.length - lostAnchorCount;
  const missingTitles = results.filter((entry) => entry.missingTitleAnchors.length > 0);
  const duplicates = results.filter((entry) => entry.duplicateIds.length > 0);
  const sectionRootProblems = checkSectionRootTargets();
  const destinations = destinationProblems;

  if (options.writeAllowlist) {
    writeAllowlist(allDrifts);
    console.log(`wrote ${allDrifts.length} drift entries to ${ALLOWLIST_PATH}`);
    writeDeadAnchors(destinations.preexisting);
    console.log(`wrote ${destinations.preexisting.length} dead destination anchors to ${DEAD_ANCHORS_PATH}`);
  }

  // --- dead-destination bookkeeping: the bucket is frozen, not just printed ----
  const frozenDead = loadDeadAnchors();
  const currentDead = new Set(destinations.preexisting.map((entry) => `${entry.source} → ${entry.path}#${entry.anchor}`));
  const recordedDead = new Set((frozenDead?.entries ?? []).map((entry) => `${entry.source} → ${entry.destination}`));
  const newDead = [...currentDead].filter((key) => !recordedDead.has(key)).sort();
  const staleDead = [...recordedDead].filter((key) => !currentDead.has(key)).sort();
  const deadListMissing = frozenDead === null;

  // --- drift bookkeeping: unrecorded, changed and stale entries all fail -----
  const allowlist = loadAllowlist();
  const allowByKey = new Map(allowlist.entries.map((item) => [`${item.path}#${item.prodAnchor}`, item]));
  const seenKeys = new Set();
  const unrecordedDrifts = [];
  const changedDrifts = [];
  for (const drift of allDrifts) {
    const key = `${drift.path}#${drift.prodAnchor}`;
    seenKeys.add(key);
    const recorded = allowByKey.get(key);
    if (!recorded) unrecordedDrifts.push(drift);
    else if (recorded.newAnchor !== drift.newAnchor) changedDrifts.push({ ...drift, recorded: recorded.newAnchor });
    // The `heading` field is load-bearing, not a comment: it is the human-readable
    // claim "this anchor belongs to *that* section", and it is what a reviewer
    // actually reads when approving an entry. If the heading text behind an
    // accepted rename changes, the recorded claim no longer describes reality —
    // the section may have been rewritten into something else — so it has to be
    // re-approved rather than silently inherited.
    else if ((recorded.heading ?? "") !== drift.heading) {
      changedDrifts.push({ ...drift, recorded: `${recorded.newAnchor} (heading was ${JSON.stringify(recorded.heading ?? "")})` });
    }
  }
  const staleAllowlistEntries = allowlist.entries.filter((item) => !seenKeys.has(`${item.path}#${item.prodAnchor}`));

  console.log(
    `gate (d) · URL + anchor parity vs docs/url-inventory.json (frozen ${inventory.frozenAt ?? "?"} from ${inventory.sourceUrl ?? "?"})`,
  );
  console.log(
    `  URLs    ${results.length - unresolved.length}/${results.length} resolve  (${direct} direct · ${viaRedirect.length} via redirect)`,
  );
  console.log(
    `  anchors ${presentAnchorCount}/${frozenAnchorCount} identical · ${allDrifts.length} slugger drift (${allDrifts.length - unrecordedDrifts.length - changedDrifts.length} recorded) · ${missingTitleAnchorCount} missing page-title · ${lostAnchorCount} lost`,
  );
  console.log(
    `  targets ${destinations.resolved}/${destinations.total} redirect destinations land on an existing id` +
      ` (${destinations.preexisting.length} already dead in production, ${recordedDead.size} recorded · ${destinations.regressions.length} regressions)`,
  );

  if (viaRedirect.length > 0) {
    console.log("\n  resolved via redirect:");
    for (const entry of viaRedirect) console.log(`    ${entry.path}  ${entry.via}`);
  }

  if (options.json) {
    writeFileSync(
      options.json,
      `${JSON.stringify(
        {
          inventory: { frozenAt: inventory.frozenAt, sourceUrl: inventory.sourceUrl, gitSha: inventory.gitSha },
          summary: {
            urls: results.length,
            resolved: results.length - unresolved.length,
            direct,
            viaRedirect: viaRedirect.length,
            anchors: frozenAnchorCount,
            identical: presentAnchorCount,
            drifts: allDrifts.length,
            missingTitleAnchors: missingTitleAnchorCount,
            lost: lostAnchorCount,
            redirectDestinations: {
              total: destinations.total,
              resolved: destinations.resolved,
              deadInProduction: destinations.preexisting.length,
              deadRecorded: recordedDead.size,
              deadUnrecorded: newDead.length,
              deadStale: staleDead.length,
              regressions: destinations.regressions.length,
            },
          },
          redirectDestinations: destinations,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\n  report written to ${options.json}`);
  }

  if (destinations.preexisting.length > 0 && newDead.length === 0 && staleDead.length === 0) {
    console.log(
      `\n  ${destinations.preexisting.length} redirect destination(s) point at an anchor production did not serve either —\n  dead deep links inherited from the old app's table (the manifest's \`record.anchor\` never\n  matched a heading on the destination page), all of them recorded in\n  ${relative(APP_ROOT, DEAD_ANCHORS_PATH)}. Fixing one for real means fixing that anchor in the generator.`,
    );
  }

  const failed =
    unresolved.length > 0 ||
    lost.length > 0 ||
    missingTitles.length > 0 ||
    duplicates.length > 0 ||
    destinations.regressions.length > 0 ||
    newDead.length > 0 ||
    staleDead.length > 0 ||
    deadListMissing ||
    unrecordedDrifts.length > 0 ||
    changedDrifts.length > 0 ||
    staleAllowlistEntries.length > 0 ||
    sectionRootProblems.length > 0;

  if (!failed) {
    console.log(
      `\n✓ gate (d): every URL production serves resolves here, every anchor it serves is either identical\n  or a recorded slugger rename whose heading is still present, no anchor id is ambiguous, and every\n  redirect destination lands on an id that exists (bar the ${destinations.preexisting.length} recorded as already dead in production).`,
    );
    return;
  }

  console.error("\n✗ gate (d) FAILED");
  if (missingTitles.length > 0) {
    console.error(
      `\n  ${missingTitleAnchorCount} page-title anchor(s) production serves have no id here. Decision 2.3 requires the\n  title to carry \`id={slugifyHeading(page.data.title)}\` — check that renderTop in\n  app/[lang]/docs/[[...slug]]/page.tsx still emits it (lib/title-anchor.mjs):`,
    );
    for (const entry of missingTitles) {
      console.error(`    ${entry.path}: ${entry.missingTitleAnchors.map((anchor) => `#${anchor}`).join(" ")}`);
    }
  }
  if (duplicates.length > 0) {
    console.error(
      `\n  ${duplicates.length} page(s) render the same anchor id more than once, so the anchor is ambiguous — most\n  likely the page-title id collided with a body heading and titleAnchorId failed to suppress it:`,
    );
    for (const entry of duplicates) console.error(`    ${entry.path}: ${entry.duplicateIds.join(" ")}`);
  }
  if (destinations.regressions.length > 0) {
    console.error(
      `\n  ${destinations.regressions.length} redirect destination(s) point at an anchor that production DID serve and this tree does\n  not. The reader lands on the right page at the wrong place — fix the destination in\n  lib/docs-redirects.mjs (or the heading it should point at):`,
    );
    for (const entry of destinations.regressions) {
      console.error(`    ${entry.source} → ${entry.path}#${entry.anchor}  [${entry.reason}]`);
    }
  }
  if (unresolved.length > 0) {
    console.error(`\n  ${unresolved.length} URL(s) production serves do NOT resolve here:`);
    for (const entry of unresolved) {
      console.error(
        `    ${entry.path} → ${entry.status}${entry.via ? ` (after ${entry.via})` : ""}${entry.error ? ` [${entry.error}]` : ""}`,
      );
    }
    console.error(
      "\n  Fix by emitting the page into content/docs/**, or — when the URL was deliberately\n  consolidated elsewhere — by adding a redirect to apps/docs-next/lib/docs-redirects.mjs.",
    );
  }
  if (lost.length > 0) {
    console.error(
      `\n  ${lostAnchorCount} anchor(s) production serves have no heading behind them here (CONTENT LOST,\n  not a slug rename — no heading on the page slugs to them under either slugger):`,
    );
    for (const entry of lost) {
      console.error(`    ${entry.path}: ${entry.lostAnchors.map((anchor) => `#${anchor}`).join(" ")}`);
    }
  }
  if (unrecordedDrifts.length > 0) {
    console.error(
      `\n  ${unrecordedDrifts.length} anchor(s) renamed by the new slugger and NOT recorded in\n  scripts/url-anchor-drift-allowlist.json (the heading is still there, its id changed —\n  every old deep link to it now lands at the top of the page instead of the section):`,
    );
    for (const drift of unrecordedDrifts) {
      console.error(`    ${drift.path}: #${drift.prodAnchor} → #${drift.newAnchor}   (“${drift.heading}”)`);
    }
    console.error(
      "\n  Either restore the id, or accept the rename by running\n  `node scripts/check-url-anchor-parity.mjs --write-allowlist` and committing the diff.",
    );
  }
  if (changedDrifts.length > 0) {
    console.error(`\n  ${changedDrifts.length} recorded drift(s) now point somewhere else:`);
    for (const drift of changedDrifts) {
      console.error(`    ${drift.path}: #${drift.prodAnchor} → #${drift.newAnchor} (recorded: #${drift.recorded})`);
    }
  }
  if (staleAllowlistEntries.length > 0) {
    console.error(
      `\n  ${staleAllowlistEntries.length} stale entr(ies) in scripts/url-anchor-drift-allowlist.json (the drift no longer\n  happens — good news, but the file must not keep pretending it does):`,
    );
    for (const item of staleAllowlistEntries) console.error(`    ${item.path}: #${item.prodAnchor}`);
  }
  if (sectionRootProblems.length > 0) {
    console.error("\n  section-root redirects out of sync with content/docs/**/meta.json:");
    for (const problem of sectionRootProblems) console.error(`    ${problem}`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error("gate (d) crashed:", error);
  process.exit(1);
});
