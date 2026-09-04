import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assertValidModuleOriginMap } from "../../c1-compiler-protocol/lib/origin-map.mjs";
import {
  jsonAllocationUnits,
  TINT_REVISION,
} from "../../c1-compiler-protocol/lib/protocol.mjs";

export const INVENTORY_CONTRACT = "vgpu-native-tint-entry-inventory/v1";
export const INVENTORY_REQUEST_IDENTITY_DOMAIN =
  "vgpu-native-tint-entry-inventory-request-bytes/v1";

export const INVENTORY_COMPILER = Object.freeze({
  name: "vgpu-tint-compiler",
  version: "0.1.0",
  protocol: 1,
  upstream: Object.freeze({ name: "dawn/tint", revision: TINT_REVISION }),
});

const supportedFeatures = new Set([
  "dual_source_blending",
  "f16",
  "sized_binding_array",
  "uniform_buffer_standard_layout",
  "unrestricted_pointer_parameters",
]);
const stageOrder = new Map([
  ["vertex", 0],
  ["fragment", 1],
  ["compute", 2],
]);

export class InventoryProtocolError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "InventoryProtocolError";
    this.code = code;
  }
}

export function sha256Utf8(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail("VGPU-C1-INVENTORY-UNICODE", "value is not well-formed Unicode");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function originMapSha256(originMap) {
  return sha256Utf8(deterministicStringify(originMap));
}

export function encodeInventoryRequest(request) {
  return deterministicStringify(request);
}

/**
 * Deterministic JSON encoding that sorts object keys without normalizing string
 * values. The resolved WGSL is an exact byte input, so NFC canonicalization
 * here would silently compile and authenticate different source bytes.
 */
export function deterministicStringify(value) {
  return encodeJsonValue(value, new Set(), "$request");
}

export function inventoryRequestIdentity(requestBytes) {
  if (typeof requestBytes !== "string" || !requestBytes.isWellFormed()) {
    fail(
      "VGPU-C1-INVENTORY-REQUEST-BYTES",
      "request bytes must be one well-formed Unicode string"
    );
  }
  return {
    domain: INVENTORY_REQUEST_IDENTITY_DOMAIN,
    sha256: sha256Utf8(
      `${INVENTORY_REQUEST_IDENTITY_DOMAIN}\u0000${requestBytes}`
    ),
  };
}

export function assertInventoryRequestSemantics(request) {
  if (
    request?.schemaVersion !== 1 ||
    request?.contractId !== INVENTORY_CONTRACT
  ) {
    fail("VGPU-C1-INVENTORY-CONTRACT", "request selects another contract");
  }
  assertInventoryRequestResourceLimits(request);
  if (
    typeof request.source?.text !== "string" ||
    !request.source.text.isWellFormed() ||
    request.source.text.includes("\u0000")
  ) {
    fail(
      "VGPU-C1-INVENTORY-SOURCE",
      "source text is not valid exact-byte protocol text"
    );
  }
  if (Buffer.byteLength(request.source.text, "utf8") > 16 * 1024 * 1024) {
    fail("VGPU-C1-INVENTORY-SOURCE-SIZE", "source exceeds 16 MiB UTF-8");
  }
  if (sha256Utf8(request.source.text) !== request.source.sha256) {
    fail(
      "VGPU-C1-INVENTORY-SOURCE-HASH",
      "source hash differs from its UTF-8 bytes"
    );
  }
  assertCanonicalVirtualPath(request.source.virtualPath);
  if (
    request.originMap?.generatedSource?.virtualPath !==
      request.source.virtualPath ||
    request.originMap?.generatedSource?.sha256 !== request.source.sha256
  ) {
    fail(
      "VGPU-C1-INVENTORY-ORIGIN-SOURCE",
      "origin map describes another source"
    );
  }
  const sourceBytes = Buffer.byteLength(request.source.text, "utf8");
  try {
    assertValidModuleOriginMap(request.originMap, sourceBytes);
  } catch (cause) {
    throw new InventoryProtocolError(
      "VGPU-C1-INVENTORY-ORIGIN-MAP",
      cause.message
    );
  }
  if (originMapSha256(request.originMap) !== request.originMapSha256) {
    fail(
      "VGPU-C1-INVENTORY-ORIGIN-HASH",
      "origin-map hash is stale or crossed"
    );
  }
  assertOriginCanonical(request.source.text, request.originMap);
  assertFeaturesCanonical(request.languageFeatures);
  return request;
}

export function assertInventoryRequestResourceLimits(request) {
  if (
    request?.originMap?.sources?.length > 4_096 ||
    request?.originMap?.segments?.length > 65_536
  ) {
    fail(
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
      "request exceeds an inventory worker resource limit"
    );
  }
  const encoded = deterministicStringify(request);
  if (jsonAllocationUnits(request) > 262_144) {
    fail(
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
      "request exceeds an inventory worker resource limit"
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > 128 * 1024 * 1024) {
    fail(
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
      "request exceeds an inventory worker resource limit"
    );
  }
  return request;
}

export function assertInventoryResponseSemantics(
  request,
  requestBytes,
  response
) {
  if (
    response?.schemaVersion !== 1 ||
    response?.contractId !== INVENTORY_CONTRACT
  ) {
    fail(
      "VGPU-C1-INVENTORY-RESPONSE-CONTRACT",
      "response selects another contract"
    );
  }
  if (!isDeepStrictEqual(response.compiler, INVENTORY_COMPILER)) {
    fail("VGPU-C1-INVENTORY-COMPILER", "compiler identity drifted");
  }
  const encoded = encodeInventoryRequest(request);
  if (encoded !== requestBytes) {
    fail(
      "VGPU-C1-INVENTORY-REQUEST-BYTES",
      "response association did not retain the exact encoded request bytes"
    );
  }
  if (
    !isDeepStrictEqual(
      response.requestIdentity,
      inventoryRequestIdentity(requestBytes)
    )
  ) {
    fail(
      "VGPU-C1-INVENTORY-REQUEST-IDENTITY",
      "response belongs to another request"
    );
  }
  const errors = response.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  );
  if (!response.ok) {
    if (Object.hasOwn(response, "result") || errors.length === 0) {
      fail(
        "VGPU-C1-INVENTORY-FAILURE",
        "failure must contain an error and no result"
      );
    }
    return response;
  }
  if (!response.result || errors.length !== 0) {
    fail("VGPU-C1-INVENTORY-SUCCESS", "success has an error or no result");
  }
  assertCanonicalEntryPoints(response.result.entryPoints);
  return response;
}

export function assertCanonicalEntryPoints(entryPoints) {
  if (entryPoints.length > 65_536) {
    fail(
      "VGPU-C1-INVENTORY-RESOURCE-LIMIT",
      "response exceeds the entry-point limit"
    );
  }
  let previous;
  for (const entry of entryPoints) {
    const rank = stageOrder.get(entry.stage);
    if (rank === undefined) {
      fail(
        "VGPU-C1-INVENTORY-ENTRY-STAGE",
        "entry point has an unsupported stage"
      );
    }
    const key = `${rank}:${entry.wgsl}`;
    if (previous !== undefined && compareAscii(previous, key) >= 0) {
      fail(
        "VGPU-C1-INVENTORY-ENTRY-ORDER",
        "entry points are duplicated or not in canonical stage/name order"
      );
    }
    previous = key;
  }
  return entryPoints;
}

function assertFeaturesCanonical(features) {
  let previous;
  for (const feature of features) {
    if (!supportedFeatures.has(feature)) {
      fail(
        "VGPU-C1-INVENTORY-FEATURE",
        `unsupported language feature ${feature}`
      );
    }
    if (previous !== undefined && compareAscii(previous, feature) >= 0) {
      fail(
        "VGPU-C1-INVENTORY-FEATURE-ORDER",
        "language features are duplicated or not canonically ordered"
      );
    }
    previous = feature;
  }
}

function assertOriginCanonical(text, originMap) {
  const boundaries = new Set([0]);
  let offset = 0;
  for (const character of text) {
    offset += Buffer.byteLength(character, "utf8");
    boundaries.add(offset);
  }
  let previous;
  for (const segment of originMap.segments) {
    if (
      !boundaries.has(segment.generated.startByte) ||
      !boundaries.has(segment.generated.endByte)
    ) {
      fail(
        "VGPU-C1-INVENTORY-ORIGIN-UTF8",
        "origin segment splits a UTF-8 code point"
      );
    }
    if (
      previous?.generated.endByte === segment.generated.startByte &&
      previous.origin.input === segment.origin.input
    ) {
      fail(
        "VGPU-C1-INVENTORY-ORIGIN-CANONICAL",
        "adjacent equal origins must be merged"
      );
    }
    previous = segment;
  }
  let previousInput;
  for (const source of originMap.sources) {
    if (
      typeof source.input !== "string" ||
      !source.input.isWellFormed() ||
      source.input.normalize("NFC") !== source.input
    ) {
      fail(
        "VGPU-C1-INVENTORY-ORIGIN-INPUT",
        "origin input is not NFC-canonical"
      );
    }
    if (
      previousInput !== undefined &&
      compareAscii(previousInput, source.input) >= 0
    ) {
      fail(
        "VGPU-C1-INVENTORY-ORIGIN-ORDER",
        "origin inputs are not canonically ordered"
      );
    }
    previousInput = source.input;
  }
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalVirtualPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    exceedsCodePointLimit(value, 4_096) ||
    !value.isWellFormed() ||
    value.normalize("NFC") !== value ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.split("/").some((segment) => ["", ".", ".."].includes(segment)) ||
    posix.normalize(value) !== value
  ) {
    fail(
      "VGPU-C1-INVENTORY-SOURCE-PATH",
      "source virtual path is not a canonical relative POSIX NFC path"
    );
  }
  return value;
}

function exceedsCodePointLimit(value, limit) {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function encodeJsonValue(value, active, path) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      fail(
        "VGPU-C1-INVENTORY-WIRE-UNICODE",
        `${path} is not well-formed Unicode`
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(
        "VGPU-C1-INVENTORY-WIRE-NUMBER",
        `${path} is not a finite canonical JSON number`
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail("VGPU-C1-INVENTORY-WIRE-VALUE", `${path} is not a plain JSON value`);
  }
  if (active.has(value)) {
    fail("VGPU-C1-INVENTORY-WIRE-CYCLE", `${path} contains a cycle`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const values = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          fail(
            "VGPU-C1-INVENTORY-WIRE-VALUE",
            `${path}[${index}] is an array hole`
          );
        }
        values.push(encodeJsonValue(value[index], active, `${path}[${index}]`));
      }
      if (
        Reflect.ownKeys(value).some(
          (key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(String(key))
        )
      ) {
        fail(
          "VGPU-C1-INVENTORY-WIRE-VALUE",
          `${path} has a non-index array property`
        );
      }
      return `[${values.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("VGPU-C1-INVENTORY-WIRE-VALUE", `${path} is not a plain object`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !key.isWellFormed())) {
      fail(
        "VGPU-C1-INVENTORY-WIRE-UNICODE",
        `${path} has a symbol or malformed key`
      );
    }
    keys.sort(compareAscii);
    const members = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fail(
          "VGPU-C1-INVENTORY-WIRE-VALUE",
          `${path}.${key} is not an enumerable data property`
        );
      }
      members.push(
        `${JSON.stringify(key)}:${encodeJsonValue(
          descriptor.value,
          active,
          `${path}.${key}`
        )}`
      );
    }
    return `{${members.join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function fail(code, message) {
  throw new InventoryProtocolError(code, message);
}
