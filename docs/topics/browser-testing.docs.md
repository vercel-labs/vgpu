# Browser testing with Playwright WebGPU

Browser tests should exercise the same public API users copy: `init()`, `gpu.surface(canvas, opts)`, explicit targets, and deterministic frame submission. Avoid hidden app globals and avoid relying on a continuous loop in assertions.

```text
import { init } from "vgpu";

export async function renderOnce(canvas: HTMLCanvasElement) {
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: 1, autoResize: false });
  const effect = gpu.effect(WGSL, { set: { time: 0, texel: surface.texelSize } });
  gpu.frame((f) => f.pass({ target: surface, clear: [0, 0, 0, 1] }, (p) => p.draw(effect)));
  return gpu;
}
```

## Test checklist

- Use fixed DPR/size (`dpr: 1`, `autoResize: false`, or explicit `size`) for pixel snapshots.
- Submit with `gpu.frame(...)` for one deterministic frame, not `requestAnimationFrame` loops.
- Read from explicit surfaces or offscreen targets with `target.read()`.
- Keep WGSL imports pure: modules export helpers only; bindings live in the entry shader. If a module declares a binding, fix `VGPU-RESOLVE-MODULE-BINDING`.
- For headless tests use `vgpu/mock` for deterministic unit tests and `vgpu/node` only when Dawn/WebGPU behavior is under test.
