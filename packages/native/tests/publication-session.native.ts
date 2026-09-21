import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  spawned: [] as import("node:child_process").ChildProcess[],
}));
// Observe the external process boundary; every helper still compiles and executes real C.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      processBoundary.spawned.push(child);
      return child;
    }) as typeof actual.spawn,
  };
});
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";

const temporary: string[] = [];
afterEach(async () => {
  processBoundary.spawned.length = 0;
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-publication-session-test-"))
  );
  temporary.push(root);
  const parentPath = join(root, "Parent");
  await mkdir(parentPath);
  await writeFile(join(parentPath, "preserved.txt"), "untouched");
  return { root, parentPath };
}

test("a compiled native session holds the physical parent lock across async work and releases without modifying it", async () => {
  const { parentPath } = await fixture();
  const result = await withMetalPublicationSession(
    { parentPath },
    async (session) => {
      expect(session.capabilities).toEqual({
        renameSwap: true,
        renameExclusive: true,
      });
      expect(Object.isFrozen(session.parent)).toBe(true);
      await Promise.resolve();
      for (const alias of [
        parentPath,
        parentPath.replace(/\/Parent$/, "/parent"),
        `/System/Volumes/Data${parentPath}`,
      ]) {
        const identity = await stat(alias, { bigint: true }).catch(
          () => undefined
        );
        if (
          identity?.dev.toString() !== session.parent.device ||
          identity.ino.toString() !== session.parent.inode
        )
          continue;
        await expect(
          withMetalPublicationSession(
            { parentPath: alias },
            async () => "unexpected"
          )
        ).rejects.toMatchObject({
          name: "MetalPublicationSessionError",
          code: "busy",
        });
      }
      return "completed";
    }
  );
  expect(result).toBe("completed");
  expect(
    await withMetalPublicationSession({ parentPath }, async () => "reacquired")
  ).toBe("reacquired");
  expect(await readdir(parentPath)).toEqual(["preserved.txt"]);
});

test("sessions reject symlinked parent components instead of locking their targets", async () => {
  const { root, parentPath } = await fixture();
  const alias = join(root, "Link");
  await symlink(parentPath, alias);
  await mkdir(join(parentPath, "Nested"));
  for (const path of [alias, join(alias, "Nested")]) {
    await expect(
      withMetalPublicationSession(
        { parentPath: path },
        async () => "unexpected"
      )
    ).rejects.toMatchObject({
      name: "MetalPublicationSessionError",
      code: "unsafe-parent",
    });
  }
});

test("a renamed parent remains locked but its replacement cannot satisfy the session identity", async () => {
  const { root, parentPath } = await fixture();
  const moved = join(root, "Moved");
  await expect(
    withMetalPublicationSession({ parentPath }, async (session) => {
      await rename(parentPath, moved);
      await mkdir(parentPath);
      await expect(session.assertParentUnchanged()).rejects.toMatchObject({
        code: "parent-changed",
      });
      await expect(
        withMetalPublicationSession(
          { parentPath: moved },
          async () => "unexpected"
        )
      ).rejects.toMatchObject({ code: "busy" });
      return "must not succeed";
    })
  ).rejects.toMatchObject({ code: "parent-changed" });
  expect(await readdir(parentPath)).toEqual([]);
  expect(await readdir(moved)).toEqual(["preserved.txt"]);
  expect(
    await withMetalPublicationSession(
      { parentPath: moved },
      async () => "released"
    )
  ).toBe("released");
});

test("sessions capture the selected tool environment before awaiting and remove only their own scratch on success or failure", async () => {
  const { root, parentPath } = await fixture();
  const scratch = join(root, "Scratch");
  await mkdir(scratch);
  await writeFile(join(scratch, "keep.txt"), "not helper-owned");
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
  const pending = withMetalPublicationSession(
    { parentPath, environment },
    async () => "captured"
  );
  environment.DEVELOPER_DIR = "/missing/changed-selection";
  environment.TMPDIR = "/missing/changed-scratch";
  expect(await pending).toBe("captured");
  const failure = new Error("callback failed");
  await expect(
    withMetalPublicationSession(
      { parentPath, environment: { ...process.env, TMPDIR: scratch } },
      async () => {
        throw failure;
      }
    )
  ).rejects.toBe(failure);
  await expect(
    withMetalPublicationSession(
      {
        parentPath,
        environment: {
          ...process.env,
          TMPDIR: scratch,
          DEVELOPER_DIR: "/missing/invalid-selection",
        },
      },
      async () => "unexpected"
    )
  ).rejects.toMatchObject({ code: "helper-failed" });
  const built = await import("../dist/tooling/publication-session.js");
  expect(
    await built.withMetalPublicationSession(
      { parentPath, environment: { ...process.env, TMPDIR: scratch } },
      async () => "built source asset"
    )
  ).toBe("built source asset");
  expect(await readdir(scratch)).toEqual(["keep.txt"]);
  expect(await readdir(parentPath)).toEqual(["preserved.txt"]);
});

test("cancellation waits for callback cleanup before releasing the lock and removes helper scratch", async () => {
  const { root, parentPath } = await fixture();
  const scratch = join(root, "Scratch");
  await mkdir(scratch);
  const environment = { ...process.env, TMPDIR: scratch };
  const before = new AbortController();
  before.abort();
  await expect(
    withMetalPublicationSession(
      { parentPath, environment, signal: before.signal },
      async () => "unexpected"
    )
  ).rejects.toMatchObject({ code: "cancelled" });
  const during = new AbortController();
  await expect(
    withMetalPublicationSession(
      { parentPath, environment, signal: during.signal },
      async (session) => {
        during.abort();
        expect(session.signal.aborted).toBe(true);
        await expect(
          withMetalPublicationSession(
            { parentPath, environment },
            async () => "unexpected"
          )
        ).rejects.toMatchObject({ code: "busy" });
        return "must not succeed";
      }
    )
  ).rejects.toMatchObject({ code: "cancelled" });
  const checking = new AbortController();
  let checkCancelled = false;
  await expect(
    withMetalPublicationSession(
      { parentPath, environment, signal: checking.signal },
      async (session) => {
        const pendingCheck = session.assertParentUnchanged();
        checking.abort();
        checkCancelled = await pendingCheck.then(
          () => false,
          (error) => error.code === "cancelled"
        );
      }
    )
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(checkCancelled).toBe(true);
  const cleanup = new AbortController();
  const cleanupFailure = new Error("callback cleanup failed");
  await expect(
    withMetalPublicationSession(
      { parentPath, environment, signal: cleanup.signal },
      async () => {
        cleanup.abort();
        throw cleanupFailure;
      }
    )
  ).rejects.toBe(cleanupFailure);
  expect(
    await withMetalPublicationSession(
      { parentPath, environment },
      async () => "released"
    )
  ).toBe("released");
  expect(await readdir(scratch)).toEqual([]);
});

test("an unexpectedly terminated helper aborts the active session and cannot report success", async () => {
  const { root, parentPath } = await fixture();
  const scratch = join(root, "Scratch");
  await mkdir(scratch);
  const environment = { ...process.env, TMPDIR: scratch };
  let observedAbort = false;
  await expect(
    withMetalPublicationSession(
      { parentPath, environment },
      async (session) => {
        const helper = processBoundary.spawned.at(-1)!;
        const closed = new Promise<void>((resolve) =>
          helper.once("close", () => resolve())
        );
        helper.kill("SIGKILL");
        await closed;
        observedAbort = session.signal.aborted;
        return "must not succeed";
      }
    )
  ).rejects.toMatchObject({ code: "helper-failed" });
  expect(observedAbort).toBe(true);
  let watchdogFired = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      withMetalPublicationSession(
        { parentPath, environment },
        async (session) => {
          const helper = processBoundary.spawned.at(-1)!;
          helper.kill("SIGSTOP");
          watchdog = setTimeout(() => {
            watchdogFired = true;
            helper.kill("SIGKILL");
          }, 8_000);
          await session.assertParentUnchanged();
          return "must not succeed";
        }
      )
    ).rejects.toMatchObject({ code: "helper-failed" });
  } finally {
    clearTimeout(watchdog);
  }
  expect(watchdogFired).toBe(false);
  expect(
    await withMetalPublicationSession(
      { parentPath, environment },
      async () => "released"
    )
  ).toBe("released");
  expect(await readdir(scratch)).toEqual([]);
  expect(await readdir(parentPath)).toEqual(["preserved.txt"]);
});

test("a callback failure and helper shutdown failure both remain available to the caller", async () => {
  const { parentPath } = await fixture();
  const primary = new Error("callback recovery evidence");
  const failure = await withMetalPublicationSession(
    { parentPath },
    async () => {
      processBoundary.spawned.at(-1)!.kill("SIGKILL");
      throw primary;
    }
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    name: "MetalPublicationSessionCleanupError",
    code: "cleanup-failed",
    errors: [
      primary,
      {
        code: "helper-failed",
        cause: { exitCode: null, signal: "SIGKILL" },
      },
    ],
  });
  expect((failure as { errors: unknown[] }).errors[0]).toBe(primary);
  expect(
    await withMetalPublicationSession({ parentPath }, async () => "released")
  ).toBe("released");
});

test("scratch cleanup failure preserves the primary error and identifies its owned recovery directory", async () => {
  const { root, parentPath } = await fixture();
  const scratch = join(root, "Scratch");
  await mkdir(scratch);
  await writeFile(join(scratch, "keep.txt"), "not helper-owned");
  const primary = new Error("callback recovery evidence");
  let owned: string | undefined;
  try {
    const failure = await withMetalPublicationSession(
      { parentPath, environment: { ...process.env, TMPDIR: scratch } },
      async () => {
        owned = dirname(processBoundary.spawned.at(-1)!.spawnfile);
        await chmod(owned, 0o500);
        throw primary;
      }
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "MetalPublicationSessionCleanupError",
      code: "cleanup-failed",
      recoveryPath: owned,
      errors: [primary, { code: "EACCES" }],
    });
    expect((failure as { errors: unknown[] }).errors[0]).toBe(primary);
    expect(await readdir(owned!)).toContain("publication-session.c");
    expect(await readdir(parentPath)).toEqual(["preserved.txt"]);
    expect(
      await withMetalPublicationSession({ parentPath }, async () => "released")
    ).toBe("released");
  } finally {
    if (owned) await chmod(owned, 0o700);
  }
});

test("relative tool and scratch selections keep their entry-time working-directory meaning", async () => {
  const { root, parentPath } = await fixture();
  const original = process.cwd();
  const other = join(root, "Other");
  const scratch = join(root, "Scratch");
  await mkdir(other);
  await mkdir(scratch);
  const selected = execFileSync("/usr/bin/xcode-select", ["--print-path"], {
    encoding: "utf8",
  }).trim();
  await symlink(selected, join(root, "SelectedXcode"));
  const environment = {
    ...process.env,
    TMPDIR: "Scratch",
    DEVELOPER_DIR: "SelectedXcode",
  };
  try {
    process.chdir(root);
    const pending = withMetalPublicationSession(
      { parentPath, environment },
      async () => "captured"
    );
    process.chdir(other);
    expect(await pending).toBe("captured");
  } finally {
    process.chdir(original);
  }
  expect(environment).toMatchObject({
    TMPDIR: "Scratch",
    DEVELOPER_DIR: "SelectedXcode",
  });
  expect(await readdir(scratch)).toEqual([]);
  expect(await readdir(other)).toEqual([]);
});
