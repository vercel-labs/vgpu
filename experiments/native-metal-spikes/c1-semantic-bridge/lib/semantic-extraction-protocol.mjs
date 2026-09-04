import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  attachDiagnosticOrigins,
  assertCanonicalJsonNumbers,
  jsonAllocationUnits,
} from "../../c1-compiler-protocol/lib/protocol.mjs";
import {
  assertSourceCapsuleSemantics,
  deterministicStringify,
  INVENTORY_COMPILER,
  InventoryProtocolError,
} from "./protocol.mjs";

export const SEMANTIC_EXTRACTION_CONTRACT =
  "vgpu-native-tint-semantic-extraction/v1";
export const SEMANTIC_EXTRACTION_REQUEST_IDENTITY_DOMAIN =
  "vgpu-native-tint-semantic-extraction-request-bytes/v1";
export const SEMANTIC_EXTRACTION_COMPILER = INVENTORY_COMPILER;

const wgslIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class SemanticExtractionProtocolError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SemanticExtractionProtocolError";
    this.code = code;
  }
}

export function encodeSemanticExtractionRequest(request) {
  try {
    return deterministicStringify(request);
  } catch (cause) {
    if (cause instanceof InventoryProtocolError) {
      semanticFail(
        "VGPU-C1-SEMANTIC-WIRE",
        cause.message.replace(/^[^:]+:\s*/u, "")
      );
    }
    throw cause;
  }
}

export function semanticExtractionRequestIdentity(requestBytes) {
  if (typeof requestBytes !== "string" || !requestBytes.isWellFormed()) {
    semanticFail(
      "VGPU-C1-SEMANTIC-REQUEST-BYTES",
      "request bytes must be one well-formed Unicode string"
    );
  }
  return {
    domain: SEMANTIC_EXTRACTION_REQUEST_IDENTITY_DOMAIN,
    sha256: createHash("sha256")
      .update(SEMANTIC_EXTRACTION_REQUEST_IDENTITY_DOMAIN, "utf8")
      .update("\0", "utf8")
      .update(requestBytes, "utf8")
      .digest("hex"),
  };
}

export function assertSemanticExtractionRequestResourceLimits(request) {
  if (
    request?.originMap?.sources?.length > 4_096 ||
    request?.originMap?.segments?.length > 65_536 ||
    request?.overrideConfiguration?.length > 4_096
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-RESOURCE-LIMIT",
      "request exceeds a semantic extraction worker resource limit"
    );
  }
  const encoded = encodeSemanticExtractionRequest(request);
  if (
    jsonAllocationUnits(request) > 262_144 ||
    Buffer.byteLength(encoded, "utf8") > 128 * 1024 * 1024
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-RESOURCE-LIMIT",
      "request exceeds a semantic extraction worker resource limit"
    );
  }
  return request;
}

export function assertSemanticExtractionRequestSemantics(request) {
  if (
    request?.schemaVersion !== 1 ||
    request?.contractId !== SEMANTIC_EXTRACTION_CONTRACT
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-CONTRACT",
      "request selects another contract"
    );
  }
  assertSemanticExtractionRequestResourceLimits(request);
  assertSourceCapsuleSemantics(request, {
    codePrefix: "VGPU-C1-SEMANTIC",
    failWith: semanticFail,
  });
  assertSelectedProgram(request.entryPoints);
  assertOverrideConfiguration(request.overrideConfiguration);
  return request;
}

export function assertSemanticExtractionExecutableProfile(request) {
  assertSemanticExtractionRequestSemantics(request);
  if (request.overrideConfiguration.length !== 0) {
    semanticFail(
      "VGPU-C1-SEMANTIC-CONFIGURATION-UNSUPPORTED",
      "configured overrides are outside the interface-only executable profile"
    );
  }
  return request;
}

export function assertSemanticExtractionResponseSemantics(
  request,
  requestBytes,
  response
) {
  assertCanonicalJsonNumbers(response, "semantic extraction response", {
    code: "VGPU-C1-SEMANTIC-CANONICAL",
    failWith: semanticFail,
  });
  if (
    response?.schemaVersion !== 1 ||
    response?.contractId !== SEMANTIC_EXTRACTION_CONTRACT
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-RESPONSE-CONTRACT",
      "response selects another contract"
    );
  }
  if (!isDeepStrictEqual(response.compiler, SEMANTIC_EXTRACTION_COMPILER)) {
    semanticFail("VGPU-C1-SEMANTIC-COMPILER", "compiler identity drifted");
  }
  if (encodeSemanticExtractionRequest(request) !== requestBytes) {
    semanticFail(
      "VGPU-C1-SEMANTIC-REQUEST-BYTES",
      "response association did not retain the exact encoded request bytes"
    );
  }
  if (
    !isDeepStrictEqual(
      response.requestIdentity,
      semanticExtractionRequestIdentity(requestBytes)
    )
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-REQUEST-IDENTITY",
      "response belongs to another request"
    );
  }
  try {
    attachDiagnosticOrigins(request, { diagnostics: response.diagnostics });
  } catch (cause) {
    semanticFail(
      "VGPU-C1-SEMANTIC-DIAGNOSTIC",
      `diagnostic provenance is invalid: ${cause?.message ?? cause}`
    );
  }

  const errors = response.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (!response.ok) {
    if (Object.hasOwn(response, "result") || errors.length === 0) {
      semanticFail(
        "VGPU-C1-SEMANTIC-FAILURE",
        "failure must contain an error and no result"
      );
    }
    return response;
  }
  if (!response.result || errors.length !== 0) {
    semanticFail(
      "VGPU-C1-SEMANTIC-SUCCESS",
      "success has an error or no result"
    );
  }
  if (request.overrideConfiguration.length !== 0) {
    semanticFail(
      "VGPU-C1-SEMANTIC-PROFILE",
      "the interface-only profile cannot succeed with configured overrides"
    );
  }

  const result = response.result;
  if (result.entryPoints.length !== request.entryPoints.length) {
    semanticFail(
      "VGPU-C1-SEMANTIC-ENTRY-SET",
      "response entry tuple differs from the selected program"
    );
  }
  for (let index = 0; index < request.entryPoints.length; index += 1) {
    const requested = request.entryPoints[index];
    const extracted = result.entryPoints[index];
    if (
      extracted.stage !== requested.stage ||
      extracted.wgsl !== requested.wgsl ||
      extracted.semanticInterface.kind !== requested.stage
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-ENTRY-SET",
        "response entry tuple differs from the selected program"
      );
    }
    assertCanonicalInterface(
      extracted.semanticInterface,
      request.languageFeatures
    );
    if (
      extracted.bindings.length !== 0 ||
      extracted.samplingPairs.length !== 0 ||
      extracted.overrides.length !== 0
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-PROFILE",
        "interface-only entry contains resources, sampling pairs, or overrides"
      );
    }
    if (
      requested.stage === "compute" &&
      (!Number.isInteger(extracted.workgroupSize?.x) ||
        extracted.workgroupSize.x <= 0 ||
        !Number.isInteger(extracted.workgroupSize?.y) ||
        extracted.workgroupSize.y <= 0 ||
        !Number.isInteger(extracted.workgroupSize?.z) ||
        extracted.workgroupSize.z <= 0)
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-WORKGROUP-SIZE",
        "compute extraction has no positive resolved workgroup size"
      );
    }
  }
  if (
    result.bindings.length !== 0 ||
    result.overrides.length !== 0 ||
    Object.keys(result.types).length !== 0 ||
    Object.keys(result.layouts).length !== 0
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-PROFILE",
      "interface-only result contains resource, override, type, or layout facts"
    );
  }
  return response;
}

function assertSelectedProgram(entryPoints) {
  if (!Array.isArray(entryPoints)) {
    semanticFail(
      "VGPU-C1-SEMANTIC-ENTRY-SET",
      "entryPoints must select compute or vertex-fragment"
    );
  }
  const compute =
    entryPoints.length === 1 && entryPoints[0]?.stage === "compute";
  const render =
    entryPoints.length === 2 &&
    entryPoints[0]?.stage === "vertex" &&
    entryPoints[1]?.stage === "fragment";
  if (!compute && !render) {
    semanticFail(
      "VGPU-C1-SEMANTIC-ENTRY-SET",
      "entryPoints must select compute or vertex-fragment"
    );
  }
  for (const entry of entryPoints) {
    if (
      typeof entry?.wgsl !== "string" ||
      entry.wgsl.length > 256 ||
      !wgslIdentifier.test(entry.wgsl)
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-ENTRY-NAME",
        "selected entry name is not a compiler-protocol WGSL identifier"
      );
    }
  }
}

function assertOverrideConfiguration(configuration) {
  if (!Array.isArray(configuration)) {
    semanticFail(
      "VGPU-C1-SEMANTIC-OVERRIDE-CONFIGURATION",
      "override configuration must be an array"
    );
  }
  let previous;
  for (const configured of configuration) {
    if (
      typeof configured?.name !== "string" ||
      configured.name.length > 256 ||
      !wgslIdentifier.test(configured.name) ||
      (previous !== undefined && previous >= configured.name)
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-OVERRIDE-ORDER",
        "override names are invalid, duplicated, or not in ASCII order"
      );
    }
    if (
      typeof configured.value !== "boolean" &&
      (typeof configured.value !== "number" ||
        !Number.isFinite(configured.value) ||
        Object.is(configured.value, -0))
    ) {
      semanticFail(
        "VGPU-C1-SEMANTIC-OVERRIDE-VALUE",
        "override value must be a finite canonical JSON number or boolean"
      );
    }
    previous = configured.name;
  }
}

function assertCanonicalInterface(shaderInterface, languageFeatures) {
  assertCanonicalInterfaceValues(
    shaderInterface.inputs,
    shaderInterface.kind,
    "inputs",
    languageFeatures
  );
  assertCanonicalInterfaceValues(
    shaderInterface.outputs,
    shaderInterface.kind,
    "outputs",
    languageFeatures
  );
  const colorOutputs =
    shaderInterface.kind === "fragment"
      ? shaderInterface.outputs.filter((value) =>
          Object.hasOwn(value, "location")
        )
      : [];
  const dualSource = colorOutputs.filter((value) =>
    Object.hasOwn(value, "blendSource")
  );
  if (
    dualSource.length > 0 &&
    !languageFeatures.includes("dual_source_blending")
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "dual-source outputs require the dual_source_blending language feature"
    );
  }
  if (
    dualSource.length > 0 &&
    (colorOutputs.length !== 2 ||
      dualSource.length !== 2 ||
      dualSource[0].location !== 0 ||
      dualSource[1].location !== 0 ||
      dualSource[0].blendSource !== 0 ||
      dualSource[1].blendSource !== 1 ||
      !isDeepStrictEqual(dualSource[0].type, dualSource[1].type))
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "dual-source outputs must be the exact same-type location(0) source 0/1 pair"
    );
  }
}

function assertCanonicalInterfaceValues(
  values,
  stage,
  direction,
  languageFeatures
) {
  let previous;
  for (const value of values) {
    assertInterfaceValueSemantics(value, stage, direction, languageFeatures);
    const key = interfaceKey(value);
    if (previous !== undefined && compareInterfaceKeys(previous, key) >= 0) {
      semanticFail(
        "VGPU-C1-SEMANTIC-INTERFACE-ORDER",
        `${direction} repeat a semantic key or are not canonically ordered`
      );
    }
    previous = key;
  }
}

function assertInterfaceValueSemantics(
  value,
  stage,
  direction,
  languageFeatures
) {
  const linkedLocation =
    Object.hasOwn(value, "location") &&
    ((stage === "vertex" && direction === "outputs") ||
      (stage === "fragment" && direction === "inputs"));
  if (linkedLocation !== Object.hasOwn(value, "interpolation")) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "interface interpolation is not normalized by stage role"
    );
  }
  if (
    linkedLocation &&
    ["i32", "u32"].includes(value.type.scalar) &&
    value.interpolation.type !== "flat"
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "integral inter-stage location is not flat"
    );
  }
  if (value.type.scalar === "f16" && !languageFeatures.includes("f16")) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "f16 interface value lacks the explicit f16 language feature"
    );
  }

  if (Object.hasOwn(value, "builtin")) {
    const expected = expectedBuiltinType(stage, direction, value.builtin);
    if (!expected || !isDeepStrictEqual(value.type, expected)) {
      semanticFail(
        "VGPU-C1-SEMANTIC-INTERFACE",
        "interface builtin or builtin type is unsupported"
      );
    }
  }
  const mayBeInvariant =
    stage === "vertex" &&
    direction === "outputs" &&
    value.builtin === "position";
  if (value.invariant && !mayBeInvariant) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "interface invariance is unsupported in this stage role"
    );
  }
  if (
    Object.hasOwn(value, "blendSource") &&
    (stage !== "fragment" || direction !== "outputs" || value.location !== 0)
  ) {
    semanticFail(
      "VGPU-C1-SEMANTIC-INTERFACE",
      "interface blend source is unsupported in this stage role"
    );
  }
}

function expectedBuiltinType(stage, direction, builtin) {
  const key = `${stage}:${direction}:${builtin}`;
  if (
    [
      "vertex:inputs:vertex_index",
      "vertex:inputs:instance_index",
      "fragment:inputs:sample_index",
      "fragment:inputs:sample_mask",
      "fragment:outputs:sample_mask",
      "compute:inputs:local_invocation_index",
    ].includes(key)
  ) {
    return { scalar: "u32", width: 1 };
  }
  if (
    [
      "compute:inputs:local_invocation_id",
      "compute:inputs:global_invocation_id",
      "compute:inputs:workgroup_id",
      "compute:inputs:num_workgroups",
    ].includes(key)
  ) {
    return { scalar: "u32", width: 3 };
  }
  if (["vertex:outputs:position", "fragment:inputs:position"].includes(key)) {
    return { scalar: "f32", width: 4 };
  }
  if (key === "fragment:inputs:front_facing") {
    return { scalar: "bool", width: 1 };
  }
  if (key === "fragment:outputs:frag_depth") {
    return { scalar: "f32", width: 1 };
  }
  return undefined;
}

function interfaceKey(value) {
  if (Object.hasOwn(value, "location")) {
    return {
      kind: 0,
      location: value.location,
      blend: Object.hasOwn(value, "blendSource") ? value.blendSource + 1 : 0,
    };
  }
  return { kind: 1, builtin: value.builtin };
}

function compareInterfaceKeys(left, right) {
  if (left.kind !== right.kind) return left.kind - right.kind;
  if (left.kind === 0) {
    return left.location - right.location || left.blend - right.blend;
  }
  return left.builtin < right.builtin
    ? -1
    : left.builtin > right.builtin
    ? 1
    : 0;
}

function semanticFail(code, message) {
  throw new SemanticExtractionProtocolError(code, message);
}
