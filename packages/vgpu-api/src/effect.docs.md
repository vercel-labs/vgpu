# Effect

Fullscreen-fragment render unit created by `effect(gpu)`. Use it for post-processing, gradients, blurs, and screen/target copies; use `draw(gpu)` for meshes, vertex buffers, instancing, or explicit vertex counts.

## Import

```ts
import type { Effect, EffectOptions } from "vgpu";
```

## Signature

```ts
import type { DrawCallOptions, Target, TargetSignature } from "vgpu";

type SetBag = Record<string, unknown>;

type BlendPreset = "alpha" | "additive" | "premultiplied";
interface BlendComponentOptions { readonly src: GPUBlendFactor; readonly dst: GPUBlendFactor; readonly op?: GPUBlendOperation; }
interface BlendOptions { readonly color: BlendComponentOptions; readonly alpha?: BlendComponentOptions; }

interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
  readonly entry?: { readonly fragment?: string };
  readonly blend?: BlendPreset | BlendOptions;
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
}

interface Effect {
  readonly gpu: GPURenderPipeline | undefined;
  dispose(): void;
  set(values: SetBag): this;
  draw(target?: Target | DrawCallOptions): void;
  compile(target?: Target | TargetSignature): Promise<this>;
  compileSync(target?: Target | TargetSignature): this;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| effect.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. Fragment selection prefers `fs_main` when several fragment entries exist, otherwise uses the first; a single entry can have any name. If no `@vertex` entry exists, vgpu injects a fullscreen triangle vertex stage and provides `@location(0) uv`. |
| effect.opts | `EffectOptions` | ✖ | `{}` | Initial options. Passing a `geometry` property is rejected; effects have no vertex buffers. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Same as one initial `.set(opts.set)` call: establishes first-set binding ownership and validates reflected bindings. |
| opts.label | `string` | ✖ | `"effect"` | Used in shader reflection labels, GPU object labels, and `VGPU-*` error `where` fields. |
| opts.entry | `{ fragment?: string }` | ✖ | `fs_main` when declared, otherwise first fragment | Constructor-only selection. An explicit name overrides the default and must identify a declared `@fragment`. Omission, `{}`, and `{ fragment: undefined }` use automatic selection. Vertex overrides are not supported. |
| opts.blend | `"alpha" \| "additive" \| "premultiplied" \| BlendOptions` | ✖ | `undefined` | Constructor-only blend state passed through to the fullscreen draw. Presets and defaults match `DrawOptions.blend`; omitted explicit `alpha` copies `color`, and `op` defaults to `"add"`. |
| opts.writeMask | `readonly ("r" \| "g" \| "b" \| "a")[]` | ✖ | all channels | Constructor-only color channel mask. Omit for RGBA; `[]` writes no channels; `["r","g","b"]` skips alpha. |
| effect.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are lib-owned; resources are user-owned. A raw `GPUBuffer` or `GPUBufferBinding` (`{ buffer, offset?, size? }`) in a uniform/storage slot binds that byte range as a caller-owned resource, with the same defaults, snapshot, and checks as [`Draw`](/reference/vgpu/draw#draw) (see Notes). A `Target` follows its attachment across resizes; a `Texture` stays bound to that exact texture. A `Surface` is rejected in every slot with `VGPU-SURFACE-NOT-BINDABLE`. |
| effect.draw.target | `Target \| DrawCallOptions` | ✖ | `{}` | One-shot render pass. Pass a bare target for the common case, or an options bag when setting per-call draw options. |
| opts.target | `Target` | ✖ | — | Required at runtime when an options bag is used. Use an offscreen `Target`, or a `Surface` while a frame is active; outside a frame a surface throws `VGPU-SURFACE-NOT-IN-FRAME`. |
| effect.dispose | `() => void` | ✖ | not called — an effect you stop referencing is collected without it | Takes no arguments. Synchronous and idempotent; valid after `gpu.dispose()` or device loss. Retires the effect and its one underlying draw: every later member call throws `VGPU-DRAW-DISPOSED`, every managed `Bundle` that recorded it goes stale, and its bindings, values, and cached bind groups are released. Never destroys borrowed resources or shared pipelines. See Disposal below. |

The `uv` varying that `effect(gpu)` injects is top-origin: `(0, 0)` is the
top-left corner and `v` grows downward — the same convention as WebGPU texture
coordinates, `@builtin(position)`, and `target.color.read({ mipLevel: 0, region: "all" })`. Sampling any texture
with this `uv` needs no flip: a pass that samples `src` at `uv` reproduces the
image exactly. If you are porting a WebGL or Shadertoy shader that assumes
`v` grows upward, invert once at the boundary (`1.0 - uv.y`) and keep
everything else flip-free.

**Returns:** `effect(gpu)` returns `Effect`; `effect.set()` and `effect.compileSync()` return the same `Effect`; `effect.compile()` returns `Promise<this>`; `effect.draw()` returns `void` after starting a one-shot draw path; `effect.dispose()` returns `void`.

**Throws:** `VGPU-DRAW-DISPOSED` when any member other than `dispose()` is used after `dispose()` — `set()`, one-shot `draw()`, `compile()`, `compileSync()`, the `gpu` getter, `FramePass.draw(effect)`, the `currentFrame.pass(target, effect)` shorthand, or `BundleRecorder.draw(effect)`. An effect shares the draw error family: the message is `Draw '<label>' has been disposed.`, `where` is `<label>.<operation>`, and `detail` is `{ label }`, with the effect's label. The check runs before argument normalization and this effect's target, binding, and device checks; frame and pass errors keep their own precedence. `compile()` throws synchronously when already disposed, and a pending `compile()` rejects with this code once its preparation settles. Create a new `effect(gpu, ...)`; a disposed effect cannot be reused. `VGPU-ENTRY-INVALID` for malformed `entry`, a vertex override, or a fragment name that is not a string, does not exist, or belongs to another stage; `VGPU-TARGET-REQUIRED` when `effect.draw()` or compile pre-warm is called without `target`; `VGPU-SURFACE-NOT-IN-FRAME` when one-shot `effect.draw()` targets a `Surface` while no frame is active — encode surface draws inside `frame(gpu, ...)`, while `compile(surface)` and `bundle(gpu, { target: surface }, ...)` can prepare outside a frame; `VGPU-SURFACE-DISPOSED` when `compile()` or `compileSync()` receives a disposed `Surface` (`compile()` throws synchronously instead of rejecting) — prepare against a live surface; `VGPU-BLEND-INVALID` for an unknown blend preset or malformed blend object; `VGPU-WRITEMASK-INVALID` for a non-array or unknown write mask channel; `VGPU-RING1-UNSUPPORTED` when `effect(gpu)` receives mesh/vertex data; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-SET-VALUE-INVALID` when a JS-owned binding has the wrong structure/vector/matrix/fixed-array shape or an out-of-range integer (structured detail contains `reason` and the complete `path`); `VGPU-R1-BINDING-NEVER-SET` when a reflected binding has no value at draw time; `VGPU-R1-OWNERSHIP-FLIP` when a binding switches between JS-value and resource ownership; `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` at `set` when a resource does not satisfy the binding — for a raw `GPUBuffer`/`GPUBufferBinding` this includes a missing `uniform`/`storage` usage, a non-integer, negative, `null`, or out-of-bounds `offset`/`size`, a zero size, an `offset` that is not a multiple of the granted `minUniformBufferOffsetAlignment`/`minStorageBufferOffsetAlignment`, a range smaller than the WGSL type or larger than the granted maximum binding size, and a storage size that is not a multiple of 4; the message names the binding, group, and binding number, `fix` gives the required usage and a valid aligned offset/size, and the previous value stays bound; `VGPU-R1-BINDING-DESTROYED` when `set()` receives an already-destroyed tracked `Buffer`, `Uniform`, `uniforms()` block, `Texture`, or `Target`, or an active tracked resource was destroyed before use — bind a live replacement and re-record bundles that captured it (direct operations on a destroyed `Buffer`, such as `write()`, still report `VGPU-BUFFER-DISPOSED`; a destroyed raw `GPUBuffer` is reported by native WebGPU validation instead); `VGPU-SET-TEXTURE-FILTERABILITY` when an ordinarily sampled facade texture is not filterable (structured detail names its format/binding and paired sampler; use a filterable format, request `float32-filterable`, or use `textureLoad` without a sampler); `VGPU-SURFACE-NOT-BINDABLE` when a `Surface` is passed as a binding value in `opts.set` or a later `set()`, inside or outside a frame — `where` is `<label>.<binding>`, vgpu throws before reading the surface's attachments or acquiring a canvas texture, and the rejected binding keeps its previous value (keys earlier in the same `set()` call are already applied); render to an offscreen target and bind that target or its texture, and use the `Surface` only as a render destination. Asynchronous draw validation errors are delivered through `gpu.onError`; tests can `await gpu.settled()`.

Managed uniform `set()` calls validate and pack on every call and always update the stored CPU value. Frame-only values upload through captured frame pages; one-shot draws upload pending values when used. When the newly packed bytes equal the previous bytes, the update is not a new revision, so later draws in the same frame reuse the snapshot already captured. Storage bindings and live uniforms (recorded into a bundle, or a `uniforms(gpu)` object whose `.buffer`/`.gpu` was accessed) still write on every `set()`.

## Examples

```ts
import { init, clock, effect, frame, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const shader = effect(gpu, `
  struct Params { time: f32, speed: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1);
  }
`, { label: "wave", set: { params: { time: 0, speed: 2 } } });

shader.set({ params: { time: clock(gpu).time, speed: 2 } });
frame(gpu, (currentFrame) => currentFrame.pass(colorTarget, shader));
```

```ts
import { init, effect, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [32, 32] });
const copy = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv.x, uv.y, 0.0, 1.0);
  }
`);
copy.draw(colorTarget);
```

Select an alternative fragment from the same module:

```ts
import { effect, frame, init, target } from "vgpu/mock";

const gpu = await init();
const output = target(gpu, { size: [4, 4] });
const shader = `
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
  @fragment fn mask() -> @location(0) vec4f { return vec4f(0, 0, 0, 1); }
`;
const mask = effect(gpu, shader, { entry: { fragment: "mask" } });
frame(gpu, f => f.pass(output, mask));
gpu.dispose();
```

## Pipeline pre-warm

Effects compile lazily for the target signature they draw into. Use `await effect.compile(target)` during loading to pre-warm without blocking, or `effect.compileSync(target)` when synchronous creation is acceptable. Signature objects follow the same shape as draws: `colors` is required, `depth` and `sampleCount` are optional.

A live `Surface` is a valid preparation target outside a frame. `compile()` reads its configured signature — `format`, resolved depth format, and sample count — without acquiring the canvas texture, resizing the canvas, or submitting work:

```ts
import { init, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);

// ---cut---
const gradient = effect(gpu, `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0.6, 1); }
`);
await gradient.compile(canvasSurface); // during loading, outside any frame

frameLoop(gpu, (currentFrame) => currentFrame.pass(canvasSurface, gradient)); // drawing stays in the frame
```

Before the surface exists, compile against `{ colors: [navigator.gpu.getPreferredCanvasFormat()] }` for a surface with the default format, no depth, and one sample. A surface created later with those defaults shares that cached pipeline. Include the planned `depth` format and `sampleCount` for a surface using those options, or prefer `compile(surface)` once it exists.

## Disposal

`dispose()` is optional. An effect you stop referencing is collected eventually, like any JavaScript object, and bundles that recorded it keep replaying. Call `dispose()` to retire an effect at a known point — unmounting a component, swapping a post-processing chain. It delegates to the effect's one underlying draw, so it has exactly the [`Draw` disposal](/reference/vgpu/draw#draw) behavior and the same `VGPU-DRAW-DISPOSED` error. It is synchronous, idempotent, and valid after `gpu.dispose()` or device loss.

Stop whatever still calls the effect before you dispose it — the frame loop and any resize subscription that calls `set()`:

```ts
import { init, effect, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);

// ---cut---
const vignette = effect(gpu, `
  struct Params { width: f32, height: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let centered = position.xy / vec2f(params.width, params.height) - 0.5;
    return vec4f(vec3f(1.0 - length(centered)), 1.0);
  }
`, { label: "vignette" });

const unsubscribe = canvasSurface.onResize(({ width, height }) => {
  vignette.set({ params: { width, height } });
}); // fires once immediately with the current size
const loop = frameLoop(gpu, (currentFrame) => currentFrame.pass(canvasSurface, vignette));

function teardown(): void {
  loop.stop(); // no more frames draw the effect
  unsubscribe(); // no more resize callbacks call set()
  vignette.dispose(); // then retire the effect
}
```

After `teardown()`, the canvas surface and everything the effect sampled stay usable; `dispose()` never destroys borrowed targets, textures, buffers, samplers, or shared pipelines. Work already encoded keeps its captured uniform values, managed bundles that recorded the effect throw `VGPU-R3-BUNDLE-STALE` on replay, and a native `GPURenderBundle` read from `bundle.gpu` keeps its last uniform contents. A pending `compile()` settles with its preparation, then rejects with `VGPU-DRAW-DISPOSED`; a live effect or draw sharing that pipeline is unaffected. Neither collection nor `dispose()` promises when GPU memory is reclaimed.

## Notes

- When the source already has vertex entries, the unique entry is used regardless of name; with several entries, `vs_main` is preferred, otherwise the first is used. These preferred names are vgpu conventions, not WGSL requirements.
- A fragment-only effect is internally implemented as a `Draw` with an injected fullscreen triangle. Fragment-only resources receive fragment visibility only, so storage does not consume `maxStorageBuffersInVertexStage`.
- `entry`, `blend`, and `writeMask` are immutable pipeline state, fixed at `effect(gpu)` construction, and apply uniformly to every color target. Use them for overlays, glow, UI, and other loaded-pass compositing. For explicit blends, `op` defaults to `"add"` and omitted `alpha` copies `color`.
- One-shot `effect.draw()` does not join a surrounding frame. Inside `frame(gpu)`, draw through `frame.pass()`.
- There is no implicit screen target. Browser code should create a `Surface` and pass it as `target`.
- A `Surface` is only a destination. To post-process the screen image, render the scene into an offscreen `Target`, bind that target to the post effect, and draw the effect into a surface pass; see `Surface` for the full example. Binding the `Target` follows its attachment after `resize(...)`; binding `sceneTarget.color` keeps that exact texture, so rebind it after a resize.
- Do not rely on implicit uniforms like time or resolution; pass `clock(gpu).time`, `target.size`, or `target.texelSize` explicitly through `set()`.
- JS-owned values pack with the intrinsic `wgsl-host-shareable-v1` layout. Vectors, flattened column-major matrices, and fixed arrays require exact lengths; `i32`/`u32` require integral in-range numbers; padding is zero; and f16 conversion rounds to nearest with ties to even. A first complete binding object supplies every field. Later object updates merge over the last accepted value, while member-name shorthand starts unspecified siblings at WGSL zero. Each candidate is validated into temporary bytes before that binding's retained state or GPU bytes change.
- Raw buffer bindings follow the [`Draw` raw-buffer rules](/reference/vgpu/draw#draw): `set()` recognizes a raw `GPUBuffer` or `{ buffer: GPUBuffer, offset?, size? }` by shape, so a WGSL struct whose members are named `buffer`, `offset`, or `size` still packs as data. Omitted `offset` is `0` and omitted `size` is `buffer.size - offset`; only `undefined` takes a default. `set()` copies the range, so mutating your descriptor later needs another `set()`. The buffer stays yours — vgpu never destroys it, `dispose()` leaves it alone, and its contents are read live rather than captured per frame.
- `set()` binds a `Texture` or `Target` through views that binding normalization generates and may reuse a compatible generated view across effects and rebinds. This is internal and has no controls; `Texture.createView(desc)` still returns a fresh view on every call.
- **See also:** `effect`, `Draw`, `FramePass.draw`, `Surface`, `Target`, `SharedUniforms`.

## Compilation validation and uniform capture

`compile()` waits for native validation even after `compileSync()` created a candidate or took over a pending asynchronous compile. Synchronous creation failures throw; asynchronous validation from synchronous preparation uses `gpu.onError`. A failed pipeline throws on automatic reuse; explicitly compile again to retry.

Direct frame draws capture managed uniform values when encoded, matching compute dispatches. Later `set()` calls do not alter earlier commands. Storage bindings, raw/low-level buffers, claimed bind groups, and render bundles retain their live buffer contents.

Packed-byte equality, pooled frame pages and their bind-group reuse work as described for `Draw` in "Compilation validation and uniform capture". A raw `GPUBuffer` or `{ buffer, offset?, size? }` passed to `effect.set()` for a uniform or storage buffer binding is bound as a live user-owned resource keyed by buffer, effective offset and size; see "Raw buffer bindings" in `Draw`.
