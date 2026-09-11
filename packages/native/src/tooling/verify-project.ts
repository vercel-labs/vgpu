import { loadMetalProject } from "./project.js";
import { verifyMetalOutput } from "./output-verification.js";
import { validateMetalProjectOutputBoundary } from "./project-output-boundary.js";

export interface VerifyMetalProjectInput {
  readonly configurationPath: string;
  readonly signal?: AbortSignal;
  readonly onDependency?: (path: string) => void;
}

export interface VerifiedMetalProject {
  readonly configurationPath: string;
  readonly outputPath: string;
  readonly moduleName: string;
  readonly inputFingerprint: string;
}

export class MetalProjectVerificationError extends Error {
  readonly code = "stale-output";

  constructor(readonly outputPath: string) {
    super("Generated output is stale; build the Metal package again");
    this.name = "MetalProjectVerificationError";
  }
}

/** Read current source and artifact metadata without invoking compilers or writing output. */
export async function verifyMetalProject(
  input: VerifyMetalProjectInput
): Promise<VerifiedMetalProject> {
  const { configurationPath, signal, onDependency } = input;
  const project = await loadMetalProject({
    configurationPath,
    signal,
    onDependency,
  });
  await validateMetalProjectOutputBoundary({
    configurationPath: project.filePath,
    output: project.configuration.output,
    // Freshness uses captured inputs. Do not reopen them for read-only inspection.
    sourcePaths: [],
  });
  const record = await verifyMetalOutput({
    configurationPath: project.filePath,
    outputPath: project.outputPath,
    signal,
  });
  if (
    record.moduleName !== project.configuration.moduleName ||
    record.inputFingerprint !== project.inputFingerprint
  )
    throw new MetalProjectVerificationError(project.outputPath);
  return Object.freeze({
    configurationPath: project.filePath,
    outputPath: project.outputPath,
    moduleName: record.moduleName,
    inputFingerprint: record.inputFingerprint,
  });
}
