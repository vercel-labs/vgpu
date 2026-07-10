# @vgpu/wgsl-std/hash

Pure WGSL integer and float hash helpers for `@vgpu/wgsl` imports. The module contains declarations only: no bindings, overrides, hidden state, or entry points.

```wgsl
import { hashU32, pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

fn cellRandom(cell: vec3i) -> f32 {
  return unitFloat(pcg3d(bitcast<vec3u>(cell)).x);
}
```

## API

- `hashU32(value: u32) -> u32`
- `pcg2d(value: vec2u) -> vec2u`
- `pcg3d(value: vec3u) -> vec3u`
- `unitFloat(hash: u32) -> f32`
- `hash1(seed: f32) -> f32`
- `hash2(seed: vec2f) -> vec2f`
- `hash3(seed: vec3f) -> vec3f`

## Integer hashes

`hashU32` implements Chris Wellons' `lowbias32` integer hash. It is not PCG; the name intentionally describes the public behavior, while the docs name the algorithm so shader ports can match constants bit-for-bit.

`pcg2d` and `pcg3d` implement Jarzynski and Olano-style multi-output PCG hash variants for vector lattice coordinates. Use them when you need two or three decorrelated integer outputs from one seed, such as jittering a 2D or 3D feature point.

## Unit floats

`unitFloat(hash)` maps a `u32` hash to `[0.0, 1.0)` with exact 24-bit mantissa precision:

```text
f32(hash >> 8u) * (1.0 / 16777216.0)
```

Because the lower eight bits are discarded before conversion, the result never reaches `1.0`.

## Float-domain wrappers

`hash1`, `hash2`, and `hash3` bitcast float inputs to unsigned integers, hash those bit patterns, then convert each result with `unitFloat`. This avoids precision cliffs from sine/fract-style hashes and is stable across the full `f32` bit pattern range.

Precision notes:

- `hash1(-0.0) != hash1(0.0)` because the raw float bits differ.
- NaN payloads are caller responsibility; different NaN encodings can hash differently.
- For lattice positions, prefer `floor()` before hashing so integer cell coordinates remain exact.
- Integer-lattice callers can skip float wrappers entirely: `unitFloat(pcg3d(bitcast<vec3u>(cell)).x)`.
