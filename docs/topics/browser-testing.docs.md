# Browser testing with Playwright WebGPU

Browser tests should exercise the same public API users copy: `init(canvas)`, explicit targets, and deterministic frame submission. Avoid hidden app globals and avoid relying on a continuous loop in assertions.

```text
import { init } from "vgpu";

export async function renderOnce(canvas: HTMLCanvasElement) {
  const gpu = await init(canvas, { dpr: 1, autoResize: false });
  const target = gpu.screen!;
  const pass = gpu.pass(WGSL, { set: { time: 0, texel: target.texelSize } });
  gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(pass)));
  return gpu;
}
```

## Test checklist

- Use fixed DPR/size (`dpr: 1`, `autoResize: false`) for pixel snapshots.
- Submit with `gpu.frame(...)` for one deterministic frame, not `requestAnimationFrame` loops.
- Read from explicit offscreen targets with `target.read()` when testing Node/mock-compatible logic.
- Keep WGSL imports pure: modules export helpers only; bindings live in the entry shader. If a module declares a binding, fix `VGPU-RESOLVE-MODULE-BINDING`.
- For headless tests use `vgpu/mock` for deterministic unit tests and `vgpu/node` only when Dawn/WebGPU behavior is under test.
