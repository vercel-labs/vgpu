# Optimize a pass

Optimize one pass by first deciding what changes every frame.

## 1. Static commands

If the draw list is static, record it once:

```ts
const passBundle = gpu.bundle({ target }, (b) => {
  b.draw(background);
  b.draw(grid);
});
gpu.frame.loop((f) => f.pass({ target }, (p) => p.bundles(passBundle)));
```

## 2. Animated scalar/vector values

Keep the pass object and write values in place:

```ts
const pass = gpu.pass(WGSL, { set: { time: 0, exposure: 1 } });
gpu.frame.loop(() => {
  pass.set({ time: gpu.time });
  pass.draw({ target });
});
```

## 3. Resources that swap

Use ping-pong rather than allocating a new target or storage buffer:

```ts
const state = gpu.pingPong(512, 512, { format: "rgba16float" });
gpu.frame.loop((f) => {
  step.set({ src: state.read.color });
  f.pass({ target: state.write }, (p) => p.draw(step));
  state.swap();
});
```

## 4. Many objects

Use instancing for many copies of the same draw, or use `UniformPool` plus `draw.group()` when every object needs a different uniform block.
