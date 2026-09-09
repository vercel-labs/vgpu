import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const journalName = ".vgpu-native-publication.json";
const updateName = ".vgpu-native-publication.update.json";
const stageName = ".vgpu-native-stage";
const transactionId = "0123456789abcdef0123456789abcdef";
const firstFiles = [
  { path: "Package.swift", bytes: Buffer.from("manifest payload") },
  {
    path: "Sources/AppShaders/Shaders.generated.swift",
    bytes: Buffer.from("generated Swift payload"),
  },
  {
    path: "Sources/AppShaders/Resources/Shaders.metallib",
    bytes: Buffer.from("compiled library payload"),
  },
] as const;

test("the real staging helper rejects an output-record frame above 64 KiB before creating its file", async () => {
  await withStagingHelper(async (helper) => {
    for (const [index, file] of firstFiles.entries()) {
      await helper.send(fileHeader(index, file.bytes));
      await helper.send(file.bytes);
    }
    await helper.send(fileHeader(3, Buffer.alloc(64 * 1024 + 1)));
    helper.end();

    expect(await helper.receive()).toMatchObject({
      schemaVersion: 1,
      kind: "error",
      code: "invalid-transfer",
    });
    expect(await helper.exited).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
      spawnError: undefined,
    });
    await expect(
      lstat(join(helper.stage, ".vgpu-native-output.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });

    const journal = JSON.parse(await readFile(helper.journal, "utf8"));
    const stageIdentity = await lstat(helper.stage, { bigint: true });
    expect(journal).toMatchObject({
      schemaVersion: 1,
      phase: "staging",
      transactionId,
      destinationName: "AppShaders",
      stage: {
        name: stageName,
        device: stageIdentity.dev.toString(),
        inode: stageIdentity.ino.toString(),
      },
    });
    for (const file of firstFiles)
      expect(await readFile(join(helper.stage, file.path))).toEqual(file.bytes);
    expect((await readdir(helper.parent)).sort()).toEqual(
      [journalName, stageName].sort()
    );
  });
});

test("the real staging helper accepts an output-record frame of exactly 64 KiB and finalizes its checked tree", async () => {
  await withStagingHelper(async (helper) => {
    for (const [index, file] of firstFiles.entries()) {
      await helper.send(fileHeader(index, file.bytes));
      await helper.send(file.bytes);
    }
    // Record schema validation belongs to TypeScript; this boundary carries UTF-8 bytes.
    const record = Buffer.alloc(64 * 1024, 0x20);
    record.write("{}");
    await helper.send(fileHeader(3, record));
    await helper.send(record);
    await helper.send(Buffer.from("prepare\n"));

    const hash = createHash("sha256").update(record).digest("hex");
    expect(await helper.receive()).toMatchObject({
      schemaVersion: 1,
      kind: "prepared",
      recordSHA256: hash,
      files: expect.arrayContaining([
        {
          role: "output-record",
          path: ".vgpu-native-output.json",
          length: 64 * 1024,
          sha256: hash,
        },
      ]),
    });
    expect(
      await readFile(join(helper.stage, ".vgpu-native-output.json"))
    ).toEqual(record);

    await helper.send(Buffer.from("finalize\n"));
    expect(await helper.receive()).toEqual({
      schemaVersion: 1,
      kind: "finalized",
    });
    helper.end();
    expect(await helper.exited).toEqual({
      code: 0,
      signal: null,
      timedOut: false,
      spawnError: undefined,
    });
    expect(await readdir(helper.parent)).toEqual([]);
  });
});

test("premature payload EOF removes only the unchanged written prefix and this live transaction's tree", async () => {
  await withStagingHelper(async (helper) => {
    for (const [index, file] of firstFiles.slice(0, 2).entries()) {
      await helper.send(fileHeader(index, file.bytes));
      await helper.send(file.bytes);
    }
    const planned = Buffer.alloc(3 * 64 * 1024, 0x5a);
    await helper.send(fileHeader(2, planned));
    await helper.send(planned.subarray(0, 64 * 1024 + 123));
    helper.end();

    expect(await helper.receive()).toMatchObject({
      schemaVersion: 1,
      kind: "error",
      code: "invalid-transfer",
      cleanup: "cleaned",
    });
    expect(await helper.exited).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
      spawnError: undefined,
    });
    expect(await readdir(helper.parent)).toEqual([]);
  });
});

test("premature EOF preserves the transaction when the persisted prefix changes under the same file identity", async () => {
  await withStagingHelper(async (helper) => {
    for (const [index, file] of firstFiles.slice(0, 2).entries()) {
      await helper.send(fileHeader(index, file.bytes));
      await helper.send(file.bytes);
    }
    const planned = Buffer.alloc(3 * 64 * 1024, 0x5a);
    const prefix = Buffer.from(planned.subarray(0, 64 * 1024));
    await helper.send(fileHeader(2, planned));
    await helper.send(prefix);
    const target = join(helper.stage, firstFiles[2].path);
    await waitForFileSize(target, prefix.byteLength);
    const before = await lstat(target, { bigint: true });
    const editor = await open(target, "r+");
    try {
      prefix[0] = 0x61;
      await editor.write(prefix.subarray(0, 1), 0, 1, 0);
    } finally {
      await editor.close();
    }
    const changed = await lstat(target, { bigint: true });
    expect({
      device: changed.dev,
      inode: changed.ino,
      size: changed.size,
    }).toEqual({
      device: before.dev,
      inode: before.ino,
      size: before.size,
    });
    helper.end();

    expect(await helper.receive()).toMatchObject({
      schemaVersion: 1,
      kind: "error",
      code: "invalid-transfer",
      cleanupCode: "cleanup-failed",
    });
    expect(await helper.exited).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
      spawnError: undefined,
    });
    expect(await readFile(target)).toEqual(prefix);
    for (const file of firstFiles.slice(0, 2))
      expect(await readFile(join(helper.stage, file.path))).toEqual(file.bytes);
    expect(JSON.parse(await readFile(helper.journal, "utf8"))).toMatchObject({
      phase: "staging",
      transactionId,
    });
    expect((await readdir(helper.parent)).sort()).toEqual(
      [journalName, stageName].sort()
    );
  });
});

test("a real short journal update write preserves the partial update and unchanged prior journal", async () => {
  await withStagingHelper(
    async (helper) => {
      const prior = await readFile(helper.journal);
      const priorIdentity = await lstat(helper.journal, { bigint: true });
      expect(prior.byteLength).toBeLessThan(512);
      for (const [index, file] of firstFiles.entries()) {
        await helper.send(fileHeader(index, file.bytes));
        await helper.send(file.bytes);
      }
      const record = Buffer.from("{}");
      await helper.send(fileHeader(3, record));
      await helper.send(record);
      await helper.send(Buffer.from("prepare\n"));

      const response = await helper.receive();
      expect(response).toMatchObject({
        schemaVersion: 1,
        kind: "error",
        code: "helper-failed",
        errno: constants.errno.EFBIG,
      });
      expect(await helper.exited).toEqual({
        code: 1,
        signal: null,
        timedOut: false,
        spawnError: undefined,
      });
      const partial = await readFile(join(helper.parent, updateName));
      expect(partial.byteLength).toBe(512);
      const plannedFiles = [
        ...firstFiles.map((file, index) => ({
          ...file,
          role: ["package-manifest", "swift-source", "metal-library"][index],
        })),
        {
          path: ".vgpu-native-output.json",
          bytes: record,
          role: "output-record",
        },
      ];
      const expectedUpdate = Buffer.from(
        `${JSON.stringify({
          ...JSON.parse(prior.toString("utf8")),
          phase: "prepared",
          recordSHA256: createHash("sha256").update(record).digest("hex"),
          files: plannedFiles.map(({ role, path, bytes }) => ({
            role,
            path,
            length: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          })),
        })}\n`
      );
      expect(expectedUpdate.byteLength).toBeGreaterThan(512);
      expect(partial).toEqual(expectedUpdate.subarray(0, 512));
      expect(() => JSON.parse(partial.toString("utf8"))).toThrow();
      expect(await readFile(helper.journal)).toEqual(prior);
      const current = await lstat(helper.journal, { bigint: true });
      expect({
        device: current.dev,
        inode: current.ino,
        mode: current.mode,
      }).toEqual({
        device: priorIdentity.dev,
        inode: priorIdentity.ino,
        mode: priorIdentity.mode,
      });
      expect(response).toMatchObject({ retainedUpdate: true });
      expect((await readdir(helper.parent)).sort()).toEqual(
        [journalName, updateName, stageName].sort()
      );
      for (const file of firstFiles)
        expect(await readFile(join(helper.stage, file.path))).toEqual(
          file.bytes
        );
    },
    { limitFileSize: true }
  );
});

test("a prior journal changed under the same identity before prepare is rejected without replacement", async () => {
  await withStagingHelper(async (helper) => {
    const prior = await readFile(helper.journal);
    const before = await lstat(helper.journal, { bigint: true });
    const changed = Buffer.from(prior);
    const phaseOffset = changed.indexOf(Buffer.from('"phase":"staging"'));
    expect(phaseOffset).toBeGreaterThanOrEqual(0);
    changed[phaseOffset + Buffer.byteLength('"phase":"')] = 0x78;
    const editor = await open(helper.journal, "r+");
    try {
      await editor.write(changed, 0, changed.byteLength, 0);
    } finally {
      await editor.close();
    }
    const edited = await lstat(helper.journal, { bigint: true });
    expect({
      device: edited.dev,
      inode: edited.ino,
      size: edited.size,
    }).toEqual({
      device: before.dev,
      inode: before.ino,
      size: before.size,
    });
    for (const [index, file] of firstFiles.entries()) {
      await helper.send(fileHeader(index, file.bytes));
      await helper.send(file.bytes);
    }
    const record = Buffer.from("{}");
    await helper.send(fileHeader(3, record));
    await helper.send(record);
    await helper.send(Buffer.from("prepare\n"));

    expect(await helper.receive()).toMatchObject({
      schemaVersion: 1,
      kind: "error",
      code: "helper-failed",
      errno: constants.errno.ESTALE,
    });
    expect(await helper.exited).toEqual({
      code: 1,
      signal: null,
      timedOut: false,
      spawnError: undefined,
    });
    expect(await readFile(helper.journal)).toEqual(changed);
    const after = await lstat(helper.journal, { bigint: true });
    expect({ device: after.dev, inode: after.ino, mode: after.mode }).toEqual({
      device: before.dev,
      inode: before.ino,
      mode: before.mode,
    });
    expect((await readdir(helper.parent)).sort()).toEqual(
      [journalName, stageName].sort()
    );
    for (const file of firstFiles)
      expect(await readFile(join(helper.stage, file.path))).toEqual(file.bytes);
  });
});

test.each(["same-inode edit", "same-byte replacement"] as const)(
  "a prepared journal candidate changed after close is preserved without replacing the prior journal (%s)",
  async (mutation) => {
    await withStagingHelper(
      async (helper) => {
        const prior = await readFile(helper.journal);
        const before = await lstat(helper.journal, { bigint: true });
        for (const [index, file] of firstFiles.entries()) {
          await helper.send(fileHeader(index, file.bytes));
          await helper.send(file.bytes);
        }
        const record = Buffer.from("{}");
        await helper.send(fileHeader(3, record));
        await helper.send(record);
        await helper.send(Buffer.from("prepare\n"));
        await waitForFileSize(helper.updateClosedPath, 7);

        const updatePath = join(helper.parent, updateName);
        const candidate = await readFile(updatePath);
        const originalCandidate = await lstat(updatePath, { bigint: true });
        const changed = Buffer.from(candidate);
        if (mutation === "same-inode edit") {
          const phaseOffset = changed.indexOf(
            Buffer.from('"phase":"prepared"')
          );
          expect(phaseOffset).toBeGreaterThanOrEqual(0);
          changed[phaseOffset + Buffer.byteLength('"phase":"')] = 0x78;
          const editor = await open(updatePath, "r+");
          try {
            await editor.write(changed, 0, changed.byteLength, 0);
          } finally {
            await editor.close();
          }
        } else {
          const replacement = join(helper.parent, "replacement-candidate");
          await writeFile(replacement, changed, { flag: "wx" });
          await rename(replacement, updatePath);
        }
        const edited = await lstat(updatePath, { bigint: true });
        expect({ device: edited.dev, size: edited.size }).toEqual({
          device: originalCandidate.dev,
          size: originalCandidate.size,
        });
        if (mutation === "same-inode edit")
          expect(edited.ino).toBe(originalCandidate.ino);
        else expect(edited.ino).not.toBe(originalCandidate.ino);
        await writeFile(helper.updateResumePath, "resume\n");

        expect(await helper.receive()).toMatchObject({
          schemaVersion: 1,
          kind: "error",
          code: "helper-failed",
          errno: constants.errno.ESTALE,
          retainedUpdate: true,
        });
        expect(await helper.exited).toEqual({
          code: 1,
          signal: null,
          timedOut: false,
          spawnError: undefined,
        });
        expect(await readFile(helper.journal)).toEqual(prior);
        const after = await lstat(helper.journal, { bigint: true });
        expect({
          device: after.dev,
          inode: after.ino,
          mode: after.mode,
        }).toEqual({
          device: before.dev,
          inode: before.ino,
          mode: before.mode,
        });
        expect(await readFile(updatePath)).toEqual(changed);
        const retained = await lstat(updatePath, { bigint: true });
        expect({
          device: retained.dev,
          inode: retained.ino,
          mode: retained.mode,
        }).toEqual({
          device: edited.dev,
          inode: edited.ino,
          mode: edited.mode,
        });
        expect((await readdir(helper.parent)).sort()).toEqual(
          [journalName, updateName, stageName].sort()
        );
      },
      { pausePreparedUpdate: true }
    );
  }
);

async function waitForFileSize(path: string, size: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const actual = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (actual?.size === size) return;
    await delay(5);
  }
  throw new Error(
    "The staging helper did not persist the expected payload prefix"
  );
}

function fileHeader(role: number, bytes: Uint8Array): Buffer {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return Buffer.from(`file ${role} ${bytes.byteLength} ${hash}\n`);
}

interface StagingHelper {
  readonly parent: string;
  readonly stage: string;
  readonly journal: string;
  readonly updateClosedPath: string;
  readonly updateResumePath: string;
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    spawnError: Error | undefined;
  }>;
  send(bytes: Uint8Array): Promise<void>;
  end(): void;
  receive(): Promise<Record<string, unknown>>;
}

async function withStagingHelper(
  callback: (helper: StagingHelper) => Promise<void>,
  options: {
    readonly limitFileSize?: boolean;
    readonly pausePreparedUpdate?: boolean;
  } = {}
): Promise<void> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-staging-protocol-"))
  );
  try {
    const executable = join(root, "publication-staging");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
      )
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
        fileURLToPath(
          new URL("../src/tooling/publication-staging.c", import.meta.url)
        ),
        "-o",
        executable,
      ],
      {
        env: environment,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      }
    );
    let launcher = executable;
    if (options.limitFileSize) {
      launcher = join(root, "publication-file-size-limit");
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
          fileURLToPath(
            new URL("./fixtures/publication-file-size-limit.c", import.meta.url)
          ),
          "-o",
          launcher,
        ],
        {
          env: environment,
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        }
      );
    }
    const updateClosedPath = join(root, "update-closed");
    const updateResumePath = join(root, "update-resume");
    if (options.pausePreparedUpdate) {
      const observer = join(root, "publication-journal-close.dylib");
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
          "-dynamiclib",
          fileURLToPath(
            new URL("./fixtures/publication-journal-close.c", import.meta.url)
          ),
          "-o",
          observer,
        ],
        {
          env: environment,
          timeout: 30_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        }
      );
      environment.DYLD_INSERT_LIBRARIES = observer;
      environment.VGPU_JOURNAL_CLOSED = updateClosedPath;
      environment.VGPU_JOURNAL_RESUME = updateResumePath;
    }
    const parent = join(root, "Generated");
    const child = spawn(
      launcher,
      [
        ...(options.limitFileSize ? [executable] : []),
        "vgpu-publication-staging/v1",
        parent,
        "AppShaders",
        "AppShaders",
        transactionId,
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] }
    );
    let spawnError: Error | undefined;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    const exited: StagingHelper["exited"] = new Promise((resolveExit) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        clearTimeout(deadline);
        resolveExit({ code, signal, timedOut, spawnError });
      });
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    const helper: StagingHelper = {
      parent,
      stage: join(parent, stageName),
      journal: join(parent, journalName),
      updateClosedPath,
      updateResumePath,
      exited,
      send: (bytes) =>
        new Promise((resolveSend, reject) => {
          child.stdin.write(bytes, (error) =>
            error ? reject(error) : resolveSend()
          );
        }),
      end: () => {
        child.stdin.end();
      },
      receive: async () => {
        const reply = await replies.next();
        if (reply.done) {
          const outcome = await exited;
          throw new Error(
            `Staging helper ended without a reply: ${JSON.stringify(outcome)}`
          );
        }
        return JSON.parse(reply.value) as Record<string, unknown>;
      },
    };
    try {
      expect(await helper.receive()).toEqual({
        schemaVersion: 1,
        kind: "ready",
      });
      await callback(helper);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      lines.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
