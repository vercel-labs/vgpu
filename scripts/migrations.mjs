#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseChangeset, renderMigration, renderMigrationIndex, stableVersion } from "./lib/migrations.mjs";

export function pendingSources(root) {
  return Object.fromEntries(readdirSync(join(root, ".changeset")).filter(file => file.endsWith(".md") && file !== "README.md").sort().map(file => [file.slice(0, -3), readFileSync(join(root, ".changeset", file), "utf8")]));
}

export function validateSources(sources) {
  return Object.entries(sources).map(([id, source]) => parseChangeset(source, id));
}

export function syncMigration(root, releaseVersion, sources) {
  const version = stableVersion(releaseVersion);
  validateSources(sources);
  const directory = join(root, "docs/migrations");
  const recordPath = join(directory, "records", `${version}.json`);
  const existing = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : { schemaVersion: 1, version, sources: {} };
  if (existing.schemaVersion !== 1 || existing.version !== version) throw new Error(`Invalid migration record: ${recordPath}`);
  if (existing.preparedVersion === version && Object.entries(sources).some(([id, source]) => existing.sources[id] !== source)) {
    throw new Error(`Migration ${version} is finalized; collect new or changed fragments into the next release instead.`);
  }
  // Retain sources consumed by Changesets at stable release; upsert by ID throughout the RC cycle.
  const merged = Object.fromEntries(Object.entries({ ...existing.sources, ...sources }).sort(([a], [b]) => a.localeCompare(b, "en")));
  const record = { schemaVersion: 1, version, preparedVersion: releaseVersion, sources: merged };
  const markdown = renderMigration({ version, fragments: validateSources(merged) });
  mkdirSync(join(directory, "records"), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(directory, `${version}.docs.md`), markdown);
  writeFileSync(join(directory, "index.docs.md"), renderMigrationIndex(readdirSync(join(directory, "records")).filter(file => file.endsWith(".json")).map(file => stableVersion(file.slice(0, -5)))));
}

export function checkMigrations(root, { release = false } = {}) {
  const pending = pendingSources(root);
  validateSources(pending);
  const prePath = join(root, ".changeset/pre.json");
  if (existsSync(prePath)) {
    const pre = JSON.parse(readFileSync(prePath, "utf8"));
    if (pre.mode === "pre") for (const id of pre.changesets ?? []) {
      if (!Object.hasOwn(pending, id)) throw new Error(`RC changeset ${id} was removed or renamed; keep its ID and source until Changesets consumes it at stable release.`);
    }
  }
  const directory = join(root, "docs/migrations");
  const recordDir = join(directory, "records");
  const records = existsSync(recordDir) ? readdirSync(recordDir).filter(file => file.endsWith(".json")).sort() : [];
  const known = new Set();
  for (const file of records) {
    const record = JSON.parse(readFileSync(join(recordDir, file), "utf8"));
    if (record.schemaVersion !== 1 || file !== `${stableVersion(record.version)}.json` || record.version !== stableVersion(record.version)) throw new Error(`Invalid migration record: ${file}`);
    const expected = renderMigration({ version: record.version, fragments: validateSources(record.sources) });
    const path = join(directory, `${record.version}.docs.md`);
    if (!existsSync(path) || readFileSync(path, "utf8") !== expected) throw new Error(`Migration guide drift: ${path}. Regenerate from its release record; do not edit generated guides.`);
    known.add(`${record.version}.docs.md`);
  }
  for (const file of existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith(".docs.md")) : []) {
    if (file === "index.docs.md") continue;
    if (!known.has(file)) throw new Error(`Migration guide ${file} has no source record.`);
  }
  if (records.length) {
    const indexPath = join(directory, "index.docs.md");
    const expectedIndex = renderMigrationIndex(records.map(file => stableVersion(file.slice(0, -5))));
    if (!existsSync(indexPath) || readFileSync(indexPath, "utf8") !== expectedIndex) throw new Error("Migration index drift: regenerate migration documentation.");
  }
  if (release) {
    const version = JSON.parse(readFileSync(join(root, "packages/vgpu-api/package.json"), "utf8")).version;
    const recordPath = join(recordDir, `${stableVersion(version)}.json`);
    if (!existsSync(recordPath)) throw new Error(`Missing migration record for ${version}; prepare releases with pnpm release:version.`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (record.preparedVersion !== version) throw new Error(`Migration record was prepared for ${record.preparedVersion}, not ${version}; use pnpm release:version.`);
    for (const [id, source] of Object.entries(pending)) {
      if (record.sources[id] !== source) throw new Error(`${id} was not collected for ${version}; run release preparation before publishing.`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "sync" && args.length === 2) {
      const current = JSON.parse(readFileSync("packages/vgpu-api/package.json", "utf8")).version;
      if (args[1] !== current) throw new Error(`Only the current prepared version (${current}) can be regenerated. Use pnpm release:version for a new release.`);
      syncMigration(process.cwd(), args[1], pendingSources(process.cwd()));
    }
    else if (args[0] === "check" && (args.length === 1 || (args.length === 2 && args[1] === "--release"))) checkMigrations(process.cwd(), { release: args.includes("--release") });
    else throw new Error("Usage: node scripts/migrations.mjs sync <version> | check [--release]");
    console.log("Migration documentation validated.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
