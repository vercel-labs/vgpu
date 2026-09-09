import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
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

// Instrument only the second real publisher, without replacing replies or syscall results.
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
            arg === "publish-missing-or-empty" || arg === "publish-project"
        )
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
import { publishPreparedMetalOutput } from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("a byte-identical owned rebuild atomically exchanges distinct complete package roots and cleans only the old package", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
  const markerController = new AbortController();
  let oldDirectory: FileHandle | undefined;
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed:
    | Promise<{ code: number | null; signal: string | null }>
    | undefined;
  let operation: Promise<unknown> | undefined;
  let markerWait: Promise<Record<string, any>> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let observedPublishers = 0;
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
    expect(await readdir(parent)).toEqual(["AppShaders"]);
    oldDirectory = await open(
      input.outputPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const oldRoot = await oldDirectory.stat({ bigint: true });
    expect(oldRoot.isDirectory()).toBe(true);
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
    expect(prepared.record.moduleName).toBe(original.record.moduleName);
    expect(prepared.project.inputFingerprint).toBe(
      original.project.inputFingerprint
    );
    expect(Object.keys(prepared.files).sort()).toEqual(
      Object.keys(original.files).sort()
    );
    expect(Object.keys(prepared.files)).toHaveLength(4);
    for (const [name, bytes] of Object.entries(prepared.files))
      expect(Buffer.from(bytes)).toEqual(Buffer.from(original.files[name]!));
    expect(Buffer.from(prepared.files[".vgpu-native-output.json"]!)).toEqual(
      oldRecordBytes
    );
    expect(await treeEvidence(input.outputPath)).toEqual(oldBefore);

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
      observedPublishers++;
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
    }).catch((cause: unknown) => cause);
    markerWait = waitForMarker(paused, markerController.signal);
    const first = await Promise.race([
      operation.then((value) => ({ kind: "settled" as const, value })),
      markerWait.then((value) => ({ kind: "paused" as const, value })),
    ]);
    if (first.kind === "settled") {
      markerController.abort();
      await markerWait.catch(() => {});
      await closed;
      expect(boundary.observationFailure).toBeUndefined();
      expect(observedPublishers).toBe(1);
      expect(watchdogFired).toBe(false);
      expect(await treeEvidence(input.outputPath)).toEqual(oldBefore);
      expect(
        await readFile(join(input.outputPath, ".vgpu-native-output.json"))
      ).toEqual(oldRecordBytes);
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
      expect(await readdir(parent)).toEqual(["AppShaders"]);
      for (const path of [paused, resume, completed, returnAfterSuccess])
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        verifyMetalProject({ configurationPath: input.configurationPath })
      ).resolves.toMatchObject({
        inputFingerprint: prepared.project.inputFingerprint,
      });
      // The original helper's nonempty conflict is a product RED, never a barrier timeout.
      expect(
        first.value,
        `Publisher settled before exchange: ${String(first.value)}`
      ).toMatchObject({
        kind: "published",
        outcome: "published",
        confirmation: "acknowledged",
      });
      throw new Error(
        "Publication completed without the actual exchange observer"
      );
    }

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
    expect(before.source).toEqual(stageIdentity);
    expect(stageIdentity).not.toEqual(oldIdentity);
    const stageBefore = await treeEvidence(stage);
    const journalBefore = await treeEvidence(journal);
    expect(await treeEvidence(input.outputPath)).toEqual(oldBefore);
    expect(await readFile(join(stage, ".vgpu-native-output.json"))).toEqual(
      oldRecordBytes
    );
    const journalRecord = JSON.parse(await readFile(journal, "utf8"));
    const publication = {
      renameMode: "swap",
      expectedDestination: "owned",
      oldDestination: oldIdentity,
    };
    expect(journalRecord).toMatchObject({ phase: "prepared", publication });
    expect(
      boundary.messages.find((message) => message.kind === "prepared")
    ).toMatchObject({
      transactionId: journalRecord.transactionId,
      publication,
      stage: { name: ".vgpu-native-stage", ...stageIdentity },
    });
    await writeFile(resume, "resume\n", { flag: "wx" });
    markerWait = waitForMarker(completed, markerController.signal);
    const after = await markerWait;
    expect(after).toMatchObject({
      result: 0,
      source: oldIdentity,
      destination: stageIdentity,
    });
    // Both complete byte-identical trees are still distinguishable by their original identities.
    expect(await treeEvidence(stage)).toEqual(oldBefore);
    expect(await treeEvidence(input.outputPath)).toEqual(stageBefore);
    expect(await treeEvidence(journal)).toEqual(journalBefore);
    expect(await readFile(join(stage, ".vgpu-native-output.json"))).toEqual(
      oldRecordBytes
    );
    expect(
      await readFile(join(input.outputPath, ".vgpu-native-output.json"))
    ).toEqual(oldRecordBytes);
    expect(
      boundary.messages.some((message) => message.kind === "commit-result")
    ).toBe(false);
    expect(helper?.exitCode).toBeNull();
    expect(helper?.signalCode).toBeNull();
    await writeFile(returnAfterSuccess, "return\n", { flag: "wx" });

    const receipt = await operation;
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(boundary.observationFailure).toBeUndefined();
    expect(observedPublishers).toBe(1);
    expect(watchdogFired).toBe(false);
    expect(receipt).toMatchObject({
      kind: "published",
      outcome: "published",
      confirmation: "acknowledged",
      transactionId: journalRecord.transactionId,
      outputPath: input.outputPath,
      output: stageIdentity,
    });
    expect(await treeEvidence(input.outputPath)).toEqual(stageBefore);
    const retainedOld = await oldDirectory.stat({ bigint: true });
    expect({ device: retainedOld.dev, inode: retainedOld.ino }).toEqual({
      device: oldRoot.dev,
      inode: oldRoot.ino,
    });
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
    for (const path of [stage, journal, update])
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(parent)).toEqual(["AppShaders"]);
  } finally {
    markerController.abort();
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    await markerWait?.catch(() => {});
    clearTimeout(watchdog);
    await oldDirectory?.close();
    boundary.environment = undefined;
    boundary.messages = [];
    boundary.observationFailure = undefined;
    boundary.onHelper = undefined;
    await rm(input.directory, { recursive: true, force: true });
  }
});

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
  throw new Error("The actual owned-package exchange barrier was not reached");
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
  if (!stat.isFile())
    throw new Error("Unexpected nonordinary publication entry");
  return { ...identity, size: stat.size, bytes: await readFile(root) };
}
