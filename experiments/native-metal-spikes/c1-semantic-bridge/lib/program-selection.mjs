import { isAuthenticatedEntryInventory } from "./authenticated-inventory.mjs";

export const FULLSCREEN_TRIANGLE_INJECTION_PROFILE =
  "vgpu-native-fullscreen-triangle/v1";

const programKinds = new Set(["effect", "draw", "compute"]);
const programKeys = new Set(["name", "source", "kind", "entryPoints"]);
const stageOrder = ["vertex", "fragment", "compute"];
const stagesForKind = Object.freeze({
  effect: Object.freeze(["vertex", "fragment"]),
  draw: Object.freeze(["vertex", "fragment"]),
  compute: Object.freeze(["compute"]),
});
const wgslIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const programSelectionPlans = new WeakSet();

export class ProgramSelectionError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ProgramSelectionError";
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Selects one normalized native program from an exact configuration-owned
 * selection view and a successful authenticated Tint inventory. This function
 * deliberately receives no overrides, WGSL, or resolver reflection, so it
 * cannot become a second shader parser.
 */
export function selectProgramEntries(selectionView, inventory) {
  if (!isAuthenticatedEntryInventory(inventory)) {
    selectionFail(
      "VGPU-C1-PROGRAM-INVENTORY",
      "program selection requires an authenticated successful entry inventory"
    );
  }

  const normalized = normalizeSelectionView(selectionView);
  if (normalized.source !== inventory.configSource) {
    selectionFail(
      "VGPU-C1-PROGRAM-INVENTORY",
      `program ${quoted(
        normalized.name
      )} was paired with another source inventory`,
      {
        program: normalized.name,
        kind: normalized.kind,
      }
    );
  }

  const selected = {};
  for (const stage of stageOrder) {
    if (!stagesForKind[normalized.kind].includes(stage)) continue;
    Object.defineProperty(selected, stage, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: selectStage({
        program: normalized,
        inventory,
        stage,
        requested: normalized.entryPoints[stage],
        injectWhenMissing: normalized.kind === "effect" && stage === "vertex",
      }),
    });
  }

  return freezeSelectionPlan({
    name: normalized.name,
    source: normalized.source,
    kind: normalized.kind,
    inventoryRequestIdentity: inventory.requestIdentity,
    entryPoints: selected,
  });
}

export function isProgramSelectionPlan(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    programSelectionPlans.has(value)
  );
}

function normalizeSelectionView(program) {
  if (!isPlainObject(program)) {
    selectionFail("VGPU-C1-PROGRAM-CONFIG", "program must be a plain object");
  }
  const properties = ownDataProperties(program, programKeys, "program");
  const kind = properties.has("kind") ? properties.get("kind") : "effect";
  if (!programKinds.has(kind)) {
    selectionFail(
      "VGPU-C1-PROGRAM-CONFIG",
      `program kind ${quoted(kind)} is not effect, draw, or compute`
    );
  }
  const name = properties.get("name");
  if (typeof name !== "string" || name.length === 0) {
    selectionFail(
      "VGPU-C1-PROGRAM-CONFIG",
      "program name must be a non-empty string",
      { kind }
    );
  }
  const source = properties.get("source");
  if (typeof source !== "string" || source.length === 0) {
    selectionFail(
      "VGPU-C1-PROGRAM-CONFIG",
      `program ${quoted(name)} source must be a non-empty string`,
      { program: name, kind }
    );
  }

  const rawEntryPoints = properties.has("entryPoints")
    ? properties.get("entryPoints")
    : {};
  if (!isPlainObject(rawEntryPoints)) {
    selectionFail(
      "VGPU-C1-PROGRAM-CONFIG",
      `program ${quoted(name)} entryPoints must be a plain object`,
      { program: name, kind }
    );
  }
  const allowed = new Set(stagesForKind[kind]);
  const rawEntries = ownDataProperties(
    rawEntryPoints,
    allowed,
    `program ${quoted(name)} entryPoints`,
    { program: name, kind }
  );
  const entryPoints = Object.create(null);
  for (const [key, value] of rawEntries) {
    if (
      typeof value !== "string" ||
      value.length > 256 ||
      !wgslIdentifier.test(value)
    ) {
      selectionFail(
        "VGPU-C1-PROGRAM-CONFIG",
        `program ${quoted(
          name
        )} entryPoints.${key} must be a WGSL identifier string`,
        { program: name, kind, stage: key }
      );
    }
    entryPoints[key] = value;
  }

  return { name, source, kind, entryPoints };
}

function selectStage({
  program,
  inventory,
  stage,
  requested,
  injectWhenMissing,
}) {
  const candidates = inventory.entryPoints.filter(
    (entry) => entry.stage === stage
  );
  const available = inventory.entryPoints.map((entry) => ({ ...entry }));
  if (requested !== undefined) {
    const named = inventory.entryPoints.find(
      (entry) => entry.wgsl === requested
    );
    if (!named) {
      selectionFail(
        "VGPU-C1-PROGRAM-ENTRY-UNKNOWN",
        `program ${quoted(
          program.name
        )} selects unknown @${stage} entry ${quoted(requested)}`,
        selectionDetails(program, stage, available, requested)
      );
    }
    if (named.stage !== stage) {
      selectionFail(
        "VGPU-C1-PROGRAM-ENTRY-STAGE",
        `program ${quoted(program.name)} selects ${quoted(
          requested
        )} as @${stage}, but it is @${named.stage}`,
        selectionDetails(program, stage, available, requested)
      );
    }
    return { stage, origin: "authored", wgsl: named.wgsl };
  }

  if (candidates.length === 1) {
    return { stage, origin: "authored", wgsl: candidates[0].wgsl };
  }
  if (candidates.length === 0 && injectWhenMissing) {
    return {
      stage: "vertex",
      origin: "injected",
      injectionProfile: FULLSCREEN_TRIANGLE_INJECTION_PROFILE,
    };
  }
  if (candidates.length === 0) {
    selectionFail(
      "VGPU-C1-PROGRAM-ENTRY-MISSING",
      `program ${quoted(program.name)} requires an @${stage} entry point`,
      selectionDetails(program, stage, available)
    );
  }
  selectionFail(
    "VGPU-C1-PROGRAM-ENTRY-AMBIGUOUS",
    `program ${quoted(
      program.name
    )} has multiple @${stage} entry points; configure entryPoints.${stage}`,
    selectionDetails(program, stage, available)
  );
}

function selectionDetails(program, stage, available, requested) {
  return {
    program: program.name,
    kind: program.kind,
    stage,
    ...(requested === undefined ? {} : { requested }),
    available: Object.freeze(
      available.map((entry) => Object.freeze({ ...entry }))
    ),
  };
}

function freezeSelectionPlan(plan) {
  for (const entry of Object.values(plan.entryPoints)) Object.freeze(entry);
  Object.freeze(plan.entryPoints);
  Object.freeze(plan);
  programSelectionPlans.add(plan);
  return plan;
}

function ownDataProperties(value, allowed, label, details) {
  const properties = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      selectionFail(
        "VGPU-C1-PROGRAM-CONFIG",
        `${label} cannot contain ${quoted(key)}`,
        details
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      selectionFail(
        "VGPU-C1-PROGRAM-CONFIG",
        `${label}.${key} must be an enumerable data property`,
        details
      );
    }
    properties.set(key, descriptor.value);
  }
  return properties;
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function quoted(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function selectionFail(code, message, details) {
  throw new ProgramSelectionError(code, message, details);
}
