import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const COMPILER_CONTRACT = "vgpu-native-tint-compiler/v1";
export const TINT_REVISION = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

const immediateReservation = {
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
};

export class CompilerProtocolError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "CompilerProtocolError";
    this.code = code;
  }
}

export function sha256Utf8(value) {
  if (typeof value !== "string" || !value.isWellFormed()) {
    fail(
      "VGPU-C1-PROTOCOL-UNICODE",
      "UTF-8 protocol strings cannot contain isolated UTF-16 surrogates"
    );
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Checks invariants that JSON Schema cannot express: crossed hashes, canonical
 * ordering, unique semantic keys, UTF-8 origin ranges, and interval overlap.
 */
export function assertRequestSemantics(request) {
  if (request.contractId !== COMPILER_CONTRACT || request.schemaVersion !== 1) {
    fail("VGPU-C1-PROTOCOL-CONTRACT", "request selects another contract");
  }
  if (sha256Utf8(request.source.text) !== request.source.sha256) {
    fail(
      "VGPU-C1-PROTOCOL-SOURCE-HASH",
      "source hash does not match UTF-8 text"
    );
  }
  if (
    request.originMap.generatedSource.virtualPath !==
      request.source.virtualPath ||
    request.originMap.generatedSource.sha256 !== request.source.sha256
  ) {
    fail(
      "VGPU-C1-PROTOCOL-ORIGIN-SOURCE",
      "origin map describes a different generated source"
    );
  }

  assertCanonicalVirtualPath(request.source.virtualPath, "source virtual path");

  assertSortedUnique(
    request.originMap.sources,
    (item) => item.input,
    "origin source inputs"
  );
  const originInputs = new Set(
    request.originMap.sources.map((item) => item.input)
  );
  for (const source of request.originMap.sources) {
    assertCanonicalInputId(source.input, "origin input");
  }
  const generatedBytes = Buffer.byteLength(request.source.text, "utf8");
  const utf8Boundaries = utf8BoundarySet(request.source.text);
  let previousEnd = 0;
  let previousSegment;
  for (const [index, segment] of request.originMap.segments.entries()) {
    const { startByte, endByte } = segment.generated;
    if (
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      startByte < previousEnd ||
      endByte <= startByte ||
      endByte > generatedBytes
    ) {
      fail(
        "VGPU-C1-PROTOCOL-ORIGIN-RANGE",
        `origin segment ${index} is empty, crossed, overlapping, or out of bounds`
      );
    }
    if (!utf8Boundaries.has(startByte) || !utf8Boundaries.has(endByte)) {
      fail(
        "VGPU-C1-PROTOCOL-ORIGIN-UTF8",
        `origin segment ${index} splits a UTF-8 code point`
      );
    }
    if (!originInputs.has(segment.origin.input)) {
      fail(
        "VGPU-C1-PROTOCOL-ORIGIN-INPUT",
        `origin segment ${index} references an unknown input`
      );
    }
    if (
      previousSegment &&
      previousSegment.generated.endByte === startByte &&
      previousSegment.origin.input === segment.origin.input
    ) {
      fail(
        "VGPU-C1-PROTOCOL-ORIGIN-CANONICAL",
        `origin segment ${index} must be merged with its adjacent equal origin`
      );
    }
    previousEnd = endByte;
    previousSegment = segment;
  }

  assertSortedUnique(
    request.languageFeatures,
    (feature) => feature,
    "language features"
  );
  assertSortedUnique(request.overrides, (item) => item.name, "override names");
  assertSortedUnique(
    request.metal.bindings,
    (binding) => coordinate(binding.group, binding.binding),
    "WGSL binding points"
  );
  for (const binding of request.metal.bindings) {
    assertSortedUnique(
      binding.slots,
      slotKey,
      `slots for @group(${binding.group}) @binding(${binding.binding})`
    );
  }

  if (
    !isDeepStrictEqual(request.metal.internalReservations, [
      immediateReservation,
    ])
  ) {
    fail(
      "VGPU-C1-PROTOCOL-INTERNAL-ABI",
      "v1 requires exactly the candidate immediate-data reservation at buffer(30)"
    );
  }
  if (
    request.metal.bindingModel !== "vgpu-metal-binding-slots-v1" ||
    request.metal.storageBufferSizes.model !==
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1" ||
    request.metal.storageBufferSizes.immediateDataByteOffset !== 4
  ) {
    fail(
      "VGPU-C1-PROTOCOL-METAL-ABI",
      "request does not implement the v1 Metal ABI"
    );
  }

  const intervals = request.metal.bindings.flatMap((binding) =>
    binding.slots.map((slot) => ({
      owner: coordinate(binding.group, binding.binding),
      resourceClass: slot.resourceClass,
      start: slot.index,
      end: slot.index + slot.count,
    }))
  );
  for (const interval of intervals) {
    if (!Number.isSafeInteger(interval.end) || interval.end > 2 ** 32) {
      fail(
        "VGPU-C1-PROTOCOL-SLOT-OVERFLOW",
        `${interval.owner} overflows UInt32`
      );
    }
    if (interval.resourceClass === "buffer" && interval.end > 30) {
      fail(
        "VGPU-C1-PROTOCOL-INTERNAL-COLLISION",
        `${interval.owner} reaches reserved Metal buffer(30)`
      );
    }
  }
  intervals.sort(
    (left, right) =>
      compare(left.resourceClass, right.resourceClass) ||
      left.start - right.start ||
      left.end - right.end
  );
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (
      previous.resourceClass === current.resourceClass &&
      current.start < previous.end
    ) {
      fail(
        "VGPU-C1-PROTOCOL-SLOT-COLLISION",
        `${previous.owner} and ${current.owner} overlap in the ${current.resourceClass} namespace`
      );
    }
  }
  return request;
}

/** Attaches only module-level provenance when a Tint range is wholly inside one segment. */
export function attachDiagnosticOrigins(request, response) {
  const enriched = structuredClone(response);
  for (const diagnostic of enriched.diagnostics ?? []) {
    const location = diagnostic.location;
    if (location !== undefined && diagnostic.phase !== "wgsl") {
      fail(
        "VGPU-C1-PROTOCOL-DIAGNOSTIC-PHASE",
        "only WGSL diagnostics may carry a generated-source location"
      );
    }
    if (!location || location.kind !== "generated-wgsl") continue;
    if (location.virtualPath !== request.source.virtualPath) {
      fail(
        "VGPU-C1-PROTOCOL-DIAGNOSTIC-SOURCE",
        "compiler diagnostic names a different generated source"
      );
    }
    const startByte = byteOffsetForLocation(
      request.source.text,
      location.start
    );
    const endByte = byteOffsetForLocation(request.source.text, location.end);
    if (endByte < startByte) {
      fail("VGPU-C1-PROTOCOL-DIAGNOSTIC-RANGE", "diagnostic range is reversed");
    }
    const segment = request.originMap.segments.find(
      (item) =>
        startByte >= item.generated.startByte &&
        startByte < item.generated.endByte &&
        endByte <= item.generated.endByte
    );
    const expected = segment
      ? { input: segment.origin.input, precision: "module" }
      : undefined;
    if (
      location.origin !== undefined &&
      !isDeepStrictEqual(location.origin, expected)
    ) {
      fail(
        "VGPU-C1-PROTOCOL-DIAGNOSTIC-ORIGIN",
        "compiler diagnostic overstates or misattributes its authored origin"
      );
    }
    if (expected) location.origin = expected;
  }
  return enriched;
}

export function assertResponseSemantics(request, response) {
  if (
    response.contractId !== COMPILER_CONTRACT ||
    response.schemaVersion !== 1
  ) {
    fail(
      "VGPU-C1-PROTOCOL-RESPONSE-CONTRACT",
      "response selects another contract"
    );
  }
  if (
    response.compiler?.name !== "vgpu-tint-compiler" ||
    response.compiler?.protocol !== 1 ||
    response.compiler?.upstream?.name !== "dawn/tint" ||
    response.compiler?.upstream?.revision !== TINT_REVISION
  ) {
    fail("VGPU-C1-PROTOCOL-COMPILER", "response compiler identity drifted");
  }
  for (const diagnostic of response.diagnostics) {
    if (diagnostic.location !== undefined && diagnostic.phase !== "wgsl") {
      fail(
        "VGPU-C1-PROTOCOL-DIAGNOSTIC-PHASE",
        "only WGSL diagnostics may carry a generated-source location"
      );
    }
  }
  const errorCount = response.diagnostics.filter(
    (item) => item.severity === "error"
  ).length;
  if (!response.ok) {
    if (response.result !== undefined || errorCount === 0) {
      fail(
        "VGPU-C1-PROTOCOL-FAILURE",
        "negative response must contain an error and no result"
      );
    }
    return response;
  }
  if (errorCount !== 0 || !response.result) {
    fail(
      "VGPU-C1-PROTOCOL-SUCCESS",
      "successful response has an error or no result"
    );
  }
  if (!isDeepStrictEqual(response.result.entryPoint, request.entryPoint)) {
    fail("VGPU-C1-PROTOCOL-ENTRY", "response changed the selected entry point");
  }
  if (!isDeepStrictEqual(response.result.bindings, request.metal.bindings)) {
    fail("VGPU-C1-PROTOCOL-BINDINGS", "response changed the external slot map");
  }
  const regions = response.result.storageBufferSizeRegions;
  const internals = response.result.internalBindings;
  if (regions.length > 0) {
    if (
      !isDeepStrictEqual(internals, [immediateReservation]) ||
      regions.length !== 1 ||
      regions[0].stage !== request.entryPoint.stage ||
      regions[0].immediateDataByteOffset !== 4
    ) {
      fail(
        "VGPU-C1-PROTOCOL-SIZE-REGION",
        "effective size region is not backed by the shared immediate-data ABI"
      );
    }
  }
  if (
    request.entryPoint.stage === "compute" &&
    response.result.resolvedWorkgroupSize === undefined
  ) {
    fail(
      "VGPU-C1-PROTOCOL-WORKGROUP",
      "compute response omitted resolved dimensions"
    );
  }
  if (
    request.entryPoint.stage !== "compute" &&
    response.result.resolvedWorkgroupSize !== undefined
  ) {
    fail(
      "VGPU-C1-PROTOCOL-WORKGROUP",
      "non-compute response returned workgroup dimensions"
    );
  }
  if (
    !hasMslEntryDeclaration(
      response.result.msl,
      request.entryPoint.stage,
      request.entryPoint.metal
    )
  ) {
    fail(
      "VGPU-C1-PROTOCOL-MSL-ENTRY",
      "MSL omits the requested emitted entry declaration"
    );
  }
  return response;
}

function byteOffsetForLocation(text, position) {
  if (
    !Number.isSafeInteger(position?.line) ||
    !Number.isSafeInteger(position?.column) ||
    position.line < 1 ||
    position.column < 1
  ) {
    fail(
      "VGPU-C1-PROTOCOL-DIAGNOSTIC-POSITION",
      "diagnostic position is invalid"
    );
  }
  const lines = text.split("\n");
  if (position.line > lines.length) {
    fail(
      "VGPU-C1-PROTOCOL-DIAGNOSTIC-POSITION",
      "diagnostic line is out of bounds"
    );
  }
  let offset = 0;
  for (let index = 0; index < position.line - 1; index += 1) {
    offset += Buffer.byteLength(lines[index], "utf8") + 1;
  }
  const lineBytes = Buffer.byteLength(lines[position.line - 1], "utf8");
  if (position.column - 1 > lineBytes) {
    fail(
      "VGPU-C1-PROTOCOL-DIAGNOSTIC-POSITION",
      "diagnostic column is out of bounds"
    );
  }
  const boundaries = new Set([0]);
  let boundary = 0;
  for (const character of lines[position.line - 1]) {
    boundary += Buffer.byteLength(character, "utf8");
    boundaries.add(boundary);
  }
  if (!boundaries.has(position.column - 1)) {
    fail(
      "VGPU-C1-PROTOCOL-DIAGNOSTIC-POSITION",
      "diagnostic column splits a UTF-8 code point"
    );
  }
  return offset + position.column - 1;
}

function assertCanonicalVirtualPath(value, label) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(
      "VGPU-C1-PROTOCOL-VIRTUAL-PATH",
      `${label} is not an NFC-normalized relative POSIX path`
    );
  }
}

function assertCanonicalInputId(value, label) {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      "VGPU-C1-PROTOCOL-INPUT-ID",
      `${label} is not an NFC-normalized logical identity`
    );
  }
}

function utf8BoundarySet(text) {
  const boundaries = new Set([0]);
  let offset = 0;
  for (const character of text) {
    offset += Buffer.byteLength(character, "utf8");
    boundaries.add(offset);
  }
  return boundaries;
}

function hasMslEntryDeclaration(msl, stage, emittedName) {
  const stageKeyword = {
    compute: "kernel",
    fragment: "fragment",
    vertex: "vertex",
  }[stage];
  const escapedName = emittedName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^\\s*${stageKeyword}\\s+[^\\n{};]*\\b${escapedName}\\s*\\(`,
    "mu"
  ).test(msl);
}

function assertSortedUnique(items, keyOf, label) {
  let previous;
  for (const item of items) {
    const key = keyOf(item);
    if (previous !== undefined && compare(previous, key) >= 0) {
      fail(
        "VGPU-C1-PROTOCOL-CANONICAL",
        `${label} are duplicated or not strictly sorted`
      );
    }
    previous = key;
  }
}

function coordinate(group, binding) {
  return `${String(group).padStart(10, "0")}:${String(binding).padStart(
    10,
    "0"
  )}`;
}

function slotKey(slot) {
  return `${slot.resourceClass}:${slot.component}:${String(slot.index).padStart(
    10,
    "0"
  )}:${String(slot.count).padStart(10, "0")}`;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message) {
  throw new CompilerProtocolError(code, message);
}
