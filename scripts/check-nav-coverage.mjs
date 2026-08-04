#!/usr/bin/env node
/**
 * TGEIST-03 — bidirectional coverage gate between docs/nav.json and the docs manifest.
 *
 * Asserts:
 *  (a) every page emitted by the manifest is reachable from docs/nav.json — either
 *      listed explicitly, or absorbed by an explicit "..." catch-all at the
 *      corresponding level (packageOrder, a topicOrder[pkg] array, or guideGroups).
 *  (b) every literal entry in docs/nav.json (not a "..." catch-all) resolves to a
 *      real record in the manifest — catches stale/renamed slugs before they rot.
 *
 * Scope, matching the manifest.ts/nav.ts curation this ticket extracted:
 *  - API records (kind: "api"): packageOrder + topicOrder.
 *  - Guide records without a `websitePath` (kind: "guide", the ones rendered at
 *    /guides/<symbol>): guideGroups.
 *  - Guide records WITH a `websitePath` (kind: "guide", rendered at a fixed route
 *    like /cli or /ml/browser via getDocsRecordByWebsitePath): the literal href
 *    strings under docs/nav.json's "sections" tree.
 *
 * Deliberately out of scope (see docs/nav.json comments in the PR description):
 *  - "sections" entries for Get started / Concepts / Examples / API Reference are
 *    either literal, hand-authored routes with no manifest-record backing (Get
 *    started, Concepts titles) or fully generated from packageOrder/topicOrder
 *    (API Reference) / docs/../examples-metadata (Examples) — marked "groups": "..."
 *    where nothing is separately curated here.
 *  - Full URL/anchor link-checking is TGEIST-12's job (docs/url-inventory.json).
 *
 * Import note: this mirrors apps/docs/lib/manifest.ts's `docsManifest` import, but
 * resolves the generated file by relative path instead of the "@vgpu/cli" package
 * specifier, so this script stays dependency-free (no `pnpm install` required) and
 * can run in the same `docs-generated` CI job as check-drift.js, which already
 * follows this convention.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const manifestPath = join(repoRoot, 'packages/vgpu/lib/generated/docs-manifest.generated.js');
const navPath = join(repoRoot, 'docs/nav.json');

const errors = [];

function fail(message) {
  errors.push(message);
}

// Mirrors apps/docs/lib/manifest.ts's referencePackageName() — kept in sync manually
// since that file is off-limits for this ticket (read-only, not consumed here).
function referencePackageName(pkg) {
  if (pkg === 'vgpu' || pkg === 'vgpu/core' || pkg === 'vgpu/scene') return pkg;
  if (pkg.startsWith('@vgpu/wgsl-std')) return '@vgpu/wgsl-std';
  if (pkg.startsWith('@vgpu/wgsl')) return '@vgpu/wgsl';
  if (pkg.startsWith('@vgpu/render')) return '@vgpu/render';
  return pkg;
}

function isCatchAll(entry) {
  return entry === '...' || (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, '...'));
}

function collectHrefs(node, into) {
  if (node === undefined || node === null || isCatchAll(node)) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHrefs(item, into);
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.href === 'string') into.add(node.href);
    for (const value of Object.values(node)) collectHrefs(value, into);
  }
}

async function main() {
  const { docsManifest } = await import(pathToFileURL(manifestPath).href);
  const nav = JSON.parse(readFileSync(navPath, 'utf8'));

  const records = docsManifest.records;
  const apiRecords = records.filter((r) => r.kind === 'api');
  const guideRecords = records.filter((r) => r.kind === 'guide' && r.websitePath === undefined);
  const websiteGuideRecords = records.filter((r) => r.kind === 'guide' && r.websitePath !== undefined);

  // --- packageOrder ---------------------------------------------------------
  const packagesInManifest = new Set(apiRecords.map((r) => referencePackageName(r.package)));
  const packageOrder = nav.packageOrder ?? [];
  const packageLiterals = packageOrder.filter((e) => !isCatchAll(e));
  const packageHasCatchAll = packageOrder.some(isCatchAll);

  const packagesNotListed = [...packagesInManifest].filter((p) => !packageLiterals.includes(p));
  if (packagesNotListed.length > 0 && !packageHasCatchAll) {
    fail(`packageOrder: manifest has packages not listed and no "..." catch-all: ${packagesNotListed.join(', ')}`);
  }
  const staleePackageEntries = packageLiterals.filter((p) => !packagesInManifest.has(p));
  if (staleePackageEntries.length > 0) {
    fail(`packageOrder: entries do not resolve to any package in the manifest: ${staleePackageEntries.join(', ')}`);
  }

  // --- topicOrder ------------------------------------------------------------
  const topicOrder = nav.topicOrder ?? {};
  for (const [pkg, order] of Object.entries(topicOrder)) {
    const topicsForPkg = new Set(
      apiRecords.filter((r) => referencePackageName(r.package) === pkg).map((r) => r.topic),
    );
    if (topicsForPkg.size === 0) {
      fail(`topicOrder["${pkg}"]: no API records reference this package (stale key?)`);
      continue;
    }
    const literals = order.filter((e) => !isCatchAll(e));
    const hasCatchAll = order.some(isCatchAll);
    const missing = [...topicsForPkg].filter((t) => !literals.includes(t));
    if (missing.length > 0 && !hasCatchAll) {
      fail(`topicOrder["${pkg}"]: manifest has topics not listed and no "..." catch-all: ${missing.join(', ')}`);
    }
    const stale = literals.filter((t) => !topicsForPkg.has(t));
    if (stale.length > 0) {
      fail(`topicOrder["${pkg}"]: entries do not resolve to any topic in the manifest: ${stale.join(', ')}`);
    }
  }

  // --- guideGroups (guides without a websitePath) -----------------------------
  const guideSymbolsInManifest = new Set(guideRecords.map((r) => r.symbol));
  const guideGroups = nav.guideGroups ?? [];
  const guideHasCatchAll = guideGroups.some(isCatchAll);
  const listedSlugs = guideGroups.filter((g) => !isCatchAll(g)).flatMap((g) => g.slugs ?? []);

  const staleSlugs = listedSlugs.filter((slug) => !guideSymbolsInManifest.has(slug));
  if (staleSlugs.length > 0) {
    fail(`guideGroups: slugs do not resolve to any guide record in the manifest: ${staleSlugs.join(', ')}`);
  }
  const uncoveredGuides = [...guideSymbolsInManifest].filter((symbol) => !listedSlugs.includes(symbol));
  if (uncoveredGuides.length > 0 && !guideHasCatchAll) {
    fail(`guideGroups: guide records not listed and no "..." catch-all present: ${uncoveredGuides.join(', ')}`);
  }

  // --- sections (guides WITH a websitePath: /cli, /ml, /ml/browser, ...) ------
  const hrefsInSections = new Set();
  collectHrefs(nav.sections ?? [], hrefsInSections);

  const websitePaths = new Set(websiteGuideRecords.map((r) => r.websitePath));
  const websitePathsNotFound = [...websitePaths].filter((p) => !hrefsInSections.has(p));
  if (websitePathsNotFound.length > 0) {
    fail(`sections: websitePath-backed guide records missing from the nav href tree: ${websitePathsNotFound.join(', ')}`);
  }
  // Reverse-check only inside the two websitePath-owned namespaces (/cli, /ml*) —
  // other hrefs (Get started, Concepts, Examples) are literal routes with no
  // manifest-record backing by design and are out of scope (see file header).
  const websitePathLikeHrefs = [...hrefsInSections].filter((href) => /^\/(cli|ml)(\/|$)/.test(href));
  const staleWebsitePathHrefs = websitePathLikeHrefs.filter((href) => !websitePaths.has(href));
  if (staleWebsitePathHrefs.length > 0) {
    fail(`sections: /cli or /ml* hrefs do not resolve to any websitePath in the manifest: ${staleWebsitePathHrefs.join(', ')}`);
  }

  if (errors.length > 0) {
    console.error('docs/nav.json coverage check FAILED:\n');
    for (const message of errors) console.error(`  - ${message}`);
    console.error(`\n${errors.length} error(s).`);
    process.exit(1);
  }

  console.log(
    `docs/nav.json coverage OK — ${apiRecords.length} api records, ${guideRecords.length} guide records, ${websiteGuideRecords.length} websitePath records.`,
  );
}

main().catch((error) => {
  console.error('docs/nav.json coverage check crashed:', error);
  process.exit(1);
});
