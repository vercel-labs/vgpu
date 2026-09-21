import { packageRank, uniqueByPath } from "../index.js";
import { fail, ok } from "./shared.js";

// Agents type prose, not identifiers: the dogfood experiment searched "wgsl import", "typescript
// wgsl", "next.js", "declare module". A single-substring match over symbol+path answered none of
// them, so find works in three widening steps: every whitespace token must match (1) the route
// text — symbol, title and the doc's declared keywords, (2) the doc paths, and only when both come
// back empty (3) the doc body, which is what makes error codes and prose phrases findable.
//
// Both tiers share one cap: "gpu" is a substring of "vgpu", so route text matched 134 lines and
// buried the exact `Gpu` match around line 100. Ranking by match quality is what makes the cap
// safe — capping alphabetical output would truncate the exact match away entirely.
const HIT_LIMIT = 20;

export function findCommand(index, args) {
  if (args.includes("--help") || args.includes("-h")) return ok("Usage: vgpu docs find <query>");
  if (args.length !== 1) return fail("Usage: vgpu docs find <query>");
  const found = findDocs(index, args[0]);
  if (found.results.length === 0) return fail(`No docs found for: ${args[0]}`);
  return ok(withNotice(found.results.map(formatFindResult), found.hiddenCount));
}

export function findDocs(index, query) {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return { results: [], truncated: false, hiddenCount: 0 };
  const phrase = tokens.join(" ");

  const matchesAll = (haystack) => tokens.every((token) => haystack.includes(token));
  const symbolHits = index.records
    .filter((record) => matchesAll(symbolText(record)))
    .map((record) => ({
      type: "symbol",
      record,
      line: `${record.symbol}\t${record.package}\t${record.virtualPath}`,
    }));
  const pathHits = uniqueByPath(index.records)
    .filter((record) => matchesAll(pathText(record)))
    .map((record) => ({ type: "path", record, line: pathLine(record) }));

  // Dedupe by line text, first hit wins — the same uniqueness the previous `new Set([...])` gave.
  const routeHitMap = new Map();
  for (const hit of [...symbolHits, ...pathHits]) if (!routeHitMap.has(hit.line)) routeHitMap.set(hit.line, hit);

  // INVARIANT (do not move this check): the routing gate is evaluated on the full, UNRANKED,
  // UNCAPPED, UNFILTERED hit set. Ranking and capping happen only inside this branch and never
  // remove a hit from consideration, they only reorder it or hide it behind the truncation notice.
  // If ranking ever filtered hits, a query whose only hits were dropped would silently fall
  // through to the body-search fallback (#258) — a routing-policy change, not a ranking fix.
  if (routeHitMap.size > 0) {
    const hits = [...routeHitMap.values()];
    const ranked = rankRouteHits(hits, tokens, phrase);
    const hiddenCount = Math.max(hits.length - HIT_LIMIT, 0);
    return {
      results: ranked.slice(0, HIT_LIMIT).map(resultFromHit),
      truncated: hiddenCount > 0,
      hiddenCount,
    };
  }

  const contentHits = uniqueByPath(index.records)
    .filter((record) => matchesAll(record.content.toLowerCase()))
    .map((record) => ({ type: "path", record, line: pathLine(record) }))
    .sort((left, right) => compareBytes(left.line, right.line));
  const hiddenCount = Math.max(contentHits.length - HIT_LIMIT, 0);
  return {
    results: contentHits.slice(0, HIT_LIMIT).map(resultFromHit),
    truncated: hiddenCount > 0,
    hiddenCount,
  };
}

function symbolText(record) {
  return `${record.symbol}\n${record.topicTitle ?? ""}\n${keywordText(record)}`.toLowerCase();
}

function pathText(record) {
  return `${record.virtualPath}\n${record.repoPath}\n${keywordText(record)}`.toLowerCase();
}

function keywordText(record) {
  return (record.keywords ?? []).join("\n");
}

function pathLine(record) {
  return `${record.virtualPath}\t${record.repoPath}`;
}

function resultFromHit(hit) {
  if (hit.type === "symbol") {
    return {
      kind: "symbol",
      symbol: hit.record.symbol,
      package: hit.record.package,
      virtualPath: hit.record.virtualPath,
    };
  }
  return { kind: "path", virtualPath: hit.record.virtualPath, repoPath: hit.record.repoPath };
}

function formatFindResult(result) {
  return result.kind === "symbol"
    ? `${result.symbol}\t${result.package}\t${result.virtualPath}`
    : `${result.virtualPath}\t${result.repoPath}`;
}

// Order (never filter) the route hits so the best match is the line an agent reads first. Ties break
// on the shared package curation ladder, then page lines before their symbol lines, then a
// byte-stable line compare — never localeCompare, whose ICU tables make output Node-build dependent.
function rankRouteHits(hits, tokens, phrase) {
  return hits
    .map((hit) => ({ ...hit, tier: tierOf(hit, tokens, phrase) }))
    .sort((left, right) =>
      left.tier - right.tier ||
      packageRank(left.record.package) - packageRank(right.record.package) ||
      typeOrder(left) - typeOrder(right) ||
      compareBytes(left.line, right.line));
}

function typeOrder(hit) {
  return hit.type === "path" ? 0 : 1;
}

function compareBytes(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Tiers 1-6 from the design: exact symbol, exact page identity, word-boundary in name text,
// word-boundary in path, substring in name text, substring in path only. Tiers 5/6 need no
// substring re-check: a symbol hit only exists because it passed matchesAll(symbolText(record)),
// and a path hit only because it passed matchesAll(pathText(record)).
function tierOf(hit, tokens, phrase) {
  if (hit.type === "symbol" && hit.record.symbol.toLowerCase() === phrase) return 1;
  if (isExactPageIdentity(hit.record, phrase)) return 2;
  if (everyTokenWordMatches(tokens, nameWords(hit.record))) return 3;
  if (everyTokenWordMatches(tokens, pathWords(hit.record))) return 4;
  return hit.type === "symbol" ? 5 : 6;
}

function isExactPageIdentity(record, phrase) {
  if ((record.keywords ?? []).some((keyword) => keyword.toLowerCase() === phrase)) return true;
  if ((record.topicTitle ?? "").toLowerCase() === phrase) return true;
  if ((record.topic ?? "").toLowerCase() === phrase) return true;
  return pageBasename(record.virtualPath) === phrase;
}

function pageBasename(virtualPath) {
  const segment = (virtualPath ?? "").split("/").pop() ?? "";
  return segment.replace(/\.docs\.md$/u, "").toLowerCase();
}

// "whole word or word-prefix" is one startsWith check: a word trivially starts with itself.
function everyTokenWordMatches(tokens, words) {
  return tokens.every((token) => words.some((word) => word.startsWith(token)));
}

function nameWords(record) {
  return words(`${record.symbol} ${record.topicTitle ?? ""} ${(record.keywords ?? []).join(" ")}`);
}

function pathWords(record) {
  return words(`${record.virtualPath} ${record.repoPath}`);
}

// Split on non-alphanumerics, then on camelCase boundaries, so "WebGPU" yields ["web", "gpu"] and
// "createNodeAdapter" yields ["create", "node", "adapter"].
function words(text) {
  return (text ?? "")
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .flatMap((chunk) => chunk.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/gu) ?? [chunk])
    .map((word) => word.toLowerCase());
}

// Truncation is never silent: an agent must be able to tell 20-of-20 from 20-of-200. Stdout, exit 0,
// and deliberately free of tabs so the notice can never be parsed as one of the result lines.
function withNotice(lines, hiddenCount) {
  if (hiddenCount <= 0) return lines;
  const plural = hiddenCount === 1 ? "" : "es";
  return [...lines, `... and ${hiddenCount} more match${plural}; showing the ${HIT_LIMIT} best. Add another word to narrow.`];
}
