import { execFile } from "node:child_process";
import { constants } from "node:fs";
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

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("a real empty-directory replacement with a lost ACK is reconciled as published without changing retained evidence", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
  let oldDirectory: FileHandle | undefined;
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed:
    | Promise<{ code: number | null; signal: string | null }>
    | undefined;
  let operation: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
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
    const journalEvidence = await treeEvidence(journal);
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
    await writeFile(resume, "resume\n", { flag: "wx" });

    const failure = await operation;
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
    expect(await readFile(journal)).toEqual(journalBytes);
    await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      "AppShaders",
    ]);

    // Physical rename and exact retained evidence must pass before this product RED.
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({ outcome: "published" });
    expect(failure).toMatchObject({
      code: "helper-failed",
      cause: expect.objectContaining({
        code: "helper-failed",
        message: "Invalid publication staging helper response",
      }),
      receipt: {
        confirmation: "reconciled",
        outcome: "published",
        transactionId: journalRecord.transactionId,
        outputPath: input.outputPath,
        output: stageIdentity,
      },
      recoveryPaths: [journal, input.outputPath],
    });
  } finally {
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    await oldDirectory?.close();
    boundary.environment = undefined;
    boundary.messages = [];
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
