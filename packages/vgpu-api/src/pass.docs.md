# Pass

Fullscreen-fragment render unit created by `gpu.pass()`. Use it for post-processing, gradients, blurs, and screen/target copies; use `gpu.draw()` for meshes, vertex buffers, instancing, or explicit vertex counts.

## Import

```ts
import type { Pass, PassOptions } from "vgpu";
```

## Signature

```ts
import type { DrawCallOptions, Target } from "vgpu";

type SetBag = Record<string, unknown>;

interface PassOptions {
  readonly set?: SetBag;
  readonly label?: string;
}

interface Pass {
  readonly gpu: GPURenderPipeline | undefined;
  set(values: SetBag): this;
  draw(opts?: DrawCallOptions & { readonly target?: Target }): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.pass.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. If no `@vertex` entry exists, vgpu injects a fullscreen triangle vertex stage and provides `@location(0) uv`. |
| gpu.pass.opts | `PassOptions` | ✖ | `{}` | Initial options. Passing a `mesh` property is rejected; pass has no vertex buffers. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Same as one initial `.set(opts.set)` call: establishes first-set binding ownership in the main API and validates reflected bindings. |
| opts.label | `string` | ✖ | `"pass"` | Used in shader reflection labels, GPU object labels, and `VGPU-*` error `where` fields. |
| pass.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are lib-owned; resources are user-owned. |
| pass.draw.opts | `DrawCallOptions & { target?: Target }` | ✖ | `{}` | One-shot render pass. `target` defaults to `gpu.screen`; required in headless/offscreen contexts. |

**Returns:** `gpu.pass()` returns `Pass`; `pass.set()` returns the same `Pass`; `pass.draw()` returns `void` after starting a one-shot draw path.

**Throws:** `VGPU-RING1-UNSUPPORTED` when `gpu.pass()` receives mesh/vertex data or when one-shot `draw()` has no target; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-R1-BINDING-NEVER-SET` when a reflected binding has no value at draw time; `VGPU-R1-OWNERSHIP-FLIP` when a binding switches between JS-value and resource ownership. `pass.draw()` discards the underlying `Draw.draw()` promise, so do not use it when manual bind-group validation needs to be normal control flow; use `Draw.draw()` directly or submit through `gpu.frame(...)` and `await frame.done` instead.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [64, 64] });
const target = gpu.target({ size: [64, 64] });
const pass = gpu.pass(`
  struct Params { time: f32, speed: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1);
  }
`, { label: "wave", set: { params: { time: 0, speed: 2 } } });

pass.set({ params: { time: gpu.time, speed: 2 } });
gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(pass)));
```

```ts
import { init } from "vgpu/mock";

const gpu = await init({ size: [32, 32] });
const target = gpu.target({ size: [32, 32] });
const copy = gpu.pass(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv.x, uv.y, 0.0, 1.0);
  }
`);
copy.draw({ target });
```

## Notes

- A fragment-only pass is internally implemented as a `Draw` with an injected fullscreen triangle.
- `Pass.gpu` is `undefined` until a target-specific pipeline has been compiled.
- Do not rely on implicit uniforms like time or resolution; pass `gpu.time`, `target.size`, or `target.texelSize` explicitly through `set()`.
- **See also:** `Gpu.pass`, `Draw`, `FramePass.draw`, `Target`, `SharedUniforms`.
