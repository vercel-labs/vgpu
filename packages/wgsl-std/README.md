# @vgpu/wgsl-std

Pure WGSL utility snippets for use with `@vgpu/wgsl` import resolution.

This package intentionally ships raw `.wgsl` modules instead of JavaScript wrappers or a macro/include system. Import the explicit utility area you need:

```wgsl
import { saturate, remap, safeNormalize3, rotate2d } from "@vgpu/wgsl-std/math";
import { srgbToLinear3, linearToSrgb3, luminance, applyExposure } from "@vgpu/wgsl-std/color";
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

## Color utilities

`@vgpu/wgsl-std/color` includes non-PBR color helpers:

- `srgbToLinear(value: f32) -> f32`: standard IEC/sRGB decode transfer for one channel.
- `srgbToLinear3(color: vec3f) -> vec3f`: decode RGB channels from sRGB to linear light.
- `srgbToLinear4(color: vec4f) -> vec4f`: decode RGB channels and preserve alpha.
- `linearToSrgb(value: f32) -> f32`: standard IEC/sRGB encode transfer for one channel.
- `linearToSrgb3(color: vec3f) -> vec3f`: encode RGB channels from linear light to sRGB.
- `linearToSrgb4(color: vec4f) -> vec4f`: encode RGB channels and preserve alpha.
- `luminance(color: vec3f) -> f32`: relative luminance using Rec.709/sRGB coefficients `(0.2126, 0.7152, 0.0722)`. Pass linear-light color.
- `applyExposure(color: vec3f, exposure: f32) -> vec3f`: multiply by `exp2(exposure)`, where exposure is measured in stops/EV.

WGSL has no user-defined generics, so vector transfer helpers use `3`/`4` suffixes while scalar transfer helpers keep the base names. Color transfer helpers expect normal `[0.0, 1.0]` color-channel inputs but do not clamp; clamp explicitly with `@vgpu/wgsl-std/math` when desired. The color module intentionally defers PBR helpers and tonemappers (ACES/Hable/Filament/Reinhard) so applications choose their own display transform.

See `src/color/index.docs.md` for formulas, examples, and performance notes.
