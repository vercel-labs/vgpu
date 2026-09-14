import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:os";
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

// Inject observation at the process boundary; the production helper and replies remain real.
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

test("an empty destination appearing at the actual exclusive rename boundary is preserved and publication is rejected", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
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
    const observer = join(input.directory, "publication-rename-conflict.dylib");
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
    };
    boundary.onHelper = (child) => {
      helper = child;
      closed = new Promise((resolveClose) => {
        child.once("close", (code, signal) => resolveClose({ code, signal }));
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
    // A nonempty sentinel would also defeat ordinary rename, so the competitor must stay empty.
    await mkdir(input.outputPath, { mode: 0o750 });
    const competitor = await lstat(input.outputPath, { bigint: true });
    expect(competitor.isDirectory()).toBe(true);
    expect(await readdir(input.outputPath)).toEqual([]);
    await writeFile(resume, "resume\n", { flag: "wx" });

    const failure = await operation;
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({
      code: "conflict",
      outcome: "not-published",
      recoveryPaths: [],
      receipt: undefined,
    });
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(watchdogFired).toBe(false);
    expect(await readFile(completed, "utf8")).toBe(
      `-1 ${constants.errno.EEXIST}\n`
    );
    const retained = await lstat(input.outputPath, { bigint: true });
    expect({
      device: retained.dev,
      inode: retained.ino,
      mode: retained.mode,
    }).toEqual({
      device: competitor.dev,
      inode: competitor.ino,
      mode: competitor.mode,
    });
    expect(await readdir(input.outputPath)).toEqual([]);
    expect(await readdir(dirname(input.outputPath))).toEqual(["AppShaders"]);
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
