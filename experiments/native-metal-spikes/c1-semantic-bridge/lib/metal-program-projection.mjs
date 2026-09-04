import { isDeepStrictEqual } from "node:util";

import {
  compilerRequestForTranslation,
  compilerResponseForTranslation,
  isAuthenticatedCompilerTranslation,
} from "./authenticated-compiler-translation.mjs";
import { projectMetalDeviceRequirements } from "./metal-device-requirements.mjs";
import {
  isCompilerRequestForAssembly,
  isMetalSlotAllocationForAssembly,
  isSemanticProgramAssembly,
} from "./semantic-assembly.mjs";
import { verifyMetalProgramProjection } from "./verify-metal-program-projection.mjs";

const metalProgramProjections = new WeakMap();
const stageOrder = Object.freeze(["vertex", "fragment", "compute"]);
const stagesForKind = Object.freeze({
  effect: Object.freeze(["vertex", "fragment"]),
  draw: Object.freeze(["vertex", "fragment"]),
  compute: Object.freeze(["compute"]),
});

export class MetalProgramProjectionError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MetalProgramProjectionError";
    this.code = code;
  }
}

/**
 * Combines the authenticated one-entry compiler results for exactly one
 * nominal semantic program. MSL and compiler identity remain retained
 * evidence instead of becoming fields in the serializable program fragment.
 */
export function assembleMetalProgramProjection({
  assembly,
  allocation,
  translations,
}) {
  if (!isSemanticProgramAssembly(assembly)) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-ASSEMBLY",
      "program projection requires a nominal semantic assembly"
    );
  }
  if (!isMetalSlotAllocationForAssembly(allocation, assembly)) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-ALLOCATION",
      "program projection requires the exact allocation for its assembly"
    );
  }
  if (!Array.isArray(translations)) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-TRANSLATIONS",
      "program translations must be an array"
    );
  }

  const program = assembly.semantic.programs[0];
  const expectedStages = stagesForKind[program.kind];
  if (!expectedStages) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-KIND",
      `unsupported semantic program kind ${JSON.stringify(program.kind)}`
    );
  }

  const records = translations.map((translation, index) => {
    if (!isAuthenticatedCompilerTranslation(translation)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-TRANSLATION",
        `translation at index ${index} is not an authenticated compiler result`
      );
    }
    const request = compilerRequestForTranslation(translation);
    const response = compilerResponseForTranslation(translation);
    if (!isCompilerRequestForAssembly(request, assembly, allocation)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-OWNERSHIP",
        `translation at index ${index} belongs to another assembly or allocation`
      );
    }
    return { request, response };
  });

  assertExactStageSet(records, expectedStages);
  records.sort(
    (left, right) =>
      stageRank(left.request.entryPoint.stage) -
      stageRank(right.request.entryPoint.stage)
  );
  assertUniqueMetalNames(records);
  const compiler = assertOneCompilerIdentity(records);

  let deviceRequirements;
  try {
    deviceRequirements = projectMetalDeviceRequirements(program);
  } catch (cause) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-REQUIREMENTS",
      cause?.message ?? String(cause)
    );
  }

  const projection = {
    semanticProgram: program.name,
    kind: program.kind,
    entryPoints: records.map(({ request, response }) => ({
      ...structuredClone(request.entryPoint),
      interface: structuredClone(response.result.interface),
    })),
    bindings: structuredClone(allocation.bindings),
    internalBindings: assembleInternalBindings(records),
    storageBufferSizeRegions: records.flatMap(({ response }) =>
      structuredClone(response.result.storageBufferSizeRegions)
    ),
    ...(program.kind === "compute"
      ? {
          resolvedWorkgroupSize: structuredClone(
            records[0].response.result.resolvedWorkgroupSize
          ),
        }
      : {}),
    deviceRequirements: structuredClone(deviceRequirements),
  };

  try {
    verifyMetalProgramProjection({
      semanticProgram: program,
      semanticLayouts: assembly.semantic.layouts,
      allocation,
      translations: records,
      projection,
    });
  } catch (cause) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-VERIFY",
      cause?.message ?? String(cause)
    );
  }

  const frozenProjection = freezeJson(projection);
  const sources = freezeJson(
    records.map(({ request, response }) => ({
      stage: request.entryPoint.stage,
      entryPoint: request.entryPoint.metal,
      msl: response.result.msl,
    }))
  );
  metalProgramProjections.set(frozenProjection, {
    allocation,
    assembly,
    compiler,
    sources,
  });
  return frozenProjection;
}

export function isMetalProgramProjection(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    metalProgramProjections.has(value)
  );
}

export function metalSourcesForProgramProjection(value) {
  const record = metalProgramProjections.get(value);
  if (!record) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-BRAND",
      "Metal sources require a nominal program projection"
    );
  }
  return record.sources;
}

function assertExactStageSet(records, expectedStages) {
  const observed = new Set();
  for (const { request } of records) {
    const stage = request.entryPoint.stage;
    if (!expectedStages.includes(stage)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-STAGES",
        `translation includes unselected stage ${JSON.stringify(stage)}`
      );
    }
    if (observed.has(stage)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-STAGES",
        `translation duplicates selected stage ${JSON.stringify(stage)}`
      );
    }
    observed.add(stage);
  }
  const missing = expectedStages.filter((stage) => !observed.has(stage));
  if (missing.length !== 0) {
    projectionFail(
      "VGPU-C1-METAL-PROJECTION-STAGES",
      `translations omit selected stages ${missing
        .map(JSON.stringify)
        .join(", ")}`
    );
  }
}

function assertUniqueMetalNames(records) {
  const observed = new Set();
  for (const { request } of records) {
    const name = request.entryPoint.metal;
    if (observed.has(name)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-METAL-NAME",
        `emitted Metal entry name ${JSON.stringify(name)} is duplicated`
      );
    }
    observed.add(name);
  }
}

function assertOneCompilerIdentity(records) {
  const compiler = records[0]?.response.compiler;
  for (const { response } of records.slice(1)) {
    if (!isDeepStrictEqual(response.compiler, compiler)) {
      projectionFail(
        "VGPU-C1-METAL-PROJECTION-COMPILER",
        "program translations report different compiler identities"
      );
    }
  }
  return compiler;
}

function assembleInternalBindings(records) {
  const slotsByRole = new Map();
  for (const { request, response } of records) {
    const stage = request.entryPoint.stage;
    for (const internal of response.result.internalBindings) {
      const slots = slotsByRole.get(internal.role) ?? [];
      slots.push(
        ...internal.slots.map((slot) => ({
          stage,
          ...structuredClone(slot),
        }))
      );
      slotsByRole.set(internal.role, slots);
    }
  }
  return [...slotsByRole.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([role, slots]) => ({
      role,
      slots: slots.sort(
        (left, right) =>
          stageRank(left.stage) - stageRank(right.stage) ||
          compare(left.resourceClass, right.resourceClass) ||
          left.index - right.index
      ),
    }));
}

function stageRank(stage) {
  const rank = stageOrder.indexOf(stage);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function projectionFail(code, message) {
  throw new MetalProgramProjectionError(code, message);
}
