import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import {
  assertInventoryRequestSemantics,
  assertInventoryResponseSemantics,
} from "./protocol.mjs";

const authenticatedEntryInventories = new WeakMap();
const validators = loadValidators();

export class AuthenticatedInventoryError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "AuthenticatedInventoryError";
    this.code = code;
  }
}

/**
 * Mints the compact in-process value that program selection is allowed to
 * consume. Deserializing or cloning this value intentionally loses its brand;
 * callers must retain and revalidate the exact request bytes and response.
 *
 * configSource is the canonical source identity produced by the configuration
 * boundary. It is deliberately distinct from the generated virtual WGSL path.
 */
export function authenticateSuccessfulInventory({
  configSource,
  request,
  requestBytes,
  response,
}) {
  assertConfigSource(configSource);
  assertSchema(validators.request, request, "inventory request");
  assertSchema(validators.response, response, "inventory response");
  assertInventoryRequestSemantics(request);
  assertInventoryResponseSemantics(request, requestBytes, response);
  if (!response.ok) {
    throw new AuthenticatedInventoryError(
      "VGPU-C1-INVENTORY-NOT-SUCCESS",
      "a failed inventory response cannot authorize program selection"
    );
  }

  const inventory = Object.freeze({
    configSource,
    requestIdentity: Object.freeze({
      domain: response.requestIdentity.domain,
      sha256: response.requestIdentity.sha256,
    }),
    capsule: Object.freeze({
      virtualPath: request.source.virtualPath,
      sourceSha256: request.source.sha256,
      originMapSha256: request.originMapSha256,
      languageFeatures: Object.freeze([...request.languageFeatures]),
    }),
    entryPoints: Object.freeze(
      response.result.entryPoints.map((entry) =>
        Object.freeze({ stage: entry.stage, wgsl: entry.wgsl })
      )
    ),
  });
  authenticatedEntryInventories.set(inventory, { requestBytes });
  return inventory;
}

export function isAuthenticatedEntryInventory(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    authenticatedEntryInventories.has(value)
  );
}

export function authenticatedInventoryRequestBytes(value) {
  const record = authenticatedEntryInventories.get(value);
  if (!record) {
    throw new AuthenticatedInventoryError(
      "VGPU-C1-INVENTORY-BRAND",
      "value is not an authenticated entry inventory"
    );
  }
  return record.requestBytes;
}

function assertConfigSource(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    exceedsCodePointLimit(value, 4_096) ||
    !value.isWellFormed() ||
    value.normalize("NFC") !== value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.split("/").some((component) => ["", ".", ".."].includes(component))
  ) {
    throw new AuthenticatedInventoryError(
      "VGPU-C1-INVENTORY-CONFIG-SOURCE",
      "configSource must be a canonical relative POSIX NFC path"
    );
  }
}

function loadValidators() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compilerContracts = resolve(
    directory,
    "../../c1-compiler-protocol/contracts"
  );
  const inventoryContracts = resolve(directory, "../contracts");
  const schemas = [
    readJson(join(compilerContracts, "origin-map-v1.schema.json")),
    readJson(join(compilerContracts, "response-v1.schema.json")),
    readJson(join(inventoryContracts, "inventory-request-v1.schema.json")),
    readJson(join(inventoryContracts, "inventory-response-v1.schema.json")),
  ];
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of schemas) ajv.addSchema(schema);
  return {
    request: ajv.getSchema(schemas[2].$id),
    response: ajv.getSchema(schemas[3].$id),
  };
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    throw new AuthenticatedInventoryError(
      "VGPU-C1-INVENTORY-SCHEMA",
      `${label} failed JSON Schema validation: ${JSON.stringify(
        validate.errors
      )}`
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function exceedsCodePointLimit(value, limit) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}
