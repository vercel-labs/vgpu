import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const repoRoot = resolve(process.env.C1_REPO_ROOT ?? join(fixtureDir, "../../.."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const naga = JSON.parse(await readFile(join(artifactsDir, "naga/results.json"), "utf8"));
const outputRoot = join(artifactsDir, "offline-metal");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const files = [];
for (const [index, result] of naga.files.filter((candidate) => candidate.observed === "success").entries()) {
  const name = result.kind === "corpus" ? result.name : `canaries/${result.name}.wgsl`;
  const air = join(outputRoot, "objects", `${name}.air`);
  const library = join(outputRoot, "libraries", `${name}.metallib`);
  await Promise.all([mkdir(dirname(air), { recursive: true }), mkdir(dirname(library), { recursive: true })]);
  const metal = spawnSync("xcrun", [
    "-sdk", "macosx", "metal", "-std=metal2.4", "-mmacosx-version-min=14.0",
    "-c", join(repoRoot, result.output), "-o", air,
  ], { cwd: repoRoot, encoding: "utf8" });
  const metallib = metal.status === 0
    ? spawnSync("xcrun", ["-sdk", "macosx", "metallib", air, "-o", library], { cwd: repoRoot, encoding: "utf8" })
    : null;
  files.push({
    kind: result.kind,
    name: result.name,
    metalExitCode: metal.status,
    metallibExitCode: metallib?.status ?? null,
    ok: metal.status === 0 && metallib?.status === 0,
    diagnostic: `${metal.stderr ?? ""}${metallib?.stderr ?? ""}`.trim(),
  });
  if ((index + 1) % 50 === 0) console.error(`offline metal ${index + 1}`);
}

const summary = {
  schemaVersion: 1,
  status: "completed",
  compiler: "xcrun metal + metallib",
  languageVersion: "2.4",
  deploymentTarget: "macOS 14.0",
  attempted: files.length,
  succeeded: files.filter((result) => result.ok).length,
  failures: files.filter((result) => !result.ok).map(({ name, diagnostic }) => ({ name, diagnostic })),
};
await writeFile(join(outputRoot, "results.json"), `${JSON.stringify({ summary, files }, null, 2)}\n`);
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (summary.succeeded !== summary.attempted) process.exit(1);
