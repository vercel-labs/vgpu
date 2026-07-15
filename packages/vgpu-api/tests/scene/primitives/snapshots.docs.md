# Primitive snapshot regeneration

## Regeneration command

```sh
VGPU_WRITE_SNAPSHOTS=1 VGPU_DOCKER_TEST=1 pnpm test:docker -- packages/render/tests/primitives
```

Re-run without `VGPU_WRITE_SNAPSHOTS` before committing:

```sh
VGPU_DOCKER_TEST=1 pnpm test:docker -- packages/render/tests/primitives
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

These snapshots are gated on `VGPU_DOCKER_TEST=1` and are only deterministic on the Docker/Dawn path. Non-Docker WebGPU implementations may produce different bytes.
