#!/usr/bin/env node
/**
 * TGEIST-02 — Freeze docs/url-inventory.json from the OLD site, in PROD, before
 * anything moves to geistdocs.
 *
 * This is the "day 0" script of the vgpu -> geistdocs migration: it snapshots
 * every URL currently served under /docs (plus every heading `id=` anchor on
 * each page) so that the gate added in TGEIST-12 (Decision 4, item d) can later
 * assert that the NEW tree (apps/docs-next / geistdocs) reproduces every one of
 * them. Once the old site is decommissioned this inventory can never be
 * regenerated, so it must run against the real production deployment, not the
 * local checkout.
 *
 * Route derivation intentionally mirrors (does not import) the logic in
 * apps/docs/lib/manifest.ts (`referencePackageName`, `slugifyPackage`,
 * `buildReferenceTopics`, `apiRecords`/`guideRecords` filters) and
 * apps/docs/lib/nav.ts (`docsHref`, the get-started/concepts static slugs) —
 * see TGEIST-02-url-inventory.md, "Fuente de la lista de rutas". Those files
 * live under apps/docs/**, which this ticket is not allowed to touch or
 * import, so the grouping rules are reimplemented here against the same
 * generated manifest they both read from.
 *
 * Usage:
 *   VGPU_DOCS_PROD_URL=https://vgpu.sh node scripts/freeze-docs-url-inventory.mjs
 *
 * Env vars:
 *   VGPU_DOCS_PROD_URL   (required) base URL of the OLD site's production deployment.
 *   VGPU_DOCS_GIT_SHA    (optional) override for the recorded gitSha (defaults to `git rev-parse origin/main`).
 *   VGPU_DOCS_CONCURRENCY (optional) parallel requests, default 6.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const PROD_URL = process.env.VGPU_DOCS_PROD_URL;
if (!PROD_URL) {
  console.error(
    'freeze-docs-url-inventory: missing VGPU_DOCS_PROD_URL.\n' +
      'This script must hit the real production deployment of the OLD docs site, never the local checkout.\n' +
      'Example: VGPU_DOCS_PROD_URL=https://vgpu.sh node scripts/freeze-docs-url-inventory.mjs',
  );
  process.exit(1);
}

const PROD_ORIGIN = PROD_URL.replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.VGPU_DOCS_CONCURRENCY ?? 6);
const OUT_PATH = join(REPO_ROOT, 'docs', 'url-inventory.json');
const MANIFEST_PATH = join(REPO_ROOT, 'packages', 'vgpu', 'lib', 'generated', 'docs-manifest.generated.js');

// ---------------------------------------------------------------------------
// 1. Route derivation — mirrors apps/docs/lib/manifest.ts + lib/nav.ts.
// ---------------------------------------------------------------------------

function referencePackageName(record) {
  if (record.package === 'vgpu' || record.package === 'vgpu/core' || record.package === 'vgpu/scene') return record.package;
  if (record.package.startsWith('@vgpu/wgsl-std')) return '@vgpu/wgsl-std';
  if (record.package.startsWith('@vgpu/wgsl')) return '@vgpu/wgsl';
  if (record.package.startsWith('@vgpu/render')) return '@vgpu/render';
  return record.package;
}

function slugifyPackage(packageName) {
  if (packageName === 'guides') return 'guides';
  if (packageName === '@vgpu/wgsl') return 'wgsl';
  if (packageName === '@vgpu/wgsl-std') return 'wgsl-std';
  if (packageName === '@vgpu/render') return 'render';
  return packageName.replace(/^@/, '').replace(/[/@]/g, '-');
}

// Static routes that are NOT derivable from docsManifest.records at all
// (get-started and concepts are authored directly under apps/docs/content /
// apps/docs/lib/concepts.ts) plus the two section index pages defined only
// in apps/docs/lib/nav.ts (`navSections` entries for 'Guides' / 'API
// Reference', hrefs '/guides' and '/reference' -> docsHref() prefixes them
// with /docs). Enumerated explicitly per TGEIST-02, "Pasos" 2(a).
//
// NOTE: the CLI page and the /ml/* pages are intentionally NOT here — they
// are guide records with a `websitePath` override (see buildRoutes()) and
// must come from that mechanical derivation, not be hardcoded here, or this
// list silently drifts every time a new websitePath guide is added.
const STATIC_ROUTES = [
  { path: '/docs', kind: 'static' },
  { path: '/docs/get-started', kind: 'static' },
  { path: '/docs/get-started/agents', kind: 'static' },
  { path: '/docs/get-started/web', kind: 'static' },
  { path: '/docs/get-started/node', kind: 'static' },
  { path: '/docs/concepts', kind: 'static' },
  { path: '/docs/concepts/context', kind: 'static' },
  { path: '/docs/concepts/draws', kind: 'static' },
  { path: '/docs/concepts/compilation', kind: 'static' },
  { path: '/docs/concepts/effects', kind: 'static' },
  { path: '/docs/concepts/passes', kind: 'static' },
  { path: '/docs/concepts/frames', kind: 'static' },
  { path: '/docs/concepts/render-bundles', kind: 'static' },
  // Section index pages (apps/docs/lib/nav.ts navSections: 'Guides' href
  // '/guides', 'API Reference' href '/reference' -> docsHref() -> /docs/*).
  { path: '/docs/guides', kind: 'static' },
  { path: '/docs/reference', kind: 'static' },
];

async function buildRoutes() {
  const { docsManifest } = await import(MANIFEST_PATH);
  const records = docsManifest.records;

  const apiRecords = records.filter((r) => r.kind === 'api');
  // Guide records that render at their own /docs/guides/<symbol> page.
  const guideRecords = records.filter((r) => r.kind === 'guide' && r.websitePath === undefined);
  // Guide records that override their URL via `websitePath` (cli, ml, ml/browser,
  // ml/node, ml/buffers) — derived MECHANICALLY from the manifest, not
  // hardcoded, so a future websitePath guide can't silently fall out of the
  // inventory the way /docs/ml/* did.
  const websitePathGuideRecords = records.filter((r) => r.kind === 'guide' && r.websitePath !== undefined);

  // Group API records into topic pages exactly like buildReferenceTopics().
  const topicsByKey = new Map();
  for (const record of apiRecords) {
    const packageName = referencePackageName(record);
    const key = `${packageName}\u0000${record.topic}`;
    if (!topicsByKey.has(key)) {
      topicsByKey.set(key, { packageName, topic: record.topic, records: [] });
    }
    topicsByKey.get(key).records.push(record);
  }

  const apiTopicPages = Array.from(topicsByKey.values()).map((entry) => ({
    path: `/docs/reference/${slugifyPackage(entry.packageName)}/${encodeURIComponent(entry.topic)}`,
    kind: 'api-topic',
    expectedAnchors: entry.records.map((r) => r.anchor),
  }));

  const guidePages = guideRecords.map((record) => ({
    path: `/docs/guides/${encodeURIComponent(record.symbol)}`,
    kind: 'guide',
    expectedAnchors: [],
  }));

  // Mechanical derivation, not a hardcoded list: whatever websitePath says is
  // where the record lives, that's the route we freeze. Prefixed with /docs
  // the same way docsHref() does for every non-/examples route in lib/nav.ts.
  const websitePathPages = websitePathGuideRecords.map((record) => ({
    path: `/docs${record.websitePath}`,
    kind: 'website-path',
    expectedAnchors: [],
  }));

  const staticPages = STATIC_ROUTES.map((route) => ({ ...route, expectedAnchors: [] }));

  return [...staticPages, ...apiTopicPages, ...guidePages, ...websitePathPages].sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// 2. HTTP fetch with backoff for Vercel's transient anti-bot mitigation.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, { maxAttempts = 6, baseDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const mitigated = res.headers.get('x-vercel-mitigated');
      if (res.status === 403 && mitigated) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[retry ${attempt}/${maxAttempts}] 403 x-vercel-mitigated="${mitigated}" on ${url} — backing off ${delay}ms (transient anti-bot, not a real outage)`,
        );
        if (attempt === maxAttempts) return res;
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry ${attempt}/${maxAttempts}] fetch error on ${url}: ${err.message} — retrying in ${delay}ms`);
      if (attempt === maxAttempts) throw lastError;
      await sleep(delay);
    }
  }
  throw lastError ?? new Error(`Exhausted retries for ${url}`);
}

// ---------------------------------------------------------------------------
// 3. Minimal, dependency-free heading-anchor extraction.
//    Geistdocs/fumadocs headings are always well-formed `<hN id="...">` tags
//    emitted by Next.js's own renderer (no user-controlled markup), so a
//    tag-then-attribute regex pass is reliable here without pulling in an
//    HTML parser dependency the repo doesn't already have.
// ---------------------------------------------------------------------------

function extractHeadingAnchors(html) {
  const anchors = [];
  const seen = new Set();
  const headingTagRe = /<h[1-6]\b([^>]*)>/gi;
  let match;
  while ((match = headingTagRe.exec(html))) {
    const idMatch = match[1].match(/\bid=["']([^"']+)["']/i);
    if (idMatch && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);
      anchors.push(idMatch[1]);
    }
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// 4. Bounded-concurrency map.
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// 5. Main.
// ---------------------------------------------------------------------------

async function main() {
  const routes = await buildRoutes();
  console.log(
    `freeze-docs-url-inventory: ${routes.length} routes to freeze from ${PROD_ORIGIN} ` +
      `(${routes.filter((r) => r.kind === 'static').length} static, ` +
      `${routes.filter((r) => r.kind === 'api-topic').length} api-topic, ` +
      `${routes.filter((r) => r.kind === 'guide').length} guide)`,
  );

  let anchorMismatchCount = 0;

  const pages = await mapWithConcurrency(routes, CONCURRENCY, async (route) => {
    const url = `${PROD_ORIGIN}${route.path}`;
    const res = await fetchWithRetry(url);
    const html = res.status === 200 ? await res.text() : '';
    const anchors = html ? extractHeadingAnchors(html) : [];

    if (route.kind === 'api-topic' && route.expectedAnchors.length > 0) {
      const anchorSet = new Set(anchors);
      const missing = route.expectedAnchors.filter((expected) => !anchorSet.has(expected));
      if (missing.length > 0) {
        anchorMismatchCount += missing.length;
        console.warn(`[anchor-mismatch] ${route.path}: manifest expects ${JSON.stringify(missing)}, HTML has ${JSON.stringify(anchors)}`);
      }
    }

    console.log(`  ${res.status} ${route.path} (${anchors.length} anchors)`);
    return { path: route.path, status: res.status, anchors };
  });

  pages.sort((a, b) => a.path.localeCompare(b.path));

  const gitSha = process.env.VGPU_DOCS_GIT_SHA ?? execSync('git rev-parse origin/main', { cwd: REPO_ROOT }).toString().trim();

  const inventory = {
    frozenAt: new Date().toISOString(),
    sourceUrl: PROD_ORIGIN,
    gitSha,
    pages,
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');

  const nonOk = pages.filter((p) => p.status !== 200);
  const totalAnchors = pages.reduce((sum, p) => sum + p.anchors.length, 0);

  console.log('---');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`pages: ${pages.length}, non-200: ${nonOk.length}, total anchors: ${totalAnchors}, anchor mismatches vs manifest: ${anchorMismatchCount}`);
  if (nonOk.length > 0) {
    console.warn('Non-200 responses:', nonOk.map((p) => `${p.path} -> ${p.status}`).join(', '));
  }
  if (anchorMismatchCount > 0) {
    // Informational only: this is exactly the github-slugger-vs-slugifyHeading
    // drift the gate in TGEIST-12 (Decision 4, item d) exists to catch later —
    // it does not mean this freeze run failed, so it must not fail CI/exit non-zero.
    console.warn(
      `${anchorMismatchCount} anchor(s) computed by the manifest (record.anchor) were not found as a real heading id= on their page — see [anchor-mismatch] lines above. This is expected pre-existing drift, not a freeze error.`,
    );
  }

  // Only a real fetch failure or a non-200 response on a route we expected to
  // be live should fail this script — anchor mismatches are diagnostic, not fatal.
  if (nonOk.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
