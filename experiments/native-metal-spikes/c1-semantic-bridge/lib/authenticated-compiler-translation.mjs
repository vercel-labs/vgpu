import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { assertResponseSemantics } from "../../c1-compiler-protocol/lib/protocol.mjs";
import { isAssembledCompilerRequest } from "./semantic-assembly.mjs";

const authenticatedCompilerTranslations = new WeakMap();
const responseValidator = loadResponseValidator();

export class AuthenticatedCompilerTranslationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "AuthenticatedCompilerTranslationError";
    this.code = code;
  }
}

/**
 * Authenticates one successful compiler response against the exact nominal
 * request that produced it. The caller-owned response is snapshotted before
 * validation; only a minimal entry identity is exposed by the returned handle.
 */
export function authenticateSuccessfulCompilerTranslation({
  request,
  response,
}) {
  if (!isAssembledCompilerRequest(request)) {
    translationFail(
      "VGPU-C1-TRANSLATION-REQUEST",
      "translation authentication requires a nominal assembled compiler request"
    );
  }

  let snapshot;
  try {
    snapshot = structuredClone(response);
  } catch (cause) {
    translationFail(
      "VGPU-C1-TRANSLATION-SNAPSHOT",
      `compiler response could not be snapshotted: ${
        cause?.message ?? String(cause)
      }`
    );
  }
  assertResponseSchema(snapshot);
  try {
    assertResponseSemantics(request, snapshot);
  } catch (cause) {
    translationFail(
      "VGPU-C1-TRANSLATION-SEMANTICS",
      `compiler response failed request-specific validation: ${
        cause?.message ?? String(cause)
      }`
    );
  }
  if (!snapshot.ok) {
    translationFail(
      "VGPU-C1-TRANSLATION-NOT-SUCCESS",
      "a failed compiler response cannot authorize program projection"
    );
  }

  freezeJson(snapshot);
  const translation = Object.freeze({
    stage: snapshot.result.entryPoint.stage,
    wgsl: snapshot.result.entryPoint.wgsl,
    metal: snapshot.result.entryPoint.metal,
  });
  authenticatedCompilerTranslations.set(translation, {
    request,
    response: snapshot,
  });
  return translation;
}

export function isAuthenticatedCompilerTranslation(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    authenticatedCompilerTranslations.has(value)
  );
}

export function compilerRequestForTranslation(value) {
  return requireTranslation(value).request;
}

export function compilerResponseForTranslation(value) {
  return requireTranslation(value).response;
}

function requireTranslation(value) {
  const record = authenticatedCompilerTranslations.get(value);
  if (!record) {
    translationFail(
      "VGPU-C1-TRANSLATION-BRAND",
      "value is not an authenticated compiler translation"
    );
  }
  return record;
}

function loadResponseValidator() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(
    readFileSync(
      resolve(
        directory,
        "../../c1-compiler-protocol/contracts/response-v1.schema.json"
      ),
      "utf8"
    )
  );
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

function assertResponseSchema(value) {
  if (!responseValidator(value)) {
    translationFail(
      "VGPU-C1-TRANSLATION-SCHEMA",
      `compiler response failed JSON Schema validation: ${JSON.stringify(
        responseValidator.errors
      )}`
    );
  }
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function translationFail(code, message) {
  throw new AuthenticatedCompilerTranslationError(code, message);
}
