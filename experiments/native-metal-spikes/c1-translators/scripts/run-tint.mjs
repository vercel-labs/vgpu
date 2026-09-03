import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const repoRoot = resolve(process.env.C1_REPO_ROOT ?? join(fixtureDir, "../../.."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const manifest = JSON.parse(await readFile(join(artifactsDir, "manifest.json"), "utf8"));
const outputRoot = join(artifactsDir, "tint");
const child = join(scriptDir, "tint-child.mjs");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const sha256 = (source) => createHash("sha256").update(source).digest("hex");
const resultMarker = "__VGPU_C1_RESULT__";

function parsePayload(stdout) {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(resultMarker));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(resultMarker.length));
  } catch {
    return null;
  }
}

const results = [];
for (const [index, input] of manifest.inputs.entries()) {
  const sourcePath = join(repoRoot, input.input);
  const reflectionPath = join(repoRoot, input.reflection);
  const args = [child, sourcePath, reflectionPath, input.name];
  const options = { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const first = spawnSync(process.execPath, args, options);
  const second = spawnSync(process.execPath, args, options);
  const payload = parsePayload(first.stdout ?? "");
  const repeatPayload = parsePayload(second.stdout ?? "");
  const observed = first.status === 0 ? "success" : "failure";
  const artifactName = input.kind === "corpus" ? input.name : `canaries/${input.name}.wgsl`;
  const mslChunks = [...(first.stdout ?? "").matchAll(
    /info:\n(\/\* Dumped generated MSL \*\/[\s\S]*?)(?=\ninfo:\n|\n__VGPU_C1_RESULT__)/g,
  )].map((match) => match[1]);
  const msl = [];
  for (const [chunkIndex, source] of mslChunks.entries()) {
    const path = join(outputRoot, "msl", artifactName, `${chunkIndex}.metal`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    msl.push({ path: path.slice(repoRoot.length + 1), bytes: Buffer.byteLength(source), sha256: sha256(source) });
  }

  const logPath = join(outputRoot, "logs", `${artifactName}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `# stdout\n${first.stdout ?? ""}\n# stderr\n${first.stderr ?? ""}`);
  const deterministic = first.status === second.status
    && first.signal === second.signal
    && first.stdout === second.stdout
    && first.stderr === second.stderr
    && JSON.stringify(payload) === JSON.stringify(repeatPayload);
  results.push({
    kind: input.kind,
    name: input.name,
    contract: input.contract,
    expected: input.expectations.tint,
    observed,
    expectedOutcome: observed === input.expectations.tint,
    contractOutcome: observed === (input.contract === "valid" ? "success" : "failure"),
    deterministic,
    stdoutSha256: sha256(first.stdout ?? ""),
    stderrSha256: sha256(first.stderr ?? ""),
    payload,
    msl,
  });
  if ((index + 1) % 25 === 0) console.error(`tint ${index + 1}/${manifest.inputs.length}`);
}

const canary = (name) => results.find((result) => result.kind === "canary" && result.name === name);
const combinedMSL = async (name) => Promise.all(
  (canary(name)?.msl ?? []).map((artifact) => readFile(join(repoRoot, artifact.path), "utf8")),
).then((chunks) => chunks.join("\n"));
const bindingMSL = await combinedMSL("binding-slots");
const typedMSL = await combinedMSL("typed-overrides");
const features = results.find((result) => result.payload?.wgslLanguageFeatures)?.payload.wgslLanguageFeatures ?? [];
const bindingSlotsObserved = ["[[buffer(0)]]", "[[buffer(1)]]", "[[texture(0)]]", "[[sampler(0)]]", "[[buffer(30)]]"]
  .every((needle) => bindingMSL.includes(needle));
const overridesBaked = canary("typed-overrides")?.observed === "success"
  && !typedMSL.includes("function_constant")
  && typedMSL.includes("max_total_threads_per_threadgroup(4)");
const multiplePipelines = canary("multiple-entry-points")?.payload?.pipelines.length === 3
  && canary("multiple-entry-points")?.payload?.pipelines.every((pipeline) => pipeline.ok);
const languageFeaturesObserved = ["uniform_buffer_standard_layout", "unrestricted_pointer_parameters"]
  .every((feature) => features.includes(feature));

const valid = results.filter((result) => result.contract === "valid");
const invalid = results.filter((result) => result.contract === "invalid");
const summary = {
  schemaVersion: 1,
  status: "completed",
  implementation: "Tint embedded in webgpu@0.4.0 / Dawn c5d549e250b9225744929ae860b369cb4304a767",
  backend: "Metal via Dawn",
  attempted: results.length,
  expectedBehaviorMatched: results.filter((result) => result.expectedOutcome).length,
  deterministic: results.filter((result) => result.deterministic).length,
  contractValid: { attempted: valid.length, succeeded: valid.filter((result) => result.observed === "success").length },
  contractInvalidRejected: invalid.filter((result) => result.observed === "failure").length,
  pipelineRootsCreated: results.reduce((total, result) => total + (result.payload?.pipelines?.filter((pipeline) => pipeline.ok).length ?? 0), 0),
  authoredEntryPoints: manifest.inputs.reduce((total, input) => total + input.entryPoints, 0),
  generatedMslModules: results.reduce((total, result) => total + result.msl.length, 0),
  languageFeatures: features,
  canaries: Object.fromEntries(results.filter((result) => result.kind === "canary").map((result) => [result.name, {
    expected: result.expected,
    observed: result.observed,
    contractOutcome: result.contractOutcome,
  }])),
  assertions: { bindingSlotsObserved, languageFeaturesObserved, multiplePipelines, overridesBaked },
  contractFailures: results.filter((result) => !result.contractOutcome).map((result) => result.name),
  failures: results.filter((result) => result.observed === "failure").map((result) => ({
    name: result.name,
    fatal: result.payload?.fatal,
    moduleDiagnostics: result.payload?.moduleDiagnostics,
    pipelines: result.payload?.pipelines,
  })),
};
await writeFile(join(outputRoot, "results.json"), `${JSON.stringify({ summary, files: results }, null, 2)}\n`);
await writeFile(join(outputRoot, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const behaviorDrift = results.filter((result) => !result.expectedOutcome || !result.deterministic);
if (behaviorDrift.length || !Object.values(summary.assertions).every(Boolean)) {
  console.error(JSON.stringify({ behaviorDrift: behaviorDrift.map((result) => result.name), assertions: summary.assertions }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
