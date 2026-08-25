# vgpu

[![npm version](https://img.shields.io/npm/v/vgpu.svg)](https://www.npmjs.com/package/vgpu)
[![CI](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/vgpu.svg)](../../LICENSE)

vgpu is a TypeScript library for WebGPU: typed shader imports, a tiny gpu-first API, and the same code running in the browser, headless Node, and your test suite. Ship a 25 KB effect, not a 500 KB engine.

## Install

```bash
pnpm add vgpu
pnpm add -D @webgpu/types
```

## Quick Start

```ts
import { clock, init, effect, frameLoop, surface } from "vgpu";
import waveShader from "./wave.wgsl";

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
const wave = effect(gpu, waveShader, { set: { speed: 2 } });

const time = clock(gpu);
frameLoop(gpu, (frame) => {
  wave.set({ time: time.time });
  frame.pass(canvasSurface, wave);
});
```

The same `init`, `effect`, and `frame` calls run unchanged against `vgpu/node` (Dawn-backed, headless) and `vgpu/mock` (deterministic, no GPU hardware) — see the [Node quick start](../../README.md#node-quick-start) in the repo root.

## WGSL modules with typed imports

`.wgsl` files import and export like TypeScript modules. `@vgpu/wgsl-std` ships reusable declarations (hash, noise, color, sampling, ...) as named exports, and any `.wgsl` file can export its own `fn`, `struct`, or `const` for other shaders to import:

```wgsl
// grain.wgsl
import { hash2 } from "@vgpu/wgsl-std/hash";

export fn grain(uv: vec2f, time: f32) -> f32 {
  return hash2(uv * time).x;
}
```

Imports resolve at build time through typed WGSL reflection — no codegen step and no manual binding declarations to keep in sync.

## Why vgpu

- **One `Gpu` context.** `init()` returns a single handle; `draw`, `effect`, `frame`, `surface`, `target`, and every other entry point take it as their first argument. No facade, no hidden global state.
- **Typed WGSL imports.** Shaders import from `@vgpu/wgsl-std` or from each other, and reflection keeps binding names, types, and layouts correct without hand-written declarations.
- **Real tree-shaking.** Unused declarations are pruned before minification, so a single fullscreen effect ships in a 25 KB gzip budget instead of a 500 KB engine.
- **Multi-runtime by default.** The public API is one surface across the browser, headless Node (`vgpu/node`, Dawn-backed), and a deterministic mock (`vgpu/mock`) built for tests and CI.
- **Explicit frames.** `frame(gpu, (f) => f.pass(target, effect))` — passes, clears, and draws are all explicit calls, never implicit scene-graph state.

## Documentation

Guides and API reference ship inside the package and run fully offline through the CLI:

```bash
npx vgpu docs cat getting-started.md
npx vgpu docs find effect
```

Agents can use the same docs and verified examples through the public read-only MCP endpoint at
`https://vgpu.sh/api/mcp` with automatic or modern MCP protocol negotiation, or start the local
stdio server. Filesystem writes are opt-in; `--project-from-cwd` enables relative example downloads
on Linux and macOS:

```bash
npx vgpu mcp
npx vgpu mcp --project-from-cwd
```

Start with [`docs/topics/getting-started.docs.md`](../../docs/topics/getting-started.docs.md), then [`docs/topics/performance-playbook.docs.md`](../../docs/topics/performance-playbook.docs.md) for the defaults (bundles, target pre-warm, in-place `set()`, instancing, ping-pong, MSAA/depth) that shader authors should reach for from day one.

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, bundle budgets, and release flow.

## License

MIT — see [LICENSE](../../LICENSE).
