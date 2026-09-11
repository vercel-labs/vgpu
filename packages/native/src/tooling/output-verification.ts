import { lstat, open, opendir, stat } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import {
  metalOutputRecordPath,
  parseMetalOutputRecord,
  type MetalOutputRecord,
} from "./output-record.js";
import { validateMetalOutputBoundary } from "./output-boundary.js";

export interface MetalOutputVerificationInput {
  readonly outputPath: string;
  readonly configurationPath: string;
  readonly signal?: AbortSignal;
}

export class MetalOutputVerificationError extends Error {
  constructor(
    readonly code: "invalid-output" | "output-owner-mismatch" | "cancelled",
    readonly outputPath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MetalOutputVerificationError";
  }
}

/** Read-only artifact integrity inspection; freshness and publication are separate checks. */
export async function verifyMetalOutput(
  input: MetalOutputVerificationInput
): Promise<MetalOutputRecord> {
  const { outputPath, configurationPath, signal } = input;
  try {
    signal?.throwIfAborted();
    await validateMetalOutputBoundary({
      outputPath,
      configurationPath,
      sourcePaths: [],
    });
    signal?.throwIfAborted();
    const observations = new Map<string, BigIntStats>();
    const recordChunks: Buffer[] = [];
    const recordPath = join(outputPath, metalOutputRecordPath);
    observations.set(
      recordPath,
      await readRegularFile(
        recordPath,
        (bytes) => recordChunks.push(Buffer.from(bytes)),
        signal,
        64 * 1024
      )
    );
    const record = parseMetalOutputRecord(Buffer.concat(recordChunks));
    const owner = await stat(join(outputPath, record.ownerConfiguration), {
      bigint: true,
    });
    const expected = await stat(configurationPath, { bigint: true });
    if (
      !owner.isFile() ||
      !expected.isFile() ||
      owner.dev !== expected.dev ||
      owner.ino !== expected.ino
    )
      throw new MetalOutputVerificationError(
        "output-owner-mismatch",
        outputPath,
        "Generated output belongs to another configuration"
      );
    await inspectTree(
      outputPath,
      [metalOutputRecordPath, ...record.files.map((file) => file.path)],
      observations,
      signal
    );
    for (const file of record.files) {
      const hash = createHash("sha256");
      const path = join(outputPath, file.path);
      observations.set(
        path,
        await readRegularFile(
          path,
          (bytes) => {
            hash.update(bytes);
          },
          signal
        )
      );
      if (hash.digest("hex") !== file.sha256)
        throw new Error(`Generated file has changed: ${file.path}`);
    }
    for (const [path, observation] of observations) {
      signal?.throwIfAborted();
      if (!sameObservation(observation, await lstat(path, { bigint: true })))
        throw new Error(`Generated file changed during verification: ${path}`);
    }
    signal?.throwIfAborted();
    return record;
  } catch (cause) {
    if (signal?.aborted)
      throw new MetalOutputVerificationError(
        "cancelled",
        outputPath,
        "Output verification was cancelled",
        { cause }
      );
    if (cause instanceof MetalOutputVerificationError) throw cause;
    throw new MetalOutputVerificationError(
      "invalid-output",
      outputPath,
      cause instanceof Error ? cause.message : "Output could not be verified",
      { cause }
    );
  }
}

async function readRegularFile(
  path: string,
  onChunk: (bytes: Buffer) => void,
  signal?: AbortSignal,
  maximum = Number.MAX_SAFE_INTEGER
): Promise<BigIntStats> {
  signal?.throwIfAborted();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (!info.isFile() || info.nlink !== 1n)
      throw new Error(
        `Generated output must use unlinked regular files: ${path}`
      );
    if (info.size <= 0n || info.size > BigInt(maximum))
      throw new Error(
        `Generated file size is outside the supported range: ${path}`
      );
    const size = Number(info.size);
    const buffer = Buffer.alloc(64 * 1024);
    let count = 0;
    while (count <= size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - count + 1),
        null
      );
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > size)
        throw new Error(`Generated file grew during verification: ${path}`);
      onChunk(buffer.subarray(0, bytesRead));
    }
    if (
      count !== size ||
      !sameObservation(info, await handle.stat({ bigint: true })) ||
      !sameObservation(info, await lstat(path, { bigint: true }))
    )
      throw new Error(`Generated file changed during verification: ${path}`);
    signal?.throwIfAborted();
    return info;
  } finally {
    await handle.close();
  }
}

function sameObservation(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function inspectTree(
  outputPath: string,
  files: readonly string[],
  observations: Map<string, BigIntStats>,
  signal?: AbortSignal
): Promise<void> {
  const directories = new Map<string, Map<string, "file" | "directory">>();
  for (const file of files) {
    let path = file;
    let kind: "file" | "directory" = "file";
    while (path !== ".") {
      const parent = dirname(path);
      const entries =
        directories.get(parent) ?? new Map<string, "file" | "directory">();
      entries.set(basename(path), kind);
      directories.set(parent, entries);
      path = parent;
      kind = "directory";
    }
  }
  for (const [path, expected] of directories) {
    signal?.throwIfAborted();
    const absolute = join(outputPath, path);
    const observation = await lstat(absolute, { bigint: true });
    if (!observation.isDirectory())
      throw new Error(
        `Generated directory changed during verification: ${path}`
      );
    observations.set(absolute, observation);
    for await (const entry of await opendir(absolute)) {
      signal?.throwIfAborted();
      const kind = expected.get(entry.name);
      if (!kind || (kind === "file" ? !entry.isFile() : !entry.isDirectory()))
        throw new Error(
          `Unexpected generated directory entry: ${join(path, entry.name)}`
        );
      expected.delete(entry.name);
    }
    if (expected.size !== 0)
      throw new Error(`Missing generated directory entries: ${path}`);
  }
}
