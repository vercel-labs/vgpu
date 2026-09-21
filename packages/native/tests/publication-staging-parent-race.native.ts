import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  onHelper: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));
// Observe actual process/pipe events; every compiler, payload, and helper response is real.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (args[0].endsWith("/publication-staging"))
        processBoundary.onHelper?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
      return child;
    }) as typeof actual.spawn,
  };
});
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import { withPreparedMetalPublicationStage } from "../src/tooling/publication-staging.ts";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);
const stageName = ".vgpu-native-stage";
const journalName = ".vgpu-native-publication.json";

test("moving the output parent during real payload transfer keeps every write under its retained directory", async () => {
  const input = await projectFixture();
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    let enteredBarrier!: () => void;
    const barrier = new Promise<void>((resolveBarrier) => {
      enteredBarrier = resolveBarrier;
    });
    processBoundary.onHelper = (child) => {
      helper = child;
      closed = new Promise((resolveClose) =>
        child.once("close", () => resolveClose())
      );
      const write = child.stdin.write.bind(child.stdin);
      let paused = false;
      child.stdin.write = ((
        chunk: Uint8Array,
        callback: (error?: Error | null) => void
      ) =>
        write(chunk, (error) => {
          if (
            !paused &&
            !error &&
            Buffer.from(chunk.subarray(0, 7)).toString("ascii") === "file 0 "
          ) {
            paused = true;
            release = () => {
              release = undefined;
              callback(error);
            };
            enteredBarrier();
          } else callback(error);
        })) as typeof child.stdin.write;
    };
    let callbackCalled = false;
    pending = withPreparedMetalPublicationStage({ prepared }, async () => {
      callbackCalled = true;
    }).catch((cause: unknown) => cause);
    await withDeadline(
      Promise.race([
        barrier,
        pending.then((result) => {
          throw new Error("Staging ended before the pipe barrier", {
            cause: result,
          });
        }),
      ])
    );

    const parent = dirname(input.outputPath);
    const moved = join(input.directory, "Moved");
    const parentIdentity = await lstat(parent, { bigint: true });
    const stageIdentity = await lstat(join(parent, stageName), {
      bigint: true,
    });
    const journalBytes = await readFile(join(parent, journalName));
    expect(JSON.parse(journalBytes.toString("utf8"))).toMatchObject({
      phase: "staging",
      parent: {
        device: parentIdentity.dev.toString(),
        inode: parentIdentity.ino.toString(),
      },
      stage: {
        device: stageIdentity.dev.toString(),
        inode: stageIdentity.ino.toString(),
      },
    });
    await rename(parent, moved);
    await mkdir(parent);
    const sentinel = join(parent, "replacement.txt");
    await writeFile(sentinel, "preserve replacement parent");
    const replacementIdentity = await lstat(parent, { bigint: true });
    expect(replacementIdentity.ino).not.toBe(parentIdentity.ino);
    release!();

    expect(await withDeadline(pending)).toMatchObject({
      name: "MetalPublicationStagingError",
      code: "parent-changed",
    });
    expect(callbackCalled).toBe(false);
    await withDeadline(closed!);
    expect(await readdir(parent)).toEqual(["replacement.txt"]);
    expect(await readFile(sentinel, "utf8")).toBe(
      "preserve replacement parent"
    );
    const replacementAfter = await lstat(parent, { bigint: true });
    expect({
      device: replacementAfter.dev,
      inode: replacementAfter.ino,
    }).toEqual({
      device: replacementIdentity.dev,
      inode: replacementIdentity.ino,
    });

    const movedStage = join(moved, stageName);
    const movedIdentity = await lstat(moved, { bigint: true });
    const movedStageIdentity = await lstat(movedStage, { bigint: true });
    expect({ device: movedIdentity.dev, inode: movedIdentity.ino }).toEqual({
      device: parentIdentity.dev,
      inode: parentIdentity.ino,
    });
    expect({
      device: movedStageIdentity.dev,
      inode: movedStageIdentity.ino,
    }).toEqual({
      device: stageIdentity.dev,
      inode: stageIdentity.ino,
    });
    expect(Object.keys(prepared.files)).toHaveLength(4);
    for (const [path, bytes] of Object.entries(prepared.files)) {
      const target = join(movedStage, path);
      const identity = await lstat(target);
      expect(identity.isFile()).toBe(true);
      expect(identity.nlink).toBe(1);
      expect(await readFile(target)).toEqual(Buffer.from(bytes));
    }
    const moduleName = prepared.record.moduleName;
    expect((await readdir(movedStage, { recursive: true })).sort()).toEqual(
      [
        ...Object.keys(prepared.files),
        "Sources",
        `Sources/${moduleName}`,
        `Sources/${moduleName}/Resources`,
      ].sort()
    );
    expect(await readFile(join(moved, journalName))).toEqual(journalBytes);
    expect((await readdir(moved)).sort()).toEqual(
      [journalName, stageName].sort()
    );
    for (const output of [
      input.outputPath,
      join(moved, basename(input.outputPath)),
    ])
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await withMetalPublicationSession(
        { parentPath: moved },
        async () => "released"
      )
    ).toBe("released");
  } finally {
    processBoundary.onHelper = undefined;
    release?.();
    if (helper && helper.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    if (closed) await withDeadline(closed);
    if (pending) await withDeadline(pending);
    await rm(input.directory, { recursive: true, force: true });
  }
});

async function withDeadline<T>(pending: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("The real staging parent-race observation timed out")
            ),
          10_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
