import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, ClientError } from "eve/client";
import { expect, it } from "vitest";
import { createEveInvocation } from "../src/eve-invocation.ts";
import { runFactoryEvals } from "../scripts/evals.ts";

const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SYNTHETIC_TOKEN = "1".repeat(64);

async function expectNoTokenInArtifacts(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Never traverse the shared dependency link outside the owned fixture.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await expectNoTokenInArtifacts(path);
    if (entry.isFile()) {
      expect((await readFile(path)).includes(SYNTHETIC_TOKEN), path).toBe(
        false
      );
    }
  }
}

function fixtureEnvironment(testRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: testRoot,
    TMPDIR: testRoot,
    CI: "1",
    NO_COLOR: "1",
    EVE_TRACES: "off",
    EVE_TRACES_CONTENT: "off",
    VGPU_FACTORY_LOCAL_TOKEN: SYNTHETIC_TOKEN,
    FACTORY_TEST_CALLS: join(testRoot, "model-calls.txt"),
    FACTORY_TEST_HOST_PID: join(testRoot, "host-pid.txt"),
  };
}

async function writeRuntimeFixture(sourceAppRoot: string): Promise<void> {
  const sources = {
    "package.json": JSON.stringify({
      name: "factory-isolation-fixture",
      type: "module",
      dependencies: { eve: "0.29.5", ai: "^7.0.38", zod: "^4.4.3" },
    }),
    "tsconfig.json":
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}',
    "agent/instructions.md": "Return the deterministic fixture response.",
    "agent/agent.ts": `
import { appendFile, writeFile } from "node:fs/promises";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  modelContextWindowTokens: 128_000,
  model: mockModel(async ({ lastUserMessage }) => {
    await writeFile(process.env.FACTORY_TEST_HOST_PID!, String(process.pid));
    await appendFile(process.env.FACTORY_TEST_CALLS!, lastUserMessage + "\\n");
    if (lastUserMessage === "interrupted") await new Promise(resolve => setTimeout(resolve, 120_000));
    return "Deterministic fixture reply";
  }),
});
`,
    // Compile the production auth channel inside the deterministic fixture.
    "agent/channels/eve.ts": await readFile(
      join(FACTORY_ROOT, "agent/channels/eve.ts"),
      "utf8"
    ),
    "src/fixture.ts": 'export const reply = "Deterministic fixture reply";',
    "evals/evals.config.ts":
      'import { defineEvalConfig } from "eve/evals"; export default defineEvalConfig({});',
    "evals/smoke.eval.ts": `
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { reply } from "../src/fixture.ts";
export default defineEval({
  async test(t) {
    await t.send("fresh");
    t.succeeded();
    t.check(t.reply, equals(reply));
  },
});
`,
  };
  for (const [relativePath, source] of Object.entries(sources)) {
    const path = join(sourceAppRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  }
  await symlink(
    join(FACTORY_ROOT, "node_modules"),
    join(sourceAppRoot, "node_modules"),
    "junction"
  );
}

async function openPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  if (address === null || typeof address === "string")
    throw new Error("Missing test port.");
  return address.port;
}

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  checkRunning?: () => void,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 450; attempt += 1) {
    checkRunning?.();
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      if (!shouldRetry(error)) throw error;
      lastError = error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the isolated Eve fixture.", {
    cause: lastError,
  });
}

async function stop(
  child: ChildProcess,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM"
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve())
  );
  child.kill(signal);
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(3_000)]);
  }
}

async function boot(
  appRoot: string,
  testRoot: string
): Promise<{
  child: ChildProcess;
  client: Client;
  host: string;
  diagnostics: () => string;
}> {
  const port = await openPort();
  const host = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      join(appRoot, "node_modules/eve/bin/eve.js"),
      "dev",
      "--no-ui",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: appRoot,
      env: fixtureEnvironment(testRoot),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let diagnostics = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const checkRunning = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Eve exited during startup: ${diagnostics}`);
    }
  };
  try {
    await eventually(
      async () => {
        const response = await fetch(`${host}/eve/v1/health`, {
          signal: AbortSignal.timeout(500),
        });
        return response.ok;
      },
      Boolean,
      checkRunning
    );
    // Health is static and can respond before Eve activates the generation
    // used by channel dispatch. The authenticated info route exercises that
    // generation without submitting a turn, matching Eve's own eval readiness.
    await eventually(
      async () => {
        const response = await fetch(`${host}/eve/v1/info`, {
          headers: { authorization: `Bearer ${SYNTHETIC_TOKEN}` },
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) {
          const body = await response.text();
          diagnostics += `\nReadiness /info: ${response.status} ${body}`;
          throw new ClientError(response.status, body, response.headers);
        }
        await response.json();
        return true;
      },
      Boolean,
      checkRunning,
      (error) =>
        (error instanceof ClientError && error.status >= 500) ||
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === "TimeoutError")
    );
    return {
      child,
      host,
      diagnostics: () => diagnostics,
      client: new Client({
        host,
        auth: { bearer: SYNTHETIC_TOKEN },
        redirect: "error",
      }),
    };
  } catch (error) {
    await stop(child);
    throw new Error(`Isolated Eve startup failed: ${diagnostics}`, {
      cause: error,
    });
  }
}

it.each(["SIGTERM", "SIGKILL"] as const)(
  "stops the runtime after %s and does not recover its interrupted mock turn in the next invocation",
  async (signal) => {
    const testRoot = await mkdtemp(
      join(tmpdir(), "vgpu-runtime-isolation-test-")
    );
    const sourceAppRoot = join(testRoot, "source");
    const invocationRoots: string[] = [];
    const children: ChildProcess[] = [];
    const hostPids: number[] = [];
    try {
      await writeRuntimeFixture(sourceAppRoot);

      const first = await createEveInvocation(sourceAppRoot);
      invocationRoots.push(first.appRoot);
      const firstServer = await boot(first.appRoot, testRoot);
      children.push(firstServer.child);
      const unauthorized = await fetch(`${firstServer.host}/eve/v1/session`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: "https://attacker.invalid",
        },
        body: JSON.stringify({ message: "unauthorized" }),
        signal: AbortSignal.timeout(5_000),
      });
      const unauthorizedBody = await unauthorized.text();
      expect(
        unauthorized.status,
        `Unexpected auth response: ${unauthorizedBody}\n${firstServer.diagnostics()}`
      ).toBe(401);
      await firstServer.client
        .session()
        .send({ message: "interrupted", signal: AbortSignal.timeout(10_000) });
      await eventually(
        () => readFile(join(testRoot, "model-calls.txt"), "utf8"),
        (calls) => calls === "interrupted\n"
      );
      const firstHostPid = Number(
        await readFile(join(testRoot, "host-pid.txt"), "utf8")
      );
      expect(Number.isInteger(firstHostPid) && firstHostPid > 0).toBe(true);
      hostPids.push(firstHostPid);
      await stop(firstServer.child, signal);
      await eventually(async () => {
        try {
          process.kill(firstHostPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }, Boolean);

      const firstRunDirectory = join(first.appRoot, ".eve/.workflow-data/runs");
      const firstRunNames = (await readdir(firstRunDirectory)).filter((name) =>
        name.endsWith(".json")
      );
      const firstRuns = await Promise.all(
        firstRunNames.map(
          async (name) =>
            JSON.parse(
              await readFile(join(firstRunDirectory, name), "utf8")
            ) as { status: string }
        )
      );
      expect(
        firstRuns.some(
          (run) => run.status === "running" || run.status === "pending"
        )
      ).toBe(true);
      await expectNoTokenInArtifacts(join(first.appRoot, ".eve"));

      const second = await createEveInvocation(sourceAppRoot);
      invocationRoots.push(second.appRoot);
      const secondServer = await boot(second.appRoot, testRoot);
      children.push(secondServer.child);
      const response = await secondServer.client
        .session()
        .send({ message: "fresh", signal: AbortSignal.timeout(15_000) });
      const result = await response.result();
      const secondHostPid = Number(
        await readFile(join(testRoot, "host-pid.txt"), "utf8")
      );
      expect(Number.isInteger(secondHostPid) && secondHostPid > 0).toBe(true);
      hostPids.push(secondHostPid);
      expect(result.message).toBe("Deterministic fixture reply");
      expect(await readFile(join(testRoot, "model-calls.txt"), "utf8")).toBe(
        "interrupted\nfresh\n"
      );
      expect(await readdir(firstRunDirectory)).toContain(firstRunNames[0]);
      await stop(secondServer.child);
      await expectNoTokenInArtifacts(join(second.appRoot, ".eve"));
      await expect(
        readFile(join(sourceAppRoot, ".eve/dev-runtime/current.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all(children.map((child) => stop(child)));
      for (const hostPid of hostPids) {
        // These PIDs were reported by this test's own deterministic provider.
        try {
          process.kill(hostPid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      await Promise.all(
        invocationRoots.map((root) =>
          rm(root, { recursive: true, force: true })
        )
      );
      await rm(testRoot, { recursive: true, force: true });
    }
  },
  120_000
);

it("runs the real eval launcher against the authenticated mock fixture without provider credentials", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "vgpu-eval-runtime-test-"));
  const sourceAppRoot = join(testRoot, "source");
  const invocationRoots: string[] = [];
  try {
    await writeRuntimeFixture(sourceAppRoot);
    const signalTarget = new EventEmitter();
    const code = await runFactoryEvals(["smoke", "--strict"], {
      appRoot: sourceAppRoot,
      environment: {},
      buildEnvironment: async () => ({
        environment: fixtureEnvironment(testRoot),
        // The fixture supplies its own mockModel; no actual provider key exists.
        credentialKind: "AI_GATEWAY_API_KEY",
        model: "eve-mock/model",
      }),
      signalTarget,
      serverDependencies: {
        signalTarget,
        createInvocation: async (sourceRoot) => {
          const invocation = await createEveInvocation(sourceRoot);
          invocationRoots.push(invocation.appRoot);
          return invocation;
        },
      },
    });
    expect(code).toBe(0);
    expect(await readFile(join(testRoot, "model-calls.txt"), "utf8")).toBe(
      "fresh\n"
    );
    expect(
      await readdir(join(invocationRoots[0]!, ".eve/evals"))
    ).not.toHaveLength(0);
    await expect(
      readFile(join(sourceAppRoot, ".eve/dev-runtime/current.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await Promise.all(
      invocationRoots.map((root) => rm(root, { recursive: true, force: true }))
    );
    await rm(testRoot, { recursive: true, force: true });
  }
}, 90_000);
