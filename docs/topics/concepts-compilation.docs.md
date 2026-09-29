---
title: Compilation
summary: Pipelines compile lazily on first use; pre-warm them during load so the first frame doesn't hitch.
relatedSymbols:
  - Draw
  - Effect
  - CompileTarget
prevNext:
  prev:
    title: Draws
    href: /concepts/draws
  next:
    title: Effects
    href: /concepts/effects
order: 30
---

# Compilation

Pipelines compile lazily: the first `draw()` against a new target pays the pipeline creation cost, and that cost lands inside your frame. WebGPU keys pipelines by shader *and* render signature — the tuple of color formats, depth format, and sample count — so the same WGSL rendering into a canvas and into an MSAA target means two compilations. `compile()` moves that work into load time.

Pipeline compilation is separate from shader preparation. A `.wgsl` import through the `@vgpu/wgsl` loader already carries its reflection, so `draw(gpu)` and `effect(gpu)` validate that metadata synchronously when you create them and never parse WGSL; the native shader module and pipeline are what `compile()` warms.

## Pre-warming with a target

For an existing offscreen target, `await draw.compile(target)` and `await effect.compile(target)` warm exactly that signature and resolve back to the same object:

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

For an existing surface, use `await ocean.compile({ colors: [canvasSurface.format] })` to respect its actual format, including an explicit `surface(..., { format })` override. Passing the surface itself to `compile()` outside a frame is rejected; a signature lets you pre-warm during loading without acquiring a canvas texture. Render to surfaces through `frame()` or `frameLoop()`.

The signature must match the actual target's color formats, depth format, and sample count. A canvas surface has no depth attachment and a sample count of 1, so the example omits both optional fields. For offscreen targets, use their configured formats and include depth/MSAA when enabled, or pass the existing target directly to `compile()`.

> Good to know: `getPreferredCanvasFormat()` returns the system's preferred `rgba8unorm` or `bgra8unorm` canvas texture format. Compiling a different valid signature can succeed, but it doesn't warm the pipeline needed by the actual target: the first render still compiles that pipeline lazily.

## `compileSync()`

`compileSync(target)` is the blocking twin: same cache, same signatures, but it creates the pipeline right now. Use it in tools and tests where jank doesn't matter. If an async `compile()` for the same signature is in flight, the synchronous result wins and the pending promise resolves with it.

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

## Render bundles

Recording a [bundle](/concepts/render-bundles) needs every pipeline immediately, so anything you didn't pre-warm compiles synchronously at record time. See [compilation at record time](/concepts/render-bundles#compilation-at-record-time) for that flow.
