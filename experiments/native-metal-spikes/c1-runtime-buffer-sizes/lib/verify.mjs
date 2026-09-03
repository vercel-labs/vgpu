const MODEL = "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";
const STAGES = new Set(["vertex", "fragment", "compute"]);

export class StorageBufferSizeVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StorageBufferSizeVerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StorageBufferSizeVerificationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("MALFORMED_PROJECTION", `${owner} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      "MALFORMED_PROJECTION",
      `${owner} has unexpected or missing properties`
    );
  }
}

function uint32BytesHex(words) {
  let result = "";
  for (const word of words) {
    for (let shift = 0; shift < 32; shift += 8) {
      result += ((word >>> shift) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return result;
}

function verifyProgram(inputProgram, projected, profile) {
  exactKeys(
    projected,
    ["id", "stage", "internalBindings", "storageBufferSizes"],
    `projection/${projected?.id}`
  );
  if (
    projected.id !== inputProgram.id ||
    projected.stage !== inputProgram.stage
  ) {
    fail("PROGRAM_IDENTITY_MISMATCH", `${inputProgram.id} identity drifted`);
  }
  if (!STAGES.has(projected.stage)) {
    fail("PROGRAM_IDENTITY_MISMATCH", `${inputProgram.id} stage is invalid`);
  }
  const expectedInternals = inputProgram.internalBindings
    .map((internal) => ({ ...internal }))
    .sort(
      (left, right) =>
        compareText(left.role, right.role) || left.index - right.index
    );
  if (
    !Array.isArray(projected.internalBindings) ||
    JSON.stringify(projected.internalBindings) !==
      JSON.stringify(expectedInternals)
  ) {
    fail(
      "INTERNAL_BINDING_MISMATCH",
      `${inputProgram.id} internal bindings drifted`
    );
  }
  for (const buffer of inputProgram.buffers) {
    if (buffer.kind !== "storage") continue;
    if (
      !Number.isSafeInteger(buffer.minimumBindingSize) ||
      buffer.minimumBindingSize < 0 ||
      buffer.minimumBindingSize > profile.maxRangeBytes ||
      !Number.isSafeInteger(buffer.rangeBytes) ||
      buffer.rangeBytes < 1 ||
      buffer.rangeBytes > profile.maxRangeBytes ||
      buffer.rangeBytes < buffer.minimumBindingSize ||
      buffer.rangeBytes % profile.wordBytes !== 0 ||
      !Number.isSafeInteger(buffer.logicalBufferSize) ||
      buffer.logicalBufferSize < 1 ||
      !Number.isSafeInteger(buffer.effectiveOffset) ||
      buffer.effectiveOffset < 0 ||
      buffer.effectiveOffset > buffer.logicalBufferSize ||
      buffer.rangeBytes > buffer.logicalBufferSize - buffer.effectiveOffset
    ) {
      fail(
        "INVALID_SOURCE_RANGE",
        `${inputProgram.id}/${buffer.semanticBinding} storage range is invalid`
      );
    }
  }
  if (!inputProgram.needsStorageBufferSizes) {
    if (projected.storageBufferSizes !== null) {
      fail("UNEXPECTED_TABLE", `${inputProgram.id} must not project a table`);
    }
    return;
  }
  exactKeys(
    projected.storageBufferSizes,
    [
      "model",
      "internalRole",
      "internalSlot",
      "byteOffset",
      "wordCount",
      "payloadByteLength",
      "uploadWordCount",
      "uploadByteLength",
      "entries",
      "words",
      "bytesHex",
      "uploadWords",
      "uploadBytesHex",
    ],
    `${inputProgram.id}.table`
  );
  const table = projected.storageBufferSizes;
  if (table.model !== MODEL) {
    fail("MODEL_MISMATCH", `${inputProgram.id} table model drifted`);
  }
  if (
    table.internalRole !== "immediate-data" ||
    table.internalSlot !== profile.immediateDataSlot ||
    table.byteOffset !== profile.immediateDataPrefixWords * profile.wordBytes
  ) {
    fail("INTERNAL_SLOT_MISMATCH", `${inputProgram.id} internal slot drifted`);
  }

  const storage = inputProgram.buffers
    .filter((buffer) => buffer.kind === "storage" && buffer.runtimeSized)
    .sort(
      (left, right) =>
        left.index - right.index ||
        compareText(left.semanticBinding, right.semanticBinding)
    );
  const expectedWordCount = Math.max(
    ...storage.map((buffer) => buffer.index + buffer.count)
  );
  const unpaddedUploadWordCount =
    profile.immediateDataPrefixWords + expectedWordCount;
  const uploadWordAlignment = profile.uploadAlignmentBytes / profile.wordBytes;
  const expectedUploadWordCount =
    Math.ceil(unpaddedUploadWordCount / uploadWordAlignment) *
    uploadWordAlignment;
  if (
    table.wordCount !== expectedWordCount ||
    table.payloadByteLength !== expectedWordCount * profile.wordBytes ||
    table.uploadWordCount !== expectedUploadWordCount ||
    table.uploadByteLength !== expectedUploadWordCount * profile.wordBytes
  ) {
    fail(
      "TABLE_EXTENT_MISMATCH",
      `${inputProgram.id} table extent is non-canonical`
    );
  }
  if (
    !Array.isArray(table.entries) ||
    table.entries.length !== storage.length
  ) {
    fail(
      "ENTRY_SET_MISMATCH",
      `${inputProgram.id} table entries differ from storage bindings`
    );
  }
  for (const [index, buffer] of storage.entries()) {
    const entry = table.entries[index];
    exactKeys(
      entry,
      [
        "semanticBinding",
        "metalBufferIndex",
        "sizeWordIndex",
        "rangeBytes",
        "minimumBindingSize",
        "logicalBufferSize",
        "effectiveOffset",
        "runtimeSized",
      ],
      `${inputProgram.id}.table.entries[${index}]`
    );
    if (
      entry.semanticBinding !== buffer.semanticBinding ||
      entry.metalBufferIndex !== buffer.index ||
      entry.sizeWordIndex !== buffer.index ||
      entry.rangeBytes !== buffer.rangeBytes ||
      entry.minimumBindingSize !== buffer.minimumBindingSize ||
      entry.logicalBufferSize !== buffer.logicalBufferSize ||
      entry.effectiveOffset !== buffer.effectiveOffset ||
      entry.runtimeSized !== buffer.runtimeSized
    ) {
      fail(
        "ENTRY_MAPPING_MISMATCH",
        `${inputProgram.id}/${buffer.semanticBinding} must use its Metal slot as the size word`
      );
    }
  }
  if (!Array.isArray(table.words) || table.words.length !== expectedWordCount) {
    fail("WORD_COUNT_MISMATCH", `${inputProgram.id} table word count drifted`);
  }
  const expectedWords = Array(expectedWordCount).fill(0);
  for (const buffer of storage) {
    expectedWords[buffer.index] = buffer.rangeBytes;
  }
  if (JSON.stringify(table.words) !== JSON.stringify(expectedWords)) {
    fail("WORD_PAYLOAD_MISMATCH", `${inputProgram.id} table words drifted`);
  }
  if (table.bytesHex !== uint32BytesHex(expectedWords)) {
    fail(
      "BYTE_PAYLOAD_MISMATCH",
      `${inputProgram.id} table bytes are not canonical little-endian`
    );
  }
  const expectedUploadWords = [
    ...Array(profile.immediateDataPrefixWords).fill(0),
    ...expectedWords,
    ...Array(
      expectedUploadWordCount -
        profile.immediateDataPrefixWords -
        expectedWordCount
    ).fill(0),
  ];
  if (
    !Array.isArray(table.uploadWords) ||
    JSON.stringify(table.uploadWords) !== JSON.stringify(expectedUploadWords)
  ) {
    fail(
      "UPLOAD_PAYLOAD_MISMATCH",
      `${inputProgram.id} immediate upload words drifted`
    );
  }
  if (table.uploadBytesHex !== uint32BytesHex(expectedUploadWords)) {
    fail(
      "UPLOAD_BYTE_PAYLOAD_MISMATCH",
      `${inputProgram.id} immediate upload bytes are not canonical little-endian`
    );
  }
}

export function verifyStorageBufferSizeTables(input, projection) {
  exactKeys(projection, ["model", "programs"], "projection");
  if (projection.model !== MODEL || input.model !== MODEL) {
    fail("MODEL_MISMATCH", "projection and input must use the v1 model");
  }
  if (!Array.isArray(projection.programs)) {
    fail("MALFORMED_PROJECTION", "projection.programs must be an array");
  }
  const inputById = new Map(
    input.programs.map((program) => [program.id, program])
  );
  if (
    inputById.size !== input.programs.length ||
    projection.programs.length !== input.programs.length
  ) {
    fail("PROGRAM_SET_MISMATCH", "projection program set drifted");
  }
  const seen = new Set();
  for (const projected of projection.programs) {
    const inputProgram = inputById.get(projected?.id);
    if (!inputProgram || seen.has(projected.id)) {
      fail(
        "PROGRAM_SET_MISMATCH",
        `unexpected or duplicate program ${projected?.id}`
      );
    }
    seen.add(projected.id);
    verifyProgram(inputProgram, projected, input.profile);
  }
  if (seen.size !== input.programs.length) {
    fail("PROGRAM_SET_MISMATCH", "projection omitted a program");
  }
}
