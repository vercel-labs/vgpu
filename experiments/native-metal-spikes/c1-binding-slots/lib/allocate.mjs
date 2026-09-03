const STAGES = ["vertex", "fragment", "compute"];
const RESOURCE_CLASSES = ["buffer", "texture", "sampler"];
const UINT32_MAX = 0xffff_ffff;
const UINT32_SPACE = UINT32_MAX + 1;
const MAX_STRING_LENGTH = 1024;

export class BindingSlotAllocationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BindingSlotAllocationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BindingSlotAllocationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSlot(left, right) {
  return (
    STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage) ||
    RESOURCE_CLASSES.indexOf(left.resourceClass) -
      RESOURCE_CLASSES.indexOf(right.resourceClass) ||
    left.index - right.index ||
    compareText(left.component, right.component)
  );
}

function namespaceKey(stage, resourceClass) {
  return `${stage}/${resourceClass}`;
}

function requireObject(value, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", `${owner} must be an object`);
  }
  return value;
}

function requireExactKeys(value, keys, owner) {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("INVALID_INPUT", owner + " has unexpected or missing properties");
  }
}

function requireString(value, owner) {
  const length = typeof value === "string" ? [...value].length : 0;
  if (typeof value !== "string" || length === 0 || length > MAX_STRING_LENGTH) {
    fail(
      "INVALID_INPUT",
      owner + " must be a string between 1 and 1024 characters"
    );
  }
  return value;
}

function requireRole(value, owner) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) {
    fail("INVALID_ROLE", owner + ": " + value);
  }
  return value;
}

function requireArray(value, owner) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${owner} must be an array`);
  return value;
}

function requireStage(value, owner) {
  if (!STAGES.includes(value)) fail("UNKNOWN_STAGE", `${owner}: ${value}`);
  return value;
}

function requireResourceClass(value, owner) {
  if (!RESOURCE_CLASSES.includes(value)) {
    fail("UNKNOWN_RESOURCE_CLASS", `${owner}: ${value}`);
  }
  return value;
}

function requireCount(value, owner) {
  if (!Number.isSafeInteger(value) || value < 1 || value > UINT32_MAX) {
    fail("INVALID_COUNT", `${owner}: ${value}`);
  }
  return value;
}

function requireIndex(value, owner) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail("INVALID_INDEX", `${owner}: ${value}`);
  }
  return value;
}

function checkedEnd(index, count, owner) {
  const end = index + count;
  if (!Number.isSafeInteger(end) || end > UINT32_SPACE) {
    fail("INTERVAL_OVERFLOW", `${owner}: ${index} + ${count}`);
  }
  return end;
}

function normalizeProfile(profile) {
  requireObject(profile, "profile");
  requireExactKeys(profile, ["ceilings", "internalReservations"], "profile");
  const ceilings = new Map();
  const sourceCeilings = requireObject(profile.ceilings, "profile.ceilings");
  requireExactKeys(sourceCeilings, STAGES, "profile.ceilings");
  for (const stage of STAGES) {
    const byClass = requireObject(
      sourceCeilings[stage],
      `profile.ceilings.${stage}`
    );
    requireExactKeys(byClass, RESOURCE_CLASSES, `profile.ceilings.${stage}`);
    for (const resourceClass of RESOURCE_CLASSES) {
      const ceiling = byClass[resourceClass];
      if (
        !Number.isSafeInteger(ceiling) ||
        ceiling < 0 ||
        ceiling > UINT32_SPACE
      ) {
        fail(
          "INVALID_CEILING",
          `profile.ceilings.${stage}.${resourceClass}: ${ceiling}`
        );
      }
      ceilings.set(namespaceKey(stage, resourceClass), ceiling);
    }
  }

  const reservations = [];
  const reservationKeys = new Set();
  for (const [position, raw] of requireArray(
    profile.internalReservations ?? [],
    "profile.internalReservations"
  ).entries()) {
    const owner = `profile.internalReservations[${position}]`;
    requireObject(raw, owner);
    requireExactKeys(
      raw,
      ["role", "stage", "resourceClass", "component", "index", "count"],
      owner
    );
    const reservation = {
      role: requireRole(raw.role, `${owner}.role`),
      stage: requireStage(raw.stage, `${owner}.stage`),
      resourceClass: requireResourceClass(
        raw.resourceClass,
        `${owner}.resourceClass`
      ),
      component: requireString(raw.component, `${owner}.component`),
      index: requireIndex(raw.index, `${owner}.index`),
      count: requireCount(raw.count, `${owner}.count`),
    };
    const identity = `${reservation.role}/${reservation.stage}/${reservation.resourceClass}/${reservation.component}`;
    if (reservationKeys.has(identity)) {
      fail("DUPLICATE_RESERVATION", identity);
    }
    reservationKeys.add(identity);
    const key = namespaceKey(reservation.stage, reservation.resourceClass);
    const end = checkedEnd(reservation.index, reservation.count, owner);
    if (end > ceilings.get(key)) {
      fail("RESERVATION_OVERFLOW", `${identity} ends at ${end}`);
    }
    reservations.push(reservation);
  }

  const externalCeilings = new Map(ceilings);
  for (const [key, ceiling] of ceilings) {
    const intervals = reservations
      .filter(
        (reservation) =>
          namespaceKey(reservation.stage, reservation.resourceClass) === key
      )
      .sort(
        (left, right) =>
          left.index - right.index || compareText(left.role, right.role)
      );
    if (intervals.length === 0) continue;
    let cursor = intervals[0].index;
    externalCeilings.set(key, cursor);
    for (const interval of intervals) {
      if (interval.index < cursor) {
        fail("RESERVATION_COLLISION", `${key} overlaps at ${interval.index}`);
      }
      if (interval.index !== cursor) {
        fail("RESERVATION_NOT_HIGH_END", `${key} has a gap at ${cursor}`);
      }
      cursor = checkedEnd(interval.index, interval.count, `${key} reservation`);
    }
    if (cursor !== ceiling) {
      fail(
        "RESERVATION_NOT_HIGH_END",
        `${key} reservations end at ${cursor}, ceiling is ${ceiling}`
      );
    }
  }
  return { ceilings, externalCeilings, reservations };
}

function normalizeProgram(raw, position, profile) {
  const owner = `programs[${position}]`;
  requireObject(raw, owner);
  requireExactKeys(
    raw,
    ["semanticProgram", "entries", "bindings", "requiredInternalBindings"],
    owner
  );
  const semanticProgram = requireString(
    raw.semanticProgram,
    `${owner}.semanticProgram`
  );

  const entries = new Map();
  for (const [entryPosition, entry] of requireArray(
    raw.entries,
    `${owner}.entries`
  ).entries()) {
    const entryOwner = `${owner}.entries[${entryPosition}]`;
    requireObject(entry, entryOwner);
    requireExactKeys(entry, ["stage", "bindings"], entryOwner);
    const stage = requireStage(entry.stage, `${entryOwner}.stage`);
    if (entries.has(stage)) {
      fail("DUPLICATE_STAGE", `${semanticProgram}/${stage}`);
    }
    const activeBindings = [];
    const activeSet = new Set();
    for (const id of requireArray(entry.bindings, `${entryOwner}.bindings`)) {
      requireString(id, `${entryOwner}.bindings[]`);
      if (activeSet.has(id)) {
        fail("DUPLICATE_ACTIVE_BINDING", `${semanticProgram}/${stage}/${id}`);
      }
      activeSet.add(id);
      activeBindings.push(id);
    }
    entries.set(stage, activeBindings);
  }
  if (entries.size === 0) fail("INVALID_INPUT", `${owner}.entries is empty`);

  const bindings = new Map();
  for (const [bindingPosition, binding] of requireArray(
    raw.bindings,
    `${owner}.bindings`
  ).entries()) {
    const bindingOwner = `${owner}.bindings[${bindingPosition}]`;
    requireObject(binding, bindingOwner);
    requireExactKeys(
      binding,
      ["id", "group", "binding", "components"],
      bindingOwner
    );
    const group = requireIndex(binding.group, `${bindingOwner}.group`);
    const bindingNumber = requireIndex(
      binding.binding,
      `${bindingOwner}.binding`
    );
    const id = requireString(binding.id, `${bindingOwner}.id`);
    if (id !== `g${group}b${bindingNumber}`) {
      fail(
        "BINDING_ID_MISMATCH",
        `${semanticProgram}/${id} != g${group}b${bindingNumber}`
      );
    }
    if (bindings.has(id)) fail("DUPLICATE_BINDING", `${semanticProgram}/${id}`);
    const components = [];
    const componentKeys = new Set();
    for (const [componentPosition, component] of requireArray(
      binding.components,
      `${bindingOwner}.components`
    ).entries()) {
      const componentOwner = `${bindingOwner}.components[${componentPosition}]`;
      requireObject(component, componentOwner);
      requireExactKeys(
        component,
        ["resourceClass", "component", "count"],
        componentOwner
      );
      const normalized = {
        component: requireString(
          component.component,
          `${componentOwner}.component`
        ),
        resourceClass: requireResourceClass(
          component.resourceClass,
          `${componentOwner}.resourceClass`
        ),
        count: requireCount(component.count, `${componentOwner}.count`),
      };
      const key = `${normalized.resourceClass}/${normalized.component}`;
      if (componentKeys.has(key)) {
        fail("DUPLICATE_COMPONENT", `${semanticProgram}/${id}/${key}`);
      }
      componentKeys.add(key);
      components.push(normalized);
    }
    if (components.length === 0) {
      fail("INVALID_INPUT", `${bindingOwner}.components is empty`);
    }
    bindings.set(id, { id, group, binding: bindingNumber, components });
  }

  const usedBindings = new Set();
  for (const [stage, activeBindings] of entries) {
    for (const id of activeBindings) {
      if (!bindings.has(id)) {
        fail("UNKNOWN_BINDING", `${semanticProgram}/${stage}/${id}`);
      }
      usedBindings.add(id);
    }
  }
  for (const id of bindings.keys()) {
    if (!usedBindings.has(id)) {
      fail("INACTIVE_BINDING", `${semanticProgram}/${id}`);
    }
  }

  const requiredInternalBindings = [];
  const requiredRoles = new Set();
  for (const [requirementPosition, requirement] of requireArray(
    raw.requiredInternalBindings ?? [],
    `${owner}.requiredInternalBindings`
  ).entries()) {
    const requirementOwner = `${owner}.requiredInternalBindings[${requirementPosition}]`;
    requireObject(requirement, requirementOwner);
    requireExactKeys(requirement, ["role", "stages"], requirementOwner);
    const role = requireRole(requirement.role, `${requirementOwner}.role`);
    if (requiredRoles.has(role)) {
      fail("DUPLICATE_INTERNAL_REQUIREMENT", `${semanticProgram}/${role}`);
    }
    requiredRoles.add(role);
    const stages = [];
    const stageSet = new Set();
    for (const stageValue of requireArray(
      requirement.stages,
      `${requirementOwner}.stages`
    )) {
      const stage = requireStage(stageValue, `${requirementOwner}.stages[]`);
      if (stageSet.has(stage)) {
        fail("DUPLICATE_INTERNAL_STAGE", `${semanticProgram}/${role}/${stage}`);
      }
      if (!entries.has(stage)) {
        fail("INTERNAL_STAGE_MISMATCH", `${semanticProgram}/${role}/${stage}`);
      }
      stageSet.add(stage);
      stages.push(stage);
    }
    if (stages.length === 0) {
      fail("INVALID_INPUT", `${requirementOwner}.stages is empty`);
    }
    for (const stage of stages) {
      if (
        !profile.reservations.some(
          (reservation) =>
            reservation.role === role && reservation.stage === stage
        )
      ) {
        fail("UNKNOWN_INTERNAL_ROLE", `${semanticProgram}/${role}/${stage}`);
      }
    }
    requiredInternalBindings.push({ role, stages });
  }
  return { semanticProgram, entries, bindings, requiredInternalBindings };
}

/**
 * Input: { profile: { ceilings, internalReservations }, programs }.
 * Programs declare selected {stage, bindings}, binding components, and required internal roles.
 * Returns the canonical {programs: [{semanticProgram, bindings, internalBindings}]} projection.
 */
export function allocateBindingSlots(input) {
  requireObject(input, "input");
  requireExactKeys(input, ["profile", "programs"], "input");
  const profile = normalizeProfile(input.profile);
  const sourcePrograms = requireArray(input.programs, "programs");
  if (sourcePrograms.length === 0) {
    fail("INVALID_INPUT", "programs must contain at least one program");
  }
  const programs = sourcePrograms.map((program, index) =>
    normalizeProgram(program, index, profile)
  );
  const programNames = new Set();
  for (const program of programs) {
    if (programNames.has(program.semanticProgram)) {
      fail("DUPLICATE_PROGRAM", program.semanticProgram);
    }
    programNames.add(program.semanticProgram);
  }

  const projectedPrograms = programs
    .map((program) => {
      const slotsByBinding = new Map(
        [...program.bindings.keys()].map((id) => [id, []])
      );
      for (const [stage, activeBindings] of program.entries) {
        for (const resourceClass of RESOURCE_CLASSES) {
          const candidates = [];
          for (const id of activeBindings) {
            const binding = program.bindings.get(id);
            for (const component of binding.components) {
              if (component.resourceClass === resourceClass) {
                candidates.push({ binding, component });
              }
            }
          }
          candidates.sort(
            (left, right) =>
              left.binding.group - right.binding.group ||
              left.binding.binding - right.binding.binding ||
              compareText(left.component.component, right.component.component)
          );
          let cursor = 0;
          const key = namespaceKey(stage, resourceClass);
          const ceiling = profile.externalCeilings.get(key);
          for (const { binding, component } of candidates) {
            const end = checkedEnd(
              cursor,
              component.count,
              `${program.semanticProgram}/${key}/${binding.id}/${component.component}`
            );
            if (end > ceiling) {
              fail(
                "SLOT_OVERFLOW",
                `${program.semanticProgram}/${key} needs ${end}, external ceiling is ${ceiling}`
              );
            }
            slotsByBinding.get(binding.id).push({
              stage,
              mode: "direct",
              resourceClass,
              component: component.component,
              index: cursor,
              count: component.count,
            });
            cursor = end;
          }
        }
      }

      const bindings = [...program.bindings.values()]
        .sort(
          (left, right) =>
            left.group - right.group || left.binding - right.binding
        )
        .map((binding) => ({
          semanticBinding: binding.id,
          slots: slotsByBinding.get(binding.id).sort(compareSlot),
        }));

      const internalBindings = program.requiredInternalBindings
        .map((requirement) => ({
          role: requirement.role,
          slots: profile.reservations
            .filter(
              (reservation) =>
                reservation.role === requirement.role &&
                requirement.stages.includes(reservation.stage)
            )
            .map(({ role: _role, ...slot }) => ({ mode: "direct", ...slot }))
            .sort(compareSlot),
        }))
        .sort((left, right) => compareText(left.role, right.role));

      return {
        semanticProgram: program.semanticProgram,
        bindings,
        internalBindings,
      };
    })
    .sort((left, right) =>
      compareText(left.semanticProgram, right.semanticProgram)
    );

  return { programs: projectedPrograms };
}
