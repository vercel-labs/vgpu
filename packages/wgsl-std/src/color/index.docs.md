# @vgpu/wgsl-std/color

Raw WGSL color utility module for `@vgpu/wgsl` imports. The module contains pure declarations only: no bindings, overrides, hidden state, or entry points.

```wgsl
import { srgbToLinear3, linearToSrgb3, luminance, applyExposure } from "@vgpu/wgsl-std/color";

fn shade(baseColorSrgb: vec3f, exposureStops: f32) -> vec3f {
  let linear = srgbToLinear3(baseColorSrgb);
  let exposed = applyExposure(linear, exposureStops);
  return linearToSrgb3(exposed);
}
```

## API

WGSL has no user-defined generics, so v1 uses an explicit dimensional suffix for vector transfer helpers and unsuffixed scalar helpers:

- `srgbToLinear(value: f32) -> f32`
- `srgbToLinear3(color: vec3f) -> vec3f`
- `srgbToLinear4(color: vec4f) -> vec4f`
- `linearToSrgb(value: f32) -> f32`
- `linearToSrgb3(color: vec3f) -> vec3f`
- `linearToSrgb4(color: vec4f) -> vec4f`
- `luminance(color: vec3f) -> f32`
- `applyExposure(color: vec3f, exposure: f32) -> vec3f`

The `vec4f` transfer helpers convert RGB channels and preserve alpha unchanged.

## sRGB transfer functions

`srgbToLinear*` and `linearToSrgb*` implement the standard IEC/sRGB piecewise transfer formulas:

```text
srgbToLinear(c) = c / 12.92                         when c <= 0.04045
                = ((c + 0.055) / 1.055) ^ 2.4       otherwise

linearToSrgb(c) = 12.92 * c                         when c <= 0.0031308
                = 1.055 * c ^ (1 / 2.4) - 0.055     otherwise
```

The expected input and output range is `[0.0, 1.0]` for color channels. These helpers do **not** clamp inputs or outputs; callers that need display-range saturation should import `saturate` or `clamp01` from `@vgpu/wgsl-std/math` explicitly.

## Luminance

`luminance(color)` returns relative luminance for a linear RGB color using Rec.709/sRGB coefficients:

```text
dot(color, vec3f(0.2126, 0.7152, 0.0722))
```

Pass linear-light color values. If your source is sRGB encoded, decode with `srgbToLinear3` before computing luminance.

## Exposure

`applyExposure(color, exposure)` treats `exposure` as photographic stops/EV and returns:

```text
color * exp2(exposure)
```

Examples: `0.0` leaves the color unchanged, `1.0` doubles it, and `-2.0` multiplies it by `0.25`. The function is intentionally unclamped so HDR pipelines can keep values above `1.0` until an explicit later display transform.

## Performance notes

- Scalar transfer helpers branch once and use `pow` only above the sRGB breakpoint.
- Vector transfer helpers call the scalar helper per RGB channel. This keeps behavior identical for scalar and vector paths and avoids hidden approximation tables.
- `luminance` is a single dot product; `applyExposure` is a scalar `exp2` and vector multiply.

## Deferred helpers

This v1 color module intentionally does not include PBR helpers, BRDF/Fresnel/IBL routines, ACES/Hable/Filament tonemappers, or a default tonemap. Tonemapping and PBR-specific utilities are deferred so applications choose their own display transform and resource model explicitly.
