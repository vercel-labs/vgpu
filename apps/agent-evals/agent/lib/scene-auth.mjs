import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { SCENE_TASK_IDS } from "../../evals/lib/scene-contracts.mjs";

const COMPETING_KEYS = [
  "AI_GATEWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
];
export const SCENE_AUTH_MIN_REMAINING_MS = 25 * 60_000;

export function isSceneTask(taskId) {
  return SCENE_TASK_IDS.includes(taskId);
}

export function validateSceneAuth(taskId, env = process.env, now = Date.now()) {
  if (!isSceneTask(taskId)) return { ok: true, applies: false };
  const present = COMPETING_KEYS.filter((name) => typeof env[name] === "string" && env[name].length > 0);
  if (present.length > 0) {
    return { ok: false, applies: true, reason: `scene evals require project OIDC only; unset ${present.join(", ")}` };
  }
  const token = env.VERCEL_OIDC_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, applies: true, reason: "scene evals require VERCEL_OIDC_TOKEN from the configured project" };
  }
  let payload;
  try {
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("wrong segment count");
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, applies: true, reason: "VERCEL_OIDC_TOKEN is malformed; start a fresh configured project session" };
  }
  if (typeof payload?.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { ok: false, applies: true, reason: "VERCEL_OIDC_TOKEN has no usable expiry" };
  }
  const expiresAt = payload.exp * 1000;
  const remainingMs = expiresAt - now;
  if (remainingMs < SCENE_AUTH_MIN_REMAINING_MS) {
    return {
      ok: false,
      applies: true,
      expiresAt,
      remainingMs,
      reason: "VERCEL_OIDC_TOKEN has less than 25 minutes remaining; start a fresh configured project session",
    };
  }
  return { ok: true, applies: true, expiresAt, remainingMs };
}

export function assertSceneAuth(taskId, env = process.env, now = Date.now()) {
  const result = validateSceneAuth(taskId, env, now);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = "SCENE_EVAL_AUTH";
    throw error;
  }
  return result;
}

export function consumeSceneLauncherArgs(argv) {
  const taskIndex = argv.indexOf("--task");
  const taskId = taskIndex === -1 ? undefined : argv[taskIndex + 1];
  const withoutTask = taskIndex === -1 ? [...argv] : [...argv.slice(0, taskIndex), ...argv.slice(taskIndex + 2)];
  const skipPack = withoutTask.includes("--skip-pack");
  return { taskId, skipPack, forwarded: withoutTask.filter((argument) => argument !== "--skip-pack") };
}

export function resolveSceneTarballsDir(packageDir, env = process.env) {
  return resolve(env.VGPU_EVALS_TARBALLS_DIR || join(packageDir, ".work", "tarballs"));
}

export function validatePackedArtifacts(manifestPath, expectedSourceKey) {
  try {
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) throw new Error("manifest is missing");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.sourceKey !== expectedSourceKey) throw new Error(`manifest source key ${manifest.sourceKey ?? "missing"} is stale`);
    if (!Array.isArray(manifest.tarballs) || manifest.tarballs.length === 0) throw new Error("manifest has no tarballs");
    const directory = dirname(manifestPath);
    for (const entry of manifest.tarballs) {
      if (typeof entry?.file !== "string" || !safeFileName(entry.file)) throw new Error("manifest has an invalid tarball path");
      const file = join(directory, entry.file);
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`tarball ${entry.file} is missing`);
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function safeFileName(file) {
  if (isAbsolute(file)) return false;
  const normalized = normalize(file).replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/");
}
