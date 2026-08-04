#!/usr/bin/env node
/**
 * G2 of the geistdocs migration (Decision 1', TGEIST-06): the examples API in this app must stay a
 * BYTE-IDENTICAL copy of the one in `apps/docs`, for the whole dual-run window.
 *
 * The migration's promise to the CLIs in production is "the examples API does not change". That
 * promise is only worth something if a machine checks it, because the two trees are edited by
 * different tickets over weeks and nothing else would notice a one-character drift: both apps would
 * still build, both test suites would still pass, and the difference would only show up as a
 * changed `revision` (or a changed artifact byte) served to already-published CLI versions.
 *
 * So this is a `diff -r` over the group A inventory, in both directions, with:
 *
 *   - NO allowlist. Not "no allowlist yet" -- there is no mechanism to add one. A file that is
 *     legitimately allowed to differ is by definition not group A and must be removed from
 *     GROUP_A below (which is a deliberate, reviewable change to the invariant itself).
 *   - extra and missing files failing exactly like differing bytes, so neither adding a file to one
 *     tree nor deleting it from the other can slip through.
 *
 * Deleted at cutover (TGEIST-15/16), when the old tree stops existing and there is nothing to
 * compare against: the copy becomes the original.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const newApp = resolve(import.meta.dirname, '..');
const repoRoot = resolve(newApp, '../..');
const oldApp = resolve(repoRoot, 'apps/docs');

// The group A inventory, as app-relative paths. Directories are compared recursively.
const GROUP_A = [
  'app/.well-known/vgpu-examples.json/route.ts',
  'app/api/examples',
  'lib/examples-api',
  'lib/examples-source.generated.ts',
  // Not group A in the inventory (it is group C, owned by TGEIST-07), but the group A identity
  // anchor `lib/examples-source.generated.ts` type-imports `ExampleSlug` from it, so the new app
  // cannot type-check without it and the transplant cannot be split any finer than this. It is a
  // 29-line self-contained leaf with no imports of its own, copied byte-identically here for the
  // same reason as everything else: the file arriving from TGEIST-07 must have identical bytes, and
  // listing it here is what guarantees the two copies can never diverge.
  'lib/example-slugs.ts',
  'lib/server-only-stub.ts',
  'generated/examples-api',
  'scripts/check-examples-api-tracing.mjs',
  'scripts/validate-example-vocabulary.mjs',
  'scripts/validate-example-vocabulary.test.ts',
  'scripts/generate-examples-api.mjs',
  'scripts/sync-examples-api-contracts.mjs',
];

/** Every file under `entry` (or `entry` itself when it is a file), as paths relative to `appRoot`. */
async function collect(appRoot, entry) {
  const absolute = resolve(appRoot, entry);
  let entryStat;
  try {
    entryStat = await stat(absolute);
  } catch {
    return undefined;
  }
  if (!entryStat.isDirectory()) return [relative(appRoot, absolute).split(sep).join('/')];
  const found = [];
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isDirectory()) await walk(path);
      else found.push(relative(appRoot, path).split(sep).join('/'));
    }
  };
  await walk(absolute);
  return found.sort();
}

const problems = [];
let compared = 0;

for (const entry of GROUP_A) {
  const [oldFiles, newFiles] = await Promise.all([collect(oldApp, entry), collect(newApp, entry)]);
  if (oldFiles === undefined) {
    problems.push(`missing in apps/docs: ${entry} (group A entry does not exist in the app it is copied from)`);
    continue;
  }
  if (newFiles === undefined) {
    problems.push(`missing in apps/docs-next: ${entry} (group A entry was never transplanted or was deleted)`);
    continue;
  }
  const oldSet = new Set(oldFiles);
  const newSet = new Set(newFiles);
  for (const file of oldFiles) {
    if (!newSet.has(file)) problems.push(`missing in apps/docs-next: ${file}`);
  }
  for (const file of newFiles) {
    if (!oldSet.has(file)) problems.push(`extra in apps/docs-next (not present in apps/docs): ${file}`);
  }
  for (const file of oldFiles) {
    if (!newSet.has(file)) continue;
    const [oldBytes, newBytes] = await Promise.all([
      readFile(resolve(oldApp, file)),
      readFile(resolve(newApp, file)),
    ]);
    compared += 1;
    if (!oldBytes.equals(newBytes)) {
      problems.push(
        `differs: ${file} (apps/docs ${oldBytes.byteLength} bytes vs apps/docs-next ${newBytes.byteLength} bytes)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    `::error::The examples API transplant is no longer byte-identical: ${problems.length} problem(s). ` +
      'Group A must be copied verbatim between apps/docs and apps/docs-next -- fix the copy, do not ' +
      'add an exception (there is no allowlist by design; see Decision 1\' G2).',
  );
  for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  process.exit(1);
}

console.log(`${compared} group A files are byte-identical between apps/docs and apps/docs-next.`);
