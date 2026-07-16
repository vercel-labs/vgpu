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

## `VGPU-SHADER-SOURCE-INVALID`

main API (vgpu) shader arguments are either a WGSL string or a loader `ShaderSource { version: 1, wgsl }`. If importing `.wgsl` returns a URL/object without `version` and `wgsl`, configure `@vgpu/wgsl/loader-vite`, `@vgpu/wgsl/loader-webpack`, or pass a raw WGSL string.

```text
import shader from "./shader.wgsl";
const draw = gpu.draw({ shader });
```

## Missing binding: `VGPU-R1-BINDING-NEVER-SET`

Every reflected binding must be set by name or covered by a claimed group. Do not rely on globals or implicit buffers.

```text
const effect = gpu.effect(WGSL);
pass.set({ params: { time: gpu.time }, tex: target.color, samp: gpu.sampler() });
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

`VGPU-R3-BUNDLE-STALE` means a bundle was recorded against an old target or bind-group identity. Re-record after resize or resource identity changes. Plain JS `set()` updates are safe because buffers are written in place.

## Manual bind-group claims

`VGPU-R4-GROUP-CLAIMED`, `VGPU-R4-GROUP-INCOMPATIBLE`, and `VGPU-R4-GROUP-VALIDATION` all point to manual bind-group ownership. Build the bind group with `draw.layout(group)` or `draw.layout(group, { dynamicOffsets: true })`, call `draw.group(group, bindGroup)`, and send dynamic offsets through `p.draw(draw, { offsets })`.

## Compute aliasing

`VGPU-R1-STORAGE-ALIASING` means a writable storage buffer is bound as both source and destination. Use `gpu.pingPongStorage()` and swap after dispatch.
