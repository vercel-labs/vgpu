import { isDeepStrictEqual } from "node:util";

import {
  isMetalProgramProjection,
  semanticResourceEvidenceForMetalProgramProjection,
} from "./metal-program-projection.mjs";

const runtimeResourceLayouts = new WeakMap();
const stageOrder = Object.freeze(["vertex", "fragment", "compute"]);
const stagesForKind = Object.freeze({
  effect: Object.freeze(["vertex", "fragment"]),
  draw: Object.freeze(["vertex", "fragment"]),
  compute: Object.freeze(["compute"]),
});
const supportedKinds = new Set(["buffer", "texture", "sampler"]);

export class RuntimeResourceLayoutError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RuntimeResourceLayoutError";
    this.code = code;
  }
}

/**
 * Joins the semantic resource descriptors retained by a nominal Metal program
 * projection with that projection's exact physical slots. Neither half can be
 * supplied or overridden by the caller.
 *
 * The returned value is frozen, canonical, and nominally associated with its
 * source projection for the later prepare/encode boundary. A structural clone
 * does not preserve that association.
 */
export function runtimeResourceLayoutForMetalProgramProjection(projection) {
  if (!isMetalProgramProjection(projection)) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BRAND",
      "runtime resource layout requires a nominal Metal program projection"
    );
  }

  const { program, layouts } =
    semanticResourceEvidenceForMetalProgramProjection(projection);
  assertProgramIdentity(program, projection);

  const semanticBindings = requireArray(
    program.bindings,
    "semantic program bindings"
  );
  const projectedBindings = requireArray(
    projection.bindings,
    "Metal program bindings"
  );
  if (semanticBindings.length !== projectedBindings.length) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BINDINGS",
      "semantic and Metal binding sets have different lengths"
    );
  }

  const bindingById = new Map();
  const bindings = semanticBindings.map((semantic, index) => {
    requireRecord(semantic, `semantic binding at index ${index}`);
    const projected = requireRecord(
      projectedBindings[index],
      `Metal binding at index ${index}`
    );
    if (
      typeof semantic.id !== "string" ||
      bindingById.has(semantic.id) ||
      projected.semanticBinding !== semantic.id
    ) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BINDINGS",
        `binding at index ${index} does not preserve one unique semantic identity`
      );
    }
    if (!supportedKinds.has(semantic.kind)) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-KIND",
        `semantic binding ${JSON.stringify(
          semantic.id
        )} has unsupported kind ${JSON.stringify(semantic.kind)}`
      );
    }

    const descriptor = descriptorForBinding(semantic, layouts);
    const slots = slotsForBinding(semantic, projected);
    bindingById.set(semantic.id, { semantic, slots });
    return {
      semanticBinding: semantic.id,
      descriptor,
      slots,
    };
  });

  const samplingPairs = assembleSamplingPairs(program, projection, bindingById);
  const layout = freezeJson({
    semanticProgram: program.name,
    kind: program.kind,
    bindings,
    samplingPairs,
  });
  runtimeResourceLayouts.set(layout, { projection });
  return layout;
}

export function isRuntimeResourceLayout(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    runtimeResourceLayouts.has(value)
  );
}

function assertProgramIdentity(program, projection) {
  requireRecord(program, "semantic program");
  if (
    program.name !== projection.semanticProgram ||
    program.kind !== projection.kind
  ) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-PROGRAM",
      "semantic and Metal program identities differ"
    );
  }
  if (!Object.hasOwn(program, "entryPoints")) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-PROGRAM",
      "semantic program has no entry points"
    );
  }
}

function descriptorForBinding(binding, layouts) {
  if (binding.kind === "buffer") {
    const layout = requireRecord(
      layouts?.[binding.layout],
      `layout for buffer ${JSON.stringify(binding.id)}`
    );
    if (typeof layout.runtimeSized !== "boolean") {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BUFFER",
        `buffer ${JSON.stringify(
          binding.id
        )} layout has no runtime-sized classification`
      );
    }
    if (
      !["uniform", "storage"].includes(binding.addressSpace) ||
      !["read", "read_write"].includes(binding.access) ||
      (binding.addressSpace === "uniform" && binding.access !== "read") ||
      !Number.isSafeInteger(binding.minimumBindingSize) ||
      binding.minimumBindingSize < 0
    ) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-BUFFER",
        `buffer ${JSON.stringify(binding.id)} has an unsupported descriptor`
      );
    }
    return {
      kind: "buffer",
      addressSpace: binding.addressSpace,
      access: binding.access,
      minimumBindingSize: binding.minimumBindingSize,
      runtimeSized: layout.runtimeSized,
    };
  }
  if (binding.kind === "texture") {
    if (
      !["1d", "2d", "2d-array", "cube", "cube-array", "3d"].includes(
        binding.dimension
      ) ||
      !["float", "unfilterable-float", "depth", "sint", "uint"].includes(
        binding.sampleType
      ) ||
      typeof binding.multisampled !== "boolean"
    ) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-TEXTURE",
        `texture ${JSON.stringify(binding.id)} has an unsupported descriptor`
      );
    }
    return {
      kind: "texture",
      dimension: binding.dimension,
      sampleType: binding.sampleType,
      multisampled: binding.multisampled,
    };
  }
  if (binding.kind === "sampler") {
    if (
      !["filtering", "non-filtering", "comparison"].includes(
        binding.samplerKind
      )
    ) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SAMPLER",
        `sampler ${JSON.stringify(binding.id)} has an unsupported descriptor`
      );
    }
    return { kind: "sampler", samplerKind: binding.samplerKind };
  }
  layoutFail(
    "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-KIND",
    `binding ${JSON.stringify(binding.id)} cannot be projected for runtime use`
  );
}

function slotsForBinding(semantic, projected) {
  const slots = requireArray(
    projected.slots,
    `Metal slots for ${JSON.stringify(semantic.id)}`
  );
  const visibility = requireArray(
    semantic.visibility,
    `visibility for ${JSON.stringify(semantic.id)}`
  );
  const expectedClass = semantic.kind === "buffer" ? "buffer" : semantic.kind;
  const observedStages = new Set();
  const canonical = slots.map((slot, index) => {
    requireRecord(slot, `slot ${index} for ${JSON.stringify(semantic.id)}`);
    if (
      !stageOrder.includes(slot.stage) ||
      observedStages.has(slot.stage) ||
      slot.mode !== "direct" ||
      slot.resourceClass !== expectedClass ||
      slot.component !== expectedClass ||
      !Number.isSafeInteger(slot.index) ||
      slot.index < 0 ||
      slot.count !== 1
    ) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SLOT",
        `binding ${JSON.stringify(
          semantic.id
        )} has an unsupported Metal slot at index ${index}`
      );
    }
    observedStages.add(slot.stage);
    return structuredClone(slot);
  });
  canonical.sort(
    (left, right) =>
      stageOrder.indexOf(left.stage) - stageOrder.indexOf(right.stage)
  );
  if (
    !isDeepStrictEqual(
      canonical.map((slot) => slot.stage),
      visibility
    )
  ) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-VISIBILITY",
      `binding ${JSON.stringify(
        semantic.id
      )} stages differ from semantic visibility`
    );
  }
  return canonical;
}

function assembleSamplingPairs(program, projection, bindingById) {
  const selectedStages = requireArray(
    projection.entryPoints,
    "Metal program entry points"
  ).map((entry) => entry?.stage);
  const expectedStages = stagesForKind[program.kind];
  if (!expectedStages || !isDeepStrictEqual(selectedStages, expectedStages)) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-STAGE",
      "Metal entry stages do not match the semantic program kind"
    );
  }
  const pairs = [];
  for (const stage of selectedStages) {
    if (!stageOrder.includes(stage)) {
      layoutFail(
        "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-STAGE",
        `Metal program has unsupported stage ${JSON.stringify(stage)}`
      );
    }
    const semanticEntry = requireRecord(
      program.entryPoints?.[stage],
      `semantic ${stage} entry point`
    );
    const stagePairs = requireArray(
      semanticEntry.samplingPairs,
      `semantic ${stage} sampling pairs`
    );
    for (const [index, pair] of stagePairs.entries()) {
      requireRecord(pair, `${stage} sampling pair at index ${index}`);
      assertSamplingPair(pair, stage, bindingById);
      pairs.push({ stage, ...structuredClone(pair) });
    }
  }
  return pairs;
}

function assertSamplingPair(pair, stage, bindingById) {
  const texture = bindingById.get(pair.texture);
  const sampler = bindingById.get(pair.sampler);
  const textureActive = texture?.slots.some((slot) => slot.stage === stage);
  const samplerActive = sampler?.slots.some((slot) => slot.stage === stage);
  if (
    texture?.semantic.kind !== "texture" ||
    sampler?.semantic.kind !== "sampler" ||
    !textureActive ||
    !samplerActive ||
    !["filtering", "comparison"].includes(pair.mode)
  ) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SAMPLING",
      `${stage} sampling pair does not reference active texture and sampler bindings`
    );
  }
  const expectedMode =
    sampler.semantic.samplerKind === "comparison" ? "comparison" : "filtering";
  if (
    pair.mode !== expectedMode ||
    (sampler.semantic.samplerKind === "comparison" &&
      texture.semantic.sampleType !== "depth") ||
    (sampler.semantic.samplerKind === "filtering" &&
      ["unfilterable-float", "sint", "uint"].includes(
        texture.semantic.sampleType
      )) ||
    (sampler.semantic.samplerKind === "non-filtering" &&
      !["unfilterable-float", "sint", "uint"].includes(
        texture.semantic.sampleType
      ))
  ) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SAMPLING",
      `${stage} sampling pair is incompatible with its resource descriptors`
    );
  }
}

function requireRecord(value, owner) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SHAPE",
      `${owner} must be an object`
    );
  }
  return value;
}

function requireArray(value, owner) {
  if (!Array.isArray(value)) {
    layoutFail(
      "VGPU-C1-RUNTIME-RESOURCE-LAYOUT-SHAPE",
      `${owner} must be an array`
    );
  }
  return value;
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function layoutFail(code, message) {
  throw new RuntimeResourceLayoutError(code, message);
}
