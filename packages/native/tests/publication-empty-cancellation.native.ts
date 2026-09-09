import { constants } from "node:fs";
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
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  observe: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));

// Observe the actual helper streams, without replacing replies or commit bytes.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        (args[1].includes("publish-missing-or-empty") ||
          args[1].includes("publish-project"))
      )
        boundary.observe?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
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
import { verifyMetalProject } from "../src/tooling/verify-project.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test.each(["prepared", "published"] as const)(
  "cancelling at the actual empty %s response preserves the correct publication outcome",
  async (phase) => {
    const input = await projectFixture();
    const controller = new AbortController();
    const reason = new Error(`cancelled at actual empty ${phase} response`);
    let oldDirectory: FileHandle | undefined;
    let helper: import("node:child_process").ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    let operation: Promise<unknown> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let watchdogFired = false;
    let observationFailure: unknown;
    let actualPrepared: Record<string, any> | undefined;
    let actualPublished: Record<string, any> | undefined;
    let commitObserved = false;
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
      expect(await readdir(input.outputPath)).toEqual([]);
      const prepared = await prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      });
      boundary.observe = (child) => {
        helper = child;
        closed = new Promise((resolveClose) =>
          child.once("close", () => {
            clearTimeout(watchdog);
            resolveClose();
          })
        );
        watchdog = setTimeout(() => {
          watchdogFired = true;
          child.kill("SIGKILL");
        }, 20_000);
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((
          chunk: Uint8Array,
          callback: (error?: Error | null) => void
        ) => {
          if (
            chunk.byteLength < 128 &&
            /^commit-(empty|missing) [a-f0-9]{32} prepared\n$/u.test(
              Buffer.from(chunk).toString("utf8")
            )
          )
            commitObserved = true;
          return write(chunk, callback);
        }) as typeof child.stdin.write;
        let buffered = "";
        child.stdout.on("data", (chunk: Buffer) => {
          try {
            buffered += chunk.toString("utf8");
            let newline: number;
            while ((newline = buffered.indexOf("\n")) >= 0) {
              const line = buffered.slice(0, newline);
              buffered = buffered.slice(newline + 1);
              if (Buffer.byteLength(line) > 64 * 1024)
                throw new Error("Observed frame exceeded 64 KiB");
              const message = JSON.parse(line) as Record<string, any>;
              if (message.kind === "prepared") {
                if (actualPrepared)
                  throw new Error("Unexpected second prepared frame");
                actualPrepared = message;
                if (phase === "prepared") controller.abort(reason);
              } else if (
                message.kind === "commit-result" &&
                message.outcome === "published"
              ) {
                actualPublished = message;
                if (phase === "published") controller.abort(reason);
              }
            }
            if (Buffer.byteLength(buffered) > 64 * 1024)
              throw new Error("Observed frame exceeded 64 KiB");
          } catch (cause) {
            observationFailure = cause;
            child.kill("SIGKILL");
          }
        });
      };
      operation = publishPreparedMetalOutput({
        prepared,
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      const failure = await operation;
      await closed;
      expect(observationFailure).toBeUndefined();
      expect(watchdogFired).toBe(false);
      expect(controller.signal.reason).toBe(reason);
      expect(commitObserved).toBe(phase === "published");
      expect(actualPrepared?.publication).toEqual({
        renameMode: "replace-empty",
        expectedDestination: "empty",
        oldDestination: oldIdentity,
      });
      expect(failure).toBeInstanceOf(MetalPublicationError);
      expect(failure).toMatchObject({
        code: "cancelled",
        outcome: phase === "published" ? "published" : "not-published",
        cause: { code: "cancelled", cause: reason },
      });
      expect(((failure as MetalPublicationError).cause as Error).cause).toBe(
        reason
      );
      const parent = dirname(input.outputPath);
      const stage = join(parent, ".vgpu-native-stage");
      const journal = join(parent, ".vgpu-native-publication.json");
      const oldObservations = [await oldDirectory.stat({ bigint: true })];
      if (phase === "prepared")
        oldObservations.push(await lstat(input.outputPath, { bigint: true }));
      for (const root of oldObservations) {
        expect(root.isDirectory()).toBe(true);
        expect({ device: root.dev, inode: root.ino, mode: root.mode }).toEqual({
          device: oldRoot.dev,
          inode: oldRoot.ino,
          mode: oldRoot.mode,
        });
      }
      if (phase === "published") {
        const output = await lstat(input.outputPath, { bigint: true });
        const identity = {
          device: output.dev.toString(),
          inode: output.ino.toString(),
        };
        expect(output.isDirectory()).toBe(true);
        expect(identity).toEqual({
          device: actualPrepared?.stage.device,
          inode: actualPrepared?.stage.inode,
        });
        expect(identity).not.toEqual(oldIdentity);
        expect(actualPublished).toMatchObject({
          transactionId: actualPrepared?.transactionId,
          output: identity,
        });
        expect(failure).toMatchObject({
          receipt: {
            confirmation: "acknowledged",
            outcome: "published",
            outputPath: input.outputPath,
            transactionId: actualPrepared?.transactionId,
            output: identity,
          },
          recoveryPaths: [],
        });
        for (const [path, bytes] of Object.entries(prepared.files))
          expect(await readFile(join(input.outputPath, path))).toEqual(
            Buffer.from(bytes)
          );
        await expect(
          verifyMetalProject({ configurationPath: input.configurationPath })
        ).resolves.toMatchObject({
          outputPath: input.outputPath,
          inputFingerprint: prepared.project.inputFingerprint,
        });
        expect(await readdir(parent)).toEqual(["AppShaders"]);
        return;
      }
      expect(actualPublished).toBeUndefined();
      expect(failure).toMatchObject({
        receipt: undefined,
        recoveryPaths: [stage, journal],
      });
      expect(await readdir(input.outputPath)).toEqual([]);
      expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({
        phase: "prepared",
        transactionId: actualPrepared?.transactionId,
        publication: actualPrepared?.publication,
        stage: actualPrepared?.stage,
      });
      const stageRoot = await lstat(stage, { bigint: true });
      expect({
        device: stageRoot.dev.toString(),
        inode: stageRoot.ino.toString(),
      }).toEqual({
        device: actualPrepared?.stage.device,
        inode: actualPrepared?.stage.inode,
      });
      for (const [path, bytes] of Object.entries(prepared.files))
        expect(await readFile(join(stage, path))).toEqual(Buffer.from(bytes));
      expect((await readdir(parent)).sort()).toEqual([
        ".vgpu-native-publication.json",
        ".vgpu-native-stage",
        "AppShaders",
      ]);
    } finally {
      controller.abort(new Error("test cleanup"));
      if (helper?.exitCode === null && helper.signalCode === null)
        helper.kill("SIGKILL");
      await closed;
      await operation;
      clearTimeout(watchdog);
      await oldDirectory?.close();
      boundary.observe = undefined;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);
