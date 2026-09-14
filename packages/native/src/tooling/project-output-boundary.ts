import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve, sep } from "node:path";
import {
  MetalOutputBoundaryError,
  validateMetalOutputBoundary,
} from "./output-boundary.js";

export interface MetalProjectOutputBoundaryInput {
  readonly configurationPath: string;
  /** The original, unnormalized configuration.output value. */
  readonly output: string;
  /** Publication supplies every captured input. Read-only artifact inspection may omit them. */
  readonly sourcePaths: readonly string[];
}

/** Read-only path preflight; neither ownership nor permission to publish. */
export async function validateMetalProjectOutputBoundary(
  input: MetalProjectOutputBoundaryInput
): Promise<string> {
  const configurationPath = input.configurationPath;
  const output = input.output;
  const sourcePaths = [...input.sourcePaths];
  const directory = dirname(configurationPath);
  const outputPath = resolve(directory, output);
  try {
    if (
      !isAbsolute(configurationPath) ||
      resolve(configurationPath) !== configurationPath ||
      output.length === 0 ||
      isAbsolute(output) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(output) ||
      /[\\\u0000-\u001f\u007f]/u.test(output) ||
      /[\uD800-\uDFFF]/u.test(output)
    ) {
      throw new MetalOutputBoundaryError(
        outputPath,
        "Use an absolute normalized configuration path and its original relative output value with forward slashes"
      );
    }
    const root = parse(directory).root;
    let current = root;
    for (const component of [
      ...directory.slice(root.length).split(sep),
      ...output.split("/"),
    ]) {
      current = resolve(current, component);
      const entry = await lstat(current).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw cause;
      });
      if (entry && !entry.isDirectory()) {
        throw new MetalOutputBoundaryError(
          outputPath,
          "Every original output component must be a directory, not a symlink or another file type"
        );
      }
    }
    await validateMetalOutputBoundary({
      configurationPath,
      outputPath,
      sourcePaths,
    });
    return outputPath;
  } catch (cause) {
    if (cause instanceof MetalOutputBoundaryError) throw cause;
    throw new MetalOutputBoundaryError(
      outputPath,
      "Original output path could not be inspected",
      { cause }
    );
  }
}
