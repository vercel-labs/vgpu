# Primitive snapshot regeneration

## Regeneration command

```sh
pnpm snapshots:update
```

This renders the pushed revision in native x64 CI and downloads unapproved candidates plus a visual
report. Review and copy only intentional changes, then commit/push them and verify:

```sh
pnpm snapshots:check
```

## Camera convention

Primitive batteries render `front`, `iso`, and `side` views. The positions are deliberately asymmetric:

- `front`: `[0, 0.5, 3]`
- `iso`: `[2, 2, 3]`
- `side`: `[3, 0.75, 0.25]`

The PR #33 retrospective showed that symmetric subjects and axis-aligned cameras can hide rendering bugs by producing identical images from different labels. The non-zero offsets make accidental matches much less likely.

## Distinctness contract

Every primitive battery must call `assertAllDistinct(...)` for its PNG set. The helper hashes each PNG with sha256 and fails if any two labels produce byte-identical output.

## Material variants

Each primitive is rendered with two variants:

- `pbr`: simple Lambert lighting with a single directional light and ambient term.
- `normal-debug-32`: world-space normals visualized as `normal * 0.5 + 0.5` for 32-byte primitive meshes.

## Background

Snapshots clear to `(63, 63, 80, 255)`. The dark blue-gray background keeps silhouettes visible without clipping normal-debug colors.

## Determinism

These snapshots run in the pinned Linux x64 Vulkan CI environment, separately from functional GPU
tests. Docker on ARM64 is not byte-equivalent to x64. `pnpm test` does not opt into canonical visual
comparisons. See `docs/visual-snapshots.md` for the contributor workflow and environment pins.
