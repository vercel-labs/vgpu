import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PATHS MUST COME FROM THE ENVIRONMENT, NOT FROM `import.meta.url`.
 *
 * eve's dev runtime snapshots the app and executes the compiled modules from
 *   <package>/.eve/dev-runtime/snapshots/<id>/source/apps/agent-evals/.eve/compile/authored-modules/<hash>.mjs
 * so a path derived from this file's own URL resolves inside that snapshot —
 * observed in the first real run as a bootstrap looking for tarballs in
 * `<snapshot>/.eve/.work/tarballs`, which cannot exist because `.work/` is
 * gitignored and never travels into the snapshot.
 *
 * It also splits writer from reader: the export hook runs in the runtime
 * process (snapshot paths) while the eval runs in the CLI process (real paths),
 * so a relative `.work/` silently sends the tar somewhere the eval never looks.
 *
 * `scripts/agent-evals.mjs` therefore exports absolute paths before launching
 * eve, and everything here prefers them. The `import.meta.url` fallback is kept
 * only for a direct `eve eval` from the package directory, where the CLI
 * process happens to resolve correctly.
 */
const PACKAGE_ROOT_FALLBACK = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Host-side scratch root: tarballs and per-session snapshots. */
export function workDir(): string {
  const fromEnv = process.env.VGPU_EVALS_WORK_DIR;
  return fromEnv ? resolve(fromEnv) : join(PACKAGE_ROOT_FALLBACK, ".work");
}

/** Tarballs of the vgpu packages built from the branch under test. */
export function tarballsDir(): string {
  const fromEnv = process.env.VGPU_EVALS_TARBALLS_DIR;
  return fromEnv ? resolve(fromEnv) : join(workDir(), "tarballs");
}

/**
 * Root of the per-task seed trees (`agent/sandbox/tasks/<id>/`).
 *
 * This is OUR directory, walked with node:fs and materialized into /workspace by
 * bootstrap. It is deliberately not `agent/sandbox/workspace/`, which is eve's
 * own discovery convention: that one is a single fixed slot, mounted once ("At
 * most one entry per agent; mounted." — eve's discover/manifest.ts), so it
 * cannot express "one of several seeds, chosen at run time".
 *
 * Env-first for the same reason as everything else here: bootstrap executes in
 * the runtime process, where a path derived from this module's URL resolves
 * inside eve's dev-runtime snapshot and would miss the real seed files.
 */
export function tasksDir(): string {
  const fromEnv = process.env.VGPU_EVALS_TASKS_DIR;
  return fromEnv ? resolve(fromEnv) : join(PACKAGE_ROOT_FALLBACK, "agent", "sandbox", "tasks");
}

/** The seed tree for one task, copied into /workspace at bootstrap. */
export function taskSeedDir(taskId: string): string {
  return join(tasksDir(), taskId);
}

/** Everything captured for one session. */
export function snapshotDir(sessionId: string): string {
  return join(workDir(), "snapshots", sessionId);
}

/** The workspace tar the export hook writes for one session. */
export function snapshotTarPath(sessionId: string): string {
  return join(snapshotDir(sessionId), "workspace.tar");
}

/** Immutable evidence for one logical turn. */
export function snapshotTurnDir(sessionId: string, turnId: string): string {
  return join(snapshotDir(sessionId), "turns", pathSegment(turnId));
}

/** Immutable evidence for one completion attempt of a logical turn. */
export function snapshotAttemptDir(sessionId: string, turnId: string, eventId: string): string {
  return join(snapshotTurnDir(sessionId, turnId), pathSegment(eventId));
}

export function snapshotAttemptTarPath(sessionId: string, turnId: string, eventId: string): string {
  return join(snapshotAttemptDir(sessionId, turnId, eventId), "workspace.tar");
}

export function snapshotAttemptVerifyTarPath(sessionId: string, turnId: string, eventId: string): string {
  return join(snapshotAttemptDir(sessionId, turnId, eventId), "verify.tar");
}

/** Written last, after the sandbox verify directory is removed and evidence is exported. */
export function snapshotAttemptCompletePath(sessionId: string, turnId: string, eventId: string): string {
  return join(snapshotAttemptDir(sessionId, turnId, eventId), "complete.json");
}

/**
 * Records first-seen logical turns in order. Retried completion events retain
 * their stage and get a new attempt directory beneath the same turn.
 */
export function recordSceneTurn(sessionId: string, turnId: string): { stage: number; isNew: boolean } {
  const directory = join(snapshotDir(sessionId), "turns");
  const orderPath = join(directory, "order.json");
  mkdirSync(directory, { recursive: true });
  let order: string[] = [];
  if (existsSync(orderPath)) {
    const parsed = JSON.parse(readFileSync(orderPath, "utf8")) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
      throw new Error(`scene turn order is corrupt at ${orderPath}`);
    }
    order = parsed;
  }
  let index = order.indexOf(turnId);
  const isNew = index === -1;
  if (isNew) {
    order.push(turnId);
    index = order.length - 1;
    const staging = `${orderPath}.partial`;
    writeFileSync(staging, `${JSON.stringify(order, null, 2)}\n`, "utf8");
    renameSync(staging, orderPath);
  }
  return { stage: index + 1, isNew };
}

/** Where a snapshot tar is extracted so the eval can read files out of it. */
export function snapshotWorkspaceDir(sessionId: string): string {
  return join(snapshotDir(sessionId), "workspace");
}

function pathSegment(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("snapshot identifier must be nonempty");
  return encodeURIComponent(value);
}
