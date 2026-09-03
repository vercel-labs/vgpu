const UINT32_MAX = 0xffff_ffff;
const UINT32_SPACE = UINT32_MAX + 1;
const MAX_STRING_LENGTH = 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export class VertexBufferSlotVerificationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "VertexBufferSlotVerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VertexBufferSlotVerificationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function object(value, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_SHAPE", `${owner} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, owner) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (!sameJSON(actual, expected)) {
    fail("INVALID_SHAPE", `${owner} has unexpected or missing properties`);
  }
}

function array(value, owner) {
  if (!Array.isArray(value)) fail("INVALID_SHAPE", `${owner} must be an array`);
  return value;
}

function text(value, owner) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > MAX_STRING_LENGTH
  ) {
    fail("INVALID_SHAPE", `${owner} must contain 1 to 1024 characters`);
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
    fail("INTERVAL_OVERFLOW", owner);
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

function normalizeInput(input) {
  object(input, "input");
  exactKeys(input, ["profile", "pipelines"], "input");
  const rawProfile = object(input.profile, "profile");
  exactKeys(
    rawProfile,
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
    rawProfile.totalBufferSlots,
    "profile.totalBufferSlots"
  );
  const externalBufferCeiling = index(
    rawProfile.externalBufferCeiling,
    "profile.externalBufferCeiling"
  );
  const maxVertexStreams = count(
    rawProfile.maxVertexStreams,
    "profile.maxVertexStreams"
  );
  const staticBaselineStart = index(
    rawProfile.staticBaselineStart,
    "profile.staticBaselineStart"
  );
  if (externalBufferCeiling > totalBufferSlots) {
    fail("PROFILE_OVERFLOW", `${externalBufferCeiling}/${totalBufferSlots}`);
  }
  if (
    endOf(staticBaselineStart, maxVertexStreams, "static baseline") !==
    externalBufferCeiling
  ) {
    fail("NON_CANONICAL_PROFILE", "static baseline does not end at ceiling");
  }

  const reservations = [];
  const reservationRoles = new Set();
  for (const [position, raw] of array(
    rawProfile.internalReservations,
    "profile.internalReservations"
  ).entries()) {
    const owner = `profile.internalReservations[${position}]`;
    object(raw, owner);
    exactKeys(raw, ["role", "index", "count"], owner);
    const reservation = {
      role: role(raw.role, `${owner}.role`),
      index: index(raw.index, `${owner}.index`),
      count: count(raw.count, `${owner}.count`),
    };
    if (reservationRoles.has(reservation.role)) {
      fail("DUPLICATE_RESERVATION", reservation.role);
    }
    reservationRoles.add(reservation.role);
    reservations.push(reservation);
  }
  if (reservations.length === 0) {
    fail("INVALID_SHAPE", "profile.internalReservations must not be empty");
  }
  reservations.sort(
    (left, right) =>
      left.index - right.index || compareText(left.role, right.role)
  );
  let reservationCursor = externalBufferCeiling;
  for (const reservation of reservations) {
    if (reservation.index < reservationCursor) {
      fail("PROFILE_COLLISION", reservation.role);
    }
    if (reservation.index !== reservationCursor) {
      fail("NON_CANONICAL_PROFILE", reservation.role);
    }
    reservationCursor = endOf(
      reservation.index,
      reservation.count,
      reservation.role
    );
    if (reservationCursor > totalBufferSlots) {
      fail("PROFILE_OVERFLOW", reservation.role);
    }
  }
  if (reservationCursor !== totalBufferSlots) {
    fail("NON_CANONICAL_PROFILE", "reservation tail");
  }

  const rawPipelines = array(input.pipelines, "pipelines");
  if (rawPipelines.length === 0) {
    fail("INVALID_SHAPE", "pipelines must contain at least one case");
  }
  const pipelines = [];
  const ids = new Set();
  const mappingKeys = new Map();
  for (const [position, raw] of rawPipelines.entries()) {
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
    if (ids.has(id)) fail("DUPLICATE_PIPELINE", id);
    ids.add(id);
    const mappingKey = normalizeMappingKey(
      raw.mappingKey,
      `${owner}.mappingKey`
    );
    const shaderBufferIntervals = array(
      raw.shaderBufferIntervals,
      `${owner}.shaderBufferIntervals`
    ).map((rawInterval, intervalPosition) => {
      const intervalOwner = `${owner}.shaderBufferIntervals[${intervalPosition}]`;
      object(rawInterval, intervalOwner);
      exactKeys(rawInterval, ["start", "count"], intervalOwner);
      const start = index(rawInterval.start, `${intervalOwner}.start`);
      const intervalCount = count(rawInterval.count, `${intervalOwner}.count`);
      const end = endOf(start, intervalCount, intervalOwner);
      if (end > externalBufferCeiling) {
        fail("SHADER_INTERVAL_OVERFLOW", intervalOwner);
      }
      return { start, count: intervalCount, end };
    });
    shaderBufferIntervals.sort(
      (left, right) => left.start - right.start || left.count - right.count
    );
    let previous;
    for (const interval of shaderBufferIntervals) {
      if (previous && interval.start < previous.end) {
        fail("SHADER_INTERVAL_COLLISION", id);
      }
      previous = interval;
    }
    const shaderOccupiedEnd = shaderBufferIntervals.reduce(
      (maximum, interval) => Math.max(maximum, interval.end),
      0
    );
    const vertexStreamCount = count(
      raw.vertexStreamCount,
      `${owner}.vertexStreamCount`,
      { allowZero: true }
    );
    if (vertexStreamCount > maxVertexStreams) {
      fail("VERTEX_STREAM_LIMIT", id);
    }
    const availableStreamCount = Math.min(
      maxVertexStreams,
      externalBufferCeiling - shaderOccupiedEnd
    );
    if (vertexStreamCount > availableStreamCount) {
      fail("VERTEX_RANGE_OVERFLOW", id);
    }
    const internalRoles = [];
    const seenRoles = new Set();
    for (const rawRole of array(raw.internalRoles, `${owner}.internalRoles`)) {
      const roleName = role(rawRole, `${owner}.internalRoles[]`);
      if (seenRoles.has(roleName)) {
        fail("DUPLICATE_INTERNAL_ROLE", `${id}/${roleName}`);
      }
      if (!reservationRoles.has(roleName)) {
        fail("UNKNOWN_INTERNAL_ROLE", `${id}/${roleName}`);
      }
      seenRoles.add(roleName);
      internalRoles.push(roleName);
    }
    const mappingIdentity = [
      mappingKey.programFingerprint.domain,
      mappingKey.programFingerprint.sha256,
      mappingKey.runtimeProjectionFingerprint.domain,
      mappingKey.runtimeProjectionFingerprint.sha256,
      mappingKey.vertexLayoutFingerprint,
      mappingKey.bindingProfileVersion,
    ].join("/");
    const mappingInputs = JSON.stringify({
      shaderBufferIntervals: shaderBufferIntervals.map(({ start, count }) => ({
        start,
        count,
      })),
      vertexStreamCount,
      internalRoles: [...internalRoles].sort(compareText),
    });
    if (
      mappingKeys.has(mappingIdentity) &&
      mappingKeys.get(mappingIdentity) !== mappingInputs
    ) {
      fail("MAPPING_KEY_COLLISION", id);
    }
    mappingKeys.set(mappingIdentity, mappingInputs);
    pipelines.push({
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
    });
  }
  pipelines.sort((left, right) => compareText(left.id, right.id));
  return {
    totalBufferSlots,
    externalBufferCeiling,
    maxVertexStreams,
    staticBaselineStart,
    reservations,
    pipelines,
  };
}

function expectedProjection(model) {
  return {
    staticBaseline: {
      vertexInputRange: {
        start: model.staticBaselineStart,
        endExclusive: model.externalBufferCeiling,
        maxStreams: model.maxVertexStreams,
      },
      pipelines: model.pipelines.map((pipeline) => {
        const supported =
          pipeline.shaderOccupiedEnd <= model.staticBaselineStart;
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
                  metalIndex: model.staticBaselineStart + stream,
                })
              )
            : [],
        };
      }),
    },
    pipelines: model.pipelines.map((pipeline) => ({
      id: pipeline.id,
      mappingKey: { ...pipeline.mappingKey },
      shaderBufferIntervals: pipeline.shaderBufferIntervals.map((interval) => ({
        ...interval,
      })),
      shaderOccupiedEnd: pipeline.shaderOccupiedEnd,
      internalBindings: model.reservations
        .filter((reservation) =>
          pipeline.internalRoles.includes(reservation.role)
        )
        .map((reservation) => ({ ...reservation }))
        .sort((left, right) => compareText(left.role, right.role)),
      vertexInputRange: {
        start: pipeline.shaderOccupiedEnd,
        endExclusive: model.externalBufferCeiling,
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

function validateRange(raw, owner) {
  object(raw, owner);
  exactKeys(raw, ["start", "endExclusive", "maxStreams"], owner);
  const start = index(raw.start, `${owner}.start`);
  const endExclusive = index(raw.endExclusive, `${owner}.endExclusive`);
  const maxStreams = count(raw.maxStreams, `${owner}.maxStreams`, {
    allowZero: true,
  });
  if (start > endExclusive) fail("INVALID_RANGE", owner);
  if (maxStreams > endExclusive - start) fail("INVALID_RANGE", owner);
  return { start, endExclusive, maxStreams };
}

function validateStreams(raw, owner) {
  return array(raw, owner).map((slot, position) => {
    const slotOwner = `${owner}[${position}]`;
    object(slot, slotOwner);
    exactKeys(slot, ["stream", "metalIndex"], slotOwner);
    return {
      stream: index(slot.stream, `${slotOwner}.stream`),
      metalIndex: index(slot.metalIndex, `${slotOwner}.metalIndex`),
    };
  });
}

function validateObservedIntervals(model, pipeline, owner) {
  const intervals = [];
  for (const [position, interval] of pipeline.shaderBufferIntervals.entries()) {
    intervals.push({
      start: interval.start,
      end: endOf(interval.start, interval.count, `${owner}/shader/${position}`),
      owner: `shader-${position}`,
    });
  }
  for (const slot of pipeline.vertexStreams) {
    intervals.push({
      start: slot.metalIndex,
      end: endOf(slot.metalIndex, 1, `${owner}/vertex/${slot.stream}`),
      owner: `vertex-${slot.stream}`,
    });
  }
  for (const slot of pipeline.internalBindings) {
    intervals.push({
      start: slot.index,
      end: endOf(slot.index, slot.count, `${owner}/internal/${slot.role}`),
      owner: `internal-${slot.role}`,
    });
  }
  intervals.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      compareText(left.owner, right.owner)
  );
  let previous;
  for (const interval of intervals) {
    if (interval.end > model.totalBufferSlots) {
      fail("SLOT_OVERFLOW", `${owner}/${interval.owner}`);
    }
    if (previous && interval.start < previous.end) {
      fail("SLOT_COLLISION", `${owner}/${previous.owner}/${interval.owner}`);
    }
    previous = interval;
  }
}

function validateObservedProjection(model, projection) {
  object(projection, "projection");
  exactKeys(projection, ["staticBaseline", "pipelines"], "projection");
  const baseline = object(projection.staticBaseline, "staticBaseline");
  exactKeys(baseline, ["vertexInputRange", "pipelines"], "staticBaseline");
  validateRange(baseline.vertexInputRange, "staticBaseline.vertexInputRange");
  for (const [position, pipeline] of array(
    baseline.pipelines,
    "staticBaseline.pipelines"
  ).entries()) {
    const owner = `staticBaseline.pipelines[${position}]`;
    object(pipeline, owner);
    exactKeys(pipeline, ["id", "status", "reason", "vertexStreams"], owner);
    text(pipeline.id, `${owner}.id`);
    if (pipeline.status !== "supported" && pipeline.status !== "rejected") {
      fail("INVALID_STATUS", owner);
    }
    if (
      pipeline.reason !== null &&
      (typeof pipeline.reason !== "string" || pipeline.reason.length === 0)
    ) {
      fail("INVALID_STATUS", `${owner}.reason`);
    }
    validateStreams(pipeline.vertexStreams, `${owner}.vertexStreams`);
  }

  for (const [position, pipeline] of array(
    projection.pipelines,
    "projection.pipelines"
  ).entries()) {
    const owner = `projection.pipelines[${position}]`;
    object(pipeline, owner);
    exactKeys(
      pipeline,
      [
        "id",
        "mappingKey",
        "shaderBufferIntervals",
        "shaderOccupiedEnd",
        "internalBindings",
        "vertexInputRange",
        "vertexStreams",
      ],
      owner
    );
    text(pipeline.id, `${owner}.id`);
    normalizeMappingKey(pipeline.mappingKey, `${owner}.mappingKey`);
    const shaderBufferIntervals = array(
      pipeline.shaderBufferIntervals,
      `${owner}.shaderBufferIntervals`
    ).map((interval, intervalPosition) => {
      const intervalOwner = `${owner}.shaderBufferIntervals[${intervalPosition}]`;
      object(interval, intervalOwner);
      exactKeys(interval, ["start", "count"], intervalOwner);
      return {
        start: index(interval.start, `${intervalOwner}.start`),
        count: count(interval.count, `${intervalOwner}.count`),
      };
    });
    index(pipeline.shaderOccupiedEnd, `${owner}.shaderOccupiedEnd`);
    const vertexInputRange = validateRange(
      pipeline.vertexInputRange,
      `${owner}.vertexInputRange`
    );
    const vertexStreams = validateStreams(
      pipeline.vertexStreams,
      `${owner}.vertexStreams`
    );
    const internalBindings = array(
      pipeline.internalBindings,
      `${owner}.internalBindings`
    ).map((slot, slotPosition) => {
      const slotOwner = `${owner}.internalBindings[${slotPosition}]`;
      object(slot, slotOwner);
      exactKeys(slot, ["role", "index", "count"], slotOwner);
      return {
        role: role(slot.role, `${slotOwner}.role`),
        index: index(slot.index, `${slotOwner}.index`),
        count: count(slot.count, `${slotOwner}.count`),
      };
    });
    validateObservedIntervals(
      model,
      {
        shaderBufferIntervals,
        vertexInputRange,
        vertexStreams,
        internalBindings,
      },
      owner
    );
  }
}

/** Verifies the hybrid projection without importing or invoking the allocator. */
export function verifyVertexBufferSlots(input, projection) {
  const model = normalizeInput(input);
  validateObservedProjection(model, projection);
  const expected = expectedProjection(model);
  if (!sameJSON(projection, expected)) {
    fail("PROJECTION_MISMATCH", "projection is incomplete or non-canonical");
  }
  return true;
}
