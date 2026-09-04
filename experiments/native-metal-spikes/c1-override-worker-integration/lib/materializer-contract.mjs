import { isDeepStrictEqual } from "node:util";

export const MATERIALIZER_CONTRACT = "vgpu-native-override-defaults-spike/v1";
export const TINT_REVISION = "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

export class OverrideIntegrationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "OverrideIntegrationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OverrideIntegrationError(code, message);
}

function assert(condition, code, message) {
  if (!condition) fail(code, message);
}

function assertExactKeys(value, expected, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} must be an object`
  );
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  assert(
    isDeepStrictEqual(actual, sortedExpected),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} keys differ: ${JSON.stringify(actual)}`
  );
}

function assertEnvelope(result) {
  assert(
    result !== null && typeof result === "object" && !Array.isArray(result),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    "materializer result must be an object"
  );
  assert(
    result.schemaVersion === 1 &&
      result.contractId === MATERIALIZER_CONTRACT &&
      result.upstreamRevision === TINT_REVISION &&
      typeof result.ok === "boolean",
    "VGPU-C1-INTEGRATION-MATERIALIZER-CONTRACT",
    "materializer envelope drifted"
  );
}

function assertAsciiIdentifier(value, label) {
  assert(
    typeof value === "string" &&
      value.length <= 256 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} is not a supported WGSL identifier`
  );
}

function assertVirtualPath(value, label) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4_096 &&
      value.isWellFormed() &&
      value.normalize("NFC") === value &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
      !value.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !value
        .split("/")
        .some(
          (component) =>
            component === "" || component === "." || component === ".."
        ),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} is not a canonical virtual path`
  );
}

function assertTypedValue(value, expectedType, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} must be a typed value`
  );
  const type = value.type;
  assert(
    type === expectedType &&
      ["bool", "i32", "u32", "f16", "f32"].includes(type),
    "VGPU-C1-INTEGRATION-MATERIALIZER-TYPE",
    `${label} has a mismatched or unsupported scalar type`
  );
  if (type === "bool") {
    assertExactKeys(value, ["type", "value"], label);
    assert(
      typeof value.value === "boolean",
      "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
      `${label} has an invalid bool payload`
    );
    return;
  }
  if (type === "i32" || type === "u32") {
    assertExactKeys(value, ["type", "value"], label);
    const minimum = type === "i32" ? -2_147_483_648 : 0;
    const maximum = type === "i32" ? 2_147_483_647 : 4_294_967_295;
    assert(
      Number.isSafeInteger(value.value) &&
        value.value >= minimum &&
        value.value <= maximum,
      "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
      `${label} has an invalid ${type} payload`
    );
    return;
  }
  assertExactKeys(value, ["bits", "type"], label);
  const pattern = type === "f16" ? /^[a-f0-9]{4}$/u : /^[a-f0-9]{8}$/u;
  assert(
    typeof value.bits === "string" && pattern.test(value.bits),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} has noncanonical floating-point bits`
  );
  const bits = Number.parseInt(value.bits, 16);
  const exponent = type === "f16" ? (bits >>> 10) & 0x1f : (bits >>> 23) & 0xff;
  assert(
    exponent !== (type === "f16" ? 0x1f : 0xff),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} must be finite`
  );
}

function assertDefaultEvaluation(value, item, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} must be an object`
  );
  if (value.status === "absent") {
    assertExactKeys(value, ["status"], label);
    assert(
      item.initializer === "absent",
      "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
      `${label} cannot be absent when the initializer is present`
    );
    return;
  }
  assert(
    item.initializer === "present",
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} requires a declared initializer`
  );
  if (value.status === "unavailable") {
    assertExactKeys(value, ["reason", "status"], label);
    assert(
      value.reason === "requires-configuration",
      "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
      `${label} has an unsupported unavailable reason`
    );
    return;
  }
  assert(
    value.status === "value",
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} has an unsupported status`
  );
  assertExactKeys(value, ["status", "value"], label);
  assertTypedValue(value.value, item.type, `${label}.value`);
}

function validateOverride(item, label) {
  assertExactKeys(
    item,
    ["defaultEvaluation", "id", "initializer", "name", "selected", "type"],
    label
  );
  assertAsciiIdentifier(item.name, `${label}.name`);
  assert(
    ["bool", "i32", "u32", "f16", "f32"].includes(item.type),
    "VGPU-C1-INTEGRATION-MATERIALIZER-TYPE",
    `${label}.type is unsupported`
  );
  assertExactKeys(item.id, ["kind", "value"], `${label}.id`);
  assert(
    (item.id.kind === "auto" || item.id.kind === "explicit") &&
      Number.isSafeInteger(item.id.value) &&
      item.id.value >= 0 &&
      item.id.value <= 65_535,
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label}.id is invalid`
  );
  assert(
    item.initializer === "present" || item.initializer === "absent",
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label}.initializer is invalid`
  );
  assertDefaultEvaluation(
    item.defaultEvaluation,
    item,
    `${label}.defaultEvaluation`
  );
  assertTypedValue(item.selected, item.type, `${label}.selected`);
  return item;
}

function validateOverrideSet(items, label) {
  assert(
    Array.isArray(items) && items.length <= 4_096,
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    `${label} must be a bounded array`
  );
  const names = new Set();
  const ids = new Set();
  let previousName;
  for (const [index, item] of items.entries()) {
    validateOverride(item, `${label}[${index}]`);
    assert(
      previousName === undefined || previousName < item.name,
      "VGPU-C1-INTEGRATION-MATERIALIZER-ORDER",
      `${label} must be strictly name-sorted`
    );
    assert(
      !names.has(item.name) && !ids.has(item.id.value),
      "VGPU-C1-INTEGRATION-MATERIALIZER-IDENTITY",
      `${label} contains duplicate override identity`
    );
    names.add(item.name);
    ids.add(item.id.value);
    previousName = item.name;
  }
  return new Map(items.map((item) => [item.name, item]));
}

function assertVerification(verification, result) {
  const baseKeys = [
    "exactStaticOverrideCount",
    "fullActiveMapAccepted",
    "singleEntryPoint",
    "substituteOverrides",
    "verifiedOverrideCount",
  ];
  const expectedKeys =
    result.entryPoint.stage === "compute"
      ? [...baseKeys, "workgroupSize", "workgroupSizeAxes"]
      : baseKeys;
  assertExactKeys(verification, expectedKeys, "verification");
  assert(
    verification.singleEntryPoint === true &&
      verification.substituteOverrides === true &&
      verification.fullActiveMapAccepted === true &&
      verification.verifiedOverrideCount === result.overrides.length &&
      verification.exactStaticOverrideCount === result.staticOverrides.length,
    "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
    "materializer omitted exact effective/static map verification evidence"
  );
  if (result.entryPoint.stage !== "compute") return;
  assert(
    Array.isArray(verification.workgroupSize) &&
      verification.workgroupSize.length === 3 &&
      verification.workgroupSize.every(
        (value) =>
          Number.isSafeInteger(value) && value >= 1 && value <= 4_294_967_295
      ),
    "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
    "materializer returned invalid resolved workgroup dimensions"
  );
  assert(
    Array.isArray(verification.workgroupSizeAxes) &&
      verification.workgroupSizeAxes.length === 3,
    "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
    "materializer returned invalid workgroup axis evidence"
  );
  for (const [index, axis] of verification.workgroupSizeAxes.entries()) {
    assertExactKeys(
      axis,
      ["kind", "overrides", "resolved"],
      `verification.workgroupSizeAxes[${index}]`
    );
    assert(
      axis.resolved === verification.workgroupSize[index] &&
        (axis.kind === "literal" || axis.kind === "override-expression") &&
        Array.isArray(axis.overrides),
      "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
      `materializer returned incoherent workgroup axis ${index}`
    );
    let previous;
    for (const name of axis.overrides) {
      assertAsciiIdentifier(name, `workgroup axis ${index} override`);
      assert(
        overrideSetHas(result.overrides, name) &&
          (previous === undefined || previous < name),
        "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
        `workgroup axis ${index} contains an unknown or unordered override`
      );
      previous = name;
    }
    assert(
      (axis.kind === "literal") === (axis.overrides.length === 0),
      "VGPU-C1-INTEGRATION-MATERIALIZER-VERIFICATION",
      `workgroup axis ${index} kind disagrees with its dependencies`
    );
  }
}

function overrideSetHas(items, name) {
  return items.some((item) => item.name === name);
}

export function materializerToExactStaticRequest(result, expected) {
  assertEnvelope(result);
  assert(
    result.ok === true,
    "VGPU-C1-INTEGRATION-MATERIALIZER-FAILED",
    "a failed materialization cannot become a compiler request"
  );
  if (!Object.hasOwn(result, "staticOverrides")) {
    fail(
      "VGPU-C1-INTEGRATION-STATIC-OVERRIDES",
      "materializer omitted the exact static override view"
    );
  }
  assertExactKeys(
    result,
    [
      "contractId",
      "entryPoint",
      "ok",
      "overrides",
      "schemaVersion",
      "sourceSha256",
      "sourceName",
      "staticOverrides",
      "upstreamRevision",
      "verification",
    ],
    "materializer success"
  );
  assertVirtualPath(result.sourceName, "materializer sourceName");
  assert(
    typeof result.sourceSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(result.sourceSha256),
    "VGPU-C1-INTEGRATION-SOURCE-HASH",
    "materializer sourceSha256 is not canonical"
  );
  assertExactKeys(result.entryPoint, ["name", "stage"], "entryPoint");
  assertAsciiIdentifier(result.entryPoint.name, "entryPoint.name");
  assert(
    ["compute", "fragment", "vertex"].includes(result.entryPoint.stage),
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    "entryPoint.stage is unsupported"
  );
  assert(
    result.sourceName === expected.sourceName &&
      result.entryPoint.name === expected.entryPoint &&
      result.entryPoint.stage === expected.stage,
    "VGPU-C1-INTEGRATION-MATERIALIZER-IDENTITY",
    "materializer result describes another source or entry point"
  );
  assert(
    typeof expected.sourceSha256 === "string" &&
      result.sourceSha256 === expected.sourceSha256,
    "VGPU-C1-INTEGRATION-SOURCE-HASH",
    "materializer result describes different source bytes"
  );
  const effectiveByName = validateOverrideSet(result.overrides, "overrides");
  const staticByName = validateOverrideSet(
    result.staticOverrides,
    "staticOverrides"
  );
  for (const [name, effective] of effectiveByName) {
    assert(
      staticByName.has(name) &&
        isDeepStrictEqual(staticByName.get(name), effective),
      "VGPU-C1-INTEGRATION-EFFECTIVE-SUBSET",
      `effective override ${name} is not identical in the static view`
    );
  }
  assertVerification(result.verification, result);
  return result.staticOverrides.map(({ name, selected }) => ({
    name,
    value: structuredClone(selected),
  }));
}

export function assertMaterializerFailure(result, expectedCode, expectedPhase) {
  assertEnvelope(result);
  assert(
    result.ok === false,
    "VGPU-C1-INTEGRATION-MATERIALIZER-FAILED",
    "expected materialization to fail"
  );
  assertExactKeys(
    result,
    ["contractId", "diagnostics", "ok", "schemaVersion", "upstreamRevision"],
    "materializer failure"
  );
  assert(
    Array.isArray(result.diagnostics) && result.diagnostics.length === 1,
    "VGPU-C1-INTEGRATION-MATERIALIZER-SHAPE",
    "materializer failure must contain one bounded diagnostic"
  );
  const diagnostic = result.diagnostics[0];
  assertExactKeys(diagnostic, ["code", "message", "phase"], "diagnostic");
  assert(
    diagnostic.code === expectedCode &&
      (expectedPhase === undefined || diagnostic.phase === expectedPhase) &&
      [
        "config",
        "inspect",
        "internal",
        "materialize",
        "request",
        "verify",
        "wgsl",
      ].includes(diagnostic.phase) &&
      typeof diagnostic.message === "string" &&
      diagnostic.message.isWellFormed() &&
      Buffer.byteLength(diagnostic.message, "utf8") <= 16_384,
    "VGPU-C1-INTEGRATION-MATERIALIZER-DIAGNOSTIC",
    `materializer did not return ${expectedCode} in the expected phase`
  );
  return result;
}
