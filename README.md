# vgpu

> 0.1.3 — early preview of the new public `vgpu` API

vgpu is an agentic-first WebGPU library for browsers, Node/Dawn, and deterministic mock tests. The public package is `vgpu`: one `Gpu` context with explicit WGSL reflection and performance-oriented defaults.

## Packages

| Package | What it is |
| --- | --- |
| [`vgpu`](./packages/vgpu-api/README.md) | Public main API (`vgpu`): `init`, `pass`, `draw`, `compute`, `frame`, `bundle`, `target`, `uniforms`, scene and core subpaths. |
| [`@vgpu/core`](./packages/core/README.md) | core layer (`vgpu/core`) resource wrappers and native WebGPU escape hatches. |
| [`@vgpu/render`](./packages/render/README.md) | Slim edit/inspect/utils/perf package for helpers outside the new rendering surface. |
| [`@vgpu/wgsl`](./packages/wgsl/README.md) | WGSL modules, reflection, runtime resolution, and loaders. |
| [`@vgpu/wgsl-std`](./packages/wgsl-std/README.md) | Standard WGSL utility modules. |
| [`@vgpu/adapter-node`](./packages/adapter-node/README.md) | Dawn-backed adapter used by `vgpu/node`. |
| [`@vgpu/adapter-mock`](./packages/adapter-mock/README.md) | Mock adapter used by `vgpu/mock`. |

## Install

```bash
pnpm add vgpu
pnpm add -D @webgpu/types
```

## Browser quick start

```ts
import { init } from "vgpu";

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const wave = gpu.effect(WAVE_WGSL, { set: { speed: 2 } });
gpu.frame.loop(() => {
  wave.set({ time: gpu.time });
  wave.draw();
});
```

## Node quick start

```ts
import { init } from "vgpu/node";

const gpu = await init();
const target = gpu.target({ size: [256, 256], format: "rgba8unorm" });
const draw = gpu.draw({ shader: TRIANGLE_WGSL, targets: [target] });
gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(draw)));
const pixels = await target.read();
gpu.dispose();
```

## Performance playbook

Start with `docs/topics/performance-playbook.docs.md`. It makes bundles, target pre-warm, dynamic offsets, in-place `set()`, bake, instancing, shared uniforms, ping-pong, and MSAA/depth the default implementation style for shader authors.

## Releasing

Releases are triggered by GitHub Releases. Bump package versions, commit the bumps, create a release tag, and let the release workflow publish packages with provenance.

## License

MIT — see [LICENSE](./LICENSE).
