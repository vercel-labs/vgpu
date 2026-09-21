import { checkMetalPackage, type CheckedMetalPackage } from "../compile.js";
import { loadMetalProject } from "./project.js";

export interface CheckMetalProjectInput {
  readonly configurationPath: string;
  /** Internal distribution seam; not a user configuration field. */
  readonly workerPath: string;
  readonly signal?: AbortSignal;
  readonly onDependency?: (path: string) => void;
}

export interface CheckedMetalProject extends CheckedMetalPackage {
  readonly configurationPath: string;
  readonly inputFingerprint: string;
}

/** Validate one captured project without inspecting output or running Apple's compiler. */
export async function checkMetalProject(
  input: CheckMetalProjectInput
): Promise<CheckedMetalProject> {
  const { configurationPath, workerPath, signal, onDependency } = input;
  const project = await loadMetalProject({
    configurationPath,
    signal,
    onDependency,
  });
  const checked = await checkMetalPackage({
    ...project.compilerInput,
    workerPath,
    signal,
  });
  return Object.freeze({
    configurationPath: project.filePath,
    moduleName: checked.moduleName,
    programs: Object.freeze(
      checked.programs.map((program) =>
        Object.freeze({
          ...program,
          stages: Object.freeze([...program.stages]),
        })
      )
    ),
    inputFingerprint: project.inputFingerprint,
  });
}
