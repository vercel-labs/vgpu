---
title: "Bundle"
description: "Main API (`vgpu`) render bundle recorded by `bundle(gpu, { target }, cb)`. Bundles freeze commands, attachment formats, sample count, and bind-group identities for static work; `FramePass.bundles()` checks signature and resource staleness (`VGPU-R3-BUNDLE-STALE`) when replaying. A bundle keeps its own snapshots of what it recorded, so the draws and effects you recorded can be dropped while the bundle keeps replaying; explicitly disposing one of them stales the bundle instead. Drop a bundle you no longer need and it is collected with the rest of your garbage, or call `dispose()` to release it at a known point."
---

## Import

```ts
import type { Bundle, BundleOptions, BundleRecorder } from "vgpu";
```

## Signature

```ts
import type { Draw, DrawCallOptions, Effect, Target, TargetSignature } from "vgpu";

interface BundleOptions {
  readonly target: Target | TargetSignature;
  readonly label?: string;
}

interface BundleRecorder {
  draw(drawable: Draw | Effect, opts?: DrawCallOptions): void;
}

interface Bundle {
  readonly id: string;
  readonly gpu: GPURenderBundle;
  dispose(): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| bundle.opts | `BundleOptions` | ✔ | — | Recording options. |
| opts.target | `Target \| TargetSignature` | ✔ | — | Formats, depth format, and sample count are recorded. Signature form is `{ colors: [...], depth?, sampleCount? }`; `colors` is required. A live `Surface` is accepted inside or outside a frame: recording reads its configured `format`, resolved depth format, and sample count without acquiring a canvas texture. Before the surface exists, `{ colors: [navigator.gpu.getPreferredCanvasFormat()] }` describes its defaults; include matching `depth` and `sampleCount` when planning depth or MSAA. |
| opts.label | `string` | ✖ | `` `bundle${n}` `` | Bundle id and GPU label. Auto id increments from `bundle1`. |
| bundle.cb | `(recorder: BundleRecorder) => void` | ✔ | — | Called immediately to encode commands. |
| recorder.draw.drawable | `Draw \| Effect` | ✔ | — | Draw or fullscreen effect to encode into the bundle. |
| recorder.draw.opts | `DrawCallOptions` | ✖ | `{}` | Counts and offsets captured in the recorded commands. `indirect` records fine — render bundle encoders support `drawIndirect`/`drawIndexedIndirect` — and the GPU re-reads the argument buffer on every replay. |
| bundle.id | `string` | — | `opts.label` or `` `bundle${n}` `` | Read-only. Stays readable after `dispose()`. |
| bundle.gpu | `GPURenderBundle` | — | recorded at creation | Read-only native render bundle. Throws `VGPU-BUNDLE-DISPOSED` after `dispose()`. A stale bundle that was not disposed — including one whose recorded draw was disposed — still returns it. |
| bundle.dispose | `() => void` | ✖ | not called — the bundle is released when it is garbage-collected | Synchronous and idempotent. Releases the bundle's registrations, captured resource, target, and geometry snapshots, and native handle reference now. Never destroys or disposes the draws, effects, geometry, textures, buffers, or targets it recorded. |
| framePass.bundles.bundles | `readonly Bundle[]` | ✔ | — | Replayed bundles; must be created by `bundle()` and not disposed. |

**Returns:** `bundle(gpu)` returns `Bundle` with `id`, native `gpu` render bundle, and `dispose()`; `BundleRecorder.draw()` returns `void`; `Bundle.dispose()` returns `void`; `FramePass.bundles()` returns `void`.

**Throws:**
- `VGPU-R3-BUNDLE-STALE` from `FramePass.bundles()` when the replay target's formats, depth format, or sample count differ from the recorded signature — record a bundle for that signature. The message prints both recorded and actual signature keys. This check runs per replay and does not mark the bundle stale: replaying it later on a matching target works.
- `VGPU-R3-BUNDLE-STALE` from `FramePass.bundles()` when a recorded draw's bound resource identity or claimed group changed after the bundle finished recording — including a rebind made while a different bundle records — or a captured texture, buffer, or target was destroyed, or a sampled `Target` replaced its attachment (for example on `resize()`) — record a new bundle, swap it in, then `dispose()` the old one. Destruction and attachment replacement are detected even after the recorded draw or effect was collected. This staleness is permanent and the message always names the first change, even after later rebinds.
- `VGPU-R3-BUNDLE-STALE` from `FramePass.bundles()` when a recorded draw or effect was disposed with `dispose()`, including during this bundle's own recording callback. The message is `Bundle '<id>' is stale: draw '<label>' was disposed. Create a new draw/effect and re-record the bundle.` — create a new draw or effect, record a new bundle, swap it in, then `dispose()` the old bundle. This staleness is permanent and keeps the first cause; collecting a recorded draw or effect without `dispose()` never stales the bundle.
- The geometry's own liveness error, such as `VGPU-MESH-LAYOUT-INVALID` for a destroyed `geometry(gpu)`, from `FramePass.bundles()` when geometry the bundle recorded was destroyed — create live geometry, then record a new draw and bundle.
- `VGPU-BUNDLE-DISPOSED` from `bundle.gpu` or `FramePass.bundles()` after `dispose()` — record a new bundle before replaying; this bundle was disposed.
- `VGPU-R3-BUNDLE-INVALID` when replay receives an object not created by `bundle()` — pass the value `bundle(gpu, ...)` returned.
- `VGPU-BUNDLE-BLEND-CONSTANT` when recording a draw with `blendConstant` — the blend constant is render-pass state that render bundle encoders cannot set; encode such draws in a frame pass instead.
- `VGPU-BUNDLE-STENCIL-REF` when recording a draw whose `stencil` has `ref` — the stencil reference is likewise render-pass state; stencil state without `ref` records fine.
- `VGPU-SURFACE-DISPOSED` when `opts.target` is a disposed surface, or when replaying against a disposed surface — record and replay against a live `surface(gpu, canvas)`.
- `VGPU-DRAW-DISPOSED` from `recorder.draw(drawable)` when the draw or effect was already disposed — record a live draw or effect.
- Draw binding errors such as `VGPU-R1-BINDING-NEVER-SET` can throw during recording. A recording that throws returns no bundle and leaves nothing registered on the draws or resources it touched.

`FramePass.bundles()` checks every bundle in the list before replaying any: one stale or disposed entry means none of the list replays.

## Examples

```ts
import { init, bundle, draw, frame, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const drawable = draw(gpu, { shader: `
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 1, 0, 1); }
` });

const statics = bundle(gpu, { target: colorTarget, label: "static" }, (recorded) => {
  recorded.draw(drawable);
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: colorTarget }, (pass) => pass.bundles(statics));
});
```

Create a draw or effect inside the function that records it and return only the bundle. The bundle does not need the effect to stay reachable:

```ts
import { init, bundle, effect, frame, target, type Bundle, type Gpu, type Target } from "vgpu/mock";

const gpu = await init();
const sceneTarget = target(gpu, { size: [64, 64] });

// ---cut---
function recordBackground(gpu: Gpu, sceneTarget: Target): Bundle {
  const background = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.2, 0.4, 1); }`);
  return bundle(gpu, { target: sceneTarget, label: "background" }, (recorded) => recorded.draw(background));
} // `background` is unreachable once this returns; the bundle keeps its own snapshots

const backgroundBundle = recordBackground(gpu, sceneTarget);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: sceneTarget }, (pass) => pass.bundles(backgroundBundle)); // replays without the effect
});
```

Collecting the effect does not make `backgroundBundle` stale. Keep the draw or effect only when you still need to `set()` its uniforms, rebind it, or draw it outside the bundle.

Record for a canvas during loading by passing the live surface as the target, then replay inside a frame. The bundle keeps replaying after the canvas resizes, because the signature does not include size:

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const background = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.2, 0.4, 1); }`);

// ---cut---
const statics = bundle(gpu, { target: canvasSurface, label: "surfaceStatics" }, (recorded) => {
  recorded.draw(background);
}); // outside any frame: reads canvasSurface.format, acquires no canvas texture

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.bundles(statics)); // no re-record on resize
});
```

Recording reads the surface's configured signature only. It does not acquire the current canvas texture, read or allocate attachments, resize the canvas, notify `onResize` listeners, or submit work.

Replace a bundle when something it samples changes. Record the next bundle first, swap your reference, then dispose the old one — if recording throws, the old bundle is still in place:

```ts
import { init, bundle, effect, frameLoop, sampler, surface, target, type Bundle } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const sceneTarget = target(gpu, { size: [canvasSurface.size[0], canvasSurface.size[1]] });
const postEffect = effect(gpu, `
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(1.0 - textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
  }
`);
postEffect.set({ src: sceneTarget, samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) });

// ---cut---
let post: Bundle | undefined;

canvasSurface.onResize(({ width, height }) => {
  sceneTarget.resize([width, height]); // new textures: a bundle sampling the old ones is stale
  const next = bundle(gpu, { target: canvasSurface, label: "post" }, (recorded) => {
    recorded.draw(postEffect);
  });
  const previous = post;
  post = next;
  previous?.dispose(); // release the replaced bundle now instead of waiting for collection
}); // fires once immediately, so this also records the first bundle

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.bundles(post!));
});
```

```ts
import { init, bundle, clock, effect, frame, pingPong } from "vgpu/mock";

const gpu = await init();
const ping = pingPong(gpu, 32, 32);
const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);
const even = bundle(gpu, { target: ping.write }, (b) => b.draw(shader));
ping.swap();
const odd = bundle(gpu, { target: ping.write }, (b) => b.draw(shader));
ping.swap();

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: ping.write }, (p) => p.bundles(clock(gpu).frameCount % 2 ? odd : even));
});
```

Dispose on teardown. Disposal does not cancel a frame that already replayed the bundle, and it leaves the recorded effect usable:

```ts
import { init, bundle, effect, frame, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const shader = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`);

// ---cut---
const statics = bundle(gpu, { target: colorTarget, label: "statics" }, (recorded) => recorded.draw(shader));

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: colorTarget }, (pass) => pass.bundles(statics));
  statics.dispose(); // the replay is already encoded; this frame still submits it
});

statics.dispose(); // no-op: dispose() is idempotent
console.log(statics.id); // "statics" — still readable
// statics.gpu and pass.bundles(statics) now throw VGPU-BUNDLE-DISPOSED
shader.draw(colorTarget); // the effect was borrowed, not destroyed
```

## Signature-arm recording

`bundle(gpu, { target: { colors: ["bgra8unorm"], depth: "depth24plus", sampleCount: 4 } }, cb)` records before a target exists. This relaxes only the replay target: any resources sampled by draws still need to be set before recording. Cold signature recording creates missing pipelines synchronously, which can jank; pre-warm first with `await draw.compile(signature)` or `await effect.compile(signature)`.

For future canvas surfaces, use `navigator.gpu.getPreferredCanvasFormat()` when building the signature; for an existing surface, pass the surface itself. A surface and an equivalent signature such as `{ colors: [canvasSurface.format] }` produce the same signature key, so either form records a bundle that replays on that surface. A bundle recorded for `bgra8unorm` will not replay on an `rgba8unorm` surface, and the stale error prints both keys.

## Lifetime

A bundle holds its native render bundle plus independent snapshots of what it recorded: each captured texture, buffer, and target, the attachment of each `Target` it samples, and the geometry it draws. It does not hold the recorded draws or effects, and neither they nor the resources they bind hold the bundle. When your code drops its last reference to a bundle, the bundle becomes unreachable and is collected eventually, like any JavaScript object. vgpu makes no promise about when collection happens or when the driver reclaims the native bundle's memory.

Dropping a recorded draw or effect is not a change to the bundle. If the draw is collected, the bundle keeps replaying, and its snapshots still detect what happens later: destroying a captured texture, buffer, or target, or replacing a sampled `Target`'s attachment, makes replay throw `VGPU-R3-BUNDLE-STALE`; destroying recorded geometry makes replay throw that geometry's liveness error.

Disposing a recorded draw or effect is a change. `draw.dispose()` and `effect.dispose()` permanently stale every bundle that recorded them — including a bundle whose recording callback is still running — and replay throws `VGPU-R3-BUNDLE-STALE` naming the disposed draw. Collection is silent and keeps the bundle; disposal is explicit and retires it. Dispose a draw only when you also replace or drop the bundles that recorded it:

```ts
import { init, bundle, effect, frame, target } from "vgpu/mock";

const gpu = await init();
const sceneTarget = target(gpu, { size: [64, 64] });

// ---cut---
let sky = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.4, 0.6, 0.9, 1); }`, { label: "daySky" });
let skyBundle = bundle(gpu, { target: sceneTarget, label: "day" }, (recorded) => recorded.draw(sky));

function switchToNight(): void {
  const nextSky = effect(gpu, `@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.02, 0.03, 0.1, 1); }`, { label: "nightSky" });
  const nextBundle = bundle(gpu, { target: sceneTarget, label: "night" }, (recorded) => recorded.draw(nextSky));
  const previousSky = sky;
  const previousBundle = skyBundle;
  sky = nextSky;
  skyBundle = nextBundle; // swap only after recording succeeded
  previousSky.dispose(); // permanently stales previousBundle
  previousBundle.dispose(); // then release the stale bundle
}

switchToNight();
frame(gpu, (currentFrame) => {
  currentFrame.pass(sceneTarget, (pass) => pass.bundles(skyBundle)); // replays the night sky
});
```

Between the two `dispose()` calls, replaying the day bundle would throw `VGPU-R3-BUNDLE-STALE` with `Bundle 'day' is stale: draw 'daySky' was disposed.` Disposing the bundle as well releases its snapshots now instead of at collection.

Disposing the draw leaves native work alone. Commands already encoded in a frame still submit, and a `GPURenderBundle` read from `bundle.gpu` before or after the draw's disposal keeps replaying the last uniform contents the draw wrote — vgpu never revalidates or revokes it.

Rebinding is checked per bundle. A draw rebound after a bundle finished recording stales that bundle, even when the rebind happens inside another bundle's recording callback. Within one recording, rebinding between `recorded.draw()` calls is deliberate: each call records the resources bound at that moment, and the bundle validates all of them at replay.

`dispose()` releases vgpu's references and registrations at a point you choose. It is synchronous and idempotent: it unregisters the bundle from the draws and resources it watched, drops its snapshots, and drops its reference to the native render bundle. It never destroys borrowed resources — the draws, effects, geometry, textures, buffers, samplers, and targets stay yours. After disposal, `id` stays readable, and reading `gpu` or replaying the bundle throws `VGPU-BUNDLE-DISPOSED`. Neither garbage collection nor `dispose()` promises when native WebGPU or the driver reclaims memory.

Neither disposal nor collection — of the bundle or of the draws it recorded — reaches work or handles that already left the facade. A frame that replayed the bundle before `dispose()` still submits it. A `GPURenderBundle` you read from `bundle.gpu` stays usable for as long as native WebGPU keeps it valid; vgpu cannot revoke it, and only `FramePass.bundles()` checks staleness — replaying that native handle yourself does not. While you hold the recorded draw and have not disposed it, its `set()` uniform updates keep reaching that native handle too.

A bundle that becomes permanently stale — a captured resource was rebound or destroyed, a sampled `Target` replaced its attachment, or a recorded draw or effect was disposed — detaches from its draws and resources right away, so later `set()` or `destroy()` calls do no work for it. You still `dispose()` it or drop it; until then, replay keeps throwing `VGPU-R3-BUNDLE-STALE` with the first cause.

## Notes

- Bundles match replay targets by render signature, not size. They survive resizing the target they draw onto. Do not re-record because the destination resized.
- Re-record when the bundle samples a resized target; vgpu detects the changed texture identity and reports `VGPU-R3-BUNDLE-STALE`.
- Replace bundles in this order: record the next bundle, swap your reference, then `dispose()` the old one. Disposing first leaves you with nothing to replay if the new recording throws.
- `surface.onResize(...)` fires immediately, so the same re-recording callback can initialize and refresh bundles that sample resized resources.
- Bundles freeze bind group identities, not buffer contents. Updating JS-owned packed values in-place is safe, and `set()` uniform updates on a draw you still hold keep reaching every live bundle that recorded it, including native handles read from `bundle.gpu`, until you dispose the draw. Rebinding a different texture/buffer/sampler after recording stales the bundle.
- Do not keep draws or effects alive only so their bundles keep working. A bundle replays and detects destroyed resources on its own; keep the draw only to update, rebind, or draw it again.
- Do not call `dispose()` on a draw or effect whose bundles you still replay: disposal stales them permanently. To let a draw go while keeping its bundle, drop your reference instead.
- Record against a live `Surface` inside or outside a frame; recording uses its configured signature and never acquires a canvas texture. Replay stays inside `frame(gpu)` or `frameLoop(gpu)`, because `pass.bundles()` exists only on a frame pass. Recording against a disposed surface throws `VGPU-SURFACE-DISPOSED`.
- Neither garbage collection nor `dispose()` frees GPU or driver memory on a schedule. Call `dispose()` when you replace or tear down bundles and want vgpu's references and registrations released synchronously.
- Draws with `blendConstant` cannot be recorded: render bundle encoders have no way to set the pass blend constant. Recording throws `VGPU-BUNDLE-BLEND-CONSTANT`; use `FramePass.draw` for those draws.
- Draws whose `stencil` has `ref` cannot be recorded either: render bundle encoders have no way to set the pass stencil reference. Recording throws `VGPU-BUNDLE-STENCIL-REF`; stencil pipeline state without `ref` records fine.
- **See also:** `FramePass.bundles`, `Draw`, `Effect`, `Surface`, `Target`, `createRenderBundle`.
