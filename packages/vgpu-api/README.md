# vgpu

> 0.0.8 — ring-1 public API spine

This package owns the bare `vgpu` specifier for the public ring-1 API. Phase 2
freezes the `Gpu`/`Pass`/`Draw`/`Target`/`Frame` shape and the `set()` ownership
engine used by downstream lanes.

## Exports

- `vgpu` — browser entrypoint, `init(canvas, opts)` via `navigator.gpu`
- `vgpu/node` — Node/Dawn entrypoint, `init({ size })`
- `vgpu/mock` — mock-adapter entrypoint for GPU-less tests
- `vgpu/scene` — scene helpers placeholder
- `vgpu/client` — client typing baseline for `.wgsl` imports and Vite WGSL plugin passthrough

## WGSL import typing

Create a `vgpu-env.d.ts` file in app projects that import `.wgsl` modules:

```ts
/// <reference types="vgpu/client" />
```

This is intentionally a loose `*.wgsl` string import type. Runtime reflection remains the source of truth for binding names, types, and layouts.

## Frozen Phase-2 surface

- `init(canvasOrOpts, opts?) -> Promise<Gpu>`
- `Gpu`: `.device`, `.gpu`, `.screen?`, `.time`, `.deltaTime`, `.frameCount`,
  `.pass()`, `.draw()`, `.target()`, callable `.frame()` plus `.frame.loop()`,
  `.sampler()`, `.mesh()`, `.onResize()`, `.dispose()`
- Reserved method names for lanes: `.compute()`, `.storage()`, `.pingPong()`,
  `.pingPongStorage()`, `.uniforms()`, `.bundle()` with Phase-3 lane signatures
  frozen and explicit `VGPUError` placeholders.
- `Pass`: `.set(bag)`, `.draw(opts?)`, `.gpu`; creation `{ set }` is exactly an
  initial `.set()`.
- `Draw`: `.set(bag)`, `.draw(opts?)`, `.group(n, bg)`, `.layout(n)`, per-draw
  `{ offsets }`, `.targets?`, and internal `.__recordedIn` bundle back-reference
  registry for Lane D staleness tracking. The registry receives structured
  `BundleStaleEvent` records only when a binding identity changes; JS value
  writes stay bundle-safe.
- `Target`: `.size`, `.texelSize`, `.color`, `.colors[]`, `.depth`, `.resize()`,
  `.read()`, `.gpu`, `.sampleCount`; `msaa: true | 4` creates real 4x MSAA
  attachments and resolves into sampleable `.color` / `.colors[]` textures. Device
  capability is consulted: Dawn compatibility mode rejects `rgba16float + msaa`
  with a `VGPUError` fix-it instead of silently degrading, while capable devices
  keep the by-example HDR+MSAA contract.
- `Frame`: `.pass({ target, clear }, cb)` with one encoder / N passes / one submit
- Bind-group cache API: `getOrCreate(drawId, group, identityTuple, factory)` with
  eviction by resource identity destroy hooks
- Browser resize: `autoResize` defaults to true, applies canvas framebuffer size
  on frame boundaries, and `onResize()` is notified for explicit or automatic
  `screen.resize()` changes.

## Ownership rules

`set()` latches ownership per binding on first write:

- JS-plain value -> lib-owned buffer; writes happen in-place and keep bind groups stable.
- ring-0 / target / texture / sampler resource -> user-owned; vgpu only binds it.
- changing ownership later throws the canonical R1 fix-it error.
- missing bindings, including samplers, throw at draw time; vgpu never creates phantom resources.
- `draw.group(n, bindGroup)` claims the whole group; later `set()` for that group is an error.
