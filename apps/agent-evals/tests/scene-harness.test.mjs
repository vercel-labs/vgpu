import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  recordSceneTurn,
  snapshotAttemptDir,
  snapshotTarPath,
  snapshotTurnDir,
} from "../agent/lib/paths.ts";
import { executeFreshSource, sourceManifest, verifySceneInSandbox } from "../agent/lib/verify/scene.mjs";
import { sceneContract, sceneInputSha256 } from "../evals/lib/scene-contracts.mjs";
import { viewProjection } from "../evals/lib/scene-math.mjs";
import { collectSceneRunProvenance, parseSceneResult, readSceneFixtureHashes, validateSceneAttempt } from "../evals/lib/scene-eval.ts";

function tempWork() {
  const root = mkdtempSync(join(tmpdir(), "scene-harness-test-"));
  process.env.VGPU_EVALS_WORK_DIR = join(root, "work");
  return root;
}

test("turn IDs and event IDs retain immutable retries without advancing stage", () => {
  const root = tempWork();
  assert.deepEqual(recordSceneTurn("session", "turn-a"), { stage: 1, isNew: true });
  assert.deepEqual(recordSceneTurn("session", "turn-a"), { stage: 1, isNew: false });
  assert.deepEqual(recordSceneTurn("session", "turn-b"), { stage: 2, isNew: true });
  assert.notEqual(snapshotAttemptDir("session", "turn-a", "event-1"), snapshotAttemptDir("session", "turn-a", "event-2"));
  assert.notEqual(snapshotTurnDir("session", "turn-a"), snapshotTurnDir("session", "turn-b"));
  assert.equal(snapshotTarPath("session").endsWith("session/workspace.tar"), true);
  rmSync(root, { recursive: true, force: true });
});

test("fresh execution copies source outside the submission, passes ordered frames, ignores old output, and cleans up", async () => {
  const root = tempWork();
  const sourceDir = join(root, "workspace");
  mkdirSync(join(sourceDir, "old-output"), { recursive: true });
  mkdirSync(join(sourceDir, "nested", "dist"), { recursive: true });
  mkdirSync(join(sourceDir, "build"), { recursive: true });
  mkdirSync(join(sourceDir, "dist"), { recursive: true });
  writeFileSync(join(sourceDir, "old-output", "result.json"), "agent-left");
  writeFileSync(join(sourceDir, "nested", "dist", "helper.mjs"), "export const nested = 'preserved';\n");
  writeFileSync(join(sourceDir, "build", "authored.mjs"), "export const built = true;\n");
  writeFileSync(join(sourceDir, "dist", "authored.mjs"), "export const distributed = true;\n");
  writeFileSync(join(sourceDir, "render.mjs"), `
    import {readFile, writeFile} from "node:fs/promises";
    import {nested} from "./nested/dist/helper.mjs";
    const [inputPath, outputDir] = process.argv.slice(2);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    await writeFile(new URL("seen.json", "file://" + outputDir + "/"), JSON.stringify({cwd: process.cwd(), frames: input.frames, nested}));
    await writeFile(new URL("result.json", "file://" + outputDir + "/"), JSON.stringify({version: 1, requestId: input.requestId, frames: []}));
  `);
  const input = sceneContract("scene-shader-bindings", 2).input;
  let capturePath;
  const result = await executeFreshSource({
    sourceDir,
    input,
    tempRoot: root,
    healthProbe: async () => ({ ok: true, renderer: "test" }),
    capture: async (outputDir) => {
      capturePath = outputDir;
      return JSON.parse(readFileSync(join(outputDir, "seen.json"), "utf8"));
    },
  });
  assert.equal(result.classification, "pass");
  assert.notEqual(result.artifacts.cwd, sourceDir);
  assert.equal(result.artifacts.cwd.includes("vgpu-scene-"), true);
  assert.deepEqual(result.artifacts.frames, input.frames);
  assert.equal(result.artifacts.nested, "preserved");
  assert.equal(existsSync(capturePath), false);
  assert.equal(result.sourceFiles.some((entry) => entry.path.startsWith("old-output/")), true);
  assert.equal(result.sourceFiles.some((entry) => entry.path === "build/authored.mjs"), true);
  assert.equal(result.sourceFiles.some((entry) => entry.path === "dist/authored.mjs"), true);
  assert.equal(result.sourceFiles.some((entry) => entry.path === "nested/dist/helper.mjs"), true);
  rmSync(root, { recursive: true, force: true });
});

test("application exits and timeouts are distinct from health/cleanup infrastructure failures", async () => {
  const root = tempWork();
  const sourceDir = join(root, "workspace");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "render.mjs"), "process.exit(7)");
  const input = sceneContract("scene-robot-arm", 1).input;
  assert.equal((await executeFreshSource({ sourceDir, input, tempRoot: root, healthProbe: async () => ({ ok: true }) })).classification, "application-failure");
  assert.equal((await executeFreshSource({ sourceDir, input, tempRoot: root, healthProbe: async () => ({ ok: false, reason: "native unavailable" }) })).classification, "infrastructure-error");

  writeFileSync(join(sourceDir, "render.mjs"), "setInterval(() => {}, 1000)");
  const timedOut = await executeFreshSource({ sourceDir, input, tempRoot: root, timeoutMs: 25, healthProbe: async () => ({ ok: true }) });
  assert.equal(timedOut.classification, "application-failure");
  assert.equal(timedOut.execution.timedOut, true);

  const cleanup = await executeFreshSource({
    sourceDir,
    input,
    tempRoot: root,
    timeoutMs: 25,
    healthProbe: async () => ({ ok: true }),
    cleanup: () => { throw new Error("cleanup denied"); },
  });
  assert.equal(cleanup.classification, "infrastructure-error");
  assert.match(cleanup.reason, /cleanup denied/);
  rmSync(root, { recursive: true, force: true });
});

test("fresh execution passes control-only environment without mutating the host environment", async () => {
  const root = tempWork();
  const sourceDir = join(root, "workspace");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "render.mjs"), `
    import {writeFile} from "node:fs/promises";
    const outputDir = process.argv[3];
    await writeFile(outputDir + "/environment.json", JSON.stringify({task: process.env.VGPU_SCENE_CONTROL_TASK, fault: process.env.VGPU_SCENE_CONTROL_FAULT}));
  `);
  const previous = process.env.VGPU_SCENE_CONTROL_TASK;
  const result = await executeFreshSource({
    sourceDir,
    input: sceneContract("scene-robot-arm", 1).input,
    tempRoot: root,
    env: { VGPU_SCENE_CONTROL_TASK: "scene-robot-arm", VGPU_SCENE_CONTROL_FAULT: "positive" },
    healthProbe: async () => ({ ok: true }),
    capture: async (outputDir) => JSON.parse(readFileSync(join(outputDir, "environment.json"), "utf8")),
  });
  assert.equal(result.classification, "pass");
  assert.deepEqual(result.artifacts, { task: "scene-robot-arm", fault: "positive" });
  assert.equal(process.env.VGPU_SCENE_CONTROL_TASK, previous);
  rmSync(root, { recursive: true, force: true });
});

test("source manifests change with authored code and seeds contain no oracle or reference implementation", () => {
  const root = tempWork();
  const sourceDir = join(root, "workspace");
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "render.mjs"), "export const value = 1");
  const first = sourceManifest(sourceDir);
  writeFileSync(join(sourceDir, "render.mjs"), "export const value = 2");
  const second = sourceManifest(sourceDir);
  assert.notEqual(first.hash, second.hash);

  for (const task of ["scene-robot-arm", "scene-shader-bindings", "scene-warehouse"]) {
    const seed = join(process.cwd(), "apps/agent-evals/agent/sandbox/tasks", task);
    assert.equal(existsSync(seed), true);
    const names = sourceManifest(seed).files.map((file) => file.path);
    assert.equal(names.length >= 2, true);
    assert.equal(names.some((name) => /reference|grade|oracle|control/i.test(name)), false);
    assert.equal(names.every((name) => ["package.json", "contract.md", "integration.wgsl"].includes(name)), true);
  }
  rmSync(root, { recursive: true, force: true });
});

test("stage-two semantics are explicit in follow-up prompts and absent from seeds", () => {
  const robot = sceneContract("scene-robot-arm", 2);
  const shader = sceneContract("scene-shader-bindings", 2);
  const warehouse = sceneContract("scene-warehouse", 2);
  assert.match(robot.prompt, /absolute replacement/i);
  assert.match(robot.prompt, /every frame in order in one invocation/i);
  assert.match(shader.prompt, /do not retarget/i);
  assert.match(shader.prompt, /orientation stays identity/i);
  assert.match(warehouse.prompt, /apply operations in order to one persistent inventory/i);
  assert.match(warehouse.prompt, /"delete".*"move".*"recolor"/i);
  for (const task of ["scene-robot-arm", "scene-shader-bindings", "scene-warehouse"]) {
    const seed = join(process.cwd(), "apps/agent-evals/agent/sandbox/tasks", task);
    const text = sourceManifest(seed).files.map((file) => readFileSync(join(seed, file.path), "utf8")).join("\n");
    assert.doesNotMatch(text, /apply operations in order to one persistent inventory/i);
    assert.doesNotMatch(text, /do not retarget/i);
    assert.doesNotMatch(text, /absolute replacement/i);
  }
  assert.equal(sceneInputSha256(shader.input), sceneInputSha256(structuredClone(shader.input)));
  const changed = structuredClone(shader.input);
  changed.frames[1].cameraPosition[0] += 0.01;
  assert.notEqual(sceneInputSha256(shader.input), sceneInputSha256(changed));
});

test("shader contract example matrix matches its documented WebGPU camera convention", () => {
  const contractPath = join(process.cwd(), "apps/agent-evals/agent/sandbox/tasks/scene-shader-bindings/contract.md");
  const guidePath = join(process.cwd(), "apps/agent-evals/scene-evals.md");
  const contract = readFileSync(contractPath, "utf8");
  const resultLine = contract.split("\n").find((line) => line.startsWith('{"version":1,"requestId":"example"'));
  assert.ok(resultLine);
  const matrix = JSON.parse(resultLine).frames[0].state.viewProjection;
  const expected = viewProjection([0, 0, 8], [-4, 4, -3, 3, 0.1, 20]);
  assert.equal(matrix.length, 16);
  matrix.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `matrix[${index}]`));
  assert.match(readFileSync(guidePath, "utf8"), /0\.3969849246/);
});

test("sandbox transport runs the native canary from the copied app before submitted source and correlates evidence", async () => {
  const files = new Map();
  const commands = [];
  let probeConfig;
  let appConfig;
  const sandbox = {
    async writeTextFile({ path, content }) { files.set(path, content); },
    async readTextFile({ path }) { return files.get(path) ?? null; },
    async run({ command }) {
      commands.push(command);
      if (command.startsWith("find /workspace")) {
        const match = command.match(/> '([^']+)'$/);
        if (match) files.set(match[1], "source  hash\n");
      } else if (/runner\.mjs.*probe-config\.json/.test(command)) {
        const path = [...files.keys()].find((key) => key.endsWith("/probe-config.json"));
        probeConfig = JSON.parse(files.get(path));
        files.set(probeConfig.resultPath, JSON.stringify({ exitCode: 0, timedOut: false, runtime: { node: "v24.fake", platform: "linux", arch: "arm64" } }));
      } else if (/runner\.mjs.*run-config\.json/.test(command)) {
        const path = [...files.keys()].find((key) => key.endsWith("/run-config.json"));
        appConfig = JSON.parse(files.get(path));
        files.set(appConfig.resultPath, JSON.stringify({ exitCode: 0, timedOut: false, runtime: { node: "v24.fake", platform: "linux", arch: "arm64" } }));
      } else if (command.startsWith("tar -cf ")) {
        const match = command.match(/^tar -cf '([^']+)'/);
        if (match) files.set(match[1], new Uint8Array([1, 2, 3]));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const contract = sceneContract("scene-robot-arm", 1);
  const result = await verifySceneInSandbox(sandbox, {
    taskId: contract.taskId,
    stage: 1,
    turnId: "turn-exact",
    metaId: "event-exact",
    input: contract.input,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "pass");
  assert.equal(result.cleanupOk, true);
  assert.equal(result.metadata.stage, 1);
  assert.equal(result.metadata.turnId, "turn-exact");
  assert.equal(result.metadata.metaId, "event-exact");
  assert.equal(result.metadata.inputSha256, sceneInputSha256(contract.input));
  assert.equal(probeConfig.cwd.endsWith("/app"), true);
  assert.deepEqual(probeConfig.args, [".vgpu-scene-canary.mjs"]);
  assert.equal(appConfig.cwd.endsWith("/app"), true);
  assert.ok(commands.findIndex((command) => /probe-config/.test(command)) < commands.findIndex((command) => /run-config/.test(command)));
  assert.ok(commands.some((command) => /rm -f .*\.vgpu-scene-canary\.mjs/.test(command)));
});

test("sandbox evidence pipelines preserve find failures", async () => {
  const files = new Map();
  const commands = [];
  const base = fakeSceneSandbox(files, () => null);
  const sandbox = {
    ...base,
    async run(options) {
      commands.push(options.command);
      return base.run(options);
    },
  };
  const contract = sceneContract("scene-robot-arm", 1);
  const result = await verifySceneInSandbox(sandbox, {
    taskId: contract.taskId,
    stage: 1,
    turnId: "turn-pipelines",
    metaId: "event-pipelines",
    input: contract.input,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "pass");

  const manifest = commands.find((command) => command.includes("source-manifest.txt"));
  const digests = commands.filter((command) => /workspace-(before|after)\.txt/.test(command));
  assert.ok(manifest, "source manifest command was not run");
  assert.equal(digests.length, 2);
  for (const command of [manifest, ...digests]) {
    assert.match(command, /^bash -o pipefail -c /);
    assert.match(command, /xargs -0 -r sha256sum/);
  }
});

test("missing supplied fixture records evidence without becoming infrastructure failure", async () => {
  const files = new Map();
  const commands = [];
  const base = fakeSceneSandbox(files, () => null);
  const sandbox = {
    ...base,
    async run(options) {
      commands.push(options.command);
      if (options.command.includes("fixture-sha256.txt")) {
        const match = options.command.match(/> '([^']*fixture-sha256\.txt)'/);
        if (match) files.set(match[1], "MISSING  integration.wgsl\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return base.run(options);
    },
  };
  const contract = sceneContract("scene-shader-bindings", 1);
  const result = await verifySceneInSandbox(sandbox, {
    taskId: contract.taskId,
    stage: 1,
    turnId: "turn-missing-fixture",
    metaId: "event-missing-fixture",
    input: contract.input,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "pass");
  assert.ok(commands.some((command) => command.includes("MISSING")));

  const evidenceRoot = mkdtempSync(join(tmpdir(), "scene-fixture-hash-test-"));
  const evidence = join(evidenceRoot, "fixture-sha256.txt");
  writeFileSync(evidence, "MISSING  integration.wgsl\n");
  assert.equal(readSceneFixtureHashes(evidence).has("integration.wgsl"), false);
  rmSync(evidenceRoot, { recursive: true, force: true });
});

test("sandbox transport classifies setup, manifest, and evidence export command failures as infrastructure", async () => {
  const contract = sceneContract("scene-robot-arm", 1);
  for (const failingCommand of ["source-copy", "source-manifest", "evidence-export"]) {
    const files = new Map();
    const sandbox = fakeSceneSandbox(files, (command) => {
      if (failingCommand === "source-copy" && command.includes("pipefail")) return { exitCode: 7, stdout: "", stderr: "copy failed" };
      if (failingCommand === "source-manifest" && command.includes("source-manifest.txt")) return { exitCode: 8, stdout: "", stderr: "manifest failed" };
      if (failingCommand === "evidence-export" && command.startsWith("tar -cf ")) return { exitCode: 9, stdout: "", stderr: "export failed" };
      return null;
    });
    const result = await verifySceneInSandbox(sandbox, {
      taskId: contract.taskId,
      stage: 1,
      turnId: `turn-${failingCommand}`,
      metaId: `event-${failingCommand}`,
      input: contract.input,
      timeoutMs: 50,
    });
    assert.equal(result.classification, "infrastructure-error");
    const expectedReason = failingCommand === "source-copy" ? "source copy" : failingCommand === "source-manifest" ? "source evidence manifest" : "evidence export";
    assert.match(result.reason, new RegExp(expectedReason));
  }
});

test("a missing runner execution record is infrastructure failure, not an agent failure", async () => {
  const files = new Map();
  const sandbox = fakeSceneSandbox(files, () => null);
  const read = sandbox.readTextFile;
  sandbox.readTextFile = (options) => options.path.endsWith("/execution.json")
    ? Promise.resolve(null)
    : read(options);
  const contract = sceneContract("scene-robot-arm", 1);
  const result = await verifySceneInSandbox(sandbox, {
    taskId: contract.taskId,
    stage: 1,
    turnId: "turn-missing-execution",
    metaId: "event-missing-execution",
    input: contract.input,
    timeoutMs: 50,
  });
  assert.equal(result.classification, "infrastructure-error");
  assert.match(result.reason, /execution record/i);
  assert.equal(result.cleanupOk, true);
});

test("sandbox transport reports a nonzero cleanup command without claiming removal", async () => {
  const files = new Map();
  const sandbox = fakeSceneSandbox(files, (command) => command.startsWith("rm -rf ")
    ? { exitCode: 13, stdout: "", stderr: "cleanup denied" }
    : null);
  const contract = sceneContract("scene-robot-arm", 1);
  const result = await verifySceneInSandbox(sandbox, {
    taskId: contract.taskId,
    stage: 1,
    turnId: "turn-cleanup",
    metaId: "event-cleanup",
    input: contract.input,
    timeoutMs: 50,
  });
  assert.equal(result.cleanupOk, false);
  assert.equal(result.classification, "infrastructure-error");
  assert.match(result.reason, /cleanup denied|cleanup failed/);
});

test("driver rejects stale stage, turn, event, or input hash coordinates", () => {
  const expected = { stage: 2, turnId: "turn-b", metaId: "event-b", inputSha256: "input-b" };
  assert.deepEqual(validateSceneAttempt(expected, expected), []);
  for (const key of Object.keys(expected)) {
    const stale = { ...expected, [key]: key === "stage" ? 1 : "stale" };
    assert.match(validateSceneAttempt(expected, stale).join("\n"), new RegExp(`^${key} expected`));
  }
});

test("scene run provenance binds the resolved model, seed, package revision, and tarball bytes", () => {
  const root = tempWork();
  const tarballDir = join(root, "tarballs");
  mkdirSync(tarballDir);
  writeFileSync(join(tarballDir, "vgpu.tgz"), "branch package bytes");
  writeFileSync(join(tarballDir, "tarballs.json"), JSON.stringify({
    sourceKey: "source-key",
    gitSha: "0123456789abcdef",
    gitBranch: "scene-branch",
    tarballs: [{ name: "vgpu", version: "0.5.0", file: "vgpu.tgz" }],
  }));
  const provenance = collectSceneRunProvenance({
    VGPU_EVALS_MODEL: "anthropic/test-model",
    VGPU_EVALS_TASK_SEED_KEY: "seed-key",
    VGPU_EVALS_SOURCE_KEY: "source-key",
    VGPU_EVALS_SANDBOX: "docker",
    VGPU_EVALS_DOCKER_IMAGE: "example.invalid/eve@sha256:abc",
  }, tarballDir);
  assert.equal(provenance.model, "anthropic/test-model");
  assert.equal(provenance.contractRevision, "scene-evals-v1");
  assert.equal(provenance.seedKey, "seed-key");
  assert.equal(provenance.packedGitSha, "0123456789abcdef");
  assert.equal(provenance.eveVersion, "0.29.5");
  assert.equal(provenance.tarballs[0].sha256, "6b10c93bc4e9bc1cc735524ba3bc78ecb6203852ac529418f130e48f05d56d20");
  rmSync(root, { recursive: true, force: true });
});

test("malformed result JSON is an application contract failure, not a thrown infrastructure error", () => {
  const malformed = parseSceneResult("{ not-json");
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /not valid JSON/);
  assert.deepEqual(parseSceneResult('{"version":1}'), { ok: true, value: { version: 1 } });
});

test("warehouse controls declare the exact frames where cached count and missed publish become visible", async () => {
  const { assessControlCase, controlCases } = await import("../scripts/scene-controls.mjs");
  const cases = controlCases("scene-warehouse");
  const cached = cases.find((entry) => entry.fault === "cached-count");
  const missed = cases.find((entry) => entry.fault === "missed-publish");
  assert.deepEqual(cached?.expectedRejectingFrames, [3, 4]);
  assert.deepEqual(missed?.expectedRejectingFrames, [3]);
  assert.equal(cases.every((entry) => entry.fault === "positive" || entry.rejectChecks.length > 0), true);
  const statePass = { name: "warehouse-state", ok: true, metrics: { failingFrames: [] } };
  assert.equal(assessControlCase(cached, { outcome: "application-failure", checks: [statePass, { name: "warehouse-pixels", ok: false, metrics: { failingFrames: [3, 4] } }] }).ok, true);
  assert.equal(assessControlCase(cached, { outcome: "application-failure", checks: [statePass, { name: "warehouse-pixels", ok: false, metrics: { failingFrames: [2] } }] }).ok, false);
  assert.equal(assessControlCase(missed, { outcome: "application-failure", checks: [statePass, { name: "warehouse-pixels", ok: false, metrics: { failingFrames: [3] } }] }).ok, true);
});

function fakeSceneSandbox(files, fail) {
  return {
    async writeTextFile({ path, content }) { files.set(path, content); },
    async readTextFile({ path }) { return files.get(path) ?? null; },
    async run({ command }) {
      const failure = fail(command);
      if (failure) return failure;
      if (command.startsWith("find /workspace")) {
        const match = command.match(/> '([^']+)'$/);
        if (match) files.set(match[1], "source  hash\n");
      } else if (/runner\.mjs.*probe-config\.json/.test(command)) {
        const path = [...files.keys()].find((key) => key.endsWith("/probe-config.json"));
        const config = JSON.parse(files.get(path));
        files.set(config.resultPath, JSON.stringify({ exitCode: 0, timedOut: false, runtime: { node: "v24.fake", platform: "linux", arch: "arm64" } }));
      } else if (/runner\.mjs.*run-config\.json/.test(command)) {
        const path = [...files.keys()].find((key) => key.endsWith("/run-config.json"));
        const config = JSON.parse(files.get(path));
        files.set(config.resultPath, JSON.stringify({ exitCode: 0, timedOut: false, runtime: { node: "v24.fake", platform: "linux", arch: "arm64" } }));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}
