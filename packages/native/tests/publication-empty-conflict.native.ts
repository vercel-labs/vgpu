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
import { constants as osConstants } from "node:os";
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

// Observe the actual helper's syscall at the spawn boundary; no substituted result or flags.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (
        boundary.environment &&
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        (args[1].includes("publish-missing-or-empty") ||
          args[1].includes("publish-project"))
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
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("an empty destination filled at the actual rename boundary is preserved by the kernel rejection", async () => {
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
    const observer = join(input.directory, "publication-empty-conflict.dylib");
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
    expect(before.source).not.toEqual(oldIdentity);
    expect(await readdir(input.outputPath)).toEqual([]);

    // All helper checks have completed: make the old destination nonempty before the real syscall.
    const handwrittenName = "keep.txt";
    const handwritten = join(input.outputPath, handwrittenName);
    const handwrittenBytes = Buffer.from(
      "A handwritten file that publication must preserve.\n"
    );
    await writeFile(handwritten, handwrittenBytes, { flag: "wx", mode: 0o640 });
    const fileBefore = await lstat(handwritten, { bigint: true });
    const rootBefore = await lstat(input.outputPath, { bigint: true });
    expect(fileBefore.isFile()).toBe(true);
    expect(fileBefore.nlink).toBe(1n);
    expect({
      device: rootBefore.dev,
      inode: rootBefore.ino,
      mode: rootBefore.mode,
    }).toEqual({
      device: oldRoot.dev,
      inode: oldRoot.ino,
      mode: oldRoot.mode,
    });
    await writeFile(resume, "resume\n", { flag: "wx" });

    const failure = await operation;
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(watchdogFired).toBe(false);
    const after = JSON.parse(await readFile(completed, "utf8"));
    expect(after).toEqual({
      result: -1,
      errno: osConstants.errno.ENOTEMPTY,
      destination: oldIdentity,
    });
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({
      code: "conflict",
      outcome: "not-published",
      receipt: undefined,
      recoveryPaths: [],
    });
    const rootAfter = await lstat(input.outputPath, { bigint: true });
    const retainedOld = await oldDirectory.stat({ bigint: true });
    for (const root of [rootAfter, retainedOld])
      expect({ device: root.dev, inode: root.ino, mode: root.mode }).toEqual({
        device: rootBefore.dev,
        inode: rootBefore.ino,
        mode: rootBefore.mode,
      });
    const fileAfter = await lstat(handwritten, { bigint: true });
    expect({
      device: fileAfter.dev,
      inode: fileAfter.ino,
      mode: fileAfter.mode,
      links: fileAfter.nlink,
      size: fileAfter.size,
    }).toEqual({
      device: fileBefore.dev,
      inode: fileBefore.ino,
      mode: fileBefore.mode,
      links: fileBefore.nlink,
      size: fileBefore.size,
    });
    expect(await readFile(handwritten)).toEqual(handwrittenBytes);
    expect(await readdir(input.outputPath)).toEqual([handwrittenName]);
    expect(await readdir(dirname(input.outputPath))).toEqual(["AppShaders"]);
  } finally {
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    await oldDirectory?.close();
    boundary.environment = undefined;
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
