---
title: "Compilation"
description: "Pipelines compile lazily on first use; pre-warm them during load so the first frame doesn't hitch."
---

Pipelines compile lazily: the first `draw()` against a new target pays the pipeline creation cost, and that cost lands inside your frame. WebGPU keys pipelines by shader *and* render signature — the tuple of color formats, depth format, and sample count — so the same WGSL rendering into a canvas and into an MSAA target means two compilations. `compile()` moves that work into load time.

Pipeline compilation is separate from shader preparation. A `.wgsl` import through the `@vgpu/wgsl` loader already carries its reflection, so `draw(gpu)` and `effect(gpu)` validate that metadata synchronously when you create them and never parse WGSL; the native shader module and pipeline are what `compile()` warms.

## Pre-warming with a target

For an existing offscreen target, `await draw.compile(target)` and `await effect.compile(target)` warm exactly that signature and resolve back to the same object:

```wgsl
// ocean.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.8, 1.0);
}
```

```wgsl
// triangle.wgsl
struct Out { @builtin(position) position: vec4f }

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> Out {
  var pts = array<vec2f, 3>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.0, 0.5));
  var out: Out;
  out.position = vec4f(pts[vi], 0.0, 1.0);
  return out;
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.4, 0.2, 1.0);
}
```

```ts
import { init, draw, effect, target } from "vgpu";
import oceanShader from "./ocean.wgsl"; // fragment-only effect
import triangleShader from "./triangle.wgsl"; // vs_main + fs_main, three hardcoded vertices

const gpu = await init();
const offscreen = target(gpu, { size: [512, 512] });

// ---cut---
const ocean = effect(gpu, oceanShader);
const tri = draw(gpu, { shader: triangleShader });

await Promise.all([ocean.compile(offscreen), tri.compile(offscreen)]);
tri.draw(offscreen);
ocean.draw(offscreen);
```

The pipelines are cached per signature at the device level, so those first `draw()` calls — and every draw after them — just encode work.

## Pre-warming for a canvas surface

A live surface works the same way, during loading and outside any frame. Pass it to `compile()`, then render through `frame()` or `frameLoop()`:

```ts
import { init, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;

// ---cut---
const canvasSurface = surface(gpu, canvas);
const ocean = effect(gpu, oceanShader);

await ocean.compile(canvasSurface); // no frame needed — no canvas texture is acquired

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass(canvasSurface, (pass) => pass.draw(ocean)); // drawing stays inside the frame
});
```

`compile(canvasSurface)` reads the surface's configured render signature — its `format`, including an explicit `surface(..., { format })` override, plus the depth format and sample count it was created with. A plain `surface(gpu, canvas)` has no depth attachment and a sample count of 1. It does not acquire the current canvas texture, read or allocate attachments, resize the canvas, notify `onResize` listeners, or submit work. `compileSync(canvasSurface)` and `draw(gpu, { targets: [canvasSurface] })` prepare the same pipeline synchronously.

A surface created with `depth` or `msaa` reports those in its signature, so the same call warms the exact pipeline its passes need:

```ts
import { init, effect, frameLoop, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const ocean = effect(gpu, oceanShader);

// ---cut---
const sceneSurface = surface(gpu, canvas, { depth: true, msaa: true });

await ocean.compile(sceneSurface); // warms format + "depth24plus" + 4 samples

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass(sceneSurface, ocean);
});
```

Prefer `compile(surface)` once the surface exists: it cannot drift from the surface's real depth format and sample count. The signature excludes size, so resizing the surface keeps every pipeline compiled for it. Compiling against the surface or against the equivalent signature — `{ colors: [canvasSurface.format] }` for a plain surface, `{ colors: [sceneSurface.format], depth: "depth24plus", sampleCount: 4 }` for the one above — warms the same cached pipeline.

> Warning: Preparation is not drawing. A one-shot `ocean.draw(canvasSurface)` outside a frame still throws `VGPU-SURFACE-NOT-IN-FRAME`; encode surface draws inside `frame(gpu, ...)` or `frameLoop(gpu, ...)`. Compiling against a disposed surface throws `VGPU-SURFACE-DISPOSED` — create a live surface first.

## Compiling without a target

Sometimes the target doesn't exist yet. Pass a signature object instead: `colors` is required, `depth` and `sampleCount` are optional. For a future canvas surface using the default format, query `navigator.gpu.getPreferredCanvasFormat()` rather than assuming a format:

```ts
import { init, effect, frame, surface } from "vgpu";
import oceanShader from "./ocean.wgsl";

const gpu = await init();
const ocean = effect(gpu, oceanShader);

// ---cut---
const format = navigator.gpu.getPreferredCanvasFormat();
await ocean.compile({ colors: [format] });

// Later, surface() selects the same preferred format by default.
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
frame(gpu, (frame) => frame.pass(canvasSurface, ocean));
```

Once the surface exists, pass it directly — `await ocean.compile(canvasSurface)` — as in the previous section. Use a signature only when you prepare before the surface is created.

The signature must match the actual target's color formats, depth format, and sample count. The surface in this example is created without `depth` or `msaa`, so it has no depth attachment and a sample count of 1, and the signature omits both optional fields. For a surface created with `{ depth: true, msaa: true }`, add `depth: "depth24plus", sampleCount: 4`. For offscreen targets, use their configured formats and include depth/MSAA when enabled, or pass the existing target or surface directly to `compile()`.

> Good to know: `getPreferredCanvasFormat()` returns the system's preferred `rgba8unorm` or `bgra8unorm` canvas texture format. Compiling a different valid signature can succeed, but it doesn't warm the pipeline needed by the actual target: the first render still compiles that pipeline lazily.

## `compileSync()`

`compileSync(target)` is the blocking twin: same cache, same signatures, but it creates the pipeline right now. Use it in tools and tests where jank doesn't matter. If an async `compile()` for the same signature is in flight, the synchronous result wins and the pending promise resolves with it.

```wgsl
// grid.wgsl
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.1, 0.4, 0.7, 1.0);
}
```

```ts
import { init, draw, target } from "vgpu";
import gridShader from "./grid.wgsl"; // fullscreen-triangle vs_main + flat fs_main

const gpu = await init();
const offscreen = target(gpu, { size: [2048, 2048], depth: true });
const grid = draw(gpu, { shader: gridShader });

grid.compileSync(offscreen);
```

## Errors

A failed `compile()` rejects its promise — the error belongs to the call site, so catch it where you scheduled the warm-up:

```ts
import { init, draw } from "vgpu";
import triangleShader from "./triangle.wgsl";

const gpu = await init();
const tri = draw(gpu, { shader: triangleShader });

try {
  await tri.compile({ colors: [navigator.gpu.getPreferredCanvasFormat()] });
} catch (error) {
  console.error('Pipeline failed to compile', error);
}
```

The lazy path is different: since `draw()` returns immediately, a pipeline that fails to compile on first use reports through [`gpu.onError`](/reference/vgpu/gpu#onerror), and `gpu.settled()` lets tests wait for those deliveries. Pre-warmed or not, the failure never lands twice.

## Disposing while a compile is pending

Compiled pipelines belong to the device-wide cache, not to the draw that requested them. Two draws or effects with the same shader and options compiling for the same signature share one compilation and one pipeline. [`dispose()`](/reference/vgpu/draw#draw) retires only its own owner, so it never cancels or poisons that shared work:

```ts
import { init, effect, VGPUError } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const oceanSource = prepareShader(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, 0.8, 1.0);
  }
`);

// ---cut---
const signature = { colors: [navigator.gpu.getPreferredCanvasFormat()] };
const preview = effect(gpu, oceanSource, { label: "preview" });
const ocean = effect(gpu, oceanSource, { label: "ocean" });

const previewReady = preview.compile(signature).catch((error: unknown) => {
  if (error instanceof VGPUError && error.code === "VGPU-DRAW-DISPOSED") return; // retired on purpose
  throw error;
});
const oceanReady = ocean.compile(signature); // shares the preview's pipeline compilation

preview.dispose(); // the preview closed before its pipeline was ready
await Promise.all([previewReady, oceanReady]); // ocean resolves; its pipeline stays cached
```

The pending `preview.compile()` is not rejected at `dispose()`. It settles when the shared compilation does, then rejects with `VGPU-DRAW-DISPOSED` at `preview.compile` — whether the pipeline compiled or failed — and is not reported again through `gpu.onError`. `ocean.compile()` resolves or fails exactly as it would have without the disposal. A disposed compute behaves the same way with `VGPU-COMPUTE-DISPOSED`. After `dispose()`, a new `compile()` or `compileSync()` on that owner throws synchronously; create a new draw, effect, or compute instead.

## Render bundles

Recording a [bundle](/concepts/render-bundles) needs every pipeline immediately, so anything you didn't pre-warm compiles synchronously at record time. See [compilation at record time](/concepts/render-bundles#compilation-at-record-time) for that flow.
