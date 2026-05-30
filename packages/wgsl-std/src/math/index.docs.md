# @vgpu/wgsl-std/math

Raw WGSL math utility module for `@vgpu/wgsl` imports.

All exports are pure WGSL declarations. Import only the helpers you use:

```wgsl
import { saturate, remap, safeNormalize3, rotate2d } from "@vgpu/wgsl-std/math";

fn shade(normal: vec3f, uv: vec2f) -> vec3f {
  let n = safeNormalize3(normal, vec3f(0.0, 0.0, 1.0));
  let rotatedUv = rotate2d(uv, 0.78539816339);
  let weight = saturate(remap(-1.0, 1.0, 0.0, 1.0, n.z));
  return vec3f(rotatedUv, weight);
}
```

## Catalog

### `saturate(value: f32) -> f32`

Clamps a scalar `f32` to `[0.0, 1.0]` using WGSL `clamp`.

### `clamp01(value: f32) -> f32`

Alias for `saturate`. Use whichever name is clearer at the call site.

### `inverseLerp(from: f32, to: f32, value: f32) -> f32`

Returns `(value - from) / (to - from)` without clamping the result. Values outside the input range produce values outside `[0.0, 1.0]`.

If `from == to`, the input range has no length and the helper returns `0.0` deterministically instead of dividing by zero.

### `remap(inMin: f32, inMax: f32, outMin: f32, outMax: f32, value: f32) -> f32`

Maps `value` from input range `[inMin, inMax]` into output range `[outMin, outMax]` using `inverseLerp`, without clamping.

If `inMin == inMax`, `inverseLerp` returns `0.0`, so `remap` returns `outMin`.

### `safeNormalize2(value: vec2f, fallback: vec2f) -> vec2f`
### `safeNormalize3(value: vec3f, fallback: vec3f) -> vec3f`
### `safeNormalize4(value: vec4f, fallback: vec4f) -> vec4f`

Normalizes non-zero vectors and returns `fallback` for zero-length vectors. The fallback is returned exactly as supplied; normalize it first if the fallback must be unit length.

WGSL does not provide user-defined generic functions for multiple vector dimensions, so v1 exports explicit `2`, `3`, and `4` dimensional names instead of a single overloaded `safeNormalize`.

### `rotate2d(value: vec2f, radians: f32) -> vec2f`

Rotates a `vec2f` by `radians` counter-clockwise around the origin:

```wgsl
let up = rotate2d(vec2f(1.0, 0.0), 1.57079632679);
```
