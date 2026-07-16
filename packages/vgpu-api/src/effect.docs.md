# Effect

Fullscreen-fragment render unit created by `gpu.effect()`. Use it for post-processing, gradients, blurs, and screen/target copies; use `gpu.draw()` for meshes, vertex buffers, instancing, or explicit vertex counts.

## Import

```ts
import type { Effect, EffectOptions } from "vgpu";
```

## Signature

```ts
import type { DrawCallOptions, Target } from "vgpu";

type SetBag = Record<string, unknown>;

interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
}

interface Effect {
  readonly gpu: GPURenderPipeline | undefined;
  set(values: SetBag): this;
  draw(opts?: DrawCallOptions & { readonly target?: Target }): void;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.effect.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. If no `@vertex` entry exists, vgpu injects a fullscreen triangle vertex stage and provides `@location(0) uv`. |
| gpu.effect.opts | `EffectOptions` | ✖ | `{}` | Initial options. Passing a `mesh` property is rejected; effects have no vertex buffers. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Same as one initial `.set(opts.set)` call: establishes first-set binding ownership and validates reflected bindings. |
| opts.label | `string` | ✖ | `"effect"` | Used in shader reflection labels, GPU object labels, and `VGPU-*` error `where` fields. |
| effect.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are lib-owned; resources are user-owned. |
| effect.draw.opts | `DrawCallOptions & { target?: Target }` | ✖ | `{}` | One-shot render pass. `target` must be supplied explicitly. |
| opts.target | `Target` | ✖ | — | Required at runtime for one-shot draws. Use a `Surface` or an offscreen `Target`. |

**Returns:** `gpu.effect()` returns `Effect`; `effect.set()` returns the same `Effect`; `effect.draw()` returns `void` after starting a one-shot draw path.

**Throws:** `VGPU-TARGET-REQUIRED` when `effect.draw()` is called without `target`; `VGPU-RING1-UNSUPPORTED` when `gpu.effect()` receives mesh/vertex data; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-R1-BINDING-NEVER-SET` when a reflected binding has no value at draw time; `VGPU-R1-OWNERSHIP-FLIP` when a binding switches between JS-value and resource ownership. `effect.draw()` discards the underlying `Draw.draw()` promise, so do not use it when manual bind-group validation needs to be normal control flow; use `Draw.draw()` directly or submit through `gpu.frame(...)` and `await frame.done` instead.

## Examples

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const target = gpu.target({ size: [64, 64] });
const effect = gpu.effect(`
  struct Params { time: f32, speed: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1);
  }
`, { label: "wave", set: { params: { time: 0, speed: 2 } } });

effect.set({ params: { time: gpu.time, speed: 2 } });
gpu.frame((frame) => frame.pass({ target }, (p) => p.draw(effect)));
```

```ts
import { init } from "vgpu/mock";

const gpu = await init();
const target = gpu.target({ size: [32, 32] });
const copy = gpu.effect(`
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv.x, uv.y, 0.0, 1.0);
  }
`);
copy.draw({ target });
```

## Notes

- A fragment-only effect is internally implemented as a `Draw` with an injected fullscreen triangle.
- There is no implicit screen target. Browser code should create a `Surface` and pass it as `target`.
- Do not rely on implicit uniforms like time or resolution; pass `gpu.time`, `target.size`, or `target.texelSize` explicitly through `set()`.
- **See also:** `Gpu.effect`, `Draw`, `FramePass.draw`, `Surface`, `Target`, `SharedUniforms`.
