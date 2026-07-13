# vgpu

> 0.0.8 — ring-1 public API scaffold

This package owns the bare `vgpu` specifier for the upcoming public API. Phase 0
only freezes package shape and exports; runtime `init()` wiring lands in Phase 2.

## Exports

- `vgpu` — browser entrypoint placeholder
- `vgpu/node` — Node/Dawn entrypoint placeholder
- `vgpu/mock` — mock-adapter entrypoint placeholder
- `vgpu/scene` — scene helpers placeholder
- `vgpu/client` — client environment typing placeholder

All entrypoints currently throw `Error("not implemented")` for runtime helpers.
