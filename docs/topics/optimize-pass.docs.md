# Optimize a pass

Optimize one pass by first deciding what changes every frame.

## 0. Measure first

Attach a `gpu.timer()` span (requires `init({ requiredFeatures: ["timestamp-query"] })`) and judge every change by the reported GPU milliseconds:

```text
const timer = gpu.timer();
timer.onResults((spans) => console.log(`pass ${spans.pass}ms`));
gpu.frame.loop((f) => f.pass({ target, timer: timer.span("pass") }, (p) => p.draw(effect)));
```

## 1. Static commands

If the draw list is static, record it once:

```text
const effectBundle = gpu.bundle({ target }, (b) => {
  b.draw(background);
  b.draw(grid);
});
gpu.frame.loop((f) => f.pass(target, (p) => p.bundles(effectBundle)));
```

## 2. Animated scalar/vector values

Keep the pass object and write values in place:

```text
const effect = gpu.effect(WGSL, { set: { time: 0, exposure: 1 } });
gpu.frame.loop((f) => {
  effect.set({ time: gpu.time });
  f.pass(target, effect);
});
```

## 3. Resources that swap

Use ping-pong rather than allocating a new target or storage buffer:

```text
const state = gpu.pingPong(512, 512, { format: "rgba16float" });
gpu.frame.loop((f) => {
  step.set({ src: state.read.color });
  f.pass(state.write, step);
  state.swap();
});
```

## 4. Many objects

Use instancing for many copies of the same draw, or use `UniformPool` plus `draw.group()` when every object needs a different uniform block.
