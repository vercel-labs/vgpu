#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mockModel } from "eve/evals";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const EVE_SRC = join(PACKAGE_ROOT, "node_modules", "eve", "dist", "src");
const SKILL_PATH = join(REPO_ROOT, "skills", "vgpu", "SKILL.md");
const NULL_TASKS = ["scene-robot-arm", "scene-math-interop", "s2-gradient"];
const TARGET_TASK = "scene-quaternion-keyframes";

export async function runSceneSkillIsolation({ outputRoot } = {}) {
  const destination = resolve(outputRoot ?? join(PACKAGE_ROOT, ".work", "skill-isolation"));
  const evidenceDir = join(destination, `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`);
  mkdirSync(evidenceDir, { recursive: true });

  const skillMarkdown = readFileSync(SKILL_PATH, "utf8");
  const sceneMarkdown = readFileSync(join(dirname(SKILL_PATH), "scene.md"), "utf8");
  const sceneSha256 = sha256(sceneMarkdown);
  const skillSha256 = sha256(skillMarkdown);
  const skillBodySha256 = sha256(stripFrontmatter(skillMarkdown));
  const internals = await eveInternals();
  const baseline = await captureModelVisible(internals, null);
  const nullCaptures = Object.fromEntries(await Promise.all(NULL_TASKS.map(async (taskId) => [
    taskId,
    await captureModelVisible(internals, { taskId, skillPath: SKILL_PATH, skillSha256 }),
  ])));
  const target = await captureModelVisible(internals, {
    taskId: TARGET_TASK,
    skillPath: SKILL_PATH,
    skillSha256,
    load: true,
  });

  const mutatedSkillPath = join(evidenceDir, "mutated-SKILL.md");
  const mutatedMarkdown = skillMarkdown.replace("# vgpu", "# vgpu mutation sentinel");
  writeFileSync(mutatedSkillPath, mutatedMarkdown);
  writeFileSync(join(evidenceDir, "scene.md"), sceneMarkdown);
  const mutatedTarget = await captureModelVisible(internals, {
    taskId: TARGET_TASK,
    skillPath: mutatedSkillPath,
    skillSha256: sha256(mutatedMarkdown),
    load: true,
  });

  const baselineVisible = canonicalVisible(baseline);
  const mismatches = Object.entries(nullCaptures)
    .filter(([, capture]) => canonicalVisible(capture) !== baselineVisible)
    .map(([taskId, capture]) => ({
      taskId,
      baselineSystemSha256: sha256(JSON.stringify(baseline.systemMessages)),
      observedSystemSha256: sha256(JSON.stringify(capture.systemMessages)),
      baselineTools: baseline.tools.map((tool) => tool.name),
      observedTools: capture.tools.map((tool) => tool.name),
    }));
  const advertised = target.systemMessages.some((message) =>
    message.text.includes("Available skills") && message.text.includes("vgpu"));
  const observedLoadedBodySha256 = typeof target.loadedBody === "string"
    ? sha256(target.loadedBody)
    : null;
  const loaded = observedLoadedBodySha256 === skillBodySha256;
  const mutatedObservedBodySha256 = typeof mutatedTarget.loadedBody === "string"
    ? sha256(mutatedTarget.loadedBody)
    : null;
  const mutatedBodyRejected = mutatedObservedBodySha256 !== null
    && mutatedObservedBodySha256 !== skillBodySha256;
  const result = {
    schemaVersion: 2,
    mechanism: "Eve dynamic-skill lifecycle and mockModel, using an in-memory SandboxSession",
    eveVersion: JSON.parse(readFileSync(join(PACKAGE_ROOT, "node_modules", "eve", "package.json"), "utf8")).version,
    skill: {
      path: SKILL_PATH,
      advertisedFullMarkdownSha256: skillSha256,
      expectedLoadedBodySha256: skillBodySha256,
    },
    baseline: summarizeCapture(baseline),
    nullTasks: Object.fromEntries(Object.entries(nullCaptures).map(([taskId, capture]) => [taskId, summarizeCapture(capture)])),
    target: { ...summarizeCapture(target), advertised, loaded, observedLoadedBodySha256,
      sceneSha256, observedSceneSha256: target.sceneSha256, sceneMaterialized: target.sceneSha256 === sceneSha256 },
    mutatedTarget: {
      ...summarizeCapture(mutatedTarget),
      observedLoadedBodySha256: mutatedObservedBodySha256,
      rejectedAgainstFrozenBody: mutatedBodyRejected,
    },
    mismatches,
    ok: mismatches.length === 0 && advertised && loaded && mutatedBodyRejected && target.sceneSha256 === sceneSha256,
  };
  writeFileSync(join(evidenceDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    throw new Error(`dynamic skill isolation failed; see ${join(evidenceDir, "summary.json")}`);
  }
  return { ...result, evidenceDir };
}

async function captureModelVisible(internals, options) {
  const sandbox = new MemorySandboxSession();
  const ctx = new internals.ContextContainer();
  ctx.set(internals.SandboxKey, { get: async () => sandbox });

  if (options) {
    process.env.VGPU_EVALS_TASK = options.taskId;
    process.env.VGPU_EVALS_VGPU_SKILL_PATH = options.skillPath;
    process.env.VGPU_EVALS_VGPU_SKILL_SHA256 = options.skillSha256;
    await internals.dispatchDynamicSkillEvent({
      ctx,
      event: { type: "session.started" },
      messages: [],
      resolvers: [{
        eventNames: ["session.started"],
        events: internals.dynamicSkill.events,
        logicalPath: "skills/vgpu.ts",
        slug: "vgpu",
        sourceId: "skill-isolation",
        sourceKind: "module",
      }],
    });
  }

  const announcement = ctx.get(internals.PendingSkillAnnouncementKey) ?? "";
  const instructions = readFileSync(join(PACKAGE_ROOT, "agent", "instructions.md"), "utf8");
  const tools = internals.getFrameworkToolDefinitions({ authoredSkills: [] })
    .map((tool) => ({
      description: tool.description,
      inputSchema: {},
      name: tool.name,
      type: "function",
    }));
  tools.push({ description: "Inspect an image.", inputSchema: {}, name: "view_image", type: "function" });
  let request;
  const model = mockModel((observed) => {
    request = observed;
    return "captured";
  });
  await model.doGenerate({
    prompt: [
      { role: "system", content: instructions },
      ...(announcement ? [{ role: "system", content: announcement }] : []),
      { role: "user", content: [{ type: "text", text: "capture" }] },
    ],
    tools,
  });
  if (!request) throw new Error("Eve mockModel did not receive the capture request");

  let loadedBody = null;
  if (options?.load) {
    const loadSkill = internals.createSkillToolDefinition([]);
    loadedBody = await internals.contextStorage.run(ctx, () =>
      loadSkill.execute({ skill: "vgpu" }));
  }
  return {
    systemMessages: request.messages.filter((message) => message.role === "system"),
    tools: request.tools,
    loadedBody,
    sceneSha256: await sandbox.readTextFile({ path: "/home/eve/.agents/skills/vgpu/scene.md" }).then((value) => value === null ? null : sha256(value)),
  };
}

async function eveInternals() {
  const [
    dynamicSkill,
    lifecycle,
    keys,
    container,
    frameworkTools,
    skillTool,
  ] = await Promise.all([
    import(pathToFileURL(join(PACKAGE_ROOT, "agent", "skills", "vgpu.ts"))),
    import(pathToFileURL(join(EVE_SRC, "context", "dynamic-skill-lifecycle.js"))),
    import(pathToFileURL(join(EVE_SRC, "context", "keys.js"))),
    import(pathToFileURL(join(EVE_SRC, "context", "container.js"))),
    import(pathToFileURL(join(EVE_SRC, "runtime", "framework-tools", "index.js"))),
    import(pathToFileURL(join(EVE_SRC, "runtime", "framework-tools", "skill.js"))),
  ]);
  return {
    dynamicSkill: dynamicSkill.default,
    dispatchDynamicSkillEvent: lifecycle.dispatchDynamicSkillEvent,
    PendingSkillAnnouncementKey: lifecycle.PendingSkillAnnouncementKey,
    SandboxKey: keys.SandboxKey,
    ContextContainer: container.ContextContainer,
    contextStorage: container.contextStorage,
    getFrameworkToolDefinitions: frameworkTools.getFrameworkToolDefinitions,
    createSkillToolDefinition: skillTool.createSkillToolDefinition,
  };
}

class MemorySandboxSession {
  #files = new Map();

  async run() {
    return { exitCode: 0, stdout: "/home/eve\n", stderr: "" };
  }

  async writeBinaryFile({ path, content }) {
    this.#files.set(path, Buffer.from(content));
  }

  async readTextFile({ path }) {
    const bytes = this.#files.get(path);
    return bytes ? bytes.toString("utf8") : null;
  }

  async readBinaryFile({ path }) {
    const bytes = this.#files.get(path);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async removePath({ path }) {
    for (const candidate of this.#files.keys()) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#files.delete(candidate);
    }
  }
}

function canonicalVisible(capture) {
  return JSON.stringify({ systemMessages: capture.systemMessages, tools: capture.tools });
}

function summarizeCapture(capture) {
  return {
    systemSha256: sha256(JSON.stringify(capture.systemMessages)),
    visibleSha256: sha256(canonicalVisible(capture)),
    tools: capture.tools.map((tool) => tool.name),
  };
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSceneSkillIsolation();
    process.stdout.write(`${JSON.stringify({ ok: result.ok, evidenceDir: result.evidenceDir }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
