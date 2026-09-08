import {
  generateMetalPackage,
  type GeneratedMetalPackage,
  type MetalProgram,
  type MetalCompute,
  type MetalStage,
} from "./index.js";
import { MetalCompileError } from "./compiler/errors.js";
import { compileMetalLibrary } from "./compiler/metal.js";
import {
  checkedSemanticResult,
  checkedTranslation,
  encodeRequest,
  semanticContract,
  translationContract,
} from "./compiler/protocol.js";
import {
  copyMetalSourceInput,
  resolveMetalSource,
  sha256,
  type MetalSourceInput,
} from "./compiler/source.js";
import { invokeTintWorker } from "./compiler/worker.js";
import {
  validateMetalPackageInterface,
  validateSwiftIdentifier,
} from "./validation.js";
import { namespaceMsl } from "./compiler/msl.js";
import { projectUniforms } from "./compiler/uniforms.js";
import { projectComputeStorage } from "./compiler/storage.js";

export { MetalCompileError } from "./compiler/errors.js";

export type CompileMetalPackageInput = MetalSourceInput & {
  readonly moduleName: string;
  readonly programs: readonly {
    readonly name: string;
    readonly source: string;
    readonly entryPoints:
      | {
          readonly vertex: string;
          readonly fragment: string;
        }
      | { readonly compute: string };
  }[];
  readonly workerPath: string;
  readonly signal?: AbortSignal;
};

export interface CheckedMetalPackage {
  readonly moduleName: string;
  readonly programs: readonly {
    readonly name: string;
    readonly stages: readonly MetalStage[];
  }[];
}

/** Internal compiler adapter. No commands or output directories are published by this API. */
export async function compileMetalPackage(
  input: CompileMetalPackageInput
): Promise<GeneratedMetalPackage> {
  const prepared = await prepareMetalPackage(input);
  const library = await compileMetalLibrary(prepared.sources, prepared.signal);
  try {
    return generateMetalPackage({
      moduleName: prepared.moduleName,
      programs: prepared.programs,
      library,
    });
  } catch (cause) {
    throw new MetalCompileError(
      "validation",
      `Generated Swift interface is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}

/** Internal shader check. Does not run Apple's compiler or generate package files. */
export async function checkMetalPackage(
  input: CompileMetalPackageInput
): Promise<CheckedMetalPackage> {
  const prepared = await prepareMetalPackage(input);
  const stages: readonly MetalStage[] = ["vertex", "fragment", "compute"];
  return {
    moduleName: prepared.moduleName,
    programs: prepared.programs.map((program) => ({
      name: program.name,
      stages: stages.filter((stage) => Object.hasOwn(program.functions, stage)),
    })),
  };
}

interface PreparedMetalPackage {
  readonly moduleName: string;
  readonly programs: readonly MetalProgram[];
  readonly sources: readonly string[];
  readonly signal?: AbortSignal;
}

async function prepareMetalPackage(
  input: CompileMetalPackageInput
): Promise<PreparedMetalPackage> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TypeError("input must be a compiler input record");
    if (Object.hasOwn(input, "modules") === Object.hasOwn(input, "snapshot"))
      throw new TypeError(
        "input must provide exactly one of modules or snapshot"
      );
    validateSwiftIdentifier(input.moduleName, "moduleName");
    if (!Array.isArray(input.programs) || input.programs.length === 0)
      throw new TypeError("programs must be a nonempty array");
    const names = new Set([input.moduleName.toLowerCase()]);
    for (const program of input.programs) {
      if (!program || typeof program !== "object" || Array.isArray(program))
        throw new TypeError("programs must contain program records");
      validateSwiftIdentifier(program.name, "program name");
      const name = program.name.toLowerCase();
      if (names.has(name))
        throw new TypeError(
          "program name collides with the module or another program"
        );
      names.add(name);
    }
  } catch (cause) {
    throw new MetalCompileError(
      "validation",
      `Invalid compiler configuration: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
  for (const program of input.programs) {
    const stages = program.entryPoints;
    if (
      !stages ||
      typeof stages !== "object" ||
      !(
        (Reflect.ownKeys(stages).length === 2 &&
          Object.hasOwn(stages, "vertex") &&
          Object.hasOwn(stages, "fragment") &&
          "vertex" in stages &&
          typeof stages.vertex === "string" &&
          "fragment" in stages &&
          typeof stages.fragment === "string") ||
        (Reflect.ownKeys(stages).length === 1 &&
          Object.hasOwn(stages, "compute") &&
          "compute" in stages &&
          typeof stages.compute === "string")
      )
    ) {
      throw new MetalCompileError(
        "validation",
        "The compiler profile requires exactly one vertex and one fragment entry point, or one compute entry point"
      );
    }
  }
  input = {
    moduleName: input.moduleName,
    workerPath: input.workerPath,
    signal: input.signal,
    programs: input.programs
      .map((program) => ({
        name: program.name,
        source: program.source,
        entryPoints: hasComputeEntry(program.entryPoints)
          ? { compute: program.entryPoints.compute }
          : {
              vertex: program.entryPoints.vertex,
              fragment: program.entryPoints.fragment,
            },
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ...copyMetalSourceInput(input),
  };
  const programs: MetalProgram[] = [];
  const sources: string[] = [];
  for (const program of input.programs) {
    const { authoredStructs, ...capsule } = await resolveMetalSource(
      program.source,
      input
    );
    const selected = hasComputeEntry(program.entryPoints)
      ? [{ stage: "compute", wgsl: program.entryPoints.compute }]
      : [
          { stage: "vertex", wgsl: program.entryPoints.vertex },
          { stage: "fragment", wgsl: program.entryPoints.fragment },
        ];
    const request = {
      schemaVersion: 1,
      contractId: semanticContract,
      ...capsule,
      entryPoints: selected,
      overrideConfiguration: [],
    };
    const requestBytes = encodeRequest(request, "semantic");
    const response = await callWorker(input, requestBytes, "validation");
    const semantics = checkedSemanticResult(response, requestBytes, selected);
    const projected =
      selected[0].stage === "compute"
        ? undefined
        : projectUniforms(semantics, authoredStructs);
    const storage =
      selected[0].stage === "compute"
        ? projectComputeStorage(semantics)
        : undefined;
    if (
      semantics.overrides.length > 0 ||
      semantics.entryPoints.some((entry) => entry.overrides.length > 0)
    ) {
      throw new MetalCompileError(
        "validation",
        "Active overrides are unsupported by the current compiler profile"
      );
    }
    const functions: MetalProgram["functions"] = {};
    let compute: MetalCompute | undefined;
    for (const entry of semantics.entryPoints) {
      const emittedName = `vgpu_${sha256(
        `${input.moduleName}\0${program.name}\0${entry.stage}`
      )}_${entry.stage}`;
      const entryPoint = {
        stage: entry.stage,
        wgsl: entry.wgsl,
        metal: emittedName,
      };
      const bindings =
        entry.stage === "compute"
          ? storage!.bindings
          : projected!.stages[entry.stage];
      const translation = {
        schemaVersion: 1,
        contractId: translationContract,
        source: capsule.source,
        originMap: capsule.originMap,
        entryPoint,
        semanticInterface: entry.semanticInterface,
        overrides: [],
        languageFeatures: [],
        metal: {
          bindingModel: "vgpu-metal-binding-slots-v1",
          immediateDataLayoutModel: "vgpu-metal-immediate-data-layout-v1",
          bindings,
          internalReservations: [
            {
              role: "immediate-data",
              slots: [
                {
                  mode: "direct",
                  resourceClass: "buffer",
                  component: "buffer",
                  index: 30,
                  count: 1,
                },
              ],
            },
          ],
          storageBufferSizes: {
            model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
            immediateDataByteOffset: entry.stage === "fragment" ? 12 : 4,
          },
        },
      };
      const translated = checkedTranslation(
        await callWorker(
          input,
          encodeRequest(translation, "translation"),
          "translation"
        ),
        entryPoint,
        entry.semanticInterface,
        bindings,
        entry.stage === "compute"
          ? {
              workgroupSize: entry.workgroupSize,
              hasRuntimeStorage: storage!.storage.some(
                (binding) => binding.runtimeSized
              ),
            }
          : undefined
      );
      if (entry.stage === "compute")
        compute = {
          workgroupSize: storage!.workgroupSize,
          storage: storage!.storage,
          internalData: translated.internalData,
        };
      const namespace = `${emittedName}_scope`;
      sources.push(namespaceMsl(translated.msl, namespace));
      functions[entry.stage] = `${namespace}::${translated.entryPoint.metal}`;
    }
    programs.push({
      name: program.name,
      functions,
      uniforms: projected?.uniforms,
      compute,
    });
  }
  try {
    validateMetalPackageInterface({ moduleName: input.moduleName, programs });
  } catch (cause) {
    throw new MetalCompileError(
      "validation",
      `Generated Swift interface is invalid: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
  return {
    moduleName: input.moduleName,
    programs,
    sources,
    signal: input.signal,
  };
}

function hasComputeEntry(
  entryPoints: CompileMetalPackageInput["programs"][number]["entryPoints"]
): entryPoints is { readonly compute: string } {
  return Object.hasOwn(entryPoints, "compute");
}

async function callWorker(
  input: CompileMetalPackageInput,
  request: string,
  stage: "validation" | "translation"
): Promise<unknown> {
  try {
    return await invokeTintWorker({
      executable: input.workerPath,
      request,
      signal: input.signal,
    });
  } catch (cause) {
    throw new MetalCompileError(
      stage,
      `Tint compiler process failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}
