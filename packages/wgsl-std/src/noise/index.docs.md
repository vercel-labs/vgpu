# @vgpu/wgsl-std/noise

Pure WGSL procedural noise primitives for `@vgpu/wgsl` imports. The module contains declarations only: no bindings, overrides, hidden state, or entry points.

```wgsl
import { voronoi3d } from "@vgpu/wgsl-std/noise";
import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

fn animatedCell(position: vec2f, time: f32) -> f32 {
  let sample = voronoi3d(vec3f(position, time));
  return unitFloat(pcg3d(bitcast<vec3u>(sample.cell)).x);
}
```

## API

- `VoronoiSample2 { f1: f32, f2: f32, cell: vec2i }`
- `VoronoiSample3 { f1: f32, f2: f32, cell: vec3i }`
- `voronoi2d(position: vec2f) -> VoronoiSample2`
- `voronoi3d(position: vec3f) -> VoronoiSample3`

## Voronoi conventions

`voronoi2d` and `voronoi3d` return Euclidean feature-point distances for the nearest (`f1`) and second-nearest (`f2`) neighboring cells. The returned values satisfy `f1 <= f2`.

Each integer lattice cell owns one fully jittered feature point in `[0.0, 1.0)^n`. Feature jitter is generated with `pcg2d` or `pcg3d` from `@vgpu/wgsl-std/hash`, then converted to floats with `unitFloat`.

The functions search a one-cell neighborhood around `floor(position)`:

- 2D: `3 x 3` candidate cells.
- 3D: `3 x 3 x 3` candidate cells.

The `cell` field is the exact integer lattice cell containing the winning feature point, not a float identifier. Use it for stable per-cell styling, random values, or masks:

```wgsl
let v = voronoi3d(position);
let random = unitFloat(pcg3d(bitcast<vec3u>(v.cell)).x);
let edge = v.f2 - v.f1;
```

## Styling policy

This module intentionally returns only geometric Voronoi data. It does not choose cell colors, edge widths, jitter strength, or smoothing curves. Those policy choices remain in application shaders so `voronoi2d` and `voronoi3d` can serve many visual styles.
