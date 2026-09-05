import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

export const METAL_PROGRAM_PROJECTION_VERIFY_CODE =
  "VGPU-C1-METAL-PROJECTION-VERIFY";

const stageOrder = ["vertex", "fragment", "compute"];
const stagesForKind = Object.freeze({
  effect: Object.freeze(["vertex", "fragment"]),
  draw: Object.freeze(["vertex", "fragment"]),
  compute: Object.freeze(["compute"]),
});
const emptyDeviceRequirements = Object.freeze({
  features: Object.freeze([]),
  limits: Object.freeze([]),
  formats: Object.freeze([]),
});

export class MetalProgramProjectionVerificationError extends Error {
  constructor(message) {
    super(`${METAL_PROGRAM_PROJECTION_VERIFY_CODE}: ${message}`);
    this.name = "MetalProgramProjectionVerificationError";
    this.code = METAL_PROGRAM_PROJECTION_VERIFY_CODE;
  }
}

const validateProjectionProgram = loadProjectionProgramValidator();

/**
 * Independently reconstructs and verifies one metal-projection-v1 program
 * fragment. This module deliberately shares no implementation with the
 * assembler that produces the fragment.
 */
export function verifyMetalProgramProjection({
  semanticProgram,
  semanticLayouts,
  allocation,
  translations,
  projection,
}) {
  requireRecord(semanticProgram, "semanticProgram");
  requireRecord(semanticLayouts, "semanticLayouts");
  requireRecord(allocation, "allocation");
  requireArray(translations, "translations");
  requireRecord(projection, "projection");

  if (!validateProjectionProgram(projection)) {
    fail(
      `projection failed metal-projection-v1 $defs/program validation: ${JSON.stringify(
        validateProjectionProgram.errors
      )}`
    );
  }

  const expectedStages = stagesForKind[semanticProgram.kind];
  if (!expectedStages) {
    fail(
      `semantic program has unsupported kind ${quoted(semanticProgram.kind)}`
    );
  }
  const semanticEntries = validateSemanticEntries(
    semanticProgram,
    expectedStages
  );
  const semanticBindings = validateSupportedSemanticProgram(
    semanticProgram,
    semanticLayouts
  );
  const semanticOverrides = validateSemanticOverrides(
    semanticProgram,
    semanticEntries,
    expectedStages
  );
  validateAllocation({
    semanticProgram,
    semanticEntries,
    semanticBindings,
    allocation,
    expectedStages,
  });

  const translationsByStage = new Map();
  let compilerIdentity;
  for (const [index, translation] of translations.entries()) {
    const owner = `translations[${index}]`;
    requireRecord(translation, owner);
    requireExactKeys(translation, ["request", "response"], owner);
    const request = requireRecord(translation.request, `${owner}.request`);
    const response = requireRecord(translation.response, `${owner}.response`);
    const requestEntry = requireRecord(
      request.entryPoint,
      `${owner}.request.entryPoint`
    );
    const stage = requestEntry.stage;
    if (!expectedStages.includes(stage)) {
      fail(`${owner} selects unexpected stage ${quoted(stage)}`);
    }
    if (translationsByStage.has(stage)) {
      fail(`translations repeat selected stage ${quoted(stage)}`);
    }

    const semanticEntry = semanticEntries.get(stage);
    if (
      requestEntry.wgsl !== semanticEntry.names?.wgsl ||
      requestEntry.stage !== semanticEntry.stage
    ) {
      fail(`${owner} entry does not belong to the semantic ${stage} entry`);
    }
    const requestMetal = requireRecord(request.metal, `${owner}.request.metal`);
    if (requestMetal.bindingModel !== allocation.bindingModel) {
      fail(`${owner} request uses a different Metal binding model`);
    }
    const expectedRequestBindings = requestBindingsForStage({
      allocation,
      semanticBindings,
      semanticEntry,
      stage,
    });
    if (!isDeepStrictEqual(requestMetal.bindings, expectedRequestBindings)) {
      fail(`${owner} request bindings differ from the allocated ${stage} view`);
    }
    const expectedRequestOverrides = semanticEntry.overrides.map((name) => ({
      name,
      value: structuredClone(semanticOverrides.get(name).selected),
    }));
    if (!isDeepStrictEqual(request.overrides, expectedRequestOverrides)) {
      fail(`${owner} request overrides differ from the semantic ${stage} view`);
    }

    if (response.ok !== true) {
      fail(`${owner} is not a successful compiler translation`);
    }
    const result = requireRecord(response.result, `${owner}.response.result`);
    if (!isDeepStrictEqual(result.entryPoint, requestEntry)) {
      fail(`${owner} response changed its requested entry point`);
    }
    const requestInterface = metalInterfaceFromRequest(
      request,
      `${owner}.request`
    );
    const semanticInterface = metalInterfaceFromSemanticEntry(
      semanticEntry,
      stage,
      `${owner}.semanticEntry`
    );
    if (
      !isDeepStrictEqual(result.interface, requestInterface) ||
      !isDeepStrictEqual(result.interface, semanticInterface)
    ) {
      fail(`${owner} response interface differs from its authenticated entry`);
    }
    if (!isDeepStrictEqual(result.bindings, expectedRequestBindings)) {
      fail(`${owner} response changed its allocated external bindings`);
    }

    requireRecord(response.compiler, `${owner}.response.compiler`);
    if (compilerIdentity === undefined) {
      compilerIdentity = structuredClone(response.compiler);
    } else if (!isDeepStrictEqual(response.compiler, compilerIdentity)) {
      fail("translations report different compiler identities");
    }

    translationsByStage.set(stage, { owner, request, response, result });
  }
  if (
    !isDeepStrictEqual([...translationsByStage.keys()].sort(compareStages), [
      ...expectedStages,
    ])
  ) {
    fail("translations do not bijectively cover the selected program stages");
  }

  const emittedNames = new Set();
  const entryPoints = [];
  const internalByRole = new Map();
  const storageBufferSizeRegions = [];
  let resolvedWorkgroupSize;

  for (const stage of expectedStages) {
    const { owner, request, result } = translationsByStage.get(stage);
    const emittedName = result.entryPoint.metal;
    if (typeof emittedName !== "string" || emittedNames.has(emittedName)) {
      fail(`program repeats emitted Metal name ${quoted(emittedName)}`);
    }
    emittedNames.add(emittedName);
    entryPoints.push({
      stage,
      wgsl: result.entryPoint.wgsl,
      metal: emittedName,
      interface: structuredClone(result.interface),
    });

    collectEffectiveInternalBindings({
      owner,
      stage,
      request,
      result,
      internalByRole,
    });
    collectStorageBufferSizeRegions({
      owner,
      stage,
      request,
      result,
      storageBufferSizeRegions,
    });

    const responseHasWorkgroupSize = Object.hasOwn(
      result,
      "resolvedWorkgroupSize"
    );
    if (stage === "compute") {
      if (
        !responseHasWorkgroupSize ||
        !isDeepStrictEqual(
          result.resolvedWorkgroupSize,
          semanticEntries.get(stage).workgroupSize
        )
      ) {
        fail(`${owner} compute workgroup size differs from semantic v1`);
      }
      resolvedWorkgroupSize = structuredClone(result.resolvedWorkgroupSize);
    } else if (responseHasWorkgroupSize) {
      fail(`${owner} render response contains a compute workgroup size`);
    }
  }

  const internalBindings = [...internalByRole.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([role, slots]) => ({
      role,
      slots: [...slots].sort(compareSlots),
    }));
  storageBufferSizeRegions.sort(
    (left, right) => stageRank(left.stage) - stageRank(right.stage)
  );
  validateRegionRelationships(
    translationsByStage,
    semanticEntries,
    semanticBindings,
    semanticLayouts,
    allocation,
    internalBindings,
    storageBufferSizeRegions
  );
  validateSlotIntervals(allocation.bindings, internalBindings);

  const expectedProjection = {
    semanticProgram: semanticProgram.name,
    kind: semanticProgram.kind,
    entryPoints,
    bindings: structuredClone(allocation.bindings),
    internalBindings,
    storageBufferSizeRegions,
    ...(semanticProgram.kind === "compute" ? { resolvedWorkgroupSize } : {}),
    deviceRequirements: structuredClone(emptyDeviceRequirements),
  };
  if (!isDeepStrictEqual(projection, expectedProjection)) {
    fail("projection differs from the independently reconstructed program");
  }
  return true;
}

function validateSemanticEntries(semanticProgram, expectedStages) {
  const entryPoints = requireRecord(
    semanticProgram.entryPoints,
    "semanticProgram.entryPoints"
  );
  const actualStages = Object.keys(entryPoints);
  if (!isDeepStrictEqual(actualStages, [...expectedStages])) {
    fail("semantic entry set does not match its program kind");
  }
  const entries = new Map();
  for (const stage of expectedStages) {
    const entry = requireRecord(
      entryPoints[stage],
      `semanticProgram.entryPoints.${stage}`
    );
    if (entry.stage !== stage) {
      fail(`semantic ${stage} entry reports another stage`);
    }
    requireRecord(entry.names, `semanticProgram.entryPoints.${stage}.names`);
    requireArray(
      entry.bindings,
      `semanticProgram.entryPoints.${stage}.bindings`
    );
    requireArray(
      entry.overrides,
      `semanticProgram.entryPoints.${stage}.overrides`
    );
    assertStrictlyOrderedStrings(
      entry.overrides,
      `semanticProgram.entryPoints.${stage}.overrides`
    );
    entries.set(stage, entry);
  }
  return entries;
}

function validateSemanticOverrides(
  semanticProgram,
  semanticEntries,
  expectedStages
) {
  const overrides = requireArray(
    semanticProgram.overrides,
    "semanticProgram.overrides"
  );
  const byName = new Map();
  let previousName;
  for (const [index, override] of overrides.entries()) {
    const owner = `semanticProgram.overrides[${index}]`;
    requireRecord(override, owner);
    const names = requireRecord(override.names, `${owner}.names`);
    const name = names.wgsl;
    if (
      typeof name !== "string" ||
      (previousName !== undefined && compareText(previousName, name) >= 0)
    ) {
      fail("semantic program overrides repeat or are not canonically ordered");
    }
    requireRecord(override.selected, `${owner}.selected`);
    previousName = name;
    byName.set(name, override);
  }

  const union = new Set();
  for (const stage of expectedStages) {
    for (const name of semanticEntries.get(stage).overrides) {
      if (!byName.has(name)) {
        fail(
          `semantic ${stage} entry references unknown override ${quoted(name)}`
        );
      }
      union.add(name);
    }
  }
  if (!isDeepStrictEqual([...union].sort(compareText), [...byName.keys()])) {
    fail("semantic program overrides are not the exact entry-set union");
  }
  return byName;
}

function validateSupportedSemanticProgram(semanticProgram, semanticLayouts) {
  const capabilities = requireRecord(
    semanticProgram.capabilities,
    "semanticProgram.capabilities"
  );
  const features = requireArray(
    capabilities.features,
    "semanticProgram.capabilities.features"
  );
  if (features.length !== 0) {
    fail("semantic execution features have no Metal requirements projection");
  }

  const bindings = requireArray(
    semanticProgram.bindings,
    "semanticProgram.bindings"
  );
  const byId = new Map();
  for (const [index, binding] of bindings.entries()) {
    const owner = `semanticProgram.bindings[${index}]`;
    requireRecord(binding, owner);
    if (binding.kind === "storage-texture") {
      fail(`${owner} requires storage-texture format projection`);
    }
    if (!["buffer", "texture", "sampler"].includes(binding.kind)) {
      fail(`${owner} has unsupported kind ${quoted(binding.kind)}`);
    }
    if (typeof binding.id !== "string" || byId.has(binding.id)) {
      fail(`${owner} has an invalid or repeated semantic binding ID`);
    }
    if (binding.kind === "buffer") {
      if (typeof binding.layout !== "string") {
        fail(`${owner} has no semantic layout reference`);
      }
      const layout = requireRecord(
        semanticLayouts[binding.layout],
        `${owner} semantic layout`
      );
      if (typeof layout.runtimeSized !== "boolean") {
        fail(`${owner} semantic layout has no runtime-sized classification`);
      }
    }
    byId.set(binding.id, binding);
  }
  return byId;
}

function validateAllocation({
  semanticProgram,
  semanticEntries,
  semanticBindings,
  allocation,
  expectedStages,
}) {
  if (
    allocation.bindingModel !== "vgpu-metal-binding-slots-v1" ||
    allocation.semanticProgram !== semanticProgram.name
  ) {
    fail("allocation names a different semantic program or binding model");
  }
  const bindings = requireArray(allocation.bindings, "allocation.bindings");
  if (
    !isDeepStrictEqual(
      bindings.map((binding) => binding?.semanticBinding),
      semanticProgram.bindings.map((binding) => binding.id)
    )
  ) {
    fail(
      "allocation does not exactly cover semantic bindings in program order"
    );
  }

  for (const [index, projected] of bindings.entries()) {
    const owner = `allocation.bindings[${index}]`;
    requireRecord(projected, owner);
    const semantic = semanticBindings.get(projected.semanticBinding);
    if (!semantic) fail(`${owner} references an unknown semantic binding`);
    const slots = requireArray(projected.slots, `${owner}.slots`);
    let previousStage = -1;
    for (const [slotIndex, slot] of slots.entries()) {
      requireRecord(slot, `${owner}.slots[${slotIndex}]`);
      const rank = stageRank(slot.stage);
      if (
        rank < 0 ||
        !expectedStages.includes(slot.stage) ||
        rank <= previousStage
      ) {
        fail(`${owner} slots repeat a stage or are not canonically ordered`);
      }
      previousStage = rank;
      assertExternalSlotShape(semantic, slot, `${owner}.slots[${slotIndex}]`);
    }
    for (const stage of expectedStages) {
      const active = semanticEntries
        .get(stage)
        .bindings.includes(projected.semanticBinding);
      const count = slots.filter((slot) => slot.stage === stage).length;
      if (count !== (active ? 1 : 0)) {
        fail(`${owner} does not match the ${stage} active binding set`);
      }
    }
  }
}

function requestBindingsForStage({
  allocation,
  semanticBindings,
  semanticEntry,
  stage,
}) {
  const active = new Set(semanticEntry.bindings);
  const projected = [];
  for (const binding of allocation.bindings) {
    if (!active.has(binding.semanticBinding)) continue;
    const semantic = semanticBindings.get(binding.semanticBinding);
    const slots = binding.slots.filter((slot) => slot.stage === stage);
    if (slots.length !== 1) {
      fail(
        `allocated binding ${quoted(
          binding.semanticBinding
        )} has no unique ${stage} slot`
      );
    }
    projected.push({
      group: semantic.group,
      binding: semantic.binding,
      slots: slots.map(({ stage: _stage, ...slot }) => structuredClone(slot)),
    });
  }
  if (projected.length !== active.size) {
    fail(`${stage} allocation does not cover its exact semantic binding set`);
  }
  return projected;
}

function collectEffectiveInternalBindings({
  owner,
  stage,
  request,
  result,
  internalByRole,
}) {
  const candidates = requireArray(
    request.metal.internalReservations,
    `${owner}.request.metal.internalReservations`
  );
  const effective = requireArray(
    result.internalBindings,
    `${owner}.response.result.internalBindings`
  );
  const seenRoles = new Set();
  for (const [index, binding] of effective.entries()) {
    const bindingOwner = `${owner}.response.result.internalBindings[${index}]`;
    requireRecord(binding, bindingOwner);
    if (typeof binding.role !== "string" || seenRoles.has(binding.role)) {
      fail(`${bindingOwner} has an invalid or repeated role`);
    }
    seenRoles.add(binding.role);
    const matchingCandidates = candidates.filter(
      (candidate) => candidate?.role === binding.role
    );
    if (matchingCandidates.length !== 1) {
      fail(`${bindingOwner} has no unique candidate reservation`);
    }
    const candidateSlots = requireArray(
      matchingCandidates[0].slots,
      `${owner}.request candidate slots`
    );
    const slots = requireArray(binding.slots, `${bindingOwner}.slots`);
    if (slots.length !== 1) {
      fail(`${bindingOwner} must contribute exactly one effective stage slot`);
    }
    const slot = requireRecord(slots[0], `${bindingOwner}.slots[0]`);
    if (
      !candidateSlots.some((candidate) => isDeepStrictEqual(candidate, slot))
    ) {
      fail(`${bindingOwner} effective slot was not reserved by its request`);
    }
    const stagedSlot = { ...structuredClone(slot), stage };
    const accumulated = internalByRole.get(binding.role) ?? [];
    if (accumulated.some((candidate) => candidate.stage === stage)) {
      fail(`${bindingOwner} repeats an effective role in stage ${stage}`);
    }
    accumulated.push(stagedSlot);
    internalByRole.set(binding.role, accumulated);
  }
}

function collectStorageBufferSizeRegions({
  owner,
  stage,
  request,
  result,
  storageBufferSizeRegions,
}) {
  const regions = requireArray(
    result.storageBufferSizeRegions,
    `${owner}.response.result.storageBufferSizeRegions`
  );
  if (regions.length > 1) {
    fail(`${owner} response has more than one stage-local size region`);
  }
  for (const region of regions) {
    requireRecord(region, `${owner}.response size region`);
    if (
      region.stage !== stage ||
      region.immediateDataByteOffset !==
        request.metal.storageBufferSizes?.immediateDataByteOffset
    ) {
      fail(`${owner} response has an invalid storage-buffer-size region`);
    }
    if (
      storageBufferSizeRegions.some((candidate) => candidate.stage === stage)
    ) {
      fail(`storage-buffer-size regions repeat stage ${stage}`);
    }
    storageBufferSizeRegions.push(structuredClone(region));
  }
}

function validateRegionRelationships(
  translationsByStage,
  semanticEntries,
  semanticBindings,
  semanticLayouts,
  allocation,
  internalBindings,
  regions
) {
  for (const region of regions) {
    const activeBindings = semanticEntries.get(region.stage).bindings;
    const hasRuntimeSizedStorageBinding = activeBindings.some((id) => {
      const semantic = semanticBindings.get(id);
      if (
        semantic?.kind !== "buffer" ||
        semantic.addressSpace !== "storage" ||
        semanticLayouts[semantic.layout]?.runtimeSized !== true
      ) {
        return false;
      }
      const projected = allocation.bindings.find(
        (binding) => binding.semanticBinding === id
      );
      const stageSlots = projected?.slots.filter(
        (slot) => slot.stage === region.stage
      );
      return (
        stageSlots?.length === 1 &&
        stageSlots[0].mode === "direct" &&
        stageSlots[0].resourceClass === "buffer" &&
        stageSlots[0].component === "buffer" &&
        stageSlots[0].count === 1
      );
    });
    if (!hasRuntimeSizedStorageBinding) {
      fail(
        `${region.stage} storage-buffer-size region has no active runtime-sized storage binding`
      );
    }
    const immediateSlots = internalBindings
      .filter((binding) => binding.role === "immediate-data")
      .flatMap((binding) => binding.slots)
      .filter((slot) => slot.stage === region.stage);
    if (
      immediateSlots.length !== 1 ||
      immediateSlots[0].mode !== "direct" ||
      immediateSlots[0].resourceClass !== "buffer" ||
      immediateSlots[0].component !== "buffer" ||
      immediateSlots[0].count !== 1
    ) {
      fail(
        `${region.stage} storage-buffer-size region has no compatible effective immediate-data slot`
      );
    }
    const request = translationsByStage.get(region.stage)?.request;
    if (
      region.immediateDataByteOffset !==
      request?.metal?.storageBufferSizes?.immediateDataByteOffset
    ) {
      fail(
        `${region.stage} storage-buffer-size region changed its candidate offset`
      );
    }
  }
}

function validateSlotIntervals(externalBindings, internalBindings) {
  const intervals = [];
  for (const binding of externalBindings) {
    for (const slot of binding.slots) {
      intervals.push(
        intervalForSlot(slot, `external/${binding.semanticBinding}`)
      );
    }
  }
  for (const binding of internalBindings) {
    for (const slot of binding.slots) {
      intervals.push(intervalForSlot(slot, `internal/${binding.role}`));
    }
  }
  intervals.sort(
    (left, right) =>
      stageRank(left.stage) - stageRank(right.stage) ||
      compareText(left.resourceClass, right.resourceClass) ||
      left.start - right.start ||
      left.end - right.end ||
      compareText(left.owner, right.owner)
  );
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (
      previous.stage === current.stage &&
      previous.resourceClass === current.resourceClass &&
      current.start < previous.end
    ) {
      fail(
        `${previous.owner} and ${current.owner} collide in ${current.stage}/${current.resourceClass}`
      );
    }
  }
}

function intervalForSlot(slot, owner) {
  requireRecord(slot, `${owner} slot`);
  const rank = stageRank(slot.stage);
  if (
    rank < 0 ||
    slot.mode !== "direct" ||
    !["buffer", "texture", "sampler"].includes(slot.resourceClass) ||
    !Number.isSafeInteger(slot.index) ||
    slot.index < 0 ||
    !Number.isSafeInteger(slot.count) ||
    slot.count < 1
  ) {
    fail(`${owner} has an invalid direct Metal interval`);
  }
  const end = slot.index + slot.count;
  if (!Number.isSafeInteger(end) || end > 2 ** 32) {
    fail(`${owner} Metal interval overflows UInt32`);
  }
  return {
    owner,
    stage: slot.stage,
    resourceClass: slot.resourceClass,
    start: slot.index,
    end,
  };
}

function assertExternalSlotShape(binding, slot, owner) {
  const expected = {
    buffer: ["buffer", "buffer"],
    texture: ["texture", "texture"],
    sampler: ["sampler", "sampler"],
  }[binding.kind];
  if (
    !expected ||
    slot.mode !== "direct" ||
    slot.resourceClass !== expected[0] ||
    slot.component !== expected[1] ||
    slot.count !== 1
  ) {
    fail(`${owner} is incompatible with semantic kind ${quoted(binding.kind)}`);
  }
  intervalForSlot(slot, owner);
}

function metalInterfaceFromRequest(request, owner) {
  const shaderInterface = requireRecord(
    request.semanticInterface,
    `${owner}.semanticInterface`
  );
  if (shaderInterface.kind !== request.entryPoint.stage) {
    fail(`${owner} semantic interface has the wrong stage`);
  }
  if (shaderInterface.kind === "vertex") {
    return vertexInterface(
      requireArray(shaderInterface.inputs, `${owner}.semanticInterface.inputs`)
    );
  }
  if (shaderInterface.kind === "fragment") {
    return fragmentInterface(
      requireArray(
        shaderInterface.outputs,
        `${owner}.semanticInterface.outputs`
      )
    );
  }
  if (shaderInterface.kind === "compute") return { kind: "compute" };
  fail(`${owner} has an unsupported semantic interface kind`);
}

function metalInterfaceFromSemanticEntry(entry, stage, owner) {
  if (stage === "vertex") {
    return vertexInterface(requireArray(entry.inputs, `${owner}.inputs`));
  }
  if (stage === "fragment") {
    return fragmentInterface(requireArray(entry.outputs, `${owner}.outputs`));
  }
  return { kind: "compute" };
}

function vertexInterface(inputs) {
  return {
    kind: "vertex",
    attributes: inputs
      .filter((value) => Object.hasOwn(value, "location"))
      .map((value) => ({
        semantic: { location: value.location },
        metal: { attribute: value.location },
      })),
  };
}

function fragmentInterface(outputs) {
  return {
    kind: "fragment",
    colorOutputs: outputs
      .filter((value) => Object.hasOwn(value, "location"))
      .map((value) => ({
        semantic: {
          location: value.location,
          ...(Object.hasOwn(value, "blendSource")
            ? { blendSource: value.blendSource }
            : {}),
        },
        metal: {
          color: value.location,
          ...(Object.hasOwn(value, "blendSource")
            ? { index: value.blendSource }
            : {}),
        },
      })),
  };
}

function compareSlots(left, right) {
  return (
    stageRank(left.stage) - stageRank(right.stage) ||
    compareText(left.resourceClass, right.resourceClass) ||
    left.index - right.index ||
    compareText(left.component, right.component) ||
    left.count - right.count
  );
}

function compareStages(left, right) {
  const leftRank = stageRank(left);
  const rightRank = stageRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return compareText(String(left), String(right));
}

function stageRank(stage) {
  return stageOrder.indexOf(stage);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireRecord(value, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${owner} must be an object`);
  }
  return value;
}

function requireArray(value, owner) {
  if (!Array.isArray(value)) fail(`${owner} must be an array`);
  return value;
}

function assertStrictlyOrderedStrings(values, owner) {
  let previous;
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== "string" ||
      (previous !== undefined && compareText(previous, value) >= 0)
    ) {
      fail(`${owner}[${index}] repeats or is not canonically ordered`);
    }
    previous = value;
  }
}

function requireExactKeys(value, keys, owner) {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    !isDeepStrictEqual(
      [...actual].sort(compareText),
      [...keys].sort(compareText)
    )
  ) {
    fail(`${owner} has unexpected or missing properties`);
  }
}

function quoted(value) {
  return JSON.stringify(value);
}

function fail(message) {
  throw new MetalProgramProjectionVerificationError(message);
}

function loadProjectionProgramValidator() {
  const directory = dirname(fileURLToPath(import.meta.url));
  const schema = JSON.parse(
    readFileSync(
      resolve(
        directory,
        "../../../../docs/plans/native/contracts/metal-projection-v1.schema.json"
      ),
      "utf8"
    )
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  const validator = ajv.getSchema(`${schema.$id}#/$defs/program`);
  if (!validator) {
    fail("metal-projection-v1 $defs/program schema could not be resolved");
  }
  return validator;
}
