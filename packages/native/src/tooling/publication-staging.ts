import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { captureToolEnvironment } from "../compiler/environment.js";
import type { PreparedMetalProject } from "./prepare-project.js";
import { readPublicationResponseLines } from "./publication-response-lines.js";
import {
  metalOutputRecordPath,
  parseMetalOutputRecord,
} from "./output-record.js";

const aggregateLimit = 128 * 1024 * 1024;
const chunkLimit = 64 * 1024;
const recordLimit = 64 * 1024;
const actualJournalName = ".vgpu-native-publication.json";
const stageName = ".vgpu-native-stage";

type ArtifactRole =
  | "package-manifest"
  | "swift-source"
  | "metal-library"
  | "output-record";

export interface MetalPublicationStagedFile {
  readonly role: ArtifactRole;
  readonly path: string;
  readonly length: number;
  readonly sha256: string;
}

export interface PreparedMetalPublicationStage {
  readonly schemaVersion: 1;
  readonly kind: "prepared";
  readonly transactionId: string;
  readonly parent: { readonly device: string; readonly inode: string };
  readonly destinationName: string;
  readonly moduleName: string;
  readonly stage: {
    readonly name: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly recordSHA256: string;
  readonly files: readonly MetalPublicationStagedFile[];
  /** Inspection-only nominal path valid while the callback and helper remain active. */
  readonly stagePath: string;
  /** Inspection-only nominal path valid while the callback and helper remain active. */
  readonly journalPath: string;
}

export interface PreparedMetalPublicationStageInput {
  readonly prepared: PreparedMetalProject;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export class MetalPublicationStagingError extends Error {
  /** Nominal locations that may require inspection; never cleanup authority. */
  readonly recoveryPaths: readonly string[];
  constructor(
    readonly code:
      | "invalid-preparation"
      | "busy"
      | "conflict"
      | "unsafe-parent"
      | "unsafe-name"
      | "unsupported-filesystem"
      | "parent-changed"
      | "helper-failed"
      | "cancelled"
      | "cleanup-failed",
    message: string,
    options?: ErrorOptions & { readonly recoveryPaths?: readonly string[] }
  ) {
    super(message, options);
    this.name = "MetalPublicationStagingError";
    this.recoveryPaths = Object.freeze([...(options?.recoveryPaths ?? [])]);
  }
}

export class MetalPublicationStagingCleanupError extends MetalPublicationStagingError {
  readonly errors: readonly unknown[];
  constructor(errors: readonly unknown[], recoveryPaths: readonly string[]) {
    super("cleanup-failed", "Publication staging cleanup also failed", {
      cause: new AggregateError(errors, "Publication staging failures"),
      recoveryPaths,
    });
    this.name = "MetalPublicationStagingCleanupError";
    this.errors = Object.freeze([...errors]);
  }
}

interface StagingSnapshot {
  readonly parentPath: string;
  readonly destinationName: string;
  readonly moduleName: string;
  readonly transactionId: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
  readonly files: readonly (MetalPublicationStagedFile & {
    readonly bytes: Uint8Array;
  })[];
}

/**
 * Materialize and verify one prepared generation without publishing it.
 * Mutable prepared bytes and caller options are copied and validated synchronously.
 * The callback must cooperate with input.signal and settle before the lock is released.
 */
export function withPreparedMetalPublicationStage<T>(
  input: PreparedMetalPublicationStageInput,
  callback: (receipt: PreparedMetalPublicationStage) => Promise<T>
): Promise<T> {
  if (typeof callback !== "function")
    throw new TypeError("A staging callback is required");
  const snapshot = snapshotPreparation(input);
  return runStaging(snapshot, callback);
}

function snapshotPreparation(
  input: PreparedMetalPublicationStageInput
): StagingSnapshot {
  if (!input || typeof input !== "object")
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "A prepared Metal project is required"
    );
  const prepared = input.prepared;
  const moduleName = prepared?.record?.moduleName;
  const outputPath = prepared?.project?.outputPath;
  if (typeof moduleName !== "string")
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Prepared module metadata is invalid"
    );
  if (
    typeof outputPath !== "string" ||
    !isAbsolute(outputPath) ||
    resolve(outputPath) !== outputPath
  )
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Prepared output path is invalid"
    );
  const destinationName = basename(outputPath);
  validateComponent(destinationName, "destination");
  validateComponent(moduleName, "module");
  const expected = [
    ["package-manifest", "Package.swift"],
    ["swift-source", `Sources/${moduleName}/Shaders.generated.swift`],
    ["metal-library", `Sources/${moduleName}/Resources/Shaders.metallib`],
    ["output-record", metalOutputRecordPath],
  ] as const;
  const keys = Reflect.ownKeys(prepared.files);
  if (
    keys.length !== expected.length ||
    expected.some(([, path]) => !Object.hasOwn(prepared.files, path))
  )
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Publication requires exactly four prepared files"
    );
  let aggregate = 0;
  const files = expected.map(([role, path]) => {
    const source = prepared.files[path];
    if (!(source instanceof Uint8Array) || source.byteLength === 0)
      throw new MetalPublicationStagingError(
        "invalid-preparation",
        `Prepared ${role} bytes are invalid`
      );
    aggregate += source.byteLength;
    if (aggregate > aggregateLimit)
      throw new MetalPublicationStagingError(
        "invalid-preparation",
        "Prepared files exceed the 128 MiB aggregate raw-byte limit"
      );
    const bytes = Uint8Array.from(source);
    return Object.freeze({
      role,
      path,
      length: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  });
  const recordFile = files[3];
  if (recordFile.length > recordLimit)
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Prepared output record exceeds 64 KiB"
    );
  let record;
  try {
    record = parseMetalOutputRecord(recordFile.bytes);
  } catch (cause) {
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Prepared output record is invalid",
      { cause }
    );
  }
  if (
    record.moduleName !== moduleName ||
    record.files.length !== 3 ||
    record.files.some((entry) => {
      const file = files.find(({ path }) => path === entry.path);
      return !file || file.sha256 !== entry.sha256;
    })
  )
    throw new MetalPublicationStagingError(
      "invalid-preparation",
      "Prepared bytes do not match their output record"
    );
  const environment = Object.freeze(
    Object.fromEntries(
      Object.entries(captureToolEnvironment(input.environment)).filter(
        ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
      )
    )
  );
  return Object.freeze({
    parentPath: dirname(outputPath),
    destinationName,
    moduleName,
    transactionId: randomBytes(16).toString("hex"),
    environment,
    signal: input.signal,
    files: Object.freeze(files),
  });
}

function validateComponent(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\/\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value) ||
    [
      actualJournalName,
      ".vgpu-native-publication.update.json",
      stageName,
    ].includes(value)
  )
    throw new MetalPublicationStagingError(
      "unsafe-name",
      `Publication ${label} is not a safe filesystem component`
    );
}

async function runStaging<T>(
  snapshot: StagingSnapshot,
  callback: (receipt: PreparedMetalPublicationStage) => Promise<T>
): Promise<T> {
  throwIfCancelled(snapshot.signal);
  if (process.platform !== "darwin")
    throw new MetalPublicationStagingError(
      "helper-failed",
      "Metal publication staging requires macOS"
    );
  const scratch = await mkdtemp(
    join(snapshot.environment.TMPDIR!, "vgpu-publication-staging-helper-")
  );
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let spawnError: Error | undefined;
  let operationFailure: MetalPublicationStagingError | undefined;
  let cancelTransfer: (() => void) | undefined;
  let cancellationGrace: ReturnType<typeof setTimeout> | undefined;
  let transferActive = true;
  let transferCancelled = false;
  let replies: AsyncIterator<string> | undefined;
  let lastMessage: Record<string, any> | undefined;
  let ioTimedOut = false;
  try {
    const source = join(scratch, "publication-staging.c");
    const executable = join(scratch, "publication-staging");
    await copyFile(new URL("./publication-staging.c", import.meta.url), source);
    throwIfCancelled(snapshot.signal);
    await compileHelper(
      source,
      executable,
      snapshot.environment,
      snapshot.signal
    );
    throwIfCancelled(snapshot.signal);
    child = spawn(
      executable,
      [
        "vgpu-publication-staging/v1",
        snapshot.parentPath,
        snapshot.destinationName,
        snapshot.moduleName,
        snapshot.transactionId,
      ],
      { env: snapshot.environment, stdio: ["pipe", "pipe", "pipe"] }
    );
    closed = new Promise<number | null>((resolveClose) => {
      child!.once("error", (error) => {
        spawnError = error;
      });
      child!.once("close", resolveClose);
    });
    const childInput = child.stdin;
    const childOutput = child.stdout;
    const childError = child.stderr;
    if (!childInput || !childOutput || !childError)
      throw new MetalPublicationStagingError(
        "helper-failed",
        "Publication staging helper pipes were unavailable"
      );
    childInput.on("error", () => {});
    childError.resume();
    const watchProgress = async <U>(operation: Promise<U>): Promise<U> => {
      const deadline = setTimeout(() => {
        ioTimedOut = true;
        child?.kill("SIGKILL");
      }, 30_000);
      try {
        return await operation;
      } finally {
        clearTimeout(deadline);
      }
    };
    const lines = readPublicationResponseLines(childOutput);
    replies = lines;
    cancelTransfer = () => {
      if (!transferActive || transferCancelled) return;
      transferCancelled = true;
      childInput.end();
      cancellationGrace = setTimeout(() => child?.kill("SIGKILL"), 5_000);
    };
    snapshot.signal?.addEventListener("abort", cancelTransfer, { once: true });
    if (snapshot.signal?.aborted) cancelTransfer();
    const ready = (lastMessage = await watchProgress(receiveMessage(lines)));
    if (ready.kind !== "ready") throw helperResponseError(ready);
    for (let index = 0; index < snapshot.files.length; index++) {
      throwIfCancelled(snapshot.signal);
      const file = snapshot.files[index]!;
      await watchProgress(
        writeBytes(
          childInput,
          Buffer.from(`file ${index} ${file.length} ${file.sha256}\n`)
        )
      );
      for (
        let offset = 0;
        offset < file.bytes.byteLength;
        offset += chunkLimit
      ) {
        throwIfCancelled(snapshot.signal);
        await watchProgress(
          writeBytes(
            childInput,
            file.bytes.subarray(
              offset,
              Math.min(offset + chunkLimit, file.bytes.byteLength)
            )
          )
        );
      }
    }
    throwIfCancelled(snapshot.signal);
    await watchProgress(writeBytes(childInput, Buffer.from("prepare\n")));
    const prepared = (lastMessage = await watchProgress(receiveMessage(lines)));
    if (prepared.kind !== "prepared") throw helperResponseError(prepared);
    const receipt = validateReceipt(prepared, snapshot);
    throwIfCancelled(snapshot.signal);
    transferActive = false;
    let value: T;
    try {
      value = await callback(receipt);
      throwIfCancelled(snapshot.signal);
    } catch (cause) {
      if (snapshot.signal?.aborted && cause === snapshot.signal.reason)
        cause = new MetalPublicationStagingError(
          "cancelled",
          "Publication staging was cancelled",
          {
            cause: snapshot.signal.reason,
          }
        );
      try {
        await finalize(childInput, lines, child, closed, snapshot.signal);
      } catch (cleanupCause) {
        throw new MetalPublicationStagingCleanupError(
          [cause, cleanupCause],
          [receipt.stagePath, receipt.journalPath]
        );
      }
      throw cause;
    }
    try {
      await finalize(childInput, lines, child, closed, snapshot.signal);
    } catch (cleanupCause) {
      if (snapshot.signal?.aborted)
        throw new MetalPublicationStagingCleanupError(
          [
            new MetalPublicationStagingError(
              "cancelled",
              "Publication staging was cancelled",
              {
                cause: snapshot.signal.reason,
              }
            ),
            cleanupCause,
          ],
          [receipt.stagePath, receipt.journalPath]
        );
      throw new MetalPublicationStagingError(
        cleanupCause instanceof MetalPublicationStagingError
          ? cleanupCause.code
          : "helper-failed",
        "Publication staging finalization failed",
        {
          cause: cleanupCause,
          recoveryPaths: [receipt.stagePath, receipt.journalPath],
        }
      );
    }
    const code = await closed;
    if (spawnError || code !== 0)
      throw new MetalPublicationStagingError(
        "helper-failed",
        `Publication staging helper exited with status ${code}`,
        { cause: spawnError }
      );
    throwIfCancelled(snapshot.signal);
    return value;
  } catch (cause) {
    if (ioTimedOut)
      cause = new MetalPublicationStagingError(
        "helper-failed",
        "Publication staging helper made no I/O progress for 30 seconds",
        {
          cause,
          recoveryPaths: [
            join(snapshot.parentPath, stageName),
            join(snapshot.parentPath, actualJournalName),
          ],
        }
      );
    if (transferCancelled) {
      // No response read is abandoned on abort: consume EOF cleanup evidence once.
      if (lastMessage?.kind !== "error" && replies) {
        try {
          lastMessage = await receiveMessage(replies);
        } catch {
          lastMessage = undefined;
        }
      }
      child?.stdout?.resume();
      if (closed) await closed;
      const recoveryPaths =
        lastMessage?.cleanup === "cleaned"
          ? []
          : [
              join(snapshot.parentPath, stageName),
              join(snapshot.parentPath, actualJournalName),
            ];
      const cancelled = new MetalPublicationStagingError(
        "cancelled",
        "Publication staging was cancelled",
        {
          cause: snapshot.signal?.reason,
          recoveryPaths,
        }
      );
      cause =
        lastMessage?.cleanupCode === "cleanup-failed"
          ? new MetalPublicationStagingCleanupError(
              [
                cancelled,
                helperResponseError({
                  code: "cleanup-failed",
                  errno: lastMessage.cleanupErrno,
                }),
              ],
              recoveryPaths
            )
          : cancelled;
    }
    child?.kill("SIGTERM");
    child?.stdout?.resume();
    if (closed) await closed;
    if (spawnError)
      operationFailure = new MetalPublicationStagingError(
        "helper-failed",
        "Publication staging helper could not be started",
        { cause: spawnError }
      );
    else if (cause instanceof MetalPublicationStagingError)
      operationFailure = cause;
    else
      operationFailure = new MetalPublicationStagingError(
        "helper-failed",
        "Publication staging failed",
        { cause }
      );
    throw operationFailure;
  } finally {
    clearTimeout(cancellationGrace);
    if (cancelTransfer)
      snapshot.signal?.removeEventListener("abort", cancelTransfer);
    await replies?.return?.();
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cause) {
      throw new MetalPublicationStagingCleanupError(
        operationFailure ? [operationFailure, cause] : [cause],
        [...(operationFailure?.recoveryPaths ?? []), scratch]
      );
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new MetalPublicationStagingError(
      "cancelled",
      "Publication staging was cancelled",
      {
        cause: signal.reason,
      }
    );
}

async function finalize(
  input: NodeJS.WritableStream,
  lines: AsyncIterator<string>,
  child: ReturnType<typeof spawn>,
  closed: Promise<number | null>,
  signal?: AbortSignal
): Promise<void> {
  let deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const cancel = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    await writeBytes(input, Buffer.from("finalize\n"));
    const message = await receiveMessage(lines);
    if (message.kind !== "finalized") throw helperResponseError(message);
    input.end();
    if (!(await lines.next()).done)
      throw new MetalPublicationStagingError(
        "helper-failed",
        "Unexpected response after staging finalization"
      );
    const code = await closed;
    if (code !== 0)
      throw new MetalPublicationStagingError(
        "helper-failed",
        `Publication staging helper exited with status ${code}`
      );
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", cancel);
  }
}

function writeBytes(
  stream: NodeJS.WritableStream,
  bytes: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error?: Error | null) =>
      error ? reject(error) : resolve()
    );
  });
}

async function receiveMessage(
  lines: AsyncIterator<string>
): Promise<Record<string, any>> {
  const line = await lines.next();
  if (line.done || Buffer.byteLength(line.value) > recordLimit)
    throw new MetalPublicationStagingError(
      "helper-failed",
      "Invalid publication staging helper response"
    );
  let message: Record<string, any>;
  try {
    message = JSON.parse(line.value);
  } catch (cause) {
    throw new MetalPublicationStagingError(
      "helper-failed",
      "Invalid publication staging helper response",
      { cause }
    );
  }
  if (message.schemaVersion !== 1)
    throw new MetalPublicationStagingError(
      "helper-failed",
      "Invalid publication staging helper protocol version"
    );
  return message;
}

function helperResponseError(message: Record<string, any>): Error {
  const allowed = new Set([
    "busy",
    "conflict",
    "unsafe-parent",
    "unsafe-name",
    "unsupported-filesystem",
    "parent-changed",
    "cleanup-failed",
  ]);
  const code = allowed.has(message.code) ? message.code : "helper-failed";
  return new MetalPublicationStagingError(
    code,
    `Publication staging helper failed: ${String(message.code)} (errno ${
      message.errno
    })`
  );
}

function validateReceipt(
  message: Record<string, any>,
  snapshot: StagingSnapshot
): PreparedMetalPublicationStage {
  const fileMetadata = snapshot.files.map(({ bytes: _bytes, ...file }) => file);
  if (
    message.transactionId !== snapshot.transactionId ||
    message.destinationName !== snapshot.destinationName ||
    message.moduleName !== snapshot.moduleName ||
    !/^\d+$/u.test(message.parent?.device) ||
    !/^\d+$/u.test(message.parent?.inode) ||
    message.stage?.name !== stageName ||
    !/^\d+$/u.test(message.stage?.device) ||
    !/^\d+$/u.test(message.stage?.inode) ||
    message.recordSHA256 !== snapshot.files[3]!.sha256 ||
    JSON.stringify(message.files) !== JSON.stringify(fileMetadata)
  )
    throw new MetalPublicationStagingError(
      "helper-failed",
      "Invalid prepared staging receipt"
    );
  return Object.freeze({
    schemaVersion: 1,
    kind: "prepared",
    transactionId: snapshot.transactionId,
    parent: Object.freeze({ ...message.parent }),
    destinationName: snapshot.destinationName,
    moduleName: snapshot.moduleName,
    stage: Object.freeze({ ...message.stage }),
    recordSHA256: snapshot.files[3]!.sha256,
    files: Object.freeze(fileMetadata.map((file) => Object.freeze(file))),
    stagePath: join(snapshot.parentPath, stageName),
    journalPath: join(snapshot.parentPath, actualJournalName),
  });
}

function compileHelper(
  source: string,
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let failure: Error | null | undefined;
    const compiler = execFile(
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
        source,
        "-o",
        executable,
      ],
      {
        env: environment,
        signal,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: recordLimit,
      },
      (error) => {
        failure = error;
      }
    );
    compiler.once("close", () => {
      if (signal?.aborted)
        reject(
          new MetalPublicationStagingError(
            "cancelled",
            "Publication staging was cancelled",
            {
              cause: signal.reason,
            }
          )
        );
      else if (failure !== null)
        reject(
          new MetalPublicationStagingError(
            "helper-failed",
            "The selected Xcode C compiler could not build the staging helper",
            { cause: failure }
          )
        );
      else resolvePromise();
    });
    compiler.stdin?.end();
  });
}
