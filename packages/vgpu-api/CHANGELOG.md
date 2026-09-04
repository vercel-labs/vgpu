# vgpu

## 0.4.0

### Minor Changes

- 2d137a4: `frame(gpu, cb)` and `frameLoop(gpu, cb)` now cancel the frame when the callback throws instead of submitting whatever was encoded. A callback that returns still submits once; a callback that throws submits no command buffer, releases the timer/visibility retains its passes took, and rethrows the original error unchanged. A callback that already called `frame.submit()` keeps that submit (the error is rethrown without a cancel attempt), and one that already called `frame.cancel()` stays canceled. The guarantee covers only the frame's command buffer: the clock tick, CPU-side mutations and independent submissions are not rolled back. Manual `frame(gpu)` is unchanged.

  A `frameLoop` tick that throws now also stops the loop properly — the handle is released from the gpu as if `stop()` had been called — instead of leaving a loop that never ticks again registered until `gpu.dispose()`.

  BREAKING CHANGE (pre-1.0): code that relied on a throwing callback still presenting its partial frame must now submit explicitly before rethrowing:

  ```ts
  frame(gpu, (currentFrame) => {
    try {
      encode(currentFrame);
    } catch (error) {
      currentFrame.submit();
      throw error;
    }
  });
  ```

- 8b2282c: Add the `vgpu/three` adapter for calling resolved WGSL function exports from three.js TSL, including a sound curried selector with positional export names, manually typed input contracts, identifier-minified shader support, a type-only `TslExportsErrorCode` union, and early rejection of global WGSL directives that Three cannot place correctly.

  Expose authored function-export metadata from the WGSL resolver and bundler loaders so integrations can address direct `export fn` declarations after mangling and minification. Add the `isShaderFunctionExport()` type guard to `@vgpu/wgsl`, with a convenience re-export from `vgpu`, for validating unknown metadata at integration boundaries.

  Treat WGSL comments as trivia around stage and resource-binding attributes so declaration DCE, emitted identifiers, and reflection metadata stay aligned.

  Use the entry source supplied by Vite and webpack during imported-graph resolution, preserving upstream transforms and virtual entries while resolving dependencies from their normal locations.

### Patch Changes

- Updated dependencies [8b2282c]
  - @vgpu/wgsl@0.4.0
  - @vgpu/core@0.4.0
  - @vgpu/adapter-mock@0.4.0
  - @vgpu/adapter-node@0.4.0
  - @vgpu/wgsl-std@0.4.0

## 0.3.1

### Patch Changes

- 0b9b564: Expose the existing documentation and verified examples workflows as two MCP tools. Add a local
  `vgpu mcp` stdio server with opt-in, output-directory-confined example downloads and publish a
  read-only Streamable HTTP endpoint at `https://vgpu.sh/api/mcp` using the stateless modern MCP
  transport.
- f4b4b27: Make online `vgpu examples` commands work on macOS and Windows. `search`, `show`, and `cat` now
  use an in-memory cache when Linux's descriptor-anchored persistent cache is unavailable. On macOS,
  `pull` uses a portable symlink-checked staging path and preserves atomic publication and recovery.
  Linux keeps its persistent offline cache and `/proc/self/fd` hardening unchanged.
- Updated dependencies [e2b4c4a]
  - @vgpu/wgsl@0.3.1
  - @vgpu/core@0.3.1
  - @vgpu/adapter-mock@0.3.1
  - @vgpu/adapter-node@0.3.1
  - @vgpu/wgsl-std@0.3.1

## 0.3.0

### Minor Changes

- 1451232: `EntryPointInfo` (`bindings`, `samplingPairs`, `inputs`) is now plain data: every field is an ordinary enumerable, own property. `JSON.stringify`, `{ ...entry }`, `Object.keys/entries/assign`, `structuredClone`, and worker `postMessage` all see the full shape — previously `bindings`, `samplingPairs` and `inputs` were non-enumerable, so they were readable through dot access but silently dropped across every serialization/structured-clone boundary (issue #252), including the `vgpu check` CLI JSON payload. The stopgap non-enumerable `toJSON()`/`EntryPointInfoJSON` this package briefly carried is removed in favor of making the underlying data itself lossless.

  Consumers that build bind group layouts (`vgpu`'s `set-layouts.ts`) still throw `VGPU-REFLECT-ENTRY-METADATA-MISSING` when an entry point arrives without `bindings`/`samplingPairs`/`inputs` metadata, rather than silently falling back to a wrong layout.

  BREAKING CHANGE (pre-1.0): code relying on `Object.keys(entryPoint)`, `{ ...entryPoint }`, or a JSON diff of an entry point _not_ containing `bindings`/`samplingPairs`/`inputs` will now see those keys. This is a clean break with no deprecated alias, consistent with this package's other 0.x breaking changes.

### Patch Changes

- Updated dependencies [b86fe6e]
  - @vgpu/wgsl@0.3.0
  - @vgpu/core@0.3.0
  - @vgpu/adapter-mock@0.3.0
  - @vgpu/adapter-node@0.3.0
  - @vgpu/wgsl-std@0.3.0
- Updated dependencies [1451232]
- Updated dependencies [6ea8edf]
- Updated dependencies [12b4efa]
- Updated dependencies [42bffb4]
- Updated dependencies [1e27582]
- Updated dependencies [836116e]
- Updated dependencies [43dfa78]
- Updated dependencies [d1b73c8]
- Updated dependencies [1255833]
- Updated dependencies [9812605]
  - @vgpu/wgsl@0.3.0
  - @vgpu/adapter-node@0.3.0
  - @vgpu/core@0.3.0
  - @vgpu/adapter-mock@0.3.0
  - @vgpu/wgsl-std@0.3.0

## 0.2.0

### Minor Changes

- 7006a36: `@vgpu/wgsl-std` is now a dependency of `vgpu`, so WGSL package imports such as `import { voronoi3d } from "@vgpu/wgsl-std/noise";` resolve in any project that ran `npm install vgpu`. Previously the WGSL resolver failed with `VGPU-WGSL-PKG-NOTFOUND: Package @vgpu/wgsl-std was not found` until the package was installed separately, which no doc mentioned. This works under npm, pnpm, and Yarn PnP: the dependency entry alone only covers hoisting layouts, so `@vgpu/wgsl` resolves the standard modules next to itself when they are not in the project's own `node_modules`. The standard modules are pure `.wgsl` text with no JavaScript entry point.

- 0026ff2: Add `DrawOptions.blendConstant` to `draw(gpu)`, closing the gap where `"constant"`/`"one-minus-constant"` blend factors were stuck at the initial `(0, 0, 0, 0)`. The constant is `[r, g, b, a]` finite numbers (values outside `[0, 1]` are allowed), emitted as `setBlendConstant` encoder state after `setPipeline` and before the draw — it is not part of the pipeline, so draws differing only in `blendConstant` share pipelines. A malformed value, or one paired with a `blend` that uses no constant factor, throws `VGPU-BLEND-CONSTANT-INVALID` at construction; constant factors without `blendConstant` stay legal and use the WebGPU pass default. Render bundles cannot set the pass blend constant, so `bundle` rejects recording such draws with `VGPU-BUNDLE-BLEND-CONSTANT`.
- ae3b42c: Add configurable depth state to `draw(gpu)` and a per-pass depth clear value. `DrawOptions.depth` takes `false` to disable depth testing or `{ write?, compare?, bias?, biasSlopeScale?, biasClamp? }`; invalid values throw `VGPU-DEPTH-INVALID` at construction. `FramePassOptions.clearDepth` sets the depth clear value in `[0, 1]` (default `1`); use `0` with `depth: { compare: "greater" }` for reversed-Z. Render passes on combined depth-stencil targets (`"depth24plus-stencil8"`, `"depth32float-stencil8"`) now emit the required `stencilLoadOp`/`stencilStoreOp` instead of producing invalid passes, and the stencil-only `"stencil8"` depth format is rejected at target creation with `VGPU-TARGET-DEPTH-STENCIL-ONLY`.

  BREAKING CHANGE (pre-1.0): the default depth compare for draws on depth targets changes from `"less"` to `"less-equal"`.

  - Before: fragments at exactly the depth already in the buffer failed the depth test, so re-drawing coplanar geometry left the first result in place.
  - After: fragments at equal depth pass and overwrite, so decals/coplanar re-draws land without a bias.
  - Who is affected: draws on targets with a depth attachment that rely on coplanar re-draws being rejected — i.e. that expect strict `"less"` semantics. Draws without a depth target, or with an explicit `compare`, are unchanged.
  - Fix to restore the old behavior: `draw(gpu, { ..., depth: { compare: "less" } })`.

- b29b180: Add entry point selection to `draw(gpu)` and `compute(gpu)` for shaders that declare several entry points. `DrawOptions.entry` is constructor-only `{ vertex?, fragment? }` names — each omitted field keeps the first entry point of that stage, exactly as before — and `ComputeOptions.entry` is one `@compute` name defaulting to the first `@compute` entry point. Selection happens before anything derived from the selected entries, so binding visibility, bind group layouts, vertex input layouts (the selected vertex entry's inputs drive geometry attribute matching), storage-stage limit checks, and the compute storage-aliasing preflight all reflect the chosen variant. Shader modules are shared per byte-identical source, so the selected entry names now join the shared pipeline cache key when they differ from the first-of-stage defaults: draws on the same source that differ only in `entry` compile distinct pipelines, while an absent option — or one explicitly naming the first-of-stage entries — keeps byte-identical descriptors and cache keys. `VGPU-ENTRY-INVALID` throws at construction for a malformed `entry` (a non-object draw value or non-string name), a name that matches no entry point in the shader, or a name whose entry point has the wrong stage; the message lists the shader's available entry points with their stages.
- f526de2: Adopt a `GPUDevice` vgpu did not create, so an ML runtime and vgpu can share one device and one queue instead of round-tripping tensors through the CPU.

  `initFromDevice(device)` — exported from `vgpu`, `vgpu/node` and `vgpu/mock` — returns the same `Gpu` as `init()`, wrapping a device owned by someone else (ONNX Runtime Web, WebLLM, transformers.js, a host engine). It is a separate entry point rather than an `init()` option on purpose: a program that lets vgpu create its own device never bundles the adoption path. Adoption is non-owning — `gpu.dispose()` drops vgpu's wrapper and leaves the native device to its owner — and because that owner can destroy or lose the device at any time, every entry point re-checks it instead of trusting the handle. The device is validated structurally (not by `instanceof`, so a device from a worker, an iframe or a test double is accepted) and a malformed one throws `VGPU-INIT-DEVICE-INVALID`; a device that is already lost is detected before `initFromDevice()` resolves, so you never get back a `Gpu` that fails on first use.

  `Device.wrapBuffer(gpuBuffer)` (`@vgpu/core`) wraps a caller-owned `GPUBuffer` as a vgpu `Buffer` without taking ownership of its native lifetime — size, usage and label are read off the buffer itself. Disposing the wrapper releases only vgpu's handle; the runtime that allocated the buffer still owns it. A value that is not a live `GPUBuffer` with finite `size`/`usage` throws `VGPU-EXTERNAL-BUFFER-INVALID`.

- 6426a94: Add `frame.cancel()`, the explicit lifecycle exit for manual frames. A `frame(gpu)` you open by hand and never submit keeps its command encoder — and, if it attached a `timer(gpu)` span or opened a `visibility(gpu)` pass, the retain that keeps those query sets alive — until `gpu.dispose()`, because a frame is never assumed abandoned: an old frame can still be submitted. `cancel()` closes it deliberately: the encoder is dropped so nothing it encoded ever runs, and every telemetry instance the frame attached releases that frame's retain without encoding a resolve or starting a readback, so no phantom duration or phantom `"hidden"` can land and a disposed timer/visibility is destroyed right away. Cancelling is idempotent like submitting — a second `cancel()` does nothing and `submit()` after `cancel()` is a no-op, so calling `cancel()` inside a `frame(gpu, cb)` callback after its passes close is safe — while `cancel()` from an active pass callback throws the new `VGPU-FRAME-PASS-ACTIVE` (the pass descriptor still references its resources), `cancel()` after `submit()` throws `VGPU-FRAME-SUBMITTED` (queued work cannot be taken back), and `pass()` or a retained `FramePass` operation after `cancel()` throws `VGPU-FRAME-CANCELED` (it would encode into a dropped encoder).
- 1905a0c: **BREAKING: the `Gpu` facade is gone. Every factory is a free function whose first argument is the gpu.**

  0.2.0 is a clean break: there are no deprecated aliases and no compatibility layer. `init()` still returns a `Gpu`, but that object is now only a device handle and a lifetime — `device`, `gpu`, `disposed`, `onError()`, `settled()`, `dispose()`. Everything that used to hang off it is a named export of `vgpu`, `vgpu/node` and `vgpu/mock`.

  Why: the facade forced every entrypoint to import every feature, so a program that only drew a triangle still paid for compute, timers, occlusion queries, ping-pong and the scene primitives. Free functions are tree-shakable — you pay for the imports you write. The objects the factories return keep their methods (`frame.pass`, `draw.set`, `geometry.slice`, `timer.span`, `effect.draw`), so only the creation call changes.

  | 0.1.x                                           | 0.2.0                                                   |
  | ----------------------------------------------- | ------------------------------------------------------- |
  | `gpu.surface(canvas, opts?)`                    | `surface(gpu, canvas, opts?)`                           |
  | `gpu.target(opts)`                              | `target(gpu, opts)`                                     |
  | `gpu.effect(source, opts?)`                     | `effect(gpu, source, opts?)`                            |
  | `gpu.draw(opts)`                                | `draw(gpu, opts)`                                       |
  | `gpu.geometry(descriptor \| recipe)`            | `geometry(gpu, descriptor \| recipe)`                   |
  | `gpu.frame(cb?)`                                | `frame(gpu, cb?)`                                       |
  | `gpu.frame.loop(cb, opts?)`                     | `frameLoop(gpu, cb, opts?)`                             |
  | `gpu.bundle(opts, record)`                      | `bundle(gpu, opts, record)`                             |
  | `gpu.compute(source, opts?)`                    | `compute(gpu, source, opts?)`                           |
  | `gpu.storage(bytes, access?)`                   | `storage(gpu, bytes, access?)`                          |
  | `gpu.pingPong(w, h, opts?)`                     | `pingPong(gpu, w, h, opts?)`                            |
  | `gpu.pingPongStorage(bytes)`                    | `pingPongStorage(gpu, bytes)`                           |
  | `gpu.uniforms(values)`                          | `uniforms(gpu, values)`                                 |
  | `gpu.sampler(desc?)`                            | `sampler(gpu, desc?)`                                   |
  | `gpu.timer()`                                   | `timer(gpu)`                                            |
  | `gpu.visibility(opts?)`                         | `visibility(gpu, opts?)`                                |
  | `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` | `clock(gpu).time` / `.deltaTime` / `.frameCount`        |
  | `gpu.clearColor` (global default)               | `target.clearColor` / `surface.clearColor` (per target) |

  ```ts
  // 0.1.x
  const gpu = await init();
  const view = gpu.surface(canvas, { dpr: [1, 2] });
  const wave = gpu.effect(WAVE_WGSL, { set: { speed: 2 } });
  gpu.clearColor = [0.02, 0.02, 0.04, 1];
  gpu.frame.loop(() => {
    wave.set({ time: gpu.time });
    gpu.frame((f) => f.pass(view, wave));
  });

  // 0.2.0
  import { clock, effect, frameLoop, init, surface } from "vgpu";

  const gpu = await init();
  const view = surface(gpu, canvas, {
    dpr: [1, 2],
    clearColor: [0.02, 0.02, 0.04, 1],
  });
  const wave = effect(gpu, WAVE_WGSL, { set: { speed: 2 } });
  const time = clock(gpu);
  frameLoop(gpu, (frame) => {
    wave.set({ time: time.time });
    frame.pass(view, wave);
  });
  ```

  ### The clock is a free function too: `clock(gpu)`

  `clock(gpu)` returns `{ time, deltaTime, frameCount, advance(dtSeconds) }` — one instance per gpu, created lazily. Reading it is the direct replacement for the old `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` fields, which no longer exist.

  `advance(dtSeconds)` is new and is the reason the clock is worth an object: it moves the clock forward immediately and claims that frame's tick, so a later `frame(gpu)` counts the frame but does not advance time a second time. One tick per frame, manual first. That is what makes an external ticker (GSAP, Motion, an XR frame callback), a timescale, a fixed timestep or a deterministic replay possible without a second clock fighting vgpu's:

  ```ts
  import { clock, frame } from "vgpu";

  const time = clock(gpu);
  gsap.ticker.add((_total, deltaMs) => {
    time.advance(deltaMs / 1000); // your delta, your timeline
    frame(gpu, (f) => f.pass(view, wave)); // renders; does not re-advance
  });
  ```

  Without `advance()`, `frame()` and `frameLoop()` keep advancing the clock with wall-clock deltas exactly like 0.1.x. `frameCount` counts frames, never advances. Invalid deltas (negative, `NaN`, `Infinity`) throw `VGPU-CLOCK-DELTA-INVALID`. The full technique is documented in the guide _Driving vgpu with an external ticker — GSAP/Motion/XR_.

  ### Clear color belongs to the target

  The global `gpu.clearColor` is gone. Each target carries its own default, at creation or at runtime:

  ```ts
  const scene = target(gpu, {
    size: [1280, 720],
    clearColor: [0.02, 0.02, 0.04, 1],
  });
  const view = surface(gpu, canvas, { clearColor: [0, 0, 0, 1] });

  scene.clearColor = [0.1, 0, 0.1, 1]; // mutable, validated on assignment
  ```

  Precedence in a pass: the pass `clear` color wins, then `target.clearColor`, then the built-in `[0, 0, 0, 1]`. `clear: false` is unchanged — it still preserves color/depth, and it is still rejected on MSAA targets (`VGPU-PASS-PRESERVE-MSAA`). Invalid values still throw `VGPU-CLEAR-COLOR-INVALID`, now pointing at `target.clearColor` / `surface.clearColor`.

  ### Geometry is one symbol

  `geometry(gpu, input)` accepts both a raw descriptor and a scene recipe (`box()`, `plane()`, …), and each recipe carries its own builder — importing `box` retains only the box builder, not the primitive table. There is no `geometryFromRecipe`, and `vgpu/scene` deliberately does not re-export the `geometry` factory (it would pull the device path into the scene budget); import it from `vgpu`.

  ### Diagnostics

  Error **codes are unchanged**. Every user-facing message and fix-it now spells the API the way you call it — `compute(gpu, source)`, `bundle(gpu, { target }, cb)`, `storage(gpu, bytes, { indirect: true })`, `sampler(gpu)` — so a copy-pasted fix compiles. Two cross-cutting codes are now documented on `Gpu`:

  - `VGPU-GPU-DISPOSED` — a factory (or `clock`) ran after `gpu.dispose()`.
  - `VGPU-GPU-FOREIGN` — the first argument was not created by `init()`.

  ### Migration checklist

  1. Import what you create: `import { clock, draw, effect, frame, frameLoop, geometry, sampler, surface, target } from "vgpu";` (or `vgpu/node`, `vgpu/mock`).
  2. Rewrite `gpu.x(...)` as `x(gpu, ...)` per the table. Methods on returned objects do not change.
  3. Replace `gpu.frame.loop(cb)` with `frameLoop(gpu, cb)` and `gpu.frame(cb)` with `frame(gpu, cb)`.
  4. Replace `gpu.time` / `gpu.deltaTime` / `gpu.frameCount` with a `const time = clock(gpu)` hoisted out of the loop.
  5. Move `gpu.clearColor` to the target(s) that clear: an option at creation, or an assignment at runtime.
  6. Type-only imports (`Gpu`, `Surface`, `Target`, `Draw`, `Effect`, `Frame`, …) are unchanged.

- d57a030: **BREAKING:** the low-level GPU vertex/index resource is now called `Geometry`, freeing the name `Mesh` for the renderable scene-tree node (`mesh(geometry, material)` in `vgpu/scene`, the three.js acception). This is a clean break at 0.2.0 — the old names are removed, there are no deprecated aliases.

  | Old (0.1.x)                                             | New (0.2.0)                                                         |
  | ------------------------------------------------------- | ------------------------------------------------------------------- |
  | `gpu.mesh(geometry)` / `gpu.mesh(options)`              | `geometry(gpu, descriptor)` / `geometry(gpu, options)`              |
  | `DrawOptions.mesh`                                      | `DrawOptions.geometry`                                              |
  | `Mesh`                                                  | `Geometry`                                                          |
  | `MeshOptions`                                           | `GeometryOptions`                                                   |
  | `MeshLike`                                              | `GeometryLike`                                                      |
  | `MeshBuffer` / `MeshBufferOptions`                      | `GeometryBuffer` / `GeometryBufferOptions`                          |
  | `MeshSlice` / `MeshSliceOptions`                        | `GeometrySlice` / `GeometrySliceOptions`                            |
  | `MeshAttributes` / `MeshAttributeOverride` / `MeshData` | `GeometryAttributes` / `GeometryAttributeOverride` / `GeometryData` |
  | `slice.mesh` (parent back-reference)                    | `slice.geometry`                                                    |
  | `SceneMesh` (`vgpu/scene`)                              | `Geometry` (re-exported as a type from `vgpu/scene`)                |

  Migration — the 0.1.x `Mesh` names become `Geometry` names, and the factory is the free function of 0.2.0 (see the free-functions changeset):

  ```ts
  import { draw, geometry } from "vgpu";
  import type { Geometry, GeometryLike, GeometrySlice } from "vgpu";

  const cube: Geometry = geometry(gpu, box({ size: 1 }));
  const half: GeometrySlice = cube.slice({ vertexCount: 18 });
  const cubeDraw = draw(gpu, { shader, geometry: cube });
  ```

  `SceneGeometry` (the pure, device-agnostic descriptor produced by `box()`, `sphere()`, …) keeps its name, and the scene-tree `mesh()` / `MeshNode` exports of `vgpu/scene` are unchanged. Error codes stay `VGPU-MESH-*` (they are scope-bound identifiers), but their `where`/message text now teaches the new names — e.g. `geometry`, `geometry.slice`, `GeometryLike.vertexCount`.

  Also in 0.2.0, scene cameras and controls validate their inputs instead of silently producing broken matrices — these are observable behavior changes for call sites that were passing degenerate values:

  - `perspectiveCamera()` validates `aspect` (must be positive and finite) in the constructor and in `set()`. Call sites that passed `canvas.width / canvas.height` without clamping (zero-sized canvas → `0` or `Infinity`) now throw `VGPU-SCENE-VALUE-INVALID` instead of producing `Infinity`-filled projection matrices.
  - `orthographicCamera()` rejects empty or non-finite extents (`left === right`, `top === bottom`, `NaN`, …). Inverted ranges are still legal — they remain the supported way to Y-flip.
  - Orbit controls and lights reject non-finite values (`NaN`/`Infinity`) instead of poisoning transforms and light blocks.

- ccbdd95: Add `timer(gpu)` for GPU pass timing. `timer.span(name)` passed as `FramePassOptions.timer` writes a begin/end timestamp pair around the pass via the pass descriptor's `timestampWrites`; each frame appends a single `resolveQuerySet` of the contiguous used range to the frame encoder before submit, and results are read back through rotated staging buffers without ever blocking a frame. Decoded durations arrive in milliseconds through `timer.onResults(cb)`, keyed by span name, typically 1–2 frames after submit; timestamps are implementation-defined ns ticks and negative deltas (counter resets) are clamped to 0. Requires the `"timestamp-query"` device feature — `timer(gpu)` throws `VGPU-TIMER-INVALID` at creation without it, pointing at `init({ requiredFeatures: ["timestamp-query"] })`. The same code covers duplicate span names within one frame, spans used across gpus, malformed `timer` options, and disposed timers; capacity starts at 32 spans and grows only at frame boundaries up to WebGPU's 4096-query set limit (2048 spans per frame, beyond which `VGPU-TIMER-CAPACITY` throws). Failed asynchronous query readbacks are dropped without rejecting the frame and reported through `gpu.onError` as `VGPU-QUERY-READBACK`. The mock GPU device now supports the full path — `createQuerySet` (instrumented), `timestampWrites` on pass descriptors, `resolveQuerySet` writing deterministic fake u64 values, and real `copyBufferToBuffer` between mock buffers — so timing is testable end-to-end with `createMockAdapter({ features: ["timestamp-query"] })`.
- 8c186ae: Add `visibility(gpu)` for occlusion queries — core WebGPU, no device feature required. A pass opened with the new `FramePassOptions.visibility` carries the instance's occlusion query set, and the new `FramePass.occlusion(query, body)` wraps a proxy draw (a `Draw`, an `Effect`, or a callback encoding several draws) in `beginOcclusionQuery`/`endOcclusionQuery` on a per-frame contiguous slot; one `resolveQuerySet` of the used range is appended to the frame encoder before submit and read back without ever blocking a frame. Results are zero vs non-zero only, per the WebGPU occlusion semantics, and latch asynchronously into stable `vis.query(label)` handles: `q.hidden` is `true` only when a completed query confirmed zero passing samples (unknown/visible read as `false` — the safe default is to draw), `q.state` reports `"visible" | "hidden" | "unknown"`, and `q.age` counts frames since the last applied result. `reset()` (per handle or whole instance) flips state to `"unknown"` immediately and discards in-flight pre-reset readbacks, for camera cuts; `dispose()` frees a handle's label for reuse safely. Capacity is a declared contract (`{ capacity }`, default 64, max 4096 — `VGPU-VIS-CAPACITY-LIMIT`); overflowing it throws `VGPU-VIS-CAPACITY` at the offending `occlusion()` call. Validation also covers `VGPU-VIS-LABEL-DUPLICATE`, `VGPU-VIS-DISPOSED`, `VGPU-VIS-NO-DEPTH` (occlusion culling needs a depth attachment), `VGPU-QUERY-NO-VISIBILITY`, `VGPU-QUERY-NESTED`, `VGPU-QUERY-DUPLICATE` (same handle twice in one frame, across passes too), and `VGPU-VIS-INVALID` for mismatched instances or gpus. Draws replayed from bundles inside an occlusion scope count toward the active query. Failed asynchronous query readbacks are dropped without rejecting the frame and reported through `gpu.onError` as `VGPU-QUERY-READBACK`. The mock GPU render pass encoder now records `beginOcclusionQuery`/`endOcclusionQuery` scopes (instrumented no-ops), so the whole path is testable end-to-end.
- d030381: Add GPU-driven indirect draws and compute dispatches. `storage(gpu, bytes, { indirect: true })` — the second argument now also accepts a `StorageOptions` bag `{ access?, indirect? }` — appends the `"indirect"` buffer usage. `DrawCallOptions.indirect` (a `StorageBuffer` or `{ buffer, offset? }`, offset defaulting to `0`) encodes `drawIndirect` for non-indexed draws (4 u32 arguments, 16 bytes) or `drawIndexedIndirect` for indexed geometries (5 32-bit arguments, 20 bytes; the index buffer is still set), in one-shot `draw.draw()`, `FramePass.draw`, and `bundle` recording alike. `Compute.dispatch({ indirect })` encodes `dispatchWorkgroupsIndirect` (3 u32 counts, 12 bytes); positional `dispatch(x, y?, z?)` is unchanged. `VGPU-INDIRECT-INVALID` throws at call time for a malformed value, a buffer created without the indirect flag, an offset that is not a non-negative multiple of 4, arguments that do not fit the buffer, or `indirect` combined with CPU-side counts in the same call. Per the WebGPU spec, a non-zero buffered `firstInstance` needs the `"indirect-first-instance"` feature or the indirect draw is treated as a no-op — GPU-side data that cannot be validated on the CPU.
- ea7cd96: Add `DrawOptions.multisample` to `draw(gpu)`: constructor-only `{ alphaToCoverage?, mask? }` multisample state. `alphaToCoverage` maps to `GPUMultisampleState.alphaToCoverageEnabled` (fragment alpha becomes a coverage mask) and `mask` to the sample bitmask; the pipeline's sample `count` still comes from the target's `sampleCount`. Unset fields stay omitted from the descriptor and draws without the option keep byte-identical pipeline cache keys and behavior; draws that differ only in multisample state compile distinct pipelines. A non-object `multisample`, non-boolean `alphaToCoverage`, or a `mask` outside integer `[0, 0xFFFFFFFF]` throws `VGPU-MULTISAMPLE-INVALID` at construction (mask bits above the target's sample count are legal and ignored, mirroring WebGPU), and compiling `alphaToCoverage: true` against a non-MSAA target signature throws `VGPU-MULTISAMPLE-INVALID` telling you to create the target with `msaa: true` — at construction when `targets: [...]` is given.
- 47f7ec8: Add `constants` to `DrawOptions` (`draw(gpu)`) and `ComputeOptions` (`compute(gpu)`): constructor-only values for WGSL `override` pipeline constants, flowing into `GPUProgrammableStage.constants` — both the vertex and fragment stages for draws (WebGPU matches keys against the module's override declarations, not per entry point, so one record serves both stages) and the compute stage for compute pipelines. Key by override name, or by the decimal string of `N` when the declaration has `@id(N)` (the name is not usable then, mirroring WebGPU's identifier rule). Values are finite numbers or booleans; booleans convert to `1`/`0` doubles that WebGPU converts to the override's WGSL type (bool/i32/u32/f32/f16). Draws that differ only in `constants` compile distinct pipelines; an absent option — or an empty `{}` — keeps byte-identical descriptors and pipeline cache keys. `VGPU-CONSTANTS-INVALID` throws at construction for a non-object `constants`, a key that matches no override in the shader (the message lists the available overrides), a value that is neither a finite number nor a boolean, or an override declared without a default that `constants` does not provide.

  `@vgpu/wgsl` reflection: `OverrideInfo` gains an optional `id` field carrying the `@id(N)` pipeline constant ID; `defaultValue` continues to mark declarations with a default initializer. The change is additive — existing `Reflection` consumers are unaffected.

- 580b6d5: Add `FramePassOptions.depthReadOnly` to `Frame.pass`. When true, the pass's depth-stencil attachment is built with `depthReadOnly: true` and omits `depthLoadOp`/`depthStoreOp` — WebGPU requires the ops to be absent for read-only aspects — and combined depth-stencil formats also set `stencilReadOnly: true` and omit the stencil ops. Depth can be tested against and sampled in the same pass but not written: offscreen depth textures now carry `texture_binding` usage, so the pass target's own `target.depth` can be bound with `set()` inside its read-only pass (depth-aware particles, SSAO, soft depth). Draws are pre-validated against the pass, mirroring WebGPU `setPipeline`'s `[[writesDepth]]`/`[[writesStencil]]` rules: a depth-writing draw (the default is `write: true` — use `depth: { write: false }` or `depth: false`) or a stencil-writing draw (any unculled face op other than `"keep"` with a nonzero stencil `writeMask`) throws `VGPU-PASS-DEPTH-READONLY` at encode. The same code is thrown for the dead options and contradictions — a non-boolean value, `depthReadOnly: true` on a target without depth, or combining it with `clearDepth`/`clearStencil` (a color `clear` remains fine: only depth/stencil ops are omitted) — and for `FramePass.bundles` in a read-only pass, since `bundle` always records bundles with writable depth/stencil and WebGPU only executes read-only-recorded bundles there. MSAA targets are rejected separately with `VGPU-PASS-DEPTH-READONLY-MSAA`, because their discarded multisampled depth cannot be read reliably by a later read-only pass.
- e37f89d: Add per-pass `viewport` and `scissor` options to `FramePassOptions`. Both are emitted once right after the pass opens and apply to every draw in the pass, including replayed bundles. `viewport` is `{ x?, y?, width, height, minDepth?, maxDepth? }` (defaults `x`/`y` `0`, `minDepth` `0`, `maxDepth` `1`) following WebGPU `setViewport` rules — float pixels bounded by device limits, `minDepth <= maxDepth` — and throws `VGPU-PASS-VIEWPORT-INVALID` at pass open otherwise. `scissor` is `[x, y, width, height]` non-negative integers validated at pass open against the target's current pixel size (targets are resizable), throwing `VGPU-PASS-SCISSOR-INVALID` with the current size in the message when out of bounds. The scissor clips draws only; a clearing pass still clears the full attachment.
- 213e467: Add `DrawOptions.colors` to `draw(gpu)`: per-color-target blend/writeMask overrides for MRT draws, aligned by index with the target's color attachments. `null`/missing entries — and omitted fields of an entry — inherit the top-level `blend`/`writeMask`, so `colors: [null, { writeMask: [] }]` silences the second G-buffer attachment while the first keeps the uniform state. Draws that differ only in `colors` compile distinct pipelines; draws without `colors` keep today's pipeline keys and behavior. A non-array `colors` or an entry that is neither `null` nor `{ blend?, writeMask? }` throws `VGPU-COLORS-INVALID` at construction (entry values reuse the `VGPU-BLEND-INVALID`/`VGPU-WRITEMASK-INVALID` rules), and compiling against a target signature whose color attachment count differs from `colors.length` throws `VGPU-COLORS-INVALID` with both counts in the message.
- bf7c688: Add `DrawOptions.stencil` to `draw(gpu)` and `FramePassOptions.clearStencil` to `Frame.pass`. `stencil` is constructor-only `{ front?, back?, readMask?, writeMask?, ref? }` state for targets whose depth format has a stencil aspect: `front`/`back` map to `GPUDepthStencilState.stencilFront`/`stencilBack` (`compare`/`fail`/`depthFail`/`pass` → `compare`/`failOp`/`depthFailOp`/`passOp`, defaults `"always"`/`"keep"`), omitted `back` mirrors the normalized `front`, and `readMask`/`writeMask` (u32, default `0xFFFFFFFF`) map to `stencilReadMask`/`stencilWriteMask`, merging into the same depth-stencil state as the `depth` option. Unset fields stay omitted, so draws without the option keep byte-identical descriptors and pipeline cache keys; draws that differ only in stencil pipeline state compile distinct pipelines. `ref` is encoder state emitted as `setStencilReference` before the draw (only when provided, including an explicit `0`) and stays out of the pipeline key, so draws differing only in `ref` share pipelines; render bundles reject recording draws whose stencil has `ref` with `VGPU-BUNDLE-STENCIL-REF` (bundle encoders cannot set the pass stencil reference), while stencil without `ref` records fine. Malformed stencil options throw `VGPU-STENCIL-INVALID` at construction, and any stencil state against a signature whose depth format lacks a stencil aspect throws `VGPU-STENCIL-INVALID` at compile/draw time suggesting `depth: "depth24plus-stencil8"`. `clearStencil` (integer in `[0, 0xFFFFFFFF]`, default `0`, masked by WebGPU to the stencil aspect's bit width) threads into the pass depth-stencil attachment's `stencilClearValue`; invalid values or a target without a stencil aspect throw `VGPU-PASS-CLEARSTENCIL-INVALID`, and combining it with `clear: false` throws `VGPU-PASS-PRESERVE-CLEARSTENCIL`.
- 12aa696: Support float texture formats in texture/target readback, closing the gap where `target.read()` on an HDR target threw `VGPU-CORE-UNSUPPORTED-FORMAT`.

  `Texture.read()`, `Target.read()`, and `Surface.read()` now copy back `rgba16float`, `rgba32float`, `r16float`, `rg16float`, `r32float`, `rg32float`, `r8unorm`, and `rg8unorm` in addition to the existing `rgba8unorm` / `rgba8unorm-srgb` / `bgra8unorm` / `bgra8unorm-srgb`. `read()` keeps its `Promise<Uint8Array>` signature and returns the raw unpadded texel bytes of the texture's own format (`width * height * bytesPerPixel`), so `rgba8unorm` readback is byte-for-byte unchanged.

  New `Texture.readFloats()` / `Target.readFloats()` / `Surface.readFloats()` return a `Float32Array` with one f32 per component (row-major, `width * height * components` long): binary16 texels are widened to f32 (subnormals, infinities, and NaN included), f32 texels are copied verbatim, and `unorm8` texels are normalized to `[0, 1]` without srgb gamma conversion — so HDR values above `1` and negatives survive the readback instead of being clamped into bytes.

  Formats outside that table (depth/stencil, packed such as `rgb10a2unorm` / `rg11b10ufloat`, snorm/uint/sint, and compressed) still throw `VGPU-CORE-UNSUPPORTED-FORMAT`, now listing the supported formats in the message.

  The mock device also gained a real `queue.writeTexture` and allocates its texel storage from the texture's format and layer count, so `writeTexture` + `read()` / `readFloats()` round-trips per format on the mock adapter with the same byte layout a real device produces: `bytesPerRow` / `rowsPerImage` padding, `origin` (including array layers) and the `bgra*` → RGBA swizzle all behave as they do on a real readback, `read()` returns layer 0 like `copyTextureToBuffer` does, and unsupported formats are rejected on the mock exactly as they are on a real device. The mock stores mip 0 only, so `writeTexture` with `mipLevel > 0` now throws instead of silently corrupting mip 0.

  Note for custom `Target` implementers (pre-1.0): the `Target` interface gained a required `readFloats(): Promise<Float32Array>` member. Delegating to `this.color.readFloats()` — what `target(gpu)` and `surface(gpu)` do — is enough.

- 3da184f: Add `DrawOptions.unclippedDepth` to `draw(gpu)` and adapter feature checks for `init({ requiredFeatures })`. `unclippedDepth: true` maps to `GPUPrimitiveState.unclippedDepth`, disabling depth clipping so geometry outside `[near, far]` is not clipped; it requires the `"depth-clip-control"` device feature, checked against `device.features` at construction. A non-boolean value, or `true` on a device without the feature, throws `VGPU-UNCLIPPED-DEPTH-INVALID` with the exact `init({ requiredFeatures: ["depth-clip-control"] })` guidance. The option is emitted only when `true` and joins the pipeline cache key only when set, so draws without it — or with an explicit `false` — keep byte-identical descriptors and cache keys, while draws differing only in `unclippedDepth` compile distinct pipelines.

  `init({ requiredFeatures })` now validates requested features against the adapter's supported set before `requestDevice` in the browser, node, and mock adapters, failing with `VGPU-FEATURE-UNSUPPORTED` instead of a cryptic native rejection (`validateRequiredFeatures`/`unsupportedFeaturesError` are exported from `@vgpu/core`). `createMockAdapter({ features })` declares the features the mock adapter supports and `createMockGPUDevice({ features })` creates a device whose `features` set reflects them — faithful to WebGPU, a mock device enables exactly the requested features, so tests can exercise feature-gated paths with and without the grant.

### Patch Changes

- c21def5: the bare vgpu command now routes agents and humans to the docs workflow
- 5261169: Prevent shared uniform updates from modifying object prototypes through unsafe property names.
- ef1213b: the docs/examples CLI now points to https://vgpu.sh
- Updated dependencies [8345a03]
- Updated dependencies [65cc995]
- Updated dependencies [2856407]
- Updated dependencies [3731a3c]
- Updated dependencies [eba8e4d]

  - @vgpu/wgsl-std@0.2.0
  - @vgpu/wgsl@0.2.0
  - @vgpu/core@0.2.0
  - @vgpu/adapter-mock@0.2.0
  - @vgpu/adapter-node@0.1.7

- 69b3f16: Fix render-pipeline cache collisions for strip-topology geometries that derive `stripIndexFormat` from `indexFormat`. The derived format now participates in the cache key exactly as it does in the WebGPU pipeline descriptor, so `uint16` and `uint32` strip meshes cannot incorrectly share a pipeline.
- 4178c6e: Stop the render loops a gpu created when it is disposed: `frameLoop(gpu, cb)` handles are tracked like the timers and visibilities `gpu.dispose()` already releases, so disposal cancels the scheduled tick and the callback stops running against a disposed device (a loop that was stopped by hand drops its registration first). Internal tidy-ups with no behavior change: telemetry instances now expose an explicit `frameAbandoned(frame)` hook for frames that never reach the queue — a failed pass, a failed finish/submit, a cancelled frame — instead of the implicit `finalizeFrame(ABANDONED_FRAME)` + `frameSubmitted` pairing, and the `VGPU-QUERY-READBACK` error moved from an inline construction in the query ring to a `queryReadbackError()` factory in `errors.ts` like every other vgpu error.
- Updated dependencies [0026ff2]
- Updated dependencies [f526de2]
- Updated dependencies [ccbdd95]
- Updated dependencies [8c186ae]
- Updated dependencies [d030381]
- Updated dependencies [388477e]
- Updated dependencies [47f7ec8]
- Updated dependencies [e37f89d]
- Updated dependencies [bf7c688]
- Updated dependencies [12aa696]
- Updated dependencies [3da184f]
- Updated dependencies [f526de2]
- Updated dependencies [8fc4daf]
  - @vgpu/core@0.2.0
  - @vgpu/wgsl@0.2.0
  - @vgpu/adapter-mock@0.2.0
  - @vgpu/adapter-node@0.1.7
