const UINT32_MAX = 0xffff_ffff;
const UINT32_SPACE = UINT32_MAX + 1;
const MAX_STRING_LENGTH = 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export class VertexBufferSlotAllocationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "VertexBufferSlotAllocationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VertexBufferSlotAllocationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", `${owner} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, owner) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("INVALID_INPUT", `${owner} has unexpected or missing properties`);
  }
}

function array(value, owner) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${owner} must be an array`);
  return value;
}

function text(value, owner) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_STRING_LENGTH
  ) {
    fail("INVALID_INPUT", `${owner} must contain 1 to 1024 characters`);
  }
  return value;
}

function role(value, owner) {
  text(value, owner);
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    fail("INVALID_ROLE", `${owner}: ${value}`);
  }
  return value;
}

function index(value, owner) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail("INVALID_INDEX", `${owner}: ${value}`);
  }
  return value;
}

function count(value, owner, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > UINT32_MAX) {
    fail("INVALID_COUNT", `${owner}: ${value}`);
  }
  return value;
}

function endOf(start, length, owner) {
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > UINT32_SPACE) {
    fail("INTERVAL_OVERFLOW", `${owner}: ${start} + ${length}`);
  }
  return end;
}

function fingerprint(raw, owner, expectedDomain) {
  object(raw, owner);
  exactKeys(raw, ["domain", "sha256"], owner);
  const domain = text(raw.domain, `${owner}.domain`);
  const sha256 = text(raw.sha256, `${owner}.sha256`);
  if (domain !== expectedDomain || !FINGERPRINT.test(sha256)) {
    fail("INVALID_FINGERPRINT", owner);
  }
  return { domain, sha256 };
}

function normalizeMappingKey(raw, owner) {
  object(raw, owner);
  exactKeys(
    raw,
    [
      "programFingerprint",
      "runtimeProjectionFingerprint",
      "vertexLayoutFingerprint",
      "bindingProfileVersion",
    ],
    owner
  );
  const programFingerprint = fingerprint(
    raw.programFingerprint,
    `${owner}.programFingerprint`,
    "vgpu-native-program/v1"
  );
  const vertexLayoutFingerprint = text(
    raw.vertexLayoutFingerprint,
    `${owner}.vertexLayoutFingerprint`
  );
  const runtimeProjectionFingerprint = fingerprint(
    raw.runtimeProjectionFingerprint,
    `${owner}.runtimeProjectionFingerprint`,
    "vgpu-native-metal-runtime-projection/v1"
  );
  if (!FINGERPRINT.test(vertexLayoutFingerprint)) {
    fail("INVALID_FINGERPRINT", owner);
  }
  return {
    programFingerprint,
    runtimeProjectionFingerprint,
    vertexLayoutFingerprint,
    bindingProfileVersion: count(
      raw.bindingProfileVersion,
      `${owner}.bindingProfileVersion`
    ),
  };
}

function normalizeProfile(raw) {
  object(raw, "profile");
  exactKeys(
    raw,
    [
      "totalBufferSlots",
      "externalBufferCeiling",
      "maxVertexStreams",
      "staticBaselineStart",
      "internalReservations",
    ],
    "profile"
  );
  const totalBufferSlots = count(
    raw.totalBufferSlots,
    "profile.totalBufferSlots"
  );
  const externalBufferCeiling = index(
    raw.externalBufferCeiling,
    "profile.externalBufferCeiling"
  );
  const maxVertexStreams = count(
    raw.maxVertexStreams,
    "profile.maxVertexStreams"
  );
  const staticBaselineStart = index(
    raw.staticBaselineStart,
    "profile.staticBaselineStart"
  );
  if (externalBufferCeiling > totalBufferSlots) {
    fail(
      "PROFILE_OVERFLOW",
      `external ceiling ${externalBufferCeiling}, slot count ${totalBufferSlots}`
    );
  }
  if (
    endOf(staticBaselineStart, maxVertexStreams, "profile static baseline") !==
    externalBufferCeiling
  ) {
    fail(
      "NON_CANONICAL_PROFILE",
      "static baseline must end at the external buffer ceiling"
    );
  }

  const reservations = [];
  const reservationRoles = new Set();
  for (const [position, rawReservation] of array(
    raw.internalReservations,
    "profile.internalReservations"
  ).entries()) {
    const owner = `profile.internalReservations[${position}]`;
    object(rawReservation, owner);
    exactKeys(rawReservation, ["role", "index", "count"], owner);
    const reservation = {
      role: role(rawReservation.role, `${owner}.role`),
      index: index(rawReservation.index, `${owner}.index`),
      count: count(rawReservation.count, `${owner}.count`),
    };
    if (reservationRoles.has(reservation.role)) {
      fail("DUPLICATE_RESERVATION", reservation.role);
    }
    reservationRoles.add(reservation.role);
    reservations.push(reservation);
  }
  if (reservations.length === 0) {
    fail("INVALID_INPUT", "profile.internalReservations must not be empty");
  }
  reservations.sort(
    (left, right) =>
      left.index - right.index || compareText(left.role, right.role)
  );
  let cursor = externalBufferCeiling;
  for (const reservation of reservations) {
    if (reservation.index < cursor) {
      fail(
        "PROFILE_COLLISION",
        `internal ${reservation.role} overlaps the previous profile interval`
      );
    }
    if (reservation.index !== cursor) {
      fail(
        "NON_CANONICAL_PROFILE",
        `internal ${reservation.role} starts at ${reservation.index}, expected ${cursor}`
      );
    }
    cursor = endOf(
      reservation.index,
      reservation.count,
      `internal ${reservation.role}`
    );
    if (cursor > totalBufferSlots) {
      fail(
        "PROFILE_OVERFLOW",
        `internal ${reservation.role} ends at ${cursor}`
      );
    }
  }
  if (cursor !== totalBufferSlots) {
    fail(
      "NON_CANONICAL_PROFILE",
      `profile ends at ${cursor}, slot count is ${totalBufferSlots}`
    );
  }
  return {
    totalBufferSlots,
    externalBufferCeiling,
    maxVertexStreams,
    staticBaselineStart,
    reservations,
    reservationRoles,
  };
}

function normalizeShaderIntervals(rawIntervals, owner, profile) {
  const intervals = array(rawIntervals, owner).map((raw, position) => {
    const intervalOwner = `${owner}[${position}]`;
    object(raw, intervalOwner);
    exactKeys(raw, ["start", "count"], intervalOwner);
    const start = index(raw.start, `${intervalOwner}.start`);
    const intervalCount = count(raw.count, `${intervalOwner}.count`);
    const end = endOf(start, intervalCount, intervalOwner);
    if (end > profile.externalBufferCeiling) {
      fail(
        "SHADER_INTERVAL_OVERFLOW",
        `${intervalOwner} ends at ${end}, external ceiling is ${profile.externalBufferCeiling}`
      );
    }
    return { start, count: intervalCount, end };
  });
  intervals.sort(
    (left, right) => left.start - right.start || left.count - right.count
  );
  let previous;
  for (const interval of intervals) {
    if (previous && interval.start < previous.end) {
      fail(
        "SHADER_INTERVAL_COLLISION",
        `${owner} overlaps at ${interval.start}`
      );
    }
    previous = interval;
  }
  return intervals;
}

function normalizePipeline(raw, position, profile) {
  const owner = `pipelines[${position}]`;
  object(raw, owner);
  exactKeys(
    raw,
    [
      "id",
      "mappingKey",
      "shaderBufferIntervals",
      "vertexStreamCount",
      "internalRoles",
    ],
    owner
  );
  const id = text(raw.id, `${owner}.id`);
  const mappingKey = normalizeMappingKey(raw.mappingKey, `${owner}.mappingKey`);
  const shaderBufferIntervals = normalizeShaderIntervals(
    raw.shaderBufferIntervals,
    `${owner}.shaderBufferIntervals`,
    profile
  );
  const shaderOccupiedEnd = shaderBufferIntervals.reduce(
    (maximum, interval) => Math.max(maximum, interval.end),
    0
  );
  const vertexStreamCount = count(
    raw.vertexStreamCount,
    `${owner}.vertexStreamCount`,
    { allowZero: true }
  );
  if (vertexStreamCount > profile.maxVertexStreams) {
    fail(
      "VERTEX_STREAM_LIMIT",
      `${id} needs ${vertexStreamCount}, semantic maximum is ${profile.maxVertexStreams}`
    );
  }
  const availableStreamCount = Math.min(
    profile.maxVertexStreams,
    profile.externalBufferCeiling - shaderOccupiedEnd
  );
  if (vertexStreamCount > availableStreamCount) {
    fail(
      "VERTEX_RANGE_OVERFLOW",
      `${id} shader end ${shaderOccupiedEnd} plus ${vertexStreamCount} streams exceeds external ceiling ${profile.externalBufferCeiling}`
    );
  }

  const internalRoles = [];
  const seenRoles = new Set();
  for (const value of array(raw.internalRoles, `${owner}.internalRoles`)) {
    const roleName = role(value, `${owner}.internalRoles[]`);
    if (seenRoles.has(roleName)) {
      fail("DUPLICATE_INTERNAL_ROLE", `${id}/${roleName}`);
    }
    if (!profile.reservationRoles.has(roleName)) {
      fail("UNKNOWN_INTERNAL_ROLE", `${id}/${roleName}`);
    }
    seenRoles.add(roleName);
    internalRoles.push(roleName);
  }
  return {
    id,
    mappingKey,
    shaderBufferIntervals: shaderBufferIntervals.map(({ start, count }) => ({
      start,
      count,
    })),
    shaderOccupiedEnd,
    vertexStreamCount,
    availableStreamCount,
    internalRoles,
  };
}

function mappingKeyIdentity(mappingKey) {
  return [
    mappingKey.programFingerprint.domain,
    mappingKey.programFingerprint.sha256,
    mappingKey.runtimeProjectionFingerprint.domain,
    mappingKey.runtimeProjectionFingerprint.sha256,
    mappingKey.vertexLayoutFingerprint,
    mappingKey.bindingProfileVersion,
  ].join("/");
}

function mappingInputsIdentity(pipeline) {
  return JSON.stringify({
    shaderBufferIntervals: pipeline.shaderBufferIntervals,
    vertexStreamCount: pipeline.vertexStreamCount,
    internalRoles: [...pipeline.internalRoles].sort(compareText),
  });
}

/**
 * Projects artifact-fixed shader/internal slots plus pipeline-local vertex streams.
 * The static partition is emitted only as a comparison baseline.
 */
export function allocateVertexBufferSlots(input) {
  object(input, "input");
  exactKeys(input, ["profile", "pipelines"], "input");
  const profile = normalizeProfile(input.profile);
  const sourcePipelines = array(input.pipelines, "pipelines");
  if (sourcePipelines.length === 0) {
    fail("INVALID_INPUT", "pipelines must contain at least one case");
  }
  const pipelines = sourcePipelines.map((pipeline, position) =>
    normalizePipeline(pipeline, position, profile)
  );
  const ids = new Set();
  const mappingKeys = new Map();
  for (const pipeline of pipelines) {
    if (ids.has(pipeline.id)) fail("DUPLICATE_PIPELINE", pipeline.id);
    ids.add(pipeline.id);
    const identity = mappingKeyIdentity(pipeline.mappingKey);
    const inputsIdentity = mappingInputsIdentity(pipeline);
    if (
      mappingKeys.has(identity) &&
      mappingKeys.get(identity) !== inputsIdentity
    ) {
      fail(
        "MAPPING_KEY_COLLISION",
        `${pipeline.id} reuses a mapping key with incompatible inputs`
      );
    }
    mappingKeys.set(identity, inputsIdentity);
  }

  const sortedPipelines = [...pipelines].sort((left, right) =>
    compareText(left.id, right.id)
  );
  return {
    staticBaseline: {
      vertexInputRange: {
        start: profile.staticBaselineStart,
        endExclusive: profile.externalBufferCeiling,
        maxStreams: profile.maxVertexStreams,
      },
      pipelines: sortedPipelines.map((pipeline) => {
        const supported =
          pipeline.shaderOccupiedEnd <= profile.staticBaselineStart;
        return {
          id: pipeline.id,
          status: supported ? "supported" : "rejected",
          reason: supported
            ? null
            : "shader-occupied-end-exceeds-static-boundary",
          vertexStreams: supported
            ? Array.from(
                { length: pipeline.vertexStreamCount },
                (_, stream) => ({
                  stream,
                  metalIndex: profile.staticBaselineStart + stream,
                })
              )
            : [],
        };
      }),
    },
    pipelines: sortedPipelines.map((pipeline) => ({
      id: pipeline.id,
      mappingKey: { ...pipeline.mappingKey },
      shaderBufferIntervals: pipeline.shaderBufferIntervals.map((interval) => ({
        ...interval,
      })),
      shaderOccupiedEnd: pipeline.shaderOccupiedEnd,
      internalBindings: profile.reservations
        .filter((reservation) =>
          pipeline.internalRoles.includes(reservation.role)
        )
        .map((reservation) => ({ ...reservation }))
        .sort((left, right) => compareText(left.role, right.role)),
      vertexInputRange: {
        start: pipeline.shaderOccupiedEnd,
        endExclusive: profile.externalBufferCeiling,
        maxStreams: pipeline.availableStreamCount,
      },
      vertexStreams: Array.from(
        { length: pipeline.vertexStreamCount },
        (_, stream) => ({
          stream,
          metalIndex: pipeline.shaderOccupiedEnd + stream,
        })
      ),
    })),
  };
}
