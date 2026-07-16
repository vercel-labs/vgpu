import { readFileSync } from "node:fs";
import { MANIFEST_VERSION } from "../model.js";

export function parseAllowlist(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [packageName, symbol, repoPath, ...extra] = line.split(/\s+/u);
    if (!packageName || !symbol || !repoPath || extra.length > 0) throw new Error(`Invalid allowlist line: ${line}`);
    return { package: packageName, symbol, repoPath };
  });
}

export function virtualPathFor(entry) {
  return `/${entry.package}/${entry.repoPath.split("/").at(-1)}`;
}

// Guide docs are conceptual topics (not tied to an exported symbol). They live under the synthetic
// "guides" package; the symbol is the file slug so `vgpu docs cat <slug>` resolves.
export function guideEntryFor(repoPath) {
  const file = repoPath.split("/").at(-1);
  return { package: "guides", symbol: file.replace(/\.docs\.md$/u, ""), repoPath };
}

export function guideVirtualPathFor(repoPath) {
  return `/guides/${repoPath.split("/").at(-1)}`;
}

/**
 * Builds the docs manifest from the allowlist (per-symbol API docs) and an optional list of guide
 * doc paths (conceptual topics under docs/topics). Every record carries a `kind` ("api" | "guide").
 */
export function createManifest(allowlistText, options = {}) {
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const exists = options.exists ?? (() => true);
  const load = (repoPath) => {
    if (!exists(repoPath)) throw new Error(`Missing docs file: ${repoPath}`);
    return read(repoPath).replace(/\r\n/gu, "\n");
  };

  const apiRecords = parseAllowlist(allowlistText).map((entry) => enrichRecord({
    ...entry,
    kind: "api",
    virtualPath: virtualPathFor(entry),
    content: load(entry.repoPath),
  }));

  const guideRecords = (options.guides ?? []).map((repoPath) => enrichRecord({
    ...guideEntryFor(repoPath),
    kind: "guide",
    virtualPath: guideVirtualPathFor(repoPath),
    content: load(repoPath),
  }));

  const records = withUniqueAnchors([...apiRecords, ...guideRecords].sort(compareRecord));
  return { schemaVersion: MANIFEST_VERSION, generatedFrom: "docs/allowlist.txt + docs/topics", records };
}

export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function enrichRecord(record) {
  const { body, frontmatter } = parseFrontmatter(record.content);
  const topic = topicForRecord(record);
  const topicTitle = frontmatter.title ?? firstHeading(body) ?? titleFromSlug(topic);
  const anchor = headingAnchorForSymbol(body, record.symbol) ?? slugifyHeading(record.symbol);
  const section = sectionForAnchor(body, anchor) ?? body;

  return {
    ...record,
    summary: frontmatter.summary ?? firstParagraph(section) ?? firstParagraph(body) ?? "",
    snippet: firstCodeBlock(section) ?? firstCodeBlock(body) ?? "",
    anchor,
    topic,
    topicTitle,
    symbolKind: frontmatter.symbolKind ?? inferSymbolKind(record.symbol),
  };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) return { body: markdown, frontmatter: {} };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!item) continue;
    const [, key, rawValue] = item;
    frontmatter[key] = rawValue.trim().replace(/^['"]|['"]$/gu, "");
  }
  return { body: markdown.slice(match[0].length), frontmatter };
}

function topicForRecord(record) {
  return topicForRepoPath(record.repoPath);
}

function topicForRepoPath(repoPath) {
  const parts = repoPath.split("/");
  const file = parts.at(-1);
  if (file === "index.docs.md") return parts.at(-2);
  return file.replace(/\.docs\.md$/u, "");
}

function firstHeading(markdown) {
  return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim();
}

function titleFromSlug(slug) {
  return slug.split(/[-_]/u).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function headingAnchorForSymbol(markdown, symbol) {
  const symbolSlug = slugifyHeading(symbol);
  const entry = headingEntries(markdown).find((heading) => heading.text === symbol || slugifyHeading(heading.text) === symbolSlug);
  return entry?.anchor ?? null;
}

function sectionForAnchor(markdown, anchor) {
  const headings = headingEntries(markdown);
  const current = headings.find((heading) => heading.anchor === anchor);
  if (!current) return null;
  const next = headings.find((heading) => heading.index > current.index && heading.level <= current.level);
  return markdown.slice(current.index, next?.index ?? markdown.length);
}

function headingEntries(markdown) {
  const counts = new Map();
  return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gmu)].map((match) => {
    const baseAnchor = slugifyHeading(match[2]);
    const count = counts.get(baseAnchor) ?? 0;
    counts.set(baseAnchor, count + 1);
    return {
      level: match[1].length,
      text: match[2].trim(),
      index: match.index ?? 0,
      anchor: count === 0 ? baseAnchor : `${baseAnchor}-${count + 1}`,
    };
  });
}

function firstParagraph(markdown) {
  const withoutHeading = markdown.replace(/^#{1,6}\s+.+$/mu, "");
  for (const block of withoutHeading.split(/\n{2,}/u)) {
    const paragraph = block.trim();
    if (!paragraph) continue;
    if (/^(#{1,6}\s+|```|\||-|\*|>|<)/u.test(paragraph)) continue;
    return paragraph.replace(/\s+/gu, " ");
  }
  return null;
}

function firstCodeBlock(markdown) {
  const match = markdown.match(/```[^\n]*\n([\s\S]*?)```/u);
  return match?.[1]?.trim() ?? null;
}

function inferSymbolKind(symbol) {
  if (/Options$/u.test(symbol)) return "options";
  if (/^[a-z]/u.test(symbol)) return "function";
  if (/^(Gpu|Device|Buffer|Texture|Queue|EditableMesh)$/u.test(symbol)) return "class";
  return "type";
}

function withUniqueAnchors(records) {
  const seenByTopic = new Map();
  return records.map((record) => {
    const key = `${record.package}\0${record.repoPath}`;
    const seen = seenByTopic.get(key) ?? new Map();
    const count = seen.get(record.anchor) ?? 0;
    seen.set(record.anchor, count + 1);
    seenByTopic.set(key, seen);

    if (count === 0) return record;
    return { ...record, anchor: `${record.anchor}-${count + 1}` };
  });
}

export function slugifyHeading(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compareRecord(a, b) {
  return `${a.package}\0${a.symbol}\0${a.repoPath}`.localeCompare(`${b.package}\0${b.symbol}\0${b.repoPath}`);
}
