import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { MessageResult, MessageStreamEvent } from "eve/client";
import {
  TriageProposalSchema,
  type TriageProposal,
} from "../agent/lib/triage-schema.ts";
import {
  invokeTriageTurn,
  runTriageAgent,
  withEveDevServer,
  type EveChildProcess,
  type EveClientLike,
} from "../src/eve-runner.ts";
import { makeContext, makeEvents, makeProposal } from "./test-helpers.ts";

class FakeChild extends EventEmitter implements EveChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

const idleSession = {
  state: {},
  cancel: async () => ({ status: "no_active_turn" as const }),
  stream: async function* () {},
};

function clientWithHealth(
  health = vi.fn(async () => ({ ok: true }))
): EveClientLike {
  return {
    health,
    info: async () => undefined,
    session: () => ({
      ...idleSession,
      send: vi.fn(async () => {
        throw new Error("send was not configured");
      }),
    }),
  };
}

const filesystem = {
  createInvocation: async (appRoot: string) => ({ appRoot }),
};

describe("withEveDevServer", () => {
  it("keeps a hung authenticated readiness probe inside the startup deadline", async () => {
    const child = new FakeChild();
    const info = vi.fn(() => new Promise<never>(() => undefined));
    const useServer = vi.fn(async () => undefined);
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: {},
          startupTimeoutMs: 5,
          dependencies: {
            ...filesystem,
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            spawn: () => child,
            createClient: () => ({ ...clientWithHealth(), info }),
          },
        },
        useServer
      )
    ).rejects.toThrow("startup deadline");
    expect(info).toHaveBeenCalledOnce();
    expect(useServer).not.toHaveBeenCalled();
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("waits for authenticated agent readiness even when the public health route is already healthy", async () => {
    const child = new FakeChild();
    let ready = false;
    const info = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime generation is not active yet"))
      .mockImplementation(async () => {
        ready = true;
      });
    const useServer = vi.fn(async () => {
      expect(ready).toBe(true);
      return "ready";
    });
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: {},
          dependencies: {
            ...filesystem,
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            spawn: () => child,
            sleep: async () => undefined,
            createClient: () => ({ ...clientWithHealth(), info }),
          },
        },
        useServer
      )
    ).resolves.toBe("ready");
    expect(info).toHaveBeenCalledTimes(2);
    expect(useServer).toHaveBeenCalledOnce();
  });

  it.each(["request", "stream"])(
    "bounds cleanup when the cancellation %s never settles",
    async (hang) => {
      const child = new FakeChild();
      const cancel = vi.fn(async () =>
        hang === "request"
          ? new Promise<never>(() => undefined)
          : { status: "accepted" as const }
      );
      await expect(
        withEveDevServer(
          {
            appRoot: "/app",
            environment: {},
            cancellationGraceMs: 1,
            dependencies: {
              ...filesystem,
              findOpenPort: async () => 12345,
              signalTarget: new EventEmitter(),
              spawn: () => child,
              createClient: () => ({
                health: async () => undefined,
                info: async () => undefined,
                session: () => ({
                  state: { sessionId: "session-1" },
                  cancel,
                  send: async () => {
                    throw new Error("not used");
                  },
                  stream: async function* () {
                    await new Promise<never>(() => undefined);
                  },
                }),
              }),
            },
          },
          async (client) => {
            client.session();
            throw new Error("interrupted");
          }
        )
      ).rejects.toThrow("interrupted");
      expect(cancel).toHaveBeenCalledOnce();
      expect(child.kills).toEqual(["SIGTERM"]);
    }
  );

  it.each(["timeout", "SIGTERM"])(
    "cancels a turn on %s and observes its boundary before stopping Eve",
    async (interruption) => {
      const child = new FakeChild();
      const signalTarget = new EventEmitter();
      const order: string[] = [];
      child.once("exit", () => order.push("stopped"));
      let turnSignal: AbortSignal | undefined;
      const client: EveClientLike = {
        health: async () => undefined,
        info: async () => undefined,
        session: () => ({
          state: { sessionId: "session-1" },
          send: async ({ signal }) => {
            turnSignal = signal;
            if (interruption === "SIGTERM")
              queueMicrotask(() => signalTarget.emit("SIGTERM"));
            return { result: () => new Promise<never>(() => undefined) };
          },
          cancel: async () => {
            expect(turnSignal?.aborted).toBe(true);
            expect(child.signalCode).toBeNull();
            order.push("cancel");
            return { status: "accepted" as const };
          },
          stream: async function* ({ signal }) {
            expect(signal.aborted).toBe(false);
            order.push("cancelled");
            yield { type: "turn.cancelled" } as MessageStreamEvent;
            order.push("waiting");
            yield { type: "session.waiting" } as MessageStreamEvent;
          },
        }),
      };
      await expect(
        runTriageAgent(makeContext(), {
          appRoot: "/app",
          environment: {},
          agentTurnTimeoutMs: 1,
          dependencies: {
            ...filesystem,
            createClient: () => client,
            findOpenPort: async () => 12345,
            signalTarget,
            spawn: () => child,
          },
        })
      ).rejects.toThrow(
        interruption === "timeout" ? "deadline" : "Interrupted by SIGTERM"
      );
      expect(order).toEqual(["cancel", "cancelled", "waiting", "stopped"]);
    }
  );

  it("starts Eve on an ephemeral loopback port, waits for health, and always terminates it", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: { cwd: string; env: NodeJS.ProcessEnv }
      ) => child
    );
    const health = vi
      .fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue({ ok: true });
    const signalTarget = new EventEmitter();

    const value = await withEveDevServer(
      {
        appRoot: "/repo/apps/factory",
        environment: { PATH: "/bin", AI_GATEWAY_API_KEY: "secret" },
        dependencies: {
          createInvocation: async () => ({ appRoot: "/isolated/run" }),
          createClient: (host, token) => {
            expect(host).toBe("http://127.0.0.1:43210");
            expect(token).toMatch(/^[a-f0-9]{64}$/);
            expect(spawn.mock.calls[0]![2].env.VGPU_FACTORY_LOCAL_TOKEN).toBe(
              token
            );
            return clientWithHealth(health);
          },
          findOpenPort: async () => 43210,
          signalTarget,
          sleep: async () => undefined,
          spawn,
        },
      },
      async () => "done"
    );

    expect(value).toBe("done");
    expect(health).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledOnce();
    const [, args, spawnOptions] = spawn.mock.calls[0]!;
    expect(args).toEqual([
      "/isolated/run/node_modules/eve/bin/eve.js",
      "dev",
      "--no-ui",
      "--host",
      "127.0.0.1",
      "--port",
      "43210",
    ]);
    expect(spawnOptions).toEqual({
      cwd: "/isolated/run",
      env: {
        PATH: "/bin",
        AI_GATEWAY_API_KEY: "secret",
        VGPU_FACTORY_LOCAL_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("cleans up when work fails", async () => {
    const child = new FakeChild();
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            spawn: () => child,
          },
        },
        async () => {
          throw new Error("work failed");
        }
      )
    ).rejects.toThrow("work failed");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("fails a startup deadline and redacts Gateway credentials from Eve logs", async () => {
    const child = new FakeChild();
    const health = vi.fn(async () => {
      throw new Error("not ready");
    });
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "gateway-secret" },
          startupTimeoutMs: 100,
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(health),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            sleep: async () => undefined,
            timeout: async () => {
              child.stderr.emit("data", "failed while using gateway-secret");
            },
            spawn: () => child,
          },
        },
        async () => undefined
      )
    ).rejects.toSatisfy(
      (error: Error) =>
        error.message.includes("[REDACTED]") &&
        !error.message.includes("gateway-secret")
    );
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("bounds a health probe that never settles", async () => {
    const child = new FakeChild();
    const health = vi.fn(() => new Promise<never>(() => undefined));
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(health),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            timeout: async () => undefined,
            spawn: () => child,
          },
        },
        async () => undefined
      )
    ).rejects.toThrow("startup deadline");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("settles when spawn emits error without a later exit event", async () => {
    const child = new FakeChild();
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          dependencies: {
            ...filesystem,
            createClient: () =>
              clientWithHealth(
                vi.fn(() => new Promise<never>(() => undefined))
              ),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            spawn: () => {
              queueMicrotask(() => child.emit("error", new Error("ENOENT")));
              return child;
            },
          },
        },
        async () => undefined
      )
    ).rejects.toThrow("Unable to start eve dev");
    expect(child.kills).toEqual([]);
  });

  it("does not wait forever when a child never reports exit after SIGKILL", async () => {
    const child = new FakeChild();
    child.kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      child.kills.push(signal);
      return true;
    });
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          stopGraceMs: 1,
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            sleep: async () => undefined,
            spawn: () => child,
          },
        },
        async () => "done"
      )
    ).resolves.toBe("done");
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stops and fails when the process receives SIGTERM", async () => {
    const child = new FakeChild();
    const signalTarget = new EventEmitter();
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(),
            findOpenPort: async () => 12345,
            signalTarget,
            spawn: () => child,
          },
        },
        async () => {
          queueMicrotask(() => signalTarget.emit("SIGTERM"));
          return new Promise<never>(() => undefined);
        }
      )
    ).rejects.toThrow("Interrupted by SIGTERM");
    expect(child.kills).toEqual(["SIGTERM"]);
  });

  it("fails when Eve exits unexpectedly", async () => {
    const child = new FakeChild();
    let serverSignal: AbortSignal | undefined;
    await expect(
      withEveDevServer(
        {
          appRoot: "/app",
          environment: { AI_GATEWAY_API_KEY: "secret" },
          dependencies: {
            ...filesystem,
            createClient: () => clientWithHealth(),
            findOpenPort: async () => 12345,
            signalTarget: new EventEmitter(),
            spawn: () => child,
          },
        },
        async (_client, signal) => {
          serverSignal = signal;
          queueMicrotask(() => child.exit(7));
          return new Promise<never>(() => undefined);
        }
      )
    ).rejects.toThrow("code 7");
    expect(serverSignal?.aborted).toBe(true);
  });

  it("enforces a hard turn deadline when the Eve client ignores abort signals", async () => {
    const child = new FakeChild();
    const client: EveClientLike = {
      health: async () => ({ ok: true }),
      info: async () => undefined,
      session: () => ({
        ...idleSession,
        send: vi.fn(() => new Promise<never>(() => undefined)),
      }),
    };

    await expect(
      runTriageAgent(makeContext(), {
        appRoot: "/app",
        environment: { AI_GATEWAY_API_KEY: "secret" },
        agentTurnTimeoutMs: 1,
        dependencies: {
          ...filesystem,
          createClient: () => client,
          findOpenPort: async () => 12345,
          signalTarget: new EventEmitter(),
          spawn: () => child,
        },
      })
    ).rejects.toThrow("turn exceeded its 1ms deadline");
    expect(child.kills).toEqual(["SIGTERM"]);
  });
});

describe("invokeTriageTurn", () => {
  it("uses a per-turn output schema and validates the complete result", async () => {
    const context = makeContext();
    const proposal = makeProposal();
    const messageResult: MessageResult<TriageProposal> = {
      status: "completed",
      data: proposal,
      events: [
        ...makeEvents(context, proposal.security, { sessionId: "session-1" }),
        {
          type: "result.completed",
          data: {
            result: proposal,
            sequence: 0,
            stepIndex: 0,
            turnId: "turn-1",
          },
        },
        {
          type: "turn.completed",
          data: { sequence: 0, turnId: "turn-1" },
        },
        { type: "session.completed" },
      ] as MessageStreamEvent[],
      message: undefined,
      inputRequests: [],
      sessionId: "session-1",
    };
    const result = vi.fn(async () => messageResult);
    const send = vi.fn(
      async (_input: {
        message: string;
        outputSchema: typeof TriageProposalSchema;
        signal?: AbortSignal;
      }) => ({ result })
    );
    const client: EveClientLike = {
      health: async () => ({ ok: true }),
      info: async () => undefined,
      session: () => ({ ...idleSession, send }),
    };
    const signal = new AbortController().signal;

    await expect(invokeTriageTurn(client, context, signal)).resolves.toEqual(
      proposal
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({
      outputSchema: TriageProposalSchema,
      signal,
    });
    expect(send.mock.calls[0]![0].message).toContain("VGPU_UNTRUSTED_ISSUE_");
    expect(result).toHaveBeenCalledOnce();
  });

  it("classifies client submission and stream failures as runtime errors", async () => {
    const context = makeContext();
    const sendFailure: EveClientLike = {
      health: async () => undefined,
      info: async () => undefined,
      session: () => ({
        ...idleSession,
        send: vi.fn(async () => Promise.reject(new Error("transport"))),
      }),
    };
    await expect(invokeTriageTurn(sendFailure, context)).rejects.toThrow(
      "submit"
    );

    const resultFailure: EveClientLike = {
      health: async () => undefined,
      info: async () => undefined,
      session: () => ({
        ...idleSession,
        send: vi.fn(async () => ({
          result: async () => Promise.reject(new Error("stream")),
        })),
      }),
    };
    await expect(invokeTriageTurn(resultFailure, context)).rejects.toThrow(
      "consume"
    );
  });
});
