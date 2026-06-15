# @vgpu/wgsl-std

Pure WGSL utility snippets for use with `@vgpu/wgsl` import resolution.

This package intentionally ships raw `.wgsl` modules instead of JavaScript wrappers or a macro/include system. Import the explicit utility area you need:

```wgsl
import { saturate, remap, safeNormalize3, rotate2d } from "@vgpu/wgsl-std/math";
import { srgbToLinear3, linearToSrgb3, luminance, applyExposure } from "@vgpu/wgsl-std/color";
import { vogelDisk, hammersley2d } from "@vgpu/wgsl-std/sampling";
import { pi, tau, goldenAngle } from "@vgpu/wgsl-std/constants";
```

There is no root WGSL export. Subpath exports resolve to physical WGSL files:

- `@vgpu/wgsl-std/math` -> `src/math/index.wgsl`
- `@vgpu/wgsl-std/color` -> `src/color/index.wgsl`
- `@vgpu/wgsl-std/sampling` -> `src/sampling/index.wgsl`
- `@vgpu/wgsl-std/constants` -> `src/constants/index.wgsl`

WGSL snippets in this package must stay pure declaration modules: functions, constants, structs, and aliases only. They must not introduce hidden bindings, resource variables, overrides, or entry points.

## Constants

`@vgpu/wgsl-std/constants` includes common math constants as plain WGSL `const` declarations:

- `pi: f32`: π.
- `tau: f32`: 2π.
- `halfPi: f32`: π / 2.
- `quarterPi: f32`: π / 4.
- `invPi: f32`: 1 / π.
- `invTau: f32`: 1 / 2π.
- `goldenRatio: f32`: φ.
- `goldenAngle: f32`: golden angle in radians.

The constants module is intentionally small so importing it does not add much WGSL text. `resolveShader()` also performs conservative declaration-level dead-code elimination, so unused declarations from larger WGSL utility modules are pruned from shaders with entry points before minification. `goldenAngle` remains available from `@vgpu/wgsl-std/sampling` for sampling-only shaders.

See `src/constants/index.docs.md` for examples and precision notes.

## Math utilities

`@vgpu/wgsl-std/math` includes scalar range helpers and vector safety helpers:

- `saturate(value: f32) -> f32`: clamp to `[0.0, 1.0]`.
- `clamp01(value: f32) -> f32`: alias for `saturate`.
- `inverseLerp(rangeStart: f32, rangeEnd: f32, value: f32) -> f32`: unclamped inverse lerp; returns `0.0` when `rangeStart == rangeEnd`.
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

WGSL has no user-defined generics, so vector transfer helpers use `3`/`4` suffixes while scalar transfer helpers keep the base names. Color transfer helpers expect normal `[0.0, 1.0]` color-channel inputs but do not clamp; clamp explicitly with `@vgpu/wgsl-std/math` when desired. The transfer and luminance formulas are mathematically standard and useful for physically meaningful conversions, but they may not match artistic/tuned approximations in an existing shader without deliberate visual review. The color module intentionally defers PBR helpers and tonemappers (ACES/Hable/Filament/Reinhard) so applications choose their own display transform.

See `src/color/index.docs.md` for formulas, examples, and performance notes.

## Sampling utilities

`@vgpu/wgsl-std/sampling` includes deterministic sampling helpers for unit-disk kernels and low-discrepancy 2D point sets:

- `goldenAngle: f32`: golden angle in radians, rounded to WGSL `f32` precision (`2.3999631`).
- `vogelDisk(index: u32, count: u32, phi: f32) -> vec2f`: Vogel spiral sample in the unit disk for `index < count`; `phi` rotates the pattern in radians. Returns `vec2f(0.0)` when `count == 0u` to avoid division by zero.
- `radicalInverseVdc(bits: u32) -> f32`: standard base-2 Van der Corput radical inverse via deterministic bit reversal, clamped to the largest `f32` below `1.0` for high reversed-bit values whose WGSL `f32` product would otherwise round to `1.0`.
- `hammersley2d(index: u32, count: u32) -> vec2f`: Hammersley point `(index / count, radicalInverseVdc(index))`; returns `vec2f(0.0)` when `count == 0u`.

Before, shader code often repeats the sampling math manually:

```wgsl
fn localVogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  if (count == 0u) {
    return vec2f(0.0);
  }
  let angle = f32(index) * 2.3999631 + phi;
  let radius = sqrt((f32(index) + 0.5) / f32(count));
  return vec2f(cos(angle), sin(angle)) * radius;
}
```

With the utility module, import the helper explicitly:

```wgsl
import { vogelDisk } from "@vgpu/wgsl-std/sampling";

fn localVogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  return vogelDisk(index, count, phi);
}
```

Performance note: `vogelDisk` uses `sqrt`, `cos`, and `sin`; precompute fixed kernels if they are reused heavily. `hammersley2d`/`radicalInverseVdc` are stateless integer/float math and are not random-number generators.

Provenance: Vogel disk sampling is an original WGSL transcription of Vogel's 1979 published golden-angle phyllotaxis model. Van der Corput and Hammersley samples are standard low-discrepancy sequence formulas implemented here with original WGSL bit operations; they are deliberate reviewed additions beyond the original minimal `vogelDisk` requirement to satisfy the updated user preference for fewer deferrals while staying provenance-clean. `concentricDisk` is deferred for separate API review of disk-mapping conventions and edge behavior, and Perlin/simplex/fBM/value noise plus shader-magic hash/random snippets are deferred for separate API and provenance review.

See `src/sampling/index.docs.md` for examples, input ranges, and edge-case notes.
