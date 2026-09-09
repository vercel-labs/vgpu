import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  main,
  runFactoryEvals,
  type EvalChildProcess,
} from "../scripts/evals.ts";
import { FactoryConfigurationError } from "../src/errors.ts";
import type { EveChildProcess } from "../src/eve-runner.ts";

class FakeServer extends EventEmitter implements EveChildProcess {
  stdout = null;
  stderr = null;
  exitCode = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

function serverDependencies() {
  return {
    createInvocation: async (appRoot: string) => ({ appRoot }),
    findOpenPort: async () => 43210,
    createClient: () => ({
      health: async () => undefined,
      info: async () => undefined,
      session: () => {
        throw new Error("unused");
      },
    }),
    spawn: () => new FakeServer(),
    signalTarget: new EventEmitter(),
  };
}

class FakeChild extends EventEmitter implements EvalChildProcess {
  killed = false;
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.kills.push(signal);
    this.emit("exit", null, signal);
    return true;
  }

  exit(code: number): void {
    this.emit("exit", code, null);
  }
}

describe("runFactoryEvals", () => {
  it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGINT"] as const)(
    "does not swallow %s while preparing an invocation before any server exists",
    async (signal) => {
      const launcherUrl = new URL("../scripts/evals.ts", import.meta.url).href;
      const parent = spawnProcess(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { runFactoryEvals } from ${JSON.stringify(launcherUrl)};
      setTimeout(() => process.exit(78), 2_000);
      await runFactoryEvals([], {
        environment: {},
        buildEnvironment: async () => ({ environment: {}, credentialKind: "AI_GATEWAY_API_KEY", model: "mock" }),
        serverDependencies: {
          createInvocation: async () => { process.stdout.write("preparing"); await new Promise(() => {}); },
          spawn: () => { throw new Error("Must never start a server after stop"); },
        },
      });
    `,
        ],
        { env: {}, stdio: ["ignore", "pipe", "pipe"] }
      );
      const closed = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve, reject) => {
        parent.once("error", reject);
        parent.once("close", (code, signal) => resolve({ code, signal }));
      });
      parent.stdout.once("data", () => parent.kill(signal));
      try {
        await expect(closed).resolves.toEqual({ code: null, signal });
      } finally {
        if (parent.exitCode === null && parent.signalCode === null)
          parent.kill("SIGKILL");
      }
    }
  );

  it("preserves a signal exit code when the eval and managed server share the process signal target", async () => {
    const signalTarget = new EventEmitter();
    const child = new FakeChild();
    await expect(
      runFactoryEvals([], {
        nodeVersion: "24.0.0",
        signalTarget,
        serverDependencies: { ...serverDependencies(), signalTarget },
        buildEnvironment: async () => ({
          environment: {},
          credentialKind: "AI_GATEWAY_API_KEY",
          model: "mock",
        }),
        spawn: () => {
          queueMicrotask(() => signalTarget.emit("SIGTERM"));
          return child;
        },
      })
    ).resolves.toBe(143);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    ["--url", "https://example.com"],
    ["--url=https://example.com"],
    ["--", "--url", "https://example.com"],
  ])(
    "refuses target overrides before starting credential-bearing processes: %j",
    async (...argv) => {
      const spawn = vi.fn();
      const buildEnvironment = vi.fn();
      await expect(
        runFactoryEvals(argv, {
          nodeVersion: "24.0.0",
          spawn,
          buildEnvironment,
        })
      ).rejects.toThrow("local managed target");
      expect(spawn).not.toHaveBeenCalled();
      expect(buildEnvironment).not.toHaveBeenCalled();
    }
  );
  it("spawns Eve eval with only the sanitized child environment", async () => {
    const child = new FakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const signalTarget = new EventEmitter();
    const hostEnvironment = {
      AI_GATEWAY_API_KEY: "gateway-secret",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "database-secret",
    };
    const sanitizedEnvironment = {
      AI_GATEWAY_API_KEY: "gateway-secret",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      DATABASE_URL: "",
      VGPU_FACTORY_MODEL: "test-model",
    };

    await expect(
      runFactoryEvals(["--tag", "triage", "--strict"], {
        appRoot: "/repo/apps/factory",
        environment: hostEnvironment,
        nodeVersion: "24.0.0",
        buildEnvironment: async () => ({
          environment: sanitizedEnvironment,
          credentialKind: "AI_GATEWAY_API_KEY",
          model: "test-model",
          githubToken: "github-secret",
        }),
        signalTarget,
        spawn,
        serverDependencies: {
          ...serverDependencies(),
          createInvocation: async () => ({ appRoot: "/isolated/evals" }),
        },
      })
    ).resolves.toBe(0);

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "/isolated/evals/node_modules/eve/bin/eve.js",
        "eval",
        "--tag",
        "triage",
        "--strict",
        "--url",
        "http://127.0.0.1:43210",
      ],
      {
        cwd: "/isolated/evals",
        env: {
          ...sanitizedEnvironment,
          EVE_EVAL_AUTH_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        stdio: "inherit",
      }
    );
    const spawnCall = spawn.mock.calls[0] as unknown as [
      string,
      readonly string[],
      { env: NodeJS.ProcessEnv }
    ];
    const spawnedEnvironment = spawnCall[2].env;
    expect(spawnedEnvironment.GITHUB_TOKEN).toBe("");
    expect(spawnedEnvironment.DATABASE_URL).toBe("");
    expect(Object.values(spawnedEnvironment)).not.toContain("github-secret");
    expect(signalTarget.listenerCount("SIGINT")).toBe(0);
    expect(signalTarget.listenerCount("SIGTERM")).toBe(0);
  });

  it("preserves Eve exit codes", async () => {
    const child = new FakeChild();
    await expect(
      runFactoryEvals([], {
        nodeVersion: "24.0.0",
        buildEnvironment: async () => ({
          environment: { AI_GATEWAY_API_KEY: "key" },
          credentialKind: "AI_GATEWAY_API_KEY",
          model: "model",
        }),
        signalTarget: new EventEmitter(),
        serverDependencies: serverDependencies(),
        spawn: () => {
          queueMicrotask(() => child.exit(2));
          return child;
        },
      })
    ).resolves.toBe(2);
  });

  it("forwards termination signals, escalating a repeated signal to SIGKILL", async () => {
    const child = new FakeChild();
    const signalTarget = new EventEmitter();
    const run = runFactoryEvals([], {
      nodeVersion: "24.0.0",
      buildEnvironment: async () => ({
        environment: { AI_GATEWAY_API_KEY: "key" },
        credentialKind: "AI_GATEWAY_API_KEY",
        model: "model",
      }),
      signalTarget,
      serverDependencies: serverDependencies(),
      spawn: () => {
        queueMicrotask(() => {
          signalTarget.emit("SIGTERM");
          signalTarget.emit("SIGTERM");
        });
        return child;
      },
    });
    await expect(run).resolves.toBe(143);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("maps configuration and spawn failures to their CLI exit classes", async () => {
    let stderr = "";
    await expect(
      main([], {
        nodeVersion: "24.0.0",
        buildEnvironment: async () => {
          throw new FactoryConfigurationError("credential missing");
        },
        stderr: { write: (value) => (stderr += value) },
      })
    ).resolves.toBe(2);
    expect(stderr).toContain("credential missing");

    const child = new FakeChild();
    const runtime = runFactoryEvals([], {
      nodeVersion: "24.0.0",
      buildEnvironment: async () => ({
        environment: { AI_GATEWAY_API_KEY: "key" },
        credentialKind: "AI_GATEWAY_API_KEY",
        model: "model",
      }),
      signalTarget: new EventEmitter(),
      serverDependencies: serverDependencies(),
      spawn: () => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      },
    });
    await expect(runtime).rejects.toThrow("Unable to start eve eval");
  });
});
