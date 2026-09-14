import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  observe: undefined as
    | ((
        child: import("node:child_process").ChildProcessWithoutNullStreams
      ) => void)
    | undefined,
}));

// Observe the second real publisher; never substitute process replies or filesystem identities.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (
        args[0].endsWith("/publication-staging") &&
        Array.isArray(args[1]) &&
        args[1].includes("publish-project")
      )
        boundary.observe?.(
          child as import("node:child_process").ChildProcessWithoutNullStreams
        );
      return child;
    }) as typeof actual.spawn,
  };
});

import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import { withMetalPublicationSession } from "../src/tooling/publication-session.ts";
import {
  MetalPublicationError,
  publishPreparedMetalOutput,
} from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);
const runFile = promisify(execFile);
const processOptions = {
  timeout: 30_000,
  killSignal: "SIGKILL" as const,
  maxBuffer: 1024 * 1024,
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
    )
  ),
};

test("an owned package with a real foreign-device Resources directory is rejected before transaction readiness", async () => {
  const input = await projectFixture();
  const parent = dirname(input.outputPath);
  const resources = join(input.outputPath, "Sources/AppShaders/Resources");
  const originalResources = join(input.directory, "resources-source");
  const image = join(input.directory, "foreign-resources.iso");
  const controller = new AbortController();
  const abortReason = new Error(
    "Stop invalid foreign-device admission before payload transfer or SWAP"
  );
  let attachAttempted = false;
  let mountpointBefore: BigIntStats | undefined;
  let oldDirectory: FileHandle | undefined;
  let mountedDirectory: FileHandle | undefined;
  let helper: import("node:child_process").ChildProcess | undefined;
  let closed:
    | Promise<{ code: number | null; signal: string | null }>
    | undefined;
  let operation: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let watchdogFired = false;
  let observationFailure: unknown;
  let testFailure: unknown;
  let publishers = 0;
  let approvalObserved = false;
  let transferObserved = false;
  let commitObserved = false;
  const frames: Record<string, any>[] = [];
  try {
    const prepared = await prepareMetalProject({
      configurationPath: input.configurationPath,
      workerPath,
    });
    await expect(
      publishPreparedMetalOutput({ prepared })
    ).resolves.toMatchObject({
      outcome: "published",
      confirmation: "acknowledged",
    });
    oldDirectory = await open(
      input.outputPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const oldRoot = await oldDirectory.stat({ bigint: true });
    const parentRoot = await lstat(parent, { bigint: true });
    const recordPath = join(input.outputPath, ".vgpu-native-output.json");
    const recordBefore = await treeEvidence(recordPath);
    expect(oldRoot.dev).toBe(parentRoot.dev);
    expect((await lstat(recordPath, { bigint: true })).dev).toBe(
      parentRoot.dev
    );
    await rename(resources, originalResources);
    await mkdir(resources);
    mountpointBefore = await lstat(resources, { bigint: true });
    await runFile(
      "/usr/bin/hdiutil",
      ["makehybrid", "-udf", "-o", image, originalResources],
      processOptions
    );
    attachAttempted = true;
    await runFile(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-noautoopen",
        "-mountpoint",
        resources,
        "-plist",
        image,
      ],
      processOptions
    );
    const attachment = await findImage(image);
    expect(attachment).toBeDefined();
    expect(attachment?.writeable).toBe(false);
    expect(
      attachment?.["system-entities"].filter(
        (entry) => entry["mount-point"] !== undefined
      )
    ).toEqual([expect.objectContaining({ "mount-point": resources })]);
    mountedDirectory = await open(
      resources,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const mountedRoot = await mountedDirectory.stat({ bigint: true });
    expect(mountedRoot.isDirectory()).toBe(true);
    expect(mountedRoot.dev).not.toBe(parentRoot.dev);
    expect(await readdir(resources)).toEqual(["Shaders.metallib"]);
    const mountedLibrary = await lstat(join(resources, "Shaders.metallib"), {
      bigint: true,
    });
    expect(mountedLibrary.isFile()).toBe(true);
    expect(mountedLibrary.nlink).toBe(1n);
    expect(mountedLibrary.dev).toBe(mountedRoot.dev);
    for (const [path, bytes] of Object.entries(prepared.files)) {
      const metadata = await lstat(join(input.outputPath, path), {
        bigint: true,
      });
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1n);
      expect(metadata.size).toBe(BigInt(bytes.byteLength));
      expect(await readFile(join(input.outputPath, path))).toEqual(
        Buffer.from(bytes)
      );
    }
    await expect(
      verifyMetalProject({ configurationPath: input.configurationPath })
    ).resolves.toMatchObject({
      outputPath: input.outputPath,
      inputFingerprint: prepared.project.inputFingerprint,
    });
    const packageBefore = await treeEvidence(input.outputPath);
    const sourceBefore = await treeEvidence(originalResources);
    expect(await treeEvidence(recordPath)).toEqual(recordBefore);

    boundary.observe = (child) => {
      publishers++;
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
        const text = Buffer.from(chunk).toString("utf8");
        if (text.startsWith("approve-owned ")) approvalObserved = true;
        if (/^file [0-3] /u.test(text)) transferObserved = true;
        if (/^commit-/u.test(text)) commitObserved = true;
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
            const frame = JSON.parse(line) as Record<string, any>;
            frames.push(frame);
            // This listener runs before the facade can send any new payload or commit bytes.
            if (frame.kind === "ready") controller.abort(abortReason);
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
    expect(await closed).toEqual({ code: 1, signal: null });
    expect(publishers).toBe(1);
    expect(observationFailure).toBeUndefined();
    expect(watchdogFired).toBe(false);
    expect(approvalObserved).toBe(true);
    expect(transferObserved).toBe(false);
    expect(commitObserved).toBe(false);
    expect(
      frames.some((frame) => frame.kind === "owned-inspection-complete")
    ).toBe(true);
    expect(
      frames.some(
        (frame) => frame.kind === "prepared" || frame.kind === "commit-result"
      )
    ).toBe(false);
    expect(await treeEvidence(input.outputPath)).toEqual(packageBefore);
    expect(await treeEvidence(originalResources)).toEqual(sourceBefore);
    expect(await treeEvidence(recordPath)).toEqual(recordBefore);
    expect(identity(await oldDirectory.stat({ bigint: true }))).toEqual(
      identity(oldRoot)
    );
    expect(identity(await mountedDirectory.stat({ bigint: true }))).toEqual(
      identity(mountedRoot)
    );
    await expect(
      withMetalPublicationSession(
        { parentPath: parent },
        async () => "released"
      )
    ).resolves.toBe("released");
    expect(failure).toBeInstanceOf(MetalPublicationError);
    expect(failure).toMatchObject({ outcome: "not-published" });
    expect((failure as MetalPublicationError).receipt).toBeUndefined();
    expect(
      frames.find((frame) => frame.kind === "ready"),
      "The real helper admitted an exact foreign-device package and reached readiness; the observer aborted before transfer or SWAP"
    ).toBeUndefined();
    expect(failure).toMatchObject({ code: "conflict", recoveryPaths: [] });
    expect(frames.find((frame) => frame.kind === "error")).toMatchObject({
      code: "conflict",
      errno: osConstants.errno.EXDEV,
    });
    expect(await readdir(parent)).toEqual(["AppShaders"]);
    for (const name of [
      ".vgpu-native-stage",
      ".vgpu-native-publication.json",
      ".vgpu-native-publication.update.json",
    ])
      await expect(lstat(join(parent, name))).rejects.toMatchObject({
        code: "ENOENT",
      });
  } catch (cause) {
    testFailure = cause;
    throw cause;
  } finally {
    controller.abort(abortReason);
    if (helper?.exitCode === null && helper.signalCode === null)
      helper.kill("SIGKILL");
    await closed;
    await operation;
    clearTimeout(watchdog);
    boundary.observe = undefined;
    const handleResults = await Promise.allSettled([
      mountedDirectory?.close(),
      oldDirectory?.close(),
    ]);
    const cleanupFailures: unknown[] = handleResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    try {
      // Even a failed attach may have left a device: rediscover only this exact image.
      if (attachAttempted)
        await detachImage(image, resources, mountpointBefore!);
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
    if (cleanupFailures.length !== 0) {
      throw new AggregateError(
        testFailure === undefined
          ? cleanupFailures
          : [testFailure, ...cleanupFailures],
        `Disposable image cleanup was not confirmed; preserve evidence at ${input.directory}`
      );
    }
    await rm(input.directory, { recursive: true, force: true });
  }
});

interface AttachedImage {
  "image-path": string;
  writeable: boolean;
  "system-entities": { "dev-entry": string; "mount-point"?: string }[];
}

async function findImage(path: string): Promise<AttachedImage | undefined> {
  const info = await runFile(
    "/usr/bin/hdiutil",
    ["info", "-plist"],
    processOptions
  );
  const conversion = runFile(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    processOptions
  );
  conversion.child.stdin?.end(info.stdout);
  const result = JSON.parse((await conversion).stdout) as {
    images?: AttachedImage[];
  };
  if (!Array.isArray(result.images))
    throw new Error("Invalid attached-image inventory");
  const matches = result.images.filter((image) => image["image-path"] === path);
  if (matches.length > 1)
    throw new Error("Ambiguous disposable image attachment");
  return matches[0];
}

async function detachImage(
  image: string,
  mountpoint: string,
  original: BigIntStats
): Promise<void> {
  const attached = await findImage(image);
  if (attached) {
    if (
      !Array.isArray(attached["system-entities"]) ||
      attached["system-entities"].length === 0
    )
      throw new Error("Cannot identify the disposable image device");
    const devices = new Set<string>();
    for (const entity of attached["system-entities"]) {
      const device = /^\/dev\/(disk\d+)(?:s\d+)*$/u.exec(entity["dev-entry"]);
      if (
        !device ||
        (entity["mount-point"] !== undefined &&
          entity["mount-point"] !== mountpoint)
      )
        throw new Error("Unexpected disposable image device or mountpoint");
      devices.add(`/dev/${device[1]}`);
    }
    if (devices.size !== 1)
      throw new Error("Ambiguous disposable image device");
    await runFile(
      "/usr/bin/hdiutil",
      ["detach", [...devices][0]!],
      processOptions
    );
    if (await findImage(image))
      throw new Error("Disposable image is still attached");
  }
  const remaining = await lstat(mountpoint, { bigint: true }).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
      return undefined;
    }
  );
  if (
    remaining &&
    (remaining.dev !== original.dev || remaining.ino !== original.ino)
  )
    throw new Error("The original unmounted directory was not restored");
}

function identity(stat: BigIntStats) {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    links: stat.nlink,
  };
}

async function treeEvidence(root: string): Promise<unknown> {
  const stat = await lstat(root, { bigint: true });
  if (stat.isDirectory())
    return {
      ...identity(stat),
      children: await Promise.all(
        (await readdir(root))
          .sort()
          .map(async (name) => [name, await treeEvidence(join(root, name))])
      ),
    };
  if (!stat.isFile()) throw new Error("Unexpected nonordinary package entry");
  return { ...identity(stat), size: stat.size, bytes: await readFile(root) };
}
