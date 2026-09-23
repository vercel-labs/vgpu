---
title: "Render bundles"
description: "bundle(gpu, opts, record) records draws once; replaying them each frame skips re-encoding."
---

A render loop re-encodes every pipeline, bind group, and draw on every tick — even when nothing changed. A bundle records those commands once; replaying it each frame costs almost nothing.

## Record once, replay every frame

[`bundle(gpu)`](/reference/vgpu/bundle#bundle) records draws against a target and returns a [`Bundle`](/reference/vgpu/bundle#bundle). Replay it inside a pass with `pass.bundles()`:

```ts
import { init, bundle, clock, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, `
  struct Params { time: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.1, 0.3, sin(params.time + uv.y) * 0.2 + 0.6, 1.0);
  }
`, { set: { params: { time: 0 } } });
const boat = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.6, 0.4, 0.2, step(distance(uv, vec2f(0.5, 0.6)), 0.1));
  }
`);

// ---cut---
const scene = bundle(gpu, { target: { colors: [canvasTarget.format] } }, (b) => {
  b.draw(ocean);
  b.draw(boat);
}); // encoded once, right here

const time = clock(gpu);
frameLoop(gpu, (frame) => {
  ocean.set({ params: { time: time.time } }); // uniforms still animate
  frame.pass(canvasTarget, (pass) => pass.bundles(scene)); // replay — no re-encoding
});
```

Record what doesn't change, `set()` what does: the bundle references your buffers, so uniform updates flow through on every replay.

Use the surface's format in a signature to record outside a frame without acquiring a canvas texture. This also respects an explicit surface format override. Passing a surface object as the bundle target requires an active frame.

> Good to know: draws inside a bundle can use different shaders and pipelines. What a bundle freezes is the target's render signature — color formats, depth format, sample count — plus bind groups, not a material or a target size.

## Compilation at record time

`bundle(gpu)` encodes right when you call it, so it needs every pipeline immediately: any draw whose pipeline isn't cached yet for the recording signature compiles synchronously, on the spot. That's the one place vgpu still blocks on pipeline creation — and the reason to [pre-warm](/concepts/compilation) before recording. If one of those synchronous creates fails, the error reports through `gpu.onError`, like any lazy compile.

The `target` option also takes a plain signature, so you can pre-warm and record during load, before the real target exists:

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const ocean = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.1, 0.3, 0.6, 1.0);
  }
`);
const boat = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.6, 0.4, 0.2, 1.0);
  }
`);

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

Bindings must be `set()` before recording — the signature relaxes the target requirement, not the resources. Replay targets must match the recorded color formats, depth format, and sample count exactly; a mismatch throws an error showing both signatures. Query the preferred format for a future default canvas surface, use `canvasTarget.format` for an existing surface, and use the configured formats for custom or offscreen targets.

## Mix recorded and dynamic draws

A pass can replay bundles and encode fresh draws side by side:

```ts
import { init, bundle, clock, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.1, 0.3, 0.6, 1.0);
  }
`);
const cursor = effect(gpu, `
  struct Params { pos: vec2f }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(1.0, 1.0, 1.0, step(distance(uv, params.pos), 0.02));
  }
`, { set: { params: { pos: [0.5, 0.5] } } });
const scene = bundle(gpu, { target: { colors: [canvasTarget.format] } }, (b) => b.draw(ocean));

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

A bundle matches replay targets by render signature, not size, so drawing onto a resized surface keeps working:

```ts
import { init, bundle, clock, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasTarget = surface(gpu, canvas);
const ocean = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(0.1, 0.3, 0.6, 1.0);
  }
`);

// ---cut---
function recordScene() {
  return bundle(gpu, { target: { colors: [canvasTarget.format] } }, (b) => b.draw(ocean));
}

let scene = recordScene();
canvasTarget.onResize(() => { scene = recordScene(); }); // needed only if the bundle samples resized resources

frameLoop(gpu, (frame) => {
  frame.pass(canvasTarget, (pass) => pass.bundles(scene));
});
```

## When not to bother

Recording is not free, and a couple of draws per frame cost almost nothing to encode. Bundles pay off with many draws in a hot loop. The full ladder: `effect.draw(target)` for a single pass, `frame(gpu)` to batch passes into one submit, `bundle(gpu)` to skip re-encoding what never changes.

See it live: the [batch rendering example](/examples/batch-rendering) packs four primitive types into one buffer and replays them from a single bundle.
