#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeVersion } from "../src/cli-arguments.ts";
import {
  buildSanitizedEveEnvironment,
  type SanitizedEveEnvironment,
} from "../src/environment.ts";
import {
  displayError,
  exitCodeForError,
  FactoryRuntimeError,
  FactoryUsageError,
  FactoryInterruptedError,
} from "../src/errors.ts";
import {
  withEveDevServer,
  type EveRunnerDependencies,
} from "../src/eve-runner.ts";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface EvalChildProcess {
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
}

interface SignalTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface EvalLauncherDependencies {
  readonly appRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodeVersion?: string;
  readonly buildEnvironment?: (options: {
    appRoot: string;
    hostEnvironment: NodeJS.ProcessEnv;
  }) => Promise<SanitizedEveEnvironment>;
  readonly signalTarget?: SignalTarget;
  readonly serverDependencies?: EveRunnerDependencies;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: "inherit";
    }
  ) => EvalChildProcess;
  readonly stderr?: { write(value: string): unknown };
}

function spawnEval(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" }
): EvalChildProcess {
  return spawn(command, args, options);
}

export async function runFactoryEvals(
  argv: readonly string[],
  dependencies: EvalLauncherDependencies = {}
): Promise<number> {
  assertSupportedNodeVersion(dependencies.nodeVersion ?? process.versions.node);
  if (
    argv.some(
      (arg) => arg === "--" || arg === "--url" || arg.startsWith("--url=")
    )
  ) {
    throw new FactoryUsageError(
      "Factory evals require the local managed target; --url and -- are not supported."
    );
  }
  const appRoot = dependencies.appRoot ?? APP_ROOT;
  const hostEnvironment = dependencies.environment ?? process.env;
  const sanitized = await (
    dependencies.buildEnvironment ?? buildSanitizedEveEnvironment
  )({ appRoot, hostEnvironment });

  try {
    return await withEveDevServer(
      {
        appRoot,
        environment: sanitized.environment,
        dependencies: dependencies.serverDependencies,
      },
      async (_client, serverSignal, { host, token, appRoot: invocationRoot }) =>
        launchEval(
          [...argv, "--url", host],
          invocationRoot,
          resolve(invocationRoot, "node_modules/eve/bin/eve.js"),
          { ...sanitized.environment, EVE_EVAL_AUTH_TOKEN: token },
          serverSignal,
          dependencies
        )
    );
  } catch (error) {
    if (error instanceof FactoryInterruptedError)
      return error.signal === "SIGINT" ? 130 : 143;
    throw error;
  }
}

async function launchEval(
  argv: readonly string[],
  appRoot: string,
  eveBin: string,
  environment: NodeJS.ProcessEnv,
  serverSignal: AbortSignal,
  dependencies: EvalLauncherDependencies
): Promise<number> {
  const spawnProcess = dependencies.spawn ?? spawnEval;
  let child: EvalChildProcess;
  try {
    child = spawnProcess(process.execPath, [eveBin, "eval", ...argv], {
      cwd: appRoot,
      env: environment,
      stdio: "inherit",
    });
  } catch (error) {
    throw new FactoryRuntimeError("Unable to start eve eval.", {
      cause: error,
    });
  }

  const signalTarget = dependencies.signalTarget ?? process;
  let forwardedSignal: "SIGINT" | "SIGTERM" | undefined;
  const onSignal = (signal: "SIGINT" | "SIGTERM") => () => {
    const repeated = forwardedSignal !== undefined;
    forwardedSignal ??= signal;
    try {
      child.kill(repeated ? "SIGKILL" : signal);
    } catch {
      // The exit/error listeners remain authoritative if the process ended
      // between receiving the parent signal and forwarding it.
    }
  };
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  const onServerAbort = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Child already exited. */
    }
  };
  serverSignal.addEventListener("abort", onServerAbort, { once: true });
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);

  try {
    return await new Promise<number>((resolveExit, reject) => {
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(
          new FactoryRuntimeError("Unable to start eve eval.", { cause: error })
        );
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        if (typeof code === "number") {
          resolveExit(code);
          return;
        }
        const exitSignal = signal ?? forwardedSignal;
        resolveExit(
          exitSignal === "SIGINT" ? 130 : exitSignal === "SIGTERM" ? 143 : 1
        );
      });
    });
  } finally {
    serverSignal.removeEventListener("abort", onServerAbort);
    signalTarget.off("SIGINT", onSigint);
    signalTarget.off("SIGTERM", onSigterm);
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: EvalLauncherDependencies = {}
): Promise<number> {
  try {
    return await runFactoryEvals(argv, dependencies);
  } catch (error) {
    (dependencies.stderr ?? process.stderr).write(
      `factory evals: ${displayError(error)}\n`
    );
    return exitCodeForError(error);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
