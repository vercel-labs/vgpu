import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  beforeReconciliation: undefined as (() => void) | undefined,
}));

// Change one real file before the actual read-only helper starts; never fabricate helper replies.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (args[0].endsWith("/publication-staging") && Array.isArray(args[1])) {
        if (args[1].includes("reconcile-missing"))
          boundary.beforeReconciliation?.();
        if (
          boundary.environment &&
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

test("one changed payload byte with unchanged identities cannot resolve a lost publication ACK", async () => {
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
    const observer = join(
      input.directory,
      "publication-corruption-interruption.dylib"
    );
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
      VGPU_RENAME_EXIT_AFTER_SUCCESS: "1",
    };
    boundary.onHelper = (child) => {
      helper = child;
      closed = new Promise((resolveClose) => {
        child.once("close", (code, signal) => {
          clearTimeout(watchdog);
          resolveClose({ code, signal });
        });
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
    const parent = dirname(input.outputPath);
    const stage = join(parent, ".vgpu-native-stage");
    const journal = join(parent, ".vgpu-native-publication.json");
    const corruptedName = `Sources/${prepared.record.moduleName}/Resources/Shaders.metallib`;
    const originalBytes = prepared.files[corruptedName]!;
    const offset = Math.floor(originalBytes.byteLength / 2);
    expect(originalBytes.byteLength).toBeGreaterThan(0);
    const changedByte = Buffer.from([originalBytes[offset]! ^ 1]);
    const stageIdentity = await lstat(stage, { bigint: true });
    const payloadIdentity = await lstat(join(stage, corruptedName), {
      bigint: true,
    });
    const journalBefore = treeEvidenceSync(journal);
    const journalBytes = await readFile(journal);
    expect(JSON.parse(journalBytes.toString("utf8"))).toMatchObject({
      phase: "prepared",
      publication: { renameMode: "excl", expectedDestination: "missing" },
      stage: {
        device: stageIdentity.dev.toString(),
        inode: stageIdentity.ino.toString(),
      },
    });

    let corrupted = false;
    let modifiedTree: unknown;
    boundary.beforeReconciliation = () => {
      if (corrupted)
        throw new Error("Unexpected second reconciliation attempt");
      const path = join(input.outputPath, corruptedName);
      expect(entryIdentity(lstatSync(path, { bigint: true }))).toEqual(
        entryIdentity(payloadIdentity)
      );
      // No truncate, unlink, copy or replacement: change one byte through the existing file.
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_NOFOLLOW
      );
      try {
        expect(writeSync(descriptor, changedByte, 0, 1, offset)).toBe(1);
      } finally {
        closeSync(descriptor);
      }
      const changed = lstatSync(path, { bigint: true });
      expect(changed.isFile()).toBe(true);
      expect(changed.nlink).toBe(1n);
      expect(entryIdentity(changed)).toEqual(entryIdentity(payloadIdentity));
      modifiedTree = treeEvidenceSync(parent);
      corrupted = true;
    };
    await writeFile(resume, "resume\n", { flag: "wx" });

    const failure = await operation;
    expect(await closed).toEqual({ code: 97, signal: null });
    expect(watchdogFired).toBe(false);
    expect(await readFile(completed, "utf8")).toMatch(/^0 \d+\n$/u);
    expect(corrupted).toBe(true);
    const output = await lstat(input.outputPath, { bigint: true });
    expect(output.isDirectory()).toBe(true);
    expect(entryIdentity(output)).toEqual(entryIdentity(stageIdentity));
    expect(treeEvidenceSync(parent)).toEqual(modifiedTree);
    for (const [name, bytes] of Object.entries(prepared.files)) {
      const path = join(input.outputPath, name);
      const metadata = await lstat(path, { bigint: true });
      const actual = await readFile(path);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.size).toBe(BigInt(bytes.byteLength));
      if (name === corruptedName) {
        expect(entryIdentity(metadata)).toEqual(entryIdentity(payloadIdentity));
        expect(actual.byteLength).toBe(bytes.byteLength);
        const differences = [...actual.keys()].filter(
          (index) => actual[index] !== bytes[index]
        );
        expect(differences).toEqual([offset]);
        expect(actual[offset]).toBe(changedByte[0]);
      } else expect(actual).toEqual(Buffer.from(bytes));
    }
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).rejects.toMatchObject({
      name: "MetalOutputVerificationError",
      code: "invalid-output",
      message: `Generated file has changed: ${corruptedName}`,
    });
    expect(treeEvidenceSync(parent)).toEqual(modifiedTree);
    expect(treeEvidenceSync(journal)).toEqual(journalBefore);
    expect(await readFile(journal)).toEqual(journalBytes);
    await expect(lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).sort()).toEqual([
      ".vgpu-native-publication.json",
      "AppShaders",
    ]);

    // Honest GREEN characterization: root identity and file size cannot substitute for hashes.
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({
      code: "helper-failed",
      outcome: "unknown",
      receipt: undefined,
      recoveryPaths: expect.arrayContaining([journal, input.outputPath]),
    });
    expect(hasOriginalHelperEof(failure)).toBe(true);
  } finally {
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    boundary.environment = undefined;
    boundary.onHelper = undefined;
    boundary.beforeReconciliation = undefined;
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

function entryIdentity(stat: BigIntStats) {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    links: stat.nlink,
    size: stat.size,
  };
}

function treeEvidenceSync(root: string): unknown {
  const stat = lstatSync(root, { bigint: true });
  if (stat.isDirectory())
    return {
      ...entryIdentity(stat),
      children: readdirSync(root)
        .sort()
        .map((name) => [name, treeEvidenceSync(join(root, name))]),
    };
  if (!stat.isFile()) throw new Error("Unexpected nonordinary recovery entry");
  return { ...entryIdentity(stat), bytes: readFileSync(root) };
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
