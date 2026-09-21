import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { dirname, resolve } from "node:path";
import type { CompileMetalPackageInput } from "../compile.js";
import { validateSwiftIdentifier } from "../validation.js";

export interface MetalConfiguration {
  readonly schemaVersion: 1;
  readonly moduleName: string;
  readonly programs: CompileMetalPackageInput["programs"];
  readonly output: string;
}

export interface LoadedMetalConfiguration {
  readonly filePath: string;
  readonly configuration: MetalConfiguration;
  readonly sourcePaths: readonly string[];
  readonly outputPath: string;
}

export class MetalConfigurationError extends Error {
  constructor(
    readonly code: "invalid-configuration" | "configuration-unavailable",
    readonly filePath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MetalConfigurationError";
  }
}

/** Read project configuration; neither resolves shaders nor creates output. */
export async function readMetalConfiguration(
  filePath: string
): Promise<LoadedMetalConfiguration> {
  filePath = resolve(filePath);
  const directory = dirname(filePath);
  const bytes = await readConfigurationBytes(filePath).catch(
    (cause: unknown) => {
      if (cause instanceof MetalConfigurationError) throw cause;
      throw new MetalConfigurationError(
        "configuration-unavailable",
        filePath,
        "Native configuration file could not be read",
        { cause }
      );
    }
  );
  if (!isUtf8(bytes))
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      "Native configuration must contain valid UTF-8"
    );
  let configuration: MetalConfiguration;
  try {
    configuration = JSON.parse(bytes.toString("utf8")) as MetalConfiguration;
  } catch (cause) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      "Native configuration must contain valid JSON",
      { cause }
    );
  }
  exactKeys(
    configuration,
    ["schemaVersion", "moduleName", "programs", "output"],
    "configuration",
    filePath
  );
  if (configuration.schemaVersion !== 1) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      "Unsupported native configuration schemaVersion; expected 1"
    );
  }
  if (
    !Array.isArray(configuration.programs) ||
    configuration.programs.length === 0
  ) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      "programs must be a nonempty array"
    );
  }
  swiftName(configuration.moduleName, "moduleName", filePath);
  relativePath(configuration.output, "output", filePath);
  const names = new Set([configuration.moduleName.toLowerCase()]);
  for (const program of configuration.programs) {
    exactKeys(program, ["name", "source", "entryPoints"], "program", filePath);
    const entryPoints = program.entryPoints;
    exactKeys(
      entryPoints,
      entryPoints && Object.hasOwn(entryPoints, "compute")
        ? ["compute"]
        : ["vertex", "fragment"],
      "entryPoints",
      filePath
    );
    for (const entry of Object.values(entryPoints)) {
      if (
        typeof entry !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry)
      ) {
        throw new MetalConfigurationError(
          "invalid-configuration",
          filePath,
          "Entry points must be authored WGSL identifiers"
        );
      }
    }
    swiftName(program.name, "program name", filePath);
    relativePath(program.source, "source", filePath);
    const name = program.name.toLowerCase();
    if (names.has(name))
      throw new MetalConfigurationError(
        "invalid-configuration",
        filePath,
        "Program name collides with the module or another program"
      );
    names.add(name);
  }
  return {
    filePath,
    configuration,
    sourcePaths: configuration.programs.map((program) =>
      resolve(directory, program.source)
    ),
    outputPath: resolve(directory, configuration.output),
  };
}

async function readConfigurationBytes(filePath: string): Promise<Buffer> {
  const maximum = 1024 * 1024;
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new MetalConfigurationError(
        "configuration-unavailable",
        filePath,
        "Native configuration must be a regular file"
      );
    if (stat.size > maximum)
      throw new MetalConfigurationError(
        "invalid-configuration",
        filePath,
        "Native configuration exceeds one MiB"
      );
    // Bound the read itself, not just the size observed before another process could append.
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count <= maximum) {
      const result = await handle.read(
        bytes,
        count,
        bytes.length - count,
        null
      );
      if (result.bytesRead === 0) return bytes.subarray(0, count);
      count += result.bytesRead;
    }
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      "Native configuration exceeds one MiB"
    );
  } finally {
    await handle.close();
  }
}

function relativePath(value: unknown, label: string, filePath: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value)
  ) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      `${label} must be a configuration-relative path using forward slashes`
    );
  }
}

function swiftName(value: string, label: string, filePath: string): void {
  try {
    validateSwiftIdentifier(value, label);
  } catch (cause) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      cause instanceof Error ? cause.message : String(cause),
      { cause }
    );
  }
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
  filePath: string
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new MetalConfigurationError(
      "invalid-configuration",
      filePath,
      `${label} requires exactly these fields: ${keys.join(", ")}`
    );
  }
}
