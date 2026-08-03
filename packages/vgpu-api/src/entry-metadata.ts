import type { EntryPointInfo } from "@vgpu/wgsl/reflect-source";
import { entryMetadataMissingError } from "./errors.ts";

/**
 * Required accessors for the per-entry reflection metadata that drives bind group layouts.
 *
 * `bindings`, `samplingPairs` and `inputs` are optional on the type (a compute entry has no
 * `inputs`) but reflection always attaches the two resource fields, and always attaches `inputs` to
 * a vertex entry. Absence therefore means the reflection was hand-built or lost its non-enumerable
 * metadata on the way here — the pre-#252 failure mode, where a `??` fallback silently widened
 * visibility, dropped texture filterability or produced zero vertex attributes. These throw instead.
 */
export function entryBindings(entry: EntryPointInfo, where: string): NonNullable<EntryPointInfo["bindings"]> {
  if (!entry.bindings) throw entryMetadataMissingError(where, entry.name, "bindings");
  return entry.bindings;
}

export function entrySamplingPairs(entry: EntryPointInfo, where: string): NonNullable<EntryPointInfo["samplingPairs"]> {
  if (!entry.samplingPairs) throw entryMetadataMissingError(where, entry.name, "samplingPairs");
  return entry.samplingPairs;
}

export function entryInputs(entry: EntryPointInfo, where: string): NonNullable<EntryPointInfo["inputs"]> {
  if (!entry.inputs) throw entryMetadataMissingError(where, entry.name, "inputs");
  return entry.inputs;
}
