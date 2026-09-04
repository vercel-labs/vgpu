import { isDeepStrictEqual } from "node:util";

import { allocateBindingSlots } from "../../c1-binding-slots/lib/allocate.mjs";
import { verifyBindingSlotAllocation } from "../../c1-binding-slots/lib/verify.mjs";

export const METAL_BINDING_MODEL = "vgpu-metal-binding-slots-v1";

const stages = ["vertex", "fragment", "compute"];

// These ceilings belong to the current integration canary, not a published
// device-support claim. The compiler protocol already fixes the candidate
// immediate-data reservation at buffer(30).
const canaryProfile = Object.freeze({
  ceilings: Object.freeze(
    Object.fromEntries(
      stages.map((stage) => [
        stage,
        Object.freeze({ buffer: 31, texture: 128, sampler: 16 }),
      ])
    )
  ),
  internalReservations: Object.freeze(
    stages.map((stage) =>
      Object.freeze({
        role: "immediate-data",
        stage,
        resourceClass: "buffer",
        component: "buffer",
        index: 30,
        count: 1,
      })
    )
  ),
});

const storageBufferSizes = Object.freeze({
  model: "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1",
  immediateDataByteOffset: 4,
});

export class MetalSlotAllocationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetalSlotAllocationError";
  }
}

/**
 * Derives one program-level union of external Metal slots from semantic-v1.
 * Internal slots remain candidate reservations until Tint reports which ones
 * the generated entry point actually uses.
 */
export function allocateExternalMetalSlots(program) {
  const input = {
    profile: structuredClone(canaryProfile),
    programs: [
      {
        semanticProgram: program.name,
        entries: stages
          .filter((stage) => program.entryPoints[stage] !== undefined)
          .map((stage) => ({
            stage,
            bindings: [...program.entryPoints[stage].bindings],
          })),
        bindings: program.bindings.map((binding) => ({
          id: binding.id,
          group: binding.group,
          binding: binding.binding,
          components: componentsForBinding(binding),
        })),
        requiredInternalBindings: [],
      },
    ],
  };

  let raw;
  try {
    raw = allocateBindingSlots(input);
    verifyBindingSlotAllocation(input, raw);
  } catch (cause) {
    throw new MetalSlotAllocationError(cause?.message ?? String(cause));
  }
  const projected = raw.programs[0];
  if (
    raw.programs.length !== 1 ||
    projected.semanticProgram !== program.name ||
    !isDeepStrictEqual(projected.internalBindings, [])
  ) {
    throw new MetalSlotAllocationError(
      "binding allocator returned an invalid program projection"
    );
  }
  return {
    bindingModel: METAL_BINDING_MODEL,
    semanticProgram: projected.semanticProgram,
    bindings: projected.bindings,
  };
}

/** Projects the allocated program union into the one-entry compiler shape. */
export function compilerMetalPolicyForStage(program, allocation, stage) {
  const entry = program.entryPoints[stage];
  if (!entry) {
    throw new MetalSlotAllocationError(
      `program ${JSON.stringify(program.name)} has no ${JSON.stringify(
        stage
      )} entry`
    );
  }
  if (
    allocation.bindingModel !== METAL_BINDING_MODEL ||
    allocation.semanticProgram !== program.name
  ) {
    throw new MetalSlotAllocationError(
      "slot allocation names a different program or binding model"
    );
  }

  const semanticBindings = new Map(
    program.bindings.map((binding) => [binding.id, binding])
  );
  const active = new Set(entry.bindings);
  const observed = new Set();
  const bindings = [];
  for (const projected of allocation.bindings) {
    const semantic = semanticBindings.get(projected.semanticBinding);
    if (!semantic) {
      throw new MetalSlotAllocationError(
        `slot allocation references unknown binding ${JSON.stringify(
          projected.semanticBinding
        )}`
      );
    }
    const selected = projected.slots.filter((slot) => slot.stage === stage);
    if (active.has(projected.semanticBinding)) {
      if (selected.length !== 1) {
        throw new MetalSlotAllocationError(
          `active binding ${JSON.stringify(
            projected.semanticBinding
          )} does not have exactly one ${stage} slot`
        );
      }
      observed.add(projected.semanticBinding);
      bindings.push({
        group: semantic.group,
        binding: semantic.binding,
        slots: selected.map(({ stage: _stage, ...slot }) =>
          structuredClone(slot)
        ),
      });
    } else if (selected.length !== 0) {
      throw new MetalSlotAllocationError(
        `inactive binding ${JSON.stringify(
          projected.semanticBinding
        )} has a ${stage} slot`
      );
    }
  }
  if (
    !isDeepStrictEqual([...observed].sort(compare), [...active].sort(compare))
  ) {
    throw new MetalSlotAllocationError(
      `${stage} compiler projection does not cover its exact active binding set`
    );
  }

  const reservation = canaryProfile.internalReservations.find(
    (candidate) => candidate.stage === stage
  );
  if (!reservation) {
    throw new MetalSlotAllocationError(
      `slot profile has no ${stage} immediate-data reservation`
    );
  }
  const { role, stage: _stage, ...slot } = reservation;
  return {
    bindingModel: METAL_BINDING_MODEL,
    bindings,
    internalReservations: [
      {
        role,
        slots: [{ mode: "direct", ...structuredClone(slot) }],
      },
    ],
    storageBufferSizes: structuredClone(storageBufferSizes),
  };
}

function componentsForBinding(binding) {
  if (binding.kind === "buffer") {
    return [{ resourceClass: "buffer", component: "buffer", count: 1 }];
  }
  if (binding.kind === "texture" || binding.kind === "storage-texture") {
    return [{ resourceClass: "texture", component: "texture", count: 1 }];
  }
  if (binding.kind === "sampler") {
    return [{ resourceClass: "sampler", component: "sampler", count: 1 }];
  }
  throw new MetalSlotAllocationError(
    `semantic binding ${JSON.stringify(binding.id)} kind ${JSON.stringify(
      binding.kind
    )} is outside the direct Metal slot profile`
  );
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
