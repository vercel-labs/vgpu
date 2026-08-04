#!/usr/bin/env node
/**
 * Formal validation of the generated corpus against the **real** geistdocs
 * schemas. TGEIST-12 (deferred here from TGEIST-04, which had no `pnpm install`
 * available in its CI job and therefore no way to import the package).
 *
 * `source.config.ts` declares `schema: geistdocsFrontmatterSchema` and
 * `schema: geistdocsMetaSchema`, so `next build` does validate the corpus — but
 * it validates it *while compiling MDX*, which means the failure surfaces as a
 * fumadocs-mdx compile error somewhere inside a build that already spent minutes
 * bundling, with a message about a Zod issue in a virtual file. This script
 * validates the same two schemas, straight from `@vercel/geistdocs`, against
 * every `.md`/`.mdx` frontmatter and every `meta.json`, in about a second, and
 * names the file and the field. In CI it runs *before* the build for exactly
 * that reason: a bad frontmatter should cost seconds, not a whole build.
 *
 * It also closes a hole the build genuinely does not cover: a `meta.json` in a
 * directory fumadocs never walks (an orphaned or misplaced one) is validated
 * here and ignored there.
 *
 * The frontmatter parser is a deliberately tiny YAML subset (`key: value`, with
 * JSON-style double-quoted or bare scalars) and it **hard-fails on anything it
 * does not understand** rather than guessing: the corpus is machine-generated and
 * uniform (96 files, `title` + `description`), so an unexpected shape means
 * either the generator changed or a file was hand-edited, and both deserve a
 * loud stop instead of a lenient parse. A real YAML dependency is not available
 * here — `js-yaml` only exists as a transitive dep of fumadocs-mdx and
 * `apps/docs-next` must not grow a direct dependency just for a check.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { geistdocsFrontmatterSchema, geistdocsMetaSchema } from "@vercel/geistdocs/source-config";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = join(APP_ROOT, "content/docs");
const MARKDOWN = /\.mdx?$/u;

/**
 * @param {string} source
 * @param {string} label
 * @returns {{ data?: Record<string, unknown>, error?: string }}
 */
function parseFrontmatter(source, label) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  if (!match) return { error: `${label}: no frontmatter block (geistdocs requires at least a title)` };

  /** @type {Record<string, unknown>} */
  const data = {};
  for (const [index, line] of match[1].split("\n").entries()) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const pair = /^([A-Za-z][\w-]*): (.*)$/u.exec(line);
    if (!pair) {
      return {
        error:
          `${label}: frontmatter line ${index + 1} (${JSON.stringify(line)}) is not \`key: value\`. ` +
          "This checker only understands the flat, generated shape on purpose — extend it deliberately " +
          "(scripts/check-content-schemas.mjs) rather than let an unparsed field skip validation.",
      };
    }
    const [, key, rawValue] = pair;
    const value = rawValue.trim();
    if (value.startsWith('"')) {
      try {
        data[key] = JSON.parse(value);
      } catch {
        return { error: `${label}: frontmatter key \`${key}\` has an unparseable quoted value: ${value}` };
      }
    } else if (value === "true" || value === "false") data[key] = value === "true";
    else if (value !== "" && !Number.isNaN(Number(value))) data[key] = Number(value);
    else data[key] = value;
  }
  return { data };
}

function walk(dir) {
  const markdown = [];
  const metas = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = walk(path);
      markdown.push(...nested.markdown);
      metas.push(...nested.metas);
    } else if (MARKDOWN.test(entry.name)) markdown.push(path);
    else if (entry.name === "meta.json") metas.push(path);
  }
  return { markdown: markdown.sort(), metas: metas.sort() };
}

function formatIssues(result) {
  return (result.error?.issues ?? []).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function main() {
  let contentExists = true;
  try {
    contentExists = statSync(CONTENT_ROOT).isDirectory();
  } catch {
    contentExists = false;
  }
  if (!contentExists) {
    console.error(`✗ schema check: no corpus at ${CONTENT_ROOT}. Refusing to pass a check that checked nothing.`);
    process.exit(1);
  }

  const { markdown, metas } = walk(CONTENT_ROOT);
  if (markdown.length === 0) {
    console.error(`✗ schema check: no markdown under ${CONTENT_ROOT}.`);
    process.exit(1);
  }

  const failures = [];

  for (const file of markdown) {
    const label = relative(APP_ROOT, file);
    const { data, error } = parseFrontmatter(readFileSync(file, "utf8"), label);
    if (error) {
      failures.push(error);
      continue;
    }
    const result = geistdocsFrontmatterSchema.safeParse(data);
    if (!result.success) {
      for (const issue of formatIssues(result)) failures.push(`${label}: frontmatter ${issue}`);
    }
  }

  for (const file of metas) {
    const label = relative(APP_ROOT, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      failures.push(`${label}: not valid JSON — ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const result = geistdocsMetaSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of formatIssues(result)) failures.push(`${label}: ${issue}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `✗ corpus does not satisfy the geistdocs schemas — ${failures.length} problem(s).\n  These are the schemas source.config.ts hands to fumadocs-mdx, so every one of them is a\n  build failure waiting to happen (or, for an unwalked meta.json, a silently ignored file):`,
    );
    for (const failure of failures) console.error(`    ${failure}`);
    console.error(
      "\n  Fix the generator (packages/vgpu/lib/docs/generate/generate-geistdocs.js), never the\n  emitted file: content/docs/** is generated output.",
    );
    process.exit(1);
  }

  console.log(
    `✓ corpus validates against the real geistdocs schemas — ${markdown.length} frontmatters against ` +
      `geistdocsFrontmatterSchema, ${metas.length} meta.json against geistdocsMetaSchema (@vercel/geistdocs).`,
  );
}

main();
