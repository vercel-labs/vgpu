---
"vgpu": minor
"@vgpu/core": minor
"@vgpu/render": minor
---

Unify core and public texture creation around explicit `kind`, spatial `size`, array `layers`, and nonempty `usage`. Creation metadata is snapshotted and frozen; mip/sample allocation and additional view formats retain their explicit opt-ins.

Breaking changes for this pre-1.0 minor: remove `Texture.resize()` and Target/Surface read delegates. Select an attachment, then call `texture.read({ mipLevel: 0, region: "all" })` or `readFloats(options)`. Reads now include every selected layer/slice, support mip-relative crops, and validate usage, sample count, bounds and allocations. Buffer reads are unchanged.

Texture pairs and Targets prepare replacements before publishing them; synchronous preparation failures preserve the old generation. Destroyed tracked bindings fail early, and bundles capturing destroyed resources become stale. Raw native views retain native lifetime validation. Compute cache entries are isolated from draw entries even when they bind the same resource.

See `docs/plans/texture-api-migration.md` in the repository for old/new creation, readback, metadata and replacement examples. This changeset requests the next minor; it does not publish or assign a release version.
