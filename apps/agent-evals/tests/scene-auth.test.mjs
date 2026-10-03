import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  consumeSceneLauncherArgs,
  resolveSceneTarballsDir,
  validatePackedArtifacts,
  validateSceneAuth,
} from "../agent/lib/scene-auth.mjs";
import { SCENE_TASK_IDS } from "../evals/lib/scene-contracts.mjs";

function token(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

test("all scene tasks require a sufficiently long-lived project OIDC token", () => {
  const now = Date.UTC(2026, 8, 25);
  const env = { VERCEL_OIDC_TOKEN: token({ exp: Math.floor((now + 30 * 60_000) / 1000) }) };
  for (const taskId of SCENE_TASK_IDS) assert.equal(validateSceneAuth(taskId, env, now).ok, true);
  assert.equal(validateSceneAuth("s2-gradient", {}, now).ok, true);

  for (const bad of [
    {},
    { VERCEL_OIDC_TOKEN: "not-a-jwt" },
    { VERCEL_OIDC_TOKEN: token({ exp: "tomorrow" }) },
    { VERCEL_OIDC_TOKEN: token({ exp: Math.floor((now - 1) / 1000) }) },
    { VERCEL_OIDC_TOKEN: token({ exp: Math.floor((now + 24 * 60_000) / 1000) }) },
  ]) assert.equal(validateSceneAuth("scene-robot-arm", bad, now).ok, false);
});

test("scene auth rejects API keys alone or alongside OIDC without exposing credential contents", () => {
  const now = Date.UTC(2026, 8, 25);
  const secret = "private-api-key-value";
  const oidc = token({ exp: Math.floor((now + 30 * 60_000) / 1000) });
  for (const env of [
    { AI_GATEWAY_API_KEY: secret },
    { VERCEL_OIDC_TOKEN: oidc, AI_GATEWAY_API_KEY: secret },
    { VERCEL_OIDC_TOKEN: oidc, OPENAI_API_KEY: secret },
    { VERCEL_OIDC_TOKEN: oidc, ANTHROPIC_API_KEY: secret },
    { VERCEL_OIDC_TOKEN: oidc, ANTHROPIC_AUTH_TOKEN: secret },
    { VERCEL_OIDC_TOKEN: oidc, GOOGLE_GENERATIVE_AI_API_KEY: secret },
  ]) {
    const result = validateSceneAuth("scene-shader-bindings", env, now);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(oidc), false);
  }
});

test("--skip-pack is consumed instead of forwarded", () => {
  assert.deepEqual(
    consumeSceneLauncherArgs(["--task", "scene-warehouse", "--skip-pack", "--verbose"]),
    { taskId: "scene-warehouse", skipPack: true, forwarded: ["--verbose"] },
  );
  assert.deepEqual(
    consumeSceneLauncherArgs(["--task", "s2-gradient", "--verbose"]),
    { taskId: "s2-gradient", skipPack: false, forwarded: ["--verbose"] },
  );
});

test("skip-pack validation rejects stale, missing, and incomplete tarball manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "scene-pack-test-"));
  const manifestPath = join(root, "tarballs.json");
  writeFileSync(manifestPath, JSON.stringify({ sourceKey: "fresh", tarballs: [{ file: "vgpu.tgz" }] }));
  assert.equal(validatePackedArtifacts(manifestPath, "fresh").ok, false);
  writeFileSync(join(root, "vgpu.tgz"), "tar");
  assert.equal(validatePackedArtifacts(manifestPath, "fresh").ok, true);
  assert.equal(validatePackedArtifacts(manifestPath, "stale").ok, false);
  assert.equal(validatePackedArtifacts(join(root, "missing.json"), "fresh").ok, false);
  mkdirSync(join(root, "directory.tgz"));
  writeFileSync(manifestPath, JSON.stringify({ sourceKey: "fresh", tarballs: [{ file: "directory.tgz" }] }));
  assert.equal(validatePackedArtifacts(manifestPath, "fresh").ok, false);
});

test("scene launcher resolves the same tarball override for validation and runtime", () => {
  const packageDir = "/repo/apps/agent-evals";
  assert.equal(resolveSceneTarballsDir(packageDir, {}), "/repo/apps/agent-evals/.work/tarballs");
  assert.equal(resolveSceneTarballsDir(packageDir, { VGPU_EVALS_TARBALLS_DIR: "/tmp/custom-tarballs" }), "/tmp/custom-tarballs");
});

test("launcher rejects competing scene credentials before fetch, pack, or spawn", () => {
  const now = Date.now();
  const oidc = token({ exp: Math.floor((now + 30 * 60_000) / 1000) });
  const launched = spawnSync(
    process.execPath,
    ["scripts/agent-evals.mjs", "--task", "scene-robot-arm", "--skip-pack"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        VERCEL_OIDC_TOKEN: oidc,
        AI_GATEWAY_API_KEY: "must-not-leak",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
      },
    },
  );
  const output = `${launched.stdout}\n${launched.stderr}`;
  assert.equal(launched.status, 2);
  assert.match(output, /project OIDC only/i);
  assert.doesNotMatch(output, /must-not-leak/);
  assert.doesNotMatch(output, /packing this branch|provider preflight|using checked branch tarballs/i);
});
