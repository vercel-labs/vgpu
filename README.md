# vgpu

[![npm version](https://img.shields.io/npm/v/vgpu.svg)](https://www.npmjs.com/package/vgpu)
[![CI](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/vgpu.svg)](./LICENSE)

vgpu is a TypeScript library for WebGPU: typed shader imports, a tiny gpu-first API, and the same code running in the browser, headless Node, and your test suite. Ship a 25 KB effect, not a 500 KB engine.

## Quick Start

```bash
pnpm add vgpu
pnpm add -D @webgpu/types
```

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

### Node quick start

The same API runs headless, against a Dawn-backed device:

```ts
import { draw, frame, init, target } from "vgpu/node";
import triangleShader from "./triangle.wgsl";

const gpu = await init();
const colorTarget = target(gpu, { size: [256, 256], format: "rgba8unorm" });
const triangle = draw(gpu, { shader: triangleShader });

frame(gpu, (f) => f.pass(colorTarget, triangle));
const pixels = await colorTarget.read();
gpu.dispose();
```

`vgpu/mock` swaps in a deterministic software adapter for the same code, so tests never need a GPU.

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

- **One `Gpu` context.** `init()` returns a single handle; every entry point (`draw`, `effect`, `frame`, `surface`, `target`, ...) takes it as its first argument. No facade, no hidden global state.
- **Typed WGSL imports.** Shaders import from `@vgpu/wgsl-std` or from each other, and reflection keeps binding names, types, and layouts correct without hand-written declarations.
- **Real tree-shaking.** Unused declarations are pruned before minification, so a single fullscreen effect ships in a 25 KB gzip budget instead of a 500 KB engine.
- **Multi-runtime by default.** One public API surface across the browser, headless Node (`vgpu/node`, Dawn-backed), and a deterministic mock (`vgpu/mock`) built for tests and CI.

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

Start with [`docs/topics/getting-started.docs.md`](./docs/topics/getting-started.docs.md), then [`docs/topics/performance-playbook.docs.md`](./docs/topics/performance-playbook.docs.md) for the defaults (bundles, target pre-warm, in-place `set()`, instancing, ping-pong, MSAA/depth) that shader authors should reach for from day one.

## Packages

This is a monorepo. The public entry point is `vgpu`; everything else backs it or ships independently.

| Package | What it is |
| --- | --- |
| [`vgpu`](./packages/vgpu-api/README.md) | Public main API: `init`, `draw`, `compute`, `effect`, `frame`, `bundle`, `target`, `uniforms`, plus `scene` and `core` subpaths. |
| [`@vgpu/cli`](./packages/vgpu/README.md) | The `vgpu` command-line binary: docs, shader `check`, `doctor`, and Dawn/software-renderer setup. |
| [`@vgpu/core`](./packages/core/README.md) | Low-level WebGPU wrappers (`Device`, `Buffer`, `Texture`, bind groups) behind `vgpu/core`. |
| [`@vgpu/wgsl`](./packages/wgsl/README.md) | Turns `.wgsl` files into JS modules and resolves WGSL-to-WGSL imports before bundling. |
| [`@vgpu/wgsl-std`](./packages/wgsl-std/README.md) | Standard WGSL utility modules (math, color, sampling, noise, hash, ...). |
| [`@vgpu/adapter-node`](./packages/adapter-node/README.md) | Dawn-backed adapter used by `vgpu/node`. |
| [`@vgpu/adapter-mock`](./packages/adapter-mock/README.md) | Deterministic mock adapter used by `vgpu/mock`. |
| [`@vgpu/render`](./packages/render/README.md) | Slim edit/inspect/utils/perf helpers outside the main rendering surface. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup, bundle budgets, and release flow.

## License

MIT — see [LICENSE](./LICENSE).
