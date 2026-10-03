#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import { executeFreshSource } from "../agent/lib/verify/scene.mjs";
import { validatePackedArtifacts } from "../agent/lib/scene-auth.mjs";
import { taskSeedDir, tarballsDir, workDir } from "../agent/lib/paths.ts";
import { gradeSceneOutput } from "../evals/lib/grade-scene.mjs";
import { gradeSceneInterop } from "../evals/lib/scene-interop.mjs";
import { gradeSceneKeyframes } from "../evals/lib/scene-keyframes.mjs";
import { sceneContract, sceneInputSha256 } from "../evals/lib/scene-contracts.mjs";
import { sceneFixturePaths } from "../evals/lib/scene-contracts.mjs";
import { sourceKey } from "./pack-vgpu.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROL_ROOT = join(PACKAGE_ROOT, "controls");
const DOCKER_APT_PACKAGES = [
  "libvulkan1", "libdrm2", "zlib1g", "libzstd1", "libudev1", "mesa-vulkan-drivers",
];

const CASES = Object.freeze({
  "scene-robot-arm": [
    { fault: "positive", rejectChecks: [] },
    { fault: "reverse-order", rejectChecks: ["robot-matrices", "robot-pixels"] },
    { fault: "no-descendant-propagation", rejectChecks: ["robot-matrices", "robot-pixels"] },
    { fault: "frozen-image", rejectChecks: ["robot-pixels"], requirePassingChecks: ["robot-matrices"] },
  ],
  "scene-shader-bindings": [
    { fault: "positive", rejectChecks: [] },
    { fault: "omit-uniform-upload", rejectChecks: ["shader-pixels"], requirePassingChecks: ["shader-state"] },
    { fault: "previous-camera", rejectChecks: ["shader-pixels"], requirePassingChecks: ["shader-state"] },
    { fault: "wrong-style", rejectChecks: ["shader-pixels"], requirePassingChecks: ["shader-state"] },
  ],
  "scene-warehouse": [
    { fault: "positive", rejectChecks: [] },
    { fault: "packed-slot-identity", rejectChecks: ["warehouse-state", "warehouse-pixels"] },
    { fault: "cached-count", rejectChecks: ["warehouse-pixels"], expectedRejectingFrames: [3, 4] },
    { fault: "missed-publish", rejectChecks: ["warehouse-pixels"], expectedRejectingFrames: [3], requirePassingChecks: ["warehouse-state"] },
    { fault: "index-ids", rejectChecks: ["warehouse-pixels"] },
    { fault: "retain-deleted", rejectChecks: ["warehouse-state", "warehouse-pixels"] },
  ],
  "scene-math-interop": [
    { fault: "positive", rejectChecks: [] },
    { fault: "reverse-order", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [1, 2, 3, 4], requirePassingChecks: ["interop-state"] },
    { fault: "double-parent", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [1, 2, 3, 4], requirePassingChecks: ["interop-state"] },
    { fault: "shear-loss", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [1, 2, 3, 4], requirePassingChecks: ["interop-state"] },
    { fault: "ortho-no", stage: 1, rejectChecks: ["interop-state", "interop-pixels"], expectedRejectingFrames: [1, 2, 3, 4] },
    { fault: "stale-camera", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [3], requirePassingChecks: ["interop-state"] },
    { fault: "descendant-update-omission", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [2, 3], requirePassingChecks: ["interop-state"] },
    { fault: "missed-publish", stage: 1, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [2, 3], requirePassingChecks: ["interop-state"] },
    { fault: "turn1-only", stage: 2, rejectChecks: ["source-execution"] },
    { fault: "key-as-row", stage: 2, rejectChecks: ["interop-state", "interop-pixels"], expectedRejectingFrames: [3, 4] },
    { fault: "orphan-instances", stage: 2, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [2, 3, 4], requirePassingChecks: ["interop-state"] },
    { fault: "camera-local", stage: 2, rejectChecks: ["interop-state", "interop-pixels"], expectedRejectingFrames: [2, 3, 4] },
    { fault: "cached-count", stage: 2, rejectChecks: ["interop-pixels"], expectedRejectingFrames: [4], requirePassingChecks: ["interop-state"] },
  ],
  "scene-quaternion-keyframes": [
    { fault: "handwritten", positive: true, stages: [1, 2], rejectChecks: [] },
    { fault: "math", positive: true, stages: [1, 2], rejectChecks: [] },
    { fault: "wgpu-matrix", positive: true, stages: [1, 2], rejectChecks: [] },
    { fault: "sphere", positive: true, stages: [1, 2], rejectChecks: [] },
    { fault: "nlerp", stages: [1, 2], rejectChecks: ["state"] },
    { fault: "euler-xyz-lerp", stages: [1, 2], rejectChecks: ["state", "pixels"] },
    { fault: "index-uniform-time", stages: [1, 2], rejectChecks: ["state"] },
    { fault: "transposed-world", stages: [1, 2], rejectChecks: ["state"] },
    { fault: "wxyz-misread", stages: [1, 2], rejectChecks: ["state"] },
    {
      fault: "long-arc",
      stages: [1, 2],
      stageExpectations: {
        1: { expectPass: true, rejectChecks: [] },
        2: { rejectChecks: ["state", "pixels"], expectedRejectingFrames: [4, 5, 6, 8, 9] },
      },
    },
    {
      fault: "no-clamp",
      stages: [1, 2],
      stageExpectations: {
        1: { expectPass: true, rejectChecks: [] },
        2: { rejectChecks: ["state", "pixels"], expectedRejectingFrames: [1, 11] },
      },
    },
    { fault: "stale-publish", stages: [1, 2], rejectChecks: ["pixels"], requirePassingChecks: ["state"] },
    { fault: "frame0-png-reuse", stages: [1, 2], rejectChecks: ["pixels"], requirePassingChecks: ["state"] },
    { fault: "swap-red-green", stages: [1, 2], rejectChecks: ["pixels"], requirePassingChecks: ["state"] },
  ],
});

export function controlCases(taskId) {
  const cases = CASES[taskId];
  if (!cases) throw new TypeError(`unknown scene task ${JSON.stringify(taskId)}`);
  return structuredClone(cases);
}

export function assessControlCase(control, grade) {
  if (control.positive || control.expectPass || control.fault === "positive") {
    return grade?.outcome === "pass"
      ? { ok: true }
      : { ok: false, reason: `positive control graded ${grade?.outcome ?? "without an outcome"}` };
  }
  const checks = new Map((grade?.checks ?? []).map((check) => [check.name, check]));
  const rejected = control.rejectChecks.filter((name) => checks.get(name)?.ok === false);
  if (grade?.outcome !== "application-failure" || rejected.length === 0) {
    return { ok: false, reason: `fault ${control.fault} was not rejected by ${control.rejectChecks.join(", ")}` };
  }
  const requiredFailure = control.requirePassingChecks?.find((name) => checks.get(name)?.ok !== true);
  if (requiredFailure) return { ok: false, reason: `${requiredFailure} was expected to remain passing` };
  if (control.expectedRejectingFrames) {
    const observed = rejected.flatMap((name) => checks.get(name)?.metrics?.failingFrames ?? []);
    const unique = [...new Set(observed)].sort((a, b) => a - b);
    if (JSON.stringify(unique) !== JSON.stringify(control.expectedRejectingFrames)) {
      return { ok: false, reason: `expected rejecting frames ${control.expectedRejectingFrames.join(",")}, got ${unique.join(",")}` };
    }
  }
  return { ok: true, rejectedChecks: rejected };
}

export async function runSceneControls({ taskId, backendName = "host", dockerImage = process.env.VGPU_EVALS_DOCKER_IMAGE } = {}) {
  const cases = controlCases(taskId);
  if (backendName !== "host" && backendName !== "docker") throw new TypeError(`unknown backend ${JSON.stringify(backendName)}`);
  if (backendName === "docker" && !dockerImage) throw environmentError("docker controls require VGPU_EVALS_DOCKER_IMAGE");

  const packed = validatePackedArtifacts(join(tarballsDir(), "tarballs.json"), sourceKey());
  if (!packed.ok) throw environmentError(`packed branch artifacts are unavailable: ${packed.reason}`);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = join(workDir(), "scene-controls", runId, taskId);
  const sourceDir = join(runDir, "source");
  const installDir = join(runDir, "install");
  const stagedTarballsDir = join(runDir, "tarballs");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(stagedTarballsDir, { recursive: true });
  mkdirSync(join(runDir, "temporary"), { recursive: true });
  stageControlSource(taskId, sourceDir);
  const stagedTarballs = packed.manifest.tarballs.map((entry) => {
    const path = join(stagedTarballsDir, entry.file);
    copyFileSync(join(tarballsDir(), entry.file), path);
    return { ...entry, path, sha256: sha256(readFileSync(path)) };
  });
  writeJson(join(installDir, "package.json"), { private: true, type: "module" });

  const summary = {
    revision: "scene-controls-v1",
    runId,
    taskId,
    backend: backendName,
    sourceKey: packed.manifest.sourceKey,
    packedGitSha: packed.manifest.gitSha,
    packedGitBranch: packed.manifest.gitBranch,
    tarballs: stagedTarballs.map(({ name, version, file, sha256: digest }) => ({ name, version, file, sha256: digest })),
    hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    dockerImage: backendName === "docker" ? dockerImage : null,
    startedAt: new Date().toISOString(),
    runDir,
    environment: null,
    cases: [],
  };
  writeJson(join(runDir, "summary.json"), summary);

  let backend;
  try {
    backend = backendName === "host"
      ? await createHostBackend({ taskId, installDir, stagedTarballs })
      : await createDockerBackend({ taskId, installDir, runDir, stagedTarballs, image: dockerImage });
    summary.environment = backend.environment;
    writeJson(join(runDir, "environment.json"), backend.environment);
    writeJson(join(runDir, "summary.json"), summary);

    const schedule = cases.flatMap((control, index) => {
      const stages = control.stages ?? (index === 0 ? [1, 2] : [control.stage ?? 2]);
      return stages.map((stage) => ({
        control: {
          ...control,
          ...(control.stageExpectations?.[stage] ?? {}),
        },
        stage,
      }));
    });
    let infrastructureFailure = false;
    let unexpectedResult = false;
    for (const { control, stage } of schedule) {
      const record = await runControlCase({ taskId, stage, control, sourceDir, installDir, runDir, backend });
      summary.cases.push(record);
      if (record.transport.classification === "infrastructure-error" || record.grade.outcome === "infrastructure-error") infrastructureFailure = true;
      else if (!record.assessment.ok) unexpectedResult = true;
      writeJson(join(runDir, "summary.json"), { ...summary, updatedAt: new Date().toISOString() });
      if (infrastructureFailure) break;
    }
    const exitCode = infrastructureFailure ? 2 : unexpectedResult ? 1 : 0;
    Object.assign(summary, {
      completedAt: new Date().toISOString(),
      outcome: exitCode === 0 ? "pass" : infrastructureFailure ? "infrastructure-error" : "unexpected-control-result",
      exitCode,
    });
    writeJson(join(runDir, "summary.json"), summary);
    return { exitCode, runDir, summary };
  } catch (error) {
    Object.assign(summary, {
      completedAt: new Date().toISOString(),
      outcome: error?.code === "SCENE_CONTROL_ENVIRONMENT" ? "infrastructure-error" : "unexpected-control-result",
      exitCode: error?.code === "SCENE_CONTROL_ENVIRONMENT" ? 2 : 1,
      error: error instanceof Error ? error.message : String(error),
    });
    writeJson(join(runDir, "summary.json"), summary);
    return { exitCode: summary.exitCode, runDir, summary };
  } finally {
    await backend?.dispose();
  }
}

async function runControlCase({ taskId, stage, control, sourceDir, installDir, runDir, backend }) {
  const contract = sceneContract(taskId, stage);
  const label = `${control.fault}-stage-${stage}`;
  const caseDir = join(runDir, "cases", label);
  mkdirSync(caseDir, { recursive: true });
  writeJson(join(caseDir, "input.json"), contract.input);
  const transport = await executeFreshSource({
    sourceDir,
    input: contract.input,
    nodeModulesDir: join(installDir, "node_modules"),
    tempRoot: join(runDir, "temporary"),
    env: {
      VGPU_SCENE_CONTROL_TASK: taskId,
      VGPU_SCENE_CONTROL_FAULT: control.fault,
    },
    healthProbe: ({ appDir }) => nativeHealthProbe(backend, appDir),
    execute: (_command, args, options) => backend.runNode(args, options),
  });
  writeJson(join(caseDir, "transport.json"), serializableTransport(transport));
  if (transport.artifacts) writeArtifacts(join(caseDir, "output"), transport.artifacts);

  let grade;
  if (transport.classification !== "pass") {
    grade = {
      outcome: transport.classification === "application-failure" ? "application-failure" : "infrastructure-error",
      checks: [{ name: "source-execution", ok: false, metrics: { reason: transport.reason } }],
    };
  } else {
    const parsed = parseResult(transport.artifacts?.["result.json"]);
    if (!parsed.ok) {
      grade = { outcome: "application-failure", checks: [{ name: "output-contract", ok: false, metrics: { reason: parsed.reason } }] };
    } else {
      const fixtureUnchanged = sceneFixturePaths(taskId).every((path) =>
        sha256(readFileSync(join(sourceDir, path))) === sha256(readFileSync(join(taskSeedDir(taskId), path))));
      const gradeControl = taskId === "scene-math-interop"
        ? gradeSceneInterop
        : taskId === "scene-quaternion-keyframes"
          ? gradeSceneKeyframes
          : gradeSceneOutput;
      grade = await gradeControl({
        ...contract,
        result: parsed.value,
        fixtureUnchanged,
        fixturesUnmodified: fixtureUnchanged,
        readPng: async (path) => {
          const bytes = transport.artifacts?.[path];
          if (!bytes) throw new Error(`${path} is missing from fresh output`);
          return PNG.sync.read(bytes);
        },
      });
    }
  }
  const assessment = transport.classification === "infrastructure-error"
    ? { ok: false, reason: transport.reason ?? "native transport failed" }
    : assessControlCase(control, grade);
  const artifactHashes = Object.fromEntries(Object.entries(transport.artifacts ?? {}).map(([path, bytes]) => [path, sha256(bytes)]));
  const record = {
    label,
    fault: control.fault,
    stage,
    inputSha256: sceneInputSha256(contract.input),
    intendedRejectChecks: control.rejectChecks,
    expectedRejectingFrames: control.expectedRejectingFrames ?? null,
    transport: serializableTransport(transport),
    grade,
    assessment,
    artifactHashes,
  };
  writeJson(join(caseDir, "grade.json"), record);
  return record;
}

function stageControlSource(taskId, destination) {
  const reference = taskId === "scene-math-interop"
    ? "scene-interop-reference.mjs"
    : taskId === "scene-quaternion-keyframes"
      ? "scene-keyframes-reference.mjs"
      : "scene-reference.mjs";
  copyFileSync(join(CONTROL_ROOT, reference), join(destination, "render.mjs"));
  copyFileSync(join(CONTROL_ROOT, "scene-reference.wgsl"), join(destination, "scene-reference.wgsl"));
  if (taskId === "scene-quaternion-keyframes") {
    copyFileSync(join(CONTROL_ROOT, "scene-keyframes-sphere.wgsl"), join(destination, "scene-keyframes-sphere.wgsl"));
  }
  writeJson(join(destination, "package.json"), { private: true, type: "module" });
  if (taskId === "scene-shader-bindings") {
    copyFileSync(join(taskSeedDir(taskId), "integration.wgsl"), join(destination, "integration.wgsl"));
  }
  if (taskId === "scene-math-interop") cpSync(join(taskSeedDir(taskId), "ecs"), join(destination, "ecs"), { recursive: true });
}

async function createHostBackend({ taskId, installDir, stagedTarballs }) {
  const npmEnv = { npm_config_cache: join(installDir, ".npm-cache") };
  const install = await runProcess("npm", [
    "install", "--no-audit", "--no-fund", "--loglevel=error",
    ...stagedTarballs.map((entry) => entry.path), "pngjs", ...controlInstallSpecs(taskId),
  ], { cwd: installDir, timeoutMs: 180_000, env: npmEnv });
  if (install.exitCode !== 0 || install.timedOut) throw environmentError(`host dependency install failed: ${install.stderr || install.stdout}`);
  const doctor = await runProcess(join(installDir, "node_modules", ".bin", "vgpu"), ["doctor"], { cwd: installDir, timeoutMs: 60_000 });
  return {
    environment: { install, doctor, runtime: { node: process.version, platform: process.platform, arch: process.arch } },
    runNode(args, options) { return runProcess(process.execPath, args, options); },
    async dispose() {},
  };
}

async function createDockerBackend({ taskId, installDir, runDir, stagedTarballs, image }) {
  const name = `vgpu-scene-${randomUUID().slice(0, 12)}`;
  const controlsRoot = join(workDir(), "scene-controls");
  const sharedNpmCache = join(controlsRoot, ".npm-cache-docker");
  mkdirSync(sharedNpmCache, { recursive: true });
  const start = await runProcess("docker", [
    "run", "-d", "--rm", "--name", name,
    "-v", `${controlsRoot}:${controlsRoot}`,
    "-w", installDir,
    image,
    "sh", "-lc", "while :; do sleep 3600; done",
  ], { cwd: runDir, timeoutMs: 60_000 });
  if (start.exitCode !== 0 || start.timedOut) throw environmentError(`docker control container failed to start: ${start.stderr || start.stdout}`);
  const exec = (args, options = {}) => runProcess("docker", ["exec", ...(options.user ? ["-u", options.user] : []), "-w", options.cwd ?? installDir, ...envArgs(options.env), name, ...args], {
    cwd: runDir,
    timeoutMs: options.timeoutMs ?? 180_000,
  });
  try {
    const npmEnv = { npm_config_cache: sharedNpmCache };
    const install = await exec(["npm", "install", "--no-audit", "--no-fund", "--loglevel=error", ...stagedTarballs.map((entry) => entry.path), "pngjs", ...controlInstallSpecs(taskId)], { env: npmEnv, timeoutMs: 600_000 });
    if (install.exitCode !== 0 || install.timedOut) {
      throw environmentError(`docker dependency install failed: ${JSON.stringify({ exitCode: install.exitCode, timedOut: install.timedOut, elapsedMs: install.elapsedMs, stderr: install.stderr, stdout: install.stdout })}`);
    }
    const doctorAttempts = [];
    doctorAttempts.push(await exec(["npx", "vgpu", "doctor"], { timeoutMs: 60_000 }));
    if (doctorAttempts.at(-1).exitCode !== 0) {
      doctorAttempts.push(await exec(["npx", "vgpu", "install-software-renderer"], { timeoutMs: 180_000 }));
      doctorAttempts.push(await exec(["npx", "vgpu", "doctor"], { timeoutMs: 60_000 }));
    }
    if (doctorAttempts.at(-1).exitCode !== 0) {
      doctorAttempts.push(await exec(["apt-get", "update"], { user: "0", cwd: "/", timeoutMs: 180_000 }));
      doctorAttempts.push(await exec(["apt-get", "install", "-y", ...DOCKER_APT_PACKAGES], { user: "0", cwd: "/", timeoutMs: 300_000 }));
      doctorAttempts.push(await exec(["npx", "vgpu", "doctor"], { timeoutMs: 60_000 }));
    }
    const identity = await runProcess("docker", ["image", "inspect", image, "--format", "{{json .RepoDigests}} {{.Id}}"], { cwd: runDir, timeoutMs: 30_000 });
    const runtime = await exec(["node", "-p", "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch})"], { timeoutMs: 30_000 });
    return {
      environment: { image, identity, install, doctorAttempts, runtime },
      runNode(args, options) { return exec(["node", ...args], options); },
      async dispose() { await runProcess("docker", ["rm", "-f", name], { cwd: runDir, timeoutMs: 30_000 }); },
    };
  } catch (error) {
    await runProcess("docker", ["rm", "-f", name], { cwd: runDir, timeoutMs: 30_000 });
    throw error;
  }
}

function controlInstallSpecs(taskId) {
  return taskId === "scene-math-interop" || taskId === "scene-quaternion-keyframes"
    ? ["math@0.1.0"]
    : [];
}

async function nativeHealthProbe(backend, appDir) {
  const path = join(appDir, ".vgpu-scene-canary.mjs");
  writeFileSync(path, CANARY_SOURCE);
  try {
    const execution = await backend.runNode([path], { cwd: appDir, timeoutMs: 30_000, env: {} });
    let observed = null;
    try { observed = JSON.parse(execution.stdout.trim().split("\n").at(-1)); } catch {}
    return {
      ok: execution.exitCode === 0 && !execution.timedOut,
      reason: execution.exitCode === 0 && !execution.timedOut ? undefined : execution.stderr || execution.stdout || "native canary failed",
      execution,
      observed,
    };
  } finally {
    rmSync(path, { force: true });
  }
}

function runProcess(command, args, { cwd, timeoutMs = 60_000, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-262_144); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-262_144); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    let settled = false;
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        command: [command, ...args],
        exitCode,
        signal,
        timedOut,
        elapsedMs: Date.now() - startedAt,
        stdout,
        stderr: spawnError ? `${stderr}${spawnError.message}` : stderr,
      });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (exitCode, signal) => finish(exitCode, signal));
  });
}

function parseResult(bytes) {
  if (!bytes) return { ok: false, reason: "result.json is missing" };
  try { return { ok: true, value: JSON.parse(bytes.toString("utf8")) }; }
  catch (error) { return { ok: false, reason: `result.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
}

function writeArtifacts(directory, artifacts) {
  for (const [path, bytes] of Object.entries(artifacts)) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function serializableTransport(transport) {
  return {
    classification: transport.classification,
    reason: transport.reason,
    health: transport.health,
    execution: transport.execution,
    sourceHash: transport.sourceHash,
    sourceFiles: transport.sourceFiles,
    command: transport.command,
    cwd: transport.cwd,
  };
}

function envArgs(env = {}) {
  return Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function environmentError(message) {
  const error = new Error(message);
  error.code = "SCENE_CONTROL_ENVIRONMENT";
  return error;
}

const CANARY_SOURCE = String.raw`
import { frame, init, target } from "vgpu/node";
const gpu = await init();
try {
  const output = target(gpu, { size: [4, 4], format: "rgba8unorm" });
  frame(gpu, (current) => current.pass({ target: output, clear: [0.25, 0.5, 0.75, 1] }, () => {}));
  const bytes = await output.color.read({ mipLevel: 0, region: "all" });
  const pixel = Array.from(bytes.subarray(0, 4));
  if (pixel[0] < 62 || pixel[0] > 66 || pixel[1] < 126 || pixel[1] > 130 || pixel[2] < 189 || pixel[2] > 193 || pixel[3] !== 255) {
    throw new Error("native clear/read returned unexpected bytes: " + pixel.join(","));
  }
  console.log(JSON.stringify({ pixel, runtime: { node: process.version, platform: process.platform, arch: process.arch } }));
} finally {
  gpu.dispose();
}
`;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: {
        task: { type: "string" },
        backend: { type: "string", default: "host" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
    if (options.help) {
      process.stdout.write("Usage: node apps/agent-evals/scripts/scene-controls.mjs --task <scene-task-id> [--backend host|docker]\n");
    } else {
      if (!options.task) throw new TypeError("--task is required");
      const result = await runSceneControls({ taskId: options.task, backendName: options.backend });
      process.stdout.write(`scene-controls: ${result.summary.outcome} (${result.runDir})\n`);
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    process.stderr.write(`scene-controls: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "SCENE_CONTROL_ENVIRONMENT" ? 2 : 1;
  }
}
