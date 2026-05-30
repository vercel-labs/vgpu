# @vgpu/wgsl-std/constants

Raw WGSL math constants for `@vgpu/wgsl` imports. The module contains pure `const` declarations only: no functions, bindings, overrides, hidden state, resources, or entry points.

```wgsl
import { pi, tau, goldenAngle } from "@vgpu/wgsl-std/constants";

fn angleForIndex(index: u32) -> f32 {
  return f32(index) * goldenAngle + tau * 0.25;
}
```

## API

- `pi: f32`: π, rounded to WGSL `f32` precision (`3.1415927`).
- `tau: f32`: 2π, rounded to WGSL `f32` precision (`6.2831855`).
- `halfPi: f32`: π / 2, rounded to WGSL `f32` precision (`1.5707964`).
- `quarterPi: f32`: π / 4, rounded to WGSL `f32` precision (`0.7853982`).
- `invPi: f32`: 1 / π, rounded to WGSL `f32` precision (`0.3183099`).
- `invTau: f32`: 1 / 2π, rounded to WGSL `f32` precision (`0.15915494`).
- `goldenRatio: f32`: φ, rounded to WGSL `f32` precision (`1.618034`).
- `goldenAngle: f32`: golden angle in radians, rounded to WGSL `f32` precision (`2.3999631`).

## Native WGSL before

```wgsl
const PI: f32 = 3.1415927;
const TAU: f32 = 6.2831855;

fn radiansFromTurns(turns: f32) -> f32 {
  return turns * TAU;
}
```

## Utility import after

```wgsl
import { tau } from "@vgpu/wgsl-std/constants";

fn radiansFromTurns(turns: f32) -> f32 {
  return turns * tau;
}
```

## Notes

These constants are plain WGSL `const` declarations. The module is intentionally small so importing it does not add much WGSL text. Declaration-level dead-code elimination for larger WGSL utility modules is tracked in https://github.com/vercel-labs/vgpu/issues/98.

`goldenAngle` is also exported by `@vgpu/wgsl-std/sampling` for sampling-only imports. Prefer this constants module when sharing the value across non-sampling shader code.

## Provenance

These are standard mathematical constants transcribed directly into WGSL `f32` literals and rounded to the same precision style as the rest of `@vgpu/wgsl-std`.
