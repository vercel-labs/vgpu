import { dirname, resolve } from "node:path";
import { captureShaderGraph, type ShaderGraphSnapshot } from "@vgpu/wgsl/runtime";
import type { CompileMetalPackageInput } from "../compile.js";
import {
  readMetalConfiguration,
  type LoadedMetalConfiguration,
} from "./configuration.js";
import { fingerprintMetalProject } from "./fingerprint.js";

export type MetalProjectCompilerInput = Pick<
  CompileMetalPackageInput,
  "moduleName" | "programs"
> & {
  readonly snapshot: ShaderGraphSnapshot;
};

export interface LoadedMetalProject extends LoadedMetalConfiguration {
  /** Every logical input, including imported files and distinct importer contexts. */
  readonly sourcePaths: readonly string[];
  readonly compilerInput: MetalProjectCompilerInput;
  readonly inputFingerprint: string;
}

/** Read configuration and capture once. Does not launch compilers or inspect/write outputs. */
export async function loadMetalProject(input: {
  readonly configurationPath: string;
  readonly signal?: AbortSignal;
  readonly onDependency?: (path: string) => void;
}): Promise<LoadedMetalProject> {
  const { configurationPath, signal, onDependency } = input;
  signal?.throwIfAborted();
  const loaded = await readMetalConfiguration(configurationPath);
  signal?.throwIfAborted();
  const configuration = Object.freeze({
    ...loaded.configuration,
    programs: Object.freeze(
      loaded.configuration.programs.map((program) => Object.freeze({
        ...program,
        entryPoints: Object.freeze({ ...program.entryPoints }),
      }))
    ),
  });
  const rootDir = dirname(loaded.filePath);
  const snapshot = await captureShaderGraph({
    rootDir,
    signal,
    onDependency,
    entries: Object.fromEntries(configuration.programs.map((program) => [
      program.name,
      resolve(rootDir, program.source),
    ])),
  });
  const compilerInput = Object.freeze({
    moduleName: configuration.moduleName,
    programs: Object.freeze(configuration.programs
      .slice()
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map((program) => Object.freeze({
        ...program,
        source: snapshot.entries[program.name],
      }))
    ),
    snapshot,
  });
  return Object.freeze({
    ...loaded,
    // Keep configuration.output verbatim. Publication must check its raw path
    // components separately, before normalization can erase a symlink/.. pair.
    configuration,
    sourcePaths: Object.freeze(snapshot.inputs.map((source) => source.physicalPath)),
    compilerInput,
    inputFingerprint: fingerprintMetalProject(compilerInput),
  });
}
