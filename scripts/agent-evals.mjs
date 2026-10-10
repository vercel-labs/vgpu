#!/usr/bin/env node
// Entry point for `pnpm agent-evals`.
//
// Dependency-free on purpose (only node: builtins): its first job is to run
// correctly BEFORE anything workspace-specific is guaranteed to work on the
// current Node version.
//
// It does four things in order:
//   1. resolve --task, which is required — one process runs exactly one task;
//   2. preflight the Node version — `eve` needs 24+, this repo pins 22;
//   3. preflight the model provider when one was named explicitly;
//   4. pack this branch's vgpu into tarballs, then run the eval against them.
//
// Step 2 is not a convenience. The whole point of the tool is to exercise the
// vgpu in the working tree; running the evals against a stale (or absent)
// tarball set would silently measure the previous build.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  consumeSceneLauncherArgs,
  isSceneTask,
  resolveSceneTarballsDir,
  validatePackedArtifacts,
  validateSceneAuth,
} from "../apps/agent-evals/agent/lib/scene-auth.mjs";
import { sourceKey } from "../apps/agent-evals/scripts/pack-vgpu.mjs";
import {
  parseSceneExperimentEnv,
  prepareSceneGuidanceExperiment,
  validatePreparedSceneGuidanceVariant,
  validateSceneExperimentRuntime,
} from "../apps/agent-evals/scripts/scene-guidance.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = join(REPO_ROOT, "apps", "agent-evals");
const REQUIRED_MAJOR = 24;
// Exit 2, not 1, so an unusable environment is distinguishable from "the evals
// ran and something failed" (which `eve eval` reports as exit 1).
const EXIT_ENVIRONMENT = 2;
const EXIT_WRONG_NODE = EXIT_ENVIRONMENT;

const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (!Number.isInteger(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    [
      `pnpm agent-evals: Node.js >= ${REQUIRED_MAJOR} is required, but this is v${process.versions.node}.`,
      "",
      "  apps/agent-evals is driven by `eve`, which requires Node 24+. The rest of",
      "  this repo pins Node 22 on purpose, so switch Node just for this command:",
      "",
      `      nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR} && pnpm agent-evals`,
      "",
      "  You also need an AI Gateway credential (AI_GATEWAY_API_KEY or",
      "  VERCEL_OIDC_TOKEN) and a working Docker daemon.",
      "  See apps/agent-evals/README.md.",
      "",
    ].join("\n"),
  );
  process.exit(EXIT_WRONG_NODE);
}

// ---- Which task? ------------------------------------------------------------
//
// Required, with no "run everything" default. `defineSandbox`'s configuration is
// evaluated once per process and shared by every eval in it, and the tasks now
// need different seeds and different bootstrap work — so one process runs one
// task. A silent 30-minute default would be worse than being asked.
//
// One flag drives BOTH the environment variable the sandbox reads and the eval
// filter, so the two can never disagree about what is running.
const TASKS_DIR = join(PACKAGE_DIR, "agent", "sandbox", "tasks");
const VGPU_SCENE_SKILL_PATH = join(REPO_ROOT, "skills", "vgpu", "scene.md");
const VGPU_SKILL_PATH = join(REPO_ROOT, "skills", "vgpu", "SKILL.md");
const VGPU_SKILL_GENERATOR_PATH = join(REPO_ROOT, "packages", "vgpu", "lib", "docs", "generate", "skill.js");

function knownTasks() {
  try {
    return readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function usage(problem) {
  const tasks = knownTasks();
  const lines = tasks.length
    ? tasks.map((task) => {
        const evalFile = join(PACKAGE_DIR, "evals", `${task}.eval.ts`);
        return `      --task ${task}${existsSync(evalFile) ? "" : "   (no evals/" + task + ".eval.ts yet)"}`;
      })
    : ["      (no task directories found under agent/sandbox/tasks/)"];
  process.stderr.write(
    [`pnpm agent-evals: ${problem}`, "", "  Available tasks:", ...lines, "", `      pnpm agent-evals --task ${tasks[0] ?? "<id>"}`, ""].join("\n"),
  );
  process.exit(EXIT_ENVIRONMENT);
}

const { taskId, skipPack, forwarded } = consumeSceneLauncherArgs(process.argv.slice(2));
let sceneExperiment;
try {
  sceneExperiment = parseSceneExperimentEnv(process.env);
} catch (error) {
  usage(error.message);
}

if (!taskId) usage("--task <id> is required.");
if (!knownTasks().includes(taskId)) usage(`unknown task "${taskId}".`);
if (["scene-math-interop", "scene-quaternion-keyframes"].includes(taskId) && sceneExperiment.variant !== null) {
  usage(`${taskId} does not participate in the scene guidance experiment.`);
}
if (!isSceneTask(taskId) && (sceneExperiment.variant !== null || sceneExperiment.repetitions !== 1)) {
  usage("VGPU_EVALS_SCENE_GUIDANCE and VGPU_EVALS_SCENE_REPETITIONS apply only to scene evals.");
}
if (skipPack && !isSceneTask(taskId)) usage("--skip-pack is available only for scene evals.");
if (isSceneTask(taskId) && !skipPack) {
  usage("scene evals require a Node 22 pack followed by this Node 24 launcher with --skip-pack.");
}
const evalFile = join("evals", `${taskId}.eval.ts`);
if (!existsSync(join(PACKAGE_DIR, evalFile))) usage(`task "${taskId}" has a seed directory but no ${evalFile}.`);

process.env.VGPU_EVALS_TASK = taskId;
// Absolute, because bootstrap reads the seed files from the runtime process,
// where a path derived from a module URL lands inside eve's dev-runtime snapshot.
process.env.VGPU_EVALS_TASKS_DIR ??= TASKS_DIR;

// Scene runs are project-OIDC only. This check happens before provider
// preflight, packing, or Eve spawn and never logs credential contents.
const sceneAuth = validateSceneAuth(taskId, process.env);
if (!sceneAuth.ok) {
  process.stderr.write(`pnpm agent-evals: ${sceneAuth.reason}.\nNothing was packed, fetched, or started.\n`);
  process.exit(EXIT_ENVIRONMENT);
}
try {
  validateSceneExperimentRuntime(sceneExperiment, process.env);
} catch (error) {
  process.stderr.write(`pnpm agent-evals: ${error.message}.\nNothing was packed, fetched, or started.\n`);
  process.exit(EXIT_ENVIRONMENT);
}

// Preflight the provider when a model was named explicitly.
//
// A gateway that refuses the provider costs a full invocation otherwise: the
// tarballs get packed, the sandbox template boots, and only then does the turn
// die — and it dies looking like an eval result. One 16-token request answers
// it in well under a second.
//
// Only when VGPU_EVALS_MODEL is set: the default model is exercised constantly
// and does not need re-proving, and reading the default here would duplicate a
// constant that lives in agent/agent.ts.
const requestedModel = process.env.VGPU_EVALS_MODEL;
if (requestedModel) {
  const credential = isSceneTask(taskId)
    ? process.env.VERCEL_OIDC_TOKEN
    : process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (credential) {
    const provider = requestedModel.split("/")[0];
    let response;
    try {
      response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        // 16 is the gateway's documented floor for this field; asking for 1
        // gets a 400 from some providers and would read as a fake failure.
        body: JSON.stringify({ model: requestedModel, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        // A gateway that accepts the connection and then never answers would
        // otherwise hang this command forever, which is worse than the failure
        // the preflight exists to catch. The AbortError lands in the catch
        // below and is treated like any other unreachable gateway.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      // Network trouble is not evidence about the provider. Say so and carry on
      // rather than blocking a run over a blip.
      process.stderr.write(`pnpm agent-evals: provider preflight could not reach the gateway (${error.message}); continuing.\n`);
    }
    if (response !== undefined && !response.ok) {
      const body = await response.text().catch(() => "");
      const restricted = response.status === 403 && /restricted|RestrictedProviders/i.test(body);
      const missing = response.status === 404;
      // A credential the gateway refuses is a verdict, not a blip: 401 always,
      // and a 403 that is not about provider access — an expired OIDC token
      // reads exactly like that. Continuing would spend bootstrap and turns to
      // die on the same rejection, which is the cost this preflight exists to
      // avoid.
      const refused = response.status === 401 || (response.status === 403 && !restricted);
      if (restricted || missing || refused) {
        const headline = restricted
          ? `pnpm agent-evals: provider "${provider}" is restricted for this team, so ${requestedModel} cannot run.`
          : missing
            ? `pnpm agent-evals: the gateway does not know the model "${requestedModel}".`
            : `pnpm agent-evals: the gateway rejected the credential (HTTP ${response.status}).`;
        const advice = restricted
          ? "  An account owner has to allow the provider in the AI Gateway settings."
          : missing
            ? "  Check the slug against the gateway's model list."
            : isSceneTask(taskId)
              ? "  Start a fresh configured project session; credentials are not refreshed inside a running specialist session."
              : "  Check AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN (expired?). An OIDC token\n  lasts 12 hours; re-run `vercel env pull` to refresh it.";
        process.stderr.write(
          [headline, "", advice, "  Nothing was packed and no sandbox was started.", ""].join("\n"),
        );
        process.exit(EXIT_ENVIRONMENT);
      }
      // Any other non-2xx (rate limit, 5xx, a provider-specific quirk) is not a
      // definitive verdict on this model, so it is reported and not fatal.
      process.stderr.write(`pnpm agent-evals: provider preflight got HTTP ${response.status} for ${requestedModel}; continuing.\n`);
    }
  }
}

const workDir = join(PACKAGE_DIR, ".work");
const sourceTarballsDir = resolveSceneTarballsDir(PACKAGE_DIR, process.env);
let resolvedTarballsDir = sourceTarballsDir;
let manifestPath = join(resolvedTarballsDir, "tarballs.json");
if (skipPack) {
  const current = sourceKey();
  const packed = validatePackedArtifacts(manifestPath, current);
  if (!packed.ok) {
    process.stderr.write(`pnpm agent-evals: --skip-pack rejected: ${packed.reason}.\n`);
    process.stderr.write("Pack with Node 22 first; no eval was started.\n");
    process.exit(EXIT_ENVIRONMENT);
  }
  process.stdout.write(`pnpm agent-evals: using checked branch tarballs (source key ${current}).\n`);
} else {
  process.stdout.write("pnpm agent-evals: packing this branch's vgpu…\n");
  const pack = spawnSync(process.execPath, [join(PACKAGE_DIR, "scripts", "pack-vgpu.mjs")], {
    cwd: PACKAGE_DIR,
    stdio: "inherit",
  });
  if (pack.status !== 0) {
    process.stderr.write("pnpm agent-evals: packing failed; not running the evals.\n");
    process.exit(pack.status ?? 1);
  }
}

if (sceneExperiment.variant !== null) {
  try {
    const fixture = prepareSceneGuidanceExperiment({
      sourceTarballsDir,
      outputRoot: join(workDir, "scene-guidance"),
      repoRoot: REPO_ROOT,
    });
    resolvedTarballsDir = fixture.variants[sceneExperiment.variant].tarballsDir;
    validatePreparedSceneGuidanceVariant(resolvedTarballsDir, sceneExperiment.variant);
    manifestPath = join(resolvedTarballsDir, "tarballs.json");
  } catch (error) {
    process.stderr.write(`pnpm agent-evals: scene guidance preparation failed: ${error.message}\n`);
    process.exit(EXIT_ENVIRONMENT);
  }
}

// Hand the runtime ABSOLUTE paths.
//
// eve's dev runtime snapshots the app and runs the compiled modules from
// `<package>/.eve/dev-runtime/snapshots/<id>/source/apps/agent-evals/.eve/...`,
// so anything the bootstrap or the export hook derives from `import.meta.url`
// or from cwd lands inside that snapshot — where `.work/` does not exist,
// because it is gitignored and never copied. The first real run died exactly
// there. These variables are the contract that keeps the packer (this process),
// the runtime (snapshot) and the eval (CLI process) pointing at one directory.
process.env.VGPU_EVALS_WORK_DIR ??= workDir;
process.env.VGPU_EVALS_TARBALLS_DIR = resolvedTarballsDir;
process.env.VGPU_EVALS_REPO_ROOT ??= REPO_ROOT;

// Hash of THIS TASK's seed tree, so the sandbox template is rebuilt when its
// starter project changes — and, just as importantly, so editing one task's seed
// does not invalidate another task's already-warm (and expensive) template.
const seedHash = createHash("sha256");
// Recursive: the seed is a directory tree, and a flat readdir throws EISDIR the
// first time someone adds a subfolder to a starter project.
const hashTree = (dir, prefix = "") => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    const label = `${prefix}${entry.name}`;
    seedHash.update(label);
    if (entry.isDirectory()) hashTree(full, `${label}/`);
    else seedHash.update(readFileSync(full));
  }
};
hashTree(join(TASKS_DIR, taskId));
if (taskId === "scene-quaternion-keyframes") {
  for (const path of [VGPU_SKILL_PATH, VGPU_SCENE_SKILL_PATH, VGPU_SKILL_GENERATOR_PATH]) {
    if (!existsSync(path)) usage(`scene-quaternion-keyframes requires ${path}.`);
  }
  const skillBytes = readFileSync(VGPU_SKILL_PATH);
  const sceneBytes = readFileSync(VGPU_SCENE_SKILL_PATH);
  const sceneSha256 = createHash("sha256").update(sceneBytes).digest("hex");
  const generatorBytes = readFileSync(VGPU_SKILL_GENERATOR_PATH);
  const skillSha256 = createHash("sha256").update(skillBytes).digest("hex");
  const skillBody = skillBytes.toString("utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const skillBodySha256 = createHash("sha256").update(skillBody).digest("hex");
  const generatorSha256 = createHash("sha256").update(generatorBytes).digest("hex");
  seedHash.update("task-skill/skills/vgpu/SKILL.md");
  seedHash.update(skillBytes);
  seedHash.update("task-skill/skills/vgpu/scene.md");
  seedHash.update(sceneBytes);
  process.env.VGPU_EVALS_VGPU_SCENE_SKILL_SHA256 = sceneSha256;
  process.env.VGPU_EVALS_VGPU_SKILL_PATH = VGPU_SKILL_PATH;
  process.env.VGPU_EVALS_VGPU_SKILL_SHA256 = skillSha256;
  process.env.VGPU_EVALS_VGPU_SKILL_BODY_SHA256 = skillBodySha256;
  process.env.VGPU_EVALS_VGPU_SKILL_GENERATOR_SHA256 = generatorSha256;
}
process.env.VGPU_EVALS_TASK_SEED_KEY ??= seedHash.digest("hex").slice(0, 16);

// Also precompute the staleness key here, in the real worktree. The runtime
// cannot recompute it: `git` resolves against the snapshot's cwd, where the
// `packages/` pathspec matches nothing, so it would produce a different key and
// report the freshly built tarballs as stale.
try {
  process.env.VGPU_EVALS_SOURCE_KEY ??= JSON.parse(readFileSync(manifestPath, "utf8")).sourceKey;
} catch (error) {
  process.stderr.write(`pnpm agent-evals: could not read ${manifestPath}: ${error.message}\n`);
  process.exit(1);
}

// The selector is host orchestration only. The selected tarball manifest carries
// the corpus hash; neither a condition label nor its source commit enters the
// agent runtime or sandbox environment.
delete process.env.VGPU_EVALS_SCENE_GUIDANCE;

// `eve eval` identifies evals by ID (the `evals/<id>.eval.ts` filename minus
// its extension, confirmed via `eve eval --list`), not by file path — passing
// `evalFile` here made every invocation report "No evals found matching".
const child = spawn("pnpm", ["--filter", "@vgpu/agent-evals", "exec", "eve", "eval", taskId, ...forwarded], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

child.on("error", (error) => {
  process.stderr.write(`pnpm agent-evals: failed to start pnpm: ${error.message}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.stderr.write(`pnpm agent-evals: terminated by signal ${signal}\n`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
