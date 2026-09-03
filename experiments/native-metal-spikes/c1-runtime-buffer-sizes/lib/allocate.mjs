import { Buffer } from "node:buffer";

export const STORAGE_BUFFER_SIZE_MODEL =
  "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";

const STAGES = new Set(["vertex", "fragment", "compute"]);
const BINDING_ID = /^g(?:0|[1-9][0-9]*)b(?:0|[1-9][0-9]*)$/;

export class StorageBufferSizeAllocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StorageBufferSizeAllocationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StorageBufferSizeAllocationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", `${owner} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("INVALID_INPUT", `${owner} has unexpected or missing properties`);
  }
}

function integer(value, owner, minimum, maximum, code = "INVALID_INPUT") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${owner} must be an integer in ${minimum}...${maximum}`);
  }
  return value;
}

function validateProfile(profile) {
  exactKeys(
    profile,
    [
      "totalBufferSlots",
      "externalBufferCeiling",
      "immediateDataSlot",
      "immediateDataPrefixWords",
      "wordBytes",
      "uploadAlignmentBytes",
      "maxRangeBytes",
    ],
    "profile"
  );
  integer(profile.totalBufferSlots, "profile.totalBufferSlots", 1, 0xffffffff);
  integer(
    profile.externalBufferCeiling,
    "profile.externalBufferCeiling",
    1,
    profile.totalBufferSlots
  );
  integer(
    profile.immediateDataSlot,
    "profile.immediateDataSlot",
    0,
    profile.totalBufferSlots - 1
  );
  if (profile.immediateDataSlot < profile.externalBufferCeiling) {
    fail(
      "PROFILE_COLLISION",
      "immediate-data slot overlaps the external buffer interval"
    );
  }
  integer(
    profile.immediateDataPrefixWords,
    "profile.immediateDataPrefixWords",
    1,
    0xffffffff
  );
  if (profile.wordBytes !== 4 || profile.uploadAlignmentBytes !== 16) {
    fail(
      "UNSUPPORTED_TABLE_LAYOUT",
      "v1 requires four-byte words and 16-byte immediate uploads"
    );
  }
  integer(profile.maxRangeBytes, "profile.maxRangeBytes", 1, 0xffffffff);
  if (profile.maxRangeBytes !== 0xffffffff) {
    fail("UNSUPPORTED_TABLE_LAYOUT", "v1 range ceiling must be UInt32.max");
  }
}

function validateBuffer(buffer, owner, profile) {
  exactKeys(
    buffer,
    [
      "semanticBinding",
      "kind",
      "runtimeSized",
      "index",
      "count",
      "rangeBytes",
      "minimumBindingSize",
      "logicalBufferSize",
      "effectiveOffset",
    ],
    owner
  );
  if (
    typeof buffer.semanticBinding !== "string" ||
    !BINDING_ID.test(buffer.semanticBinding)
  ) {
    fail("INVALID_BINDING", `${owner}.semanticBinding is not canonical`);
  }
  if (buffer.kind !== "storage" && buffer.kind !== "uniform") {
    fail("INVALID_BINDING", `${owner}.kind must be storage or uniform`);
  }
  if (typeof buffer.runtimeSized !== "boolean") {
    fail("INVALID_BINDING", `${owner}.runtimeSized must be boolean`);
  }
  if (buffer.kind !== "storage" && buffer.runtimeSized) {
    fail("INVALID_BINDING", `${owner} cannot make a uniform runtime-sized`);
  }
  integer(buffer.index, `${owner}.index`, 0, 0xffffffff, "INVALID_SLOT");
  integer(buffer.count, `${owner}.count`, 1, 0xffffffff, "INVALID_COUNT");
  if (buffer.count !== 1) {
    fail(
      "UNSUPPORTED_BUFFER_BINDING_ARRAY",
      `${owner}.count must remain one in semantic v1`
    );
  }
  const end = buffer.index + buffer.count;
  if (!Number.isSafeInteger(end) || end > profile.externalBufferCeiling) {
    fail(
      "EXTERNAL_BUFFER_OVERFLOW",
      `${owner} crosses external buffer ceiling ${profile.externalBufferCeiling}`
    );
  }
  integer(
    buffer.logicalBufferSize,
    `${owner}.logicalBufferSize`,
    1,
    Number.MAX_SAFE_INTEGER,
    "INVALID_LOGICAL_BUFFER_SIZE"
  );
  integer(
    buffer.effectiveOffset,
    `${owner}.effectiveOffset`,
    0,
    buffer.logicalBufferSize,
    "INVALID_EFFECTIVE_OFFSET"
  );
  integer(
    buffer.minimumBindingSize,
    `${owner}.minimumBindingSize`,
    0,
    profile.maxRangeBytes,
    "INVALID_MINIMUM_BINDING_SIZE"
  );
  integer(
    buffer.rangeBytes,
    `${owner}.rangeBytes`,
    1,
    profile.maxRangeBytes,
    "INVALID_RANGE_BYTES"
  );
  if (buffer.rangeBytes < buffer.minimumBindingSize) {
    fail(
      "RANGE_BELOW_MINIMUM_BINDING_SIZE",
      `${owner}.rangeBytes is below minimumBindingSize ${buffer.minimumBindingSize}`
    );
  }
  if (
    buffer.kind === "storage" &&
    buffer.rangeBytes % profile.wordBytes !== 0
  ) {
    fail(
      "STORAGE_RANGE_NOT_WORD_ALIGNED",
      `${owner}.rangeBytes must be a multiple of ${profile.wordBytes} bytes for storage bindings`
    );
  }
  const availableBytes = buffer.logicalBufferSize - buffer.effectiveOffset;
  if (buffer.rangeBytes > availableBytes) {
    fail(
      "RANGE_EXCEEDS_LOGICAL_BUFFER",
      `${owner}.rangeBytes exceeds logicalBufferSize - effectiveOffset (${availableBytes})`
    );
  }
}

function validateInternalBinding(internal, owner, program, profile) {
  exactKeys(internal, ["role", "stage", "index", "count"], owner);
  if (internal.role !== "immediate-data") {
    fail(
      "UNKNOWN_INTERNAL_ROLE",
      `${owner}.role is not reserved by this model`
    );
  }
  if (internal.stage !== program.stage) {
    fail("INTERNAL_STAGE_MISMATCH", `${owner}.stage differs from its program`);
  }
  integer(internal.index, `${owner}.index`, 0, 0xffffffff, "INVALID_SLOT");
  integer(internal.count, `${owner}.count`, 1, 0xffffffff, "INVALID_COUNT");
  if (internal.index !== profile.immediateDataSlot || internal.count !== 1) {
    fail(
      "NON_CANONICAL_INTERNAL_SLOT",
      `${owner} must occupy buffer(${profile.immediateDataSlot})`
    );
  }
}

function validateProgram(program, profile, seenPrograms) {
  exactKeys(
    program,
    ["id", "stage", "needsStorageBufferSizes", "buffers", "internalBindings"],
    `program ${program?.id ?? "<unknown>"}`
  );
  if (typeof program.id !== "string" || program.id.length === 0) {
    fail("INVALID_PROGRAM", "program.id must be a non-empty string");
  }
  if (seenPrograms.has(program.id)) {
    fail("DUPLICATE_PROGRAM", `duplicate program ${program.id}`);
  }
  seenPrograms.add(program.id);
  if (!STAGES.has(program.stage)) {
    fail("INVALID_STAGE", `${program.id}.stage is unsupported`);
  }
  if (typeof program.needsStorageBufferSizes !== "boolean") {
    fail(
      "INVALID_PROGRAM",
      `${program.id}.needsStorageBufferSizes must be boolean`
    );
  }
  if (!Array.isArray(program.buffers) || program.buffers.length === 0) {
    fail("INVALID_PROGRAM", `${program.id}.buffers must not be empty`);
  }
  if (!Array.isArray(program.internalBindings)) {
    fail("INVALID_PROGRAM", `${program.id}.internalBindings must be an array`);
  }

  const semanticBindings = new Set();
  const intervals = [];
  for (const [index, buffer] of program.buffers.entries()) {
    const owner = `${program.id}.buffers[${index}]`;
    validateBuffer(buffer, owner, profile);
    if (semanticBindings.has(buffer.semanticBinding)) {
      fail(
        "DUPLICATE_SEMANTIC_BINDING",
        `${program.id} repeats ${buffer.semanticBinding}`
      );
    }
    semanticBindings.add(buffer.semanticBinding);
    intervals.push({
      start: buffer.index,
      end: buffer.index + buffer.count,
      owner,
    });
  }
  intervals.sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start < intervals[index - 1].end) {
      fail(
        "EXTERNAL_BUFFER_COLLISION",
        `${program.id} external buffers overlap at ${intervals[index].start}`
      );
    }
  }

  const internals = program.internalBindings;
  for (const [index, internal] of internals.entries()) {
    validateInternalBinding(
      internal,
      `${program.id}.internalBindings[${index}]`,
      program,
      profile
    );
  }
  if (internals.length > 1) {
    fail("DUPLICATE_INTERNAL_ROLE", `${program.id} repeats immediate-data`);
  }
  const runtimeStorageCount = program.buffers.filter(
    (buffer) => buffer.kind === "storage" && buffer.runtimeSized
  ).length;
  if (program.needsStorageBufferSizes) {
    if (runtimeStorageCount === 0) {
      fail(
        "TABLE_WITHOUT_RUNTIME_STORAGE",
        `${program.id} requests a size table without runtime storage`
      );
    }
    if (internals.length !== 1) {
      fail(
        "MISSING_INTERNAL_TABLE",
        `${program.id} needs the immediate-data binding`
      );
    }
  }
}

function packWords(words) {
  const bytes = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return bytes.toString("hex");
}

function projectProgram(program, profile) {
  const base = {
    id: program.id,
    stage: program.stage,
    internalBindings: program.internalBindings
      .map((internal) => ({ ...internal }))
      .sort(
        (left, right) =>
          compareText(left.role, right.role) || left.index - right.index
      ),
  };
  if (!program.needsStorageBufferSizes) {
    return { ...base, storageBufferSizes: null };
  }
  const storage = program.buffers
    .filter((buffer) => buffer.kind === "storage" && buffer.runtimeSized)
    .sort(
      (left, right) =>
        left.index - right.index ||
        compareText(left.semanticBinding, right.semanticBinding)
    );
  const wordCount = Math.max(...storage.map((buffer) => buffer.index + 1));
  const words = Array(wordCount).fill(0);
  const entries = storage.map((buffer) => {
    words[buffer.index] = buffer.rangeBytes;
    return {
      semanticBinding: buffer.semanticBinding,
      metalBufferIndex: buffer.index,
      sizeWordIndex: buffer.index,
      rangeBytes: buffer.rangeBytes,
      minimumBindingSize: buffer.minimumBindingSize,
      logicalBufferSize: buffer.logicalBufferSize,
      effectiveOffset: buffer.effectiveOffset,
      runtimeSized: buffer.runtimeSized,
    };
  });
  const prefixWords = Array(profile.immediateDataPrefixWords).fill(0);
  const unpaddedUploadWords = [...prefixWords, ...words];
  const uploadWordAlignment = profile.uploadAlignmentBytes / profile.wordBytes;
  const uploadWordCount =
    Math.ceil(unpaddedUploadWords.length / uploadWordAlignment) *
    uploadWordAlignment;
  const uploadWords = [
    ...unpaddedUploadWords,
    ...Array(uploadWordCount - unpaddedUploadWords.length).fill(0),
  ];
  return {
    ...base,
    storageBufferSizes: {
      model: STORAGE_BUFFER_SIZE_MODEL,
      internalRole: "immediate-data",
      internalSlot: profile.immediateDataSlot,
      byteOffset: profile.immediateDataPrefixWords * profile.wordBytes,
      wordCount,
      payloadByteLength: wordCount * profile.wordBytes,
      uploadWordCount,
      uploadByteLength: uploadWordCount * profile.wordBytes,
      entries,
      words,
      bytesHex: packWords(words),
      uploadWords,
      uploadBytesHex: packWords(uploadWords),
    },
  };
}

export function allocateStorageBufferSizeTables(input) {
  exactKeys(input, ["model", "profile", "programs"], "input");
  if (input.model !== STORAGE_BUFFER_SIZE_MODEL) {
    fail("UNKNOWN_MODEL", `unsupported size-table model ${input.model}`);
  }
  validateProfile(input.profile);
  if (!Array.isArray(input.programs) || input.programs.length === 0) {
    fail("INVALID_INPUT", "input.programs must contain at least one program");
  }
  const seenPrograms = new Set();
  for (const program of input.programs) {
    validateProgram(program, input.profile, seenPrograms);
  }
  return {
    model: STORAGE_BUFFER_SIZE_MODEL,
    programs: [...input.programs]
      .sort((left, right) => compareText(left.id, right.id))
      .map((program) => projectProgram(program, input.profile)),
  };
}
