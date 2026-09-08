import { resolve } from "node:path";

const commands = new Set(["doctor", "check", "build", "verify"]);

export class NativeUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeUsageError";
    this.code = 2;
  }
}

/** Parse only: no project reads, companion imports, or platform tool discovery. */
export function parseNativeArguments(args, cwd) {
  if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
    return { kind: "help" };
  }
  const [command, ...rest] = args;
  if (!commands.has(command))
    throw new NativeUsageError(`Unknown native command: ${command}`);
  let help = false;
  let configuration;
  for (let index = 0; index < rest.length; index++) {
    const option = rest[index];
    if (isHelp(option)) {
      help = true;
      continue;
    }
    if (option !== "--config")
      throw new NativeUsageError(
        `Unknown native option or argument: ${option}`
      );
    if (command === "doctor")
      throw new NativeUsageError("native doctor does not accept --config");
    if (configuration !== undefined)
      throw new NativeUsageError("--config may be provided only once");
    configuration = rest[++index];
    if (!configuration || configuration.startsWith("-"))
      throw new NativeUsageError("--config requires a file path");
    if (/[\u0000\uD800-\uDFFF]/u.test(configuration))
      throw new NativeUsageError("--config requires a valid filesystem path");
  }
  if (help) return { kind: "help", command };
  if (command === "doctor") return { kind: "execute", command };
  return {
    kind: "execute",
    command,
    configurationPath: resolve(cwd, configuration ?? "vgpu.native.json"),
  };
}

function isHelp(value) {
  return value === "--help" || value === "-h";
}
