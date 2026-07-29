---
"vgpu": minor
"@vgpu/wgsl": minor
---

Add `constants` to `DrawOptions` (`draw(gpu)`) and `ComputeOptions` (`compute(gpu)`): constructor-only values for WGSL `override` pipeline constants, flowing into `GPUProgrammableStage.constants` — both the vertex and fragment stages for draws (WebGPU matches keys against the module's override declarations, not per entry point, so one record serves both stages) and the compute stage for compute pipelines. Key by override name, or by the decimal string of `N` when the declaration has `@id(N)` (the name is not usable then, mirroring WebGPU's identifier rule). Values are finite numbers or booleans; booleans convert to `1`/`0` doubles that WebGPU converts to the override's WGSL type (bool/i32/u32/f32/f16). Draws that differ only in `constants` compile distinct pipelines; an absent option — or an empty `{}` — keeps byte-identical descriptors and pipeline cache keys. `VGPU-CONSTANTS-INVALID` throws at construction for a non-object `constants`, a key that matches no override in the shader (the message lists the available overrides), a value that is neither a finite number nor a boolean, or an override declared without a default that `constants` does not provide.

`@vgpu/wgsl` reflection: `OverrideInfo` gains an optional `id` field carrying the `@id(N)` pipeline constant ID; `defaultValue` continues to mark declarations with a default initializer. The change is additive — existing `Reflection` consumers are unaffected.
