import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/agent-evals, resolved from this file rather than from cwd. */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Host-side scratch root. Shared by the pack script (writer), the export hook
 * (writer) and the evals (readers), so the three can never disagree about
 * where an artefact landed.
 */
export function workDir(): string {
  return resolve(process.env.VGPU_EVALS_WORK_DIR || join(PACKAGE_ROOT, ".work"));
}

/** Tarballs of the vgpu packages built from the branch under test. */
export function tarballsDir(): string {
  return join(workDir(), "tarballs");
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
