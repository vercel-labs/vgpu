import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  defineEval,
  type EveEvalContext,
  type EveEvalToolCall,
  type EveEvalTurn,
} from "eve/evals";
import { equals } from "eve/evals/expect";
import { PNG } from "pngjs";
import {
  snapshotAttemptCompletePath,
  snapshotAttemptDir,
  snapshotAttemptTarPath,
  snapshotAttemptVerifyTarPath,
  snapshotDir,
  taskSeedDir,
  tarballsDir,
} from "../../agent/lib/paths.ts";
import { assertSceneAuth } from "../../agent/lib/scene-auth.mjs";
import {
  SCENE_CONTRACT_REVISION,
  sceneContract,
  sceneContractRevision,
  sceneFixturePaths,
  sceneInputSha256,
} from "./scene-contracts.mjs";
import { gradeSceneOutput } from "./grade-scene.mjs";
import { gradeSceneInterop } from "./scene-interop.mjs";
import { gradeSceneKeyframes } from "./scene-keyframes.mjs";
import { bashCalls, docsUsage, sourceFiles } from "./transcript.ts";
import { turnFailure } from "./turn-failure.mjs";
import { parseSceneExperimentEnv } from "../../scripts/scene-guidance.mjs";
import { tarballsFingerprint } from "../../scripts/tarballs-fingerprint.mjs";

type SceneTaskId = "scene-robot-arm" | "scene-shader-bindings" | "scene-warehouse" | "scene-math-interop" | "scene-quaternion-keyframes";

interface Correlation {
  stage: number;
  turnId: string;
  metaId: string;
  inputSha256: string;
}

interface SceneAttemptRecord extends Partial<Correlation> {
  cleanupOk?: boolean;
  evidenceExported?: boolean;
  classification?: string;
  dependencySnapshot?: unknown;
  skillAdvertisementSnapshot?: {
    sceneReference?: {
      path: string | null;
      expectedSha256: string;
      sha256: string | null;
      matches: boolean;
    } | null;
    advertised?: boolean;
    expectedFullMarkdownSha256?: string;
    materializedPath?: string | null;
    materializedPresent?: boolean;
    materializedSha256?: string | null;
    materializedOutsideWorkspace?: boolean;
    integrity?: "pass" | "infrastructure-error";
    error?: string | null;
  } | null;
}

type SkillAdvertisementSnapshot = NonNullable<SceneAttemptRecord["skillAdvertisementSnapshot"]>;

const KEYFRAME_HARNESS_FILES = [
  "apps/agent-evals/agent/hooks/finalize-turn.ts",
  "apps/agent-evals/agent/lib/scene-keyframe-dependencies.ts",
  "apps/agent-evals/agent/sandbox/sandbox.ts",
  "apps/agent-evals/agent/skills/vgpu.ts",
  "apps/agent-evals/agent/sandbox/tasks/scene-quaternion-keyframes/contract.md",
  "apps/agent-evals/agent/sandbox/tasks/scene-quaternion-keyframes/example-input.json",
  "apps/agent-evals/agent/sandbox/tasks/scene-quaternion-keyframes/package.json",
  "apps/agent-evals/controls/scene-keyframes-reference.mjs",
  "apps/agent-evals/controls/scene-keyframes-sphere.wgsl",
  "apps/agent-evals/evals/lib/scene-contracts.mjs",
  "apps/agent-evals/evals/lib/scene-eval.ts",
  "apps/agent-evals/evals/lib/scene-keyframes.mjs",
  "apps/agent-evals/evals/scene-quaternion-keyframes.eval.ts",
  "apps/agent-evals/scripts/scene-controls.mjs",
  "apps/agent-evals/scripts/scene-skill-isolation.mjs",
  "apps/agent-evals/tests/scene-keyframes.test.mjs",
  "scripts/agent-evals.mjs",
] as const;

export function sceneEvalDefinitions(
  taskId: SceneTaskId,
  description: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { repetitions } = parseSceneExperimentEnv(env);
  if (["scene-math-interop", "scene-quaternion-keyframes"].includes(taskId) && parseSceneExperimentEnv(env).variant !== null) {
    throw new Error(`${taskId} does not participate in the scene guidance experiment`);
  }
  const definitions = Array.from({ length: repetitions }, (_, index) =>
    defineEval({
      description,
      timeoutMs: 1_200_000,
      test: (t) => runSceneEval(t, taskId, { repetition: index + 1 }),
    }),
  );
  return repetitions === 1 ? definitions[0]! : definitions;
}

export async function runSceneEval(
  t: EveEvalContext,
  taskId: SceneTaskId,
  { repetition = 1 }: { repetition?: number } = {},
): Promise<void> {
  assertSceneAuth(taskId);
  if (t.target.kind !== "local") t.skip(`scene artifact export requires a local target (got ${t.target.kind})`);

  const run = {
    taskId,
    repetition,
    ...collectSceneRunProvenance(process.env, process.env.VGPU_EVALS_TARBALLS_DIR || tarballsDir(), taskId),
    startedAt: new Date().toISOString(),
    turns: [] as unknown[],
    limitations: [
      "Correctness is rerun from source, but the non-adversarial pilot does not attest GPU provenance.",
      "Scene helper/API adoption is observational and never a correctness gate.",
    ],
  };
  let sessionId: string | undefined;

  for (const stage of [1, 2] as const) {
    const contract = sceneContract(taskId, stage);
    const turn = await t.send(contract.prompt);
    if (turn.status === "failed") {
      throw new Error(`model/infra failure, not an agent result: ${turnFailure(turn.events)}`);
    }
    if (sessionId !== undefined && turn.sessionId !== sessionId) {
      throw new Error(`scene eval changed session from ${sessionId} to ${turn.sessionId}`);
    }
    sessionId = turn.sessionId;

    const coordinates = completionCoordinates(turn, stage, contract.input);
    const attemptDir = snapshotAttemptDir(sessionId, coordinates.turnId, coordinates.metaId);
    const completePath = snapshotAttemptCompletePath(sessionId, coordinates.turnId, coordinates.metaId);
    await waitForFile(completePath, 120_000);
    const complete = JSON.parse(readFileSync(completePath, "utf8")) as SceneAttemptRecord;
    const correlationErrors = validateSceneAttempt(coordinates, complete);
    if (correlationErrors.length > 0) throw new Error(`scene attempt correlation failed: ${correlationErrors.join("; ")}`);
    if (!complete.cleanupOk) throw new Error("scene verification cleanup did not complete before the next turn");
    if (!complete.evidenceExported) throw new Error("scene verification evidence was not exported");

    const verifyTar = snapshotAttemptVerifyTarPath(sessionId, coordinates.turnId, coordinates.metaId);
    if (!existsSync(verifyTar)) throw new Error(`scene verify tar is missing at ${verifyTar}`);
    const verifyDir = join(attemptDir, "verify");
    extractTar(verifyTar, verifyDir);
    const verdict = JSON.parse(readFileSync(join(verifyDir, "verdict.json"), "utf8")) as SceneAttemptRecord;
    const verdictErrors = validateSceneAttempt(coordinates, verdict);
    if (verdictErrors.length > 0) throw new Error(`scene verifier correlation failed: ${verdictErrors.join("; ")}`);
    if (verdict.classification === "infrastructure-error") {
      throw new Error(`scene verifier infrastructure error: ${String((verdict as { reason?: unknown }).reason ?? "unknown")}`);
    }

    const workspaceTar = snapshotAttemptTarPath(sessionId, coordinates.turnId, coordinates.metaId);
    const workspaceDir = join(attemptDir, "workspace");
    extractTar(workspaceTar, workspaceDir);
    const sourceHints = collectSceneSourceHints(taskId, workspaceDir);
    const calls = bashCalls(turn.toolCalls);
    const docs = docsUsage(calls);
    const installAttempts = calls.filter((call) =>
      /\b(?:npm\s+(?:i|install|add)|pnpm\s+add|yarn\s+add)\b/.test(call.command));
    const skillLoadCalls = taskId === "scene-quaternion-keyframes"
      ? collectSkillLoadCalls(
          turn.toolCalls,
          process.env.VGPU_EVALS_VGPU_SKILL_BODY_SHA256 ?? "unavailable",
        )
      : [];
    t.log(`turn ${stage}: source hints (semantic lead review pending) ${JSON.stringify(sourceHints)}`);
    t.log(`turn ${stage}: docs invocations=${docs.invocations}, bash calls=${calls.length}`);

    let grade;
    const resultPath = join(verifyDir, "output", "result.json");
    if (verdict.classification === "application-failure" || !existsSync(resultPath)) {
      grade = {
        outcome: "application-failure",
        checks: [{ name: "source-execution", ok: false, metrics: { classification: verdict.classification } }],
      };
    } else {
      const parsed = parseSceneResult(readFileSync(resultPath, "utf8"));
      if (!parsed.ok) {
        grade = {
          outcome: "application-failure",
          checks: [{ name: "output-contract", ok: false, metrics: { reason: parsed.reason } }],
        };
      } else {
        const fixturePaths = sceneFixturePaths(taskId);
        const expectedFixtureHashes = new Map(fixturePaths.map((path) => [
          path,
          sha256(readFileSync(join(taskSeedDir(taskId), path))),
        ]));
        const observedFixtureHashes = readSceneFixtureHashes(join(verifyDir, "fixture-sha256.txt"));
        const fixturesUnmodified = fixturePaths.every((path) => expectedFixtureHashes.get(path) === observedFixtureHashes.get(path));
        const gradeScene = taskId === "scene-math-interop"
          ? gradeSceneInterop
          : taskId === "scene-quaternion-keyframes"
            ? gradeSceneKeyframes
            : gradeSceneOutput;
        grade = await gradeScene({
          ...contract,
          result: parsed.value,
          fixtureUnchanged: fixturesUnmodified,
          fixturesUnmodified,
          readPng: (path: string) => PNG.sync.read(readFileSync(join(verifyDir, "output", path))),
        });
        if (grade.outcome === "infrastructure-error") {
          const verifier = grade.checks.find((check: { name: string }) => check.name === "verifier");
          throw new Error(`scene verifier infrastructure error: ${String(verifier?.metrics?.reason ?? "invalid fixture or oracle")}`);
        }
      }
    }
    for (const check of grade.checks) {
      t.log(`turn ${stage} ${check.name}: ${JSON.stringify(check.metrics)}`);
      t.check(check.ok, equals(true)).gate().label(`turn ${stage}: ${check.name}`);
    }

    const usage = turn.events
      .filter((event) => event.type === "step.completed")
      .map((event) => event.data.usage ?? null);
    const advertisementFields = taskId === "scene-quaternion-keyframes"
      ? sceneKeyframeAdvertisementFields(complete.skillAdvertisementSnapshot)
      : null;
    const keyframeObservations = taskId === "scene-quaternion-keyframes" ? {
      installAttempts,
      dependencySnapshot: complete.dependencySnapshot ?? null,
      skill: {
        ...advertisementFields!,
        expectedAdvertisedFullMarkdownSha256: process.env.VGPU_EVALS_VGPU_SKILL_SHA256 ?? "unavailable",
        expectedLoadedBodySha256: process.env.VGPU_EVALS_VGPU_SKILL_BODY_SHA256 ?? "unavailable",
        loadCalls: skillLoadCalls,
        loaded: skillLoadCalls.some((call) => call.successful),
      },
    } : {};
    if (taskId === "scene-quaternion-keyframes" && run.skillDelivery && advertisementFields) {
      Object.assign(run.skillDelivery, advertisementFields);
    }
    const turnRecord = {
      ...coordinates,
      contractRevision: contract.revision,
      status: turn.status,
      clarificationRequested: turn.inputRequests.length > 0,
      attemptDir,
      complete,
      verdict,
      grade,
      sourceHints,
      ...keyframeObservations,
      usage,
      toolCalls: turn.toolCalls.length,
    };
    writeJson(join(attemptDir, "grade.json"), turnRecord);
    run.turns.push(turnRecord);
    writeJson(join(snapshotDir(sessionId), "scene-run.json"), {
      ...run,
      ...sceneTemplateObservation(taskId),
      updatedAt: new Date().toISOString(),
    });
  }

  if (sessionId) writeJson(join(snapshotDir(sessionId), "scene-run.json"), {
    ...run,
    ...sceneTemplateObservation(taskId),
    completedAt: new Date().toISOString(),
  });
}

// A cold sandbox template is created during t.send, after run-level provenance
// was collected. Read its correlated bootstrap receipt when saving each turn.
export function sceneTemplateObservation(
  taskId: SceneTaskId,
  env: NodeJS.ProcessEnv = process.env,
  tarballDirectory = env.VGPU_EVALS_TARBALLS_DIR || tarballsDir(),
) {
  const templateProvenance = readTemplateProvenance(env, tarballDirectory, taskId);
  return {
    templateProvenance,
    ...(taskId === "scene-quaternion-keyframes" ? {
      initialDependencySnapshot:
        (templateProvenance as { initialDependencySnapshot?: unknown } | null)?.initialDependencySnapshot ?? null,
    } : {}),
  };
}

export function collectSceneRunProvenance(
  env: NodeJS.ProcessEnv = process.env,
  tarballDirectory = env.VGPU_EVALS_TARBALLS_DIR || tarballsDir(),
  taskId?: SceneTaskId,
) {
  let manifest: {
    sourceKey?: string;
    gitSha?: string;
    gitBranch?: string;
    tarballs?: { name?: string; version?: string; file?: string }[];
    sceneGuidance?: {
      experiment?: string;
      variant?: string;
      baselineGitSha?: string;
      currentDocsGitSha?: string;
      runtimeGitSha?: string;
      docsManifestPath?: string;
      docsSha256?: string;
      counterpartDocsSha256?: string;
      dependency?: { name?: string; version?: string };
    };
  } = {};
  let manifestError: string | null = null;
  try {
    manifest = JSON.parse(readFileSync(join(tarballDirectory, "tarballs.json"), "utf8"));
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error);
  }
  const tarballs = (manifest.tarballs ?? []).map((entry) => {
    const path = typeof entry.file === "string" ? join(tarballDirectory, entry.file) : null;
    let digest = "unavailable";
    if (path && existsSync(path)) digest = sha256(readFileSync(path));
    return { name: entry.name ?? "unknown", version: entry.version ?? "unknown", file: entry.file ?? "unknown", sha256: digest };
  });
  const templateProvenance = taskId
    ? readTemplateProvenance(env, tarballDirectory, taskId, manifest.sceneGuidance?.docsSha256)
    : null;
  const repoRoot = env.VGPU_EVALS_REPO_ROOT || process.cwd();
  const workspaceGit = gitIdentity(repoRoot);
  const harness = taskId === "scene-quaternion-keyframes"
    ? harnessIdentity(repoRoot)
    : null;
  const skillDelivery = taskId === "scene-quaternion-keyframes" ? {
    scope: "scene-quaternion-keyframes-only",
    name: "vgpu",
    advertised: null,
    advertisedFullMarkdownSha256: null,
    expectedAdvertisedFullMarkdownSha256: env.VGPU_EVALS_VGPU_SKILL_SHA256 || "unavailable",
    observedAdvertisedFullMarkdownSha256: null,
    materializedPath: null,
    materializedPresent: false,
    materializedSha256: null,
    materializedOutsideWorkspace: false,
    advertisementIntegrity: "pending",
    advertisementError: "advertisement was not observed",
    expectedSceneReferenceSha256: env.VGPU_EVALS_VGPU_SCENE_SKILL_SHA256 || "unavailable",
    expectedLoadedBodySha256: env.VGPU_EVALS_VGPU_SKILL_BODY_SHA256 || "unavailable",
    generatorSha256: env.VGPU_EVALS_VGPU_SKILL_GENERATOR_SHA256 || "unavailable",
    packageGitHead: manifest.gitSha || "unavailable",
    workspaceGitHead: workspaceGit.head,
    workspaceDirty: workspaceGit.dirty,
    harnessAggregateSha256: harness?.aggregateSha256 ?? "unavailable",
    harnessFiles: harness?.files ?? [],
    delivery: "SKILL.md and scene.md; blender resources not delivered",
  } : null;
  return {
    contractRevision: taskId ? sceneContractRevision(taskId) : SCENE_CONTRACT_REVISION,
    model: env.VGPU_EVALS_MODEL || "anthropic/claude-sonnet-5",
    sourceKey: env.VGPU_EVALS_SOURCE_KEY || manifest.sourceKey || "unavailable",
    seedKey: env.VGPU_EVALS_TASK_SEED_KEY || "unavailable",
    packedGitSha: manifest.gitSha || "unavailable",
    packedGitBranch: manifest.gitBranch || "unavailable",
    tarballManifest: join(tarballDirectory, "tarballs.json"),
    tarballManifestError: manifestError,
    tarballs,
    sceneGuidance: manifest.sceneGuidance ?? null,
    ...(skillDelivery ? { skillDelivery } : {}),
    templateProvenance,
    eveVersion: resolvedPackageVersion("eve"),
    sandboxBackend: env.VGPU_EVALS_SANDBOX || "docker",
    dockerImage: env.VGPU_EVALS_DOCKER_IMAGE || "unavailable",
    hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

function readTemplateProvenance(
  env: NodeJS.ProcessEnv,
  tarballDirectory: string,
  taskId: SceneTaskId,
  knownDocsSha256?: string,
): unknown {
  if (taskId === "scene-math-interop" || taskId === "scene-quaternion-keyframes") {
    try {
      const provenance = JSON.parse(readFileSync(join(
        env.VGPU_EVALS_WORK_DIR || join(dirname(tarballDirectory), ".."),
        "template-provenance",
        `${taskId}.json`,
      ), "utf8")) as { templateKey?: string };
      const seedKey = env.VGPU_EVALS_TASK_SEED_KEY;
      const expectedKey = seedKey ? `${tarballsFingerprint(tarballDirectory)}-${taskId}-${seedKey}` : null;
      if (!expectedKey || provenance.templateKey !== expectedKey) {
        return { unavailable: true, reason: `stale or uncorrelated ${taskId} template provenance` };
      }
      return provenance;
    } catch {
      return { unavailable: true };
    }
  }
  let docsSha256 = knownDocsSha256;
  if (!docsSha256) {
    try {
      const manifest = JSON.parse(readFileSync(join(tarballDirectory, "tarballs.json"), "utf8")) as {
        sceneGuidance?: { docsSha256?: string };
      };
      docsSha256 = manifest.sceneGuidance?.docsSha256;
    } catch {
      return null;
    }
  }
  if (!docsSha256) return null;
  try {
    return JSON.parse(readFileSync(join(
      env.VGPU_EVALS_WORK_DIR || join(dirname(tarballDirectory), ".."),
      "template-provenance",
      `${taskId}-${docsSha256}.json`,
    ), "utf8"));
  } catch {
    return { unavailable: true };
  }
}

export function validateSceneAttempt(expected: Correlation, record: SceneAttemptRecord): string[] {
  const errors: string[] = [];
  for (const key of ["stage", "turnId", "metaId", "inputSha256"] as const) {
    if (record[key] !== expected[key]) errors.push(`${key} expected ${expected[key]}, got ${String(record[key])}`);
  }
  return errors;
}

export function parseSceneResult(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `result.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function completionCoordinates(turn: EveEvalTurn, stage: number, input: unknown): Correlation {
  const event = [...turn.events].reverse().find((candidate) => candidate.type === "turn.completed");
  if (!event || event.type !== "turn.completed") throw new Error(`turn ${stage} has no turn.completed event`);
  if (!event.meta.id || !event.data.turnId) throw new Error(`turn ${stage} completion event has no coordinates`);
  return { stage, turnId: event.data.turnId, metaId: event.meta.id, inputSha256: sceneInputSha256(input) };
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for scene completion marker ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function extractTar(tarPath: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const result = spawnSync("tar", ["-xf", tarPath, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`could not extract ${tarPath}: ${result.stderr}`);
}

function collectSceneSourceHints(taskId: SceneTaskId, root: string) {
  const files = sourceFiles(root, new Set([".mjs", ".js", ".ts", ".wgsl"]));
  const source = files.map((file) => file.content).join("\n");
  const seededPaths = new Set(sceneFixturePaths(taskId));
  const authoredSource = files.filter((file) => !seededPaths.has(file.path)).map((file) => file.content).join("\n");
  return {
    sourceFiles: files.map((file) => file.path),
    semanticReview: "pending lead review; text hints do not establish runtime API or shader use",
    mentionsSceneImport: /["']vgpu\/scene(?:\/gpu)?["']/.test(source),
    mentionsVgpuNodeImport: /["']vgpu\/node["']/.test(source),
    mentionsMathImport: /["']math["']/.test(authoredSource),
    ...(taskId === "scene-quaternion-keyframes"
      ? { mentionsWgpuMatrixImport: /["']wgpu-matrix["']/.test(authoredSource) }
      : {}),
    seededEcsMentionsMathImport: taskId === "scene-math-interop"
      ? files.some((file) => file.path.startsWith("ecs/") && /["']math["']/.test(file.content))
      : null,
    suppliedShaderTextHints: taskId === "scene-shader-bindings" ? {
      mentionsIntegrationWgsl: /integration\.wgsl/.test(source),
      mentionsStyle: /\bstyle\b/.test(source),
      mentionsViewState: /\bviewState\b/.test(source),
    } : null,
    mentionsStableId: taskId === "scene-warehouse" ? /\bappId\b/.test(source) : null,
  };
}

export function collectSkillLoadCalls(
  toolCalls: readonly EveEvalToolCall[],
  expectedLoadedBodySha256: string,
) {
  return toolCalls.filter((call) => call.name === "load_skill").map((call) => {
    const skill = typeof call.input.skill === "string" ? call.input.skill : null;
    const observedLoadedBodySha256 = typeof call.output === "string" ? sha256(call.output) : null;
    const matchesExpectedLoadedBodySha256 = observedLoadedBodySha256 !== null
      && observedLoadedBodySha256 === expectedLoadedBodySha256;
    return {
      skill,
      status: call.status,
      outputSha256: observedLoadedBodySha256,
      observedLoadedBodySha256,
      matchesExpectedLoadedBodySha256,
      successful: skill === "vgpu"
        && call.status === "completed"
        && matchesExpectedLoadedBodySha256,
    };
  });
}

export function sceneKeyframeAdvertisementFields(
  snapshot: SkillAdvertisementSnapshot | null | undefined,
) {
  return {
    sceneReference: snapshot?.sceneReference ?? null,
    advertised: snapshot?.advertised === true,
    advertisedFullMarkdownSha256: snapshot?.advertised === true
      ? snapshot.materializedSha256 ?? null
      : null,
    observedAdvertisedFullMarkdownSha256: snapshot?.materializedSha256 ?? null,
    materializedPath: snapshot?.materializedPath ?? null,
    materializedPresent: snapshot?.materializedPresent === true,
    materializedSha256: snapshot?.materializedSha256 ?? null,
    materializedOutsideWorkspace: snapshot?.materializedOutsideWorkspace === true,
    advertisementIntegrity: snapshot?.integrity ?? "infrastructure-error",
    advertisementError: snapshot == null
      ? "advertisement was not observed"
      : snapshot.error ?? null,
  };
}

function gitIdentity(repoRoot: string): {
  head: string;
  dirty: boolean | "unavailable";
} {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  return {
    head: head.status === 0 ? head.stdout.trim() : "unavailable",
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : "unavailable",
  };
}

function harnessIdentity(repoRoot: string): {
  aggregateSha256: string;
  files: { path: string; sha256: string }[];
} {
  const aggregate = createHash("sha256");
  const files = KEYFRAME_HARNESS_FILES.map((path) => {
    const bytes = readFileSync(join(repoRoot, path));
    const digest = sha256(bytes);
    aggregate.update(path).update("\0").update(digest).update("\0");
    return { path, sha256: digest };
  });
  return { aggregateSha256: aggregate.digest("hex"), files };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readSceneFixtureHashes(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  return new Map(readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+(?:\.\/)?(.+)$/);
    return match ? [match[2], match[1]] : ["", ""];
  }));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvedPackageVersion(name: string): string {
  try {
    const require = createRequire(import.meta.url);
    let directory = dirname(require.resolve(name));
    for (;;) {
      const packagePath = join(directory, "package.json");
      if (existsSync(packagePath)) {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === name && pkg.version) return pkg.version;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Runtime provenance remains explicit when package resolution is unavailable.
  }
  return "unavailable";
}
