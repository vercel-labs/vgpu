# Frame

`gpu.frame` is both a callable one-frame submit helper and a `FrameRunner`. It creates one command encoder, lets you encode any number of explicit-target render passes, then submits once.

## Import

```ts
import type { Frame, FramePass, FramePassOptions, FrameLoopHandle, FrameRunner } from "vgpu";
```

## Signature

```ts
import type { Bundle, ClearColor, Draw, DrawCallOptions, Effect, Target } from "vgpu";

interface FramePassOptions {
  readonly target: Target;
  readonly clear?: boolean | ClearColor;
}

interface FrameLoopHandle { stop(): void; }
interface FrameLoopOptions { readonly fps?: number; }
type FrameLoopCallback = (frame: Frame) => void;

declare class Frame {
  done: Promise<void>;
  pass(target: Target, body: Effect | Draw | ((pass: FramePass) => void)): void;
  pass(options: FramePassOptions, body: Effect | Draw | ((pass: FramePass) => void)): void;
  submit(): void;
}

declare class FramePass {
  readonly target: Target;
  draw(drawable: Draw | Effect, opts?: DrawCallOptions): void;
  bundles(...bundles: readonly Bundle[]): void;
}

declare class FrameRunner {
  frame(cb?: (frame: Frame) => void): Frame;
  loop(cb: FrameLoopCallback, opts?: FrameLoopOptions): FrameLoopHandle;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.frame.cb | `(frame: Frame) => void` | ✖ | `undefined` | If supplied, called and then `frame.submit()` runs in `finally`. If omitted, submit manually. |
| gpu.clearColor | `ClearColor` | ✖ | `[0, 0, 0, 1]` | Writable default clear color used when pass `clear` is omitted or `true`. Assign a `GPUColor` object or `[r, g, b, a]`. |
| frame.pass.target | `Target \| FramePassOptions` | ✔ | — | Pass a bare target for the allocation-free common case, or an options bag when customizing clear/preserve behavior. |
| opts.target | `Target` | ✔ | — | Required inside `FramePassOptions`. Use a `Surface` from `gpu.surface(canvas)` or an offscreen `Target` from `gpu.target({ size })`. |
| opts.clear | `boolean \| ClearColor` | ✖ | `true` | Omitted or `true` clears with `gpu.clearColor`; `false` preserves existing color and depth with load ops; a color clears with that color. |
| frame.pass.body | `Effect \| Draw \| ((pass: FramePass) => void)` | ✔ | — | Pass a drawable directly for a single draw, or a callback to encode multiple draw and bundle commands. |
| pass.draw.drawable | `Draw \| Effect` | ✔ | — | A main API (`vgpu`) draw or fullscreen effect. |
| pass.draw.opts | `DrawCallOptions` | ✖ | `{}` | Per-call counts and dynamic offsets. Target is the frame pass target. |
| pass.bundles.bundles | `readonly Bundle[]` | ✔ | — | Bundles recorded by `gpu.bundle({ target }, cb)`. |
| runner.loop.cb | `(frame: Frame) => void` | ✔ | — | Called on each scheduled frame; frame is submitted in `finally`. Surface auto-resize runs before this callback. |
| runner.loop.opts.fps | `number` | ✖ | `0` (uncapped) | Positive values cap by minimum frame interval `1000 / fps`; omitted or non-positive uses every rAF/timer tick. |

**Returns:** `gpu.frame()` / `FrameRunner.frame()` return `Frame`; `Frame.pass()` and `Frame.submit()` return `void`; `FramePass.draw()` and `.bundles()` return `void`; `loop()` returns `FrameLoopHandle` with `stop()`.

**Throws:** `VGPU-TARGET-REQUIRED` for runtime JS calls that omit a frame pass target; `VGPU-CLEAR-COLOR-INVALID` for invalid `gpu.clearColor` assignments or clear colors; `VGPU-PASS-PRESERVE-MSAA` when `clear: false` is used on an MSAA target; `VGPU-FRAME-REENTRANT` when a frame is started from another frame or from a surface resize callback; `VGPU-R3-BUNDLE-STALE` or `VGPU-R3-BUNDLE-INVALID` when replaying invalid/stale bundles; draw/pass binding errors such as `VGPU-R1-BINDING-NEVER-SET` propagate during encoding. Raw claimed-group validation is delivered asynchronously through `gpu.onError`.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
gpu.clearColor = [0.02, 0.02, 0.04, 1];

const scene = gpu.target({ size: [64, 64], format: "rgba8unorm" });
const draw = gpu.draw({ shader: `
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.4, 1.0, 1.0); }
` });

gpu.frame((frame) => {
  frame.pass(scene, (pass) => pass.draw(draw)); // clears with gpu.clearColor
});
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const target = gpu.target({ size: [16, 16] });
const effect = gpu.effect(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
const handle = gpu.frame.loop((frame) => {
  frame.pass({ target, clear: false }, effect); // preserve color and depth
}, { fps: 30 });
handle.stop();
```

## Notes

- `Frame`, `FramePass`, and `FrameRunner` are type-only public exports. Create frames through `gpu.frame`, not `new Frame(...)`.
- There is no default target and no implicit canvas target; every `frame.pass` names its target.
- Omitted `clear` and `clear: true` clear with `gpu.clearColor`. Pass a color to clear one pass with that color without changing the default.
- `clear: false` preserves color and depth contents within the same target. On `Surface`, repeated passes in one frame layer onto the same current texture; the first preserved surface pass of a new browser frame reads the swapchain's fresh contents, not the previous frame's image.
- MSAA targets cannot be preserved because their multisample attachments use `storeOp: "discard"`; render accumulation/preserve passes into a non-MSAA target instead.
- **Hot loops:** options bags and pass callbacks are read synchronously, so you can hoist and reuse them. For zero-per-frame-JS-cost replay, record stable work with `gpu.bundle` and replay the bundle.
- `frame.done` is resolve-only. Await it as a completion/timing signal for readbacks, benchmarks, deterministic tests, or teardown; use `gpu.onError` plus `await gpu.settled()` for asynchronous errors.
- Do not `await frame.done` inside a RAF/frame loop. Schedule the next frame as soon as `gpu.frame()` returns, or you serialize CPU and GPU work.
- **See also:** `Gpu.frame`, `Surface`, `Effect`, `Draw`, `Bundle`, `Target`.
