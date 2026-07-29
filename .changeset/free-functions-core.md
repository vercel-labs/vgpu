---
"vgpu": minor
---

**BREAKING: the `Gpu` facade is gone. Every factory is a free function whose first argument is the gpu.**

0.2.0 is a clean break: there are no deprecated aliases and no compatibility layer. `init()` still returns a `Gpu`, but that object is now only a device handle and a lifetime — `device`, `gpu`, `disposed`, `onError()`, `settled()`, `dispose()`. Everything that used to hang off it is a named export of `vgpu`, `vgpu/node` and `vgpu/mock`.

Why: the facade forced every entrypoint to import every feature, so a program that only drew a triangle still paid for compute, timers, occlusion queries, ping-pong and the scene primitives. Free functions are tree-shakable — you pay for the imports you write. The objects the factories return keep their methods (`frame.pass`, `draw.set`, `geometry.slice`, `timer.span`, `effect.draw`), so only the creation call changes.

| 0.1.x | 0.2.0 |
|---|---|
| `gpu.surface(canvas, opts?)` | `surface(gpu, canvas, opts?)` |
| `gpu.target(opts)` | `target(gpu, opts)` |
| `gpu.effect(source, opts?)` | `effect(gpu, source, opts?)` |
| `gpu.draw(opts)` | `draw(gpu, opts)` |
| `gpu.geometry(descriptor \| recipe)` | `geometry(gpu, descriptor \| recipe)` |
| `gpu.frame(cb?)` | `frame(gpu, cb?)` |
| `gpu.frame.loop(cb, opts?)` | `frameLoop(gpu, cb, opts?)` |
| `gpu.bundle(opts, record)` | `bundle(gpu, opts, record)` |
| `gpu.compute(source, opts?)` | `compute(gpu, source, opts?)` |
| `gpu.storage(bytes, access?)` | `storage(gpu, bytes, access?)` |
| `gpu.pingPong(w, h, opts?)` | `pingPong(gpu, w, h, opts?)` |
| `gpu.pingPongStorage(bytes)` | `pingPongStorage(gpu, bytes)` |
| `gpu.uniforms(values)` | `uniforms(gpu, values)` |
| `gpu.sampler(desc?)` | `sampler(gpu, desc?)` |
| `gpu.timer()` | `timer(gpu)` |
| `gpu.visibility(opts?)` | `visibility(gpu, opts?)` |
| `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` | `clock(gpu).time` / `.deltaTime` / `.frameCount` |
| `gpu.clearColor` (global default) | `target.clearColor` / `surface.clearColor` (per target) |

```ts
// 0.1.x
const gpu = await init();
const view = gpu.surface(canvas, { dpr: [1, 2] });
const wave = gpu.effect(WAVE_WGSL, { set: { speed: 2 } });
gpu.clearColor = [0.02, 0.02, 0.04, 1];
gpu.frame.loop(() => {
  wave.set({ time: gpu.time });
  gpu.frame((f) => f.pass(view, wave));
});

// 0.2.0
import { clock, effect, frameLoop, init, surface } from "vgpu";

const gpu = await init();
const view = surface(gpu, canvas, { dpr: [1, 2], clearColor: [0.02, 0.02, 0.04, 1] });
const wave = effect(gpu, WAVE_WGSL, { set: { speed: 2 } });
const time = clock(gpu);
frameLoop(gpu, (frame) => {
  wave.set({ time: time.time });
  frame.pass(view, wave);
});
```

### The clock is a free function too: `clock(gpu)`

`clock(gpu)` returns `{ time, deltaTime, frameCount, advance(dtSeconds) }` — one instance per gpu, created lazily. Reading it is the direct replacement for the old `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` fields, which no longer exist.

`advance(dtSeconds)` is new and is the reason the clock is worth an object: it moves the clock forward immediately and claims that frame's tick, so a later `frame(gpu)` counts the frame but does not advance time a second time. One tick per frame, manual first. That is what makes an external ticker (GSAP, Motion, an XR frame callback), a timescale, a fixed timestep or a deterministic replay possible without a second clock fighting vgpu's:

```ts
import { clock, frame } from "vgpu";

const time = clock(gpu);
gsap.ticker.add((_total, deltaMs) => {
  time.advance(deltaMs / 1000);            // your delta, your timeline
  frame(gpu, (f) => f.pass(view, wave));   // renders; does not re-advance
});
```

Without `advance()`, `frame()` and `frameLoop()` keep advancing the clock with wall-clock deltas exactly like 0.1.x. `frameCount` counts frames, never advances. Invalid deltas (negative, `NaN`, `Infinity`) throw `VGPU-CLOCK-DELTA-INVALID`. The full technique is documented in the guide *Driving vgpu with an external ticker — GSAP/Motion/XR*.

### Clear color belongs to the target

The global `gpu.clearColor` is gone. Each target carries its own default, at creation or at runtime:

```ts
const scene = target(gpu, { size: [1280, 720], clearColor: [0.02, 0.02, 0.04, 1] });
const view = surface(gpu, canvas, { clearColor: [0, 0, 0, 1] });

scene.clearColor = [0.1, 0, 0.1, 1];       // mutable, validated on assignment
```

Precedence in a pass: the pass `clear` color wins, then `target.clearColor`, then the built-in `[0, 0, 0, 1]`. `clear: false` is unchanged — it still preserves color/depth, and it is still rejected on MSAA targets (`VGPU-PASS-PRESERVE-MSAA`). Invalid values still throw `VGPU-CLEAR-COLOR-INVALID`, now pointing at `target.clearColor` / `surface.clearColor`.

### Geometry is one symbol

`geometry(gpu, input)` accepts both a raw descriptor and a scene recipe (`box()`, `plane()`, …), and each recipe carries its own builder — importing `box` retains only the box builder, not the primitive table. There is no `geometryFromRecipe`, and `vgpu/scene` deliberately does not re-export the `geometry` factory (it would pull the device path into the scene budget); import it from `vgpu`.

### Diagnostics

Error **codes are unchanged**. Every user-facing message and fix-it now spells the API the way you call it — `compute(gpu, source)`, `bundle(gpu, { target }, cb)`, `storage(gpu, bytes, { indirect: true })`, `sampler(gpu)` — so a copy-pasted fix compiles. Two cross-cutting codes are now documented on `Gpu`:

- `VGPU-GPU-DISPOSED` — a factory (or `clock`) ran after `gpu.dispose()`.
- `VGPU-GPU-FOREIGN` — the first argument was not created by `init()`.

### Migration checklist

1. Import what you create: `import { clock, draw, effect, frame, frameLoop, geometry, sampler, surface, target } from "vgpu";` (or `vgpu/node`, `vgpu/mock`).
2. Rewrite `gpu.x(...)` as `x(gpu, ...)` per the table. Methods on returned objects do not change.
3. Replace `gpu.frame.loop(cb)` with `frameLoop(gpu, cb)` and `gpu.frame(cb)` with `frame(gpu, cb)`.
4. Replace `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` with a `const time = clock(gpu)` hoisted out of the loop.
5. Move `gpu.clearColor` to the target(s) that clear: an option at creation, or an assignment at runtime.
6. Type-only imports (`Gpu`, `Surface`, `Target`, `Draw`, `Effect`, `Frame`, …) are unchanged.
