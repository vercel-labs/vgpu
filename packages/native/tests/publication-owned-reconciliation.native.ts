import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  environment: undefined as Record<string, string> | undefined,
  beforeReconciliation: undefined as (() => void) | undefined,
  onReconciliation: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
  onHelper: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));

// Only the second publisher receives the real SWAP observer; reconciliation passes through unchanged.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        args[1].includes("reconcile-owned")
      ) {
        boundary.beforeReconciliation?.();
        const child = actual.spawn(...args);
        boundary.onReconciliation?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
        return child;
      }
      if (
        boundary.environment &&
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        args[1].includes("publish-project")
      ) {
        const child = actual.spawn(args[0], args[1], {
          ...args[2],
          env: { ...args[2]?.env, ...boundary.environment },
        });
        boundary.onHelper?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
        return child;
      }
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import { MetalOutputVerificationError } from "../src/tooling/output-verification.ts";
import {
  MetalPublicationError,
  publishPreparedMetalOutput,
} from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test.each([
  "published",
  "missing-destination",
  "not-published",
  "changed-old-payload",
] as const)(
  "owned reconciliation preserves both generations after interruption (%s)",
  async (outcome) => {
    const input = await projectFixture();
    const controller = new AbortController();
    const markerController = new AbortController();
    let oldDirectory: FileHandle | undefined;
    let helper: import("node:child_process").ChildProcess | undefined;
    let closed:
      | Promise<{ code: number | null; signal: string | null }>
      | undefined;
    let originalClosed = false;
    let operation: Promise<unknown> | undefined;
    let markerWait: Promise<Record<string, any>> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    let observationFailure: unknown;
    let publishers = 0;
    let movedOldDestination = false;
    let changedOldBefore: unknown;
    let changedOldFiles: Readonly<Record<string, Uint8Array>> | undefined;
    const expectedOutcome =
      outcome === "missing-destination" || outcome === "changed-old-payload"
        ? "unknown"
        : outcome;
    const frames: Record<string, any>[] = [];
    const reconciliationFrames: Record<string, any>[] = [];
    const reconciliationWrites: Buffer[] = [];
    const reconciliationOrder: boolean[] = [];
    const reconcilers: {
      child: import("node:child_process").ChildProcess;
      closed: Promise<{ code: number | null; signal: string | null }>;
      watchdog: ReturnType<typeof setTimeout>;
    }[] = [];
    const observeFrames = (
      child: import("node:child_process").ChildProcessWithoutNullStreams,
      messages: Record<string, any>[]
    ) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (observationFailure !== undefined) return;
        try {
          buffered += chunk.toString("utf8");
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (Buffer.byteLength(line) > 64 * 1024)
              throw new Error("Observed helper frame exceeded 64 KiB");
            messages.push(JSON.parse(line) as Record<string, any>);
          }
          if (Buffer.byteLength(buffered) > 64 * 1024)
            throw new Error("Observed helper frame exceeded 64 KiB");
        } catch (cause) {
          observationFailure = cause;
          child.kill("SIGKILL");
        }
      });
    };
    try {
      const original = await prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      });
      await expect(
        publishPreparedMetalOutput({ prepared: original })
      ).resolves.toMatchObject({
        outcome: "published",
        confirmation: "acknowledged",
        outputPath: input.outputPath,
      });
      const parent = dirname(input.outputPath);
      const stage = join(parent, ".vgpu-native-stage");
      const journal = join(parent, ".vgpu-native-publication.json");
      const update = join(parent, ".vgpu-native-publication.update.json");
      const oldBackup = join(input.directory, "original-old-output");
      oldDirectory = await open(
        input.outputPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      const oldRoot = await oldDirectory.stat({ bigint: true });
      const oldIdentity = {
        device: oldRoot.dev.toString(),
        inode: oldRoot.ino.toString(),
      };
      const oldBefore = await treeEvidence(input.outputPath);
      const oldRecordBytes = await readFile(
        join(input.outputPath, ".vgpu-native-output.json")
      );
      const prepared = await prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      });
      expect(Object.keys(prepared.files).sort()).toEqual(
        Object.keys(original.files).sort()
      );
      expect(Object.keys(prepared.files)).toHaveLength(4);
      for (const [name, bytes] of Object.entries(prepared.files))
        expect(Buffer.from(bytes)).toEqual(Buffer.from(original.files[name]!));
      expect(Buffer.from(prepared.files[".vgpu-native-output.json"]!)).toEqual(
        oldRecordBytes
      );
      expect(prepared.project.inputFingerprint).toBe(
        original.project.inputFingerprint
      );

      const observer = join(input.directory, "publication-owned-rename.dylib");
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
            new URL("./fixtures/publication-owned-rename.c", import.meta.url)
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
      const paused = join(input.directory, "owned-rename-paused");
      const resume = join(input.directory, "owned-rename-resume");
      const completed = join(input.directory, "owned-rename-completed");
      const returnAfterSuccess = join(input.directory, "owned-rename-return");
      boundary.environment = {
        DYLD_INSERT_LIBRARIES: observer,
        VGPU_OWNED_RENAME_PAUSED: paused,
        VGPU_OWNED_RENAME_RESUME: resume,
        VGPU_OWNED_RENAME_COMPLETED: completed,
        VGPU_OWNED_RENAME_RETURN: returnAfterSuccess,
      };
      boundary.onHelper = (child) => {
        publishers++;
        helper = child;
        closed = new Promise((resolveClose) =>
          child.once("close", (code, signal) => {
            originalClosed = true;
            clearTimeout(watchdog);
            resolveClose({ code, signal });
          })
        );
        watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 20_000);
        observeFrames(child, frames);
      };
      boundary.beforeReconciliation = () => {
        reconciliationOrder.push(originalClosed);
        if (outcome === "missing-destination") {
          if (!originalClosed || movedOldDestination)
            throw new Error(
              "Old destination must move once, after original helper close"
            );
          // Preserve the actual old root outside the locked parent before the real read-only spawn.
          renameSync(input.outputPath, oldBackup);
          movedOldDestination = true;
        }
        if (outcome === "changed-old-payload") {
          if (!originalClosed || changedOldBefore !== undefined)
            throw new Error(
              "Old payload must change once, after original helper close"
            );
          const changedPackage = Buffer.from(original.files["Package.swift"]!);
          expect(changedPackage.byteLength).toBeGreaterThan(0);
          const offset = Math.floor(changedPackage.byteLength / 2);
          changedPackage[offset] = changedPackage[offset]! ^ 1;
          const descriptor = openSync(
            join(input.outputPath, "Package.swift"),
            constants.O_WRONLY | constants.O_NOFOLLOW
          );
          try {
            expect(
              writeSync(descriptor, changedPackage, offset, 1, offset)
            ).toBe(1);
          } finally {
            closeSync(descriptor);
          }
          changedOldFiles = {
            ...original.files,
            "Package.swift": changedPackage,
          };
          // Capture before actual spawn; every identity, mode, size and other byte must remain original.
          changedOldBefore = treeEvidence(input.outputPath);
          const originalTree = oldBefore as {
            children: [string, Record<string, unknown>][];
          };
          expect(changedOldBefore).toEqual({
            ...originalTree,
            children: originalTree.children.map(([name, evidence]) => [
              name,
              name === "Package.swift"
                ? { ...evidence, bytes: changedPackage }
                : evidence,
            ]),
          });
          expect(treeEvidence(stage)).toEqual(newBefore);
          expect(treeEvidence(journal)).toEqual(journalBefore);
          expect(readFileSync(journal)).toEqual(journalBytes);
          expect(
            readFileSync(join(input.outputPath, ".vgpu-native-output.json"))
          ).toEqual(oldRecordBytes);
        }
      };
      boundary.onReconciliation = (child) => {
        const timeout = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 35_000);
        reconcilers.push({
          child,
          watchdog: timeout,
          closed: new Promise((resolveClose) =>
            child.once("close", (code, signal) => {
              clearTimeout(timeout);
              resolveClose({ code, signal });
            })
          ),
        });
        observeFrames(child, reconciliationFrames);
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((
          chunk: Uint8Array,
          callback: (error?: Error | null) => void
        ) => {
          reconciliationWrites.push(Buffer.from(chunk));
          return write(chunk, callback);
        }) as typeof child.stdin.write;
      };
      operation = publishPreparedMetalOutput({
        prepared,
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      markerWait = waitForMarker(paused, markerController.signal);
      const first = await Promise.race([
        markerWait.then((value) => ({ kind: "paused" as const, value })),
        operation.then((value) => ({ kind: "settled" as const, value })),
      ]);
      if (first.kind === "settled")
        throw new Error(
          `Publisher settled before the real owned SWAP: ${String(
            first.value
          )}`,
          { cause: first.value }
        );
      const before = first.value;
      expect(before.swap).toBeGreaterThan(0);
      expect(before.noFollowAny).toBeGreaterThan(0);
      expect(before.flags).toBe(before.swap | before.noFollowAny);
      expect(before.destination).toEqual(oldIdentity);
      const stageRoot = await lstat(stage, { bigint: true });
      expect(stageRoot.isDirectory()).toBe(true);
      const stageIdentity = {
        device: stageRoot.dev.toString(),
        inode: stageRoot.ino.toString(),
      };
      expect(stageIdentity).not.toEqual(oldIdentity);
      expect(before.source).toEqual(stageIdentity);
      const newBefore = await treeEvidence(stage);
      const journalBefore = await treeEvidence(journal);
      const journalBytes = await readFile(journal);
      const journalRecord = JSON.parse(journalBytes.toString("utf8"));
      const publication = {
        renameMode: "swap",
        expectedDestination: "owned",
        oldDestination: oldIdentity,
      };
      expect(journalRecord).toMatchObject({
        phase: "prepared",
        publication,
        stage: { name: ".vgpu-native-stage", ...stageIdentity },
      });
      const actualPrepared = frames.find((frame) => frame.kind === "prepared");
      expect(actualPrepared).toMatchObject({
        transactionId: journalRecord.transactionId,
        publication,
        stage: { name: ".vgpu-native-stage", ...stageIdentity },
      });
      expect(actualPrepared?.publication).toEqual(journalRecord.publication);
      expect(await treeEvidence(input.outputPath)).toEqual(oldBefore);
      await expectPackageFiles(stage, prepared.files);
      if (outcome === "published") {
        await writeFile(resume, "resume\n", { flag: "wx" });
        markerWait = waitForMarker(completed, markerController.signal);
        const after = await markerWait;
        expect(after).toMatchObject({
          result: 0,
          source: oldIdentity,
          destination: stageIdentity,
        });
      }
      // Published dies at RETURN after the actual SWAP; all other cases die before RESUME.
      expect(helper?.kill("SIGKILL")).toBe(true);
      expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
      const failure = await operation;
      const reconciliationCloses = await Promise.all(
        reconcilers.map((entry) => entry.closed)
      );
      expect(publishers).toBe(1);
      expect(watchdogFired).toBe(false);
      expect(observationFailure).toBeUndefined();
      expect(frames.some((frame) => frame.kind === "commit-result")).toBe(
        false
      );
      await expect(lstat(returnAfterSuccess)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const oldLocation =
        outcome === "published"
          ? stage
          : outcome === "missing-destination"
          ? oldBackup
          : input.outputPath;
      const newLocation = outcome === "published" ? input.outputPath : stage;
      expect(movedOldDestination).toBe(outcome === "missing-destination");
      if (outcome !== "published")
        for (const path of [
          resume,
          completed,
          ...(outcome === "missing-destination" ? [input.outputPath] : []),
        ])
          await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      const expectedOldTree = changedOldBefore ?? oldBefore;
      expect(changedOldBefore !== undefined).toBe(
        outcome === "changed-old-payload"
      );
      expect(await treeEvidence(oldLocation)).toEqual(expectedOldTree);
      expect(await treeEvidence(newLocation)).toEqual(newBefore);
      expect(await treeEvidence(journal)).toEqual(journalBefore);
      expect(await readFile(journal)).toEqual(journalBytes);
      const retainedOld = await oldDirectory.stat({ bigint: true });
      expect({
        device: retainedOld.dev,
        inode: retainedOld.ino,
        mode: retainedOld.mode,
      }).toEqual({
        device: oldRoot.dev,
        inode: oldRoot.ino,
        mode: oldRoot.mode,
      });
      await expectPackageFiles(oldLocation, changedOldFiles ?? original.files);
      await expectPackageFiles(newLocation, prepared.files);
      if (outcome === "changed-old-payload") {
        const verificationFailure = await verifyMetalProject({
          configurationPath: input.configurationPath,
        }).catch((cause: unknown) => cause);
        expect(verificationFailure).toBeInstanceOf(
          MetalOutputVerificationError
        );
        expect(verificationFailure).toMatchObject({
          code: "invalid-output",
          message: "Generated file has changed: Package.swift",
        });
      } else if (outcome !== "missing-destination")
        await expect(
          verifyMetalProject({ configurationPath: input.configurationPath })
        ).resolves.toMatchObject({
          outputPath: input.outputPath,
          inputFingerprint: prepared.project.inputFingerprint,
        });
      expect(await treeEvidence(oldLocation)).toEqual(expectedOldTree);
      expect(await treeEvidence(newLocation)).toEqual(newBefore);
      expect(await treeEvidence(journal)).toEqual(journalBefore);
      await expect(lstat(update)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(parent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        ".vgpu-native-stage",
        ...(outcome !== "missing-destination" ? ["AppShaders"] : []),
      ]);
      expect(failure).toBeInstanceOf(MetalPublicationError);
      expect(
        hasFailure(
          failure,
          "helper-failed",
          "Invalid publication staging helper response"
        )
      ).toBe(true);

      // Physical interruption, complete packages/journal, and original EOF precede outcome assertions.
      expect(failure).toMatchObject({
        outcome: expectedOutcome,
      });
      if (outcome === "published")
        expect(failure).toMatchObject({
          code: "helper-failed",
          cause: {
            code: "helper-failed",
            message: "Invalid publication staging helper response",
          },
          receipt: {
            confirmation: "reconciled",
            outcome: "published",
            transactionId: journalRecord.transactionId,
            outputPath: input.outputPath,
            output: stageIdentity,
          },
          recoveryPaths: [stage, journal, input.outputPath],
        });
      else if (outcome === "not-published")
        expect(failure).toMatchObject({
          code: "helper-failed",
          cause: {
            code: "helper-failed",
            message: "Invalid publication staging helper response",
          },
          receipt: undefined,
          recoveryPaths: [stage, journal],
        });
      else
        expect(failure).toMatchObject({
          code: "helper-failed",
          receipt: undefined,
          recoveryPaths: [stage, journal, input.outputPath],
        });
      expect(reconciliationOrder).toEqual([true]);
      expect(reconcilers).toHaveLength(1);
      expect(reconcilers[0]!.child.pid).not.toBe(helper?.pid);
      expect(reconciliationCloses).toEqual([
        { code: expectedOutcome === "unknown" ? 1 : 0, signal: null },
      ]);
      const originalPlan = actualPrepared!.publication;
      const expectedRequest =
        `verify-owned ${journalRecord.transactionId} prepared ${stageIdentity.device} ${stageIdentity.inode} ${oldIdentity.device} ${oldIdentity.inode}\n` +
        actualPrepared!.files
          .map(
            (file: { length: number; sha256: string }, index: number) =>
              `artifact ${index} ${file.length} ${file.sha256}\n`
          )
          .join("") +
        `old-package ${originalPlan.oldModuleName} ${originalPlan.oldRecordSHA256}\n` +
        originalPlan.oldFiles
          .map(
            (file: { length: number; sha256: string }, index: number) =>
              `old-artifact ${index} ${file.length} ${file.sha256}\n`
          )
          .join("");
      // Exact metadata-only input excludes payload transfer, commit, finalize, retry, and cleanup commands.
      expect(Buffer.concat(reconciliationWrites)).toEqual(
        Buffer.from(expectedRequest)
      );
      expect(
        reconciliationFrames.filter(
          (frame) => frame.kind === "reconciliation-result"
        )
      ).toEqual(
        expectedOutcome !== "unknown"
          ? [
              {
                schemaVersion: 1,
                kind: "reconciliation-result",
                transactionId: journalRecord.transactionId,
                phase: "prepared",
                outcome: expectedOutcome,
                parent: actualPrepared!.parent,
                destinationName: actualPrepared!.destinationName,
                ...(outcome === "published"
                  ? { output: stageIdentity }
                  : { stage: stageIdentity }),
                recordSHA256: actualPrepared!.recordSHA256,
              },
            ]
          : []
      );
      if (expectedOutcome === "unknown") {
        expect(
          reconciliationFrames.find((frame) => frame.kind === "reconciliation")
        ).toMatchObject({
          destination:
            outcome === "missing-destination"
              ? null
              : { ...oldIdentity, kind: "directory" },
          stage: { ...stageIdentity, kind: "directory" },
        });
        const rejected = reconciliationFrames.find(
          (frame) => frame.kind === "error"
        );
        expect(rejected).toMatchObject({
          code:
            outcome === "missing-destination" ? "conflict" : "invalid-stage",
          errno:
            outcome === "missing-destination"
              ? expect.any(Number)
              : osConstants.errno.EBADMSG,
        });
        expect(
          hasFailure(
            failure,
            "helper-failed",
            "Read-only publication reconciliation could not complete"
          )
        ).toBe(true);
      }
    } finally {
      markerController.abort();
      controller.abort(new Error("test cleanup"));
      if (helper?.exitCode === null && helper.signalCode === null)
        helper.kill("SIGKILL");
      for (const { child } of reconcilers)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      await closed;
      await operation;
      await Promise.all(reconcilers.map((entry) => entry.closed));
      await markerWait?.catch(() => {});
      clearTimeout(watchdog);
      for (const entry of reconcilers) clearTimeout(entry.watchdog);
      await oldDirectory?.close();
      boundary.environment = undefined;
      boundary.onHelper = undefined;
      boundary.beforeReconciliation = undefined;
      boundary.onReconciliation = undefined;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);

async function waitForMarker(
  path: string,
  signal: AbortSignal
): Promise<Record<string, any>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const bytes = await readFile(path, "utf8").catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
        return "";
      }
    );
    if (bytes.endsWith("\n")) return JSON.parse(bytes) as Record<string, any>;
    await delay(5, undefined, { signal });
  }
  throw new Error("The actual owned SWAP observer barrier was not reached");
}

async function expectPackageFiles(
  root: string,
  files: Readonly<Record<string, Uint8Array>>
): Promise<void> {
  for (const [path, bytes] of Object.entries(files)) {
    const metadata = await lstat(join(root, path));
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.size).toBe(bytes.byteLength);
    expect(await readFile(join(root, path))).toEqual(Buffer.from(bytes));
  }
}

function treeEvidence(root: string): unknown {
  const stat = lstatSync(root, { bigint: true });
  const identity = {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    links: stat.nlink,
  };
  if (stat.isDirectory())
    return {
      ...identity,
      children: readdirSync(root)
        .sort()
        .map((name) => [name, treeEvidence(join(root, name))]),
    };
  if (!stat.isFile()) throw new Error("Unexpected nonordinary package entry");
  return { ...identity, size: stat.size, bytes: readFileSync(root) };
}

function hasFailure(
  cause: unknown,
  code: string,
  message: string,
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
    (failure.code === code && failure.message === message) ||
    hasFailure(failure.cause, code, message, seen) ||
    (cause instanceof AggregateError &&
      cause.errors.some((error: unknown) =>
        hasFailure(error, code, message, seen)
      ))
  );
}
