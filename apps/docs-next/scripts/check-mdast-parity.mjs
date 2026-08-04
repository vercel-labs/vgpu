#!/usr/bin/env node
/**
 * Gate (c) of Decision 4 — **mdast render parity**, plus the two post-conditions
 * that make M4 and M7/M8 non-optional. TGEIST-05.
 *
 * With the double constraint (source text byte-identical, render with Geist
 * components) parity can no longer be "the markdown is unchanged": the whole
 * point is that the AST changes. What must not change is the **text a reader
 * sees**. So, for every page:
 *
 *   1. parse it to mdast with no plugins        → `toString(before)`
 *   2. run the exact M1–M9 chain `source.config.ts` runs
 *   3. `toString(after)` must equal `toString(before)` modulo whitespace
 *
 * M1–M9 only ever change node *types* and *attributes*, never text, so this is
 * an exact invariant rather than a heuristic — and it automatically catches any
 * plugin (present or future) that drops, duplicates or reorders content. It is
 * both cheaper and stricter than HTML snapshots.
 *
 * Two extra assertions ride along, because they are free once the tree is here
 * and because they are the two failure modes the design calls out by name
 * (risk #6):
 *
 *   - **M4** every `code.lang` that survives the chain must be a language Shiki
 *     can actually load (`bundledLanguages` + Shiki's plain-text specials).
 *     A single ` ```terminal ` reaching `rehypeCode` fails `next build`.
 *   - **M7/M8** no `*.docs.md` href and no bare logical href (`/reference/...`,
 *     `/ml/...`) may survive. Those are the 52 + 33 links that 404 silently.
 *
 * Usage:
 *   node scripts/check-mdast-parity.mjs [dir|file ...]
 *
 * With no arguments it scans `content/docs` (the generated corpus, emitted by
 * TGEIST-04) and `lib/remark-geist/fixtures` (the representative pages this
 * ticket ships, so the gate has teeth before the corpus lands). Missing
 * directories are skipped with a note; an empty scan set is a failure.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

import { loadGeistRemarkTransformers } from "../lib/remark-geist/index.mjs";
import { applyTransformers, loadMarkdownParser } from "../lib/remark-geist/markdown-toolchain.mjs";
import { mdastToText, normalizeWhitespace, visit } from "../lib/remark-geist/mdast-utils.mjs";
import { SHIKI_SPECIAL_LANGUAGES } from "../lib/remark-geist/normalize-code-lang.mjs";
import { isMarkdownDocHref } from "../lib/remark-geist/doc-link-index.mjs";
import { needsDocsPrefix } from "../lib/remark-geist/resolve-doc-links.mjs";
import { calloutTypeFor } from "../lib/remark-geist/callout-blockquotes.mjs";

const APP_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const DEFAULT_TARGETS = ["content/docs", "lib/remark-geist/fixtures"];
const MARKDOWN = /\.mdx?$/u;

/**
 * Same frontmatter strip as `stripMarkdownFrontmatter`
 * (`apps/docs/lib/manifest.ts`). The real pipeline uses `remark-frontmatter`;
 * removing the block up front is equivalent for text-parity purposes and keeps
 * the borrowed parser minimal.
 */
function stripFrontmatter(source) {
  return source.replace(/^---\n[\s\S]*?\n---\n?/u, "");
}

async function collectFiles(target) {
  const absolute = resolve(APP_ROOT, target);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return { files: [], missing: absolute };
  }
  if (info.isFile()) return { files: MARKDOWN.test(absolute) ? [absolute] : [] };

  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (MARKDOWN.test(entry.name)) files.push(path);
    }
  };
  await walk(absolute);
  return { files: files.sort() };
}

async function main() {
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_TARGETS;

  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const missing = [];
  for (const target of targets) {
    const result = await collectFiles(target);
    files.push(...result.files);
    if (result.missing) missing.push(result.missing);
  }

  for (const path of missing) {
    console.log(`ℹ skipped (does not exist yet): ${relative(APP_ROOT, path)}`);
  }

  if (files.length === 0) {
    console.error(
      "✗ check-mdast-parity found no markdown to check. Scanned: " +
        targets.join(", ") +
        ". Refusing to pass a gate that checked nothing.",
    );
    process.exit(1);
  }

  const { parse } = await loadMarkdownParser();
  const { bundledLanguages } = await import("shiki");
  const knownLanguages = Object.keys(bundledLanguages);
  const shikiLanguages = new Set([...knownLanguages, ...SHIKI_SPECIAL_LANGUAGES]);

  /** @type {Array<{ href: string, reason: string, file?: string }>} */
  const reports = [];
  const transformers = await loadGeistRemarkTransformers({
    knownLanguages,
    // The gate wants the *full* list of offenders, not the first exception.
    onUnresolvedMarkdownLink: "silent",
    onReport: (report) => reports.push(report),
  });

  /** @type {string[]} */
  const failures = [];
  /**
   * Fences whose label was **not** a language Shiki knows, so they render
   * unhighlighted. Not a failure (that is the designed degradation), but it must
   * not hide inside the same counter as the deliberate alias mappings: a new
   * unhighlighted block is either a corpus typo or a language worth adding, and
   * either way somebody has to see it.
   * @type {string[]}
   */
  const degradations = [];
  let calloutCount = 0;
  let normalizedFences = 0;
  let rewrittenLinks = 0;

  for (const file of files) {
    const label = relative(APP_ROOT, file);
    const source = stripFrontmatter(await readFile(file, "utf8"));

    const before = normalizeWhitespace(mdastToText(parse(source)));

    const tree = parse(source);
    const beforeLinks = [];
    visit(tree, (node) => {
      if (node.type === "link" || node.type === "definition") beforeLinks.push(node.url);
    });

    try {
      await applyTransformers(tree, transformers, { path: file });
    } catch (error) {
      failures.push(`${label}: plugin chain threw — ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const after = normalizeWhitespace(mdastToText(tree));
    if (after !== before) {
      failures.push(`${label}: TEXT CHANGED by the plugin chain\n${diffSummary(before, after)}`);
    }

    visit(tree, (node) => {
      if (node.type === "mdxJsxFlowElement" && node.name === "Callout") calloutCount += 1;
      // M1/M2, using the plugin's own matcher. Text parity cannot see this
      // mapping stop happening — a Callout and a blockquote hold the same words —
      // so without this post-condition the whole mapping could be dropped and the
      // gate would stay green while the Callouts vanished from the HTML.
      if (node.type === "blockquote") {
        const calloutType = calloutTypeFor(node);
        if (calloutType) {
          failures.push(
            `${label}:${node.position?.start?.line ?? "?"}: blockquote still matches a ` +
              `recognized callout prefix (would be <Callout type="${calloutType}">) but was left ` +
              "as a plain blockquote (M1/M2).",
          );
        }
      }
      if (node.type === "code") {
        const action = node.data?.geistLangAction;
        if (action) {
          normalizedFences += 1;
          if (action === "degraded") {
            degradations.push(
              `${label}:${node.position?.start?.line ?? "?"} "${node.data?.geistOriginalLang}" → text`,
            );
          }
        }
        // Checked **case-sensitively and against the language the node actually
        // carries**, because that is how Shiki looks it up: `json` highlights,
        // `JSON` throws `Language \`JSON\` is not included in this bundle` and
        // takes the build with it. Lowercasing here (as this gate first did) made
        // the oracle strictly weaker than the thing it models, so ` ```JSON `
        // passed the gate and broke `next build` — a gate that green-lights the
        // failure it exists to catch.
        const lang = typeof node.lang === "string" ? node.lang : "";
        if (lang && !shikiLanguages.has(lang)) {
          failures.push(
            `${label}:${node.position?.start?.line ?? "?"}: fence language "${lang}" is unknown ` +
              "to Shiki after normalization (the lookup is case-sensitive, so `JSON` is not " +
              "`json`) — this is exactly what fails `next build` (M4).",
          );
        }
      }
      if (node.type === "link" || node.type === "definition") {
        const href = node.url;
        if (typeof href !== "string" || href.length === 0) return;
        if (isMarkdownDocHref(href)) {
          failures.push(
            `${label}: link "${href}" still points at a *.docs.md file — it would 404 (M7).`,
          );
        }
        // M8, using the plugin's own predicate: after the chain, no href may
        // still be a bare logical docs path. Asserting only M7 (as this gate
        // originally did) meant M8 could be removed wholesale and the gate would
        // still pass — the 33 links it fixes would 404 in production with the
        // gate, the CI step and this file's own docstring all claiming coverage.
        if (needsDocsPrefix(href)) {
          failures.push(
            `${label}: link "${href}" is still a bare logical path — it needs the /docs ` +
              "prefix and would 404 as authored (M8).",
          );
        }
      }
    });

    const afterLinks = [];
    visit(tree, (node) => {
      if (node.type === "link" || node.type === "definition") afterLinks.push(node.url);
    });
    for (let i = 0; i < afterLinks.length; i++) {
      if (afterLinks[i] !== beforeLinks[i]) rewrittenLinks += 1;
    }
  }

  const unresolved = reports.filter((report) => report.reason === "unresolved-docs-md");
  const emptyLinks = reports.filter((report) => report.reason === "empty-link");

  for (const report of unresolved) {
    failures.push(
      `${report.file ? relative(APP_ROOT, report.file) : "?"}: unresolved *.docs.md link ` +
        `"${report.href}" (no matching docs-manifest record).`,
    );
  }

  console.log("");
  console.log(`pages checked        ${files.length}`);
  console.log(`Callouts produced    ${calloutCount} (M1/M2)`);
  console.log(
    `fences normalized    ${normalizedFences} (M4/M5) — of which ${degradations.length} degraded to text`,
  );
  console.log(`links rewritten      ${rewrittenLinks} (M7/M8)`);
  console.log(`empty links (M10)    ${emptyLinks.length} — reported, never rewritten`);
  console.log("");

  if (degradations.length > 0) {
    console.log("  fences whose label is not a language Shiki knows (rendered unhighlighted):");
    for (const degradation of degradations) console.log(`    ${degradation}`);
    console.log("");
  }

  if (emptyLinks.length > 0) {
    for (const report of emptyLinks) {
      console.log(
        `  note: empty link in ${report.file ? relative(APP_ROOT, report.file) : "?"} ` +
          "(M10: pre-existing content bug, for TGEIST-12's link-checker)",
      );
    }
    console.log("");
  }

  if (failures.length > 0) {
    console.error(`✗ mdast parity gate FAILED (${failures.length} problem(s)):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log("✓ mdast parity gate passed: the M1-M9 chain changed no visible text,");
  console.log("  every fence language is one Shiki can load, and no docs link was left unresolved.");
}

/** First divergence between the two texts, with a little context each side. */
function diffSummary(before, after) {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i += 1;
  const window = 80;
  const from = Math.max(0, i - 20);
  return [
    `    first difference at character ${i}`,
    `    before: …${JSON.stringify(before.slice(from, from + window))}`,
    `    after : …${JSON.stringify(after.slice(from, from + window))}`,
  ].join("\n");
}

await main();
