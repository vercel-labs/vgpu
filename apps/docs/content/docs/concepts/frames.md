---
title: "Frames"
description: "frame(gpu, cb) encodes your passes and submits once; frameLoop(gpu, cb) drives animation."
---

A frame is one unit of GPU work. Inside it you open render passes with explicit targets and compute passes that dispatch prepared kernels. Everything is encoded into one command encoder, and vgpu submits it once when the callback returns — which is why the callback is synchronous.

## Render a single frame

[`frame(gpu)`](/reference/vgpu/frame#framerunner) runs synchronously and renders immediately — every pass inside is encoded into one command encoder and submitted once. That single submit is what the frame is for:

```wgsl
// pulse.wgsl
struct Params { time: f32 }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
}
```

```wgsl
// post.wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(src, samp, uv, 0.0);
  return vec4f(1.0 - base.rgb, 1.0);
}
```

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";
import pulseShader from "./pulse.wgsl";
import postShader from "./post.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, pulseShader, { set: { params: { time: 0 } } });
const postEffect = effect(gpu, postShader);

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
import pulseShader from "./pulse.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, pulseShader, { set: { params: { time: 0 } } });

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
import pulseShader from "./pulse.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const pulseEffect = effect(gpu, pulseShader, { set: { params: { time: 0 } } });

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

## Compute and render in one submission

Use `f.computePass(pass => pass.dispatch(simulation, workgroups))` between render passes when work depends on their output. Each compute callback can dispatch several kernels, including indirect dispatches. The frame preserves pass order and submits the combined command buffer once. Standalone `simulation.dispatch()` remains an independent submission even if called inside the frame callback.

Prepare pipelines with `await simulation.compile()` before opening a frame. Compute-pass callbacks are synchronous and cannot nest other passes. Cancellation discards both render and compute commands belonging to the frame.

Direct draws and dispatches capture their current managed uniform values, and a `set()` that leaves the packed bytes unchanged keeps the snapshot already captured for later commands in the frame. Captures live in pooled uniform pages that return for reuse once the frame's GPU work completes or the frame is canceled, so frames that repeat the same draws in the same order reuse their bind groups. Storage buffers stay live for GPU-to-GPU dataflow. Explicit host writes, raw resources and render bundles keep their existing buffer semantics; later host writes are not inserted between encoded commands.

## Await before the frame, not inside it

`frame(gpu, cb)` submits the moment the callback returns. An `async` callback returns its promise at the first `await`, so the frame would submit before the rest of the callback encoded anything. Do the asynchronous work — compiling pipelines, loading textures, fetching data — before you call `frame(gpu)` or register `frameLoop(gpu)`, keep the encoding synchronous, and tear down outside the callback. The loop from the previous sections, with its preparation and teardown spelled out:

```wgsl
// simulation.wgsl
@group(0) @binding(0) var<storage, read_write> particles: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  particles[id.x] += vec4f(0.0, -0.01, 0.0, 0.0);
}
```

```wgsl
// shade.wgsl
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.1, 0.2, 0.4, 1.0);
}
```

```ts
import { init, compute, effect, frameLoop, storage, surface } from "vgpu";
import shadeShader from "./shade.wgsl";
import simulationShader from "./simulation.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const particles = storage(gpu, 64 * 16);
const simulation = compute(gpu, simulationShader, { set: { particles } });
const shade = effect(gpu, shadeShader);

// ---cut---
await simulation.compile(); // async preparation, before the loop exists

const handle = frameLoop(gpu, (currentFrame) => {
  currentFrame.computePass((pass) => pass.dispatch(simulation, 1)); // encoding stays synchronous
  currentFrame.pass(canvasTarget, shade);
});

export async function teardown(): Promise<void> {
  handle.stop(); // async teardown runs outside any frame callback
  await gpu.settled();
  gpu.dispose();
}
```

Synchronous block bodies, `void` expressions such as `(currentFrame) => currentFrame.pass(canvasTarget, shade)`, and helpers with a concrete non-Promise return type work — vgpu ignores the returned value. Existing synchronous helpers with those types need no rewrite.

TypeScript rejects a single callback whose inferred return type is a `Promise`, a `PromiseLike`, or a return union containing one:

```ts illustrative
frame(gpu, async (currentFrame) => { // type error: the callback returns Promise<void>
  await simulation.compile();
  currentFrame.computePass((pass) => pass.dispatch(simulation, 1));
});
```

The type check cannot see a return type that was already erased — a callback stored as `FrameLoopCallback`, `(frame: Frame) => unknown`, or `(frame: Frame) => any`, a cast, a return-type-erasing wrapper, or plain JavaScript. A union of callback function types with a void member may also erase its Promise-returning member during inference and compile. In all of these cases, vgpu checks the result at runtime: an object or function with a callable `then` throws `VGPU-ASYNC-FRAME-CALLBACK` before the implicit submit, and the frame is canceled exactly as if the callback had thrown. vgpu observes the promise's rejection without reporting it to `gpu.onError` and never waits for it, so the error is synchronous even for a promise that never settles. In a loop, the offending tick throws with `where: "frameLoop"` and stops the loop like any throwing tick; registering the loop never runs the callback, so `frameLoop(gpu, cb)` itself does not throw.

A forwarding helper whose callback still returns an unresolved generic `R`, including `R extends void`, no longer typechecks: the frame API cannot prove that return synchronous. If the helper intentionally ignores callback returns, accept `FrameLoopCallback` or `(frame: Frame) => void` and pass the callback directly to `frame` or `frameLoop`. The runtime thenable check still sees its actual result; do not wrap the call in a block that discards that result.

Cancellation still covers only the frame's own command buffer. A `frame.submit()` the callback already called stays on the queue, one-shot draws and dispatches have already submitted on their own, and CPU-side changes stay applied. The async continuation also keeps running; anything it tries to encode on the canceled frame throws `VGPU-FRAME-CANCELED`.

> Warning: Do not hide async frame work behind `void`, a cast, or a wrapper that erases the return type. The runtime check stops the frame from submitting half-encoded, but it cannot make the continuation's work reach the GPU. Await first, then call `frame(gpu)`.

Compute-pass callbacks keep their own check: a `computePass(...)` callback that returns a thenable throws `VGPU-COMPUTE-PASS-ASYNC`.

## When the device is lost

A GPU device can be lost — a driver reset, the GPU process crashing, or the owner of a borrowed device destroying it. When vgpu observes the loss, it stops every running `frameLoop(gpu)` first, then resolves [`gpu.lost`](/reference/vgpu/gpu#gpu). No tick runs after that and none throws, so the loss does not surface as an uncaught error from an animation-frame callback. The gpu is not disposed and nothing recovers on its own: restart on a new gpu from `init()`.

The loop from the previous section, restarted after loss:

```ts
import { init, compute, effect, frameLoop, storage, surface } from "vgpu";
import shadeShader from "./shade.wgsl";
import simulationShader from "./simulation.wgsl";

const canvas = document.querySelector("canvas")!;

// ---cut---
async function start(): Promise<void> {
  const gpu = await init(); // a new device every time
  const canvasTarget = surface(gpu, canvas);
  const particles = storage(gpu, 64 * 16);
  const simulation = compute(gpu, simulationShader, { set: { particles } });
  const shade = effect(gpu, shadeShader);
  await simulation.compile();

  frameLoop(gpu, (currentFrame) => {
    currentFrame.computePass((pass) => pass.dispatch(simulation, 1));
    currentFrame.pass(canvasTarget, shade);
  });

  void gpu.lost
    .then(() => {
      gpu.dispose(); // the loop already stopped; release the old surface and resources
      return start(); // recreate everything on a new gpu and restart the loop
    })
    .catch((error: unknown) => console.error("GPU restart failed", error));
}

await start();
```

Every resource belongs to the gpu that created it, so the restart recreates the surface, storage, and pipelines instead of reusing them. `gpu.lost` never rejects; the `.catch()` is for the restart itself, which can fail when `init()` rejects. Dispose the lost gpu before the new one creates its surface, so the old surface releases the canvas first.

On the lost gpu, `frame(gpu)` and `frameLoop(gpu)` throw `VGPU-DEVICE-LOST` before the frame clock advances or surface auto-resize runs. vgpu does not cancel a manual `frame(gpu)` that was open at the time: its `submit()` throws `VGPU-DEVICE-LOST` rather than silently dropping the work, until `gpu.dispose()` cancels it.

> Warning: Do not `await gpu.lost` to tear down. It stays pending while the device is healthy and after `gpu.dispose()`, so the teardown would never run. Unmount the same way as before: `handle.stop()`, `await gpu.settled()` when you need submitted work and deliveries to finish, then `gpu.dispose()`.

`gpu.dispose()` is your teardown, not a loss: disposing before vgpu observed any loss leaves `gpu.lost` pending, and disposing a gpu from `initFromDevice(device)` never destroys the borrowed device. The [`Gpu` reference](/reference/vgpu/gpu#gpu) lists every loss-versus-disposal ordering.
