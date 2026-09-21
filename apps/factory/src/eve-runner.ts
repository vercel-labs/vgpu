import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  Client,
  type MessageResult,
  type MessageStreamEvent,
} from "eve/client";
import {
  TriageProposalSchema,
  type NormalizedTriageInput,
  type TriageProposal,
} from "../agent/lib/triage-schema.ts";
import { FACTORY_LIMITS } from "./constants.ts";
import { FactoryInterruptedError, FactoryRuntimeError } from "./errors.ts";
import { createEveInvocation } from "./eve-invocation.ts";
import { serializeTriagePrompt } from "./prompt.ts";
import {
  assembleTriageReport,
  validateAgentTurn,
} from "./triage-validation.ts";

interface OutputStreamLike {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
}

export interface EveChildProcess {
  readonly stdout: OutputStreamLike | null;
  readonly stderr: OutputStreamLike | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
}

export interface EveSessionLike {
  readonly state: { readonly sessionId?: string };
  cancel(): Promise<{ status: "accepted" | "no_active_turn" }>;
  stream(options: {
    signal: AbortSignal;
    startIndex?: number;
  }): AsyncIterable<MessageStreamEvent>;
  send(input: {
    message: string;
    outputSchema: typeof TriageProposalSchema;
    signal?: AbortSignal;
  }): Promise<{ result(): Promise<MessageResult<TriageProposal>> }>;
}

export interface EveClientLike {
  health(): Promise<unknown>;
  info(): Promise<unknown>;
  session(): EveSessionLike;
}

interface SignalTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface EveRunnerDependencies {
  readonly createInvocation?: typeof createEveInvocation;
  readonly createClient?: (host: string, token: string) => EveClientLike;
  readonly findOpenPort?: () => Promise<number>;
  readonly signalTarget?: SignalTarget;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeout?: (
    milliseconds: number,
    signal: AbortSignal
  ) => Promise<void>;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => EveChildProcess;
}

export interface EveServerOptions {
  readonly appRoot: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly agentTurnTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly cancellationGraceMs?: number;
  readonly dependencies?: EveRunnerDependencies;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolveDelay, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function findOpenLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(
          new FactoryRuntimeError("Unable to reserve a loopback port for eve.")
        );
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

function spawnEve(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): EveChildProcess {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function appendBoundedLog(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length <= 4_000 ? next : next.slice(-4_000);
}

function redactLog(log: string, environment: NodeJS.ProcessEnv): string {
  let redacted = log;
  for (const key of [
    "AI_GATEWAY_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "VGPU_FACTORY_LOCAL_TOKEN",
  ] as const) {
    const value = environment[key];
    if (value) {
      redacted = redacted.replaceAll(value, "[REDACTED]");
    }
  }
  return redacted.trim();
}

async function cancelSessions(
  sessions: ReadonlySet<EveSessionLike>,
  graceMs: number
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all(
        [...sessions].map(async (session) => {
          if (session.state.sessionId === undefined) return;
          try {
            const result = await session.cancel();
            if (result.status !== "accepted" || controller.signal.aborted)
              return;
            // This runner sends one turn per session. Reattach independently of
            // the aborted transport and observe a durable terminal boundary.
            for await (const event of session.stream({
              signal: controller.signal,
              startIndex: 0,
            })) {
              if (
                [
                  "session.waiting",
                  "session.completed",
                  "session.failed",
                ].includes(event.type)
              )
                return;
            }
          } catch {
            // Cancellation is cooperative and may race startup or a dead host.
            // Process termination + a never-reused app root are the backstop.
          }
        })
      ),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export async function withEveDevServer<T>(
  options: EveServerOptions,
  useServer: (
    client: EveClientLike,
    signal: AbortSignal,
    connection: { host: string; token: string; appRoot: string }
  ) => Promise<T>
): Promise<T> {
  const dependencies = options.dependencies ?? {};
  const findPort = dependencies.findOpenPort ?? findOpenLoopbackPort;
  const sleep = dependencies.sleep ?? delay;
  const timeout = dependencies.timeout ?? abortableDelay;
  const createClient: (host: string, token: string) => EveClientLike =
    dependencies.createClient ??
    ((host: string, token: string) => {
      const client = new Client({
        host,
        auth: { bearer: token },
        redirect: "error",
      });
      return {
        health: () => client.health(),
        info: () => client.info(),
        session: () => client.session(),
      };
    });
  const spawnProcess = dependencies.spawn ?? spawnEve;
  const signalTarget = dependencies.signalTarget ?? process;
  const { appRoot } = await (
    dependencies.createInvocation ?? createEveInvocation
  )(options.appRoot);
  const port = await findPort();
  const host = `http://127.0.0.1:${port}`;
  const token = randomBytes(32).toString("hex");
  const environment = {
    ...options.environment,
    VGPU_FACTORY_LOCAL_TOKEN: token,
  };
  const eveBin = resolve(appRoot, "node_modules/eve/bin/eve.js");
  const child = spawnProcess(
    process.execPath,
    [eveBin, "dev", "--no-ui", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: appRoot, env: environment }
  );

  let output = "";
  let spawnError: Error | undefined;
  let stopping = false;
  child.stdout?.on("data", (chunk) => {
    output = appendBoundedLog(output, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output = appendBoundedLog(output, chunk);
  });
  let resolveExit!: () => void;
  let rejectUnexpectedExit!: (error: Error) => void;
  const exitObserved = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const unexpectedExit = new Promise<never>((_resolve, reject) => {
    rejectUnexpectedExit = reject;
  });
  // The race always consumes this rejection while the child is active.
  void unexpectedExit.catch(() => undefined);
  child.once("error", (error) => {
    spawnError = error;
    resolveExit();
    if (!stopping) {
      rejectUnexpectedExit(
        new FactoryRuntimeError("Unable to start eve dev.", { cause: error })
      );
    }
  });
  child.once("exit", (code, signal) => {
    resolveExit();
    if (!stopping) {
      rejectUnexpectedExit(
        new FactoryRuntimeError(
          `eve dev exited unexpectedly (${
            signal ?? `code ${code ?? "unknown"}`
          }).${output.length > 0 ? `\n${redactLog(output, environment)}` : ""}`
        )
      );
    }
  });

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    stopPromise = (async () => {
      stopping = true;
      if (
        spawnError !== undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
      await Promise.race([exitObserved, sleep(options.stopGraceMs ?? 2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          return;
        }
        // A broken child-process implementation may never emit `exit`, even
        // after SIGKILL. Cleanup must remain bounded in that case.
        await Promise.race([exitObserved, sleep(options.stopGraceMs ?? 2_000)]);
      }
    })();
    return stopPromise;
  };

  const abortController = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  void interrupted.catch(() => undefined);
  const onSignal = (signal: "SIGINT" | "SIGTERM") => () => {
    if (interruptedBy !== undefined) {
      return;
    }
    interruptedBy = signal;
    const error = new FactoryInterruptedError(signal);
    abortController.abort(error);
    rejectInterrupted(error);
  };
  const onSigint = onSignal("SIGINT");
  const onSigterm = onSignal("SIGTERM");
  // Keep handlers installed throughout cancellation and process termination.
  // A second parent-directed signal must not orphan the still-running child.
  signalTarget.on("SIGINT", onSigint);
  signalTarget.on("SIGTERM", onSigterm);

  const startupDeadlineController = new AbortController();
  const startupDeadline = timeout(
    options.startupTimeoutMs ?? FACTORY_LIMITS.eveStartupTimeoutMs,
    startupDeadlineController.signal
  ).then<never>(() => {
    throw new FactoryRuntimeError(
      `eve dev did not become healthy before the startup deadline.${
        output.length > 0 ? `\n${redactLog(output, environment)}` : ""
      }`
    );
  });
  void startupDeadline.catch(() => undefined);
  const sessions = new Set<EveSessionLike>();

  try {
    const client = createClient(host, token);
    while (true) {
      if (spawnError !== undefined) {
        throw new FactoryRuntimeError("Unable to start eve dev.", {
          cause: spawnError,
        });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new FactoryRuntimeError(
          "eve dev exited before becoming healthy."
        );
      }
      try {
        await Promise.race([
          startupDeadline,
          unexpectedExit,
          interrupted,
          (async () => {
            await client.health();
            abortController.signal.throwIfAborted();
            // Health is public and can become ready before Eve activates its
            // runtime generation. Verify authenticated routes before any send.
            await client.info();
          })(),
        ]);
        startupDeadlineController.abort();
        break;
      } catch (error) {
        if (error instanceof FactoryRuntimeError) {
          throw error;
        }
        await Promise.race([
          startupDeadline,
          unexpectedExit,
          interrupted,
          sleep(100),
        ]);
      }
    }

    return await Promise.race([
      useServer(
        {
          health: () => client.health(),
          info: () => client.info(),
          session: () => {
            const session = client.session();
            sessions.add(session);
            return session;
          },
        },
        abortController.signal,
        { host, token, appRoot }
      ),
      unexpectedExit,
      interrupted,
    ]);
  } finally {
    startupDeadlineController.abort();
    abortController.abort(
      new FactoryRuntimeError("The eve development server is shutting down.")
    );
    try {
      await cancelSessions(sessions, options.cancellationGraceMs ?? 5_000);
    } finally {
      try {
        await stop();
      } finally {
        signalTarget.off("SIGINT", onSigint);
        signalTarget.off("SIGTERM", onSigterm);
      }
    }
  }
}

export async function invokeTriageTurn(
  client: EveClientLike,
  context: NormalizedTriageInput,
  signal?: AbortSignal
): Promise<TriageProposal> {
  let response: Awaited<
    ReturnType<ReturnType<EveClientLike["session"]>["send"]>
  >;
  try {
    response = await client.session().send({
      message: serializeTriagePrompt(context),
      outputSchema: TriageProposalSchema,
      signal,
    });
  } catch (error) {
    throw new FactoryRuntimeError("Unable to submit the triage turn to eve.", {
      cause: error,
    });
  }

  let result: MessageResult<TriageProposal>;
  try {
    result = await response.result();
  } catch (error) {
    throw new FactoryRuntimeError("Unable to consume the eve triage result.", {
      cause: error,
    });
  }
  return validateAgentTurn(result, context);
}

export async function runTriageAgent(
  context: NormalizedTriageInput,
  options: EveServerOptions
): Promise<ReturnType<typeof assembleTriageReport>> {
  return withEveDevServer(options, async (client, serverSignal) => {
    const turnController = new AbortController();
    const combinedSignal = AbortSignal.any([
      serverSignal,
      turnController.signal,
    ]);
    const timeoutMs =
      options.agentTurnTimeoutMs ?? FACTORY_LIMITS.agentTurnTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new FactoryRuntimeError(
          `Eve triage turn exceeded its ${timeoutMs}ms deadline.`
        );
        turnController.abort(error);
        reject(error);
      }, timeoutMs);
    });

    try {
      const proposal = await Promise.race([
        invokeTriageTurn(client, context, combinedSignal),
        deadline,
      ]);
      return assembleTriageReport(context, proposal);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      turnController.abort(
        new FactoryRuntimeError("The Eve triage turn has ended.")
      );
    }
  });
}
