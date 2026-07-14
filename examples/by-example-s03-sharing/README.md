# by-example §3 set() sharing

This example demonstrates mixed ownership in one bind group. A user-owned `Uniform` named `camera` is shared by two draws, while each draw keeps its own lib-owned `params` color set from plain JS values. Updating or replacing the shared resource is explicit; ordinary per-draw values remain managed by vgpu.

## Run it

```bash
# Local no-GPU gate: validates the sharing contract and shader bindings.
pnpm exec vitest run examples/by-example-s03-sharing

# GPU render gate (Docker/Xvfb): validates both draws consume the same camera.
docker run --rm --platform linux/arm64 -v "$PWD:/workspace" -w /workspace -e VGPU_DOCKER_TEST=1 vgpu-test-dev:spike \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xp=$!; pnpm exec vitest run examples/by-example-s03-sharing; s=$?; kill $xp; exit $s'
```

## What to expect

The rendered 16×16 target is split into two semantic regions: the left half is red (`cube`) and the right half is green (`floor`). Both colors are multiplied by the same shared camera exposure uniform.
