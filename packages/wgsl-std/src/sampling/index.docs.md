# @vgpu/wgsl-std/sampling

Raw WGSL sampling utility module for `@vgpu/wgsl` imports. The module contains pure declarations only: no bindings, overrides, hidden state, resources, or entry points.

```wgsl
import { goldenAngle, vogelDisk, hammersley2d } from "@vgpu/wgsl-std/sampling";

fn sampleKernel(index: u32, count: u32, rotation: f32) -> vec3f {
  let disk = vogelDisk(index, count, rotation);
  let sequence = hammersley2d(index, count);
  return vec3f(disk, sequence.y);
}
```

## API

- `goldenAngle: f32`: golden angle in radians, rounded to WGSL `f32` precision (`2.3999631`).
- `vogelDisk(index: u32, count: u32, phi: f32) -> vec2f`: deterministic Vogel spiral point in the unit disk.
- `radicalInverseVdc(bits: u32) -> f32`: base-2 Van der Corput radical inverse using bit reversal, clamped to the largest `f32` below `1.0` for all-bits-set inputs.
- `hammersley2d(index: u32, count: u32) -> vec2f`: 2D Hammersley point `(index / count, radicalInverseVdc(index))`.

## Native WGSL before

```wgsl
fn localVogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  if (count == 0u) {
    return vec2f(0.0);
  }
  let goldenAngle = 2.3999631;
  let angle = f32(index) * goldenAngle + phi;
  let radius = sqrt((f32(index) + 0.5) / f32(count));
  return vec2f(cos(angle), sin(angle)) * radius;
}
```

## Utility import after

```wgsl
import { vogelDisk } from "@vgpu/wgsl-std/sampling";

fn localVogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  return vogelDisk(index, count, phi);
}
```

## Vogel disk samples

`vogelDisk(index, count, phi)` computes:

```text
angle = f32(index) * goldenAngle + phi
radius = sqrt((f32(index) + 0.5) / f32(count))
point = vec2f(cos(angle), sin(angle)) * radius
```

Use `index < count` for samples bounded by the unit disk. `phi` is an angular offset in radians; pass a per-frame or per-pixel rotation when you want to rotate the entire pattern without changing radial placement.

If `count == 0u`, the function returns `vec2f(0.0)` defensively instead of dividing by zero.

## Low-discrepancy sequence samples

`radicalInverseVdc(bits)` implements the standard base-2 Van der Corput radical inverse by reversing the 32 bits of `bits` and scaling by `1 / 2^32`. Because WGSL returns `f32`, the final value is clamped to `0.99999994` (the largest `f32` below `1.0`) so an all-bits-set input does not round up to `1.0`.

`hammersley2d(index, count)` returns:

```text
vec2f(f32(index) / f32(count), radicalInverseVdc(index))
```

Use `index < count` for the conventional Hammersley point set over `[0.0, 1.0) x [0.0, 1.0)`. If `count == 0u`, the function returns `vec2f(0.0)` defensively instead of dividing by zero.

## Performance notes

- `vogelDisk` uses one `sqrt`, one `cos`, and one `sin` per sample. Precompute or reuse points when a fixed kernel is sampled many times.
- `radicalInverseVdc` uses integer shifts, masks, and one float conversion; it does not use trigonometry or hidden state.
- `hammersley2d` is deterministic and stateless. It is not a random number generator and does not decorrelate samples across pixels by itself.

## Provenance

Vogel disk sampling comes from Vogel's 1979 published mathematical model for phyllotaxis using the golden-angle spiral. The implementation here is an original transcription of the formula into WGSL.

The Van der Corput radical inverse and Hammersley point set are standard low-discrepancy sequence definitions. The bit-reversal implementation is an original WGSL implementation of those mathematical definitions and uses only ordinary integer mask/shift operations.

## Deferred helpers

This module intentionally does not include Perlin noise, simplex noise, fBM, value noise, or shader-magic hash/random snippets. Those helpers need separate API, quality, and provenance review so v1 avoids copying unattributed shader snippets or baking in a hidden random/resource model.
