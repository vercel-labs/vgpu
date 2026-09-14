import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureToolEnvironment } from "./environment.js";

export interface TintWorkerInput {
  executable: string;
  /** Exact serialized JSON sent to the compiler without rewriting its bytes. */
  request: string;
  signal?: AbortSignal;
  /** Optional shorter process deadline; never permits more than 60 seconds. */
  timeoutMs?: number;
  /** Internal host context; captured before asynchronous executable reads. */
  environment?: NodeJS.ProcessEnv;
}

export class TintWorkerError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TintWorkerError";
  }
}

// Trusted vgpu direct-worker build for Tint revision
// 8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca. Digests copied from
// tooling/native-tint-worker/c1-tint-direct-build/provenance/source-lock.json
// build.outputs; callers cannot
// expand this allowlist by supplying an expected digest alongside a binary.
const TRUSTED_WORKERS = new Set([
  "140be4d7a517a5de1d9dcaa188d7a2c71975de5d3fa354e58375ec31af191e7b",
  "066a37e056bca72dd75697fdf36e5a3053bf7a055f8f2af6600d17efc907d2df",
  "448af648d70941a278d627809c9ab65b8ce52e8cb09c9c9fca13d592978cc8eb",
]);

const MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 160 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export async function invokeTintWorker(
  input: TintWorkerInput
): Promise<unknown> {
  throwIfCancelled(input.signal);
  const environment = captureToolEnvironment(input.environment);
  const timeoutMs = input.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TintWorkerError(
      "invalid-timeout",
      "Tint worker timeout must be an integer from 1 to 60000 ms"
    );
  }
  if (
    input.request.length > MAX_REQUEST_BYTES ||
    Buffer.byteLength(input.request, "utf8") > MAX_REQUEST_BYTES
  ) {
    throw new TintWorkerError(
      "request-too-large",
      "Tint worker request exceeds 128 MiB"
    );
  }
  // Unicode mode treats a valid surrogate pair as one non-surrogate code point.
  if (/[\uD800-\uDFFF]/u.test(input.request)) {
    throw new TintWorkerError(
      "invalid-request",
      "Tint worker request must be well-formed Unicode"
    );
  }
  const binary = await readExecutable(input.executable, input.signal).catch(
    (cause: unknown) => {
      throwIfCancelled(input.signal);
      throw new TintWorkerError(
        "executable-unavailable",
        "Tint worker executable could not be read",
        { cause }
      );
    }
  );
  throwIfCancelled(input.signal);
  const digest = createHash("sha256").update(binary).digest("hex");
  if (!TRUSTED_WORKERS.has(digest)) {
    throw new TintWorkerError(
      "untrusted-executable",
      "Tint worker executable does not match a trusted pinned build"
    );
  }
  const scratch = await mkdtemp(join(environment.TMPDIR!, "vgpu-tint-worker-"));
  try {
    // Execute these authenticated bytes, not a path that could be replaced
    // between verification and spawn. The directory is private to this call.
    const executable = join(scratch, "worker");
    await writeFile(executable, binary, { flag: "wx", mode: 0o500 });
    throwIfCancelled(input.signal);
    return await runWorker(
      executable,
      input.request,
      input.signal,
      timeoutMs,
      environment
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function runWorker(
  executable: string,
  request: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  environment: Readonly<NodeJS.ProcessEnv>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Hashing the executable is insufficient if inherited loader options can
    // inject a library or redirect its dependencies before main() runs.
    const env = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !name.startsWith("DYLD_") && !name.startsWith("LD_")
      )
    );
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: TintWorkerError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: TintWorkerError) => {
      failure ??= reason;
      if (!killTimer && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      }
    };
    const abort = () =>
      terminate(
        new TintWorkerError("cancelled", "Tint worker invocation was cancelled")
      );
    const timer = setTimeout(
      () =>
        terminate(
          new TintWorkerError(
            "timed-out",
            `Tint worker timed out after ${timeoutMs} ms`
          )
        ),
      timeoutMs
    );
    timer.unref();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(
          new TintWorkerError(
            "output-too-large",
            "Tint worker stdout exceeds 160 MiB"
          )
        );
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate(
          new TintWorkerError(
            "output-too-large",
            "Tint worker stderr exceeds 64 KiB"
          )
        );
      } else {
        stderr.push(chunk);
      }
    });
    child.on("error", (cause) => {
      terminate(
        new TintWorkerError(
          "process-failed",
          "Tint worker process could not run",
          { cause }
        )
      );
    });
    // EPIPE is a handled transport failure; it must neither escape as an
    // uncaught stream error nor permit acceptance before the child closes.
    const ioFailure = (cause: Error) => {
      terminate(
        new TintWorkerError("io-failed", "Tint worker pipe failed", { cause })
      );
    };
    child.stdin.on("error", ioFailure);
    child.stdout.on("error", ioFailure);
    child.stderr.on("error", ioFailure);
    child.on("close", (status, closeSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      try {
        throwIfCancelled(signal);
        if (failure) throw failure;
        if (closeSignal || status !== 0) {
          throw new TintWorkerError(
            "process-failed",
            `Tint worker failed with ${
              closeSignal ? `signal ${closeSignal}` : `exit ${status}`
            }`
          );
        }
        const output = Buffer.concat(stdout);
        const errors = Buffer.concat(stderr);
        if (!isUtf8(output) || !isUtf8(errors)) {
          throw new TintWorkerError(
            "invalid-response",
            "Tint worker output is not valid UTF-8"
          );
        }
        if (errors.length > 0) {
          throw new TintWorkerError(
            "unexpected-stderr",
            "Tint worker emitted unexpected stderr"
          );
        }
        resolve(JSON.parse(output.toString("utf8")));
      } catch (cause) {
        reject(
          cause instanceof TintWorkerError
            ? cause
            : new TintWorkerError(
                "invalid-response",
                "Tint worker did not emit exactly one JSON value",
                { cause }
              )
        );
      }
    });
    try {
      child.stdin.end(request, "utf8");
    } catch (cause) {
      ioFailure(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
}

async function readExecutable(
  executable: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      throw new Error(
        "Compiler path must be a regular file, not a link or device"
      );
    }
    if (metadata.size > MAX_EXECUTABLE_BYTES) {
      throw new Error("Compiler executable exceeds 16 MiB");
    }
    // Read a bounded snapshot from the open descriptor, including a sentinel
    // byte so a file growing after stat cannot bypass the cap.
    const bytes = Buffer.alloc(MAX_EXECUTABLE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      throwIfCancelled(signal);
      const result = await file.read(bytes, length, bytes.length - length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_EXECUTABLE_BYTES) {
      throw new Error("Compiler executable exceeds 16 MiB");
    }
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TintWorkerError(
      "cancelled",
      "Tint worker invocation was cancelled"
    );
  }
}
