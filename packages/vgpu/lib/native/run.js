import { NativeUsageError, parseNativeArguments } from "./arguments.js";

export async function runNative(args) {
  try {
    const parsed = parseNativeArguments(args, process.cwd());
    if (parsed.kind === "help")
      return { code: 0, stdout: help(parsed.command) };
    if (!/^22\.\d+\.\d+$/u.test(process.versions.node)) {
      throw new Error(
        `Native execution requires stable Node.js 22; found ${process.versions.node}.`
      );
    }
    const { kind, ...operation } = parsed;
    return await execute(operation);
  } catch (error) {
    return failure(error, error instanceof NativeUsageError ? 2 : 1);
  }
}

async function execute(operation) {
  // Install handlers only for execution, keep them through companion cleanup,
  // and leave any pre-existing process listeners in place.
  const controller = new AbortController();
  let interruptedCode;
  const interrupt = (signal, code) => {
    if (controller.signal.aborted) return;
    interruptedCode = code;
    controller.abort(new Error(`Native command interrupted by ${signal}.`));
  };
  const onInterrupt = () => interrupt("SIGINT", 130);
  const onTerminate = () => interrupt("SIGTERM", 143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const companion = await import(resolveCompanion());
    controller.signal.throwIfAborted();
    if (
      companion.nativeCliProtocol !== 1 ||
      typeof companion.runNativeCommand !== "function"
    )
      throw incompatible();
    const result = checkedResult(
      await companion.runNativeCommand({
        ...operation,
        signal: controller.signal,
      })
    );
    return { ...result, code: interruptedCode ?? result.code };
  } catch (error) {
    return failure(error, interruptedCode ?? 1);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

function failure(error, code) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "Native command failed";
  return { code, stderr: `${message}\n` };
}

function checkedResult(result) {
  // Protocol one carries publication/recovery diagnostics in stdout/stderr.
  // Unknown outcome fields require a protocol change, not silent omission.
  const invalid = () =>
    new Error(
      "Invalid @vgpu/native CLI protocol 1 result. Install compatible versions of vgpu and @vgpu/native."
    );
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw invalid();
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== null && prototype !== Object.prototype) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(result);
  for (const key of Reflect.ownKeys(fields)) {
    if (
      !["code", "stdout", "stderr"].includes(key) ||
      !("value" in fields[key])
    )
      throw invalid();
  }
  const code = fields.code?.value;
  if (code !== 0 && code !== 1) throw invalid();
  const snapshot = { code };
  for (const key of ["stdout", "stderr"]) {
    if (!Object.hasOwn(fields, key)) continue;
    if (typeof fields[key].value !== "string") throw invalid();
    snapshot[key] = fields[key].value;
  }
  return snapshot;
}

function resolveCompanion() {
  try {
    return import.meta.resolve("@vgpu/native/cli");
  } catch (cause) {
    if (cause.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        "The optional @vgpu/native companion is not installed. Run: npm install --save-dev vgpu @vgpu/native",
        { cause }
      );
    }
    if (cause.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") throw incompatible();
    throw cause;
  }
}

function incompatible() {
  return new Error(
    "Incompatible @vgpu/native companion: CLI protocol 1 is required. Install compatible versions of vgpu and @vgpu/native."
  );
}

function help(command) {
  if (command) {
    return `Usage: vgpu native ${command}${
      command === "doctor" ? "" : " [--config <file>]"
    } [--help]\n`;
  }
  return `Usage: vgpu native <command> [options]

Commands:
  doctor                    Check the native Metal build tools
  check [--config <file>]    Validate the configured shaders
  build [--config <file>]    Generate the owned Swift package
  verify [--config <file>]   Verify package integrity and current inputs

Project commands default to ./vgpu.native.json without searching ancestors.
Native execution requires the optional @vgpu/native companion and Node.js 22.
`;
}
