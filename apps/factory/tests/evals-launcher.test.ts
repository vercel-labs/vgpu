import { EventEmitter } from "node:events";
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
    findOpenPort: async () => 43210,
    createClient: () => ({
      health: async () => undefined,
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
        serverDependencies: serverDependencies(),
      })
    ).resolves.toBe(0);

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "/repo/apps/factory/node_modules/eve/bin/eve.js",
        "eval",
        "--tag",
        "triage",
        "--strict",
        "--url",
        "http://127.0.0.1:43210",
      ],
      {
        cwd: "/repo/apps/factory",
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
