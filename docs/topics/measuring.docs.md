# Measuring

Measure the thing you intend to optimize: CPU encoding, pipeline warm-up, bind-group churn, target memory, or shader cost. The public API makes those boundaries visible.

## CPU encoding vs replay

If the CPU is busy rebuilding the same render pass, compare a direct loop with a bundle:

```text
const staticScene = gpu.bundle({ target }, (b) => staticDraws.forEach((draw) => b.draw(draw)));
gpu.frame.loop((f) => f.pass({ target }, (p) => p.bundles(staticScene)));
```

## First-frame hitches

If the first visible frame stutters, pre-warm target signatures with `compile()`:

```text
const hdr = gpu.target({ size: [256, 256], format: "rgba16float", depth: true, msaa: true });
const draw = gpu.draw({ shader: WGSL, mesh });
await draw.compile(hdr);
```

## Binding churn

If allocations or bind-group count grows every frame, switch repeated JS values to in-place `set()`, shared state to `gpu.uniforms()`, or many object uniforms to `UniformPool` + dynamic offsets.

## GPU pass cost

If a pass looks expensive, confirm it on the GPU before optimizing it. CPU time around `frame.pass(...)` measures encoding only — encoders record commands, they do not run them. Mark the pass with a `gpu.timer()` span instead:

```text
const gpu = await init({ requiredFeatures: ["timestamp-query"] });
const timer = gpu.timer();
timer.onResults((spans) => console.log(`shadows ${spans.shadows}ms, main ${spans.main}ms`));
gpu.frame.loop((f) => {
  f.pass({ target: shadowMap, timer: timer.span("shadows") }, (p) => p.draw(casters));
  f.pass({ target: scene, timer: timer.span("main") }, (p) => p.draw(world));
});
```

Durations arrive through `onResults` in milliseconds, one or two frames after submit; readback never blocks a frame. A span times the whole pass, not individual draws — move suspect work into its own pass to isolate it.

## Correctness before speed

When measuring visual output, render one deterministic `gpu.frame(...)` into an explicit target and read it back. Do not measure while also resizing, compiling pipelines lazily, or creating temporary targets inside the loop.
