import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const RUNNER_URL = new URL("../src/eve-runner.ts", import.meta.url).href;

interface FixtureEvent {
  type: string;
  pid?: number;
  signal?: string | null;
  code?: number | null;
  error?: string;
}

function parentFixture(mode: "cancellation" | "stop"): string {
  // Only the supervisor is production code. Its child is an inert Node process,
  // and all external runtime/session work is replaced at the DI boundary.
  return `
    import { spawn } from "node:child_process";
    import { withEveDevServer } from ${JSON.stringify(RUNNER_URL)};
    const mode = ${JSON.stringify(mode)};
    const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
    const watchdog = setTimeout(() => process.exit(77), 8_000);
    let childReady;
    const ready = new Promise((resolve) => { childReady = resolve; });
    const session = {
      state: { sessionId: "session-synthetic" },
      cancel() {
        emit({ type: "cancelling" });
        return new Promise(() => {});
      },
      async *stream() {},
      async send() { throw new Error("Model calls are forbidden in this fixture."); },
    };
    try {
      await withEveDevServer({
        appRoot: "/synthetic-not-read",
        environment: {},
        cancellationGraceMs: 500,
        stopGraceMs: 500,
        dependencies: {
          createInvocation: async () => ({ appRoot: "/synthetic-not-read" }),
          findOpenPort: async () => 43210,
          createClient: () => ({ health: async () => ({ ok: true }), info: async () => ({}), session: () => session }),
          spawn() {
            const childSource = mode === "stop"
              ? "process.on('SIGTERM', () => console.log('term-seen'));"
              : "";
            const child = spawn(process.execPath, ["-e", childSource +
              "setInterval(() => {}, 1000); setTimeout(() => process.exit(78), 6000); console.log('child-ready');"],
              { env: {}, stdio: ["ignore", "pipe", "pipe"] });
            emit({ type: "child", pid: child.pid });
            let output = "";
            child.stdout.on("data", (chunk) => {
              output += chunk;
              if (output.includes("child-ready\\n")) childReady();
              if (output.includes("term-seen\\n")) {
                emit({ type: "stopping" });
                output = "";
              }
            });
            child.once("exit", (code, signal) => emit({ type: "child-exit", code, signal }));
            return child;
          },
        },
      }, async (client) => {
        await ready;
        if (mode === "cancellation") client.session();
        emit({ type: "ready" });
        await new Promise(() => {});
      });
    } catch (error) {
      emit({ type: "cleanup-complete", error: error.message });
    } finally {
      clearTimeout(watchdog);
    }
  `;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function verifyRepeatedSignals(
  mode: "cancellation" | "stop",
  signal: "SIGINT" | "SIGTERM"
): Promise<void> {
  const events: FixtureEvent[] = [];
  let stderr = "";
  let partialLine = "";
  let parentExit: { code: number | null; signal: string | null } | undefined;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "-e", parentFixture(mode)],
    { env: {}, stdio: ["ignore", "pipe", "pipe"] }
  );
  parent.stdout.setEncoding("utf8");
  parent.stdout.on("data", (chunk: string) => {
    const lines = `${partialLine}${chunk}`.split("\n");
    partialLine = lines.pop()!;
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  parent.stderr.setEncoding("utf8");
  parent.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  const exited = new Promise<void>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code, signal) => {
      parentExit = { code, signal };
    });
    parent.once("close", () => resolve());
  });
  // A failed startup must still be consumed if an earlier marker times out.
  void exited.catch(() => undefined);
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${description}. ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let ownedChildPid: number | undefined;
  try {
    await waitFor(
      () =>
        events.some((event) => event.type === "ready") ||
        parentExit !== undefined,
      "fixture readiness"
    );
    expect(parentExit, JSON.stringify({ stderr, events })).toBeUndefined();
    ownedChildPid = events.find((event) => event.type === "child")?.pid;
    expect(ownedChildPid).toBeGreaterThan(1);
    parent.kill(signal);
    const cleanupPhase = mode === "cancellation" ? "cancelling" : "stopping";
    await waitFor(
      () =>
        events.some((event) => event.type === cleanupPhase) ||
        parentExit !== undefined,
      cleanupPhase
    );
    expect(parentExit, stderr).toBeUndefined();
    parent.kill(signal);
    await waitFor(() => parentExit !== undefined, "parent cleanup and exit");
    await exited;

    expect(
      parentExit,
      "Repeated signals must not bypass owned-child cleanup"
    ).toEqual({
      code: 0,
      signal: null,
    });
    expect(
      events.find((event) => event.type === "cleanup-complete")?.error
    ).toBe(`Interrupted by ${signal}.`);
    expect(events.find((event) => event.type === "child-exit")?.signal).toBe(
      mode === "stop" ? "SIGKILL" : "SIGTERM"
    );
    expect(
      events.findIndex((event) => event.type === "child-exit")
    ).toBeLessThan(
      events.findIndex((event) => event.type === "cleanup-complete")
    );
    expect(isProcessAlive(ownedChildPid!)).toBe(false);
  } finally {
    // Only PIDs emitted by this invocation's own fixture are cleanup targets.
    ownedChildPid ??= events.find((event) => event.type === "child")?.pid;
    if (parentExit === undefined) parent.kill("SIGKILL");
    if (
      ownedChildPid !== undefined &&
      Number.isSafeInteger(ownedChildPid) &&
      ownedChildPid > 1 &&
      isProcessAlive(ownedChildPid)
    ) {
      try {
        process.kill(ownedChildPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await waitFor(
        () => !isProcessAlive(ownedChildPid!),
        "synthetic child removal"
      );
    }
    await waitFor(() => parentExit !== undefined, "synthetic parent removal");
    await exited;
  }
}

describe.skipIf(process.platform === "win32")(
  "real-process runner signal cleanup",
  () => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "cleans up after repeated %s during a hung cancellation request",
      async (signal) => verifyRepeatedSignals("cancellation", signal),
      10_000
    );

    it("retains signal protection while escalating an unresponsive child to SIGKILL", async () => {
      await verifyRepeatedSignals("stop", "SIGTERM");
    }, 10_000);
  }
);
