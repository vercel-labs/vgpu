import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const repoRoot = resolve(process.env.C1_REPO_ROOT ?? join(fixtureDir, "../../.."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const compiler = resolve(process.env.C1_METAL_RUNTIME_COMPILER ?? join(artifactsDir, "bin/metal-runtime-compiler"));
const naga = JSON.parse(await readFile(join(artifactsDir, "naga/results.json"), "utf8"));
const outputRoot = join(artifactsDir, "runtime-metal");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const files = [];
for (const result of naga.files.filter((candidate) => candidate.observed === "success")) {
  const run = spawnSync(compiler, [join(repoRoot, result.output)], { cwd: repoRoot, encoding: "utf8" });
  let payload = null;
  try {
    payload = JSON.parse(run.stdout);
  } catch {}
  files.push({
    kind: result.kind,
    name: result.name,
    ok: run.status === 0 && payload?.ok === true,
    languageVersion: payload?.languageVersion,
    functionNames: payload?.functionNames ?? [],
    device: payload?.device ?? null,
    errorDescription: payload?.errorDescription ?? (run.stderr?.trim() || "unparseable compiler result"),
  });
}

const summary = {
  schemaVersion: 1,
  status: "completed",
  compiler: "MTLDevice.makeLibrary",
  languageVersion: "2.4",
  attempted: files.length,
  succeeded: files.filter((result) => result.ok).length,
  functionsLoaded: files.reduce((total, result) => total + result.functionNames.length, 0),
  device: files.find((result) => result.device)?.device ?? null,
  failures: files.filter((result) => !result.ok).map(({ name, errorDescription }) => ({ name, errorDescription })),
};
await writeFile(join(outputRoot, "results.json"), `${JSON.stringify({ summary, files }, null, 2)}\n`);
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (summary.succeeded !== summary.attempted) process.exit(1);
