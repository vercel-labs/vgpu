---
title: "Passes"
description: "A pass composites any number of draws into one target; a single shader can draw directly."
---

A pass is a render-pass section inside a frame. It has one target, one clear color, and any number of draw calls. Open a pass by hand when you want to composite multiple draws into the same render target — here, an ocean and a boat rendered straight to the canvas:

```ts
import { init, effect, frame, surface } from "vgpu";
import oceanShader from "./ocean.wgsl"; // fullscreen water gradient
import boatShader from "./boat.wgsl"; // draws only the hull pixels; discards everything else

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

// ---cut---
const ocean = effect(gpu, oceanShader);
const boat = effect(gpu, boatShader);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(ocean); // fill the canvas with water
    pass.draw(boat); // paint the boat on top — same target
  });
});
```

Both draws share one render pass and one target. Order inside the pass is paint order: the ocean fills the canvas first, then the boat draws on top of it.

> Good to know: [`FramePass.draw()`](/reference/vgpu/frame#framepass) accepts a fullscreen [`Effect`](/reference/vgpu/effect#effect) or an explicit [`Draw`](/reference/vgpu/draw#draw). Use `draw(gpu)` when you need meshes, vertex counts, instancing, or raw bind groups.

## One shader? Draw it directly

Now add postprocessing. The pass is the same — the only change is its target: an offscreen [`Target`](/reference/vgpu/target#target) with the same size as the canvas. Then the postprocessing effect (bound with `set({ src: scene })`) needs no pass ceremony to reach the screen:

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";
import oceanShader from "./ocean.wgsl";
import boatShader from "./boat.wgsl";
import postShader from "./post.wgsl"; // samples `src` with `samp` and applies a vignette

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

const ocean = effect(gpu, oceanShader);
const boat = effect(gpu, boatShader);

// ---cut---
const scene = target(gpu, { size: [canvasSurface.size[0], canvasSurface.size[1]] });
const postprocessing = effect(gpu, postShader);
postprocessing.set({
  src: scene,
  samp: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
}); // the offscreen scene becomes the post input

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(ocean);
    pass.draw(boat);
  });
});

postprocessing.draw(canvasSurface); // rendering an effect creates a pass
```

The one-shot `draw()` runs after the frame has submitted, so the scene is already rendered when postprocessing reads it. Under the hood it creates an encoder, opens a render pass on `canvasSurface`, encodes the draw, and submits — the same GPU work you would write by hand with `frame.pass`.

> Good to know: `frame.pass()` always needs a target. Use a canvas-backed [`Surface`](/reference/vgpu/surface#surface) from `surface(gpu, canvas)` or an offscreen [`Target`](/reference/vgpu/target#target) from `target(gpu, { size })`.

> Good to know: a pass takes more than a target and a clear color. [`FramePassOptions`](/reference/vgpu/frame#framepassoptions) also sets `clearDepth` (`0` for reversed-Z), `clearStencil`, a `viewport` or `scissor` rectangle for split-screen and partial redraws, `depthReadOnly` to depth-test while sampling the depth texture, a `timer` span for GPU timing, and `visibility` for occlusion queries.
