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
  prepared: undefined as Record<string, unknown> | undefined,
  onHelper: undefined as
    | ((child: import("node:child_process").ChildProcess) => void)
    | undefined,
}));
// Observe real prepared metadata and the actual syscall; never replace helper responses.
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
            arg === "publish-missing" ||
            arg === "publish-missing-or-empty" ||
            arg === "publish-project"
        )
      ) {
        const child = actual.spawn(args[0], args[1], {
          ...args[2],
          env: { ...args[2]?.env, ...boundary.environment },
        });
        let buffered = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            const message = JSON.parse(line) as Record<string, unknown>;
            if (message.kind === "prepared") boundary.prepared = message;
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
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("an ordinary empty destination is replaced by one real no-follow rename with its original identity recorded", async () => {
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
      { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }
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
      const retained = await lstat(input.outputPath, { bigint: true });
      expect({
        device: retained.dev,
        inode: retained.ino,
        mode: retained.mode,
      }).toEqual({
        device: oldRoot.dev,
        inode: oldRoot.ino,
        mode: oldRoot.mode,
      });
      expect(await readdir(input.outputPath)).toEqual([]);
      expect(
        first.value,
        `Publisher settled before rename: ${String(first.value)}`
      ).toMatchObject({
        kind: "published",
        outcome: "published",
        confirmation: "acknowledged",
      });
      throw new Error(
        "Publication completed without the actual rename observer"
      );
    }
    const before = first.value;
    expect(before.noFollowAny).toBeGreaterThan(0);
    expect(before.flags).toBe(before.noFollowAny);
    expect(before.destination).toEqual(oldIdentity);
    expect(await readdir(input.outputPath)).toEqual([]);
    const parent = dirname(input.outputPath);
    const stageRoot = await lstat(join(parent, ".vgpu-native-stage"), {
      bigint: true,
    });
    const stageIdentity = {
      device: stageRoot.dev.toString(),
      inode: stageRoot.ino.toString(),
    };
    expect(before.source).toEqual(stageIdentity);
    expect(stageIdentity).not.toEqual(oldIdentity);
    const publication = {
      renameMode: "replace-empty",
      expectedDestination: "empty",
      oldDestination: oldIdentity,
    };
    const journal = JSON.parse(
      await readFile(join(parent, ".vgpu-native-publication.json"), "utf8")
    );
    expect(journal.phase).toBe("prepared");
    expect(journal.publication).toEqual(publication);
    expect(boundary.prepared?.publication).toEqual(publication);
    expect(boundary.prepared).toMatchObject({
      transactionId: journal.transactionId,
      stage: { name: ".vgpu-native-stage", ...stageIdentity },
    });
    await writeFile(resume, "resume\n", { flag: "wx" });
    const receipt = await operation;
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(watchdogFired).toBe(false);
    const after = JSON.parse(await readFile(completed, "utf8"));
    expect(after).toMatchObject({ result: 0, destination: stageIdentity });
    const output = await lstat(input.outputPath, { bigint: true });
    expect({
      device: output.dev.toString(),
      inode: output.ino.toString(),
    }).toEqual(stageIdentity);
    expect(output.ino).not.toBe(oldRoot.ino);
    // Keeping this descriptor open throughout excludes old-inode reuse as an explanation.
    const retainedOld = await oldDirectory.stat({ bigint: true });
    expect({ device: retainedOld.dev, inode: retainedOld.ino }).toEqual({
      device: oldRoot.dev,
      inode: oldRoot.ino,
    });
    expect(receipt).toMatchObject({
      kind: "published",
      outcome: "published",
      confirmation: "acknowledged",
      transactionId: journal.transactionId,
      outputPath: input.outputPath,
      output: stageIdentity,
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
    boundary.prepared = undefined;
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
  throw new Error("The actual empty-directory rename barrier was not reached");
}
