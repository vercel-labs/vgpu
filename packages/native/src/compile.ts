import { generateMetalPackage, type GeneratedMetalPackage } from "./index.js";
import { MetalCompileError } from "./compiler/errors.js";
import { compileMetalLibrary } from "./compiler/metal.js";
import {
  checkedSemanticResult,
  checkedTranslation,
  encodeRequest,
  semanticContract,
  translationContract,
} from "./compiler/protocol.js";
import { resolveMetalSource, sha256 } from "./compiler/source.js";
import { invokeTintWorker } from "./compiler/worker.js";
import { validateSwiftIdentifier } from "./validation.js";
import { namespaceMsl } from "./compiler/msl.js";
import { projectUniforms } from "./compiler/uniforms.js";

export { MetalCompileError } from "./compiler/errors.js";

export interface CompileMetalPackageInput {
  readonly moduleName: string;
  readonly programs: readonly {
    readonly name: string;
    readonly source: string;
    readonly entryPoints: {
      readonly vertex: string;
      readonly fragment: string;
    };
  }[];
  readonly modules: Readonly<Record<string, string>>;
  readonly workerPath: string;
  readonly signal?: AbortSignal;
}

/** Internal compiler adapter. No commands or output directories are published by this API. */
export async function compileMetalPackage(
  input: CompileMetalPackageInput
): Promise<GeneratedMetalPackage> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TypeError("input must be a compiler input record");
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
      Reflect.ownKeys(stages).length !== 2 ||
      !Object.hasOwn(stages, "vertex") ||
      !Object.hasOwn(stages, "fragment") ||
      typeof stages.vertex !== "string" ||
      typeof stages.fragment !== "string"
    ) {
      throw new MetalCompileError(
        "validation",
        "The compiler profile requires exactly one vertex and one fragment entry point"
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
        entryPoints: {
          vertex: program.entryPoints.vertex,
          fragment: program.entryPoints.fragment,
        },
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    modules: Object.assign(Object.create(null), input.modules),
  };
  const programs = [];
  const sources: string[] = [];
  for (const program of input.programs) {
    const { authoredStructs, ...capsule } = await resolveMetalSource(
      program.source,
      input.modules
    );
    const selected = ["vertex", "fragment"].map((stage) => ({
      stage,
      wgsl: program.entryPoints[stage as "vertex" | "fragment"],
    }));
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
    const projected = projectUniforms(semantics, authoredStructs);
    if (
      semantics.overrides.length > 0 ||
      semantics.entryPoints.some((entry) => entry.overrides.length > 0)
    ) {
      throw new MetalCompileError(
        "validation",
        "Active overrides are unsupported by the current render profile"
      );
    }
    const functions: { vertex?: string; fragment?: string } = {};
    for (const entry of semantics.entryPoints) {
      const emittedName = `vgpu_${sha256(
        `${input.moduleName}\0${program.name}\0${entry.stage}`
      )}_${entry.stage}`;
      const entryPoint = {
        stage: entry.stage,
        wgsl: entry.wgsl,
        metal: emittedName,
      };
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
          bindings: projected.stages[entry.stage],
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
        projected.stages[entry.stage]
      );
      const namespace = `${emittedName}_scope`;
      sources.push(namespaceMsl(translated.msl, namespace));
      functions[entry.stage] = `${namespace}::${translated.entryPoint.metal}`;
    }
    programs.push({
      name: program.name,
      functions,
      uniforms: projected.uniforms,
    });
  }
  const library = await compileMetalLibrary(sources, input.signal);
  try {
    return generateMetalPackage({
      moduleName: input.moduleName,
      programs,
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
