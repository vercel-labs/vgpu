## 0.1.0 — 2026-07-21

### Breaking
- `Draw.draw()` now returns `void`; use `gpu.onError(cb)` for asynchronous validation errors and `await gpu.settled()` in tests or teardown.
- `Frame.done` is resolve-only. `try/catch` around `await frame.done` is dead code; keep it for readbacks, benchmarks, completion pacing outside RAF loops, and deterministic tests.
- Bundles are replay-compatible by target signature (color formats, depth, sample count), not size. Drawing onto a resized target survives; sampling a resized target still stales through resource identity. `BundleOptions.target` also accepts a signature object.
- `Draw.compile(targetOrSignature)` / `Effect.compile(targetOrSignature)` pre-warm asynchronously; `compileSync()` and `DrawOptions.targets` provide synchronous warmup.
- Public rendering docs now target the `vgpu` package (`init`, `Gpu`, `pass`, `draw`, `compute`, `frame`, `bundle`, `target`, `uniforms`) and mark the old thick render surface for removal in the rewrite.
- Shader authoring guidance now treats performance patterns as defaults: bundles/replay, pipeline pre-warm, R4 dynamic offsets, in-place `set()`, bake, instancing, shared uniforms, ping-pong, and target-owned MSAA/depth.

### Added
- `@vgpu/core`: add `pingPong()` texture and buffer pairs with swap, reset, resize, and lifecycle helpers.
- `@vgpu/core`: add `filter` and `wrap` sampler descriptor shorthands.
- `@vgpu/core`: support explicit texture mip-level, dimension, and view-format options.
- `@vgpu/core` and `@vgpu/adapter-node`: add explicit cube/layer texture views and compatibility-mode plumbing.
- `@vgpu/core`: add extent-only `Texture.resize()` and cache the default view with resize/destroy invalidation.
- `@vgpu/render`: add multipass frame helpers and setup-time render bundle recording.
- `@vgpu/render`: add schema-typed `StructuredUniform` buffers with partial writes and custom bind-group composition.
- `@vgpu/render`: add descriptor-like and raw-descriptor render pipeline APIs with async-to-sync fallback support.
- `@vgpu/render`: add `Uniform`, `StorageBuffer`, `gpuFrameTime`, and `pixelDiff` performance primitives.
- `@vgpu/wgsl-std`: add hash, noise, fullscreen, tonemapping, and luminance-threshold WGSL utilities.
- CLI docs generation now discovers performance guides and emits the generated `skills/vgpu` mirror.

### Changed
- `@vgpu/wgsl`: prune unused resolved WGSL declarations conservatively for shaders with entry points.
- `@vgpu/wgsl`, `@vgpu/core`, and `vgpu`: reflect transitive static binding use to build stage-exact pipeline layouts and report actionable stage-limit errors.
- `@vgpu/wgsl` and `vgpu`: infer filterable sampled-float texture layouts per entry point while preserving unfilterable load-only textures.

### Fixed
- `Effect.gpu` now returns the actual compiled pipeline after warmup/use instead of staying undefined.
- `@vgpu/render`: omit the optional dynamic-offset argument to `RenderPass.setBindGroup` instead of forwarding explicit `undefined`.
- `@vgpu/core`: unwrap VGPU buffer-like objects before generic GPU buffer binding objects.

## 0.0.3 — 2026-05-13

### Minor
- @vgpu/render: BREAKING CHANGE (pre-1.0): `material()` no longer auto-prepends texture/sampler WGSL declarations by default. `wgslDeclarations(textures, textureBindings, samplerBindings, group?)` is also exported for lower-level declaration generation. Binding allocation order is now documented as uniforms → samplers → textures, each in insertion order.

  Migration paths:
  1. Add `autoDeclarations: true` to keep the previous PR #63 draft behavior:
     ```ts
     material({ ..., textures, samplers, autoDeclarations: true });
     ```
  2. Write declarations explicitly in shader source:
     ```wgsl
     @group(0) @binding(0) var materialSampler: sampler;
     @group(0) @binding(1) var albedo: texture_2d<f32>;
     ```
  3. Let the library compute declarations and prepend them manually:
     ```ts
     const decls = getMaterialDeclarations(spec);
     const mat = material({ ...spec, fragment: `${decls}\n${fragment}` });
     ```
- @vgpu/wgsl: Add `deps` field to `resolveShader` result; add `onDependency` callback option to `transformWgsl`. Foundation for HMR / watch-mode support in webpack/vite loaders (PR2).
- @vgpu/wgsl: Production-grade loader plumbing: webpack now tracks transitively-imported `.wgsl` files via `addDependency`, Vite/Rollup via `addWatchFile`, and CJS configs can `require.resolve('@vgpu/wgsl/loader-webpack')` / `require.resolve('@vgpu/wgsl/loader-vite')` through new `default` export conditions.
- @vgpu/wgsl: Add `examples/next-wgsl/`, a private Next.js Turbopack dogfood app plus CI smoke job for the webpack-compatible WGSL loader.
- @vgpu/wgsl: Final docs/types polish for WGSL loaders: add opt-in `@vgpu/wgsl/wgsl-types` ambient `*.wgsl` type sub-export; replace the Next example's local declaration with the package reference; expand README coverage for Webpack, Vite, Turbopack, HMR, reflection, and mangling/entry-point invariants; add webpack bare-string loader and imported-entrypoint preservation regressions.
- @vgpu/wgsl: Runtime: production HMR correctness — resolver uses async file reads + removes stale-result entry-level cache.
  - `resolveShader` now reads `.wgsl` source via async `fs/promises.readFile`. Turbopack's webpack-loader bridge tracks transitive `.wgsl` reads via this path; sync reads previously bypassed interception.
  - `resolveShader` no longer caches resolved results across calls. Existing dependency-registration wiring (`addDependency` in webpack, `addWatchFile` in vite, async-fs interception in Turbopack) now actually triggers fresh resolution on file changes. Direct-runtime hot-loop callers should memoize at their call site if performance becomes a concern (the per-file `scanCache` is still active).

## 0.0.1 — 2026-05-07

First public preview. API will shift before 0.1.0.

### Shipped
- @vgpu/core: device, buffer, texture, shader, queue, app primitives
- @vgpu/render: render pipeline + render pass + bind group helpers
- @vgpu/wgsl: WGSL compile + runtime resolve + webpack/vite loaders
- @vgpu/adapter-mock: mock GPU adapter for tests
- @vgpu/adapter-node: Node.js GPU adapter (Dawn-backed, linux-arm64 prebuilts)

### Known limitations
- Single-color render targets only (MRT lands in 0.1.0)
- No texture sampling helpers yet (lands in 0.1.0)
- API is unstable; expect breaking changes before 0.1.0
