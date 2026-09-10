import { execFile, spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { captureToolEnvironment } from "../compiler/environment.js";
import type { PreparedMetalProject } from "./prepare-project.js";
import { validateMetalProjectOutputBoundary } from "./project-output-boundary.js";
import { readPublicationResponseLines } from "./publication-response-lines.js";
import {
  readMetalPublicationRecovery,
  parseMetalPublicationPlan,
  type InterruptedMetalPublication,
  type MetalPublicationPlan,
} from "./publication-recovery.js";
import {
  metalOutputRecordPath,
  parseMetalOutputRecord,
} from "./output-record.js";
import {
  readOwnedPublicationInspection,
  ownedPublicationApproval,
  validateOwnedPublicationReady,
} from "./publication-owned-inspection.js";

const aggregateLimit = 128 * 1024 * 1024;
const chunkLimit = 64 * 1024;
const recordLimit = 64 * 1024;
const actualJournalName = ".vgpu-native-publication.json";
const journalUpdateName = ".vgpu-native-publication.update.json";
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

interface PreparedPublishingStage extends PreparedMetalPublicationStage {
  readonly publication: MetalPublicationPlan;
}

export class MetalPublicationStagingError extends Error {
  /** Nominal locations that may require inspection; never cleanup authority. */
  readonly recoveryPaths: readonly string[];
  constructor(
    readonly code:
      | "invalid-preparation"
      | "busy"
      | "conflict"
      | "interrupted-transaction"
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

export class MetalPublicationInterruptedError extends MetalPublicationStagingError {
  constructor(
    readonly transaction: InterruptedMetalPublication,
    recoveryPaths: readonly string[]
  ) {
    super(
      "interrupted-transaction",
      `Interrupted publication ${transaction.transactionId} for ${transaction.outputPath}`,
      { recoveryPaths }
    );
    this.name = "MetalPublicationInterruptedError";
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

export type MetalPublicationOutcome = "not-published" | "unknown" | "published";

export interface PublishedMetalPublication {
  readonly schemaVersion: 1;
  readonly kind: "published";
  readonly outcome: "published";
  readonly confirmation: "acknowledged" | "reconciled";
  readonly transactionId: string;
  readonly parent: PreparedMetalPublicationStage["parent"];
  readonly destinationName: string;
  readonly output: PreparedMetalPublicationStage["parent"];
  readonly recordSHA256: string;
  readonly outputPath: string;
}

interface PublicationState {
  outcome: MetalPublicationOutcome;
  prepared?: PreparedMetalPublicationStage;
  publication?: MetalPublicationPlan;
  receipt?: PublishedMetalPublication;
  finalized: boolean;
  recoveryPaths?: readonly string[];
}

export class MetalPublicationError extends MetalPublicationStagingError {
  readonly outcome: MetalPublicationOutcome;
  readonly receipt?: PublishedMetalPublication;
  constructor(state: PublicationState, cause: unknown) {
    const known =
      cause instanceof MetalPublicationStagingError ? cause : undefined;
    const retained =
      state.prepared && !state.finalized
        ? [
            ...(state.outcome === "published" &&
            state.publication?.renameMode !== "swap"
              ? []
              : [state.prepared.stagePath]),
            state.prepared.journalPath,
            ...(state.outcome === "not-published"
              ? []
              : [
                  join(
                    dirname(state.prepared.journalPath),
                    state.prepared.destinationName
                  ),
                ]),
          ]
        : [];
    super(
      known?.code ?? "helper-failed",
      `Metal publication ${state.outcome}: ${
        known?.message ?? "operation failed"
      }`,
      {
        cause,
        recoveryPaths: [
          ...new Set([
            ...(known?.recoveryPaths ?? []),
            ...(state.recoveryPaths ?? []),
            ...retained,
          ]),
        ],
      }
    );
    this.name = "MetalPublicationError";
    this.outcome = state.outcome;
    this.receipt = state.receipt;
  }
}

type StagingOperation<T> = {
  readonly kind: "stage-only";
  readonly callback: (receipt: PreparedMetalPublicationStage) => Promise<T>;
};
type PublishingOperation = {
  readonly kind: "publish-project";
  readonly configurationPath: string;
  readonly state: PublicationState;
};

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
  return runStaging(snapshot, { kind: "stage-only", callback });
}

/** Private publisher for missing, ordinary empty, or verified same-owner outputs. */
export async function publishPreparedMetalOutput(
  input: PreparedMetalPublicationStageInput
): Promise<PublishedMetalPublication> {
  const state: PublicationState = {
    outcome: "not-published",
    finalized: false,
  };
  try {
    const snapshot = snapshotPreparation(input);
    const project = input.prepared.project;
    const boundary = Object.freeze({
      configurationPath: project.filePath,
      output: project.configuration.output,
      sourcePaths: Object.freeze([...project.sourcePaths]),
    });
    const outputPath = join(snapshot.parentPath, snapshot.destinationName);
    const record = parseMetalOutputRecord(snapshot.files[3]!.bytes);
    if (
      typeof boundary.configurationPath !== "string" ||
      !isAbsolute(boundary.configurationPath) ||
      boundary.configurationPath.includes("\0") ||
      Buffer.byteLength(boundary.configurationPath) > 1023 ||
      typeof boundary.output !== "string" ||
      resolve(dirname(boundary.configurationPath), boundary.output) !==
        outputPath ||
      record.ownerConfiguration !==
        relative(outputPath, boundary.configurationPath) ||
      record.inputFingerprint !== project.inputFingerprint
    )
      throw new MetalPublicationStagingError(
        "invalid-preparation",
        "Prepared publication boundary metadata is inconsistent"
      );
    throwIfCancelled(snapshot.signal);
    await validateMetalProjectOutputBoundary(boundary);
    return await runStaging(snapshot, {
      kind: "publish-project",
      configurationPath: boundary.configurationPath,
      state,
    });
  } catch (cause) {
    throw new MetalPublicationError(state, cause);
  }
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

function runStaging<T>(
  snapshot: StagingSnapshot,
  operation: StagingOperation<T>
): Promise<T>;
function runStaging(
  snapshot: StagingSnapshot,
  operation: PublishingOperation
): Promise<PublishedMetalPublication>;
async function runStaging<T>(
  snapshot: StagingSnapshot,
  operation: StagingOperation<T> | PublishingOperation
): Promise<T | PublishedMetalPublication> {
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
  let recoveryFailure: MetalPublicationStagingError | undefined;
  let ioTimedOut = false;
  let configurationHandle: FileHandle | undefined;
  let ownedParent: PreparedMetalPublicationStage["parent"] | undefined;
  let ownedPlan:
    | Extract<MetalPublicationPlan, { renameMode: "swap" }>
    | undefined;
  const executable = join(scratch, "publication-staging");
  try {
    const source = join(scratch, "publication-staging.c");
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
        ...(operation.kind === "publish-project"
          ? ["publish-project", operation.configurationPath]
          : []),
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
    let ready = (lastMessage = await watchProgress(receiveMessage(lines)));
    if (ready.kind === "recovery") {
      const recovery = await readMetalPublicationRecovery(
        ready,
        () => watchProgress(receiveMessage(lines)),
        snapshot.parentPath
      );
      recoveryFailure = recovery.transaction
        ? new MetalPublicationInterruptedError(
            recovery.transaction,
            recovery.recoveryPaths
          )
        : new MetalPublicationStagingError(
            "conflict",
            "Unrecognized publication recovery record",
            { recoveryPaths: recovery.recoveryPaths }
          );
      childInput.end();
      if (
        !(await watchProgress(lines.next())).done ||
        (await watchProgress(closed)) !== 0
      )
        throw new MetalPublicationStagingError(
          "helper-failed",
          "Publication recovery helper did not close cleanly",
          { cause: recoveryFailure, recoveryPaths: recovery.recoveryPaths }
        );
      throw recoveryFailure;
    }
    if (
      ready.kind === "owned-inspection" &&
      operation.kind === "publish-project"
    ) {
      const inspection = await readOwnedPublicationInspection(
        ready,
        () => watchProgress(receiveMessage(lines)),
        snapshot
      );
      ownedParent = inspection.parent;
      throwIfCancelled(snapshot.signal);
      configurationHandle = await open(
        operation.configurationPath,
        constants.O_RDONLY | constants.O_NONBLOCK
      );
      const configurationStat = await configurationHandle.stat({
        bigint: true,
      });
      if (!configurationStat.isFile())
        throw new MetalPublicationStagingError(
          "conflict",
          "Current owner configuration is not a regular file"
        );
      const configuration = Object.freeze({
        device: String(configurationStat.dev),
        inode: String(configurationStat.ino),
      });
      throwIfCancelled(snapshot.signal);
      await watchProgress(
        writeBytes(
          childInput,
          ownedPublicationApproval(inspection, configuration)
        )
      );
      ready = lastMessage = await watchProgress(receiveMessage(lines));
      if (ready.kind !== "ready")
        throw helperResponseError(ready, snapshot.parentPath);
      try {
        ownedPlan = validateOwnedPublicationReady(
          ready,
          inspection,
          configuration
        );
      } catch (cause) {
        throw new MetalPublicationStagingError(
          "helper-failed",
          "Invalid owned publication approval response",
          {
            cause,
            recoveryPaths: [
              join(snapshot.parentPath, stageName),
              join(snapshot.parentPath, actualJournalName),
            ],
          }
        );
      }
      operation.state.publication = ownedPlan;
    }
    if (ready.kind !== "ready")
      throw helperResponseError(ready, snapshot.parentPath);
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
    if (prepared.kind !== "prepared")
      throw helperResponseError(prepared, snapshot.parentPath);
    const receipt = validateReceipt(prepared, snapshot);
    if (operation.kind === "publish-project") {
      operation.state.prepared = receipt;
      const publication = parseMetalPublicationPlan(
        prepared.publication,
        receipt.parent,
        receipt.stage
      );
      if (
        !publication ||
        (ownedPlan
          ? !responseIdentity(receipt.parent, ownedParent!) ||
            !samePublicationPlan(publication, ownedPlan)
          : publication.renameMode === "swap")
      )
        throw new MetalPublicationStagingError(
          "helper-failed",
          "Prepared helper did not confirm the approved publication plan"
        );
      const publishingReceipt: PreparedPublishingStage = Object.freeze({
        ...receipt,
        publication,
      });
      operation.state.prepared = publishingReceipt;
      operation.state.publication = publication;
      throwIfCancelled(snapshot.signal);
      transferActive = false;
      return await commitPublication(
        childInput,
        lines,
        child,
        closed,
        snapshot,
        publishingReceipt,
        operation.state,
        watchProgress
      );
    }
    throwIfCancelled(snapshot.signal);
    transferActive = false;
    let value: T;
    try {
      value = await operation.callback(receipt);
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
      if (!recoveryFailure && lastMessage?.kind !== "error" && replies) {
        try {
          lastMessage = await receiveMessage(replies);
        } catch {
          lastMessage = undefined;
        }
      }
      child?.stdout?.resume();
      if (closed) await closed;
      const retainedFailure =
        recoveryFailure ??
        (lastMessage?.retainedUpdate === true
          ? helperResponseError(lastMessage, snapshot.parentPath)
          : undefined);
      const recoveryPaths = retainedFailure
        ? retainedFailure.recoveryPaths
        : lastMessage?.cleanup === "cleaned"
        ? []
        : [
            join(snapshot.parentPath, stageName),
            join(snapshot.parentPath, actualJournalName),
          ];
      const cancelled = new MetalPublicationStagingError(
        "cancelled",
        "Publication staging was cancelled",
        {
          cause: retainedFailure
            ? new AggregateError(
                [snapshot.signal?.reason, retainedFailure],
                "Publication staging cancellation and retained evidence"
              )
            : snapshot.signal?.reason,
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
    if (
      operation.kind === "publish-project" &&
      operation.state.outcome === "unknown" &&
      operation.state.prepared &&
      operation.state.publication
    ) {
      try {
        await reconcilePublication(
          executable,
          snapshot,
          operation.state.prepared,
          operation.state.publication,
          operation.state
        );
      } catch (reconciliationFailure) {
        operationFailure = new MetalPublicationStagingError(
          operationFailure.code,
          `Publication failed: ${operationFailure.message}; read-only reconciliation also failed`,
          {
            cause: new AggregateError(
              [operationFailure, reconciliationFailure],
              "Publication failure and reconciliation diagnostics"
            ),
            recoveryPaths: operationFailure.recoveryPaths,
          }
        );
      }
    }
    throw operationFailure;
  } finally {
    clearTimeout(cancellationGrace);
    if (cancelTransfer)
      snapshot.signal?.removeEventListener("abort", cancelTransfer);
    const cleanupFailures: unknown[] = [];
    let retainedScratch = false;
    try {
      await replies?.return?.();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    try {
      await configurationHandle?.close();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cause) {
      retainedScratch = true;
      cleanupFailures.push(cause);
    }
    if (cleanupFailures.length)
      throw new MetalPublicationStagingCleanupError(
        operationFailure
          ? [operationFailure, ...cleanupFailures]
          : cleanupFailures,
        [
          ...(operationFailure?.recoveryPaths ?? []),
          ...(retainedScratch ? [scratch] : []),
        ]
      );
  }
}

async function commitPublication(
  input: NodeJS.WritableStream,
  lines: AsyncIterator<string>,
  child: ReturnType<typeof spawn>,
  closed: Promise<number | null>,
  snapshot: StagingSnapshot,
  prepared: PreparedPublishingStage,
  state: PublicationState,
  watchProgress: <U>(operation: Promise<U>) => Promise<U>
): Promise<PublishedMetalPublication> {
  let cancellationGrace: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    cancellationGrace ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
  };
  snapshot.signal?.addEventListener("abort", cancel, { once: true });
  if (snapshot.signal?.aborted) cancel();
  const finish = async (phase: "prepared" | "published") => {
    await watchProgress(
      writeBytes(
        input,
        Buffer.from(`finalize ${snapshot.transactionId} ${phase}\n`)
      )
    );
    const reply = await watchProgress(receiveMessage(lines));
    if (
      reply.kind !== "finalized" ||
      reply.transactionId !== snapshot.transactionId ||
      reply.phase !== phase
    )
      throw helperResponseError(reply, snapshot.parentPath);
    input.end();
    if (
      !(await watchProgress(lines.next())).done ||
      (await watchProgress(closed)) !== 0
    )
      throw new MetalPublicationStagingError(
        "helper-failed",
        "Publication helper did not close cleanly after finalization"
      );
    state.finalized = true;
  };
  try {
    throwIfCancelled(snapshot.signal);
    const commit =
      prepared.publication.renameMode === "excl"
        ? "commit-missing"
        : prepared.publication.renameMode === "replace-empty"
        ? "commit-empty"
        : "commit-owned";
    const command = Buffer.from(
      `${commit} ${snapshot.transactionId} prepared\n`
    );
    // This write can reach the helper even when its callback later fails.
    state.outcome = "unknown";
    await watchProgress(writeBytes(input, command));
    const reply = await watchProgress(receiveMessage(lines));
    if (
      reply.kind !== "commit-result" ||
      reply.transactionId !== snapshot.transactionId ||
      reply.phase !== "prepared"
    )
      throw new MetalPublicationStagingError(
        "helper-failed",
        "Unconfirmed publication commit response"
      );
    if (reply.outcome === "not-published") {
      if (
        Object.keys(reply).length !== 7 ||
        ![
          "conflict",
          "parent-changed",
          "invalid-stage",
          "helper-failed",
        ].includes(reply.code) ||
        !Number.isSafeInteger(reply.errno) ||
        reply.errno < 0
      )
        throw new MetalPublicationStagingError(
          "helper-failed",
          "Invalid publication rejection response"
        );
      state.outcome = "not-published";
      const failure = helperResponseError(reply, snapshot.parentPath);
      try {
        await finish("prepared");
      } catch (cleanupCause) {
        throw new MetalPublicationStagingCleanupError(
          [failure, cleanupCause],
          [prepared.stagePath, prepared.journalPath]
        );
      }
      throw failure;
    }
    if (
      reply.outcome !== "published" ||
      Object.keys(reply).length !== 9 ||
      !responseIdentity(reply.parent, prepared.parent) ||
      reply.destinationName !== prepared.destinationName ||
      !responseIdentity(reply.output, prepared.stage) ||
      reply.recordSHA256 !== prepared.recordSHA256
    )
      throw new MetalPublicationStagingError(
        "helper-failed",
        "Invalid successful publication response"
      );
    state.outcome = "published";
    state.receipt = Object.freeze({
      schemaVersion: 1,
      kind: "published",
      outcome: "published",
      confirmation: "acknowledged",
      transactionId: snapshot.transactionId,
      parent: prepared.parent,
      destinationName: prepared.destinationName,
      output: Object.freeze({
        device: prepared.stage.device,
        inode: prepared.stage.inode,
      }),
      recordSHA256: prepared.recordSHA256,
      outputPath: join(snapshot.parentPath, snapshot.destinationName),
    });
    await finish("published");
    throwIfCancelled(snapshot.signal);
    return state.receipt;
  } catch (cause) {
    if (
      snapshot.signal?.aborted &&
      !(
        cause instanceof MetalPublicationStagingError &&
        cause.code === "cancelled"
      )
    )
      throw new MetalPublicationStagingError(
        "cancelled",
        "Publication was cancelled while retaining commit evidence",
        {
          cause: new AggregateError(
            [snapshot.signal.reason, cause],
            "Publication cancellation and failure"
          ),
          recoveryPaths:
            cause instanceof MetalPublicationStagingError
              ? cause.recoveryPaths
              : [],
        }
      );
    throw cause;
  } finally {
    clearTimeout(cancellationGrace);
    snapshot.signal?.removeEventListener("abort", cancel);
  }
}

/** One read-only attempt, after the original process has closed; never retries commit. */
async function reconcilePublication(
  executable: string,
  snapshot: StagingSnapshot,
  prepared: PreparedMetalPublicationStage,
  publication: MetalPublicationPlan,
  state: PublicationState
): Promise<void> {
  const reconciliationMode =
    publication.renameMode === "swap"
      ? "reconcile-owned"
      : publication.renameMode === "replace-empty"
      ? "reconcile-empty"
      : "reconcile-missing";
  const child = spawn(
    executable,
    [
      "vgpu-publication-staging/v1",
      snapshot.parentPath,
      snapshot.destinationName,
      snapshot.moduleName,
      snapshot.transactionId,
      reconciliationMode,
      prepared.parent.device,
      prepared.parent.inode,
    ],
    { env: snapshot.environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  let spawnError: Error | undefined;
  const closed = new Promise<number | null>((resolveClose) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", resolveClose);
  });
  let timedOut = false;
  // A pre-existing cancellation cannot suppress this independent, finite evidence check.
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 30_000);
  let lines: AsyncIterator<string> | undefined;
  try {
    const input = child.stdin;
    const output = child.stdout;
    if (!input || !output || !child.stderr)
      throw new Error("Publication reconciliation pipes were unavailable");
    input.on("error", () => {});
    child.stderr.resume();
    lines = readPublicationResponseLines(output);
    const header = await receiveMessage(lines);
    if (header.kind !== "reconciliation")
      throw helperResponseError(header, snapshot.parentPath);
    const report = await readMetalPublicationRecovery(
      header,
      () => receiveMessage(lines!),
      snapshot.parentPath,
      "reconciliation"
    );
    state.recoveryPaths = report.recoveryPaths;
    const transaction = report.transaction;
    const evidence = report.prepared;
    if (
      !transaction ||
      transaction.phase !== "prepared" ||
      transaction.transactionId !== prepared.transactionId ||
      !responseIdentity(transaction.parent, prepared.parent) ||
      transaction.destinationName !== prepared.destinationName ||
      transaction.moduleName !== prepared.moduleName ||
      !samePublicationPlan(transaction.publication, publication) ||
      transaction.stage?.name !== prepared.stage.name ||
      transaction.stage.device !== prepared.stage.device ||
      transaction.stage.inode !== prepared.stage.inode ||
      evidence?.recordSHA256 !== prepared.recordSHA256 ||
      evidence.files.length !== prepared.files.length ||
      !evidence.files.every((file, index) => {
        const expected = prepared.files[index]!;
        return (
          file.role === expected.role &&
          file.path === expected.path &&
          file.length === expected.length &&
          file.sha256 === expected.sha256
        );
      })
    )
      throw new Error(
        "Recovery record does not match the original prepared publication"
      );
    const command =
      publication.renameMode === "swap"
        ? `verify-owned ${prepared.transactionId} prepared ${prepared.stage.device} ${prepared.stage.inode} ${publication.oldDestination.device} ${publication.oldDestination.inode}\n`
        : publication.renameMode === "replace-empty"
        ? `verify-empty ${prepared.transactionId} prepared ${prepared.stage.device} ${prepared.stage.inode} ${publication.oldDestination.device} ${publication.oldDestination.inode}\n`
        : `verify-missing ${prepared.transactionId} prepared ${prepared.stage.device} ${prepared.stage.inode}\n`;
    await writeBytes(input, Buffer.from(command));
    for (const [index, file] of prepared.files.entries())
      await writeBytes(
        input,
        Buffer.from(`artifact ${index} ${file.length} ${file.sha256}\n`)
      );
    if (publication.renameMode === "swap") {
      await writeBytes(
        input,
        Buffer.from(
          `old-package ${publication.oldModuleName} ${publication.oldRecordSHA256}\n`
        )
      );
      for (const [index, file] of publication.oldFiles.entries())
        await writeBytes(
          input,
          Buffer.from(`old-artifact ${index} ${file.length} ${file.sha256}\n`)
        );
    }
    const reply = await receiveMessage(lines);
    const published = reply.outcome === "published";
    if (
      reply.kind !== "reconciliation-result" ||
      reply.transactionId !== prepared.transactionId ||
      reply.phase !== "prepared" ||
      (!published && reply.outcome !== "not-published") ||
      Object.keys(reply).length !== 9 ||
      !responseIdentity(reply.parent, prepared.parent) ||
      reply.destinationName !== prepared.destinationName ||
      !responseIdentity(
        published ? reply.output : reply.stage,
        prepared.stage
      ) ||
      reply.recordSHA256 !== prepared.recordSHA256
    )
      throw new Error(
        "Publication reconciliation did not establish a checked outcome"
      );
    // Preserve the proved outcome even if releasing the helper subsequently fails.
    state.outcome = published ? "published" : "not-published";
    if (published)
      state.receipt = Object.freeze({
        schemaVersion: 1,
        kind: "published",
        outcome: "published",
        confirmation: "reconciled",
        transactionId: prepared.transactionId,
        parent: prepared.parent,
        destinationName: prepared.destinationName,
        output: Object.freeze({
          device: prepared.stage.device,
          inode: prepared.stage.inode,
        }),
        recordSHA256: prepared.recordSHA256,
        outputPath: join(snapshot.parentPath, snapshot.destinationName),
      });
    input.end();
    if (!(await lines.next()).done || (await closed) !== 0 || spawnError)
      throw new Error(
        "Publication reconciliation helper did not close cleanly",
        {
          cause: spawnError,
        }
      );
  } catch (cause) {
    throw new MetalPublicationStagingError(
      "helper-failed",
      timedOut
        ? "Read-only publication reconciliation exceeded 30 seconds"
        : "Read-only publication reconciliation could not complete",
      { cause }
    );
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    child.stdout?.resume();
    child.stderr?.resume();
    await closed;
    await lines?.return?.();
  }
}

function samePublicationPlan(
  observed: MetalPublicationPlan | undefined,
  expected: MetalPublicationPlan
): boolean {
  if (
    !observed ||
    observed.renameMode !== expected.renameMode ||
    observed.expectedDestination !== expected.expectedDestination
  )
    return false;
  if (expected.renameMode === "excl") return true;
  if (
    observed.renameMode === "excl" ||
    !responseIdentity(observed.oldDestination, expected.oldDestination)
  )
    return false;
  if (expected.renameMode === "replace-empty")
    return observed.renameMode === "replace-empty";
  return (
    observed.renameMode === "swap" &&
    observed.oldModuleName === expected.oldModuleName &&
    observed.oldRecordSHA256 === expected.oldRecordSHA256 &&
    observed.ownership.ownerConfiguration ===
      expected.ownership.ownerConfiguration &&
    responseIdentity(
      observed.ownership.configuration,
      expected.ownership.configuration
    ) &&
    observed.oldFiles.length === expected.oldFiles.length &&
    observed.oldFiles.every((file, index) => {
      const wanted = expected.oldFiles[index]!;
      return (
        file.role === wanted.role &&
        file.path === wanted.path &&
        file.length === wanted.length &&
        file.sha256 === wanted.sha256
      );
    })
  );
}

function responseIdentity(
  value: any,
  expected: PreparedMetalPublicationStage["parent"]
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 2 &&
    value.device === expected.device &&
    value.inode === expected.inode
  );
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

function helperResponseError(
  message: Record<string, any>,
  parentPath?: string
): MetalPublicationStagingError {
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
    })`,
    {
      recoveryPaths:
        message.retainedUpdate === true && parentPath
          ? [stageName, actualJournalName, journalUpdateName].map((name) =>
              join(parentPath, name)
            )
          : [],
    }
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
