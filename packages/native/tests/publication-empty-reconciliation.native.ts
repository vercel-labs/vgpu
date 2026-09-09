import { execFile } from "node:child_process";
import { constants, lstatSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
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
  observationFailure: undefined as unknown,
  beforeReconciliation: undefined as (() => void) | undefined,
  onReconciliation: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
  onHelper: undefined as
    | ((child: import("node:child_process").ChildProcess) => void)
    | undefined,
}));

// Interrupt only the real publisher after its real rename, never the read-only helper.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        args[1].includes("reconcile-empty")
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
        args[1].includes("publish-missing-or-empty")
      ) {
        const child = actual.spawn(args[0], args[1], {
          ...args[2],
          env: { ...args[2]?.env, ...boundary.environment },
        });
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
              boundary.messages.push(
                JSON.parse(line) as Record<string, unknown>
              );
            }
            if (Buffer.byteLength(buffered) > 64 * 1024)
              throw new Error("Observed helper frame exceeded 64 KiB");
          } catch (cause) {
            boundary.observationFailure = cause;
            child.kill("SIGKILL");
          }
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
import { parseMetalPublicationPlan } from "../src/tooling/publication-recovery.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test.each(["original", "changed-old-identity", "cancelled"] as const)(
  "lost empty-publication ACK uses the original transaction plan (%s)",
  async (journalVariant) => {
    const input = await projectFixture();
    const controller = new AbortController();
    const cancellationReason = new Error(
      "cancelled while the actual empty rename was paused"
    );
    let oldDirectory: FileHandle | undefined;
    let helper: import("node:child_process").ChildProcess | undefined;
    let closed:
      | Promise<{ code: number | null; signal: string | null }>
      | undefined;
    let operation: Promise<unknown> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    let reconciliationCount = 0;
    let reconciliationClosed: Promise<void> | undefined;
    let verificationRequested = false;
    let reconciliationStartedAborted = false;
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
      const alternate = join(input.directory, "other-empty-root");
      await mkdir(alternate);
      const alternateRoot = await lstat(alternate, { bigint: true });
      const alternateIdentity = {
        device: alternateRoot.dev.toString(),
        inode: alternateRoot.ino.toString(),
      };
      expect(alternateIdentity.device).toBe(oldIdentity.device);
      expect(alternateIdentity.inode).not.toBe(oldIdentity.inode);
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
        VGPU_EMPTY_RENAME_EXIT_AFTER_SUCCESS: "1",
      };
      boundary.onHelper = (child) => {
        helper = child;
        closed = new Promise((resolveClose) =>
          child.once("close", (code, signal) => {
            clearTimeout(watchdog);
            resolveClose({ code, signal });
          })
        );
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

      const before = await waitForMarker(paused);
      expect(before.noFollowAny).toBeGreaterThan(0);
      expect(before.flags).toBe(before.noFollowAny);
      expect(before.destination).toEqual(oldIdentity);
      expect(await readdir(input.outputPath)).toEqual([]);
      const parent = dirname(input.outputPath);
      const stage = join(parent, ".vgpu-native-stage");
      const journal = join(parent, ".vgpu-native-publication.json");
      const stageRoot = await lstat(stage, { bigint: true });
      const stageIdentity = {
        device: stageRoot.dev.toString(),
        inode: stageRoot.ino.toString(),
      };
      expect(before.source).toEqual(stageIdentity);
      expect(stageIdentity).not.toEqual(oldIdentity);
      const stageEvidence = await treeEvidence(stage);
      let journalEvidence = await treeEvidence(journal);
      const journalBytes = await readFile(journal);
      let expectedJournalBytes = journalBytes;
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
      let changedJournal = false;
      boundary.beforeReconciliation = () => {
        reconciliationStartedAborted = controller.signal.aborted;
        if (journalVariant !== "changed-old-identity") return;
        if (changedJournal)
          throw new Error("Unexpected second reconciliation attempt");
        const changed = {
          ...journalRecord,
          publication: { ...publication, oldDestination: alternateIdentity },
        };
        // The modified plan is valid in isolation, but not the original live transaction.
        expect(
          parseMetalPublicationPlan(
            changed.publication,
            changed.parent,
            changed.stage
          )
        ).toEqual(changed.publication);
        expectedJournalBytes = Buffer.from(`${JSON.stringify(changed)}\n`);
        writeFileSync(journal, expectedJournalBytes);
        const metadata = lstatSync(journal, { bigint: true });
        journalEvidence = {
          device: metadata.dev,
          inode: metadata.ino,
          mode: metadata.mode,
          links: metadata.nlink,
          size: metadata.size,
          bytes: expectedJournalBytes,
        };
        changedJournal = true;
      };
      boundary.onReconciliation = (child) => {
        reconciliationCount++;
        reconciliationClosed = new Promise((resolveClose) =>
          child.once("close", () => resolveClose())
        );
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((
          chunk: Uint8Array,
          callback: (error?: Error | null) => void
        ) => {
          verificationRequested = true;
          return write(chunk, callback);
        }) as typeof child.stdin.write;
      };
      if (journalVariant === "cancelled") controller.abort(cancellationReason);
      await writeFile(resume, "resume\n", { flag: "wx" });

      const failure = await operation;
      await reconciliationClosed;
      expect(reconciliationCount).toBe(1);
      expect(changedJournal).toBe(journalVariant === "changed-old-identity");
      expect(verificationRequested).toBe(
        journalVariant !== "changed-old-identity"
      );
      expect(reconciliationStartedAborted).toBe(journalVariant === "cancelled");
      expect(boundary.observationFailure).toBeUndefined();
      expect(await closed).toEqual({ code: 97, signal: null });
      expect(watchdogFired).toBe(false);
      expect(
        boundary.messages.some(
          (message) =>
            message.kind === "commit-result" && message.outcome === "published"
        )
      ).toBe(false);
      const after = JSON.parse(await readFile(completed, "utf8"));
      expect(after).toMatchObject({ result: 0, destination: stageIdentity });
      expect(await treeEvidence(input.outputPath)).toEqual(stageEvidence);
      // The old inode cannot be reused while this original directory descriptor is held.
      const retainedOld = await oldDirectory.stat({ bigint: true });
      expect({ device: retainedOld.dev, inode: retainedOld.ino }).toEqual({
        device: oldRoot.dev,
        inode: oldRoot.ino,
      });
      expect(Object.keys(prepared.files)).toHaveLength(4);
      for (const [name, bytes] of Object.entries(prepared.files)) {
        const path = join(input.outputPath, name);
        const metadata = await lstat(path);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.nlink).toBe(1);
        expect(metadata.size).toBe(bytes.byteLength);
        expect(await readFile(path)).toEqual(Buffer.from(bytes));
      }
      await expect(
        verifyMetalProject({ configurationPath: input.configurationPath })
      ).resolves.toMatchObject({
        outputPath: input.outputPath,
        inputFingerprint: prepared.project.inputFingerprint,
      });
      expect(await treeEvidence(input.outputPath)).toEqual(stageEvidence);
      expect(await treeEvidence(journal)).toEqual(journalEvidence);
      expect(await readFile(journal)).toEqual(expectedJournalBytes);
      const alternateAfter = await lstat(alternate, { bigint: true });
      expect({
        device: alternateAfter.dev,
        inode: alternateAfter.ino,
        mode: alternateAfter.mode,
      }).toEqual({
        device: alternateRoot.dev,
        inode: alternateRoot.ino,
        mode: alternateRoot.mode,
      });
      expect(await readdir(alternate)).toEqual([]);
      await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(parent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        "AppShaders",
      ]);

      // Physical rename and exact retained evidence precede every outcome assertion.
      expect(failure).toBeInstanceOf(MetalPublicationError);
      if (journalVariant === "changed-old-identity") {
        expect(failure).toMatchObject({
          code: "helper-failed",
          outcome: "unknown",
          receipt: undefined,
          recoveryPaths: [journal, stage, input.outputPath],
        });
        expect(
          hasFailureMessage(
            failure,
            "Invalid publication staging helper response"
          )
        ).toBe(true);
        expect(
          hasFailureMessage(
            failure,
            "Recovery record does not match the original prepared publication"
          )
        ).toBe(true);
        return;
      }
      expect(failure).toMatchObject({ outcome: "published" });
      expect(failure).toMatchObject({
        code: journalVariant === "cancelled" ? "cancelled" : "helper-failed",
        receipt: {
          confirmation: "reconciled",
          outcome: "published",
          transactionId: journalRecord.transactionId,
          outputPath: input.outputPath,
          output: stageIdentity,
        },
        recoveryPaths: [journal, input.outputPath],
      });
      expect(
        hasFailureMessage(
          failure,
          "Invalid publication staging helper response"
        )
      ).toBe(true);
      if (journalVariant === "cancelled") {
        expect(controller.signal.reason).toBe(cancellationReason);
        expect(failureChain(failure)).toContain(cancellationReason);
      } else
        expect((failure as Error).cause).toMatchObject({
          code: "helper-failed",
          message: "Invalid publication staging helper response",
        });
    } finally {
      controller.abort(new Error("test cleanup"));
      if (helper?.exitCode === null && helper.signalCode === null)
        helper.kill("SIGKILL");
      await closed;
      await operation;
      await reconciliationClosed;
      clearTimeout(watchdog);
      await oldDirectory?.close();
      boundary.environment = undefined;
      boundary.messages = [];
      boundary.observationFailure = undefined;
      boundary.onHelper = undefined;
      boundary.beforeReconciliation = undefined;
      boundary.onReconciliation = undefined;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);

function hasFailureMessage(cause: unknown, message: string): boolean {
  return (
    cause instanceof Error &&
    (cause.message === message ||
      hasFailureMessage(cause.cause, message) ||
      (cause instanceof AggregateError &&
        cause.errors.some((error: unknown) =>
          hasFailureMessage(error, message)
        )))
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
    size: stat.size,
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
  return { ...identity, bytes: await readFile(root) };
}
