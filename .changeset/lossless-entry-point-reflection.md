---
"@vgpu/wgsl": patch
"@vgpu/cli": patch
"vgpu": patch
---

Serialize entry-point reflection losslessly. `EntryPointInfo` now carries a non-enumerable `toJSON()` (returning the new exported `EntryPointInfoJSON` type), so `JSON.stringify(reflection)` keeps each entry point's `bindings`, `samplingPairs` and `inputs` instead of silently dropping them — `vgpu check` output includes the per-entry metadata its documented JSON promises. `Object.keys`/spread behaviour is unchanged, and `structuredClone` still drops those fields because it ignores `toJSON`. Consumers that build bind group layouts now throw `VGPU-REFLECT-ENTRY-METADATA-MISSING` when an entry point arrives without that metadata, instead of falling back to a silently wrong layout (widened stage visibility, `unfilterable-float` textures, or zero vertex attributes).
