import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { isFinalizedProgramCapsule } from "./fullscreen-injection.mjs";
import {
  assertSemanticExtractionRequestSemantics,
  assertSemanticExtractionResponseSemantics,
  encodeSemanticExtractionRequest,
  SEMANTIC_EXTRACTION_CONTRACT,
} from "./semantic-extraction-protocol.mjs";

const authenticatedSemanticExtractions = new WeakMap();
const validators = loadValidators();

export class AuthenticatedSemanticExtractionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "AuthenticatedSemanticExtractionError";
    this.code = code;
  }
}

export function semanticExtractionRequestForFinalizedCapsule(
  finalized,
  { overrideConfiguration = [] } = {}
) {
  if (!isFinalizedProgramCapsule(finalized)) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-CAPSULE",
      "semantic extraction requires a nominal finalized program capsule"
    );
  }
  const stages =
    finalized.selection.kind === "compute"
      ? ["compute"]
      : ["vertex", "fragment"];
  const request = {
    schemaVersion: 1,
    contractId: SEMANTIC_EXTRACTION_CONTRACT,
    source: structuredClone(finalized.capsule.source),
    originMap: structuredClone(finalized.capsule.originMap),
    originMapSha256: finalized.capsule.originMapSha256,
    entryPoints: stages.map((stage) => ({
      stage,
      wgsl: finalized.selection.entryPoints[stage].names.wgsl,
    })),
    overrideConfiguration: structuredClone(overrideConfiguration),
    languageFeatures: [...finalized.capsule.languageFeatures],
  };
  assertSchema(validators.request, request, "semantic extraction request");
  assertSemanticExtractionRequestSemantics(request);
  return freezeJson(request);
}

export function authenticateSuccessfulSemanticExtraction({
  finalized,
  request,
  requestBytes,
  response,
}) {
  if (!isFinalizedProgramCapsule(finalized)) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-CAPSULE",
      "semantic extraction requires a nominal finalized program capsule"
    );
  }
  assertSchema(validators.request, request, "semantic extraction request");
  assertSchema(validators.response, response, "semantic extraction response");
  assertSemanticExtractionRequestSemantics(request);
  assertSemanticExtractionResponseSemantics(request, requestBytes, response);
  if (!response.ok) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-NOT-SUCCESS",
      "a failed semantic extraction response cannot authorize assembly"
    );
  }

  const expectedRequest = semanticExtractionRequestForFinalizedCapsule(
    finalized,
    { overrideConfiguration: request.overrideConfiguration }
  );
  if (
    encodeSemanticExtractionRequest(expectedRequest) !== requestBytes ||
    !isDeepStrictEqual(expectedRequest, request)
  ) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-CAPSULE",
      "semantic extraction request belongs to another finalized capsule"
    );
  }

  const extraction = freezeJson({
    requestIdentity: structuredClone(response.requestIdentity),
    capsule: {
      virtualPath: request.source.virtualPath,
      sourceSha256: request.source.sha256,
      originMapSha256: request.originMapSha256,
      languageFeatures: [...request.languageFeatures],
    },
    result: structuredClone(response.result),
  });
  authenticatedSemanticExtractions.set(extraction, {
    finalized,
    selection: finalized.selection,
    requestBytes,
  });
  return extraction;
}

export function isAuthenticatedSemanticExtraction(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    authenticatedSemanticExtractions.has(value)
  );
}

export function isSemanticExtractionForFinalizedCapsule(value, finalized) {
  return authenticatedSemanticExtractions.get(value)?.finalized === finalized;
}

export function authenticatedSemanticExtractionRequestBytes(value) {
  const record = authenticatedSemanticExtractions.get(value);
  if (!record) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-BRAND",
      "value is not an authenticated semantic extraction"
    );
  }
  return record.requestBytes;
}

function loadValidators() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compilerContracts = resolve(
    directory,
    "../../c1-compiler-protocol/contracts"
  );
  const semanticContracts = resolve(directory, "../contracts");
  const schemas = [
    readJson(join(compilerContracts, "origin-map-v1.schema.json")),
    readJson(join(compilerContracts, "request-v1.schema.json")),
    readJson(join(compilerContracts, "response-v1.schema.json")),
    readJson(join(semanticContracts, "inventory-request-v1.schema.json")),
    readJson(
      join(semanticContracts, "semantic-extraction-request-v1.schema.json")
    ),
    readJson(
      join(semanticContracts, "semantic-extraction-response-v1.schema.json")
    ),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schemas[4].$id),
    response: ajv.getSchema(schemas[5].$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    authenticatedFail(
      "VGPU-C1-SEMANTIC-SCHEMA",
      `${label} failed JSON Schema validation: ${JSON.stringify(
        validate.errors
      )}`
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function authenticatedFail(code, message) {
  throw new AuthenticatedSemanticExtractionError(code, message);
}
