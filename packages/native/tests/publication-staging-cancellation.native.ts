import { chmodSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  onCompiler: undefined as
    | ((child: import("node:child_process").ChildProcess) => void)
    | undefined,
  onHelper: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));
// Observe and interrupt the actual external compiler; never replace its result.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (args[0].endsWith("/publication-staging"))
        processBoundary.onHelper?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
      return child;
    }) as typeof actual.spawn,
    execFile: ((...args: Parameters<typeof actual.execFile>) => {
      const child = actual.execFile(...args);
      if (
        Array.isArray(args[1]) &&
        args[1].some((arg) => arg.endsWith("/publication-staging.c"))
      )
        processBoundary.onCompiler?.(child);
      return child;
    }) as typeof actual.execFile,
  };
});
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import {
  createMetalOutputRecord,
  parseMetalOutputRecord,
} from "../src/tooling/output-record.ts";
import { withPreparedMetalPublicationStage } from "../src/tooling/publication-staging.ts";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("cancelling a prepared stage waits for callback work and checked cleanup before rejecting", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled staging");
    const stageInput = { prepared, signal: controller.signal };
    await expect(
      withPreparedMetalPublicationStage(stageInput, async () => {
        controller.abort(reason);
        await expect(
          withMetalPublicationSession(
            { parentPath: dirname(input.outputPath) },
            async () => "unexpected"
          )
        ).rejects.toMatchObject({ code: "busy" });
        return "must not succeed";
      })
    ).rejects.toMatchObject({
      name: "MetalPublicationStagingError",
      code: "cancelled",
      cause: reason,
    });
    expect(await readdir(dirname(input.outputPath))).toEqual([]);
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await withMetalPublicationSession(
        { parentPath: dirname(input.outputPath) },
        async () => "released"
      )
    ).toBe("released");
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("an already cancelled staging request creates no output parent and never calls its callback", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel before staging");
    controller.abort(reason);
    let called = false;
    await expect(
      withPreparedMetalPublicationStage(
        { prepared, signal: controller.signal },
        async () => {
          called = true;
        }
      )
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
    expect(called).toBe(false);
    await expect(lstat(dirname(input.outputPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a cooperative callback throwing the abort reason is reported as cancellation after cleanup", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cooperative callback cancellation");
    await expect(
      withPreparedMetalPublicationStage(
        { prepared, signal: controller.signal },
        async () => {
          controller.abort(reason);
          controller.signal.throwIfAborted();
        }
      )
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
    expect(await readdir(dirname(input.outputPath))).toEqual([]);
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancellation terminates the real helper compiler and awaits close before removing scratch", async () => {
  const input = await projectFixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let compilerClosed = false;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel helper compilation");
    processBoundary.onCompiler = (child) => {
      child.once("close", () => {
        compilerClosed = true;
      });
      child.once("spawn", () => {
        child.kill("SIGSTOP");
        controller.abort(reason);
        watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 5_000);
      });
    };
    let called = false;
    await expect(
      withPreparedMetalPublicationStage(
        { prepared, signal: controller.signal },
        async () => {
          called = true;
        }
      )
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
    expect(compilerClosed).toBe(true);
    expect(watchdogFired).toBe(false);
    expect(called).toBe(false);
    await expect(lstat(dirname(input.outputPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    processBoundary.onCompiler = undefined;
    clearTimeout(watchdog);
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancellation after a real payload chunk stops transfer and lets the live helper clean its partial file", async () => {
  const input = await projectFixture();
  try {
    const original = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const payloads = Object.fromEntries(
      Object.entries(original.files).filter(
        ([path]) => path !== ".vgpu-native-output.json"
      )
    );
    payloads["Package.swift"] = Buffer.concat([
      original.files["Package.swift"]!,
      Buffer.from("\n// cancellation transfer fixture\n".repeat(8_192)),
    ]);
    const recordBytes = createMetalOutputRecord({
      ...original.record,
      files: payloads,
    });
    const prepared = {
      ...original,
      files: { ...payloads, ".vgpu-native-output.json": recordBytes },
      record: parseMetalOutputRecord(recordBytes),
    };
    const controller = new AbortController();
    const reason = new Error("cancel partially transferred generation");
    let interrupted = false;
    let closed = false;
    processBoundary.onHelper = (child) => {
      child.once("close", () => {
        closed = true;
      });
      const write = child.stdin.write.bind(child.stdin);
      // Preserve the real bytes and write result; abort at a completed OS-pipe chunk boundary.
      child.stdin.write = ((
        chunk: Uint8Array,
        callback: (error?: Error | null) => void
      ) =>
        write(chunk, (error) => {
          if (!interrupted && chunk.byteLength === 64 * 1024) {
            interrupted = true;
            controller.abort(reason);
          }
          callback(error);
        })) as typeof child.stdin.write;
    };
    let callbackCalled = false;
    await expect(
      withPreparedMetalPublicationStage(
        { prepared, signal: controller.signal },
        async () => {
          callbackCalled = true;
        }
      )
    ).rejects.toMatchObject({ code: "cancelled", cause: reason });
    expect(interrupted).toBe(true);
    expect(callbackCalled).toBe(false);
    expect(closed).toBe(true);
    expect(await readdir(dirname(input.outputPath))).toEqual([]);
  } finally {
    processBoundary.onHelper = undefined;
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancelled callback cleanup preserves the cancellation reason and changed-stage evidence", async () => {
  const input = await projectFixture();
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel with changed staging");
    let stagePath = "";
    let journalPath = "";
    const error = await withPreparedMetalPublicationStage(
      { prepared, signal: controller.signal },
      async (receipt) => {
        stagePath = receipt.stagePath;
        journalPath = receipt.journalPath;
        await writeFile(join(stagePath, "unknown.txt"), "preserve");
        controller.abort(reason);
      }
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "cleanup-failed",
      errors: [
        { code: "cancelled", cause: reason },
        { code: "cleanup-failed" },
      ],
      recoveryPaths: [stagePath, journalPath],
    });
    expect(await readFile(join(stagePath, "unknown.txt"), "utf8")).toBe(
      "preserve"
    );
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancelled cleanup bounds a stopped real helper and retains its recovery evidence", async () => {
  const input = await projectFixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let helper:
    | import("node:child_process").ChildProcessWithoutNullStreams
    | undefined;
  let helperClosed = false;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel stopped helper");
    processBoundary.onHelper = (child) => {
      helper = child;
      child.once("close", () => {
        helperClosed = true;
      });
    };
    let stagePath = "";
    const error = await withPreparedMetalPublicationStage(
      { prepared, signal: controller.signal },
      async (receipt) => {
        stagePath = receipt.stagePath;
        expect(helper!.kill("SIGSTOP")).toBe(true);
        controller.abort(reason);
        watchdog = setTimeout(() => {
          watchdogFired = true;
          helper!.kill("SIGKILL");
        }, 8_000);
      }
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "cleanup-failed",
      errors: [{ code: "cancelled", cause: reason }, { code: "helper-failed" }],
      recoveryPaths: expect.arrayContaining([stagePath]),
    });
    expect(watchdogFired).toBe(false);
    expect(helperClosed).toBe(true);
    expect(await readdir(stagePath)).toContain("Package.swift");
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    processBoundary.onHelper = undefined;
    clearTimeout(watchdog);
    helper?.kill("SIGKILL");
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("cancellation arriving during finalize preserves its cause and the retained transaction", async () => {
  const input = await projectFixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let helper:
    | import("node:child_process").ChildProcessWithoutNullStreams
    | undefined;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel inside finalize exchange");
    processBoundary.onHelper = (child) => {
      helper = child;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((
        chunk: Uint8Array,
        callback: (error?: Error | null) => void
      ) =>
        write(chunk, (error) => {
          if (Buffer.from(chunk).toString() === "finalize\n")
            controller.abort(reason);
          callback(error);
        })) as typeof child.stdin.write;
    };
    let stagePath = "";
    let journalPath = "";
    const error = await withPreparedMetalPublicationStage(
      { prepared, signal: controller.signal },
      async (receipt) => {
        stagePath = receipt.stagePath;
        journalPath = receipt.journalPath;
        expect(helper!.kill("SIGSTOP")).toBe(true);
        watchdog = setTimeout(() => {
          watchdogFired = true;
          helper!.kill("SIGKILL");
        }, 8_000);
      }
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "cleanup-failed",
      errors: [{ code: "cancelled", cause: reason }, { code: "helper-failed" }],
      recoveryPaths: [stagePath, journalPath],
    });
    expect(watchdogFired).toBe(false);
    expect(await readdir(stagePath)).toContain("Package.swift");
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    processBoundary.onHelper = undefined;
    clearTimeout(watchdog);
    helper?.kill("SIGKILL");
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("scratch cleanup failure retains the recovery paths from a cancelled transfer", async () => {
  const input = await projectFixture();
  let ownedScratch: string | undefined;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const controller = new AbortController();
    const reason = new Error("cancel with retained transaction and scratch");
    const stage = join(dirname(input.outputPath), ".vgpu-native-stage");
    const journal = join(
      dirname(input.outputPath),
      ".vgpu-native-publication.json"
    );
    processBoundary.onHelper = (child) => {
      child.stdout.once("data", () => {
        // The real ready response means the helper has created its transaction and directories.
        writeFileSync(join(stage, "unknown.txt"), "preserve this transaction");
        ownedScratch = dirname(child.spawnfile);
        chmodSync(ownedScratch, 0o500);
        controller.abort(reason);
      });
    };
    const error = await withPreparedMetalPublicationStage(
      { prepared, signal: controller.signal },
      async () => {
        throw new Error("unexpected callback");
      }
    ).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "cleanup-failed",
      errors: [{ code: "cancelled", cause: reason }, { code: "EACCES" }],
      recoveryPaths: [stage, journal, ownedScratch],
    });
    expect(await readFile(join(stage, "unknown.txt"), "utf8")).toBe(
      "preserve this transaction"
    );
  } finally {
    processBoundary.onHelper = undefined;
    if (ownedScratch) {
      await chmod(ownedScratch, 0o700);
      await rm(ownedScratch, { recursive: true, force: true });
    }
    await rm(input.directory, { recursive: true, force: true });
  }
  await expect(lstat(ownedScratch!)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a stopped helper cannot leave readiness waiting indefinitely without cancellation", async () => {
  const input = await projectFixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let helper:
    | import("node:child_process").ChildProcessWithoutNullStreams
    | undefined;
  let closed = false;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    processBoundary.onHelper = (child) => {
      helper = child;
      child.once("close", () => {
        closed = true;
      });
      child.once("spawn", () => {
        child.kill("SIGSTOP");
        watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 35_000);
      });
    };
    await expect(
      withPreparedMetalPublicationStage({ prepared }, async () => {
        throw new Error("unexpected prepared callback");
      })
    ).rejects.toMatchObject({ code: "helper-failed" });
    expect(watchdogFired).toBe(false);
    expect(closed).toBe(true);
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    processBoundary.onHelper = undefined;
    clearTimeout(watchdog);
    helper?.kill("SIGKILL");
    await rm(input.directory, { recursive: true, force: true });
  }
});

test("a pipe failure forcibly closes a stopped helper before rejecting", async () => {
  const input = await projectFixture();
  let helper:
    | import("node:child_process").ChildProcessWithoutNullStreams
    | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let closed = false;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    processBoundary.onHelper = (child) => {
      helper = child;
      child.once("close", () => {
        closed = true;
      });
      child.stdout.once("data", () => {
        child.kill("SIGSTOP");
        child.stdin.destroy(new Error("external pipe interruption"));
        watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 8_000);
      });
    };
    await expect(
      withPreparedMetalPublicationStage({ prepared }, async () => {
        throw new Error("unexpected callback");
      })
    ).rejects.toMatchObject({ code: "helper-failed" });
    expect(watchdogFired).toBe(false);
    expect(closed).toBe(true);
    await expect(lstat(input.outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    processBoundary.onHelper = undefined;
    clearTimeout(watchdog);
    helper?.kill("SIGKILL");
    await rm(input.directory, { recursive: true, force: true });
  }
});
