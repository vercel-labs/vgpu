import { lstat, realpath, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export interface MetalOutputBoundaryInput {
  readonly configurationPath: string;
  readonly outputPath: string;
  readonly sourcePaths: readonly string[];
}

export class MetalOutputBoundaryError extends Error {
  readonly code = "unsafe-output";
  constructor(
    readonly outputPath: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "MetalOutputBoundaryError";
  }
}

/**
 * Read-only preflight of normalized absolute paths, not ownership or publication authorization.
 * Project integration must separately inspect the original configuration.output components
 * before normalization can erase a symlink followed by `..`.
 */
export async function validateMetalOutputBoundary(
  input: MetalOutputBoundaryInput
): Promise<void> {
  const output = input.outputPath;
  const inputs = [input.configurationPath, ...input.sourcePaths];
  try {
    await inspectBoundary(output, inputs);
  } catch (cause) {
    if (cause instanceof MetalOutputBoundaryError) throw cause;
    throw new MetalOutputBoundaryError(
      output,
      "Output boundary could not be inspected",
      { cause }
    );
  }
}

async function inspectBoundary(
  output: string,
  inputs: readonly string[]
): Promise<void> {
  if (!isAbsolute(output))
    throw new MetalOutputBoundaryError(
      output,
      "Output must be an absolute resolved path"
    );
  const normalized = resolve(output);
  if (normalized !== output)
    throw new MetalOutputBoundaryError(
      output,
      "Output must already be normalized; inspect original path components before this preflight"
    );
  const root = parse(normalized).root;
  const physicalOutput = await inspectOutput(normalized, output).catch(
    (cause: unknown) => {
      if (cause instanceof MetalOutputBoundaryError) throw cause;
      throw new MetalOutputBoundaryError(
        output,
        "Output path could not be inspected",
        { cause }
      );
    }
  );
  const outputIdentity = await stat(physicalOutput, { bigint: true }).catch(
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new MetalOutputBoundaryError(
        output,
        "Output identity could not be inspected",
        { cause }
      );
    }
  );
  const homeIdentity = await stat(homedir(), { bigint: true });
  if (
    normalized === root ||
    normalized === resolve(homedir()) ||
    physicalOutput === (await realpath(homedir())) ||
    (outputIdentity &&
      (sameIdentity(outputIdentity, homeIdentity) ||
        outputIdentity.dev !==
          (await stat(dirname(physicalOutput), { bigint: true })).dev))
  )
    throw new MetalOutputBoundaryError(
      output,
      "Filesystem roots and the home directory cannot be generated output"
    );
  for (const path of inputs) {
    if (!isAbsolute(path))
      throw new MetalOutputBoundaryError(
        output,
        "Inputs must be absolute resolved paths"
      );
    let physical;
    try {
      physical = await realpath(path);
    } catch (cause) {
      throw new MetalOutputBoundaryError(
        output,
        "Input path could not be inspected",
        { cause }
      );
    }
    if (
      contains(normalized, resolve(path)) ||
      contains(physicalOutput, physical) ||
      (outputIdentity && (await hasAncestorIdentity(physical, outputIdentity)))
    )
      throw new MetalOutputBoundaryError(
        output,
        "Output cannot contain its configuration or any resolved source input"
      );
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hasAncestorIdentity(
  path: string,
  identity: BigIntStats
): Promise<boolean> {
  for (;;) {
    if (sameIdentity(await stat(path, { bigint: true }), identity)) return true;
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
}

async function inspectOutput(
  normalized: string,
  output: string
): Promise<string> {
  const root = parse(normalized).root;
  let current = root;
  const components = normalized.slice(root.length).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const parent = current;
    current = resolve(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        return resolve(await realpath(parent), ...components.slice(index));
      throw new MetalOutputBoundaryError(
        output,
        "Output path could not be inspected",
        { cause }
      );
    }
    if (!stat.isDirectory())
      throw new MetalOutputBoundaryError(
        output,
        "Every existing output component must be a directory, not a symlink or another file type"
      );
  }
  return await realpath(current);
}

function contains(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}
