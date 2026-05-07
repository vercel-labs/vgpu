# frameClock

Measures elapsed time and frame delta in seconds. Use it in animation loops that need stable time values and pause support.

```ts
const clock = frameClock();
function frame() {
  const time = clock.now();
  const dt = clock.delta();
  update(time, dt);
}
```

Use `pause()`, `resume()`, and `reset()` to control the clock.
