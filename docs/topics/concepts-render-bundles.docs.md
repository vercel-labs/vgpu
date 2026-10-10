---
title: Render bundles
summary: bundle(gpu, opts, record) records draws once; replaying them each frame skips re-encoding.
relatedSymbols:
  - Bundle
  - BundleOptions
  - BundleRecorder
prevNext:
  prev:
    title: Frames
    href: /concepts/frames
order: 70
---

# Render bundles

A render loop re-encodes every pipeline, bind group, and draw on every tick — even when nothing changed. A bundle records those commands once; replaying it each frame costs almost nothing.

## Record once, replay every frame

[`bundle(gpu)`](/reference/vgpu/bundle#bundle) records draws against a target and returns a [`Bundle`](/reference/vgpu/bundle#bundle). Replay it inside a pass with `pass.bundles()`:

```wgsl
// animated-ocean.wgsl
struct Params { time: f32 }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.1, 0.3, sin(params.time + uv.y) * 0.2 + 0.6, 1.0);
}
```

```wgsl
// silhouette-boat.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.6, 0.4, 0.2, step(distance(uv, vec2f(0.5, 0.6)), 0.1));
}
```

```ts
import { init, bundle, clock, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./animated-ocean.wgsl";
import boatShader from "./silhouette-boat.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, oceanShader, { set: { params: { time: 0 } } });
const boat = effect(gpu, boatShader);

// ---cut---
const scene = bundle(gpu, { target: canvasTarget }, (b) => {
  b.draw(ocean);
  b.draw(boat);
}); // encoded once, right here — no frame needed

const time = clock(gpu);
frameLoop(gpu, (frame) => {
  ocean.set({ params: { time: time.time } }); // uniforms still animate
  frame.pass(canvasTarget, (pass) => pass.bundles(scene)); // replay — no re-encoding
});
```

Record what doesn't change, `set()` what does: the bundle references your buffers, so uniform updates flow through on every replay.

Recording against a live surface works outside a frame, during loading. vgpu reads the surface's configured render signature — its `format`, including an explicit override, resolved depth format, and sample count — and does not acquire a canvas texture, resize the canvas, or submit work. Replay is the part that draws, so it stays inside `frame()` or `frameLoop()`. Recording against a disposed surface throws `VGPU-SURFACE-DISPOSED`.

> Good to know: draws inside a bundle can use different shaders and pipelines. What a bundle freezes is the target's render signature — color formats, depth format, sample count — plus bind groups, not a material or a target size.

## Compilation at record time

`bundle(gpu)` encodes right when you call it, so it needs every pipeline immediately: any draw whose pipeline isn't cached yet for the recording signature compiles synchronously, on the spot. That's the one place vgpu still blocks on pipeline creation — and the reason to [pre-warm](/concepts/compilation) before recording. If one of those synchronous creates fails, the error reports through `gpu.onError`, like any lazy compile.

The `target` option also takes a plain signature, so you can pre-warm and record during load, before the real target exists:

```wgsl
// ocean.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.1, 0.3, 0.6, 1.0);
}
```

```wgsl
// boat.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(0.6, 0.4, 0.2, 1.0);
}
```

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";
import boatShader from "./boat.wgsl";

const gpu = await init();
const ocean = effect(gpu, oceanShader);
const boat = effect(gpu, boatShader);

// ---cut---
const signature = { colors: [navigator.gpu.getPreferredCanvasFormat()] };
await Promise.all([
  ocean.compile(signature),
  boat.compile(signature),
]);

const scene = bundle(gpu, { target: signature }, (b) => {
  b.draw(ocean);
  b.draw(boat);
}); // everything was pre-warmed — recording creates nothing

// Later, surface() selects the same preferred format by default.
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(scene));
});
```

Bindings must be `set()` before recording — the signature relaxes the target requirement, not the resources. Replay targets must match the recorded color formats, depth format, and sample count exactly; a mismatch throws an error showing both signatures. The preferred-format signature above describes a default surface with no depth and one sample. Include the planned depth format and sample count for depth/MSAA surfaces, and use the configured formats for custom or offscreen targets. Once the surface or target exists, pass it directly instead of a signature: `await ocean.compile(canvasTarget)` followed by `bundle(gpu, { target: canvasTarget }, ...)` pre-warms and records outside any frame, and shares the same cached pipelines as the equivalent signature.

## Mix recorded and dynamic draws

A pass can replay bundles and encode fresh draws side by side:

```wgsl
// cursor.wgsl
struct Params { pos: vec2f }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(1.0, 1.0, 1.0, step(distance(uv, params.pos), 0.02));
}
```

```ts
import { init, bundle, clock, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";
import cursorShader from "./cursor.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, oceanShader);
const cursor = effect(gpu, cursorShader, { set: { params: { pos: [0.5, 0.5] } } });
const scene = bundle(gpu, { target: canvasTarget }, (b) => b.draw(ocean));

// ---cut---
frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => {
    pass.bundles(scene); // the static part, replayed
    pass.draw(cursor); // the dynamic part, encoded fresh on top
  });
});
```

Some draws must stay on the dynamic side. Draws that set a `blendConstant` or a `stencil` `ref` cannot be recorded — bundle encoders have no way to set those pass-level values — so encode them with `pass.draw()`. A bundle also cannot replay inside a `depthReadOnly` pass, because bundles always record with writable depth. Indirect draws record fine: the GPU re-reads the argument buffer on every replay.

## Resizes and sampled targets

A bundle matches replay targets by render signature, not size, so drawing onto a resized surface keeps working without recording again:

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, oceanShader);

// ---cut---
const scene = bundle(gpu, { target: canvasTarget }, (b) => b.draw(ocean));

frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(scene)); // still valid after every resize
});
```

Sampling is different. A bundle freezes its bind groups, so when a texture it samples is replaced — here, an offscreen target resized to follow the canvas — the bundle goes stale and replay throws `VGPU-R3-BUNDLE-STALE`. Record a replacement, swap it in, then dispose the old bundle:

```wgsl
// post.wgsl
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(1.0 - textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
}
```

```ts
import { init, bundle, effect, frameLoop, sampler, surface, target, type Bundle } from "vgpu";
import postShader from "./post.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const sceneTarget = target(gpu, { size: [canvasTarget.size[0], canvasTarget.size[1]] });
const postEffect = effect(gpu, postShader);
postEffect.set({ src: sceneTarget, samp: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) });

// ---cut---
let post: Bundle | undefined;

canvasTarget.onResize(({ width, height }) => {
  sceneTarget.resize([width, height]); // new textures: the bundle sampling the old ones is stale
  const next = bundle(gpu, { target: canvasTarget }, (b) => b.draw(postEffect));
  const previous = post;
  post = next; // swap only after recording succeeded
  previous?.dispose(); // then release the replaced bundle
}); // fires once immediately, so this also records the first bundle

frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(post!));
});
```

The order matters. If recording throws, `post` still holds the previous bundle and nothing was disposed early. Re-record only for changes like this one, never solely because the destination resized.

## Rebinding during and after recording

A bundle captures the resources bound at each `b.draw()` call. Rebinding a draw between calls inside one recording is deliberate — the bundle records both draws, each with its own resources, and checks all of them at replay. Rebinding after a bundle finished recording stales that bundle, even when the `set()` happens inside another bundle's recording:

```ts
import { init, bundle, effect, frameLoop, surface, target } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const leftTarget = target(gpu, { size: [256, 256] });
const rightTarget = target(gpu, { size: [256, 256] });
const preview = effect(gpu, prepareShader(`
  @group(0) @binding(0) var src: texture_2d<f32>;

  @fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    return textureLoad(src, vec2i(position.xy) % vec2i(256), 0);
  }
`), { set: { src: leftTarget } });

// ---cut---
const leftOnly = bundle(gpu, { target: canvasTarget }, (b) => b.draw(preview));

const both = bundle(gpu, { target: canvasTarget }, (b) => {
  b.draw(preview); // records leftTarget
  preview.set({ src: rightTarget }); // stales leftOnly; this recording keeps going
  b.draw(preview); // records rightTarget
}); // both watches leftTarget and rightTarget

frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(both)); // pass.bundles(leftOnly) would throw VGPU-R3-BUNDLE-STALE
});
```

`both` stays valid until `preview` is rebound again, or either captured target is destroyed or replaces its attachment. `leftOnly` went stale at the `set()`, because it recorded `leftTarget` and the draw no longer binds it.

## Let recorded draws go

A bundle does not hold the draws and effects it recorded. It keeps independent snapshots instead — each captured texture, buffer, and target, the attachment of each sampled `Target`, and the geometry it draws — so a draw or effect created only to record a bundle can stay local to the function that records it:

```ts
import { init, bundle, effect, frameLoop, surface, type Bundle, type Gpu, type Surface } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);

// ---cut---
function recordBackdrop(gpu: Gpu, canvasTarget: Surface): Bundle {
  const backdrop = effect(gpu, prepareShader(`
    @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
      return vec4f(0.1, 0.3, 0.6 + uv.y * 0.2, 1.0);
    }
  `));
  return bundle(gpu, { target: canvasTarget, label: "backdrop" }, (b) => b.draw(backdrop));
} // backdrop is unreachable after this returns — the bundle does not need it

const backdropBundle = recordBackdrop(gpu, canvasTarget);
frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(backdropBundle));
});
```

Collecting the effect does not make the bundle stale. The snapshots still catch later changes on their own: destroying a captured texture, buffer, or target, or replacing a sampled `Target`'s attachment, makes replay throw `VGPU-R3-BUNDLE-STALE`, and destroying recorded geometry makes replay throw that geometry's liveness error. Keep the draw only when you still `set()` its uniforms, rebind it, or draw it outside the bundle — while you hold it, its uniform updates keep reaching every bundle that recorded it.

## Disposing a recorded draw stales its bundles

Letting a draw go and disposing it are different. Collection is silent: the bundle keeps replaying. [`draw.dispose()`](/reference/vgpu/draw#draw) and [`effect.dispose()`](/reference/vgpu/effect#effect) are explicit retirements: every bundle that recorded the draw goes permanently stale — even one whose recording callback is still running — and `pass.bundles()` throws `VGPU-R3-BUNDLE-STALE` naming the disposed draw. Replace the draw and its bundle together:

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);

// ---cut---
let backdrop = effect(gpu, prepareShader(`
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.3, 0.6, 1.0); }
`), { label: "dayBackdrop" });
let backdropBundle = bundle(gpu, { target: canvasTarget, label: "day" }, (b) => b.draw(backdrop));

function useNightBackdrop(): void {
  const nextBackdrop = effect(gpu, prepareShader(`
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.02, 0.03, 0.1, 1.0); }
  `), { label: "nightBackdrop" });
  const nextBundle = bundle(gpu, { target: canvasTarget, label: "night" }, (b) => b.draw(nextBackdrop));
  const previousBackdrop = backdrop;
  const previousBundle = backdropBundle;
  backdrop = nextBackdrop;
  backdropBundle = nextBundle; // swap only after recording succeeded
  previousBackdrop.dispose(); // stales the day bundle permanently
  previousBundle.dispose(); // then release that bundle too
}

frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(backdropBundle));
});
```

Between the two `dispose()` calls, replaying the day bundle would throw `VGPU-R3-BUNDLE-STALE` with `Bundle 'day' is stale: draw 'dayBackdrop' was disposed. Create a new draw/effect and re-record the bundle.` Disposal does not reach native work: commands already encoded still submit, and a `GPURenderBundle` you read from `bundle.gpu` keeps replaying the last uniform contents the draw wrote.

## Release bundles you no longer need

You do not have to release a bundle. The draws and resources a bundle recorded do not keep it alive, so once your code drops its last reference, the bundle is collected eventually like any other object. vgpu makes no promise about when that happens or when the driver frees the native bundle's memory.

Call `dispose()` when you want vgpu's references and registrations released at a known point — replacing a bundle, or tearing down a view. Neither garbage collection nor `dispose()` promises when native WebGPU or the driver reclaims memory:

```ts
import { init, bundle, effect, frame, target } from "vgpu";
import oceanShader from "./ocean.wgsl";

const gpu = await init();
const sceneTarget = target(gpu, { size: [256, 256] });
const ocean = effect(gpu, oceanShader);

// ---cut---
const scene = bundle(gpu, { target: sceneTarget, label: "ocean" }, (b) => b.draw(ocean));

frame(gpu, (currentFrame) => {
  currentFrame.pass(sceneTarget, (pass) => pass.bundles(scene));
  scene.dispose(); // the replay is already encoded — this frame still submits it
});

scene.dispose(); // idempotent: a second call does nothing
console.log(scene.id); // "ocean" — the id stays readable
ocean.draw(sceneTarget); // the effect was borrowed, not destroyed
```

`dispose()` is synchronous. It unregisters the bundle from the draws and resources it watched and drops its snapshots and native handle reference. It never destroys or disposes what the bundle borrowed — draws, effects, geometry, textures, buffers, and targets stay yours.

> Warning: After `dispose()`, reading `scene.gpu` or replaying the bundle throws `VGPU-BUNDLE-DISPOSED`. Record a new bundle before replaying. In `pass.bundles(a, b)`, one disposed entry means none of the list replays.

Disposal cannot reach what already left the bundle, and neither can collecting the draws it recorded. Work encoded before `dispose()` still runs, and a `GPURenderBundle` you read from `scene.gpu` earlier stays usable for as long as native WebGPU keeps it valid — vgpu cannot revoke it, and only `pass.bundles()` checks staleness, not native replay of that handle. While you hold the recorded draw and have not disposed it, its `set()` uniform updates keep reaching that handle.

A bundle that goes permanently stale — a captured resource was rebound or destroyed, a sampled `Target` replaced its attachment, or a recorded draw was disposed — detaches from its draws and resources on its own, and replay keeps reporting the first cause. A replay on a target with a different signature is not permanent: it throws `VGPU-R3-BUNDLE-STALE` for that call only, and replaying on a matching target afterwards works.

## When not to bother

Recording is not free, and a couple of draws per frame cost almost nothing to encode. Bundles pay off with many draws in a hot loop. The full ladder: `effect.draw(target)` for a single pass, `frame(gpu)` to batch passes into one submit, `bundle(gpu)` to skip re-encoding what never changes.

See it live: the [batch rendering example](/examples/batch-rendering) packs four primitive types into one buffer and replays them from a single bundle.
