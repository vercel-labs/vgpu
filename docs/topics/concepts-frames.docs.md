---
title: Frames
summary: frame(gpu, cb) encodes your passes and submits once; frameLoop(gpu, cb) drives animation.
relatedSymbols:
  - Frame
  - FrameRunner
  - FrameLoopHandle
prevNext:
  prev:
    title: Passes
    href: /concepts/passes
  next:
    title: Render bundles
    href: /concepts/render-bundles
order: 60
---

# Frames

A frame is one unit of GPU work. Inside it you open passes, each drawing into a target you choose, and draw the effects you created earlier. Everything is encoded into one command encoder, and vgpu submits it once when the callback returns.

## Render a single frame

[`frame(gpu)`](/reference/vgpu/frame#framerunner) runs synchronously and renders immediately — every pass inside is encoded into one command encoder and submitted once. That single submit is what the frame is for:

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, `
  struct Params { time: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
  }
`, { set: { params: { time: 0 } } });
const postEffect = effect(gpu, `
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let base = textureSampleLevel(src, samp, uv, 0.0);
    return vec4f(1.0 - base.rgb, 1.0);
  }
`);

// ---cut---
const sceneTarget = target(gpu, { size: [canvasTarget.size[0], canvasTarget.size[1]] });
postEffect.set({
  src: sceneTarget,
  samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
});

frame(gpu, (currentFrame) => {
  currentFrame.pass(sceneTarget, pulseEffect);
  currentFrame.pass(canvasTarget, postEffect);
}); // two passes, one encoder, one submit
```

One-shot draws like `pulseEffect.draw(canvasTarget)` are the simple default for a single pass. Multi-pass hot paths should use `frame(gpu)` to batch passes into one command encoder and one submit. One-shot draws never join a surrounding frame; inside `frame(gpu)`, always go through `frame.pass()`.

> Warning: one-shot `draw()` calls do not join a surrounding frame — inside a frame callback they submit on their own immediately. Inside `frame(gpu)`, always draw through `frame.pass()`.

> Warning: Do not call `frame(gpu)` from inside another frame callback or from a surface resize callback. vgpu throws `VGPU-FRAME-REENTRANT` so command encoders stay ordered and predictable.

## When the callback throws

The callback is all-or-nothing for the frame's command buffer. If it returns, the frame submits once. If it throws, vgpu cancels the frame: nothing it encoded reaches the GPU, the timer and visibility instances it attached release their per-frame retains, and the error reaches you unchanged. A half-encoded frame is never presented by accident.

The guarantee is scoped to the command buffer. The frame clock has already ticked, uniform updates and buffer writes made inside the callback stay applied, and anything submitted on its own from inside the callback (a one-shot `draw()`, a manual frame) has already reached the queue. A canvas the frame already opened a pass on still shows that browser frame, only empty, because the texture was acquired but never drawn into. Errors the GPU reports after a successful submit still arrive through `gpu.onError` and `await gpu.settled()`.

If you called `frame.submit()` yourself before the throw, that work is on the queue and stays there; vgpu just rethrows your error. That is also the way to keep partial work on purpose:

```ts
import { init, frame, target } from "vgpu";
import type { Frame } from "vgpu";

const gpu = await init();
const scene = target(gpu, { size: [64, 64] });
function encode(currentFrame: Frame): void { currentFrame.pass(scene, () => undefined); }

// ---cut---
frame(gpu, (currentFrame) => {
  try {
    encode(currentFrame);
  } catch (error) {
    currentFrame.submit(); // keep what was encoded before the failure
    throw error;
  }
});
```

## Render loops

For animation, use [`frameLoop(gpu)`](/reference/vgpu/frame#framerunner) — it runs your frame every tick:

```ts
import { clock, init, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, `
  struct Params { time: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
  }
`, { set: { params: { time: 0 } } });

// ---cut---
const time = clock(gpu);
const handle = frameLoop(gpu, (frame) => {
  pulseEffect.set({ params: { time: time.time } }); // update uniforms every tick
  frame.pass(canvasTarget, pulseEffect);
}, { fps: 30 });

handle.stop(); // call it when your component unmounts
```

The loop advances the frame clock — `clock(gpu).time`, `deltaTime` and `frameCount` — and runs surface auto-resize before each tick. The optional `fps` throttles it.

Each tick follows the same rule as `frame(gpu, cb)`: a tick that throws submits nothing for that frame. It also ends the loop, because the error escapes the animation-frame callback where nothing can catch it; the handle is released as if you had called `stop()`. Recover, then start a new `frameLoop(gpu, cb)`.

This is what the same loop looks like by hand with `requestAnimationFrame`:

```ts
import { init, effect, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, `
  struct Params { time: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
  }
`, { set: { params: { time: 0 } } });

// ---cut---
function tick() {
  pulseEffect.set({ params: { time: performance.now() / 1000 } }); // you own the clock now
  pulseEffect.draw(canvasTarget);
  requestAnimationFrame(tick); // and the scheduling
}
requestAnimationFrame(tick);
```

Both work. `frameLoop(gpu)` is the same loop with the clock, throttling, and resize handling done for you.

See it live: the [fluid example](/examples/fluid) runs a compute-driven simulation with exactly this frame loop shape.
