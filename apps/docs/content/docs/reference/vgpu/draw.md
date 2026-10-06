---
title: "Draw"
description: "Target-agnostic renderable shader unit created by `draw(gpu)`. It reflects WGSL bindings, caches pipelines per target format/depth/sample count, and supports geometries, explicit vertex counts, instancing, and raw group claims."
---

## Import

```ts
import type { DepthOptions, Draw, DrawOptions, DrawCallOptions, DrawLayoutOptions, GeometryLike, StencilFaceOptions, StencilOptions } from "vgpu";
```

## Signature

```ts
import type { ShaderSource, StorageBuffer, Target, TargetSignature } from "vgpu";

type SetBag = Record<string, unknown>;

type BlendPreset = "alpha" | "additive" | "premultiplied";
interface BlendComponentOptions { readonly src: GPUBlendFactor; readonly dst: GPUBlendFactor; readonly op?: GPUBlendOperation; }
interface BlendOptions { readonly color: BlendComponentOptions; readonly alpha?: BlendComponentOptions; }

interface DepthOptions {
  readonly write?: boolean;
  readonly compare?: GPUCompareFunction;
  readonly bias?: number;
  readonly biasSlopeScale?: number;
  readonly biasClamp?: number;
}

interface StencilFaceOptions {
  readonly compare?: GPUCompareFunction;
  readonly fail?: GPUStencilOperation;
  readonly depthFail?: GPUStencilOperation;
  readonly pass?: GPUStencilOperation;
}

interface StencilOptions {
  readonly front?: StencilFaceOptions;
  readonly back?: StencilFaceOptions;
  readonly readMask?: number;
  readonly writeMask?: number;
  readonly ref?: number;
}

interface DrawOptions {
  readonly shader: string | ShaderSource;
  readonly geometry?: GeometryLike;
  readonly set?: SetBag;
  readonly label?: string;
  readonly targets?: readonly Target[];
  readonly instances?: number;
  readonly vertices?: number;
  readonly firstInstance?: number;
  readonly blend?: BlendPreset | BlendOptions;
  readonly blendConstant?: readonly [number, number, number, number];
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
  readonly colors?: readonly ({ readonly blend?: BlendPreset | BlendOptions; readonly writeMask?: readonly ("r" | "g" | "b" | "a")[] } | null)[];
  readonly cull?: "none" | "front" | "back";
  readonly frontFace?: "ccw" | "cw";
  readonly unclippedDepth?: boolean;
  readonly depth?: false | DepthOptions;
  readonly stencil?: StencilOptions;
  readonly multisample?: { readonly alphaToCoverage?: boolean; readonly mask?: number };
  readonly constants?: Readonly<Record<string, number | boolean>>;
  readonly entry?: { readonly vertex?: string; readonly fragment?: string };
}

interface DrawCallOptions {
  readonly target?: Target;
  readonly offsets?: readonly number[] | Partial<Record<number, readonly number[]>>;
  readonly instances?: number;
  readonly vertices?: number;
  readonly indices?: number;
  readonly firstVertex?: number;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstInstance?: number;
  readonly indirect?: StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };
}

interface DrawLayoutOptions { readonly dynamicOffsets?: boolean; }

interface GeometryLike {
  readonly vertexCount?: number;
  readonly indexCount?: number;
  readonly instanceCount?: number;
  readonly vertexBuffers?: readonly GPUBuffer[];
  readonly indexBuffer?: GPUBuffer;
  readonly indexFormat?: GPUIndexFormat;
  readonly vertexBufferLayouts?: readonly GPUVertexBufferLayout[];
  readonly topology?: GPUPrimitiveTopology;
  readonly stripIndexFormat?: GPUIndexFormat;
  readonly firstVertex?: number;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
}

interface Draw {
  readonly gpu: GPURenderPipeline | undefined;
  readonly targets: readonly Target[] | undefined;
  dispose(): void;
  set(values: SetBag): this;
  group(n: number, bindGroup: GPUBindGroup): this;
  layout(n: number, opts?: DrawLayoutOptions): GPUBindGroupLayout;
  draw(target?: Target | DrawCallOptions): void;
  compile(target?: Target | TargetSignature): Promise<this>;
  compileSync(target?: Target | TargetSignature): this;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| opts.shader | `string \| ShaderSource` | ✔ | — | WGSL string or loader-produced `ShaderSource`. Must contain compatible vertex/fragment entry points. With no explicit selection, each stage uses its unique entry regardless of name; with multiple entries it prefers `vs_main` / `fs_main`, otherwise its first entry. |
| opts.geometry | `GeometryLike` | ✖ | `undefined` | Supplies vertex/index buffers and layouts. Omit for generated vertex-index drawing. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Initial `.set()` call. |
| opts.label | `string` | ✖ | `"draw"` | Debug/error label. |
| opts.targets | `readonly Target[]` | ✖ | `undefined` | Synchronous pre-warm sugar for the listed target signatures. A live `Surface` is accepted outside a frame; its configured signature is used without acquiring a canvas texture. In browser load paths, prefer `await draw.compile(target)`. |
| opts.instances | `number` | ✖ | `1` | Default instance count. Integer `>= 0`; per-call `instances` overrides. |
| opts.vertices | `number` | ✖ | `3` for non-indexed, unless `geometry.vertexCount` exists | Default non-indexed vertex count. Ignored by indexed geometries. Integer `>= 0`. |
| opts.firstInstance | `number` | ✖ | `0` | Default first instance. Integer `>= 0`; per-call `firstInstance` overrides. |
| opts.blend | `"alpha" \| "additive" \| "premultiplied" \| BlendOptions` | ✖ | `undefined` | Constructor-only blend state applied uniformly to every color target. Presets resolve at construction; explicit components use `src`/`dst` and optional `op` (`"add"` default). Omitted `alpha` copies `color`. |
| opts.blendConstant | `readonly [number, number, number, number]` | ✖ | whatever the pass holds — `(0, 0, 0, 0)` at pass start | Scales `"constant"`/`"one-minus-constant"` blend factors. Use it to fade or crossfade a whole layer per draw without touching per-vertex alpha. Encoder state, not pipeline state (see Notes). Components must be finite; values outside `[0, 1]` are legal. When omitted, no `setBlendConstant` is emitted for this draw, so constant factors read the current pass value: the `(0, 0, 0, 0)` default at the start of the pass, or the value an earlier draw in the same pass set, which persists until the next set. At least one color target's effective blend (`colors[i].blend` when that target has one, else the top-level `blend`) must use a constant factor. |
| opts.writeMask | `readonly ("r" \| "g" \| "b" \| "a")[]` | ✖ | all channels | Constructor-only color channel mask applied uniformly to every color target. Omit to write RGBA; `[]` writes no channels; `["r","g","b"]` skips alpha. |
| opts.colors | `readonly ({ blend?, writeMask? } \| null)[]` | ✖ | `undefined` | Per-attachment blend/writeMask overrides for MRT — the deferred-shading case, where one draw writes a G-buffer (`target(gpu, { colors: [...] })`) and each attachment needs different state. One entry per color attachment, aligned by index. Inheritance is per field: `null` entries and omitted fields fall back to the top-level `blend`/`writeMask`; `{ writeMask: [] }` leaves that attachment untouched. |
| opts.cull | `"none" \| "front" \| "back"` | ✖ | `"none"` | Skips rasterizing triangles that face away from the chosen side. `"back"`: culls faces pointing away from the viewer; on a closed geometry they are never visible, so the GPU skips roughly half the fragment work. `"front"`: culls faces toward the viewer; used when rendering shadow maps to reduce peter panning. When omitted, no triangles are culled — required for open geometry such as foliage cards. |
| opts.frontFace | `"ccw" \| "cw"` | ✖ | `"ccw"` | Winding order that counts as front-facing — the reference `cull` works against. Set `"cw"` for geometry authored clockwise, or for draws with a negative (mirrored) scale, which flips the on-screen winding. When omitted, counter-clockwise triangles are front. |
| opts.unclippedDepth | `boolean` | ✖ | `false` | Disables depth clipping so geometry outside `[near, far]` rasterizes instead of vanishing. Use it for shadow-map pancaking: casters behind the light's near plane flatten onto it instead of being clipped out of the map. Requires the `"depth-clip-control"` device feature. When omitted or `false`, standard clipping applies. |
| opts.depth | `false \| DepthOptions` | ✖ | `{ write: true, compare: "less-equal" }` | Depth test/write state for targets with a depth attachment; fields are in the `DepthOptions` table below. `false` disables depth testing for overlays and gizmos that must draw over the scene regardless of distance. When omitted, nearer fragments win and coplanar re-draws still pass; ignored when the target has no depth. |
| opts.stencil | `StencilOptions` | ✖ | WebGPU pass-through defaults | Masks draws to marked screen regions using the stencil aspect of the depth attachment — portals, mirrors, object outlines, masked UI. Requires a target depth format with a stencil aspect (`depth: "depth24plus-stencil8"`). Fields are in the `StencilOptions` table below. |
| opts.multisample | `{ alphaToCoverage?, mask? }` | ✖ | `{ alphaToCoverage: false, mask: 0xFFFFFFFF }` | MSAA state. `alphaToCoverage`: turns fragment alpha into a per-sample coverage mask, so alpha-tested foliage antialiases in any draw order — no blending, no transparency sorting; requires an `msaa: true` target. `mask`: bitmask of samples the draw may write — a niche debugging tool most draws never set. Only the low `sampleCount` bits matter; higher bits are legal and ignored. |
| opts.constants | `Readonly<Record<string, number \| boolean>>` | ✖ | the WGSL defaults | Values for WGSL `override` constants, fixed at pipeline creation. Use them to specialize one shader — quality tiers, feature toggles, workgroup-size tuning — without string-templating the WGSL. Key by override name, or by the decimal string of `N` when the declaration has `@id(N)` (the name is not usable then). Booleans become `1`/`0`; every override declared without a default must be provided. |
| opts.entry | `{ vertex?: string; fragment?: string }` | ✖ | `vs_main` / `fs_main` when declared, otherwise first in each stage | Selects which `@vertex`/`@fragment` functions to compile when one WGSL module declares several — variants of one technique sharing helpers, such as depth-only and shaded passes from the same source. Names must exist in the shader with the matching stage. Omitted fields select the sole entry of that stage, or prefer its conventional name when several exist, falling back to the first. Explicit names always take priority and must be valid. |
| draw.set.values | `Record<string, unknown>` | ✔ | — | Values keyed by WGSL binding variable name. JS objects/numbers are packed; resources are bound by identity. A raw `GPUBuffer` or `GPUBufferBinding` (`{ buffer, offset?, size? }`) in a uniform/storage slot binds that byte range as a caller-owned resource; omitted `offset` is `0` and omitted `size` is `buffer.size - offset` (see Raw buffers and byte ranges). A `Target` follows its attachment across resizes; a `Texture` stays bound to that exact texture. A `Surface` is rejected in every slot with `VGPU-SURFACE-NOT-BINDABLE`. |
| draw.group.n | `number` | ✔ | — | Bind group index to claim for manual bind-group binding (`group(n, bindGroup)`). |
| draw.group.bindGroup | `GPUBindGroup` | ✔ | — | Must be compatible with `draw.layout(n)` or `draw.layout(n, { dynamicOffsets: true })`. |
| draw.layout.n | `number` | ✔ | — | Reflected bind group index. |
| draw.layout.opts.dynamicOffsets | `boolean` | ✖ | `false` | When `true`, returns/reuses a layout whose buffer entries have `hasDynamicOffset: true` and clears cached pipelines. |
| draw.draw.target | `Target \| DrawCallOptions` | ✖ | `{}` | One-shot draw options. Pass a bare target for the common case, or an options bag when setting counts or offsets. |
| opts.target | `Target` | ✖ | — | Required at runtime when an options bag is used. Use an offscreen `Target`, or a `Surface` while a frame is active; outside a frame a surface throws `VGPU-SURFACE-NOT-IN-FRAME`. |
| opts.offsets | `readonly number[] \| Partial<Record<number, readonly number[]>>` | ✖ | Reflected/claimed fallback offsets | Dynamic offsets for claimed/dynamic groups. Array applies to every group; object keys by group. |
| opts.instances | `number` | ✖ | `DrawOptions.instances ?? geometry.instanceCount ?? 1` | Per-call instance count; integer `>= 0`. |
| opts.vertices | `number` | ✖ | `geometry.vertexCount ?? DrawOptions.vertices ?? 3` | Per-call non-indexed vertex count; indexed geometries use `geometry.indexCount`. |
| opts.firstVertex | `number` | ✖ | `0` | Non-indexed first vertex; indexed geometries use firstIndex/baseVertex `0`. |
| opts.firstInstance | `number` | ✖ | `DrawOptions.firstInstance ?? 0` | Per-call first instance. |
| opts.indirect | `StorageBuffer \| { buffer, offset? }` | ✖ | `undefined` | GPU-driven draw: the GPU reads the draw arguments from the buffer at byte `offset` (default `0`) instead of CPU-side counts. Use it when a culling compute pass decides what to draw — the arguments are written on the GPU and the CPU never round-trips. Create the buffer with `storage(gpu, bytes, { indirect: true })`; argument layouts are in Notes. |
| draw.dispose | `() => void` | ✖ | not called — a draw you stop referencing is collected without it | Takes no arguments. Synchronous and idempotent; valid after `gpu.dispose()` or device loss. Retires the draw: every later member call throws `VGPU-DRAW-DISPOSED`, every managed `Bundle` that recorded it goes stale, and the draw releases its bindings, values, claimed groups, and cached bind groups. Never destroys borrowed resources or shared pipelines. See Disposal below. |

**`DepthOptions`** — the object form of `opts.depth`:

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| write | `boolean` | ✖ | `true` | `false` keeps testing against the depth buffer without writing it. Use it for blended transparents and decals, which must hide behind opaque geometry but not occlude what draws after them. |
| compare | `GPUCompareFunction` | ✖ | `"less-equal"` | Comparison a fragment must pass against the stored depth. `"greater"` plus `clearDepth: 0` on the pass gives reversed-Z, which spreads floating-point precision evenly across the view distance. |
| bias | `number` | ✖ | `0` | Constant offset added to each fragment's depth. Must be an integer (WebGPU `depthBias` is `i32`). A small positive bias while rendering the shadow map removes shadow acne; a small negative bias lets coplanar decals win the depth test instead of z-fighting. |
| biasSlopeScale | `number` | ✖ | `0` | Extra bias proportional to the polygon's depth slope. Surfaces at glancing angles need more offset than facing ones — pair it with `bias` to remove acne on sloped ground. |
| biasClamp | `number` | ✖ | `0` (no clamp) | Upper bound on the total bias. Caps runaway slope-scaled bias on near-edge-on triangles, which otherwise detaches shadows from their casters (peter panning). |

**`StencilOptions`** — the fields of `opts.stencil`:

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| front | `StencilFaceOptions` | ✖ | `{ compare: "always", fail/depthFail/pass: "keep" }` | Test and operations for front-facing triangles; fields are in the `StencilFaceOptions` table below. |
| back | `StencilFaceOptions` | ✖ | mirrors the normalized `front` | Give it explicitly when the two sides must differ — incrementing on front faces and decrementing on back faces to count volume crossings. With `back` given and `front` omitted, the front keeps the WebGPU face defaults. |
| readMask | `number` | ✖ | `0xFFFFFFFF` | Bits of the stored stencil value visible to `compare`. Integer in `[0, 0xFFFFFFFF]`. |
| writeMask | `number` | ✖ | `0xFFFFFFFF` | Bits the face operations may change. Integer in `[0, 0xFFFFFFFF]`. Disjoint masks let several effects share one stencil buffer. |
| ref | `number` | ✖ | pass default `0` | Value `compare` tests against and `"replace"` writes. Integer in `[0, 0xFFFFFFFF]`. Encoder state, not pipeline state (see Notes); an explicit `0` still emits, restoring the pass default after an earlier draw changed it. |

**`StencilFaceOptions`** — the `front` / `back` faces:

| Field | Type | Required | Default | Notes |
|---|---|---:|---|---|
| compare | `GPUCompareFunction` | ✖ | `"always"` | Comparison between the masked `ref` and the masked stored value. `"equal"` draws only inside a previously marked region — the portal or mirror interior. |
| fail | `GPUStencilOperation` | ✖ | `"keep"` | Operation when the stencil comparison fails. |
| depthFail | `GPUStencilOperation` | ✖ | `"keep"` | Operation when the stencil comparison passes but the depth test fails. |
| pass | `GPUStencilOperation` | ✖ | `"keep"` | Operation when both comparisons pass. `"replace"` writes `ref`, marking the region for later draws. |

**Returns:** `draw(gpu)` returns `Draw`; `set()`, `group()`, and `compileSync()` return the same `Draw`; `layout()` returns a `GPUBindGroupLayout`; one-shot `draw()` returns `void`; `compile()` returns `Promise<this>`; `dispose()` returns `void`.

**Throws:** one `VGPU-*` code per condition below. Checks marked † resolve against the target signature at compile/draw time; with `targets: [...]` they surface from `draw(gpu)` itself, because that option compiles at construction.

- `VGPU-LIMIT-STORAGE-VERTEX` / `VGPU-LIMIT-STORAGE-FRAGMENT` — static storage-buffer use by a selected entry point exceeds the granted stage limit. Request the supported `requiredLimits` value, or reduce/move the storage data.
- `VGPU-TARGET-REQUIRED` — `draw.draw()` was called without a target and the draw has none to fall back on. Pass a `Target`, or an options bag with `target`.
- `VGPU-SURFACE-NOT-IN-FRAME` — one-shot `draw.draw()` targets a `Surface` while no frame is active. Encode surface draws inside `frame(gpu, ...)`; `compile(surface)` and `bundle(gpu, { target: surface }, ...)` can prepare outside a frame.
- `VGPU-SURFACE-DISPOSED` — `compile()`, `compileSync()`, or `targets: [...]` received a disposed `Surface`. `compile()` throws synchronously instead of returning a rejected promise. Prepare against a live surface.
- `VGPU-BLEND-INVALID` — unknown blend preset or malformed blend object. Use `"alpha"`, `"additive"`, `"premultiplied"`, or `{ color: { src, dst, op? }, alpha? }`.
- `VGPU-BLEND-CONSTANT-INVALID` — `blendConstant` is not exactly four finite numbers, or no color target's effective blend uses a `"constant"`/`"one-minus-constant"` factor (the value could never apply). The effective blend of a target is its `colors[i].blend` when it has one, else the top-level `blend` — so a top-level constant factor overridden on *every* target is still dead, while a constant factor reached only through `colors[i].blend` is live. Fix the tuple, or add a constant factor to a blend that survives the per-target overrides.
- `VGPU-WRITEMASK-INVALID` — `writeMask` is not an array, or contains a channel outside `"r"`/`"g"`/`"b"`/`"a"`.
- `VGPU-COLORS-INVALID` — `colors` is not an array; an entry is neither `null` nor `{ blend?, writeMask? }`; or † its length differs from the target's color attachment count (both counts are in the message). Give one entry per attachment.
- `VGPU-CULL-INVALID` — `cull` is outside `"none"`/`"front"`/`"back"`.
- `VGPU-FRONTFACE-INVALID` — `frontFace` is outside `"ccw"`/`"cw"`.
- `VGPU-UNCLIPPED-DEPTH-INVALID` — `unclippedDepth` is not a boolean, or is `true` on a device whose `features` lacks `"depth-clip-control"`. Request the feature with `init({ requiredFeatures: ["depth-clip-control"] })` on an adapter that supports it.
- `VGPU-DEPTH-INVALID` — non-boolean `write`; unknown `compare`; non-integer `bias`; non-finite bias values; a nonzero bias value with a `line-*`/`point-*` topology (depth bias is only defined for triangles); or a nonzero `biasClamp` on a compatibility-mode device. Zero the offending field.
- `VGPU-STENCIL-INVALID` — malformed `stencil` (non-object value, malformed `front`/`back` face, unknown `compare` or `fail`/`depthFail`/`pass` operation, or `readMask`/`writeMask`/`ref` outside integer `[0, 0xFFFFFFFF]`); or † any stencil state against a depth format without a stencil aspect. Create the target with `depth: "depth24plus-stencil8"`.
- `VGPU-MULTISAMPLE-INVALID` — malformed `multisample` (non-object value, non-boolean `alphaToCoverage`, or a `mask` outside integer `[0, 0xFFFFFFFF]`); or † `alphaToCoverage: true` against a non-MSAA signature. Create the target with `msaa: true`.
- `VGPU-CONSTANTS-INVALID` — non-object `constants`; a key that matches no override in the shader (the message lists the available ones); a value that is neither a finite number nor a boolean; or an override declared without a default that `constants` does not provide. Add `constants: { "<nameOrId>": value }`.
- `VGPU-ENTRY-INVALID` — non-object `entry` or a non-string `vertex`/`fragment` field; a name that matches no entry point; or a name whose entry point has the wrong stage. The message lists the shader's entry points with their stages.
- `VGPU-R1-DRAW-COUNT` — a count field is not an integer `>= 0`. Use `0` only for a deliberate no-op draw.
- `VGPU-INDIRECT-INVALID` — at call time: `indirect` is neither a `StorageBuffer` nor `{ buffer, offset? }`; the buffer was created without the indirect flag (use `storage(gpu, bytes, { indirect: true })`); `offset` is not a non-negative integer multiple of 4; the arguments overrun the buffer (the message shows the byte math); or `indirect` is combined with `vertices`/`indices`/`instances`/`firstVertex`/`firstIndex`/`baseVertex`/`firstInstance` — the GPU reads those from the buffer, so drop the CPU-side value.
- `VGPU-R1-BINDING-NEVER-SET` — a reflected binding was never provided before drawing. `set()` the named binding, or claim its group with `group(n, bindGroup)`.
- `VGPU-R1-OWNERSHIP-FLIP` — a binding switched between JS-value ownership and resource ownership across `set()` calls. Keep passing the kind its first `set()` used.
- `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` — a `set()` value does not satisfy the binding; `where` is `set`, and the message names the binding, its group and binding number, and what it needs. Tracked `Buffer`, Uniform-like, and provider bindings keep their synchronous native-usage validation and now also get checkable range validation at `set()`; previously native-only reflected-minimum, granted-maximum, and storage-size failures are synchronous. For a raw `GPUBuffer`/`GPUBufferBinding` this covers every range fact vgpu can check: a missing `uniform`/`storage` usage; an `offset` or `size` that is not a non-negative safe integer (`null` and numeric strings are rejected; only `undefined` takes the default); a zero `size`, including the default when `offset` equals `buffer.size`; a range past the end of the buffer; an `offset` that is not a multiple of `gpu.gpu.limits.minUniformBufferOffsetAlignment` (uniform) or `minStorageBufferOffsetAlignment` (storage); a range smaller than the WGSL type needs; a range larger than `maxUniformBufferBindingSize`/`maxStorageBufferBindingSize`; or a storage `size` that is not a multiple of 4. Raw-range `fix` names the required usage and a valid aligned offset/size; a tracked usage failure retains vgpu's `usage: ['uniform'|'storage','copy_dst']` vocabulary. The candidate is rejected before it replaces the binding's previous value.
- `VGPU-R1-BINDING-DESTROYED` — `set()` received an already-destroyed tracked resource (a `Buffer`, `Uniform`, `uniforms()` block, `Texture`, or `Target`), or an active binding's tracked resource was destroyed before the draw used it. `where` is `<label>.<binding>`; detail names the binding and resource. Bind a live replacement with `set()` and re-record bundles that captured the old resource. Direct operations on a destroyed `Buffer` itself, such as `write()` or `read()`, still report `VGPU-BUFFER-DISPOSED`; only the binding boundary uses this code. Raw `GPUBuffer` values are not tracked, so a destroyed raw buffer is reported by native WebGPU validation instead.
- `VGPU-SURFACE-NOT-BINDABLE` — a `Surface` was passed as a binding value, in `opts.set` or a later `set()`, inside or outside a frame. `where` is `<label>.<binding>`. vgpu throws before reading the surface's `color`/`colors`/`depth` or acquiring a canvas texture, and the rejected binding keeps its previous value. `set()` applies keys in order, so keys before the rejected one in the same call are already applied. Render to an offscreen target and bind that target or its texture; use the `Surface` only as a render destination.
- `VGPU-SET-VALUE-INVALID` — a JS-owned buffer binding has a missing or unknown struct member, the wrong vector/matrix/array extent, an out-of-range integer, or an invalid runtime-array extent. Structured detail identifies the complete value path and reason. The rejected value does not change that binding's retained host state or packed GPU bytes.
- `VGPU-SET-TEXTURE-FILTERABILITY` — a facade texture format cannot satisfy an ordinarily sampled `float` binding (detail identifies the format, texture, and paired sampler). Use a filterable format, request `float32-filterable`, or rewrite to `textureLoad`.
- `VGPU-R4-GROUP-CLAIMED` — `set()` tried to update a claimed group. Call `set()` before claiming, or keep updating the group yourself from `draw.layout(n)`.
- `VGPU-R4-GROUP-INCOMPATIBLE` — a claimed bind group does not match the draw's layout. Build it from `draw.layout(n, { dynamicOffsets? })` before calling `group(n, bindGroup)`.
- `VGPU-R4-GROUP-VALIDATION` — WebGPU rejected a claimed group at draw time; delivered asynchronously through `gpu.onError`. Build the group from `draw.layout(n)` and pass offsets via the draw call.
- `VGPU-SHADER-SOURCE-INVALID` — malformed `ShaderSource`. Pass WGSL text or a loader-produced `{ version, wgsl }` object.
- `VGPU-DRAW-DISPOSED` — any member other than `dispose()` was used after `dispose()`: `set()`, `group()`, `layout()`, one-shot `draw()`, `compile()`, `compileSync()`, the `gpu` and `targets` getters, `currentFrame.pass(target, draw)`, `FramePass.draw(drawable)`, or `BundleRecorder.draw(drawable)`. The message is `Draw '<label>' has been disposed.`, `where` is `<label>.<operation>`, and `detail` is `{ label }`. The check runs before this draw's argument, target, binding, and device checks, so a disposed draw always reports this code; frame and pass errors, such as using an ended pass, keep their own precedence. `compile()` throws synchronously when the draw is already disposed, and a `compile()` still pending at `dispose()` rejects with this code once its preparation settles. Create a new `draw(gpu, ...)`; a disposed draw cannot be reused.

## Examples

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [64, 64] });
const tri = draw(gpu, {
  label: "tri",
  targets: [colorTarget],
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }
  `,
});

tri.draw({ target: colorTarget, vertices: 3, instances: 1 });
```

Backface culling for a closed imported geometry:

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const scene = target(gpu, { size: [256, 256], depth: true });
const statue = { vertexCount: 36 }; // closed geometry; vertex data omitted for brevity
const opaque = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi % 3u], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.8, 0.8, 0.7, 1); }
  `,
  geometry: statue,
  cull: "back",    // closed geometry: faces pointing away are never visible
  frontFace: "cw", // the importer produced clockwise triangles
});
opaque.draw(scene);
```

Culling back faces skips roughly half the fragment work on the closed statue, and `frontFace: "cw"` keeps the imported clockwise winding — or a negative-scale mirror — counting as front-facing.

Shadow map with depth bias and pancaking:

```ts
import { init, createMockAdapter, draw, target } from "vgpu/mock";

const gpu = await init({
  adapter: createMockAdapter({ features: ["depth-clip-control"] }),
  requiredFeatures: ["depth-clip-control"],
});
const shadowMap = target(gpu, { size: [1024, 1024], depth: true });
const casters = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0); }
  `,
  // Nudge stored depth away from the light to stop shadow acne.
  depth: { bias: 2, biasSlopeScale: 2 },
  // Pancake casters behind the light's near plane instead of clipping them away.
  unclippedDepth: true,
});
casters.draw(shadowMap);
```

The bias pair keeps lit surfaces acne-free, and `unclippedDepth` flattens casters between the light and its near plane onto the map instead of losing their shadows.

MRT decal into a G-buffer:

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
// Deferred-shading G-buffer: albedo + world-space normals.
const gbuffer = target(gpu, {
  size: [512, 512],
  colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }],
  depth: true,
});
const decal = draw(gpu, {
  shader: `
    struct Frag { @location(0) albedo: vec4f, @location(1) normal: vec4f }
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> Frag { return Frag(vec4f(0.6, 0.1, 0.1, 0.8), vec4f(0, 1, 0, 0)); }
  `,
  colors: [
    { blend: "alpha" },   // blend the decal into the albedo
    { writeMask: [] },    // leave the normals untouched
  ],
  depth: { write: false }, // the decal sits on existing geometry
});
decal.draw(gbuffer);
```

One draw blends the decal into `gbuffer.colors[0]` while `{ writeMask: [] }` leaves the normals exactly as the opaque pass wrote them — the fragment still outputs `@location(1)`, the mask only blocks the write.

Alpha-tested foliage without transparency sorting:

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const scene = target(gpu, { size: [256, 256], depth: true, msaa: true });
const foliage = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    // In a real scene, alpha comes from the leaf texture.
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.1, 0.5, 0.1, 0.4); }
  `,
  multisample: { alphaToCoverage: true },
});
foliage.draw(scene);
```

Fragment alpha becomes per-sample coverage, so leaf edges antialias in any draw order — no blending, no transparency sorting.

Stencil-masked portal:

```ts
import { init, draw, frame, target } from "vgpu/mock";

const gpu = await init();
const scene = target(gpu, { size: [256, 256], depth: "depth24plus-stencil8" });
const SHADER = `
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0.2, 0.2, 1, 1); }
`;
// Mark the portal's pixels with stencil value 1; write no color, no depth.
const portalMask = draw(gpu, { shader: SHADER, writeMask: [], depth: false, stencil: { front: { pass: "replace" }, ref: 1 } });
// Draw the far world only where the mask matches.
const otherWorld = draw(gpu, { shader: SHADER, stencil: { front: { compare: "equal" }, ref: 1 } });

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: scene }, (pass) => {
    pass.draw(portalMask);
    pass.draw(otherWorld);
  });
});
```

The first draw marks the portal region in the stencil buffer; the second renders only where the stored value equals `ref`, inside one pass so the mask survives.

Per-draw layer fade with the blend constant:

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [128, 128] });
const overlay = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0.5, 0, 1); }
  `,
  // Weight the whole layer by the blend constant, not per-vertex alpha.
  blend: { color: { src: "constant", dst: "one-minus-constant" } },
  blendConstant: [0.25, 0.25, 0.25, 0.25], // the layer shows at 25%
});
overlay.draw(colorTarget);
```

The whole overlay fades with one per-draw value — no per-vertex alpha rewrite, and no extra pipeline, because the constant is encoder state.

Pipeline specialization with `constants` and `entry`:

```ts
import { init, draw, target } from "vgpu/mock";

const gpu = await init();
const colorTarget = target(gpu, { size: [128, 128] });
// One module, two fragment variants sharing the vertex stage and helpers.
const SOURCE = `
  override STEPS: u32 = 8;
  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_shaded() -> @location(0) vec4f { return vec4f(f32(STEPS) / 64.0, 0, 0, 1); }
  @fragment fn fs_flat() -> @location(0) vec4f { return vec4f(0.5, 0.5, 0.5, 1); }
`;
const hero = draw(gpu, { shader: SOURCE, constants: { STEPS: 64 } });        // high quality tier
const backdrop = draw(gpu, { shader: SOURCE, entry: { fragment: "fs_flat" } }); // cheap variant

hero.draw(colorTarget);
backdrop.draw(colorTarget);
```

Both draws compile from the same module: `constants` specializes the shaded variant at pipeline creation instead of string-templating WGSL, and `entry` picks the flat fragment for the backdrop.

GPU-driven draw with `indirect`:

```ts
import { init, compute, draw, storage, target } from "vgpu/mock";

const gpu = await init();
const scene = target(gpu, { size: [256, 256], depth: true });
// drawIndirect arguments: vertexCount, instanceCount, firstVertex, firstInstance.
const args = storage(gpu, 16, { indirect: true });
const cullPass = compute(gpu, `
  @group(0) @binding(0) var<storage, read_write> args: array<u32, 4>;
  @compute @workgroup_size(1) fn cs_main() {
    args = array<u32, 4>(3u, 1u, 0u, 0u); // survivors of the culling test
  }
`);
cullPass.set({ args });
const grass = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(0, 0.6, 0, 1); }
  `,
});
cullPass.dispatch(1);                          // the GPU decides the counts
grass.draw({ target: scene, indirect: args }); // the CPU never reads them back
```

The compute pass writes the draw arguments and the draw consumes them on the GPU — the culling result never round-trips through the CPU.

## Pipeline pre-warm

`draw.compile(target)` asynchronously prepares one target signature and resolves to the same draw. `draw.compileSync(target)` prepares the same signature synchronously; if an async compile for that signature is still pending, the synchronous result wins the race and unblocks later draws. Both methods also accept a target signature object such as `{ colors: ["bgra8unorm"], depth: "depth24plus", sampleCount: 4 }`; `colors` is required and bare strings are rejected.

Pass a live `Surface` to prepare for a canvas during loading. Preparation reads the surface's configured signature — `format`, resolved depth format, and sample count — and does not acquire the canvas texture, resize the canvas, or submit work, so it runs outside any frame:

```ts
import { init, draw, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);

// ---cut---
const tri = draw(gpu, {
  shader: `
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.0, 0.5));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(1, 0.4, 0.2, 1); }
  `,
});
await tri.compile(canvasSurface); // outside a frame: no canvas texture is acquired

frameLoop(gpu, (currentFrame) => {
  currentFrame.pass(canvasSurface, (pass) => pass.draw(tri)); // rendering stays inside the frame
});
```

The default surface shown above and the equivalent signature `{ colors: [canvasSurface.format] }` share one cached pipeline, and a size-only resize keeps it valid. A surface with `depth` or `msaa` needs the matching `depth` and `sampleCount` in that signature. Prefer `compile(surface)` once the surface exists; use the explicit signature for preparation before it does.

Each color/depth/sample-count variant is a different pipeline. A missed variant sync-compiles on first use, which can jank; fire-and-forget pre-warms should always use `.catch(...)` or `gpu.onError`/`gpu.settled()` will not observe the returned promise rejection. `targets: [target]` is kept as creation-time `compileSync()` sugar for non-browser hot paths.

## Disposal

`dispose()` is optional. A draw you stop referencing is collected eventually, like any JavaScript object, and its bundles keep replaying. Call `dispose()` when you want to retire a draw at a known point: it stops every later call, stales the managed bundles that recorded it, and releases the draw's bindings, values, claimed groups, and cached bind groups synchronously. It is idempotent and needs no live device, so it is safe to call after `gpu.dispose()` or device loss.

```ts
import { init, draw, frame, target } from "vgpu/mock";

const gpu = await init();
const sceneTarget = target(gpu, { size: [64, 64] });

// ---cut---
const marker = draw(gpu, {
  label: "marker",
  shader: `
    struct Params { tint: vec4f }
    @group(0) @binding(0) var<uniform> params: Params;
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[vi], 0, 1);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return params.tint; }
  `,
  set: { params: { tint: [1, 0, 0, 1] } },
});

const pending = frame(gpu); // manual frame: nothing submits until submit()
pending.pass(sceneTarget, (pass) => pass.draw(marker)); // captures the red tint now
marker.dispose(); // retire the draw before the frame submits
pending.submit(); // still draws red: encoded work keeps its captured values
await pending.done;

marker.dispose(); // no-op: dispose() is idempotent
// marker.set(...), marker.draw(...), and marker.gpu now throw VGPU-DRAW-DISPOSED
```

Disposal retires the facade, not the work it already handed to WebGPU. A frame pass that drew the draw before `dispose()` still submits with the uniform values captured when it was encoded, and canceling that frame still discards it.

What disposal releases and what it leaves alone:

- **Borrowed resources stay yours.** Textures, buffers, targets, geometry, `uniforms()` blocks, samplers, and bind groups passed to `group(n, bindGroup)` are never destroyed. Pipelines, shader modules, and layouts live in device-wide stores, so another draw built from the same shader keeps using its compiled pipeline.
- **Managed bundles go stale.** `FramePass.bundles()` throws `VGPU-R3-BUNDLE-STALE` with `Bundle '<id>' is stale: draw '<label>' was disposed. Create a new draw/effect and re-record the bundle.` for every bundle that recorded the draw, including a bundle still recording when `dispose()` runs. Dropping the draw without disposing it does not stale its bundles.
- **Native handles keep their own lifetime.** A `GPURenderBundle` read from `bundle.gpu` keeps replaying the last uniform contents the draw wrote; `set()` updates stop because `set()` now throws. vgpu cannot revoke that handle or revalidate already encoded commands.
- **Memory is not reclaimed on a schedule.** A private uniform buffer that native work might still reference is released by reference rather than destroyed, so its memory returns when native WebGPU drops it. Neither collection nor `dispose()` promises when the GPU or driver frees memory.

A `compile()` still pending when you call `dispose()` is not canceled. It settles with its underlying preparation, then rejects with `VGPU-DRAW-DISPOSED` at `<label>.compile`, whether native compilation succeeded or failed. The shared pipeline is not poisoned: another live draw compiling the same shader and signature resolves normally and keeps the pipeline. The disposed draw's rejection belongs to its promise only — it is not delivered again through `gpu.onError`, so handle it with `.catch(...)` like any compile.

## Raw buffers and byte ranges

Bind a raw `GPUBuffer` you created on `gpu.gpu` (the shared `GPUDevice`) when you manage its memory yourself — one allocation holding several uniform blocks, or a buffer another library owns. `set()` recognizes a raw buffer or a `GPUBufferBinding` (`{ buffer, offset?, size? }`) in a reflected uniform/storage slot by its shape, before it considers packing the value, so an ordinary WGSL struct with members named `buffer`, `offset`, or `size` still packs as data:

```ts
import { init, draw, frame, target } from "vgpu/mock";

const gpu = await init();
const sceneTarget = target(gpu, { size: [64, 64] });

// ---cut---
const UNIFORM = 0x40; // GPUBufferUsage.UNIFORM — WebGPU fixes the flag values; Node has no global
const COPY_DST = 0x08; // GPUBufferUsage.COPY_DST
const TINT_BYTES = 16; // struct Tint { color: vec4f }
const alignment = gpu.gpu.limits.minUniformBufferOffsetAlignment; // the granted limit — never assume 256
const coolOffset = Math.ceil(TINT_BYTES / alignment) * alignment; // first aligned offset after the warm tint

const palette = gpu.gpu.createBuffer({ label: "palette", size: coolOffset + TINT_BYTES, usage: UNIFORM | COPY_DST });
gpu.gpu.queue.writeBuffer(palette, 0, new Float32Array([1, 0.4, 0.2, 1])); // warm tint
gpu.gpu.queue.writeBuffer(palette, coolOffset, new Float32Array([0.2, 0.5, 1, 1])); // cool tint

const stripeShader = `
  struct Tint { color: vec4f }
  struct Stripe { offset: f32, size: f32, buffer: f32 } // plain data that shares member names with a buffer binding
  @group(0) @binding(0) var<uniform> tint: Tint;
  @group(0) @binding(1) var<uniform> stripe: Stripe;

  @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
    return vec4f(p[vi], 0, 1);
  }
  @fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
    let gap = abs(position.y - stripe.offset);
    let coverage = 1.0 - smoothstep(stripe.size, stripe.size + stripe.buffer, gap);
    return vec4f(tint.color.rgb, coverage);
  }
`;

const coolRange: GPUBufferBinding = { buffer: palette, offset: coolOffset }; // size defaults to the remaining 16 bytes
const warmStripe = draw(gpu, {
  label: "warm-stripe",
  shader: stripeShader,
  blend: "alpha",
  set: {
    tint: { buffer: palette, size: TINT_BYTES }, // raw range; offset defaults to 0
    stripe: { offset: 20, size: 6, buffer: 4 }, // numbers, so this packs like any struct
  },
});
const coolStripe = draw(gpu, {
  label: "cool-stripe",
  shader: stripeShader,
  blend: "alpha",
  set: { tint: coolRange, stripe: { offset: 44, size: 6, buffer: 4 } },
});

coolRange.offset = 0; // no effect: set() copied { buffer, offset, size } when it ran

const rendered = frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: sceneTarget, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(warmStripe); // reads palette bytes [0, 16)
    pass.draw(coolStripe); // reads palette bytes [coolOffset, coolOffset + 16)
  });
});
await rendered.done;
palette.destroy(); // the raw buffer is yours: vgpu never destroys it
```

Both draws read one allocation through different aligned ranges, while `stripe` packs as an ordinary uniform because its `buffer` member is a number, not a buffer. Mutating `coolRange` after `set()` changes nothing; call `coolStripe.set({ tint: { buffer: palette, offset: 0, size: TINT_BYTES } })` to bind a different range.

The rules for raw buffer bindings:

- **Defaults apply only to `undefined`.** An omitted `offset` is `0`; an omitted `size` is `buffer.size - offset`. A bare `GPUBuffer` binds the whole buffer. `null` or a numeric string is rejected, not defaulted.
- **Equivalent spellings are one binding.** `buffer`, `{ buffer }`, `{ buffer, offset: 0 }`, and `{ buffer, offset: 0, size: buffer.size }` normalize to the same `{ buffer, offset, size }` and share one bind group. Another offset or size creates a new bind group, and a `Bundle` recorded with the old range throws `VGPU-R3-BUNDLE-STALE` until you re-record it.
- **The range is snapshotted on `set()`.** vgpu stores its own `{ buffer, offset, size }` copy, so mutating your descriptor object has no effect until you pass it to `set()` again.
- **Ranges are checked at `set()`.** Usage, bounds, offset alignment against the granted `gpu.gpu.limits`, the WGSL type's minimum size, the granted maximum binding size, and the storage multiple-of-4 rule throw `VGPU-R1-BINDING-INCOMPATIBLE-RESOURCE` with a fix (see **Throws**). A rejected range leaves the binding's previous value in place.
- **The buffer stays caller-managed.** vgpu neither tracks nor destroys a raw buffer, and `dispose()` leaves it alone. Only what vgpu cannot see is left to native WebGPU validation when the work runs: a destroyed or mapped buffer, or one created on another device.
- **Contents are live.** vgpu never packs, captures, or uploads a raw range, unlike managed uniform values captured per frame: work reads whatever the buffer holds when the GPU executes it, so `queue.writeBuffer` updates reach later submissions and saved bundles.
- **Ownership follows the first `set()`.** A raw buffer or range is resource ownership; switching that binding to a JS value later throws `VGPU-R1-OWNERSHIP-FLIP`, and the reverse does too.

## Notes

- Choose blend by use case: omit it for opaque geometry; use `"alpha"`/`"premultiplied"` for ordinary composition and `"additive"` for glow. Reserve explicit equations for special effects. `blendConstant` is persistent pass state (not pipeline state and not bundle state), so set it when fading or crossfading a layer.
- For MRT, use `colors[i]` to inherit or override blend/write masks per attachment. Use `cull: "back"` on closed geometries, `"none"` on foliage/cards, and `"front"` for shadow passes; pair negative scales with `frontFace: "cw"`. Disable depth for overlays and depth writes for transparent/decals. Stencil needs a depth-stencil target; `multisample.alphaToCoverage` is for alpha-tested foliage with MSAA, not general blending.
- Use indirect draws when compute produces arguments in storage buffers marked `{ indirect: true }`; this avoids CPU readback and keeps culling GPU-driven.
- Count precedence is per-call option, then draw option, then geometry/default. `instances: 0` and `vertices: 0` are valid no-op draws.
- Blend, write masks, `colors`, `cull`, `frontFace`, `unclippedDepth`, `depth`, `stencil` (all but `ref`), `multisample`, `constants`, and `entry` are immutable pipeline state, fixed at `draw(gpu)`; draws that differ in any of them compile distinct pipelines. Absent options and their explicit no-op spellings — `unclippedDepth: false`, `multisample: {}`, `constants: {}`, an all-defaults `stencil`, `entry` naming the same functions selected by default — keep byte-identical descriptors and cache keys.
- WebGPU mapping: `cull`/`frontFace`/`unclippedDepth` → `GPUPrimitiveState`; `depth` → `GPUDepthStencilState` (`write` → `depthWriteEnabled`, `compare` → `depthCompare`, the bias family → `depthBias`/`depthBiasSlopeScale`/`depthBiasClamp`); `stencil` → its stencil members (`fail` → `failOp`, `depthFail` → `depthFailOp`, `pass` → `passOp`); `multisample` → `GPUMultisampleState`, with the sample `count` always taken from the target's `sampleCount`; `constants` → `GPUProgrammableStage.constants` on both stages.
- `depth: false` compiles `{ depthWriteEnabled: false, depthCompare: "always" }` because WebGPU cannot omit depth state when the pass has a depth attachment. `stencil` merges into the same depth-stencil state; stencil without a `depth` option keeps the depth defaults.
- `unclippedDepth` disables clipping only; fragment depth is still clamped to the viewport `[minDepth, maxDepth]` range at output.
- With `alphaToCoverage` on, WebGPU additionally requires the first color target to be blendable with an alpha channel and forbids a fragment `sample_mask` output; native validation reports those.
- WebGPU matches `constants` keys against the module's override declarations, not per entry point, so one record serves both stages even when an override is referenced by only one of them.
- `entry` selection happens at construction: binding visibility, bind group layouts, vertex input layouts (the selected vertex entry's inputs drive geometry attribute matching), and storage-stage limit checks all reflect the chosen variant. Unused declarations keep visibility `0` in reflected layouts, so build claimed bind groups from `draw.layout(n)` rather than guessing a raw layout.
- `blendConstant` and `stencil.ref` are encoder state: emitted as `setBlendConstant`/`setStencilReference` after `setPipeline` and before the draw, so draws that differ only in them share pipelines. Both are *pass* state and persist: a value set by one draw stays in effect for every later draw in the same pass that does not set its own. The `(0, 0, 0, 0)` blend-constant default therefore only holds until the first draw in the pass sets one — pass `blendConstant` explicitly on any draw in a pass that must not inherit a previous draw's value (`stencil.ref` behaves the same, and an explicit `0` re-emits). Render bundle encoders cannot set render-pass state, so `bundle()` rejects such draws with `VGPU-BUNDLE-BLEND-CONSTANT`/`VGPU-BUNDLE-STENCIL-REF`; encode them in a frame pass instead.
- Blend presets: `"alpha"` uses source alpha over, `"premultiplied"` uses premultiplied source over, and `"additive"` uses one-plus-one additive blending for color and alpha. In explicit blends, `op` defaults to `"add"` and omitted `alpha` copies `color`.
- `indirect` argument layouts: a non-indexed geometry (or no geometry) encodes `drawIndirect` — 4 u32 values, `vertexCount, instanceCount, firstVertex, firstInstance` (16 bytes); an indexed geometry still sets its index buffer and encodes `drawIndexedIndirect` — 5 32-bit values, `indexCount, instanceCount, firstIndex, baseVertex (signed), firstInstance` (20 bytes). Write them from a compute shader (bind the same buffer as storage) or from JS via `write()`. Indirect draws record fine into `bundle()`: `drawIndirect`/`drawIndexedIndirect` exist on render bundle encoders.
- A non-zero `firstInstance` inside the buffered indirect arguments silently turns the draw into a no-op unless the device has the `"indirect-first-instance"` feature. The value lives on the GPU, so vgpu cannot validate it — request the feature with `init({ requiredFeatures: ["indirect-first-instance"] })` when you need it.
- One-shot `draw.draw()` has no implicit target and returns `void`; raw claimed-group validation errors are delivered through `gpu.onError`, and tests can `await gpu.settled()`.
- `set()` binds a `Texture` or `Target` through views that binding normalization generates — the default view, a depth-only view for depth-stencil formats — and may reuse a compatible generated view across draws and rebinds. This is internal and has no controls. `Texture.createView(desc)` still returns a fresh view on every call.
- Changing resource identity after a draw is recorded in a `Bundle` marks that bundle stale; changing JS values in-place does not. `dispose()` marks every bundle that recorded the draw stale too; letting the draw be collected does not.
- Do not dispose a draw whose bundles you still replay through `FramePass.bundles()`. Create the replacement draw, record its bundle, swap your references, then dispose the old draw and bundle.
- Bind an offscreen `Target` (`set({ source: sceneTarget })`) when the draw should follow its attachment: after `sceneTarget.resize(...)`, the binding switches to the replacement texture. Bind a `Texture` (`set({ source: sceneTarget.color })`) to keep that exact texture and its lifetime; it does not follow resize, so rebind the replacement after `sceneTarget.resize(...)` — the released attachment fails at draw time. Do not bind a `Surface` — render into a `Target` and present it with a surface pass; see `Surface` for the full producer → present example.
- **See also:** `Effect`, `Compute`, `FramePass.draw`, `Bundle`, `Surface`, `Target`, `SharedUniforms`.

## Compilation validation and uniform capture

`compile()` waits for native validation even after `compileSync()` created a candidate or took over a pending asynchronous compile. Synchronous creation failures throw; asynchronous validation from synchronous preparation uses `gpu.onError`. A failed pipeline throws on automatic reuse; explicitly compile again to retry.

Direct frame draws capture managed uniform values when encoded, matching compute dispatches. Later `set()` calls — and `dispose()` — do not alter earlier commands. Storage bindings, raw/low-level buffers, claimed bind groups, and render bundles retain their live buffer contents.

Managed uniforms are JS values on a `var<uniform>` binding and `uniforms(gpu)` objects adopted as uniform. `set()` validates, packs and stores the CPU value on every call. Frame-only values upload through captured frame pages; one-shot draws upload pending values when used. When the packed bytes equal the previous ones (bitwise: an in-place typed-array change is detected, `+0` and `-0` differ), the update is not a new revision: later commands in the same frame reuse its snapshot, and a pending upload stays pending. You never need to compare values yourself; skipping a redundant `set()` saves only CPU work. Storage bindings and live uniforms (recorded into a bundle, or exposed through `.buffer`/`.gpu`) still write on every `set()`.

Captures live in pooled uniform pages. A page belongs to one frame until its GPU work completes or the frame is canceled, so frames in flight never share pages. Bind groups follow the physical page range, so frames that repeat the same draws in the same order reuse them; reordering or culling draws can create some again. Idle retention is bounded and `gpu.dispose()` frees the pages. Each frame still uploads its own captured pages.
