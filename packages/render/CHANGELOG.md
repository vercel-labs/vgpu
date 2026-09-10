# @vgpu/render

## 0.5.0-rc.0

### Minor Changes

- 588a94e: Unify core and public texture creation around explicit `kind`, spatial `size`, array `layers`, and nonempty `usage`. Creation metadata is snapshotted and frozen; mip/sample allocation and additional view formats retain their explicit opt-ins.

  Breaking changes for this pre-1.0 minor: remove `Texture.resize()` and Target/Surface read delegates. Select an attachment, then call `texture.read({ mipLevel: 0, region: "all" })` or `readFloats(options)`. Reads now include every selected layer/slice, support mip-relative crops, and validate usage, sample count, bounds and allocations. Buffer reads are unchanged.

  Texture pairs and Targets prepare replacements before publishing them; synchronous preparation failures preserve the old generation. Destroyed tracked bindings fail early, and bundles capturing destroyed resources become stale. Raw native views retain native lifetime validation. Compute cache entries are isolated from draw entries even when they bind the same resource.

  See `docs/texture-api-migration.md` in the repository for old/new creation, readback, metadata and replacement examples. This changeset requests the next minor; it does not publish or assign a release version.

### Patch Changes

- Updated dependencies [588a94e]
  - @vgpu/core@0.5.0-rc.0

## 0.4.1

### Patch Changes

- @vgpu/core@0.4.1

## 0.4.0

### Patch Changes

- @vgpu/core@0.4.0

## 0.3.1

### Patch Changes

- @vgpu/core@0.3.1

## 0.3.0

### Patch Changes

- @vgpu/core@0.3.0
- @vgpu/core@0.3.0

## 0.1.7

### Patch Changes

- @vgpu/core@0.2.0

- f526de2: Respell the published README and reference docs for the 0.2.0 free-function API (`surface(gpu, canvas)`, `draw(gpu, …)`, `frameLoop(gpu, cb)`, `geometry(gpu, …)`), so copied snippets compile. No runtime change: `@vgpu/render`'s own exports are untouched.
- Updated dependencies [0026ff2]
- Updated dependencies [f526de2]
- Updated dependencies [ccbdd95]
- Updated dependencies [8c186ae]
- Updated dependencies [d030381]
- Updated dependencies [388477e]
- Updated dependencies [e37f89d]
- Updated dependencies [bf7c688]
- Updated dependencies [12aa696]
- Updated dependencies [3da184f]
  - @vgpu/core@0.2.0
