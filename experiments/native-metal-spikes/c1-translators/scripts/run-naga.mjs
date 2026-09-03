import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const repoRoot = resolve(process.env.C1_REPO_ROOT ?? join(fixtureDir, "../../.."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const harness = resolve(process.env.C1_NAGA_HARNESS ?? join(artifactsDir, "cargo-target/release/vgpu-c1-naga-harness"));
const manifest = JSON.parse(await readFile(join(artifactsDir, "manifest.json"), "utf8"));
const outputRoot = join(artifactsDir, "naga");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const results = [];
for (const [index, input] of manifest.inputs.entries()) {
  const artifactName = input.kind === "corpus" ? input.name : `canaries/${input.name}.wgsl`;
  const sourcePath = join(repoRoot, input.input);
  const outputPath = join(outputRoot, `${artifactName}.metal`);
  const metadataPath = join(outputRoot, `${artifactName}.json`);
  const repeatOutput = join(outputRoot, `${artifactName}.repeat.metal`);
  const repeatMetadata = join(outputRoot, `${artifactName}.repeat.json`);
  await mkdir(dirname(outputPath), { recursive: true });

  const first = spawnSync(harness, [sourcePath, outputPath, metadataPath], { cwd: repoRoot, encoding: "utf8" });
  const second = spawnSync(harness, [sourcePath, repeatOutput, repeatMetadata], { cwd: repoRoot, encoding: "utf8" });
  const observed = first.status === 0 ? "success" : "failure";
  let deterministic = first.status === second.status && first.stdout === second.stdout && first.stderr === second.stderr;
  let projection = null;
  let msl = null;
  if (first.status === 0 && second.status === 0) {
    const [firstMSL, secondMSL, firstMetadata, secondMetadata] = await Promise.all([
      readFile(outputPath, "utf8"),
      readFile(repeatOutput, "utf8"),
      readFile(metadataPath, "utf8"),
      readFile(repeatMetadata, "utf8"),
    ]);
    deterministic &&= firstMSL === secondMSL && firstMetadata === secondMetadata;
    msl = firstMSL;
    projection = JSON.parse(firstMetadata);
  }
  results.push({
    kind: input.kind,
    name: input.name,
    contract: input.contract,
    expected: input.expectations.naga,
    observed,
    expectedOutcome: observed === input.expectations.naga,
    contractOutcome: observed === (input.contract === "valid" ? "success" : "failure"),
    deterministic,
    output: first.status === 0 ? outputPath.slice(repoRoot.length + 1) : null,
    projection,
    diagnostic: first.stderr.trim(),
  });
  if ((index + 1) % 50 === 0) console.error(`naga ${index + 1}/${manifest.inputs.length}`);
}

const canary = (name) => results.find((result) => result.kind === "canary" && result.name === name);
const binding = canary("binding-slots");
const bindingMSL = binding.output ? await readFile(join(repoRoot, binding.output), "utf8") : "";
const projectedBindings = binding.projection?.bindings.map(({ group, binding, kind, buffer, texture, sampler }) => ({
  group, binding, kind, buffer, texture, sampler,
}));
const expectedBindings = [
  { group: 0, binding: 3, kind: "buffer", buffer: 0, texture: null, sampler: null },
  { group: 1, binding: 2, kind: "sampler", buffer: null, texture: null, sampler: 0 },
  { group: 1, binding: 7, kind: "texture", buffer: null, texture: 0, sampler: null },
  { group: 2, binding: 0, kind: "buffer", buffer: 1, texture: null, sampler: null },
];
const bindingProjectionMatches = JSON.stringify(projectedBindings) === JSON.stringify(expectedBindings)
  && bindingMSL.includes("[[buffer(30)]]");

const typed = canary("typed-overrides");
const typedMSL = typed.output ? await readFile(join(repoRoot, typed.output), "utf8") : "";
const overridesBaked = typed.observed === "success"
  && !typedMSL.includes("function_constant")
  && typed.projection?.entryPoints[0]?.workgroupSize?.[0] === 4;
const multipleEntryPoints = canary("multiple-entry-points").projection?.entryPoints.length === 4;

const summary = {
  schemaVersion: 1,
  status: "completed",
  implementation: "naga 30.0.1",
  mslVersion: "2.4",
  attempted: results.length,
  expectedBehaviorMatched: results.filter((result) => result.expectedOutcome).length,
  deterministic: results.filter((result) => result.deterministic).length,
  contractValid: {
    attempted: results.filter((result) => result.contract === "valid").length,
    succeeded: results.filter((result) => result.contract === "valid" && result.observed === "success").length,
  },
  contractInvalidRejected: results.filter((result) => result.contract === "invalid" && result.observed === "failure").length,
  emittedEntryPoints: results.reduce((total, result) => total + (result.projection?.entryPoints.length ?? 0), 0),
  canaries: Object.fromEntries(results.filter((result) => result.kind === "canary").map((result) => [result.name, {
    expected: result.expected,
    observed: result.observed,
    contractOutcome: result.contractOutcome,
  }])),
  assertions: {
    bindingProjectionMatches,
    multipleEntryPoints,
    overridesBaked,
  },
  contractFailures: results.filter((result) => !result.contractOutcome).map((result) => result.name),
  diagnostics: results.filter((result) => result.observed === "failure").map((result) => ({ name: result.name, diagnostic: result.diagnostic })),
};
await writeFile(join(outputRoot, "results.json"), `${JSON.stringify({ summary, files: results }, null, 2)}\n`);
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const behaviorDrift = results.filter((result) => !result.expectedOutcome || !result.deterministic);
if (behaviorDrift.length || !bindingProjectionMatches || !multipleEntryPoints || !overridesBaked) {
  console.error(JSON.stringify({ behaviorDrift: behaviorDrift.map((result) => result.name), assertions: summary.assertions }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
