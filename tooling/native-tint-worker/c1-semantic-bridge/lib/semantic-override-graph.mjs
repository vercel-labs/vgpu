const MAX_OVERRIDE_RECORDS = 4_096;
const MAX_OVERRIDE_MEMBERSHIPS = 8_192;
const MAX_OVERRIDE_NAME_BYTES = 256;

const wgslIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const f16Bits = /^[0-9a-f]{4}$/u;
const f32Bits = /^[0-9a-f]{8}$/u;

export function assertSemanticOverrideGraph(
  result,
  { overrideConfiguration = [], languageFeatures = [], failWith }
) {
  const fail = (code, message) => failWith(code, message);
  if (
    !Array.isArray(result?.overrides) ||
    !Array.isArray(result?.entryPoints)
  ) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-SHAPE",
      "semantic override records and entry memberships must be arrays"
    );
  }
  if (result.overrides.length > MAX_OVERRIDE_RECORDS) {
    fail(
      "VGPU-C1-SEMANTIC-RESOURCE-LIMIT",
      "semantic result exceeds the override record limit"
    );
  }

  let memberships = 0;
  for (const entry of result.entryPoints) {
    if (!Array.isArray(entry?.overrides)) {
      fail(
        "VGPU-C1-SEMANTIC-OVERRIDE-SHAPE",
        "entry override memberships must be arrays"
      );
    }
    memberships += entry.overrides.length;
    if (memberships > MAX_OVERRIDE_MEMBERSHIPS) {
      fail(
        "VGPU-C1-SEMANTIC-RESOURCE-LIMIT",
        "semantic result exceeds the override membership limit"
      );
    }
  }

  const records = new Map();
  const authoredIds = new Set();
  let previousName;
  for (const record of result.overrides) {
    assertOverrideRecord(record, languageFeatures, fail);
    if (
      previousName !== undefined &&
      compareAscii(previousName, record.name) >= 0
    ) {
      fail(
        "VGPU-C1-SEMANTIC-OVERRIDE-ORDER",
        "program overrides repeat a resolved name or are not in ASCII order"
      );
    }
    previousName = record.name;
    records.set(record.name, record);

    if (Object.hasOwn(record, "wgslId")) {
      if (authoredIds.has(record.wgslId)) {
        fail(
          "VGPU-C1-SEMANTIC-OVERRIDE-ID",
          "authored WGSL override IDs must be unique"
        );
      }
      authoredIds.add(record.wgslId);
    }
  }

  const union = new Set();
  for (const entry of result.entryPoints) {
    let previous;
    for (const name of entry.overrides) {
      if (!isResolvedName(name)) {
        fail(
          "VGPU-C1-SEMANTIC-OVERRIDE-REFERENCE",
          "entry override membership is not a resolved WGSL name"
        );
      }
      if (previous !== undefined && compareAscii(previous, name) >= 0) {
        fail(
          "VGPU-C1-SEMANTIC-OVERRIDE-ORDER",
          "entry overrides repeat a resolved name or are not in ASCII order"
        );
      }
      previous = name;
      if (!records.has(name)) {
        fail(
          "VGPU-C1-SEMANTIC-OVERRIDE-REFERENCE",
          "entry override references no program override"
        );
      }
      union.add(name);
    }
  }
  if (
    union.size !== records.size ||
    [...records.keys()].some((name) => !union.has(name))
  ) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-UNION",
      "program overrides are not the exact union of entry override sets"
    );
  }

  for (const configured of overrideConfiguration) {
    if (!wgslIdentifier.test(configured.identifier)) continue;
    const record = records.get(configured.identifier);
    if (record && Object.hasOwn(record, "wgslId")) {
      fail(
        "VGPU-C1-SEMANTIC-OVERRIDE-CONFIGURATION",
        "an override with an authored WGSL ID cannot be configured by name"
      );
    }
  }
  return result;
}

function assertOverrideRecord(record, languageFeatures, fail) {
  if (!record || typeof record !== "object" || !isResolvedName(record.name)) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-SHAPE",
      "program override has no valid resolved WGSL name"
    );
  }
  if (
    Object.hasOwn(record, "wgslId") &&
    (!Number.isInteger(record.wgslId) ||
      record.wgslId < 0 ||
      record.wgslId > 65_535)
  ) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-ID",
      "authored WGSL override ID is outside 0...65535"
    );
  }
  if (!["bool", "i32", "u32", "f16", "f32"].includes(record.type)) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-TYPE",
      "program override has an unsupported scalar type"
    );
  }
  if (record.type === "f16" && !languageFeatures.includes("f16")) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-TYPE",
      "f16 override lacks the explicit f16 language feature"
    );
  }
  if (!Object.hasOwn(record, "selected")) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-VALUE",
      "program override has no selected value"
    );
  }
  assertTypedValue(record.selected, record.type, "selected", fail);
  if (Object.hasOwn(record, "default")) {
    assertTypedValue(record.default, record.type, "default", fail);
  }
}

function assertTypedValue(value, type, role, fail) {
  if (!value || typeof value !== "object" || value.type !== type) {
    fail(
      "VGPU-C1-SEMANTIC-OVERRIDE-TYPE",
      `${role} override value disagrees with its declared type`
    );
  }
  if (type === "bool") {
    if (typeof value.value !== "boolean") invalidValue(role, type, fail);
    return;
  }
  if (type === "i32") {
    if (
      !Number.isInteger(value.value) ||
      value.value < -2_147_483_648 ||
      value.value > 2_147_483_647
    ) {
      invalidValue(role, type, fail);
    }
    return;
  }
  if (type === "u32") {
    if (
      !Number.isInteger(value.value) ||
      value.value < 0 ||
      value.value > 4_294_967_295
    ) {
      invalidValue(role, type, fail);
    }
    return;
  }
  const bits = value.bits;
  if (
    (type === "f16" &&
      (typeof bits !== "string" ||
        !f16Bits.test(bits) ||
        (Number.parseInt(bits, 16) & 0x7c00) === 0x7c00)) ||
    (type === "f32" &&
      (typeof bits !== "string" ||
        !f32Bits.test(bits) ||
        (Number.parseInt(bits, 16) & 0x7f800000) === 0x7f800000))
  ) {
    invalidValue(role, type, fail);
  }
}

function invalidValue(role, type, fail) {
  fail(
    "VGPU-C1-SEMANTIC-OVERRIDE-VALUE",
    `${role} override value is not a finite canonical ${type} value`
  );
}

function isResolvedName(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_OVERRIDE_NAME_BYTES &&
    wgslIdentifier.test(value)
  );
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
