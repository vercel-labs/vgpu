import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { defineHook } from "eve/hooks";
import { snapshotDir, snapshotTarPath } from "../lib/paths.ts";

const WORKSPACE = "/workspace";
const TAR_IN_SANDBOX = "/tmp/vgpu-agent-evals-workspace.tar";

/**
 * Copies the agent's workspace out of the sandbox after every completed turn,
 * so the eval can look at the FILES the agent produced instead of believing
 * what it said about them.
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

      const tar = await sandbox.run({
        command: `tar -cf ${TAR_IN_SANDBOX} --exclude=./node_modules --exclude=./.git --exclude=./.vgpu-tarballs -C ${WORKSPACE} .`,
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
    },
  },
});
