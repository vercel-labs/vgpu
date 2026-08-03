import type { EntryPointInfo } from "@vgpu/wgsl/reflect-source";
import { VGPUError } from "./errors.ts";

/**
 * Required accessor for the per-entry reflection metadata that drives bind group layouts.
 *
 * `bindings`, `samplingPairs` and `inputs` are optional on the type (a compute entry has no
 * `inputs`) but reflection always attaches the two resource fields, and always attaches `inputs` to
 * a vertex entry. Absence therefore means the reflection was hand-built or lost its non-enumerable
 * metadata on the way here — the pre-#252 failure mode, where a `??` fallback silently widened
 * visibility, dropped texture filterability or produced zero vertex attributes. This throws instead.
 *
 * One generic accessor, throwing inline rather than through an errors.ts factory: this ships in
 * the client bundle, which is budgeted (`pnpm bundle-check`).
 */
export function entryMetadata<K extends "bindings" | "samplingPairs" | "inputs">(entry: EntryPointInfo, field: K, where: string): NonNullable<EntryPointInfo[K]> {
  const value = entry[field];
  if (!value) {
    throw new VGPUError({
      code: "VGPU-REFLECT-ENTRY-METADATA-MISSING",
      message: `Entry point '${entry.name}' has no reflected ${field}.`,
      fix: "Pass the reflection from reflectSource()/resolveShader().",
      where,
    });
  }
  return value as NonNullable<EntryPointInfo[K]>;
}
