import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const artifactsDir = resolve(
  process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts")
);
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const readOptional = async (path) => {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT")
      return { schemaVersion: 1, status: "skipped", reason: "not run" };
    throw error;
  }
};

const manifest = await readJson(join(artifactsDir, "manifest.json"));
const [tint, naga, runtimeMetal, offlineMetal] = await Promise.all([
  readOptional(join(artifactsDir, "tint/summary.json")),
  readOptional(join(artifactsDir, "naga/summary.json")),
  readOptional(join(artifactsDir, "runtime-metal/summary.json")),
  readOptional(join(artifactsDir, "offline-metal/summary.json")),
]);
const candidatesCompleted =
  tint.status === "completed" && naga.status === "completed";
const offlineCompleted = offlineMetal.status === "completed";
const summary = {
  schemaVersion: 1,
  mode: manifest.mode,
  inventory: manifest.inventory,
  resolution: manifest.resolution,
  inputs: {
    total: manifest.inputs.length,
    canaries: manifest.inputs.filter((input) => input.kind === "canary").length,
    corpus: manifest.inputs.filter((input) => input.kind === "corpus").length,
  },
  candidates: { tint, naga },
  metalValidation: { runtime: runtimeMetal, offline: offlineMetal },
  decision: {
    semanticLeader: candidatesCompleted ? "Tint" : null,
    frozen: false,
    c1Complete: false,
    reason: candidatesCompleted
      ? offlineCompleted
        ? "Tint covers the tested WGSL contract; the integrated direct-worker corpus and downstream artifact and parity gates remain open."
        : "Tint covers the tested WGSL contract; offline metal/metallib validation and downstream gates remain open."
      : "Both translator candidates must run before comparing them.",
  },
  reproduction: {
    complete: candidatesCompleted,
    offlineGateSkipped: !offlineCompleted,
  },
};
await writeFile(
  join(artifactsDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);
console.log(JSON.stringify(summary, null, 2));
