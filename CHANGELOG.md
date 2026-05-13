## Unreleased

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
