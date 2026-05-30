# @vgpu/wgsl-std

Pure WGSL utility snippets for use with `@vgpu/wgsl` import resolution.

This package intentionally ships raw `.wgsl` modules instead of JavaScript wrappers or a macro/include system. Import the explicit utility area you need:

```wgsl
import { saturate, remap, safeNormalize3, rotate2d } from "@vgpu/wgsl-std/math";
import { identityVec3f } from "@vgpu/wgsl-std/color";
```

There is no root WGSL export. Subpath exports resolve to physical WGSL files:

- `@vgpu/wgsl-std/math` -> `src/math/index.wgsl`
- `@vgpu/wgsl-std/color` -> `src/color/index.wgsl`

WGSL snippets in this package must stay pure declaration modules: functions, constants, structs, and aliases only. They must not introduce hidden bindings, resource variables, overrides, or entry points.

## Math utilities

`@vgpu/wgsl-std/math` includes scalar range helpers and vector safety helpers:

- `saturate(value: f32) -> f32`: clamp to `[0.0, 1.0]`.
- `clamp01(value: f32) -> f32`: alias for `saturate`.
- `inverseLerp(from: f32, to: f32, value: f32) -> f32`: unclamped inverse lerp; returns `0.0` when `from == to`.
- `remap(inMin: f32, inMax: f32, outMin: f32, outMax: f32, value: f32) -> f32`: unclamped range remap; returns `outMin` when the input range is zero-length.
- `safeNormalize2/3/4(value, fallback)`: normalize non-zero vectors and return `fallback` for zero-length vectors. WGSL has no user-defined generic overloads, so dimensions are explicit in v1.
- `rotate2d(value: vec2f, radians: f32) -> vec2f`: counter-clockwise 2D rotation by radians.

See `src/math/index.docs.md` for examples and edge-case notes.

The color module currently contains only the scaffold identity helper; the reviewed color utility catalog is planned for a later slice.
