# vgpu

[![npm version](https://img.shields.io/npm/v/vgpu.svg)](https://www.npmjs.com/package/vgpu)
[![CI](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml/badge.svg)](https://github.com/vercel-labs/vgpu/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/vgpu.svg)](./LICENSE)

vgpu is a TypeScript library for WebGPU: typed shader imports, a tiny gpu-first API, and the same code running in the browser, headless Node, and your test suite.

- **Typed WGSL imports.** `.wgsl` files import and export like TypeScript modules, and reflection keeps binding names, types, and layouts correct without hand-written declarations.
- **One `Gpu` context.** `init()` returns a single handle; every entry point (`draw`, `effect`, `frame`, `surface`, `target`, ...) takes it as its first argument. No hidden global state.
- **Small by design.** Unused declarations are pruned before minification, and a complete fullscreen effect ships in 25 KB gzipped — a budget enforced in CI.
- **Multi-runtime by default.** One public API surface across the browser, headless Node (`vgpu/node`, Dawn-backed), and a deterministic mock (`vgpu/mock`) built for tests and CI.
- **Explicit frames.** `frame(gpu, (f) => f.pass(target, effect))` — passes, clears, and draws are explicit calls, never implicit scene-graph state.
- **Agent-ready.** Docs, the example gallery, and shader validation all run from the CLI (`npx vgpu docs`, `npx vgpu examples`, `npx vgpu check`), and [vgpu.sh](https://vgpu.sh) publishes `agents.md` and `llms.txt` for LLM consumption.

**View full documentation and examples on [vgpu.sh](https://vgpu.sh).**

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

In this example, `init()` acquires an adapter and device and returns the single `Gpu` context; every other entry point takes it as its first argument. `surface` wraps the canvas as a render target and keeps its size current, clamping the device-pixel ratio between 1 and 2. `effect` compiles the shader into a fullscreen effect whose uniforms are addressed by their WGSL names through `set()` — writes land immediately, so the loop only sets what changes each frame. `clock` provides frame time, and `frameLoop` runs the callback once per frame, where `frame.pass` draws the effect into the surface.

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

## Documentation

Full documentation lives on [vgpu.sh](https://vgpu.sh). Start with [Getting started](https://vgpu.sh/docs/get-started), then the [performance playbook](https://vgpu.sh/docs/guides/performance-playbook) for the defaults (bundles, target pre-warm, in-place `set()`, instancing, ping-pong, MSAA/depth) that shader authors should reach for from day one. [Interactive examples](https://vgpu.sh/examples) run in the browser, and their source is what `vgpu examples` serves.

The same guides and API reference also ship inside the package and run fully offline through the CLI:

```bash
npx vgpu docs cat getting-started.md
npx vgpu docs find effect
```

## Agent resources

vgpu is built to be operated by coding agents as well as people. The example gallery is searchable from the CLI, and any example's complete source can be copied locally without cloning the repository:

```bash
npx vgpu examples search "raymarching"
npx vgpu examples pull <id> --out ./example
```

Agents with skill support can install vgpu's thin documentation router. The skill contains no versioned API reference; it queries the docs bundled with the `vgpu` version installed in the project.

```bash
npx skills add vercel-labs/vgpu
```

- [Agent readiness manifest](https://vgpu.sh/agents.md) — how agents should discover and use vgpu
- [llms.txt](https://vgpu.sh/llms.txt) and [llms-full.txt](https://vgpu.sh/llms-full.txt) — documentation index and full export for LLMs
- [Examples discovery API](https://vgpu.sh/docs/examples-api) — tokenless and read-only, described by [OpenAPI](https://vgpu.sh/openapi.json)
- [MCP guide](https://vgpu.sh/docs/mcp) — connect agents to the public read-only endpoint at `https://vgpu.sh/api/mcp`, or run local stdio for package-versioned docs and opt-in example downloads

```bash
npx vgpu mcp
npx vgpu mcp --project-from-cwd
```

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
