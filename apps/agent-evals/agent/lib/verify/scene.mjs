import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { sceneFixturePaths, sceneInputSha256 } from "../../../evals/lib/scene-contracts.mjs";

const SOURCE_COPY_EXCLUSIONS = [
  "node_modules", ".git", ".vgpu-tarballs", ".agent-evals", ".next", ".cache", ".work",
];
const SKIP_ROOT_DIRECTORIES = new Set(SOURCE_COPY_EXCLUSIONS);

export function sourceManifest(root) {
  const files = [];
  const hash = createHash("sha256");
  walkFiles(root, (file) => {
    const path = relative(root, file).split(sep).join("/");
    const bytes = readFileSync(file);
    files.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) hash.update(file.path).update("\0").update(file.sha256).update("\0");
  return { hash: hash.digest("hex"), files };
}

/**
 * Host-side fresh-source executor shared by native controls and lifecycle tests.
 * Expected state and grading deliberately stay outside this module.
 */
export async function executeFreshSource({
  sourceDir,
  input,
  nodeModulesDir,
  env = {},
  timeoutMs = 60_000,
  tempRoot = tmpdir(),
  healthProbe = async () => ({ ok: true }),
  execute = runChild,
  capture = captureOutput,
  cleanup = (directory) => rmSync(directory, { recursive: true, force: true }),
}) {
  const verificationDir = mkdtempSync(join(tempRoot, "vgpu-scene-"));
  const appDir = join(verificationDir, "app");
  const outputDir = join(verificationDir, "output");
  const inputPath = join(verificationDir, "input.json");
  const manifest = sourceManifest(sourceDir);
  let classification = "infrastructure-error";
  let reason;
  let execution;
  let health;
  let artifacts;
  try {
    mkdirSync(appDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    copySourceTree(sourceDir, appDir);
    const modules = nodeModulesDir ?? (existsSync(join(sourceDir, "node_modules")) ? join(sourceDir, "node_modules") : undefined);
    if (modules) symlinkSync(modules, join(appDir, "node_modules"), "dir");
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`, "utf8");

    try {
      health = await healthProbe({ verificationDir, appDir });
    } catch (error) {
      health = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!health?.ok) {
      classification = "infrastructure-error";
      reason = health?.reason ?? "native health probe failed";
    } else if (!existsSync(join(appDir, "render.mjs"))) {
      classification = "application-failure";
      reason = "render.mjs is missing from the submitted source";
    } else {
      execution = await execute(process.execPath, ["render.mjs", inputPath, outputDir], {
        cwd: appDir,
        timeoutMs,
        env,
        verificationDir,
        inputPath,
        outputDir,
      });
      if (execution.exitCode !== 0 || execution.timedOut) {
        classification = "application-failure";
        reason = execution.timedOut ? `submitted source exceeded ${timeoutMs}ms` : `submitted source exited ${execution.exitCode}`;
      } else {
        artifacts = await capture(outputDir);
        classification = "pass";
      }
    }
  } catch (error) {
    classification = "infrastructure-error";
    reason = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      cleanup(verificationDir);
    } catch (error) {
      classification = "infrastructure-error";
      reason = `verification cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    classification,
    reason,
    health,
    execution,
    artifacts,
    sourceHash: manifest.hash,
    sourceFiles: manifest.files,
    command: [process.execPath, "render.mjs", inputPath, outputDir],
    cwd: appDir,
  };
}

/**
 * Sandbox-side equivalent used by the turn hook. It returns an evidence tar
 * outside the temporary verification tree, then removes that tree before the
 * caller can permit a follow-up turn.
 */
export async function verifySceneInSandbox(sandbox, { taskId, stage, turnId, metaId, input, timeoutMs = 60_000 }) {
  const nonce = randomUUID();
  const verificationDir = `/var/tmp/vgpu-scene-${nonce}`;
  const appDir = `${verificationDir}/app`;
  const outputDir = `${verificationDir}/output`;
  const evidenceDir = `${verificationDir}/evidence`;
  const evidenceTarPath = `/tmp/vgpu-scene-evidence-${nonce}.tar`;
  const inputSha256 = sceneInputSha256(input);
  const metadata = { taskId, stage, turnId, metaId, inputSha256 };
  let cleanupOk = false;
  let classification = "infrastructure-error";
  let reason;
  let probe = null;
  let execution = null;
  let workspaceBefore = "";
  let workspaceAfter = "";

  try {
    await runChecked(sandbox, {
      command: `bash -o pipefail -c ${shellQuote([
        `mkdir -p ${shellQuote(appDir)} ${shellQuote(outputDir)} ${shellQuote(evidenceDir)}`,
        `tar -C /workspace ${SOURCE_COPY_EXCLUSIONS.map((name) => `--exclude=./${name}`).join(" ")} -cf - . | tar -C ${shellQuote(appDir)} -xf -`,
        `ln -s /workspace/node_modules ${shellQuote(`${appDir}/node_modules`)}`,
      ].join(" && "))}`,
    }, "source copy setup");
    workspaceBefore = await workspaceDigest(sandbox, verificationDir, "workspace-before.txt");
    await sandbox.writeTextFile({ path: `${verificationDir}/input.json`, content: `${JSON.stringify(input)}\n` });
    await sandbox.writeTextFile({ path: `${evidenceDir}/input.json`, content: `${JSON.stringify(input, null, 2)}\n` });
    await sandbox.writeTextFile({ path: `${verificationDir}/runner.mjs`, content: SANDBOX_RUNNER_SOURCE });
    const canaryPath = `${appDir}/.vgpu-scene-canary.mjs`;
    await sandbox.writeTextFile({ path: canaryPath, content: CANARY_SOURCE });

    const probeConfig = {
      cwd: appDir,
      command: "node",
      args: [".vgpu-scene-canary.mjs"],
      timeoutMs: Math.min(timeoutMs, 30_000),
      resultPath: `${evidenceDir}/probe-execution.json`,
    };
    await sandbox.writeTextFile({ path: `${verificationDir}/probe-config.json`, content: JSON.stringify(probeConfig) });
    await runChecked(sandbox, { command: `node ${shellQuote(`${verificationDir}/runner.mjs`)} ${shellQuote(`${verificationDir}/probe-config.json`)}` }, "native probe runner");
    probe = await readSandboxJson(sandbox, probeConfig.resultPath);
    // Harness code must not enter the submission source manifest or app run.
    await runChecked(sandbox, { command: `rm -f ${shellQuote(canaryPath)}` }, "native canary removal");
    if (probe?.exitCode !== 0 || probe?.timedOut) {
      classification = "infrastructure-error";
      reason = probe?.timedOut ? "native health probe timed out" : `native health probe exited ${probe?.exitCode ?? "unknown"}`;
    } else {
      const runConfig = {
        cwd: appDir,
        command: "node",
        args: ["render.mjs", `${verificationDir}/input.json`, outputDir],
        timeoutMs,
        resultPath: `${evidenceDir}/execution.json`,
      };
      await sandbox.writeTextFile({ path: `${verificationDir}/run-config.json`, content: JSON.stringify(runConfig) });
      await runChecked(sandbox, { command: `node ${shellQuote(`${verificationDir}/runner.mjs`)} ${shellQuote(`${verificationDir}/run-config.json`)}` }, "submitted source runner");
      execution = await readSandboxJson(sandbox, runConfig.resultPath);
      if (!execution || !Object.hasOwn(execution, "exitCode")) {
        throw new Error("submitted source runner execution record is missing or invalid");
      }
      if (execution?.exitCode !== 0 || execution?.timedOut) {
        classification = "application-failure";
        reason = execution?.timedOut ? `submitted source exceeded ${timeoutMs}ms` : `submitted source exited ${execution?.exitCode ?? "unknown"}`;
      } else {
        classification = "pass";
      }
      await runChecked(sandbox, {
        command: `mkdir -p ${shellQuote(`${evidenceDir}/output`)} && cp -a ${shellQuote(`${outputDir}/.`)} ${shellQuote(`${evidenceDir}/output/`)}`,
      }, "output evidence copy");
    }

    await runChecked(sandbox, {
      command: `bash -o pipefail -c ${shellQuote([
        `find ${shellQuote(appDir)} -type f -print0 | sort -z | xargs -0 -r sha256sum > ${shellQuote(`${evidenceDir}/source-manifest.txt`)}`,
        fixtureDigestCommand(taskId, appDir, `${evidenceDir}/fixture-sha256.txt`),
      ].join(" && "))}`,
    }, "source evidence manifest");
    workspaceAfter = await workspaceDigest(sandbox, verificationDir, "workspace-after.txt");
  } catch (error) {
    classification = "infrastructure-error";
    reason = error instanceof Error ? error.message : String(error);
    await bestEffortRun(sandbox, `mkdir -p ${shellQuote(evidenceDir)}`);
  }

  const verdict = {
    ...metadata,
    classification,
    reason,
    command: ["node", "render.mjs", `${verificationDir}/input.json`, outputDir],
    cwd: appDir,
    timeoutMs,
    probe,
    execution,
    hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    sandboxRuntime: execution?.runtime ?? probe?.runtime ?? null,
    sourceCopyExclusions: SOURCE_COPY_EXCLUSIONS.map((name) => `./${name}`),
    workspaceMutationObserved: workspaceBefore !== workspaceAfter,
    limitations: [
      "The source rerun is bounded and non-adversarial; it does not attest GPU provenance.",
      "Absolute writes to /workspace are only observed by before/after manifests and are not prevented.",
    ],
  };
  try {
    await sandbox.writeTextFile({ path: `${evidenceDir}/verdict.json`, content: `${JSON.stringify(verdict, null, 2)}\n` });
    await runChecked(sandbox, { command: `tar -cf ${shellQuote(evidenceTarPath)} -C ${shellQuote(evidenceDir)} .` }, "evidence export");
  } catch (error) {
    classification = "infrastructure-error";
    reason = `evidence export failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      const cleanup = await sandbox.run({ command: `rm -rf ${shellQuote(verificationDir)} && test ! -e ${shellQuote(verificationDir)}` });
      cleanupOk = cleanup.exitCode === 0;
      if (!cleanupOk) {
        classification = "infrastructure-error";
        reason = `verification cleanup failed (exit ${cleanup.exitCode}): ${tail(cleanup.stderr ?? cleanup.stdout ?? "")}`;
      }
    } catch (error) {
      cleanupOk = false;
      classification = "infrastructure-error";
      reason = `verification cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { evidenceTarPath, cleanupOk, removedPath: verificationDir, classification, reason, metadata };
}

function fixtureDigestCommand(taskId, appDir, destination) {
  const paths = sceneFixturePaths(taskId);
  if (paths.length === 0) return `: > ${shellQuote(destination)}`;
  const checks = paths.map((path) =>
    `if [ -f ${shellQuote(path)} ]; then sha256sum ${shellQuote(path)}; else printf 'MISSING  %s\\n' ${shellQuote(path)}; fi`);
  return `cd ${shellQuote(appDir)} && { ${checks.join("; ")}; } > ${shellQuote(destination)}`;
}

function walkFiles(root, visit, current = root) {
  if (!existsSync(current)) return;
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (current === root && entry.isDirectory() && SKIP_ROOT_DIRECTORIES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, visit, path);
    else if (entry.isFile()) visit(path);
  }
}

function copySourceTree(source, destination, root = source) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (source === root && entry.isDirectory() && SKIP_ROOT_DIRECTORIES.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copySourceTree(from, to, root);
    } else if (entry.isFile() && !lstatSync(from).isSymbolicLink()) {
      copyFileSync(from, to);
    }
  }
}

function runChild(command, args, { cwd, timeoutMs, env = {} }) {
  return new Promise((resolve) => {
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
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-65_536); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, elapsedMs: Date.now() - startedAt, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, elapsedMs: Date.now() - startedAt, stdout, stderr });
    });
  });
}

function captureOutput(outputDir) {
  const files = {};
  walkFiles(outputDir, (file) => { files[relative(outputDir, file).split(sep).join("/")] = readFileSync(file); });
  return files;
}

async function workspaceDigest(sandbox, verificationDir, name) {
  const path = `${verificationDir}/${name}`;
  await runChecked(sandbox, {
    command: `bash -o pipefail -c ${shellQuote(`find /workspace -path /workspace/node_modules -prune -o -path /workspace/.git -prune -o -path /workspace/.vgpu-tarballs -prune -o -path /workspace/.agent-evals -prune -o -type f -print0 | sort -z | xargs -0 -r sha256sum > ${shellQuote(path)}`)}`,
  }, "workspace mutation digest");
  const text = await sandbox.readTextFile({ path, encoding: "utf-8" });
  return text ?? "";
}

async function readSandboxJson(sandbox, path) {
  const text = await sandbox.readTextFile({ path, encoding: "utf-8" });
  return text ? JSON.parse(text) : null;
}

async function bestEffortRun(sandbox, command) {
  try {
    await sandbox.run({ command });
  } catch {
    // The caller records the original infrastructure error.
  }
}

async function runChecked(sandbox, options, label) {
  const result = await sandbox.run(options);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${tail(result.stderr ?? result.stdout ?? "")}`);
  }
  return result;
}

function tail(value) {
  return String(value).slice(-4_096);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const SANDBOX_RUNNER_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const startedAt = Date.now();
let stdout = "";
let stderr = "";
let timedOut = false;
let settled = false;
const child = spawn(config.command, config.args, { cwd: config.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}, config.timeoutMs);
const result = await new Promise((resolve) => {
  child.on("error", (error) => resolve({ exitCode: null, signal: null, error: error.message }));
  child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
clearTimeout(timer);
await writeFile(config.resultPath, JSON.stringify({
  ...result,
  timedOut,
  elapsedMs: Date.now() - startedAt,
  stdout,
  stderr,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
}, null, 2));
`;

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
  console.log(JSON.stringify({ pixel }));
} finally {
  gpu.dispose();
}
`;
