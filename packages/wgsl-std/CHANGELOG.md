# @vgpu/wgsl-std

## 0.6.0-rc.0

### Minor Changes

- a332125: Rebuild `vgpu/scene` around material-independent scene composition: CPU transform math, parent/child groups, external hierarchy evaluation, fixed-capacity typed instances, and camera functions that operate on application-owned state. Geometry recipes remain available.

  Add `vgpu/scene/gpu` to publish instance matrices and custom attributes as an instanced vertex stream, borrowing an existing mesh. Add pure `@vgpu/wgsl-std/scene` helpers for world matrices, positions, directions, and normals. Shaders own their resources and binding locations; applications connect uniforms by name and choose their own shading and passes.

  Remove the previous mesh, material, light, camera-node, and orbit-control abstractions. This is a breaking pre-1.0 API revision.

  [Migration guide](https://github.com/vercel-labs/vgpu/blob/v0.6.0-rc.0/docs/migrations/0.6.0.docs.md).

## 0.5.0

## 0.5.0-rc.1

## 0.5.0-rc.0

## 0.4.1

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
