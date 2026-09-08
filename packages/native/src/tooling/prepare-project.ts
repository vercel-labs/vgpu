import { relative, resolve } from "node:path";
import { compileMetalPackage } from "../compile.js";
import { captureToolEnvironment } from "../compiler/environment.js";
import { loadMetalProject, type LoadedMetalProject } from "./project.js";
import { validateMetalProjectOutputBoundary } from "./project-output-boundary.js";
import {
  createMetalOutputRecord,
  metalOutputRecordPath,
  parseMetalOutputRecord,
  type MetalOutputRecord,
} from "./output-record.js";

export interface PrepareMetalProjectInput {
  readonly configurationPath: string;
  readonly workerPath: string;
  readonly signal?: AbortSignal;
  readonly onDependency?: (path: string) => void;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface PreparedMetalProject {
  readonly project: LoadedMetalProject;
  /** Owned mutable byte arrays, not deeply immutable. A publisher must copy and validate before awaiting. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly record: MetalOutputRecord;
}

/** Compile one capture to owned package bytes. Does not stage, publish or authorize replacement. */
export async function prepareMetalProject(
  input: PrepareMetalProjectInput
): Promise<PreparedMetalProject> {
  const { configurationPath, workerPath, signal, onDependency } = input;
  const executable = resolve(workerPath);
  const environment = captureToolEnvironment(input.environment);
  const project = await loadMetalProject({
    configurationPath,
    signal,
    onDependency,
  });
  await validateMetalProjectOutputBoundary({
    configurationPath: project.filePath,
    output: project.configuration.output,
    sourcePaths: project.sourcePaths,
  });
  signal?.throwIfAborted();
  const generated = await compileMetalPackage({
    ...project.compilerInput,
    workerPath: executable,
    signal,
    environment,
  });
  signal?.throwIfAborted();
  const files: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(generated.files).map(([path, bytes]) => [
      path,
      Uint8Array.from(bytes),
    ])
  );
  const recordBytes = createMetalOutputRecord({
    moduleName: project.configuration.moduleName,
    ownerConfiguration: relative(project.outputPath, project.filePath),
    inputFingerprint: project.inputFingerprint,
    files,
  });
  files[metalOutputRecordPath] = Uint8Array.from(recordBytes);
  return Object.freeze({
    project,
    files: Object.freeze(files),
    record: parseMetalOutputRecord(recordBytes),
  });
}
