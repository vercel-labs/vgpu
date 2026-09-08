import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface MetalPublicationSession {
  readonly parent: { readonly device: string; readonly inode: string };
  readonly capabilities: {
    readonly renameSwap: true;
    readonly renameExclusive: true;
  };
  readonly signal: AbortSignal;
  assertParentUnchanged(): Promise<void>;
}

export interface MetalPublicationSessionInput {
  readonly parentPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

type SessionErrorCode =
  | "busy"
  | "unsafe-parent"
  | "unsupported-filesystem"
  | "parent-changed"
  | "helper-failed"
  | "cleanup-failed"
  | "cancelled";

export class MetalPublicationSessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MetalPublicationSessionError";
  }
}

export class MetalPublicationSessionCleanupError extends MetalPublicationSessionError {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[], readonly recoveryPath?: string) {
    super(
      "cleanup-failed",
      recoveryPath
        ? `Publication helper scratch requires recovery: ${recoveryPath}`
        : "Publication session cleanup also failed",
      {
        cause: new AggregateError(errors, "Publication session failures"),
      }
    );
    this.name = "MetalPublicationSessionCleanupError";
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * Lock-only internal session; this does not authorize or perform publication.
 * The callback must honor session.signal and finish its cleanup before settling.
 * Cancellation does not release its lock while callback work is still running.
 */
export async function withMetalPublicationSession<T>(
  input: MetalPublicationSessionInput,
  callback: (session: MetalPublicationSession) => Promise<T>
): Promise<T> {
  const parentPath = input.parentPath;
  const environment = { ...(input.environment ?? process.env) };
  environment.TMPDIR = resolve(environment.TMPDIR ?? tmpdir());
  if (environment.DEVELOPER_DIR !== undefined)
    environment.DEVELOPER_DIR = resolve(environment.DEVELOPER_DIR);
  const scratchRoot = environment.TMPDIR;
  const signal = input.signal;
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new MetalPublicationSessionError(
        "cancelled",
        "Publication session was cancelled",
        { cause: signal?.reason }
      )
    );
  if (signal?.aborted) cancel();
  controller.signal.throwIfAborted();
  if (process.platform !== "darwin")
    throw new MetalPublicationSessionError(
      "helper-failed",
      "Publication sessions require macOS"
    );
  if (
    typeof parentPath !== "string" ||
    !isAbsolute(parentPath) ||
    resolve(parentPath) !== parentPath ||
    parentPath.includes("\0")
  )
    throw new MetalPublicationSessionError(
      "unsafe-parent",
      "Publication parent must be a normalized absolute directory path"
    );
  signal?.addEventListener("abort", cancel, { once: true });
  let scratch: string | undefined;
  let callbackFailed = false;
  let callbackFailure: unknown;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    scratch = await mkdtemp(join(scratchRoot, "vgpu-publication-helper-"));
    const source = join(scratch, "publication-session.c");
    const executable = join(scratch, "publication-session");
    await copyFile(new URL("./publication-session.c", import.meta.url), source);
    controller.signal.throwIfAborted();
    await compileHelper(source, executable, environment, controller.signal);
    controller.signal.throwIfAborted();
    const child = spawn(
      executable,
      ["vgpu-publication-session/v1", parentPath],
      { env: environment, stdio: ["pipe", "pipe", "pipe"] }
    );
    let spawnError: Error | undefined;
    let ready = false;
    let closing = false;
    const closed = new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => {
        if (ready && !closing)
          controller.abort(
            new MetalPublicationSessionError(
              "helper-failed",
              "Publication helper exited during the active session",
              { cause: spawnError }
            )
          );
        resolve(code);
      });
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let entered = false;
    const cancelStartingHelper = () => {
      if (!entered) child.kill("SIGKILL");
    };
    controller.signal.addEventListener("abort", cancelStartingHelper);
    try {
      const line = await receiveLine(iterator, controller);
      if (line.done)
        throw new MetalPublicationSessionError(
          "helper-failed",
          "Publication helper exited before readiness",
          { cause: spawnError }
        );
      const evidence = readySession(JSON.parse(line.value));
      const session = Object.freeze({
        ...evidence,
        signal: controller.signal,
        async assertParentUnchanged() {
          controller.signal.throwIfAborted();
          child.stdin.write("check\n");
          const line = await receiveLine(iterator, controller);
          if (line.done)
            throw new MetalPublicationSessionError(
              "helper-failed",
              "Publication helper exited during identity check"
            );
          const message = checkedMessage(JSON.parse(line.value));
          if (message.kind !== "checked")
            throw new MetalPublicationSessionError(
              "helper-failed",
              "Invalid publication helper identity response"
            );
        },
      });
      ready = true;
      controller.signal.throwIfAborted();
      entered = true;
      let result: T;
      try {
        result = await callback(session);
      } catch (cause) {
        callbackFailed = true;
        callbackFailure = cause;
        throw cause;
      }
      controller.signal.throwIfAborted();
      await session.assertParentUnchanged();
      return result;
    } finally {
      controller.signal.removeEventListener("abort", cancelStartingHelper);
      closing = true;
      child.stdin.end();
      let forcedShutdown = false;
      const shutdown = setTimeout(() => {
        forcedShutdown = child.kill("SIGKILL");
      }, 1_000);
      const code = await closed.finally(() => clearTimeout(shutdown));
      lines.close();
      if (
        ready &&
        code !== 0 &&
        !(forcedShutdown && controller.signal.aborted)
      ) {
        const failure = new MetalPublicationSessionError(
          "helper-failed",
          "Publication helper exited unexpectedly",
          { cause: spawnError ?? { exitCode: code, signal: child.signalCode } }
        );
        if (callbackFailed)
          throw new MetalPublicationSessionCleanupError([
            callbackFailure,
            failure,
          ]);
        if (!controller.signal.aborted) throw failure;
      }
    }
  } catch (cause) {
    operationFailed = true;
    if (controller.signal.aborted && !callbackFailed)
      operationFailure = controller.signal.reason;
    else if (callbackFailed || cause instanceof MetalPublicationSessionError)
      operationFailure = cause;
    else
      operationFailure = new MetalPublicationSessionError(
        "helper-failed",
        "Publication session could not be established",
        { cause }
      );
    throw operationFailure;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (scratch) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (cause) {
        throw new MetalPublicationSessionCleanupError(
          operationFailed ? [operationFailure, cause] : [cause],
          scratch
        );
      }
    }
  }
}

function receiveLine(
  iterator: AsyncIterator<string>,
  controller: AbortController
): Promise<IteratorResult<string>> {
  const signal = controller.signal;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        controller.abort(
          new MetalPublicationSessionError(
            "helper-failed",
            "Publication helper response timed out"
          )
        ),
      5_000
    );
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    iterator.next().then(
      (line) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) reject(signal.reason);
        else resolve(line);
      },
      (cause) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", aborted);
        reject(cause);
      }
    );
  });
}

function checkedMessage(value: unknown): Record<string, any> {
  const message = value as Record<string, any>;
  if (message?.schemaVersion !== 1)
    throw new MetalPublicationSessionError(
      "helper-failed",
      "Invalid publication helper response"
    );
  if (message.kind === "error") {
    const code: SessionErrorCode = [
      "busy",
      "unsafe-parent",
      "unsupported-filesystem",
      "parent-changed",
    ].includes(message.code)
      ? message.code
      : "helper-failed";
    throw new MetalPublicationSessionError(
      code,
      `Publication helper failed: ${code} (errno ${message.errno})`
    );
  }
  return message;
}

function readySession(
  value: unknown
): Pick<MetalPublicationSession, "parent" | "capabilities"> {
  const message = checkedMessage(value);
  if (
    message.kind !== "ready" ||
    typeof message.parent?.device !== "string" ||
    !/^\d+$/.test(message.parent.device) ||
    typeof message.parent?.inode !== "string" ||
    !/^\d+$/.test(message.parent.inode) ||
    message.capabilities?.renameSwap !== true ||
    message.capabilities?.renameExclusive !== true
  )
    throw new MetalPublicationSessionError(
      "helper-failed",
      "Invalid publication helper readiness"
    );
  return Object.freeze({
    parent: Object.freeze({
      device: message.parent.device,
      inode: message.parent.inode,
    }),
    capabilities: Object.freeze({ renameSwap: true, renameExclusive: true }),
  });
}

function compileHelper(
  source: string,
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    let failure: Error | null | undefined;
    const child = execFile(
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
        maxBuffer: 64 * 1024,
      },
      (error) => {
        failure = error;
      }
    );
    child.once("close", () => {
      if (failure !== null)
        reject(
          new MetalPublicationSessionError(
            "helper-failed",
            "The selected Xcode C compiler could not build the publication helper",
            { cause: failure }
          )
        );
      else resolve();
    });
    child.stdin?.end();
  });
}
