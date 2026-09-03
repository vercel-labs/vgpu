import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  main,
  runFactoryEvals,
  type EvalChildProcess,
} from "../scripts/evals.ts";
import { FactoryConfigurationError } from "../src/errors.ts";

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
      ],
      {
        cwd: "/repo/apps/factory",
        env: sanitizedEnvironment,
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
      spawn: () => {
        queueMicrotask(() => child.emit("error", new Error("ENOENT")));
        return child;
      },
    });
    await expect(runtime).rejects.toThrow("Unable to start eve eval");
  });
});
