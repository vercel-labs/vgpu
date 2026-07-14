# by-example §2 fullscreen pass

This example is the minimal ring-1 render loop: initialize a headless GPU, create an explicit render target, build a fragment-only fullscreen pass, pass ordinary JS numbers with `set()`, and draw into the target.

## Run it

```bash
# Local no-GPU gate: validates the public contract and shader shape.
pnpm exec vitest run examples/by-example-s02-fullscreen

# GPU render gate (Docker/Xvfb): validates the rendered pixels.
docker run --rm --platform linux/arm64 -v "$PWD:/workspace" -w /workspace -e VGPU_DOCKER_TEST=1 vgpu-test-dev:spike \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xp=$!; pnpm exec vitest run examples/by-example-s02-fullscreen; s=$?; kill $xp; exit $s'
```

## What to expect

The GPU test renders an 8×8 `rgba8unorm` target. The blue channel at the center is near full intensity because `time` and `speed` are explicit uniform values supplied by the example, not hidden globals.
