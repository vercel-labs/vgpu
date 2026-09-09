import { execFile } from "node:child_process";
import { constants, renameSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  environment: undefined as Record<string, string> | undefined,
  messages: [] as Record<string, unknown>[],
  reconciliationMessages: [] as Record<string, unknown>[],
  beforeReconciliation: undefined as (() => void) | undefined,
  onReconciliation: undefined as
    | ((
        child: import("node:child_process").ChildProcess,
        args: readonly string[]
      ) => void)
    | undefined,
  observationFailure: undefined as unknown,
  onHelper: undefined as
    | ((child: import("node:child_process").ChildProcess) => void)
    | undefined,
}));

// Mutate the real filesystem before the real reconciliation spawn; never replace replies.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (!args[0].endsWith("/publication-staging") || !Array.isArray(args[1]))
        return actual.spawn(...args);
      let child: import("node:child_process").ChildProcess;
      let messages: Record<string, unknown>[];
      if (
        boundary.environment &&
        args[1].includes("publish-missing-or-empty")
      ) {
        child = actual.spawn(args[0], args[1], {
          ...args[2],
          env: { ...args[2]?.env, ...boundary.environment },
        });
        messages = boundary.messages;
        boundary.onHelper?.(child);
      } else if (
        args[1].some(
          (arg) => arg === "reconcile-empty" || arg === "reconcile-missing"
        )
      ) {
        try {
          boundary.beforeReconciliation?.();
        } catch (cause) {
          boundary.observationFailure = cause;
          throw cause;
        }
        child = actual.spawn(...args);
        messages = boundary.reconciliationMessages;
        boundary.onReconciliation?.(child, args[1]);
      } else return actual.spawn(...args);
      let buffered = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (boundary.observationFailure !== undefined) return;
        try {
          buffered += chunk.toString("utf8");
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (Buffer.byteLength(line) > 64 * 1024)
              throw new Error("Observed helper frame exceeded 64 KiB");
            messages.push(JSON.parse(line) as Record<string, unknown>);
          }
          if (Buffer.byteLength(buffered) > 64 * 1024)
            throw new Error("Observed helper frame exceeded 64 KiB");
        } catch (cause) {
          boundary.observationFailure = cause;
          child.kill("SIGKILL");
        }
      });
      return child;
    }) as typeof actual.spawn,
  };
});

import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import {
  MetalPublicationError,
  publishPreparedMetalOutput,
} from "../src/tooling/publication-staging.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("an absent old destination cannot prove non-publication of an interrupted empty-directory replacement", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
  let oldDirectory: FileHandle | undefined;
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed:
    | Promise<{ code: number | null; signal: string | null }>
    | undefined;
  let operation: Promise<unknown> | undefined;
  let watchdogFired = false;
  let publisherCount = 0;
  let reconciliationCount = 0;
  let reconciliationArgs: readonly string[] | undefined;
  let moved = false;
  const children: {
    child: import("node:child_process").ChildProcess;
    closed: Promise<{ code: number | null; signal: string | null }>;
  }[] = [];
  function track(child: import("node:child_process").ChildProcess) {
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      child.kill("SIGKILL");
    }, 20_000);
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolveClose) =>
        child.once("close", (code, signal) => {
          clearTimeout(watchdog);
          resolveClose({ code, signal });
        })
    );
    children.push({ child, closed });
    return closed;
  }
  try {
    await mkdir(input.outputPath, { recursive: true, mode: 0o750 });
    oldDirectory = await open(
      input.outputPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const oldRoot = await oldDirectory.stat({ bigint: true });
    const oldIdentity = {
      device: oldRoot.dev.toString(),
      inode: oldRoot.ino.toString(),
    };
    expect(oldRoot.isDirectory()).toBe(true);
    expect(await readdir(input.outputPath)).toEqual([]);
    const oldEvidence = await treeEvidence(input.outputPath);
    const backup = join(input.directory, "preserved-original-empty");
    expect(dirname(backup)).not.toBe(dirname(input.outputPath));
    await expect(lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const observer = join(input.directory, "publication-empty-rename.dylib");
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
          new URL("./fixtures/publication-empty-rename.c", import.meta.url)
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
    const paused = join(input.directory, "empty-rename-paused");
    const resume = join(input.directory, "empty-rename-resume");
    const completed = join(input.directory, "empty-rename-completed");
    boundary.environment = {
      DYLD_INSERT_LIBRARIES: observer,
      VGPU_EMPTY_RENAME_PAUSED: paused,
      VGPU_EMPTY_RENAME_RESUME: resume,
      VGPU_EMPTY_RENAME_COMPLETED: completed,
    };
    boundary.onHelper = (child) => {
      publisherCount++;
      helper = child;
      closed = track(child);
    };
    boundary.onReconciliation = (child, args) => {
      reconciliationCount++;
      reconciliationArgs = [...args];
      track(child);
    };
    operation = publishPreparedMetalOutput({
      prepared,
      signal: controller.signal,
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    const pausedRename = await waitForMarker(paused);
    expect(pausedRename.noFollowAny).toBeGreaterThan(0);
    expect(pausedRename.flags).toBe(pausedRename.noFollowAny);
    expect(pausedRename.destination).toEqual(oldIdentity);
    expect(await readdir(input.outputPath)).toEqual([]);
    const parent = dirname(input.outputPath);
    const stage = join(parent, ".vgpu-native-stage");
    const journal = join(parent, ".vgpu-native-publication.json");
    const stageRoot = await lstat(stage, { bigint: true });
    const stageIdentity = {
      device: stageRoot.dev.toString(),
      inode: stageRoot.ino.toString(),
    };
    expect(stageRoot.isDirectory()).toBe(true);
    expect(pausedRename.source).toEqual(stageIdentity);
    expect(stageIdentity).not.toEqual(oldIdentity);
    const stageBefore = await treeEvidence(stage);
    const journalBefore = await treeEvidence(journal);
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
      "AppShaders",
    ]);
    const journalBytes = await readFile(journal);
    const journalRecord = JSON.parse(journalBytes.toString("utf8"));
    const publication = {
      renameMode: "replace-empty",
      expectedDestination: "empty",
      oldDestination: oldIdentity,
    };
    expect(journalRecord).toMatchObject({
      phase: "prepared",
      publication,
      stage: { name: ".vgpu-native-stage", ...stageIdentity },
    });
    expect(
      boundary.messages.find((message) => message.kind === "prepared")
    ).toMatchObject({
      transactionId: journalRecord.transactionId,
      publication,
      stage: { name: ".vgpu-native-stage", ...stageIdentity },
    });

    boundary.beforeReconciliation = () => {
      if (moved) throw new Error("Unexpected second reconciliation attempt");
      // Keep the original root alive outside the locked parent, without a replacement.
      renameSync(input.outputPath, backup);
      moved = true;
    };

    // Never resume: the real empty-directory replacement syscall must not execute.
    expect(helper?.kill("SIGKILL")).toBe(true);
    expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
    const failure = await operation;
    await Promise.all(children.map((entry) => entry.closed));
    expect(publisherCount).toBe(1);
    expect(reconciliationCount).toBe(1);
    expect(children).toHaveLength(2);
    expect(children[1]!.child.pid).toBeGreaterThan(0);
    expect(children[1]!.child.pid).not.toBe(helper?.pid);
    expect(reconciliationArgs).toEqual([
      "vgpu-publication-staging/v1",
      parent,
      "AppShaders",
      prepared.project.configuration.moduleName,
      journalRecord.transactionId,
      "reconcile-empty",
      journalRecord.parent.device,
      journalRecord.parent.inode,
    ]);
    expect(moved).toBe(true);
    expect(boundary.observationFailure).toBeUndefined();
    expect(watchdogFired).toBe(false);
    for (const path of [resume, completed, input.outputPath])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      boundary.messages.some((message) => message.kind === "commit-result")
    ).toBe(false);
    expect(
      boundary.reconciliationMessages.find(
        (message) => message.kind === "reconciliation"
      )
    ).toMatchObject({
      destination: null,
      stage: { ...stageIdentity, kind: "directory" },
    });
    expect(
      boundary.reconciliationMessages.find(
        (message) => message.kind === "error"
      )
    ).toMatchObject({
      code: "conflict",
    });
    expect(
      boundary.reconciliationMessages.some(
        (message) => message.kind === "reconciliation-result"
      )
    ).toBe(false);
    expect(await treeEvidence(stage)).toEqual(stageBefore);
    expect(await treeEvidence(journal)).toEqual(journalBefore);
    expect(await treeEvidence(backup)).toEqual(oldEvidence);
    expect(await readFile(journal)).toEqual(journalBytes);
    const retainedOld = await oldDirectory.stat({ bigint: true });
    expect(retainedOld.isDirectory()).toBe(true);
    expect({
      device: retainedOld.dev,
      inode: retainedOld.ino,
      mode: retainedOld.mode,
      links: retainedOld.nlink,
    }).toEqual({
      device: oldRoot.dev,
      inode: oldRoot.ino,
      mode: oldRoot.mode,
      links: oldRoot.nlink,
    });
    const namedOld = await lstat(backup, { bigint: true });
    expect(namedOld.isDirectory()).toBe(true);
    expect({
      device: namedOld.dev,
      inode: namedOld.ino,
      mode: namedOld.mode,
      links: namedOld.nlink,
    }).toEqual({
      device: oldRoot.dev,
      inode: oldRoot.ino,
      mode: oldRoot.mode,
      links: oldRoot.nlink,
    });
    expect(await readdir(backup)).toEqual([]);
    expect(Object.keys(prepared.files)).toHaveLength(4);
    for (const [name, bytes] of Object.entries(prepared.files)) {
      const path = join(stage, name);
      const metadata = await lstat(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      expect(metadata.size).toBe(bytes.byteLength);
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      ".vgpu-native-stage",
    ]);
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(hasOriginalHelperEof(failure)).toBe(true);

    // Honest GREEN: absence cannot stand in for the original empty destination identity.
    expect(failure).toMatchObject({
      code: "helper-failed",
      outcome: "unknown",
      receipt: undefined,
      recoveryPaths: [stage, journal, input.outputPath],
    });
  } finally {
    controller.abort(new Error("test cleanup"));
    for (const entry of children)
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        entry.child.kill("SIGKILL");
    await Promise.all(children.map((entry) => entry.closed));
    await operation;
    await oldDirectory?.close();
    boundary.environment = undefined;
    boundary.messages = [];
    boundary.reconciliationMessages = [];
    boundary.beforeReconciliation = undefined;
    boundary.onReconciliation = undefined;
    boundary.observationFailure = undefined;
    boundary.onHelper = undefined;
    await rm(input.directory, { recursive: true, force: true });
  }
});

async function waitForMarker(path: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bytes = await readFile(path, "utf8").catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
        return "";
      }
    );
    if (bytes.endsWith("\n")) return JSON.parse(bytes) as Record<string, any>;
    await delay(5);
  }
  throw new Error("The actual empty-directory rename barrier was not reached");
}

async function treeEvidence(root: string): Promise<unknown> {
  const stat = await lstat(root, { bigint: true });
  const identity = {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    links: stat.nlink,
  };
  if (stat.isDirectory())
    return {
      ...identity,
      children: await Promise.all(
        (await readdir(root))
          .sort()
          .map(async (name) => [name, await treeEvidence(join(root, name))])
      ),
    };
  if (!stat.isFile()) throw new Error("Unexpected nonordinary recovery entry");
  return { ...identity, size: stat.size, bytes: await readFile(root) };
}

function hasOriginalHelperEof(
  cause: unknown,
  seen = new Set<unknown>()
): boolean {
  if (cause === null || typeof cause !== "object" || seen.has(cause))
    return false;
  seen.add(cause);
  const failure = cause as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  return (
    (failure.code === "helper-failed" &&
      failure.message === "Invalid publication staging helper response") ||
    hasOriginalHelperEof(failure.cause, seen) ||
    (cause instanceof AggregateError &&
      cause.errors.some((error: unknown) => hasOriginalHelperEof(error, seen)))
  );
}
