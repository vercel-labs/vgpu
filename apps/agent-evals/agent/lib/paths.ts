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

/** Everything captured for one session. */
export function snapshotDir(sessionId: string): string {
  return join(workDir(), "snapshots", sessionId);
}

/** The workspace tar the export hook writes for one session. */
export function snapshotTarPath(sessionId: string): string {
  return join(snapshotDir(sessionId), "workspace.tar");
}

/** Where a snapshot tar is extracted so the eval can read files out of it. */
export function snapshotWorkspaceDir(sessionId: string): string {
  return join(snapshotDir(sessionId), "workspace");
}
