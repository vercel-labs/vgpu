import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  environment: undefined as Record<string, string> | undefined,
  onHelper: undefined as
    | ((child: import("node:child_process").ChildProcess) => void)
    | undefined,
}));

// Interrupt the actual publisher only; the read-only reconciliation helper stays unmodified.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (
        boundary.environment &&
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        args[1].some(
          (arg) =>
            arg === "publish-missing" || arg === "publish-missing-or-empty"
        )
      ) {
        const child = actual.spawn(args[0], args[1], {
          ...args[2],
          env: { ...args[2]?.env, ...boundary.environment },
        });
        boundary.onHelper?.(child);
        return child;
      }
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import {
  MetalPublicationError,
  publishPreparedMetalOutput,
} from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("an already requested cancellation cannot skip reconciliation after a real successful rename loses its ACK", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
  const reason = new Error("caller cancelled while the real rename was paused");
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed:
    | Promise<{ code: number | null; signal: string | null }>
    | undefined;
  let operation: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const observer = join(
      input.directory,
      "publication-cancelled-lost-ack.dylib"
    );
    await promisify(execFile)(
      "/usr/bin/xcrun",
      [
        "--sdk",
        "macosx",
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=14.0",
        "-dynamiclib",
        fileURLToPath(
          new URL("./fixtures/publication-rename-conflict.c", import.meta.url)
        ),
        "-o",
        observer,
      ],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
          )
        ),
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      }
    );
    const paused = join(input.directory, "rename-paused");
    const resume = join(input.directory, "rename-resume");
    const completed = join(input.directory, "rename-completed");
    boundary.environment = {
      DYLD_INSERT_LIBRARIES: observer,
      VGPU_RENAME_CONFLICT_PAUSED: paused,
      VGPU_RENAME_CONFLICT_RESUME: resume,
      VGPU_RENAME_CONFLICT_COMPLETED: completed,
      VGPU_RENAME_EXIT_AFTER_SUCCESS: "1",
    };
    boundary.onHelper = (child) => {
      helper = child;
      closed = new Promise((resolveClose) => {
        child.once("close", (code, signal) => {
          clearTimeout(watchdog);
          resolveClose({ code, signal });
        });
      });
      watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill("SIGKILL");
      }, 20_000);
    };
    operation = publishPreparedMetalOutput({
      prepared,
      signal: controller.signal,
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    await waitForMarker(paused, "before-rename\n");
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const parent = dirname(input.outputPath);
    const stage = join(parent, ".vgpu-native-stage");
    const journal = join(parent, ".vgpu-native-publication.json");
    const stageIdentity = await lstat(stage, { bigint: true });
    const journalIdentity = await lstat(journal, { bigint: true });
    const journalBytes = await readFile(journal);
    const journalRecord = JSON.parse(journalBytes.toString("utf8"));
    expect(journalRecord).toMatchObject({
      phase: "prepared",
      publication: { renameMode: "excl", expectedDestination: "missing" },
      stage: {
        device: stageIdentity.dev.toString(),
        inode: stageIdentity.ino.toString(),
      },
    });
    // Commit was already sent. Abort before the real syscall resumes, then lose its actual ACK.
    controller.abort(reason);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
    await writeFile(resume, "resume\n", { flag: "wx" });

    const failure = await operation;
    expect(await closed).toEqual({ code: 97, signal: null });
    expect(watchdogFired).toBe(false);
    expect(await readFile(completed, "utf8")).toMatch(/^0 \d+\n$/u);
    const output = await lstat(input.outputPath, { bigint: true });
    expect(output.isDirectory()).toBe(true);
    expect({
      device: output.dev,
      inode: output.ino,
      mode: output.mode,
    }).toEqual({
      device: stageIdentity.dev,
      inode: stageIdentity.ino,
      mode: stageIdentity.mode,
    });
    for (const [name, bytes] of Object.entries(prepared.files)) {
      const path = join(input.outputPath, name);
      const metadata = await lstat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.size).toBe(bytes.byteLength);
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
    expect(
      await verifyMetalProject({ configurationPath: input.configurationPath })
    ).toMatchObject({ inputFingerprint: prepared.project.inputFingerprint });
    expect(await readFile(journal)).toEqual(journalBytes);
    const retainedJournal = await lstat(journal, { bigint: true });
    expect({
      device: retainedJournal.dev,
      inode: retainedJournal.ino,
      mode: retainedJournal.mode,
      links: retainedJournal.nlink,
      size: retainedJournal.size,
    }).toEqual({
      device: journalIdentity.dev,
      inode: journalIdentity.ino,
      mode: journalIdentity.mode,
      links: journalIdentity.nlink,
      size: journalIdentity.size,
    });
    await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      "AppShaders",
    ]);

    // Honest GREEN characterization: the pre-existing abort must not suppress evidence checking.
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({
      code: "cancelled",
      outcome: "published",
      receipt: {
        confirmation: "reconciled",
        outcome: "published",
        transactionId: journalRecord.transactionId,
        outputPath: input.outputPath,
        output: {
          device: stageIdentity.dev.toString(),
          inode: stageIdentity.ino.toString(),
        },
      },
      recoveryPaths: [journal, input.outputPath],
    });
    const causes = failureChain(failure);
    expect(causes).toContain(reason);
    expect(causes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "helper-failed",
          message: "Invalid publication staging helper response",
        }),
      ])
    );
  } finally {
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    boundary.environment = undefined;
    boundary.onHelper = undefined;
    await rm(input.directory, { recursive: true, force: true });
  }
});

async function waitForMarker(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bytes = await readFile(path, "utf8").catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
        return undefined;
      }
    );
    if (bytes === expected) return;
    await delay(5);
  }
  throw new Error(
    "The real publication helper never reached the rename barrier"
  );
}

function failureChain(cause: unknown, seen = new Set<unknown>()): unknown[] {
  if (cause === null || typeof cause !== "object" || seen.has(cause)) return [];
  seen.add(cause);
  return [
    cause,
    ...failureChain((cause as { cause?: unknown }).cause, seen),
    ...(cause instanceof AggregateError
      ? cause.errors.flatMap((error: unknown) => failureChain(error, seen))
      : []),
  ];
}
