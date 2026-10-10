---
title: "Surface"
description: "Canvas-backed render target created by `surface(gpu, canvas, opts)`. Use it for browser canvases, `OffscreenCanvas`, multi-canvas rendering, and resize-driven derived targets. Opt into an owned depth attachment and 4× MSAA with `depth` and `msaa` to render depth-tested, antialiased 3D straight to the canvas."
---

## Import

```ts
import type { Surface, SurfaceOptions, SurfaceResizeEvent } from "vgpu";
```

## Signature

```ts
import type { ClearColor, Target } from "vgpu";

interface SurfaceOptions {
  readonly autoResize?: boolean;
  readonly clearColor?: ClearColor;
  readonly dpr?: number | readonly [number, number];
  readonly size?: readonly [number, number];
  readonly format?: GPUTextureFormat;
  readonly alphaMode?: GPUCanvasAlphaMode;
  readonly colorSpace?: PredefinedColorSpace;
  readonly depth?: boolean | GPUTextureFormat;
  readonly msaa?: boolean | 4;
  readonly label?: string;
}

interface SurfaceResizeEvent {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly surface: Surface;
}

interface Surface extends Target {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly autoResize: boolean;
  readonly layoutBacked: boolean;
  readonly dpr: number;
  readonly disposed: boolean;
  onResize(cb: (event: SurfaceResizeEvent) => void): () => void;
  dispose(): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| surface.canvas | `HTMLCanvasElement \| OffscreenCanvas` | ✔ | — | Must return a `GPUCanvasContext` from `getContext("webgpu")`. |
| surface.opts | `SurfaceOptions` | ✖ | `{}` | Canvas configuration, attachments, and resize behavior. Canvas configuration and depth/MSAA options are fixed at construction; see individual fields for resize behavior. |
| opts.autoResize | `boolean` | ✖ | `true` for layout-backed canvases, `false` when `size` is provided or when the canvas has no numeric `clientWidth` | Auto-resize is checked at the frame boundary before user frame callbacks. Explicit `true` on buffer-only canvases throws. |
| opts.dpr | `number \| readonly [number, number]` | ✖ | `globalThis.devicePixelRatio ?? 1` | Number fixes DPR. Tuple clamps runtime DPR to `[min, max]`; layout-backed surfaces re-read DPR each frame. |
| opts.size | `readonly [number, number]` | ✖ | Layout-backed: `clientWidth/clientHeight × dpr`; buffer-only: existing `canvas.width/height` | Physical pixel size. When provided, initial canvas buffer is set and `autoResize` defaults to `false`. |
| opts.format | `GPUTextureFormat` | ✖ | `navigator.gpu.getPreferredCanvasFormat() ?? "bgra8unorm"` | Canvas swapchain format. Also the format of the private MSAA color attachment when `msaa` is enabled. |
| opts.alphaMode | `GPUCanvasAlphaMode` | ✖ | `"premultiplied"` | Passed to `GPUCanvasContext.configure`. |
| opts.colorSpace | `PredefinedColorSpace` | ✖ | `"srgb"` | Passed to `GPUCanvasContext.configure`. |
| opts.clearColor | `ClearColor` | ✖ | `[0, 0, 0, 1]` | Default clear color of this surface, used by passes that clear without naming one. Writable at runtime as `surface.clearColor`; a pass `clear` color still wins for that pass. Four finite numbers, or a `GPUColor` object. |
| opts.depth | `boolean \| GPUTextureFormat` | ✖ | `undefined` — no depth attachment | `true` allocates an owned `"depth24plus"` attachment. A string selects `"depth16unorm"`, `"depth24plus"`, `"depth24plus-stencil8"`, `"depth32float"`, or `"depth32float-stencil8"`; any other value, including color formats and stencil-only `"stencil8"`, throws `VGPU-SURFACE-DEPTH-INVALID`. `false` is the same as omitting it. Native format features still apply: `"depth32float-stencil8"` needs `init({ requiredFeatures: ["depth32float-stencil8"] })`. |
| opts.msaa | `boolean \| 4` | ✖ | `undefined` — sample count `1` | `true` or `4` renders through a private 4-sample color attachment that resolves into the canvas texture, and gives the depth attachment 4 samples. `false` is the same as omitting it. Any other value, including `1`, `2`, `8`, and `"4"`, throws `VGPU-SURFACE-MSAA-INVALID`. There is no `sampleCount` option; `surface.sampleCount` reports the resolved `1` or `4`. |
| opts.label | `string` | ✖ | `undefined` | Used in error messages and texture labels. |
| onResize.cb | `(event: SurfaceResizeEvent) => void` | ✔ | — | Called synchronously immediately on subscription and after future size changes. |
| event.width | `number` | ✔ | — | Physical pixel width, equal to `surface.size[0]` and `canvas.width`. |
| event.height | `number` | ✔ | — | Physical pixel height, equal to `surface.size[1]` and `canvas.height`. |
| event.dpr | `number` | ✔ | — | Effective DPR used for the current size. |
| event.surface | `Surface` | ✔ | — | Surface that resized, useful for shared handlers. |
| surface.resize.size | `readonly [number, number]` | ✔ | — | Manual physical pixel size. Values are floored and clamped to at least `1`. |

**Returns:** `surface(gpu)` returns `Surface`; `onResize()` returns an unsubscribe function; `dispose()` returns `void`. `surface.depth` is the owned depth `Texture`, or `undefined` without `depth`; `surface.sampleCount` is `1` or `4`; `surface.color` is the current canvas texture, always single-sample.

**Throws:**

- `VGPU-SURFACE-CONTEXT` when `getContext("webgpu")` returns `null` — pass a canvas that supports WebGPU.
- `VGPU-SURFACE-DUPLICATE` when a live surface already owns the canvas — call `dispose()` on the old surface first.
- `VGPU-SURFACE-AUTORESIZE-UNSUPPORTED` for explicit `autoResize: true` on a buffer-only canvas — omit it and call `surface.resize(...)`.
- `VGPU-SURFACE-DEPTH-INVALID` when `depth` is not `false`, `true`, or one of the five depth-aspect formats above — use `depth: true`, a format such as `"depth24plus"`, or omit `depth`.
- `VGPU-SURFACE-MSAA-INVALID` when `msaa` is not `false`, `true`, or `4` — use `msaa: true` or `4` for four samples, or omit it for one.
- `VGPU-SURFACE-DISPOSED` when using a disposed surface, including as a `compile()`, `compileSync()`, `targets: [...]`, or `bundle()` preparation target, and for `resize()` — create a new surface.
- `VGPU-SURFACE-NOT-IN-FRAME` when a one-shot `draw.draw(surface)` / `effect.draw(surface)` runs while no frame is active, or a frame that already submitted opens a surface pass — encode surface draws inside `frame(gpu, ...)`, while `compile(surface)` and `bundle(gpu, { target: surface }, ...)` can prepare outside a frame.
- `VGPU-SURFACE-RESIZE-REENTRANT` when the same surface is resized from its own resize notification, including the immediate `onResize` fire on subscription — resize derived targets only.
- `VGPU-FRAME-REENTRANT` when `frame(gpu)` is called from any `onResize` callback, including the immediate fire on subscription — call `frame(gpu)` before subscribing or from code outside the callback.
- `VGPU-PASS-PRESERVE-MSAA` for `clear: false` on an `msaa` surface, and `VGPU-PASS-DEPTH-READONLY-MSAA` for `depthReadOnly` on one — multisample attachments are discarded at the end of each pass; use a single-sample surface or target.
- `VGPU-R1-BINDING-DESTROYED` at draw time when a binding still holds a `surface.depth` texture that a resize or `dispose()` destroyed — rebind the current `surface.depth` and re-record bundles that captured the old one.
- `VGPU-SURFACE-NOT-BINDABLE` when the surface itself is an input binding (see below).
- `VGPU-SURFACE-READ-UNAVAILABLE` when `surface.color.read()` / `readFloats()` does not refer to the current canvas texture submitted by a completed frame, or while a frame is active — read immediately after `frame()` returns or use an offscreen target for deferred readback.
- Native WebGPU validation still applies to the configured formats, features, and compatibility-mode restrictions; synchronous allocation errors propagate unchanged.

A surface is never a valid input binding. Passing one as a binding value to `draw(gpu)`, `effect(gpu)`, or `compute(gpu)` — in the constructor `set` option or a later `.set()`, inside or outside a frame — throws `VGPU-SURFACE-NOT-BINDABLE` from that call. The error names the binding and drawable in `where` (for example `post.source`). vgpu rejects the surface before it reads `color`, `colors`, or `depth`, so no canvas texture is acquired; that holds for disposed surfaces too. Fix: “Render to an offscreen target and bind that target or its texture. Use Surface only as a render destination.”

A live surface is a valid preparation target outside a frame. `draw.compile(surface)`, `effect.compile(surface)`, `compileSync(surface)`, `draw(gpu, { targets: [surface] })`, and `bundle(gpu, { target: surface }, ...)` read the surface's configured render signature — `format`, the resolved depth format (none unless `depth` is set), and the sample count (`1` unless `msaa` is set). They do not acquire the current canvas texture, read or allocate attachments, resize the canvas, notify `onResize` listeners, or submit work. Rendering to the surface — pass draws and bundle replay — stays inside `frame(gpu)` or `frameLoop(gpu)`.

## Examples

```wgsl
// surface-color.wgsl
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.6, 1, 1); }
```

```ts
import { init, effect, frame, surface } from "vgpu";
import surfaceColorShader from "./surface-color.wgsl";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
const wave = effect(gpu, surfaceColorShader);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(wave));
});

// Read immediately, before the browser advances the canvas texture. For deferred readback,
// render to an offscreen target instead.
const pixels = await canvasSurface.color.read({ mipLevel: 0, region: "all" });
console.log(pixels.byteLength);
```

### Render 3D directly to the canvas

With `depth` and `msaa`, depth-tested and antialiased geometry needs no offscreen target. This draws two published scene instances straight to the canvas:

```wgsl
// crates.wgsl
struct CameraData { viewProjection: mat4x4f }
@group(0) @binding(0) var<uniform> camera: CameraData;
struct VertexOut { @builtin(position) clip: vec4f, @location(0) normal: vec3f }

@vertex fn vs_main(
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(3) world0: vec4f, @location(4) world1: vec4f,
  @location(5) world2: vec4f, @location(6) world3: vec4f,
) -> VertexOut {
  let world = mat4x4f(world0, world1, world2, world3);
  var out: VertexOut;
  out.clip = camera.viewProjection * world * vec4f(position, 1.0);
  out.normal = (world * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let light = max(dot(normalize(normal), normalize(vec3f(1.0, 1.0, 1.0))), 0.15);
  return vec4f(vec3f(0.9, 0.5, 0.1) * light, 1.0);
}
```

```ts
import { draw, frameLoop, geometry, init, surface } from "vgpu";
import { box, composeMatrix, instances, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import crateShader from "./crates.wgsl";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { depth: true, msaa: true }); // owned depth24plus, 4 samples

const crates = instances({ capacity: 2 });
crates.setWorld(crates.add(), composeMatrix({ position: [-0.6, 0, 0] }, new Float32Array(16)));
crates.setWorld(crates.add(), composeMatrix({ position: [0.6, 0, -1] }, new Float32Array(16)));
const crateBridge = instanceGeometry(gpu, crates, { mesh: geometry(gpu, box()) });

const crateDraw = draw(gpu, {
  geometry: crateBridge.geometry,
  cull: "back",
  shader: crateShader,
});

const rig = orbitRig({ yaw: 0.6, pitch: 0.4, distance: 4 });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = new Float32Array(16);
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

canvasSurface.onResize(({ width, height }) => { // fires now, then after every resize
  perspective({ fov: 45, near: 0.1, far: 100 }, width / height, projection);
  viewMatrices(rigPose(rig, pose), projection, matrices);
  crateDraw.set({ camera: { viewProjection: matrices.viewProjection } }); // set() packs now
});
const crateCount = crateBridge.publish(); // CPU records -> instance buffer

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.07, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount }); // depth-tested, resolved into the canvas texture
  });
});
```

The pass clears depth to `1` and stencil to `0` unless you pass `clearDepth` / `clearStencil`. Camera, uniforms, publication, and the instance count stay yours; the surface only owns the attachments. The draw's default depth state (`write: true`, `compare: "less-equal"`) applies because the pass target now has depth.

### Sample an image after you render it

To sample a rendered image — post-processing, feedback, compositing — render it into an offscreen `Target` first, bind that target, and present the result to the surface:

```wgsl
// scene.wgsl
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.5, 1); }
```

```wgsl
// present.wgsl
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(sceneTexture, sceneSampler, uv);
}
```

```ts
import { init, effect, frame, sampler, surface, target } from "vgpu";
import presentShader from "./present.wgsl";
import sceneShader from "./scene.wgsl";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas);
const sceneTarget = target(gpu, { size: canvasSurface.size }); // offscreen, sampleable, same size as the canvas
const scene = effect(gpu, sceneShader);
const present = effect(gpu, presentShader, { set: { sceneTexture: sceneTarget, sceneSampler: sampler(gpu) } }); // bind the Target, never the Surface

canvasSurface.onResize(({ width, height }) => sceneTarget.resize([width, height])); // the binding follows the new attachment

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: sceneTarget }, (pass) => pass.draw(scene)); // produce offscreen
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(present)); // present to the canvas
});
```

The surface appears only as a pass `target`. Because `present` binds `sceneTarget` itself, the binding picks up the replacement attachment after every `sceneTarget.resize(...)`; no rebind is needed. Binding `{ sceneTexture: canvasSurface }` instead throws `VGPU-SURFACE-NOT-BINDABLE`.

### Read the surface depth

A single-sample depth surface stores its depth, so a later pass in the same frame can depth-test against it and read it. Bind `surface.depth` explicitly and rebind it after every resize:

```wgsl
// opaque.wgsl
@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[vi], 0.25, 1);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.2, 0.5, 0.2, 1);
}
```

```wgsl
// haze.wgsl
@group(0) @binding(0) var sceneDepth: texture_2d<f32>; // unfilterable float view, compatibility-safe

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(p[vi], 0.0, 1);
}

@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let depth = textureLoad(sceneDepth, vec2i(position.xy), 0).x;
  return vec4f(0.7, 0.8, 0.9, 1.0) * depth * 0.3;
}
```

```ts
import { draw, frame, init, surface } from "vgpu";
import hazeShader from "./haze.wgsl";
import opaqueShader from "./opaque.wgsl";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { depth: true }); // no msaa: depth is stored and readable
const opaque = draw(gpu, { shader: opaqueShader });
const haze = draw(gpu, {
  shader: hazeShader,
  depth: { write: false }, // depth-test without writing the read-only depth
  blend: "additive",
});

canvasSurface.onResize(() => haze.set({ sceneDepth: canvasSurface.depth! })); // fires now; resize destroys the old depth

frame(gpu, (currentFrame) => {
  currentFrame.pass(canvasSurface, opaque); // writes depth
  currentFrame.pass({ target: canvasSurface, clear: false, depthReadOnly: true }, haze); // tests and reads the same depth
});
```

`surface.depth` is a plain `Texture` with `render_attachment` and `texture_binding` usage, so the binding keeps that exact texture. The `onResize` rebind keeps it current for explicit and automatic resizes; direct canvas writes need an explicit rebind after reconciliation (see [Resize transaction](#resize-transaction)). A draw that still holds a destroyed depth throws `VGPU-R1-BINDING-DESTROYED`. An `msaa` surface's depth has 4 samples and is discarded after each pass, so it cannot be read this way.

### Derived targets, multiple canvases, and `OffscreenCanvas`

```ts
import { init, effect, frame, surface, target } from "vgpu/mock";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
declare const canvas: HTMLCanvasElement;
const canvasSurface = surface(gpu, canvas);

const bloomSize = (w: number, h: number): [number, number] => [w / 2, h / 2];
const bloom = target(gpu, { size: bloomSize(canvasSurface.size[0], canvasSurface.size[1]) });
const brightPass = effect(gpu, prepareShader(`
  struct Params { resolution: vec2f }
  @group(0) @binding(0) var<uniform> params: Params;
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`), { set: { params: { resolution: bloom.size } } });
const composite = effect(gpu, prepareShader(`@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }`));

canvasSurface.onResize(({ width, height }) => {
  bloom.resize(bloomSize(width, height));
  brightPass.set({ params: { resolution: bloom.size } });
});

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: bloom }, (pass) => pass.draw(brightPass));
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.draw(composite));
});
```

```wgsl
// shared.wgsl
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
```

```ts
import { init, effect, frame, surface } from "vgpu";
import sharedShader from "./shared.wgsl";

declare const canvasA: HTMLCanvasElement;
declare const canvasB: HTMLCanvasElement;

const gpu = await init();
const main = surface(gpu, canvasA);
const preview = surface(gpu, canvasB, { autoResize: false, size: [320, 180] });
const shader = effect(gpu, sharedShader);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: main }, (p) => p.draw(shader));
  currentFrame.pass({ target: preview }, (p) => p.draw(shader));
});
```

```ts
import { init, surface, target } from "vgpu";

declare const offscreen: OffscreenCanvas;
declare function postMessage(message: unknown): void;

const gpu = await init();
const canvasSurface = surface(gpu, offscreen);
const half = target(gpu, { size: [Math.max(1, canvasSurface.size[0] / 2), Math.max(1, canvasSurface.size[1] / 2)] });

canvasSurface.onResize(({ width, height }) => {
  half.resize([width / 2, height / 2]);
  postMessage({ type: "resized", width, height });
});

canvasSurface.resize([640, 360]);
```

### Prepare before the first frame

Prepare pipelines and bundles for the surface during loading, then render inside the frame loop:

```wgsl
// prewarm-background.wgsl
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.2, 0.4, 1); }
```

```ts
import { init, bundle, effect, frameLoop, surface } from "vgpu";
import backgroundShader from "./prewarm-background.wgsl";

declare const canvas: HTMLCanvasElement;

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { depth: true, msaa: true });
const background = effect(gpu, backgroundShader);

await background.compile(canvasSurface); // outside a frame: format + depth24plus + 4 samples, no canvas texture acquired
const statics = bundle(gpu, { target: canvasSurface }, (recorded) => recorded.draw(background)); // also outside a frame

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface }, (pass) => pass.bundles(statics)); // replay stays inside the frame
});
```

The signature here is `{ colors: [canvasSurface.format], depth: "depth24plus", sampleCount: 4 }`; compiling against that object warms the same cached pipeline. Resizing the surface changes only its size, so the compiled pipeline and the recorded bundle keep matching its render signature. Normal bundle staleness still applies: a bundle that samples a resized `Target`, or that bound an old `surface.depth`, must be re-recorded.

## Attachments and lifetimes

- **Color.** `surface.color` wraps the canvas's current texture, single-sample in `surface.format`. The browser replaces it after each presentation, and vgpu never destroys it. With `msaa`, each pass renders into a private 4-sample color attachment and resolves into that texture; the multisample attachment has no public handle.
- **Depth.** `surface.depth` is owned by the surface, with the surface's sample count. The same `Texture` stays valid until the surface resizes or is disposed; then it is destroyed.
- **Pass semantics.** Single-sample depth is stored at the end of each pass, so `clear: false` and `depthReadOnly` work on it. It is not replaced per frame: a `clear: false` first pass of a new frame loads the previous frame's depth over fresh canvas color, so clear the first surface pass of each frame. With `msaa`, color and depth are discarded after the pass: every surface pass must clear, so encode a frame's draws into one surface pass.
- **Construction.** `surface()` allocates every owned attachment before it returns. If an allocation throws, vgpu destroys the partial attachments, unconfigures the context, restores the canvas size it changed, and rethrows; the canvas can take a new surface.
- **Dispose.** `dispose()` unconfigures the context, frees the canvas for a new surface, and destroys the owned depth and MSAA attachments even when an `onDestroy` listener throws; the first listener error is rethrown afterwards. A second `dispose()` does nothing.

## Resize transaction

`resize()`, automatic layout/DPR resizes at the frame boundary, and reconciliation of a canvas you resized yourself all replace attachments in four steps:

1. **Prepare.** Allocate the replacement MSAA color and depth at the new size. If an allocation throws synchronously, vgpu destroys the partial replacements and rethrows; the canvas size, DPR, attachments, and existing bindings stay exactly as they were, and no callback runs.
2. **Commit.** Publish the new canvas size, DPR, and attachments together.
3. **Notify.** Run internal attachment-replacement listeners, then public `onResize` callbacks for explicit or automatic resizes. Every callback already sees the new `surface.size`, `dpr`, and `surface.depth`.
4. **Release.** Destroy the previous owned attachments.

A throwing callback does not stop the remaining callbacks or the release step; the first error is rethrown after both, and the new generation stays committed. The reentrancy guard covers steps 2–4, including an `onResize` subscription made inside a replacement callback: resizing the same surface there throws `VGPU-SURFACE-RESIZE-REENTRANT`, and `frame(gpu)` throws `VGPU-FRAME-REENTRANT`.

A resize matching both the canvas buffer and the attachment generation allocates nothing and notifies nobody. After a direct canvas write, `surface.resize(surface.size)` replaces stale owned attachments and notifies listeners so they can rebind; a default surface with no owned attachments keeps its existing no-op behavior. A library change to the canvas buffer size notifies in either case.

If you write `canvas.width` / `canvas.height` directly between frames, vgpu reconciles attachments at the next frame boundary, before your callback encodes any passes, including for `OffscreenCanvas` and `autoResize: false`. Reconciliation itself does not notify public `onResize` listeners; internal texture-replacement notifications still invalidate references to old attachments. Automatic layout resizing retains its usual notifications. Rebind a captured depth texture to the current `surface.depth` before using it. Prefer `surface.resize(...)` before the frame so replacement, rebinding, and public notifications happen together.

The pass descriptor also reconciles dimensions changed during a frame, before acquiring the canvas texture. This does not preserve commands that already reference old attachments: resize before encoding them, and submit any older manual frames first. If replacement allocation throws, the frame boundary or pass throws before user encoding or texture acquisition respectively; `surface.size` reports your written size, the old attachments stay live, and the next attempt retries. vgpu does not roll back your canvas write. Late native validation or out-of-memory errors arrive through normal WebGPU error reporting without rollback; this is not an async resize API.

## Notes

- Use a `Surface` for the swapchain/backbuffer: it renders the current browser frame, including direct 3D with `depth` and `msaa`. Use `target(gpu, ...)` for intermediate, reusable, sampleable/readable images — post-processing, history, ping-pong; see `Target` for the contrast.
- `surface.color.read(...)` / `readFloats(...)` only read the current canvas texture after its frame was submitted and before presentation advances. Reads before submission, after cancellation, during a frame, or from a stale canvas texture throw `VGPU-SURFACE-READ-UNAVAILABLE`. For reliable or deferred readback, render to an offscreen `Target` instead.
- A surface pass may be the final presentation pass; do not use a surface as a ping-pong resource. For post-processing, render into a `Target`, then sample it in a draw or effect targeting the surface in the same frame.
- Do not bind a surface: `set({ source: canvasSurface })` throws `VGPU-SURFACE-NOT-BINDABLE` in every resource slot (sampled color or depth, storage texture, sampler, buffer). Bind an offscreen `Target` to follow its attachment across resizes, or bind an explicit `Texture` such as `sceneTarget.color` or a single-sample `canvasSurface.depth` to keep that exact texture until you rebind it.
- `surface.color` is still a `Texture`, but it wraps the canvas's current texture, which the browser replaces after each presentation. Binding it explicitly is not a substitute for an offscreen target: the binding does not follow later frames and is not safe to reuse after the frame presents.
- Prepare against the surface itself once it exists; it reports the exact depth format and sample count. Keep a signature such as `{ colors: [navigator.gpu.getPreferredCanvasFormat()] }` — plus `depth` / `sampleCount: 4` when the surface will enable them — for preparation before `surface(gpu, canvas)` runs. Do not hardcode `bgra8unorm` or `rgba8unorm` for a canvas.
- Layout-backed detection is structural: `typeof canvas.clientWidth === "number"`; it does not use `instanceof`.
- Resize callbacks run in surface creation order at the frame boundary, before the user frame callback.
- Manual `surface.resize()` fires callbacks synchronously at the call site and works for `OffscreenCanvas`.
- `surface.color.read({ mipLevel: 0, region: "all" })` reads the canvas texture current when you call it — with `msaa`, the resolved single-sample image; vgpu keeps no copy of an earlier presented frame. To read a rendered image back later, render it into a `Target` and read `target.color`. It returns RGBA bytes. Canvas formats `bgra8unorm` and `bgra8unorm-srgb` are supported and swizzled to RGBA, which matters on platforms where `navigator.gpu.getPreferredCanvasFormat()` returns BGRA.
- `surface.color.readFloats({ mipLevel: 0, region: "all" })` returns the same pixels decoded to a `Float32Array` of components (`unorm8` canvas formats normalized to `[0, 1]`); it is the readback to use if a surface is ever configured with a float format.
- A canvas can have only one live surface. Call `surface.dispose()` before creating another one for the same canvas.
- **See also:** `init`, `surface`, `Target`, `Frame`, `Bundle`, `instanceGeometry`.
