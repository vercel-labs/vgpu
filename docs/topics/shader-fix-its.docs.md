# Shader diagnostics and fix-its

Use these messages as the self-correction map for generated shader code. Prefer fixing the shader/binding shape over suppressing errors.

## `VGPU-RESOLVE-MODULE-BINDING`

WGSL modules must be pure helpers. A module may export structs, functions, constants, and types, but it must not declare `@group(...) @binding(...)` variables. Move bindings to the entry shader:

```wgsl
// noise.wgsl
export struct NoiseConfig { seed: u32 }
export fn noise(p: vec2f, cfg: NoiseConfig) -> f32 { return f32(cfg.seed) * 0.0; }
```

```wgsl
// entry.wgsl
import { NoiseConfig, noise } from "./noise.wgsl";
@group(0) @binding(0) var<uniform> cfg: NoiseConfig;
```

## Unprepared shader input: `VGPU-SHADER-SOURCE-UNPREPARED`

`draw`, `effect`, and `compute` take only a prepared `ShaderSource` (`version: 2`), which carries the reflection they read instead of parsing WGSL. They throw this code synchronously for a raw WGSL string or a legacy `{ version: 1, wgsl, functionExports? }` artifact. A `.wgsl` import that arrives as a string — no loader configured, or a raw/URL import — lands here too.

Import static shaders through `@vgpu/wgsl/loader-vite` or `@vgpu/wgsl/loader-webpack` (see [Next.js and other bundlers](/guides/nextjs)); prepare runtime WGSL once per source change with `prepareShader()`:

```ts
import { init, effect } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const tintSource = `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.9, 0.3, 0.2, 1.0); }`;

// Before: effect(gpu, tintSource) threw VGPU-SHADER-SOURCE-UNPREPARED
const tint = effect(gpu, prepareShader(tintSource)); // prepare once, outside the frame loop
```

Upgrade a stored v1 asset with `prepareShader(legacyAsset, path)`; the object form keeps its `functionExports`.

## Artifact version mismatch: `VGPU-SHADER-SOURCE-VERSION`

The artifact's `version` is an integer vgpu does not support — usually a loader, prebuilt asset, or package from a different `@vgpu/wgsl` release than the `vgpu` runtime. The message names the received version, the supported version (`2`), and — when the artifact has one — its `producer`. Align the `@vgpu/wgsl` and `vgpu` versions, then rebuild the loader output and regenerate prebuilt assets.

## Malformed artifact: `VGPU-SHADER-SOURCE-INVALID`

The shader argument is not a string but is not a valid prepared artifact either: it is not an object, `version` is missing or not an integer, a required field (`wgsl`, `reflection`, `sourceChecksum`, `producer`) is missing, accessor-backed, or malformed, the reflection metadata is inconsistent, or `sourceChecksum` does not match `wgsl`. The structured detail gives the field `path` and the `reason`. `prepareShader()` throws the same code for input it cannot prepare.

Regenerate the artifact with a supported producer — the `@vgpu/wgsl` loaders or `prepareShader()` — and do not hand-write or edit `reflection`, `sourceChecksum`, or `wgsl` after preparation. An import that returns an object without `version` and `wgsl` means the bundler is not running a vgpu loader for `.wgsl`.

## Stage storage limits: `VGPU-LIMIT-STORAGE-VERTEX` / `VGPU-LIMIT-STORAGE-FRAGMENT`

**Symptom:** creating a draw reports that the selected vertex or fragment entry uses more storage buffers than the device grants for that stage.

**Cause:** bindings statically reached by the selected entry point count against `maxStorageBuffersInVertexStage` or `maxStorageBuffersInFragmentStage` (falling back to `maxStorageBuffersPerShaderStage` when a stage-specific property is unavailable). Unused declarations and resources used only by another stage do not count.

**Fix:** if the adapter supports it, request the reported count through `init({ requiredLimits: { maxStorageBuffersInVertexStage: count } })` or the fragment sibling. For vertex data, prefer `geometry(gpu, ...)` vertex streams where possible. Otherwise reduce the number of storage buffers reached by that stage. The error detail includes `stage`, `entryPoint`, `count`, `limit`, and the `{ name, group, binding }` bindings that were counted.

## Missing binding: `VGPU-R1-BINDING-NEVER-SET`

Every reflected binding must be set by name or covered by a claimed group. Do not rely on globals or implicit buffers.

```text
const effect = effect(gpu, postShader); // a prepared .wgsl import
effect.set({ params: { time: clock(gpu).time }, tex: target.color, samp: sampler(gpu) });
```

## Ownership flip: `VGPU-R1-OWNERSHIP-FLIP`

The first `set()` decides ownership. Plain JS values are lib-owned and updated in place. Resources (`Uniform`, storage, textures, samplers, bind groups) are user-owned. Do not switch the same binding from JS value to resource later.

```text
// Pick one from the start:
wave.set({ params: { time: 0 } });     // lib-owned
// or
wave.set({ params: sharedUniform });   // user-owned
```

## Bool host-shareable layouts

Rule of thumb: treat every bool host-shareable uniform as a `u32` in WGSL. WGSL `bool` is not a stable host-shareable uniform field for JS packing. Use `u32` and encode booleans as `0` or `1`.

```wgsl
struct Params { enabled: u32 }
```

## Bundle stale

`VGPU-R3-BUNDLE-STALE` means a bundle was recorded for a different render signature or an old bind-group/resource identity. A bundle survives resizing the target it draws onto when formats/depth/sample count match; re-record after resource identity changes, including sampling a resized target. Plain JS `set()` updates are safe because buffers are written in place.

## Manual bind-group claims

`VGPU-R4-GROUP-CLAIMED`, `VGPU-R4-GROUP-INCOMPATIBLE`, and `VGPU-R4-GROUP-VALIDATION` all point to manual bind-group ownership. Build the bind group with `draw.layout(group)` or `draw.layout(group, { dynamicOffsets: true })`, call `draw.group(group, bindGroup)`, and send dynamic offsets through `p.draw(draw, { offsets })`.

## Compute aliasing

`VGPU-R1-STORAGE-ALIASING` means a writable storage buffer is bound as both source and destination. Use `pingPongStorage(gpu)` and swap after dispatch.
