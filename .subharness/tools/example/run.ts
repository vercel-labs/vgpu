// Runs a repository command for an example tool and keeps what an agent needs from it: exit code,
// duration, and the tail of the combined output.
import { spawn } from "node:child_process";

export interface CommandResult {
  readonly command: string;
  readonly code: number;
  readonly seconds: number;
  readonly output: string;
}

/**
 * Runs `command` through the shell in `cwd`, capturing stdout+stderr, and never throws on a non-zero
 * exit. Output is trimmed to the last `tailLines` lines.
 *
 * @example
 *   const result = await runCommand("node apps/docs/scripts/check-example-imports.mjs", root);
 *   result.code === 0;
 */
export function runCommand(command: string, cwd: string, options: { env?: NodeJS.ProcessEnv; tailLines?: number; timeoutMs?: number } = {}): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      env: { ...process.env, ...options.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") append(Buffer.from(`${String(error)}\n`));
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      // Keep the escalation even when the shell exits first: a grandchild may still own the pipes.
      setTimeout(() => killGroup("SIGKILL"), 3000);
    }, options.timeoutMs ?? 300_000);
    child.once("error", (error) => append(Buffer.from(`${error.message}\n`)));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const lines = output.replace(/\u001b\[[0-9;]*m/g, "").trimEnd().split("\n");
      resolve({
        command,
        code: timedOut ? 124 : code ?? (signal ? 124 : 1),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        output: lines.slice(-(options.tailLines ?? 40)).join("\n"),
      });
    });
  });
}
