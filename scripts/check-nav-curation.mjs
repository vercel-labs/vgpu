#!/usr/bin/env node
/**
 * Curation snapshot for `docs/nav.json` — TGEIST-12, closing the HIGH finding of
 * the #276 review.
 *
 * `check-nav-coverage.mjs` (TGEIST-03) proves the two directions that matter for
 * *completeness*: every emitted page is reachable from the nav, and every literal
 * nav entry resolves to a real record. What it structurally cannot see is a
 * **deletion**: `packageOrder`, every `topicOrder[pkg]` and `guideGroups` all end
 * in an explicit `"..."` catch-all (by design — new pages must not need a nav
 * edit to appear), and a catch-all absorbs whatever you remove. Drop
 * `"performance-playbook"` from its group and coverage stays green: the page is
 * still reachable, just no longer curated, silently demoted to alphabetical
 * fallback at the bottom of the sidebar. Same for reordering, and same for an
 * entire `sections` item disappearing.
 *
 * So the curation itself is snapshotted here: the ordered literals of every level
 * that a human deliberately arranged. Any change — removal, insertion, reorder,
 * retitle — fails until `docs/nav-curation.snapshot.json` is regenerated in the
 * same PR, which is exactly the review this file exists to force. The snapshot is
 * a *projection*, not a copy of `nav.json`: only the curated sequences, so the
 * diff a reviewer reads is the curation change and nothing else.
 *
 * Usage:
 *   node scripts/check-nav-curation.mjs           # verify (CI)
 *   node scripts/check-nav-curation.mjs --write   # re-record, then review the diff
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const navPath = join(repoRoot, 'docs/nav.json');
const snapshotPath = join(repoRoot, 'docs/nav-curation.snapshot.json');

const CATCH_ALL = '...';

function isCatchAll(entry) {
  return (
    entry === CATCH_ALL ||
    (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, CATCH_ALL))
  );
}

/** Ordered entries of a curated array, with catch-alls kept as a literal marker
 *  (their *position* is curation too: `["a", "...", "b"]` is not `["a", "b", "..."]`). */
function curatedSequence(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => (isCatchAll(entry) ? CATCH_ALL : entry));
}

/** `sections` flattened to `Section > Group > Item` labels + hrefs, in order. */
function flattenSections(sections) {
  const flat = [];
  for (const section of sections ?? []) {
    if (isCatchAll(section)) {
      flat.push(CATCH_ALL);
      continue;
    }
    flat.push(`${section.title ?? ''} @ ${section.href ?? ''}`);
    for (const group of section.groups ?? []) {
      if (isCatchAll(group)) {
        flat.push(`  ${CATCH_ALL}`);
        continue;
      }
      flat.push(`  ${group.title ?? ''}`);
      for (const item of group.items ?? []) {
        if (isCatchAll(item)) {
          flat.push(`    ${CATCH_ALL}`);
          continue;
        }
        flat.push(`    ${item.title ?? ''} @ ${item.href ?? ''}`);
      }
    }
  }
  return flat;
}

function project(nav) {
  return {
    packageOrder: curatedSequence(nav.packageOrder),
    topicOrder: Object.fromEntries(
      Object.entries(nav.topicOrder ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pkg, order]) => [pkg, curatedSequence(order)]),
    ),
    guideGroups: curatedSequence(nav.guideGroups).map((group) =>
      group === CATCH_ALL ? CATCH_ALL : { title: group.title ?? '', slugs: curatedSequence(group.slugs) },
    ),
    sections: flattenSections(nav.sections),
  };
}

/** Line-level diff of the two projections, so the failure names the entry. */
function diffLines(expected, actual) {
  const expectedLines = JSON.stringify(expected, null, 2).split('\n');
  const actualLines = JSON.stringify(actual, null, 2).split('\n');
  const removed = expectedLines.filter((line) => !actualLines.includes(line));
  const added = actualLines.filter((line) => !expectedLines.includes(line));
  return { removed, added };
}

function main() {
  const write = process.argv.includes('--write');
  const nav = JSON.parse(readFileSync(navPath, 'utf8'));
  const projection = project(nav);

  if (write) {
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          $comment:
            'Curation snapshot of docs/nav.json (ordered literals only), enforced by ' +
            'scripts/check-nav-curation.mjs. It exists because every curated level ends in a "..." ' +
            'catch-all, so removing or reordering an entry keeps check-nav-coverage.mjs green while ' +
            'silently demoting the page to the alphabetical fallback. Regenerate with ' +
            '`node scripts/check-nav-curation.mjs --write` and review the diff — that review is the point.',
          curation: projection,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote the nav curation snapshot to ${snapshotPath}`);
    return;
  }

  if (!existsSync(snapshotPath)) {
    console.error(
      `✗ nav curation snapshot missing: ${snapshotPath}\n  Create it with \`node scripts/check-nav-curation.mjs --write\`.`,
    );
    process.exit(1);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')).curation;
  if (JSON.stringify(snapshot) === JSON.stringify(projection)) {
    const curatedCount =
      projection.packageOrder.length +
      Object.values(projection.topicOrder).reduce((sum, order) => sum + order.length, 0) +
      projection.guideGroups.reduce((sum, group) => sum + (group === CATCH_ALL ? 1 : group.slugs.length), 0) +
      projection.sections.length;
    console.log(`docs/nav.json curation matches its snapshot — ${curatedCount} curated entries, order included.`);
    return;
  }

  const { removed, added } = diffLines(snapshot, projection);
  console.error(
    '✗ docs/nav.json curation changed. This is not automatically wrong — it is unreviewable by\n' +
      '  accident, which is why it stops here. `check-nav-coverage.mjs` cannot see any of this: the\n' +
      '  "..." catch-alls absorb whatever is removed, so a dropped entry stays "covered" while it\n' +
      '  silently loses its curated position in the sidebar.\n',
  );
  if (removed.length > 0) {
    console.error('  no longer in docs/nav.json:');
    for (const line of removed) console.error(`    - ${line.trim()}`);
  }
  if (added.length > 0) {
    console.error('  new in docs/nav.json:');
    for (const line of added) console.error(`    + ${line.trim()}`);
  }
  console.error(
    '\n  If the change is intended: `node scripts/check-nav-curation.mjs --write` and commit the\n  snapshot alongside the nav edit.',
  );
  process.exit(1);
}

main();
