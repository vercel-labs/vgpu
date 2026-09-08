import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import originSchema = require("./schemas/origin-map.json");
import inventoryRequestSchema = require("./schemas/inventory-request.json");
import semanticRequestSchema = require("./schemas/semantic-request.json");
import semanticResponseSchema = require("./schemas/semantic-response.json");
import compilerRequestSchema = require("./schemas/compiler-request.json");
import compilerResponseSchema = require("./schemas/compiler-response.json");
import { MetalCompileError, type CompileStage } from "./errors.js";
import { sha256 } from "./source.js";
import { hasMslEntryDeclaration } from "./msl.js";
import type { MetalBindingMapping } from "./uniforms.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of [
  originSchema,
  inventoryRequestSchema,
  compilerRequestSchema,
  compilerResponseSchema,
  semanticRequestSchema,
  semanticResponseSchema,
])
  ajv.addSchema(schema);

export const compilerIdentity = {
  name: "vgpu-tint-compiler",
  version: "0.1.0",
  protocol: 1,
  upstream: {
    name: "dawn/tint",
    revision: "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca",
  },
};
export const semanticContract = "vgpu-native-tint-semantic-extraction/v1";
export const translationContract = "vgpu-native-tint-compiler/v1";

export interface InterfaceValue {
  type: { scalar: string; width: number };
  invariant: boolean;
  location?: number;
  builtin?: string;
  interpolation?: { type: string; sampling: string };
  blendSource?: number;
}
export interface ShaderInterface {
  kind: "vertex" | "fragment";
  inputs: InterfaceValue[];
  outputs: InterfaceValue[];
}
export interface ExtractedEntry {
  stage: "vertex" | "fragment";
  wgsl: string;
  semanticInterface: ShaderInterface;
  bindings: string[];
  samplingPairs: unknown[];
  overrides: string[];
}
export interface SemanticResult {
  entryPoints: ExtractedEntry[];
  bindings: unknown[];
  overrides: unknown[];
  types: Record<string, unknown>;
  layouts: Record<string, unknown>;
}

export function encodeRequest(
  request: unknown,
  kind: "semantic" | "translation"
): string {
  const schema =
    kind === "semantic" ? semanticRequestSchema : compilerRequestSchema;
  assertSchema(
    schema.$id,
    request,
    kind === "semantic" ? "validation" : "translation"
  );
  return JSON.stringify(request);
}

export function checkedSemanticResult(
  response: unknown,
  requestBytes: string,
  selected: readonly { stage: string; wgsl: string }[]
): SemanticResult {
  assertSchema(semanticResponseSchema.$id, response, "validation");
  const domain = "vgpu-native-tint-semantic-extraction-request-bytes/v1";
  if (
    !isDeepStrictEqual((response as Record<string, unknown>).requestIdentity, {
      domain,
      sha256: sha256(`${domain}\0${requestBytes}`),
    })
  ) {
    throw new MetalCompileError(
      "validation",
      "Tint semantic response belongs to another request"
    );
  }
  const checked = checkedResponse(
    response,
    semanticResponseSchema.$id,
    "validation"
  );
  const result = checked.result as unknown as SemanticResult;
  if (
    !isDeepStrictEqual(
      result.entryPoints.map(({ stage, wgsl }) => ({ stage, wgsl })),
      selected
    )
  ) {
    throw new MetalCompileError(
      "validation",
      "Tint semantic response changed the selected stages"
    );
  }
  return result;
}

export function checkedTranslation(
  response: unknown,
  entryPoint: { stage: string; wgsl: string; metal: string },
  semanticInterface: ShaderInterface,
  expectedBindings: readonly MetalBindingMapping[] = []
): {
  msl: string;
  entryPoint: typeof entryPoint;
  internalBindings: unknown[];
  storageBufferSizeRegions: unknown[];
} {
  const checked = checkedResponse(
    response,
    compilerResponseSchema.$id,
    "translation"
  );
  const result = checked.result as Record<string, unknown>;
  if (
    !isDeepStrictEqual(result.entryPoint, entryPoint) ||
    !isDeepStrictEqual(result.bindings, expectedBindings) ||
    !isDeepStrictEqual(
      result.interface,
      expectedMetalInterface(semanticInterface)
    )
  ) {
    throw new MetalCompileError(
      "translation",
      "Tint translation changed the selected entry, slots, or interface"
    );
  }
  if (
    !isDeepStrictEqual(result.internalBindings, []) ||
    !isDeepStrictEqual(result.storageBufferSizeRegions, [])
  ) {
    throw new MetalCompileError(
      "translation",
      "Effective Metal internal data is unsupported by the current render profile"
    );
  }
  if (
    !hasMslEntryDeclaration(
      result.msl as string,
      entryPoint.stage,
      entryPoint.metal
    )
  ) {
    throw new MetalCompileError(
      "translation",
      "Tint MSL is missing its selected entry declaration"
    );
  }
  return result as unknown as {
    msl: string;
    entryPoint: typeof entryPoint;
    internalBindings: unknown[];
    storageBufferSizeRegions: unknown[];
  };
}

function checkedResponse(
  response: unknown,
  schema: string,
  stage: CompileStage
): Record<string, unknown> {
  assertSchema(schema, response, stage);
  const result = response as Record<string, unknown>;
  if (!isDeepStrictEqual(result.compiler, compilerIdentity))
    throw new MetalCompileError(
      stage,
      "Tint compiler identity does not match the pinned protocol"
    );
  const diagnostics = result.diagnostics as {
    severity: string;
    message: string;
  }[];
  if (!result.ok)
    throw new MetalCompileError(
      stage,
      `Tint rejected the program: ${diagnostics
        .map(({ message }) => message)
        .join("; ")}`,
      { diagnostics }
    );
  if (diagnostics.some(({ severity }) => severity === "error"))
    throw new MetalCompileError(
      stage,
      "Tint success response contains errors",
      { diagnostics }
    );
  return result;
}

function assertSchema(id: string, value: unknown, stage: CompileStage): void {
  const validate = ajv.getSchema(id)!;
  if (!validate(value))
    throw new MetalCompileError(
      stage,
      `Invalid Tint wire value: ${ajv.errorsText(validate.errors)}`
    );
}

function expectedMetalInterface(shader: ShaderInterface): unknown {
  if (shader.kind === "vertex")
    return {
      kind: "vertex",
      attributes: shader.inputs
        .filter((input) => input.location !== undefined)
        .map(({ location }) => ({
          semantic: { location },
          metal: { attribute: location },
        })),
    };
  return {
    kind: "fragment",
    colorOutputs: shader.outputs
      .filter((output) => output.location !== undefined)
      .map(({ location, blendSource }) => ({
        semantic: {
          location,
          ...(blendSource === undefined ? {} : { blendSource }),
        },
        metal: {
          color: location,
          ...(blendSource === undefined ? {} : { index: blendSource }),
        },
      })),
  };
}
