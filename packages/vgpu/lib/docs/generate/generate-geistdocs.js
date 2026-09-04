#!/usr/bin/env node
// TGEIST-04 — "geistdocs" target of the docs generator.
//
// Emits the geistdocs content tree (`content/docs/**/*.md` + a `meta.json` per directory) from the
// SAME `docsManifest` the existing target already builds (see generate.js / manifest.js — untouched
// here, only imported) plus the navigation curation in `docs/nav.json` (TGEIST-03 owns that file;
// this target only reads it).
//
// Design, in one screen:
//
//  * ADDITIVE. `generate:docs` (thin skill router + docs-manifest.generated.js) keeps running exactly as
//    before; this is a second, independent writer with its own npm script and its own output tree.
//
//  * ONE SOURCE FILE ⇒ ONE PAGE (fact 5 of the design doc). A reference topic page is one
//    `*.docs.md` even when the allowlist maps N symbols to it (49 of the 62 topic pages do), so the
//    page count is "unique source files", not "records".
//
//  * The body is VERBATIM except for the TWO permitted subtractions (Decision 2.2):
//      1. the leading `# H1` moves to `frontmatter.title` (geistdocs renders the title from
//         frontmatter, so leaving it in the body duplicates it);
//      2. the first paragraph moves to `frontmatter.description` — and ONLY when it is literally the
//         text we hoisted, so the two are always consistent.
//    Everything else is copied byte for byte. No link rewriting, no fence normalization, no callout
//    mapping: M1–M9 are *render* plugins and belong to TGEIST-05 (`source.config.ts`), not here.
//    The only whitespace touched is: `\r\n`→`\n` (already done by createManifest), leading blank
//    lines after a subtraction, and collapsing the trailing newline run to exactly one.
//
//  * `.md`, never `.mdx` (Decision 2.1 / fact 4): `.md` disables JSX, so `ReadonlyArray<number>` in
//    prose can never break a build and the source corpus stays untouched.
//
//  * DETERMINISTIC + IDEMPOTENT: no timestamps, no git state, no filesystem order (every collection
//    is sorted), so a re-run produces a zero diff. That is what makes the emitted tree committable
//    and drift-checkable (check-docs-content.mjs + `git status` in CI).
//
// Output root defaults to `apps/docs/content/docs` and can be redirected with
// VGPU_GEISTDOCS_CONTENT_DIR (used by the drift check to write into a scratch dir).
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./generate.js";

export const DEFAULT_CONTENT_DIR = "apps/docs/content/docs";

// meta.json entries that intentionally point at content this target does NOT own: `get-started`
// and `examples-api` are hand-authored MDX, and the section index pages (`index.mdx`) are
// hand-authored too. check-docs-content.mjs allows these to be unresolved instead of reporting a
// dangling entry.
export const EXTERNALLY_OWNED_META_ENTRIES = ["get-started", "examples-api"];

/* ------------------------------------------------------------------ paths */

// Ported (not imported) from apps/docs/lib/manifest.ts — the old app is off-limits for this ticket
// and will be deleted at cutover, so the URL-shape rules live here now. Keep in sync until then:
// these two functions ARE the URL contract that docs/url-inventory.json froze from production.
export function referencePackageName(packageName) {
  if (packageName === "vgpu" || packageName === "vgpu/core" || packageName === "vgpu/scene") return packageName;
  if (packageName.startsWith("@vgpu/wgsl-std")) return "@vgpu/wgsl-std";
  if (packageName.startsWith("@vgpu/wgsl")) return "@vgpu/wgsl";
  if (packageName.startsWith("@vgpu/render")) return "@vgpu/render";
  return packageName;
}

export function slugifyPackage(packageName) {
  if (packageName === "guides") return "guides";
  if (packageName === "@vgpu/wgsl") return "wgsl";
  if (packageName === "@vgpu/wgsl-std") return "wgsl-std";
  if (packageName === "@vgpu/render") return "render";
  return packageName.replace(/^@/u, "").replace(/[/@]/gu, "-");
}

// A path segment must survive being a file name AND a URL segment untouched (no percent-encoding,
// no case folding) or the emitted route stops mirroring the production URL. Fail loudly instead of
// silently emitting a page nobody can reach.
function assertSafeSegment(segment, context) {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u.test(segment)) {
    throw new Error(`Unsafe content path segment "${segment}" (${context}) — cannot mirror the production URL`);
  }
  return segment;
}

/* ------------------------------------------------- frontmatter / markdown */

// Same shape as manifest.js's private parseFrontmatter (single-line `key: value` pairs, which is
// all the corpus uses). Exported so check-docs-content.mjs can split a source file the same way
// without importing any of the derivation logic it is supposed to verify independently.
export function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) return { body: markdown, frontmatter: {} };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!item) continue;
    frontmatter[item[1]] = parseYamlScalar(item[2].trim());
  }
  return { body: markdown.slice(match[0].length), frontmatter };
}

// The source corpus only ever uses plain scalars (same assumption manifest.js makes), but the
// frontmatter THIS target emits is double-quoted with `\"`/`\\` escapes — the corpus is full of
// `layout: "auto"` and `"timestamp-query"` inside descriptions. check-docs-content.mjs re-reads the
// emitted files with this same splitter, so unescaping has to be real or the parity gate reports
// phantom mismatches on the 4 pages whose description contains a quote.
function parseYamlScalar(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/gu, "'");
  return raw;
}

export function normalizeInline(text) {
  return text.trim().replace(/\s+/gu, " ");
}

// First block of a markdown body ("block" = run of lines up to a blank line), returned raw so the
// exact bytes can be removed from the body.
function firstBlock(body) {
  const end = body.search(/\n[ \t]*\n/u);
  return end === -1 ? body : body.slice(0, end);
}

// Same predicate manifest.js uses to skip non-prose blocks when extracting a summary: a plain
// paragraph never starts with a heading, fence, table row, list marker, blockquote or html tag.
function isPlainParagraph(block) {
  const trimmed = block.trim();
  if (!trimmed) return false;
  return !/^(#{1,6}\s+|```|\||-|\*|>|<)/u.test(trimmed);
}

function stripLeadingBlankLines(body) {
  return body.replace(/^(?:[ \t]*\n)+/u, "");
}

// Exactly one trailing newline; every other byte of the body is preserved.
function normalizeTrailingNewline(body) {
  const trimmed = body.replace(/(?:[ \t]*\n)+$/u, "");
  return trimmed === "" ? "" : `${trimmed}\n`;
}

function quoteYamlScalar(value) {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * The two subtractions, in one place.
 *
 * @param content full source file (frontmatter included, `\n` line endings)
 * @param fallbackTitle used when the source has neither `frontmatter.title` nor an `# H1`
 * @param fallbackSummary manifest-extracted summary, used only when the page has no leading paragraph
 * @returns { title, description, body }
 */
export function deriveEmission({ content, fallbackTitle, fallbackSummary = "" }) {
  const { body: rawBody, frontmatter } = splitFrontmatter(content);
  let body = stripLeadingBlankLines(rawBody);

  // (1) H1 → title. Only a *leading* H1 is hoisted: a `#` further down the file is real content.
  const heading = body.match(/^#[ \t]+(.+?)[ \t]*$/mu);
  const headingTitle = heading && heading.index === 0 ? heading[1].trim() : null;
  const title = frontmatter.title ?? headingTitle ?? fallbackTitle;

  // Subtract the H1 only when it IS the title. docs/topics/external-ticker.docs.md carries
  // `title: External ticker` in frontmatter *and* a different H1 ("Driving vgpu with an external
  // ticker — GSAP/Motion/XR"); hoisting the frontmatter title and deleting that H1 would delete
  // visible prose, which no rule in Decision 2.2 permits. Keeping it costs one extra heading and
  // loses nothing.
  if (headingTitle !== null && headingTitle === title) {
    body = stripLeadingBlankLines(body.slice(heading[0].length));
  }

  // (2) first paragraph → description. A source `summary:` wins (Decision 2.2 rule 3: those guides
  // keep their body intact), otherwise the leading paragraph itself becomes the description.
  const block = firstBlock(body);
  const leadingParagraph = isPlainParagraph(block) ? normalizeInline(block) : null;
  const description = frontmatter.summary
    ? normalizeInline(frontmatter.summary)
    : (leadingParagraph ?? normalizeInline(fallbackSummary));

  // Subtract the paragraph only when it IS the description — never remove text that stays hidden.
  if (leadingParagraph !== null && description === leadingParagraph) {
    body = stripLeadingBlankLines(body.slice(block.length));
  }

  return { title, description, body: normalizeTrailingNewline(body) };
}

export function renderPage({ title, description, body }) {
  const lines = ["---", `title: ${quoteYamlScalar(title)}`];
  if (description) lines.push(`description: ${quoteYamlScalar(description)}`);
  lines.push("---", "");
  return `${lines.join("\n")}\n${body}`;
}

/* ----------------------------------------------------------- page inventory */

function titleFromSlug(slug) {
  return slug
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every page the geistdocs tree contains, with the URL it must mirror.
 *
 * Route shapes (all verified against apps/docs/app/docs/** and docs/nav.json):
 *  - api records            → /reference/<packageSlug>/<topic>   (N symbols share one page)
 *  - guides `concepts-*`    → /concepts/<slug>                   (the curated Concepts section;
 *                             /docs/concepts/[slug] and lib/concepts.ts are deleted by Decision 5,
 *                             the pages themselves keep their production URL)
 *  - other guides           → /guides/<symbol>
 *  - guides with websitePath→ that path verbatim (/cli, /ml, /ml/browser, ...)
 *
 * A URL that is also the parent of other URLs (/ml) becomes `<dir>/index.md`, which geistdocs picks
 * up as that folder's landing page.
 */
export function buildPages(manifest) {
  const pages = [];

  const byTopic = new Map();
  for (const record of manifest.records.filter((item) => item.kind === "api")) {
    const packageName = referencePackageName(record.package);
    const key = `${packageName}\u0000${record.topic}`;
    byTopic.set(key, [...(byTopic.get(key) ?? []), record]);
  }
  for (const [key, records] of [...byTopic.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const packageName = key.split("\u0000")[0];
    const sorted = [...records].sort((a, b) => compareStrings(a.symbol, b.symbol));
    const first = sorted[0];
    const repoPaths = new Set(sorted.map((record) => record.repoPath));
    if (repoPaths.size !== 1) {
      throw new Error(`Topic ${key.replace("\u0000", "/")} spans ${repoPaths.size} source files — one page cannot mirror both`);
    }
    pages.push({
      kind: "reference",
      segments: [
        "reference",
        assertSafeSegment(slugifyPackage(packageName), `package ${packageName}`),
        assertSafeSegment(first.topic, `topic of ${first.repoPath}`),
      ],
      packageName,
      records: sorted,
      repoPath: first.repoPath,
      content: first.content,
      fallbackTitle: first.topicTitle || titleFromSlug(first.topic),
      fallbackSummary: first.summary,
    });
  }

  for (const record of manifest.records.filter((item) => item.kind === "guide")) {
    const segments = record.websitePath
      ? record.websitePath.slice(1).split("/")
      : record.symbol.startsWith("concepts-")
        ? ["concepts", record.symbol.slice("concepts-".length)]
        : ["guides", record.symbol];
    pages.push({
      kind: "guide",
      segments: segments.map((segment) => assertSafeSegment(segment, `guide ${record.repoPath}`)),
      records: [record],
      repoPath: record.repoPath,
      content: record.content,
      fallbackTitle: record.topicTitle || titleFromSlug(record.symbol),
      fallbackSummary: record.summary,
    });
  }

  // /ml is both a page and the parent of /ml/browser → it has to become ml/index.md.
  const directories = new Set();
  for (const page of pages) {
    for (let index = 1; index < page.segments.length; index += 1) {
      directories.add(page.segments.slice(0, index).join("/"));
    }
  }
  for (const page of pages) {
    const url = `/${page.segments.join("/")}`;
    const file = directories.has(page.segments.join("/"))
      ? [...page.segments, "index"]
      : page.segments;
    page.url = url;
    page.path = `${file.join("/")}.md`;
  }

  pages.sort((a, b) => compareStrings(a.path, b.path));

  const seen = new Map();
  for (const page of pages) {
    if (seen.has(page.path)) {
      throw new Error(`Two source files map to ${page.path}: ${seen.get(page.path)} and ${page.repoPath}`);
    }
    seen.set(page.path, page.repoPath);
  }
  return pages;
}

/* ------------------------------------------------------------- meta.json */

function isCatchAll(entry) {
  return entry === "..." || (entry !== null && typeof entry === "object" && Object.hasOwn(entry, "..."));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function findSection(nav, title) {
  return (nav.sections ?? []).find((section) => !isCatchAll(section) && section.title === title) ?? null;
}

// Tolerates both shapes docs/nav.json uses for `groups`: a real array of groups, and the literal
// `"..."` / `[{"...": []}]` catch-all that marks a section as 100% derived (Examples, API Reference).
function sectionItemSlugs(section, prefix) {
  const slugs = [];
  const groups = Array.isArray(section?.groups) ? section.groups : [];
  for (const group of groups) {
    if (isCatchAll(group)) continue;
    for (const item of group.items ?? []) {
      if (typeof item?.href !== "string") continue;
      if (item.href === prefix) continue; // the section landing page (index.mdx), not a child slug
      if (!item.href.startsWith(`${prefix}/`)) continue;
      slugs.push(item.href.slice(prefix.length + 1));
    }
  }
  return slugs;
}

/**
 * Translates docs/nav.json into one meta.json per directory.
 *
 * nav.json's `"..."` catch-alls (packageOrder, topicOrder[pkg], guideGroups) map 1:1 onto
 * geistdocs' own `"..."` entry — same meaning in both schemas: "then everything not listed above,
 * alphabetically". Group titles become `"---Title---"` separators. Sections outside content/docs
 * (`/examples`, which docsHref() exempts from the /docs prefix) become `"[Label](/route)"` links.
 * A catch-all is appended to every generated directory even where nav.json lists its entries
 * literally (concepts, ml), so a newly added source file is never an invisible page.
 */
export function buildMetaFiles(nav, pages) {
  const files = new Map();
  const emittedPaths = new Set(pages.map((page) => page.path));

  // -- root: one entry per nav section, in nav order --------------------------
  const rootPages = [];
  for (const section of nav.sections ?? []) {
    if (isCatchAll(section)) {
      rootPages.push("...");
      continue;
    }
    const href = section.href;
    if (typeof href !== "string" || !href.startsWith("/")) {
      throw new Error(`nav.json section "${section.title}" has no absolute href`);
    }
    // /examples lives outside content/docs (see docsHref() in apps/docs/lib/nav.ts).
    if (href.startsWith("/examples")) {
      rootPages.push(`[${section.title}](${href})`);
      continue;
    }
    const segments = href.slice(1).split("/");
    rootPages.push(segments.length === 1 ? segments[0] : `[${section.title}](/docs${href})`);
  }
  // The examples API reference is intentionally hand-authored beside the generated `.md` corpus.
  // Keep it adjacent to the examples gallery in the root navigation without pretending it is a
  // manifest-derived page or adding a second navigation source.
  const examplesIndex = rootPages.findIndex((entry) => entry.startsWith("[Examples]("));
  rootPages.splice(examplesIndex === -1 ? rootPages.length : examplesIndex + 1, 0, "examples-api");
  // Root branding (TGEIST-11 gap 2, flagged in the #278 review): nav.json's optional
  // `root.{title,description}` becomes content/docs/meta.json's own `title`/`description`, the
  // same keys `geistdocsMetaSchema` already accepts on every other directory's meta.json. nav.json
  // (TGEIST-03) stays the single source; this emitter stays a mechanical translation, same as every
  // section above — no new concept, just two more optional fields carried through.
  const rootMeta = { root: true };
  if (typeof nav.root?.title === "string") rootMeta.title = nav.root.title;
  if (typeof nav.root?.description === "string") rootMeta.description = nav.root.description;
  rootMeta.pages = rootPages;
  files.set("meta.json", serializeJson(rootMeta));

  // -- get-started: literal order from the Get started section (TGEIST-11) --
  // The 3 pages here are hand-authored .mdx (EXTERNALLY_OWNED_META_ENTRIES), but their *order* has
  // no reason to be hand-authored too: docs/nav.json's "Get started" section already declares it
  // (Agents, Web, Node.js), the same source every other section's meta.json is derived from below.
  // Emitting this file — instead of leaving it for a human to create by hand next to hand-authored
  // pages — is what makes `prune()`'s "I own every meta.json" invariant actually true: an
  // unemitted-but-present get-started/meta.json is exactly the file `prune()` deletes as an orphan
  // on the next run, sidebar order silently reverting to alphabetical. Deriving it here removes the
  // hand-authored copy instead of trying to make prune() smarter about what it should spare.
  const getStartedSection = findSection(nav, "Get started");
  if (getStartedSection) {
    files.set(
      "get-started/meta.json",
      serializeJson({
        title: getStartedSection.title,
        pages: [...sectionItemSlugs(getStartedSection, "/get-started"), "..."],
      }),
    );
  }

  // -- concepts: literal order from the Concepts section ---------------------
  const conceptsSection = findSection(nav, "Concepts");
  if (conceptsSection) {
    files.set(
      "concepts/meta.json",
      serializeJson({ title: conceptsSection.title, pages: [...sectionItemSlugs(conceptsSection, "/concepts"), "..."] }),
    );
  }

  // -- ml: literal order from the ML section (the /ml overview is ml/index.md) -
  const mlSection = findSection(nav, "ML");
  if (mlSection) {
    files.set("ml/meta.json", serializeJson({ title: mlSection.title, pages: [...sectionItemSlugs(mlSection, "/ml"), "..."] }));
  }

  // -- guides: guideGroups → separators + slugs ------------------------------
  const guidePages = [];
  let guidesHaveCatchAll = false;
  for (const group of nav.guideGroups ?? []) {
    if (isCatchAll(group)) {
      guidesHaveCatchAll = true;
      continue;
    }
    if (group.title) guidePages.push(`---${group.title}---`);
    for (const slug of group.slugs ?? []) guidePages.push(slug);
  }
  if (guidesHaveCatchAll || guidePages.length > 0) {
    files.set(
      "guides/meta.json",
      serializeJson({ title: findSection(nav, "Guides")?.title ?? "Guides", pages: [...guidePages, "..."] }),
    );
  }

  // -- reference: packageOrder, then topicOrder per package ------------------
  const referenceSection = findSection(nav, "API Reference");
  const packageOrder = nav.packageOrder ?? [];
  const referencePages = packageOrder.map((entry) => (isCatchAll(entry) ? "..." : slugifyPackage(entry)));
  if (!referencePages.includes("...")) referencePages.push("...");
  files.set(
    "reference/meta.json",
    serializeJson({ title: referenceSection?.title ?? "API Reference", pages: referencePages }),
  );

  const packagesInPages = new Map();
  for (const page of pages) {
    if (page.kind !== "reference") continue;
    packagesInPages.set(page.packageName, page.segments[1]);
  }
  for (const packageName of [...packagesInPages.keys()].sort(compareStrings)) {
    const packageSlug = packagesInPages.get(packageName);
    const order = (nav.topicOrder ?? {})[packageName];
    const topicPages = (order ?? []).map((entry) => (isCatchAll(entry) ? "..." : entry));
    if (!topicPages.includes("...")) topicPages.push("...");
    files.set(`reference/${packageSlug}/meta.json`, serializeJson({ title: packageName, pages: topicPages }));
  }

  // Dangling literal entries are a nav.json bug (TGEIST-03 owns the file) or a slug drift here;
  // either way it silently hides a page, so refuse to emit.
  for (const [metaPath, contents] of files) {
    const dir = metaPath === "meta.json" ? "" : `${dirname(metaPath)}/`;
    // The whole subtree is hand-authored (get-started/**.mdx today) when `dir` itself is one of
    // EXTERNALLY_OWNED_META_ENTRIES: every entry in *this* meta.json points at a page this target
    // does not emit, by construction, so none of them can resolve against `emittedPaths` below.
    const dirIsExternallyOwned = EXTERNALLY_OWNED_META_ENTRIES.includes(dir.replace(/\/$/u, ""));
    if (dirIsExternallyOwned) continue;
    for (const entry of JSON.parse(contents).pages ?? []) {
      if (entry === "..." || /^---.*---$/u.test(entry) || /^(?:external:)?\[.*\]\(.*\)$/u.test(entry)) continue;
      if (EXTERNALLY_OWNED_META_ENTRIES.includes(entry)) continue;
      const asPage = `${dir}${entry}.md`;
      const asIndex = `${dir}${entry}/index.md`;
      const asDirectory = [...emittedPaths].some((path) => path.startsWith(`${dir}${entry}/`));
      if (!emittedPaths.has(asPage) && !emittedPaths.has(asIndex) && !asDirectory) {
        throw new Error(`${metaPath} lists "${entry}" but no page resolves to it`);
      }
    }
  }

  return files;
}

/* ---------------------------------------------------------------- emission */

export function buildGeistdocsFiles({ manifest, nav }) {
  const pages = buildPages(manifest);
  const files = new Map();
  for (const page of pages) {
    files.set(page.path, renderPage(deriveEmission(page)));
  }
  for (const [path, contents] of buildMetaFiles(nav, pages)) files.set(path, contents);
  return { pages, files: new Map([...files.entries()].sort((a, b) => compareStrings(a[0], b[0]))) };
}

function writeAtomic(outPath, contents) {
  mkdirSync(dirname(outPath), { recursive: true });
  const temp = `${outPath}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, outPath);
}

// Prune only what this target owns: generated `.md` pages and `meta.json`. Hand-authored `.mdx`
// (get-started, section landing pages) is never touched, so the two authoring modes can share the
// tree while stale generated pages still cannot survive a rename.
function prune(dir, expected) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name))) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      prune(full, expected);
      try {
        rmdirSync(full);
      } catch {}
      continue;
    }
    const owned = entry.name === "meta.json" || (entry.name.endsWith(".md") && !entry.name.endsWith(".mdx"));
    if (owned && !expected.has(full) && !/\.\d+\.tmp$/u.test(entry.name)) rmSync(full, { force: true });
  }
}

export function generateGeistdocs({ root, contentDir }) {
  const manifest = loadManifest(root);
  const nav = JSON.parse(readFileSync(resolve(root, "docs/nav.json"), "utf8"));
  const { pages, files } = buildGeistdocsFiles({ manifest, nav });

  const expected = new Set();
  let bytes = 0;
  for (const [path, contents] of files) {
    const outPath = resolve(contentDir, path);
    expected.add(outPath);
    bytes += Buffer.byteLength(contents);
    writeAtomic(outPath, contents);
  }
  prune(contentDir, expected);

  return { manifest, pages, files, bytes };
}

/* --------------------------------------------------------------------- cli */

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../../../..");

export function resolveContentDir(root = repoRoot) {
  const override = process.env.VGPU_GEISTDOCS_CONTENT_DIR;
  return override ? resolve(process.cwd(), override) : resolve(root, DEFAULT_CONTENT_DIR);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contentDir = resolveContentDir();
  const { manifest, pages, files, bytes } = generateGeistdocs({ root: repoRoot, contentDir });
  const metaCount = [...files.keys()].filter((path) => path.endsWith("meta.json")).length;
  console.log(
    `geistdocs target: ${pages.length} pages + ${metaCount} meta.json (${bytes} bytes) from ${manifest.records.length} manifest records`,
  );
  console.log(`  → ${relative(process.cwd(), contentDir) || "."}`);
}

export { join };
