# @vgpu/wgsl-std

## 0.4.0

## 0.3.1

## 0.3.0

## 0.2.0

### Minor Changes

- 65cc995: Add Perlin (`noise/perlin`) and Simplex (`noise/simplex`) noise, each with 2D/3D
  base functions and amplitude-normalized FBM variants. Guaranteed `(-1, 1)` range,
  table-free integer-hash gradients (bit-identical across backends), no seed
  parameter (offset the input by >=2 units to decorrelate). See each module's
  `index.docs.md` for measured range/variance/cost tables and a clouds recipe.

### Patch Changes

- 8345a03: The `@vgpu/wgsl-std/noise` (Voronoi) docs now show the octave-plus-domain-warp recipe that produces a cloud/plasma look from `voronoi3d` and cross-link to the dedicated `noise/perlin`/`noise/simplex` subpaths for smooth gradient noise, plus a note that the package ships as a dependency of `vgpu`.
