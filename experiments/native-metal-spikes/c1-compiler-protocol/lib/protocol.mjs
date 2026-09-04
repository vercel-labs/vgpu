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
  assertCanonicalJsonNumbers(request, "request");
  if (request.contractId !== COMPILER_CONTRACT || request.schemaVersion !== 1) {
    fail("VGPU-C1-PROTOCOL-CONTRACT", "request selects another contract");
  }
  const collectionSizes = [
    ["origin sources", request.originMap.sources.length, 4_096],
    ["origin segments", request.originMap.segments.length, 65_536],
    ["overrides", request.overrides.length, 4_096],
    ["language features", request.languageFeatures.length, 5],
    ["bindings", request.metal.bindings.length, 65_536],
    ["interface inputs", request.semanticInterface.inputs.length, 64],
    ["interface outputs", request.semanticInterface.outputs.length, 64],
  ];
  if (
    Buffer.byteLength(request.source.text, "utf8") > 16 * 1024 * 1024 ||
    collectionSizes.some(([, size, maximum]) => size > maximum) ||
    jsonAllocationUnits(request) > 262_144
  ) {
    fail(
      "VGPU-C1-PROTOCOL-RESOURCE-LIMIT",
      "request exceeds an experimental worker resource limit"
    );
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
  assertSemanticInterface(request);
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

export function jsonAllocationUnits(value) {
  if (Array.isArray(value)) {
    return (
      1 + value.reduce((total, item) => total + jsonAllocationUnits(item), 0)
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce(
      (total, [, item]) => total + 1 + jsonAllocationUnits(item),
      1
    );
  }
  return 1;
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
  assertCanonicalJsonNumbers(response, "response");
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
  if (
    !isDeepStrictEqual(
      response.result.interface,
      expectedMetalInterface(request.semanticInterface)
    )
  ) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "response changed or compacted the exact Metal interface projection"
    );
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
  const code = maskMslCommentsAndLiterals(msl);
  return new RegExp(
    `^\\s*${stageKeyword}\\s+[^{};]*\\b${escapedName}\\s*\\([^{};]*\\)\\s*\\{`,
    "mu"
  ).test(code);
}

function maskMslCommentsAndLiterals(msl) {
  let code = "";
  let state = "code";
  for (let index = 0; index < msl.length; index += 1) {
    const character = msl[index];
    const next = msl[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        code += "\n";
        state = "code";
      } else {
        code += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        code += "  ";
        index += 1;
        state = "code";
      } else {
        code += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "string" || state === "character") {
      if (character === "\\" && next !== undefined) {
        code += next === "\n" ? " \n" : "  ";
        index += 1;
      } else {
        code += character === "\n" ? "\n" : " ";
        if (
          (state === "string" && character === '"') ||
          (state === "character" && character === "'")
        ) {
          state = "code";
        }
      }
      continue;
    }
    if (character === "/" && next === "/") {
      code += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      code += "  ";
      index += 1;
      state = "block-comment";
    } else if (character === '"') {
      code += " ";
      state = "string";
    } else if (character === "'") {
      code += " ";
      state = "character";
    } else {
      code += character;
    }
  }
  return code;
}

function assertCanonicalJsonNumbers(root, label) {
  const pending = [{ path: label, value: root }];
  while (pending.length > 0) {
    const { path, value } = pending.pop();
    if (typeof value === "number" && Object.is(value, -0)) {
      fail(
        "VGPU-C1-PROTOCOL-CANONICAL",
        `${path} contains non-canonical negative zero`
      );
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ path: `${path}[${index}]`, value: value[index] });
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        pending.push({ path: `${path}.${key}`, value: child });
      }
    }
  }
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

const builtinTypes = new Map([
  ["vertex:inputs:vertex_index", "u32:1"],
  ["vertex:inputs:instance_index", "u32:1"],
  ["vertex:outputs:position", "f32:4"],
  ["fragment:inputs:position", "f32:4"],
  ["fragment:inputs:front_facing", "bool:1"],
  ["fragment:inputs:sample_index", "u32:1"],
  ["fragment:inputs:sample_mask", "u32:1"],
  ["fragment:outputs:frag_depth", "f32:1"],
  ["fragment:outputs:sample_mask", "u32:1"],
  ["compute:inputs:local_invocation_id", "u32:3"],
  ["compute:inputs:local_invocation_index", "u32:1"],
  ["compute:inputs:global_invocation_id", "u32:3"],
  ["compute:inputs:workgroup_id", "u32:3"],
  ["compute:inputs:num_workgroups", "u32:3"],
]);

function interfaceValueKey(value) {
  if (value.location !== undefined) {
    const blend = value.blendSource === undefined ? 0 : value.blendSource + 1;
    return `0:${String(value.location).padStart(10, "0")}:${blend}`;
  }
  return `1:${value.builtin}`;
}

function interfaceTypeKey(type) {
  return `${type.scalar}:${type.width}`;
}

function assertSemanticInterface(request) {
  const shaderInterface = request.semanticInterface;
  if (shaderInterface.kind !== request.entryPoint.stage) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "semantic interface kind differs from the selected entry-point stage"
    );
  }
  for (const direction of ["inputs", "outputs"]) {
    const values = shaderInterface[direction];
    assertSortedUnique(
      values,
      interfaceValueKey,
      `${shaderInterface.kind} interface ${direction}`
    );
    for (const value of values) {
      if (shaderInterface.kind === "compute" && value.location !== undefined) {
        fail(
          "VGPU-C1-PROTOCOL-INTERFACE",
          "compute interface values must use builtins"
        );
      }
      if (
        value.type.scalar === "f16" &&
        !request.languageFeatures.includes("f16")
      ) {
        fail(
          "VGPU-C1-PROTOCOL-INTERFACE",
          "f16 interface type requires the f16 language feature"
        );
      }
      if (value.builtin !== undefined) {
        const key = `${shaderInterface.kind}:${direction}:${value.builtin}`;
        if (builtinTypes.get(key) !== interfaceTypeKey(value.type)) {
          fail(
            "VGPU-C1-PROTOCOL-INTERFACE",
            `builtin ${value.builtin} has the wrong scalar or vector width`
          );
        }
      } else if (
        (value.type.scalar === "i32" || value.type.scalar === "u32") &&
        (value.interpolation?.type === undefined ||
          value.interpolation.type !== "flat") &&
        ((shaderInterface.kind === "vertex" && direction === "outputs") ||
          (shaderInterface.kind === "fragment" && direction === "inputs"))
      ) {
        fail(
          "VGPU-C1-PROTOCOL-INTERFACE",
          "integral inter-stage locations require flat interpolation"
        );
      }
    }
  }

  if (
    shaderInterface.kind === "vertex" &&
    shaderInterface.outputs.filter((value) => value.builtin === "position")
      .length !== 1
  ) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "vertex interface must contain exactly one position output"
    );
  }
  const vertexAttributes =
    shaderInterface.kind === "vertex"
      ? shaderInterface.inputs.filter((value) => value.location !== undefined)
      : [];
  if (vertexAttributes.some((value) => value.location > 30)) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "vertex input location exceeds Metal attribute(30)"
    );
  }
  const colorOutputs =
    shaderInterface.kind === "fragment"
      ? shaderInterface.outputs.filter((value) => value.location !== undefined)
      : [];
  if (colorOutputs.some((value) => value.location > 7)) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "fragment output location exceeds Metal color(7)"
    );
  }
  const dualSource = colorOutputs.filter(
    (value) => value.blendSource !== undefined
  );
  if (
    dualSource.length > 0 &&
    !request.languageFeatures.includes("dual_source_blending")
  ) {
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
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
    fail(
      "VGPU-C1-PROTOCOL-INTERFACE",
      "dual-source outputs must be the exact same-type location(0) source 0/1 pair"
    );
  }
}

function expectedMetalInterface(shaderInterface) {
  if (shaderInterface.kind === "vertex") {
    return {
      kind: "vertex",
      attributes: shaderInterface.inputs
        .filter((value) => value.location !== undefined)
        .map((value) => ({
          semantic: { location: value.location },
          metal: { attribute: value.location },
        })),
    };
  }
  if (shaderInterface.kind === "fragment") {
    return {
      kind: "fragment",
      colorOutputs: shaderInterface.outputs
        .filter((value) => value.location !== undefined)
        .map((value) => ({
          semantic: {
            location: value.location,
            ...(value.blendSource === undefined
              ? {}
              : { blendSource: value.blendSource }),
          },
          metal: {
            color: value.location,
            ...(value.blendSource === undefined
              ? {}
              : { index: value.blendSource }),
          },
        })),
    };
  }
  return { kind: "compute" };
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code, message) {
  throw new CompilerProtocolError(code, message);
}
