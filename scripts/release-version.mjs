#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrations, pendingSources, syncMigration } from "./migrations.mjs";

const root = process.cwd();
const sources = pendingSources(root);
checkMigrations(root); // Reject missing migration decisions or lost RC sources before any mutation.
const temp = mkdtempSync(join(tmpdir(), "vgpu-release-plan-"));
try {
  const planFile = join(temp, "plan.json");
  execFileSync("pnpm", ["changeset", "status", "--output", planFile], { stdio: "inherit" });
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const version = plan.releases.find(release => release.name === "vgpu")?.newVersion;
  if (!version) throw new Error("No public vgpu release in the Changesets plan. Add an appropriate changeset before preparing a release.");
  execFileSync("pnpm", ["changeset", "version"], { stdio: "inherit", env: { ...process.env, VGPU_RELEASE_VERSION: version } });
  const actual = JSON.parse(readFileSync(join(root, "packages/vgpu-api/package.json"), "utf8")).version;
  if (actual !== version) throw new Error(`Changesets planned ${version} but generated ${actual}; inspect the release diff.`);
  syncMigration(root, version, sources);
  execFileSync("pnpm", ["install"], { stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "@vgpu/cli", "generate:docs"], { stdio: "inherit" });
  execFileSync("pnpm", ["--filter", "@vgpu/cli", "generate:docs:geistdocs"], { stdio: "inherit" });
  console.log(`Prepared ${version}, changelogs and migration guides. Review and commit the entire diff.`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
