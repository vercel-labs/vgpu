---
title: "Effects"
description: "An effect is a full-screen fragment shader; chain effects by binding a target as another effect's input."
---

An [`Effect`](/reference/vgpu/effect#effect) is a full-screen fragment shader created with `effect(gpu, shader)`. Its pipeline compiles lazily on first use; call `await effect.compile(target)` during load if you want to pre-warm it. See [Compilation](/concepts/compilation) for the full pre-warm flow. Every draw fills the whole target — you only write the fragment.

`shader` is a prepared [`ShaderSource`](/reference/wgsl/resolved-shader) — WGSL plus the reflection vgpu reads bindings from. Keep static shaders in `.wgsl` files and import them through the `@vgpu/wgsl` loader ([Next.js and other bundlers](/guides/nextjs)), which prepares them at build time so the browser never loads the WGSL parser. A raw WGSL string throws `VGPU-SHADER-SOURCE-UNPREPARED`; wrap WGSL you build at runtime in `prepareShader()` from `@vgpu/wgsl/prepare` once per source change.

Effects chain through targets: render one effect into an offscreen [`Target`](/reference/vgpu/target#target), then bind that target as a texture input of the next effect with `set()`.

The `uv` varying comes from the fullscreen vertex stage `effect(gpu)` supplies when your shader declares no `@vertex` entry. It is top-origin: `(0, 0)` is the
top-left corner and `v` grows downward — the same convention as WebGPU texture
coordinates, `@builtin(position)`, and `target.color.read({ mipLevel: 0, region: "all" })`. Sampling any texture
with this `uv` needs no flip: a pass that samples `src` at `uv` reproduces the
image exactly. If you are porting a WebGL or Shadertoy shader that assumes
`v` grows upward, invert once at the boundary (`1.0 - uv.y`) and keep
everything else flip-free.

```wgsl
// scene.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 1.0, 1.0);
}
```

```wgsl
// post.wgsl — reads the scene texture and inverts its colors
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(src, samp, uv, 0.0);
  return vec4f(1.0 - base.rgb, 1.0);
}
```

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

// ---cut---
import sceneShader from "./scene.wgsl";
import postShader from "./post.wgsl";

const scene = target(gpu, { size: [1280, 720] });

const sceneEffect = effect(gpu, sceneShader);
const post = effect(gpu, postShader);
post.set({
  src: scene,
  samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
}); // the offscreen result becomes the post input

frame(gpu, (currentFrame) => {
  currentFrame.pass(scene, sceneEffect); // render the scene offscreen
  currentFrame.pass(canvasSurface, post); // invert it onto the canvas
});
```

Reach for `textureLoad` only when you need exact texels or an unfilterable
format — for ordinary sampling, a filtering sampler is simpler and faster.

`post.set(...)` exposes the offscreen result and filtering sampler to WGSL as bindings named `src` and `samp`. Both passes encode into one [`frame(gpu)`](/reference/vgpu/frame#framerunner) and submit once, in pass order, so the canvas pass reads the finished scene. Surface passes always go through a frame; a one-shot `post.draw(canvasSurface)` outside one throws `VGPU-SURFACE-NOT-IN-FRAME`.

## Updating bindings

You can update bindings at any time by using `.set`.

`set()` validates and packs the new values on the CPU every time you call it —
there is no change detection. The upload happens when an operation uses the
values: each frame pass captures them when it encodes the effect. Match your
calls to how often values actually change: constants once at creation, size-
and resolution-class uniforms at init and on resize, and per-frame calls only
for genuinely dynamic values like time or pointer input. Rebinding the same
resources is free — bind groups are cached by resource identity — so this rule
is purely about avoiding redundant work.

```wgsl
// pulse.wgsl
struct Params { time: f32, width: f32, height: f32 }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let glow = sin(params.time) * 0.5 + 0.5;
  return vec4f(uv.x, uv.y, glow, 1.0);
}
```

```ts
import { clock, init, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

// ---cut---
import pulseShader from "./pulse.wgsl";

const pulse = effect(gpu, pulseShader, {
  // initial uniform defaults
  set: {
    params: {
      time: 0,
      width: canvasSurface.size[0],
      height: canvasSurface.size[1]
    }
  },
});

const time = clock(gpu);
frameLoop(gpu, (currentFrame) => {
  // update uniforms before drawing
  pulse.set({
    params: {
      time: time.time,
    },
  });
  currentFrame.pass(canvasSurface, pulse); // this pass captures the new time
});
```

You should also only update uniforms when they need to change, for example, react to canvas size changes:

```ts
import { clock, init, effect, surface } from "vgpu";
import pulseShader from "./pulse.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
const pulse = effect(gpu, pulseShader, { set: { params: { time: 0, width: canvasSurface.size[0], height: canvasSurface.size[1] } } });

// ---cut---
const unsubscribe = canvasSurface.onResize(({ width, height }) => {
  pulse.set({ params: { width, height } }); // partial update: time keeps its value
});
```

`onResize()` fires the callback once immediately with the current size, then again on every resize. It returns an `unsubscribe` function — call it when you tear the effect down.

## Different values in one frame

Each pass captures the effect's uniform values when it encodes the effect, so
a later `set()` in the same frame changes only the passes encoded after it.
One effect can run a horizontal and a vertical blur back to back:

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
const sceneTarget = target(gpu, { size: [512, 512] });
const horizontalTarget = target(gpu, { size: [512, 512] });
const linear = sampler(gpu, { minFilter: "linear", magFilter: "linear" });

// ---cut---
const blur = effect(gpu, prepareShader(`
  struct Params { direction: vec2f }
  @group(0) @binding(0) var<uniform> params: Params;
  @group(0) @binding(1) var src: texture_2d<f32>;
  @group(0) @binding(2) var samp: sampler;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    let texel = params.direction / vec2f(textureDimensions(src));
    let sum = textureSampleLevel(src, samp, uv - texel, 0.0)
      + textureSampleLevel(src, samp, uv, 0.0)
      + textureSampleLevel(src, samp, uv + texel, 0.0);
    return vec4f(sum.rgb / 3.0, 1.0);
  }
`), { set: { samp: linear } });

frame(gpu, (currentFrame) => {
  blur.set({ params: { direction: [1, 0] }, src: sceneTarget });
  currentFrame.pass(horizontalTarget, blur); // captures the horizontal direction
  blur.set({ params: { direction: [0, 1] }, src: horizontalTarget });
  currentFrame.pass(canvasSurface, blur); // captures the vertical direction
});
```

The first pass keeps `direction: [1, 0]` even though the second `set()` runs
before the frame submits. Storage buffers and render bundles are the
exception: they read live buffer contents, so a `set()` on an effect recorded
in a bundle reaches every later replay.

## Tear an effect down

You do not have to release an effect. One you stop referencing is collected
eventually, like any JavaScript object, and bundles that recorded it keep
replaying. Call [`effect.dispose()`](/reference/vgpu/effect#effect) when you
want to retire it at a known point — unmounting a component, or swapping a
post-processing chain. Stop everything that still calls the effect first,
then dispose it:

```ts
import { clock, init, effect, frameLoop, surface } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
const pulse = effect(gpu, prepareShader(`
  struct Params { time: f32, width: f32, height: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
  }
`), { label: "pulse", set: { params: { time: 0, width: canvasSurface.size[0], height: canvasSurface.size[1] } } });

// ---cut---
const unsubscribe = canvasSurface.onResize(({ width, height }) => {
  pulse.set({ params: { width, height } });
});
const time = clock(gpu);
const loop = frameLoop(gpu, (currentFrame) => {
  pulse.set({ params: { time: time.time } });
  currentFrame.pass(canvasSurface, pulse);
});

function unmount(): void {
  loop.stop(); // no more frames draw the effect
  unsubscribe(); // no more resize callbacks call set()
  pulse.dispose(); // then retire the effect
}
```

`dispose()` is synchronous and idempotent, and it never destroys what the
effect borrowed: the surface, sampled targets and textures, buffers, and
samplers stay yours, and the compiled pipeline stays cached for other effects
built from the same shader. Work already encoded keeps the values it captured.

> Warning: After `dispose()`, every other call on the effect — `set()`, `draw()`, `compile()`, `gpu`, or drawing it in a pass — throws `VGPU-DRAW-DISPOSED`, the same code a disposed [`Draw`](/reference/vgpu/draw#draw) uses. Unsubscribe the resize callback before disposing, or its next call throws. A bundle that recorded the effect throws `VGPU-R3-BUNDLE-STALE` on replay; record its replacement with a new effect.
