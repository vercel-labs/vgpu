---
title: "Bundle"
description: "Main API (`vgpu`) render bundle recorded by `bundle(gpu, { target }, cb)`. Bundles freeze commands, attachment formats, sample count, and bind-group identities for static work; `FramePass.bundles()` checks signature and resource staleness (`VGPU-R3-BUNDLE-STALE`) when replaying. Drop a bundle you no longer need and it is collected with the rest of your garbage, or call `dispose()` to release it at a known point."
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
| bundle.gpu | `GPURenderBundle` | — | recorded at creation | Read-only native render bundle. Throws `VGPU-BUNDLE-DISPOSED` after `dispose()`. |
| bundle.dispose | `() => void` | ✖ | not called — the bundle is released when it is garbage-collected | Synchronous and idempotent. Releases the bundle's registrations, captured draws, and native handle reference now. Never destroys the draws, effects, geometry, textures, buffers, or targets it recorded. |
| framePass.bundles.bundles | `readonly Bundle[]` | ✔ | — | Replayed bundles; must be created by `bundle()` and not disposed. |

**Returns:** `bundle(gpu)` returns `Bundle` with `id`, native `gpu` render bundle, and `dispose()`; `BundleRecorder.draw()` returns `void`; `Bundle.dispose()` returns `void`; `FramePass.bundles()` returns `void`.

**Throws:**
- `VGPU-R3-BUNDLE-STALE` from `FramePass.bundles()` when the replay target's formats, depth format, or sample count differ from the recorded signature — record a bundle for that signature. The message prints both recorded and actual signature keys. This check runs per replay and does not mark the bundle stale: replaying it later on a matching target works.
- `VGPU-R3-BUNDLE-STALE` from `FramePass.bundles()` when a recorded draw's bound resource identity or claimed group changed after recording, or a captured resource was destroyed — record a new bundle, swap it in, then `dispose()` the old one. This staleness is permanent and the message always names the first change, even after later rebinds.
- `VGPU-BUNDLE-DISPOSED` from `bundle.gpu` or `FramePass.bundles()` after `dispose()` — record a new bundle before replaying; this bundle was disposed.
- `VGPU-R3-BUNDLE-INVALID` when replay receives an object not created by `bundle()` — pass the value `bundle(gpu, ...)` returned.
- `VGPU-BUNDLE-BLEND-CONSTANT` when recording a draw with `blendConstant` — the blend constant is render-pass state that render bundle encoders cannot set; encode such draws in a frame pass instead.
- `VGPU-BUNDLE-STENCIL-REF` when recording a draw whose `stencil` has `ref` — the stencil reference is likewise render-pass state; stencil state without `ref` records fine.
- `VGPU-SURFACE-DISPOSED` when `opts.target` is a disposed surface, or when replaying against a disposed surface — record and replay against a live `surface(gpu, canvas)`.
- Draw binding errors such as `VGPU-R1-BINDING-NEVER-SET` can throw during recording. A recording that throws returns no bundle and leaves nothing registered on the draws or resources it touched.

`FramePass.bundles()` checks every bundle in the list before replaying any: one stale or disposed entry means none of the list replays.

## Examples

```ts
import { init, bundle, draw, frame, target } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const drawable = draw(gpu, { shader: prepareShader(`
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 1, 0, 1); }
`) });

const statics = bundle(gpu, { target: colorTarget, label: "static" }, (recorded) => {
  recorded.draw(drawable);
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: colorTarget }, (pass) => pass.bundles(statics));
});
```

Record for a canvas during loading by passing the live surface as the target, then replay inside a frame. The bundle keeps replaying after the canvas resizes, because the signature does not include size:

```ts
import { prepareShader } from "@vgpu/wgsl/prepare";
import { init, bundle, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const background = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.2, 0.4, 1); }`));

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
import { prepareShader } from "@vgpu/wgsl/prepare";
import { init, bundle, effect, frameLoop, sampler, surface, target, type Bundle } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const sceneTarget = target(gpu, { size: [canvasSurface.size[0], canvasSurface.size[1]] });
const postEffect = effect(gpu, prepareShader(`
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(1.0 - textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
  }
`));
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
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const ping = pingPong(gpu, 32, 32);
const shader = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`));
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
import { prepareShader } from "@vgpu/wgsl/prepare";
import { init, bundle, effect, frame, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const shader = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`));

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

A bundle holds its recorded draws; the draws and the resources they bind do not hold the bundle. When your code drops its last reference to a bundle, the bundle becomes unreachable and is collected eventually, like any JavaScript object. vgpu makes no promise about when collection happens or when the driver reclaims the native bundle's memory.

`dispose()` releases vgpu's references and registrations at a point you choose. It is synchronous and idempotent: it unregisters the bundle from the draws and resources it watched, drops its captured draws, and drops its reference to the native render bundle. It never destroys borrowed resources — the draws, effects, geometry, textures, buffers, samplers, and targets stay yours. After disposal, `id` stays readable, and reading `gpu` or replaying the bundle throws `VGPU-BUNDLE-DISPOSED`. Neither garbage collection nor `dispose()` promises when native WebGPU or the driver reclaims memory.

Disposal cannot reach work or handles that already left the facade. A frame that replayed the bundle before `dispose()` still submits it. A `GPURenderBundle` you read from `bundle.gpu` before disposal stays usable for as long as native WebGPU keeps it valid; vgpu cannot revoke it and no longer checks it for staleness.

A bundle that becomes permanently stale — a captured resource was rebound or destroyed — detaches from its draws and resources right away, so later `set()` or `destroy()` calls do no work for it. You still `dispose()` it or drop it; until then, replay keeps throwing `VGPU-R3-BUNDLE-STALE` with the first cause.

## Notes

- Bundles match replay targets by render signature, not size. They survive resizing the target they draw onto. Do not re-record because the destination resized.
- Re-record when the bundle samples a resized target; vgpu detects the changed texture identity and reports `VGPU-R3-BUNDLE-STALE`.
- Replace bundles in this order: record the next bundle, swap your reference, then `dispose()` the old one. Disposing first leaves you with nothing to replay if the new recording throws.
- `surface.onResize(...)` fires immediately, so the same re-recording callback can initialize and refresh bundles that sample resized resources.
- Bundles freeze bind group identities, not buffer contents. Updating JS-owned packed values in-place is safe, and `set()` uniform updates keep reaching every live bundle that recorded the draw, including native handles read from `bundle.gpu`. Rebinding a different texture/buffer/sampler stales the bundle.
- Record against a live `Surface` inside or outside a frame; recording uses its configured signature and never acquires a canvas texture. Replay stays inside `frame(gpu)` or `frameLoop(gpu)`, because `pass.bundles()` exists only on a frame pass. Recording against a disposed surface throws `VGPU-SURFACE-DISPOSED`.
- Neither garbage collection nor `dispose()` frees GPU or driver memory on a schedule. Call `dispose()` when you replace or tear down bundles and want vgpu's references and registrations released synchronously.
- Draws with `blendConstant` cannot be recorded: render bundle encoders have no way to set the pass blend constant. Recording throws `VGPU-BUNDLE-BLEND-CONSTANT`; use `FramePass.draw` for those draws.
- Draws whose `stencil` has `ref` cannot be recorded either: render bundle encoders have no way to set the pass stencil reference. Recording throws `VGPU-BUNDLE-STENCIL-REF`; stencil pipeline state without `ref` records fine.
- **See also:** `FramePass.bundles`, `Draw`, `Effect`, `Surface`, `Target`, `createRenderBundle`.
