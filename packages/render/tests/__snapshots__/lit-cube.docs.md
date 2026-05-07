# Lit cube snapshot

`lit-cube.png` is the canonical pixel reference for the lit cube acceptance test.

To regenerate it from a Dawn-capable environment, run:

```sh
pnpm typecheck
pnpm run generate-lit-cube-snapshot
```

Then commit the updated PNG together with the reason for the change.

Visual sanity check: the image should show an orange-ish cube from `srgb(0xCC8844)` on a dark blue background. The cube is rotated 30 degrees around Y and is lit by a directional light with travel direction `(-1, -1, -1)`.

Render target format is `rgba8unorm-srgb` to match Linux compatibility-mode Dawn backends. The PNG bytes are sRGB-encoded; viewers display the gamma-correct image directly.

The matrix math is deterministic, and Dawn rasterization is expected to be stable across runs of the same Dawn build. If the snapshot changes after a Dawn update, treat that as an explicit maintenance decision.
