---
title: Mapping inventory fixture
description: Every mechanical mapping of Decision 2.4 in one page, with real corpus lines.
---

Every block below is copied from the real vgpu corpus (`docs/topics/**`,
`packages/**/*.docs.md`) so the gate exercises the exact strings that ship, not
paraphrases. Line references point at `origin/main`.

## M1 — `Good to know:` blockquote (5 occurrences)

> Good to know: [`FramePass.draw()`](/reference/vgpu/frame#framepass) accepts a fullscreen [`Effect`](/reference/vgpu/effect#effect) or an explicit [`Draw`](/reference/vgpu/draw#draw). Use `draw(gpu)` when you need meshes, vertex counts, instancing, or raw bind groups.

> Good to know: surface formats are platform-dependent — `bgra8unorm` on most browsers, `rgba8unorm` on others. Compiling the wrong signature doesn't error; it's just a warm-up you didn't need, and the real draw compiles lazily on first use anyway. When in doubt, compile against the actual target.

## M2 — `Warning:` blockquote (2 occurrences)

> Warning: one-shot `draw()` calls do not join a surrounding frame — inside a frame callback they submit on their own immediately. Inside `frame(gpu)`, always draw through `frame.pass()`.

> Warning: Do not call `frame(gpu)` from inside another frame callback or from a surface resize callback. vgpu throws `VGPU-FRAME-REENTRANT` so command encoders stay ordered and predictable.

## M3 — blockquote with no recognized prefix (stays a blockquote)

> **Want fBM, turbulence, ridged noise, or domain warping?** Those are
> compositions, not primitives: they live in the noise guide, not in this
> module. Read it with
> `npx vgpu docs cat /@vgpu/wgsl-std/noise/perlin/index.docs.md`. Stay here only for cells, edges
> and the raw gradient field.

## M4 — ` ```terminal ` fence (19 occurrences, breaks the build unmapped)

```terminal
npx vgpu doctor
```

```terminal
npx vgpu docs find "render bundle"
npx vgpu docs cat /guides/getting-started.docs.md
```

## M5 — alias fences

```sh
pnpm add vgpu
```

```typescript
const gpu = await createContext();
```

## M6 — languages Shiki already knows (ts / wgsl / json)

```ts
import { frame, surface } from "vgpu";

const view = surface(gpu, canvas);
frame(gpu, (f) => {
  const pass = f.pass({ target: view, clear: [0, 0, 0, 1] });
  pass.draw(effect);
});
```

```wgsl
fn perlin_2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot_grad(i, f), dot_grad(i + vec2(1.0, 0.0), f - vec2(1.0, 0.0)), u.x),
             mix(dot_grad(i + vec2(0.0, 1.0), f - vec2(0.0, 1.0)),
                 dot_grad(i + vec2(1.0, 1.0), f - vec2(1.0, 1.0)), u.x), u.y);
}
```

```json
{ "vgpu": { "adapter": "node" } }
```

## M7 — relative `*.docs.md` links (52 occurrences) and the code-span trap

The entry path is resolved on disk and may omit `.wgsl` when a matching file or `index.wgsl` exists. Pass `rootDir` when your modules use `@/foo.wgsl` aliases. Full parameters, the return shape, and every `VGPU-WGSL-*` error code live in the [`resolveShader` reference](/@vgpu/wgsl/runtime/resolve-shader.docs.md) (`npx vgpu docs cat /@vgpu/wgsl/runtime/resolve-shader.docs.md`).

- [Getting started](getting-started.docs.md)
- [Two-pass rendering](two-pass-rendering.docs.md)
- [Frames](concepts-frames.docs.md)
- [Browser testing](browser-testing.docs.md)
- [No bundler](/guides/no-bundler.docs.md)

Reference-style definition and its usage: see the [shader workflow guide][workflow].

[workflow]: shader-workflow.docs.md

## M8 — absolute logical links without the `/docs` prefix (33 occurrences)

- [`FramePass`](/reference/vgpu/frame#framepass)
- [Effects](/reference/vgpu/effect#effect)
- [Concepts: draws](/concepts/draws)
- [Quickstart: Browser](/ml/browser)
- [Buffers & ownership](/ml/buffers)
- [Air painting example](/examples/air-painting) — must stay outside `/docs`
- [Examples gallery](/examples)

## M9 — anchor-only links (31 occurrences, untouched)

- [`FramePass`](#framepass)
- [`FramePassOptions`](#framepassoptions)

## M10 — the one empty link in the corpus

- [broken]()

## External links (untouched)

- [WebGPU spec](https://www.w3.org/TR/webgpu/)
- [mailto](mailto:docs@example.com)
