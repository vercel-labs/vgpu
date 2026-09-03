const STAGES = ["vertex", "fragment", "compute"];
const RESOURCE_CLASSES = ["buffer", "texture", "sampler"];
const UINT32_MAX = 0xffff_ffff;
const UINT32_SPACE = UINT32_MAX + 1;
const MAX_STRING_LENGTH = 1024;

export class BindingSlotVerificationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "BindingSlotVerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BindingSlotVerificationError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function namespaceKey(stage, resourceClass) {
  return `${stage}/${resourceClass}`;
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  const length = typeof value === "string" ? [...value].length : 0;
  if (typeof value !== "string" || length === 0 || length > MAX_STRING_LENGTH) {
    fail("INVALID_SHAPE", `${owner} must be between 1 and 1024 characters`);
  }
  return value;
}

function role(value, owner) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) {
    fail("INVALID_ROLE", `${owner}: ${value}`);
  }
  return value;
}

function stage(value, owner) {
  if (!STAGES.includes(value)) fail("UNKNOWN_STAGE", `${owner}: ${value}`);
  return value;
}

function resourceClass(value, owner) {
  if (!RESOURCE_CLASSES.includes(value)) {
    fail("UNKNOWN_RESOURCE_CLASS", `${owner}: ${value}`);
  }
  return value;
}

function count(value, owner) {
  if (!Number.isSafeInteger(value) || value < 1 || value > UINT32_MAX) {
    fail("INVALID_COUNT", `${owner}: ${value}`);
  }
  return value;
}

function index(value, owner) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail("INVALID_INDEX", `${owner}: ${value}`);
  }
  return value;
}

function endOf(indexValue, countValue, owner) {
  const end = indexValue + countValue;
  if (!Number.isSafeInteger(end) || end > UINT32_SPACE) {
    fail("INTERVAL_OVERFLOW", owner);
  }
  return end;
}

function sameJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedModel(input) {
  if (!isObject(input) || !isObject(input.profile)) {
    fail("INVALID_SHAPE", "input/profile must be objects");
  }
  exactKeys(input, ["profile", "programs"], "input");
  exactKeys(input.profile, ["ceilings", "internalReservations"], "profile");
  const ceilings = new Map();
  if (!isObject(input.profile.ceilings)) {
    fail("INVALID_SHAPE", "profile.ceilings must be an object");
  }
  exactKeys(input.profile.ceilings, STAGES, "profile.ceilings");
  for (const stageName of STAGES) {
    const classes = input.profile.ceilings[stageName];
    if (!isObject(classes)) {
      fail("INVALID_SHAPE", `profile.ceilings.${stageName} must be an object`);
    }
    exactKeys(classes, RESOURCE_CLASSES, `profile.ceilings.${stageName}`);
    for (const className of RESOURCE_CLASSES) {
      const value = classes[className];
      if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_SPACE) {
        fail("INVALID_CEILING", `${stageName}/${className}: ${value}`);
      }
      ceilings.set(namespaceKey(stageName, className), value);
    }
  }

  const reservations = [];
  const reservationIdentities = new Set();
  for (const [position, raw] of array(
    input.profile.internalReservations ?? [],
    "profile.internalReservations"
  ).entries()) {
    if (!isObject(raw)) fail("INVALID_SHAPE", `reservation ${position}`);
    exactKeys(
      raw,
      ["role", "stage", "resourceClass", "component", "index", "count"],
      `reservation ${position}`
    );
    const normalized = {
      role: role(raw.role, `reservation ${position} role`),
      stage: stage(raw.stage, `reservation ${position} stage`),
      resourceClass: resourceClass(
        raw.resourceClass,
        `reservation ${position} class`
      ),
      component: text(raw.component, `reservation ${position} component`),
      index: index(raw.index, `reservation ${position} index`),
      count: count(raw.count, `reservation ${position} count`),
    };
    const identity = `${normalized.role}/${normalized.stage}/${normalized.resourceClass}/${normalized.component}`;
    if (reservationIdentities.has(identity)) {
      fail("DUPLICATE_RESERVATION", identity);
    }
    reservationIdentities.add(identity);
    const key = namespaceKey(normalized.stage, normalized.resourceClass);
    if (
      endOf(normalized.index, normalized.count, identity) > ceilings.get(key)
    ) {
      fail("RESERVATION_OVERFLOW", identity);
    }
    reservations.push(normalized);
  }

  const externalCeilings = new Map(ceilings);
  for (const [key, ceiling] of ceilings) {
    const intervals = reservations
      .filter((slot) => namespaceKey(slot.stage, slot.resourceClass) === key)
      .sort(
        (left, right) =>
          left.index - right.index || compareText(left.role, right.role)
      );
    if (intervals.length === 0) continue;
    let cursor = intervals[0].index;
    externalCeilings.set(key, cursor);
    for (const interval of intervals) {
      if (interval.index < cursor) fail("RESERVATION_COLLISION", key);
      if (interval.index !== cursor) fail("RESERVATION_NOT_HIGH_END", key);
      cursor = endOf(interval.index, interval.count, key);
    }
    if (cursor !== ceiling) fail("RESERVATION_NOT_HIGH_END", key);
  }

  const sourcePrograms = array(input.programs, "programs");
  if (sourcePrograms.length === 0) {
    fail("INVALID_SHAPE", "programs must contain at least one program");
  }
  const programs = new Map();
  for (const [programPosition, rawProgram] of sourcePrograms.entries()) {
    if (!isObject(rawProgram))
      fail("INVALID_SHAPE", `program ${programPosition}`);
    exactKeys(
      rawProgram,
      ["semanticProgram", "entries", "bindings", "requiredInternalBindings"],
      `program ${programPosition}`
    );
    const name = text(
      rawProgram.semanticProgram,
      `program ${programPosition} name`
    );
    if (programs.has(name)) fail("DUPLICATE_PROGRAM", name);
    const entries = new Map();
    for (const [entryPosition, rawEntry] of array(
      rawProgram.entries,
      `${name}.entries`
    ).entries()) {
      if (!isObject(rawEntry))
        fail("INVALID_SHAPE", `${name} entry ${entryPosition}`);
      exactKeys(
        rawEntry,
        ["stage", "bindings"],
        `${name} entry ${entryPosition}`
      );
      const stageName = stage(rawEntry.stage, `${name} entry stage`);
      if (entries.has(stageName))
        fail("DUPLICATE_STAGE", `${name}/${stageName}`);
      const active = array(rawEntry.bindings, `${name}/${stageName} bindings`);
      const activeSet = new Set();
      for (const id of active) {
        text(id, `${name}/${stageName} binding`);
        if (activeSet.has(id))
          fail("DUPLICATE_ACTIVE_BINDING", `${name}/${stageName}/${id}`);
        activeSet.add(id);
      }
      entries.set(stageName, activeSet);
    }
    if (entries.size === 0) fail("INVALID_SHAPE", `${name} has no entries`);

    const bindings = new Map();
    for (const [bindingPosition, rawBinding] of array(
      rawProgram.bindings,
      `${name}.bindings`
    ).entries()) {
      if (!isObject(rawBinding))
        fail("INVALID_SHAPE", `${name} binding ${bindingPosition}`);
      exactKeys(
        rawBinding,
        ["id", "group", "binding", "components"],
        `${name} binding ${bindingPosition}`
      );
      const group = index(rawBinding.group, `${name} group`);
      const number = index(rawBinding.binding, `${name} binding number`);
      const id = text(rawBinding.id, `${name} binding id`);
      if (id !== `g${group}b${number}`)
        fail("BINDING_ID_MISMATCH", `${name}/${id}`);
      if (bindings.has(id)) fail("DUPLICATE_BINDING", `${name}/${id}`);
      const components = [];
      const componentKeys = new Set();
      for (const rawComponent of array(
        rawBinding.components,
        `${name}/${id} components`
      )) {
        if (!isObject(rawComponent))
          fail("INVALID_SHAPE", `${name}/${id} component`);
        exactKeys(
          rawComponent,
          ["resourceClass", "component", "count"],
          `${name}/${id} component`
        );
        const normalized = {
          component: text(
            rawComponent.component,
            `${name}/${id} component name`
          ),
          resourceClass: resourceClass(
            rawComponent.resourceClass,
            `${name}/${id} class`
          ),
          count: count(rawComponent.count, `${name}/${id} count`),
        };
        const componentKey = `${normalized.resourceClass}/${normalized.component}`;
        if (componentKeys.has(componentKey))
          fail("DUPLICATE_COMPONENT", `${name}/${id}/${componentKey}`);
        componentKeys.add(componentKey);
        components.push(normalized);
      }
      if (components.length === 0)
        fail("INVALID_SHAPE", `${name}/${id} has no components`);
      bindings.set(id, { id, group, binding: number, components });
    }

    const used = new Set();
    for (const [stageName, active] of entries) {
      for (const id of active) {
        if (!bindings.has(id))
          fail("UNKNOWN_BINDING", `${name}/${stageName}/${id}`);
        used.add(id);
      }
    }
    for (const id of bindings.keys()) {
      if (!used.has(id)) fail("INACTIVE_BINDING", `${name}/${id}`);
    }

    const internals = new Map();
    for (const rawRequirement of array(
      rawProgram.requiredInternalBindings ?? [],
      `${name}.requiredInternalBindings`
    )) {
      if (!isObject(rawRequirement))
        fail("INVALID_SHAPE", `${name} internal requirement`);
      exactKeys(
        rawRequirement,
        ["role", "stages"],
        `${name} internal requirement`
      );
      const roleName = role(rawRequirement.role, `${name} internal role`);
      if (internals.has(roleName))
        fail("DUPLICATE_INTERNAL_REQUIREMENT", `${name}/${roleName}`);
      const stages = new Set();
      for (const rawStage of array(
        rawRequirement.stages,
        `${name}/${roleName} stages`
      )) {
        const stageName = stage(rawStage, `${name}/${roleName} stage`);
        if (stages.has(stageName))
          fail("DUPLICATE_INTERNAL_STAGE", `${name}/${roleName}/${stageName}`);
        if (!entries.has(stageName))
          fail("INTERNAL_STAGE_MISMATCH", `${name}/${roleName}/${stageName}`);
        if (
          !reservations.some(
            (slot) => slot.role === roleName && slot.stage === stageName
          )
        ) {
          fail("UNKNOWN_INTERNAL_ROLE", `${name}/${roleName}/${stageName}`);
        }
        stages.add(stageName);
      }
      if (stages.size === 0)
        fail("INVALID_SHAPE", `${name}/${roleName} has no stages`);
      internals.set(roleName, stages);
    }
    programs.set(name, { entries, bindings, internals });
  }
  return { ceilings, externalCeilings, reservations, programs };
}

/** Verifies a canonical allocation from the same normalized input without calling the allocator. */
export function verifyBindingSlotAllocation(input, allocation) {
  const model = expectedModel(input);
  if (!isObject(allocation))
    fail("INVALID_SHAPE", "allocation must be an object");
  exactKeys(allocation, ["programs"], "allocation");
  const projectedPrograms = array(allocation.programs, "allocation.programs");
  const canonicalProgramNames = [...model.programs.keys()].sort(compareText);
  const observedProgramNames = projectedPrograms.map((program, position) => {
    if (!isObject(program))
      fail("INVALID_SHAPE", `projected program ${position}`);
    exactKeys(
      program,
      ["semanticProgram", "bindings", "internalBindings"],
      `projected program ${position}`
    );
    return text(program.semanticProgram, `projected program ${position} name`);
  });
  if (!sameJSON(observedProgramNames, canonicalProgramNames)) {
    fail(
      "PROGRAM_SET_MISMATCH",
      "programs must be unique and canonically ordered"
    );
  }

  for (const projected of projectedPrograms) {
    const name = projected.semanticProgram;
    const program = model.programs.get(name);
    const expectedBindings = [...program.bindings.values()].sort(
      (left, right) => left.group - right.group || left.binding - right.binding
    );
    const projectedBindings = array(projected.bindings, `${name}.bindings`);
    if (
      !sameJSON(
        projectedBindings.map((binding) => binding?.semanticBinding),
        expectedBindings.map((binding) => binding.id)
      )
    ) {
      fail("BINDING_SET_MISMATCH", name);
    }

    const slotsByNamespace = new Map();
    for (const binding of projectedBindings) {
      if (!isObject(binding))
        fail("INVALID_SHAPE", `${name} projected binding`);
      exactKeys(
        binding,
        ["semanticBinding", "slots"],
        `${name} projected binding`
      );
      const source = program.bindings.get(binding.semanticBinding);
      for (const rawSlot of array(
        binding.slots,
        `${name}/${binding.semanticBinding} slots`
      )) {
        if (!isObject(rawSlot)) fail("INVALID_SHAPE", `${name} slot`);
        exactKeys(
          rawSlot,
          ["stage", "mode", "resourceClass", "component", "index", "count"],
          `${name} slot`
        );
        const stageName = stage(rawSlot.stage, `${name} slot stage`);
        const className = resourceClass(
          rawSlot.resourceClass,
          `${name} slot class`
        );
        if (rawSlot.mode !== "direct")
          fail("MODE_MISMATCH", `${name}/${binding.semanticBinding}`);
        const componentName = text(rawSlot.component, `${name} slot component`);
        const indexValue = index(rawSlot.index, `${name} slot index`);
        const countValue = count(rawSlot.count, `${name} slot count`);
        if (!program.entries.get(stageName)?.has(binding.semanticBinding)) {
          fail(
            "INACTIVE_SLOT",
            `${name}/${stageName}/${binding.semanticBinding}`
          );
        }
        const component = source.components.find(
          (candidate) =>
            candidate.resourceClass === className &&
            candidate.component === componentName
        );
        if (!component || component.count !== countValue) {
          fail(
            "COMPONENT_MISMATCH",
            `${name}/${binding.semanticBinding}/${componentName}`
          );
        }
        const key = namespaceKey(stageName, className);
        const entries = slotsByNamespace.get(key) ?? [];
        entries.push({
          binding: source,
          component,
          index: indexValue,
          count: countValue,
        });
        slotsByNamespace.set(key, entries);
      }
    }

    const expectedSlotsByBinding = new Map(
      [...program.bindings.keys()].map((id) => [id, []])
    );
    for (const [stageName, active] of program.entries) {
      for (const className of RESOURCE_CLASSES) {
        const expected = [];
        for (const id of active) {
          const binding = program.bindings.get(id);
          for (const component of binding.components) {
            if (component.resourceClass === className)
              expected.push({ binding, component });
          }
        }
        expected.sort(
          (left, right) =>
            left.binding.group - right.binding.group ||
            left.binding.binding - right.binding.binding ||
            compareText(left.component.component, right.component.component)
        );
        const key = namespaceKey(stageName, className);
        const observed = slotsByNamespace.get(key) ?? [];
        observed.sort((left, right) => left.index - right.index);
        if (observed.length !== expected.length)
          fail("SLOT_SET_MISMATCH", `${name}/${key}`);
        let cursor = 0;
        for (let position = 0; position < expected.length; position += 1) {
          const wanted = expected[position];
          const actual = observed[position];
          if (
            actual.binding.id !== wanted.binding.id ||
            actual.component.component !== wanted.component.component ||
            actual.component.resourceClass !== wanted.component.resourceClass ||
            actual.count !== wanted.component.count ||
            actual.index !== cursor
          ) {
            fail("SLOT_MISMATCH", `${name}/${key}/${position}`);
          }
          expectedSlotsByBinding.get(wanted.binding.id).push({
            stage: stageName,
            mode: "direct",
            resourceClass: className,
            component: wanted.component.component,
            index: cursor,
            count: wanted.component.count,
          });
          cursor = endOf(actual.index, actual.count, `${name}/${key}`);
        }
        if (cursor > model.externalCeilings.get(key)) {
          fail("SLOT_OVERFLOW", `${name}/${key}`);
        }
      }
    }
    for (const binding of projectedBindings) {
      const normalizedSlots = binding.slots.map((slot) => ({
        stage: slot.stage,
        mode: slot.mode,
        resourceClass: slot.resourceClass,
        component: slot.component,
        index: slot.index,
        count: slot.count,
      }));
      const expectedSlots = expectedSlotsByBinding
        .get(binding.semanticBinding)
        .sort(compareSlot);
      if (!sameJSON(normalizedSlots, expectedSlots)) {
        fail("SLOT_ORDER_MISMATCH", `${name}/${binding.semanticBinding}`);
      }
    }

    const projectedInternals = array(
      projected.internalBindings,
      `${name}.internalBindings`
    );
    const expectedRoles = [...program.internals.keys()].sort(compareText);
    if (
      !sameJSON(
        projectedInternals.map((item) => item?.role),
        expectedRoles
      )
    ) {
      fail("INTERNAL_SET_MISMATCH", name);
    }
    const occupied = new Map();
    for (const [key, slots] of slotsByNamespace) {
      occupied.set(
        key,
        slots.map((slot) => ({
          start: slot.index,
          end: endOf(slot.index, slot.count, `${name}/${key}`),
          owner: `external/${slot.binding.id}/${slot.component.component}`,
        }))
      );
    }
    for (const item of projectedInternals) {
      if (!isObject(item)) fail("INVALID_SHAPE", `${name} internal binding`);
      exactKeys(item, ["role", "slots"], `${name} internal binding`);
      role(item.role, `${name} internal role`);
      for (const slot of array(item.slots, `${name}/${item.role} slots`)) {
        if (!isObject(slot)) {
          fail("INVALID_SHAPE", `${name}/${item.role} slot`);
        }
        exactKeys(
          slot,
          ["stage", "mode", "resourceClass", "component", "index", "count"],
          `${name}/${item.role} slot`
        );
      }
      const requiredStages = program.internals.get(item.role);
      const expected = model.reservations
        .filter(
          (reservation) =>
            reservation.role === item.role &&
            requiredStages.has(reservation.stage)
        )
        .map(({ role: _role, ...slot }) => ({ mode: "direct", ...slot }))
        .sort(
          (left, right) =>
            STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage) ||
            RESOURCE_CLASSES.indexOf(left.resourceClass) -
              RESOURCE_CLASSES.indexOf(right.resourceClass) ||
            left.index - right.index ||
            compareText(left.component, right.component)
        );
      if (!sameJSON(item.slots, expected))
        fail("INTERNAL_SLOT_MISMATCH", `${name}/${item.role}`);
      for (const slot of expected) {
        const key = namespaceKey(slot.stage, slot.resourceClass);
        const interval = {
          start: slot.index,
          end: endOf(slot.index, slot.count, `${name}/${item.role}`),
          owner: `internal/${item.role}/${slot.component}`,
        };
        const intervals = occupied.get(key) ?? [];
        for (const other of intervals) {
          if (interval.start < other.end && other.start < interval.end) {
            fail(
              "SLOT_COLLISION",
              `${name}/${key}/${interval.owner}/${other.owner}`
            );
          }
        }
        intervals.push(interval);
        occupied.set(key, intervals);
      }
    }

    for (const [key, intervals] of occupied) {
      const ceiling = model.ceilings.get(key);
      for (const interval of intervals) {
        if (interval.end > ceiling)
          fail("SLOT_OVERFLOW", `${name}/${key}/${interval.owner}`);
      }
    }
  }
  return true;
}
