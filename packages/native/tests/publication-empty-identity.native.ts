import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  onHelper: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));

// Observe real process streams; every byte, callback, and helper response stays unchanged.
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
        boundary.onHelper?.(
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

const workerPath = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("a different empty root installed at the real prepared boundary is rejected without replacing either empty directory", async () => {
  const input = await projectFixture();
  const controller = new AbortController();
  let oldDirectory: FileHandle | undefined;
  let replacementDescriptor: number | undefined;
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
    const oldIdentity = directoryIdentity(
      await oldDirectory.stat({ bigint: true })
    );
    expect(await readdir(input.outputPath)).toEqual([]);
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    const preserved = join(input.directory, "preserved-original-empty");
    expect(dirname(preserved)).not.toBe(dirname(input.outputPath));
    await expect(lstat(preserved)).rejects.toMatchObject({ code: "ENOENT" });
    let preparedMessage: Record<string, any> | undefined;
    let commitReply: Record<string, any> | undefined;
    let replacementIdentity: ReturnType<typeof directoryIdentity> | undefined;
    let observationFailure: unknown;
    let commitCommand: string | undefined;
    let replaced = false;
    let replacedBeforeCommit = false;
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
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((
        chunk: Uint8Array,
        callback: (error?: Error | null) => void
      ) => {
        if (chunk.byteLength < 128) {
          const text = Buffer.from(chunk).toString("utf8");
          if (/^commit-(empty|missing) [a-f0-9]{32} prepared\n$/u.test(text))
            commitCommand = text;
        }
        return write(chunk, callback);
      }) as typeof child.stdin.write;
      let buffered = "";
      // This listener runs synchronously before the driver's prepared-frame continuation.
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          buffered += chunk.toString("utf8");
          if (Buffer.byteLength(buffered) > 64 * 1024)
            throw new Error(
              "Observed helper response exceeded the test frame bound"
            );
          let newline: number;
          while ((newline = buffered.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffered.slice(0, newline)) as Record<
              string,
              any
            >;
            buffered = buffered.slice(newline + 1);
            if (message.kind === "prepared") {
              if (replaced) throw new Error("Unexpected second prepared frame");
              preparedMessage = message;
              replacedBeforeCommit = commitCommand === undefined;
              renameSync(input.outputPath, preserved);
              mkdirSync(input.outputPath, { mode: 0o710 });
              replacementDescriptor = openSync(
                input.outputPath,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW
              );
              replacementIdentity = directoryIdentity(
                fstatSync(replacementDescriptor, { bigint: true })
              );
              replaced = true;
            } else if (message.kind === "commit-result") commitReply = message;
          }
        } catch (cause) {
          observationFailure = cause;
          child.kill("SIGKILL");
        }
      });
    };
    operation = publishPreparedMetalOutput({
      prepared,
      signal: controller.signal,
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );
    const failure = await operation;
    expect(observationFailure).toBeUndefined();
    expect(replaced).toBe(true);
    expect(replacedBeforeCommit).toBe(true);
    expect(commitCommand).toBe(
      `commit-empty ${preparedMessage?.transactionId} prepared\n`
    );
    expect(preparedMessage?.publication).toEqual({
      renameMode: "replace-empty",
      expectedDestination: "empty",
      oldDestination: {
        device: oldIdentity.device.toString(),
        inode: oldIdentity.inode.toString(),
      },
    });
    expect(commitReply).toMatchObject({
      kind: "commit-result",
      phase: "prepared",
      outcome: "not-published",
      code: "conflict",
      errno: osConstants.errno.ESTALE,
    });
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(watchdogFired).toBe(false);
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({
      code: "conflict",
      outcome: "not-published",
      receipt: undefined,
      recoveryPaths: [],
    });
    expect(replacementIdentity?.device).toBe(oldIdentity.device);
    expect(replacementIdentity?.inode).not.toBe(oldIdentity.inode);
    expect(directoryIdentity(await lstat(preserved, { bigint: true }))).toEqual(
      oldIdentity
    );
    expect(
      directoryIdentity(await oldDirectory.stat({ bigint: true }))
    ).toEqual(oldIdentity);
    expect(
      directoryIdentity(await lstat(input.outputPath, { bigint: true }))
    ).toEqual(replacementIdentity);
    expect(
      directoryIdentity(fstatSync(replacementDescriptor!, { bigint: true }))
    ).toEqual(replacementIdentity);
    expect(await readdir(preserved)).toEqual([]);
    expect(await readdir(input.outputPath)).toEqual([]);
    expect(await readdir(dirname(input.outputPath))).toEqual(["AppShaders"]);
  } finally {
    controller.abort(new Error("test cleanup"));
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    if (replacementDescriptor !== undefined) closeSync(replacementDescriptor);
    await oldDirectory?.close();
    boundary.onHelper = undefined;
    await rm(input.directory, { recursive: true, force: true });
  }
});

function directoryIdentity(stat: BigIntStats) {
  if (!stat.isDirectory()) throw new Error("Expected an ordinary directory");
  return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}
