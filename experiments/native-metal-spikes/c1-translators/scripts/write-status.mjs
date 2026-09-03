import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const [target, status, ...reasonWords] = process.argv.slice(2);
const allowedTargets = new Set(["naga", "tint", "runtime-metal", "offline-metal"]);
const allowedStatuses = new Set(["skipped", "failed"]);
if (!allowedTargets.has(target) || !allowedStatuses.has(status) || reasonWords.length === 0) {
  throw new Error("usage: write-status.mjs <naga|tint|runtime-metal|offline-metal> <skipped|failed> <reason>");
}
const directory = join(artifactsDir, target);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "summary.json"), `${JSON.stringify({
  schemaVersion: 1,
  status,
  reason: reasonWords.join(" "),
}, null, 2)}\n`);
