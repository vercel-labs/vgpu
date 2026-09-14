import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { defineHook } from "eve/hooks";
import type { SandboxSession } from "eve/sandbox";
import { snapshotDir, snapshotTarPath } from "../lib/paths.ts";
import { requireTaskId } from "../lib/task.ts";
import { verifyN1HeroShader } from "../lib/verify/n1-hero-shader.mjs";
import { verifyNextBuild } from "../lib/verify/next-build.mjs";

const WORKSPACE = "/workspace";
const TAR_IN_SANDBOX = "/tmp/vgpu-agent-evals-workspace.tar";

/**
 * Everything that must happen inside the LIVE sandbox once the agent stops.
 *
 * Two jobs, in this order: run the task's own verification (which needs a live
 * sandbox — it builds, serves and drives a browser), then copy the workspace out
 * so the eval can look at the FILES the agent produced instead of believing what
 * it said about them.
 *
 * Why one hook with two sequential awaits rather than two hooks on the same
 * event: eve's ordering across multiple hooks registered for one event was not
 * something this suite verified, and losing that race would export a tar with no
 * verification artifacts in it — a silent hole, not a loud failure. One file
 * removes the question.
 *
 * Why a hook and not a channel: both work. `getSandbox()` lives on
 * `SessionContext`, which `HookContext` extends and which authored channel
 * EVENT handlers also receive — a channel could do this too. What cannot do it
 * is the shape this started as, a channel ROUTE handler: its `RouteHandlerArgs`
 * has no sandbox access (verified against eve 0.29.5's
 * `dist/src/channel/routes.d.ts`). A hook is preferred here because the export
 * is agent-scoped: it should happen for every session regardless of which
 * channel the run came in on.
 *
 * Nothing here is docker-specific — plain `tar` over `sandbox.run` plus a
 * binary read — so `VGPU_EVALS_SANDBOX=vercel` keeps working unchanged.
 */
export default defineHook({
  events: {
    "turn.completed": async (_event, ctx) => {
      const sessionId = ctx.session.id;
      const sandbox = await ctx.getSandbox();

      // Task-specific verification first, so its artifacts are inside the
      // workspace before the tar is taken. It never throws: a failed build is a
      // gate the eval reports, not an exception that loses the whole run.
      const taskId = requireTaskId();
      if (taskId === "n1-hero-shader") {
        await verifyN1HeroShader(sandbox);
      } else if (taskId === "n2-ship-hero" || taskId === "n3-explore-hero") {
        // Build + `vgpu check` only: these two tasks grade what the agent does at
        // the finishing moment, so no browser pass is needed and each run stays
        // in the minutes rather than n1's half hour.
        await verifyNextBuild(sandbox);
      }

      await exportWorkspaceTar(sandbox, sessionId);
    },
  },
});

async function exportWorkspaceTar(sandbox: SandboxSession, sessionId: string): Promise<void> {
      // `--exclude=./.next` (PR #272 review, P1-7): verify now runs `next
      // build` before this tar is taken, so every n1 turn would otherwise
      // carry a full Next build (typically 100-300 MB with cache) through an
      // in-memory Buffer on every export, for no reader — the eval's own
      // `SKIP_DIRS` already skips `.next` on the READ side and says so.
      const tar = await sandbox.run({
        command: `tar -cf ${TAR_IN_SANDBOX} --exclude=./node_modules --exclude=./.git --exclude=./.vgpu-tarballs --exclude=./.next -C ${WORKSPACE} .`,
      });
      if (tar.exitCode !== 0) {
        throw new Error(`export-workspace: tar failed (exit ${tar.exitCode}): ${tar.stderr ?? ""}`);
      }

      const bytes = await sandbox.readBinaryFile({ path: TAR_IN_SANDBOX });
      if (!bytes) {
        throw new Error(`export-workspace: ${TAR_IN_SANDBOX} was missing after a successful tar`);
      }

      // Write then rename: a reader must never observe a half-written tar, and
      // a failed turn must never leave a truncated one behind that looks like
      // the previous turn's good export.
      const destination = snapshotTarPath(sessionId);
      mkdirSync(snapshotDir(sessionId), { recursive: true });
      const staging = `${destination}.partial`;
      writeFileSync(staging, bytes);
      renameSync(staging, destination);
}
