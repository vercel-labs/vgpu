#!/usr/bin/env node
// TGEIST-04 — gate (b) of Decision 4: EMISSION PARITY of the geistdocs content tree.
//
// For every page the manifest produces, assert that the committed `.md` is the source file minus
// exactly three things: the frontmatter, the leading `# H1`, and the leading paragraph — and NOTHING
// else. TGEIST-12 formalizes this into the `docs-parity` job together with (a), (c) and (d).
//
// The check is deliberately NOT a re-run of the generator's own derivation (that would be
// tautological). It only imports the *inventory* (which source file owns which output path) and the
// frontmatter splitter, then proves the byte-level property structurally:
//
//   1. `sourceBody.trimEnd().endsWith(emittedBody.trimEnd())` — the emitted body is a VERBATIM TAIL
//      of the source body. One string comparison; catches any rewrite, reflow, link resolution or
//      fence normalization anywhere in the corpus.
//   2. The prefix that the tail leaves over may contain ONLY blank lines, at most one `# ` line whose
//      text equals `frontmatter.title`, and at most one paragraph whose whitespace-normalized text
//      equals `frontmatter.description`. So the two permitted subtractions are proven to be exactly
//      what was hoisted into the frontmatter — nothing was dropped on the way.
//   3. `title` is non-empty (geistdocs' Zod schema requires it) and `.md` files are never `.mdx`.
//   4. No stale/extra generated `.md` in the tree, and every `meta.json` is valid against the
//      documented geistdocs meta schema (keys + `pages` entry grammar), with every literal entry
//      resolving to a real page.
//
// Usage: node packages/vgpu/lib/docs/generate/check-docs-content.mjs [contentDir]
// (also honours VGPU_GEISTDOCS_CONTENT_DIR, like the generator).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  EXTERNALLY_OWNED_META_ENTRIES,
  buildPages,
  normalizeInline,
  repoRoot,
  resolveContentDir,
  splitFrontmatter,
} from "./generate-geistdocs.js";
import { loadManifest } from "./generate.js";

const META_KEYS = new Set(["title", "description", "root", "defaultOpen", "icon", "pages"]);
const SEPARATOR = /^---.*---$/u;
const LINK = /^(?:external:)?\[[^\]]*\]\([^)]*\)$/u;

const contentDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : resolveContentDir();
const errors = [];
const fail = (message) => errors.push(message);

const manifest = loadManifest(repoRoot);
const pages = buildPages(manifest);

// --- 1..3: per-page emission parity ------------------------------------------
let checkedBytes = 0;
for (const page of pages) {
  const outPath = resolve(contentDir, page.path);
  if (!existsSync(outPath)) {
    fail(`${page.path}: missing (source ${page.repoPath})`);
    continue;
  }
  const emitted = readFileSync(outPath, "utf8");
  checkedBytes += Buffer.byteLength(emitted);

  const { body: emittedBody, frontmatter } = splitFrontmatter(emitted);
  if (!emitted.startsWith("---\n")) fail(`${page.path}: no frontmatter block`);
  if (!frontmatter.title) fail(`${page.path}: frontmatter.title is required by geistdocsFrontmatterSchema`);

  const sourceBody = splitFrontmatter(page.content).body;
  const source = sourceBody.trimEnd();
  // The emitted file separates frontmatter from body with one blank line; that separator is not
  // content, so it is not part of the tail comparison (leading blank lines are normalized on both
  // sides — every other byte is compared literally).
  const body = emittedBody.replace(/^(?:[ \t]*\n)+/u, "").trimEnd();

  if (!source.endsWith(body)) {
    fail(`${page.path}: body is not a verbatim tail of ${page.repoPath} (content was transformed)`);
    continue;
  }

  const prefix = source.slice(0, source.length - body.length);
  const issue = describePrefix(prefix, frontmatter);
  if (issue) fail(`${page.path}: ${issue} (source ${page.repoPath})`);

  if (frontmatter.description !== undefined && !frontmatter.description) {
    fail(`${page.path}: empty frontmatter.description emitted`);
  }
}

/**
 * The removed prefix must be: blank lines, then optionally the H1 (matching `title`), then blank
 * lines, then optionally the first paragraph (matching `description`). Anything else means content
 * was deleted, which is what this gate exists to forbid.
 */
function describePrefix(prefix, frontmatter) {
  const lines = prefix.split("\n");
  let index = 0;
  const skipBlank = () => {
    while (index < lines.length && lines[index].trim() === "") index += 1;
  };

  skipBlank();
  if (index < lines.length && /^#[ \t]+/u.test(lines[index])) {
    const heading = lines[index].replace(/^#[ \t]+/u, "").trim();
    if (heading !== frontmatter.title) {
      return `removed H1 "${heading}" does not match frontmatter.title "${frontmatter.title}"`;
    }
    index += 1;
  }

  skipBlank();
  const paragraph = [];
  while (index < lines.length && lines[index].trim() !== "") {
    paragraph.push(lines[index]);
    index += 1;
  }
  if (paragraph.length > 0) {
    const text = normalizeInline(paragraph.join("\n"));
    if (text !== frontmatter.description) {
      return `removed paragraph does not match frontmatter.description (removed: "${truncate(text)}", description: "${truncate(frontmatter.description ?? "")}")`;
    }
  }

  skipBlank();
  if (index < lines.length) {
    return `removed more than the H1 and the first paragraph (extra content: "${truncate(lines.slice(index).join(" "))}")`;
  }
  return null;
}

function truncate(text) {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// --- 4: no stale pages, valid meta.json --------------------------------------
const expectedPages = new Set(pages.map((page) => page.path));
const found = { md: new Set(), meta: new Set() };
if (existsSync(contentDir)) walk(contentDir);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const relativePath = relative(contentDir, full).split("\\").join("/");
    if (entry.name === "meta.json") found.meta.add(relativePath);
    else if (entry.name.endsWith(".md")) found.md.add(relativePath);
  }
}

for (const path of [...found.md].sort()) {
  if (!expectedPages.has(path)) fail(`${path}: stale generated page (no manifest record produces it)`);
}

const pageDirectories = new Set(pages.map((page) => page.path.split("/").slice(0, -1).join("/")));
for (const metaPath of [...found.meta].sort()) {
  let meta;
  try {
    meta = JSON.parse(readFileSync(resolve(contentDir, metaPath), "utf8"));
  } catch (error) {
    fail(`${metaPath}: invalid JSON (${error.message})`);
    continue;
  }
  for (const key of Object.keys(meta)) {
    if (!META_KEYS.has(key)) fail(`${metaPath}: "${key}" is not a key of geistdocsMetaSchema`);
  }
  if (meta.title !== undefined && typeof meta.title !== "string") fail(`${metaPath}: title must be a string`);
  if (meta.root !== undefined && typeof meta.root !== "boolean") fail(`${metaPath}: root must be a boolean`);
  if (meta.pages !== undefined && !Array.isArray(meta.pages)) {
    fail(`${metaPath}: pages must be an array`);
    continue;
  }

  const dir = metaPath === "meta.json" ? "" : `${metaPath.slice(0, -"meta.json".length)}`;
  const seen = new Set();
  for (const entry of meta.pages ?? []) {
    if (typeof entry !== "string") {
      fail(`${metaPath}: pages entry ${JSON.stringify(entry)} is not a string`);
      continue;
    }
    if (entry !== "..." && !SEPARATOR.test(entry) && seen.has(entry)) fail(`${metaPath}: duplicate pages entry "${entry}"`);
    seen.add(entry);
    if (entry === "..." || SEPARATOR.test(entry) || LINK.test(entry)) continue;
    if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u.test(entry)) {
      fail(`${metaPath}: pages entry "${entry}" is neither a slug, a "---separator---", a "[link](/route)" nor "..."`);
      continue;
    }
    if (EXTERNALLY_OWNED_META_ENTRIES.includes(entry)) continue;
    const resolves =
      expectedPages.has(`${dir}${entry}.md`) ||
      expectedPages.has(`${dir}${entry}/index.md`) ||
      pageDirectories.has(`${dir}${entry}`) ||
      existsSync(resolve(contentDir, `${dir}${entry}.mdx`)) ||
      isDirectory(resolve(contentDir, `${dir}${entry}`));
    if (!resolves) fail(`${metaPath}: pages entry "${entry}" does not resolve to a page or folder`);
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

if (errors.length > 0) {
  console.error(`::error::geistdocs emission parity FAILED — ${errors.length} problem(s) in ${relative(repoRoot, contentDir)}:`);
  for (const message of errors) console.error(`  - ${message}`);
  console.error("\nRegenerate with `pnpm -F @vgpu/cli generate:docs:geistdocs` and commit the result.");
  process.exit(1);
}

console.log(
  `geistdocs emission parity OK — ${pages.length} pages (${checkedBytes} bytes) are verbatim tails of their sources; ${found.meta.size} meta.json valid.`,
);
