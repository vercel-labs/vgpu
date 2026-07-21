# Effect

Fullscreen-fragment render unit created by `gpu.effect()`. Use it for post-processing, gradients, blurs, and screen/target copies; use `gpu.draw()` for meshes, vertex buffers, instancing, or explicit vertex counts.

## Import

```ts
import type { Effect, EffectOptions } from "vgpu";
```

## Signature

```ts
import type { DrawCallOptions, Target, TargetSignature } from "vgpu";

type SetBag = Record<string, unknown>;

type BlendPreset = "alpha" | "additive" | "premultiplied";
interface BlendComponentOptions { readonly src: GPUBlendFactor; readonly dst: GPUBlendFactor; readonly op?: GPUBlendOperation; }
interface BlendOptions { readonly color: BlendComponentOptions; readonly alpha?: BlendComponentOptions; }

interface EffectOptions {
  readonly set?: SetBag;
  readonly label?: string;
  readonly blend?: BlendPreset | BlendOptions;
  readonly writeMask?: readonly ("r" | "g" | "b" | "a")[];
}

interface Effect {
  readonly gpu: GPURenderPipeline | undefined;
  set(values: SetBag): this;
  draw(target?: Target | DrawCallOptions): void;
  compile(target?: Target | TargetSignature): Promise<this>;
  compileSync(target?: Target | TargetSignature): this;
}
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---:|---|---|
| gpu.effect.source | `string \| ShaderSource` | ✔ | — | WGSL string or `ShaderSource`. If no `@vertex` entry exists, vgpu injects a fullscreen triangle vertex stage and provides `@location(0) uv`. |
| gpu.effect.opts | `EffectOptions` | ✖ | `{}` | Initial options. Passing a `mesh` property is rejected; effects have no vertex buffers. |
| opts.set | `Record<string, unknown>` | ✖ | `undefined` | Same as one initial `.set(opts.set)` call: establishes first-set binding ownership and validates reflected bindings. |
| opts.label | `string` | ✖ | `"effect"` | Used in shader reflection labels, GPU object labels, and `VGPU-*` error `where` fields. |
| opts.blend | `"alpha" \| "additive" \| "premultiplied" \| BlendOptions` | ✖ | `undefined` | Constructor-only blend state passed through to the fullscreen draw. Presets and defaults match `DrawOptions.blend`; omitted explicit `alpha` copies `color`, and `op` defaults to `"add"`. |
| opts.writeMask | `readonly ("r" \| "g" \| "b" \| "a")[]` | ✖ | all channels | Constructor-only color channel mask. Omit for RGBA; `[]` writes no channels; `["r","g","b"]` skips alpha. |
| effect.set.values | `Record<string, unknown>` | ✔ | — | Binding values by WGSL variable name. JS values are lib-owned; resources are user-owned. |
| effect.draw.target | `Target \| DrawCallOptions` | ✖ | `{}` | One-shot render pass. Pass a bare target for the common case, or an options bag when setting per-call draw options. |
| opts.target | `Target` | ✖ | — | Required at runtime when an options bag is used. Use a `Surface` or an offscreen `Target`. |

**Returns:** `gpu.effect()` returns `Effect`; `effect.set()` and `effect.compileSync()` return the same `Effect`; `effect.compile()` returns `Promise<this>`; `effect.draw()` returns `void` after starting a one-shot draw path.

**Throws:** `VGPU-TARGET-REQUIRED` when `effect.draw()` or compile pre-warm is called without `target`; `VGPU-BLEND-INVALID` for an unknown blend preset or malformed blend object; `VGPU-WRITEMASK-INVALID` for a non-array or unknown write mask channel; `VGPU-RING1-UNSUPPORTED` when `gpu.effect()` receives mesh/vertex data; `VGPU-SHADER-SOURCE-INVALID` for malformed `ShaderSource`; `VGPU-R1-BINDING-NEVER-SET` when a reflected binding has no value at draw time; `VGPU-R1-OWNERSHIP-FLIP` when a binding switches between JS-value and resource ownership; `VGPU-SET-TEXTURE-FILTERABILITY` when an ordinarily sampled facade texture is not filterable (structured detail names its format/binding and paired sampler; use a filterable format, request `float32-filterable`, or use `textureLoad` without a sampler). Asynchronous draw validation errors are delivered through `gpu.onError`; tests can `await gpu.settled()`.

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
gpu.frame((frame) => frame.pass(target, effect));
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
copy.draw(target);
```

## Pipeline pre-warm

Effects compile lazily for the target signature they draw into. Use `await effect.compile(target)` during loading to pre-warm without blocking, or `effect.compileSync(target)` when synchronous creation is acceptable. Signature objects follow the same shape as draws: `{ colors: ["bgra8unorm"], depth?, sampleCount? }`.

## Notes

- A fragment-only effect is internally implemented as a `Draw` with an injected fullscreen triangle. Fragment-only resources receive fragment visibility only, so storage does not consume `maxStorageBuffersInVertexStage`.
- `blend` and `writeMask` are immutable pipeline state, fixed at `gpu.effect()` construction, and apply uniformly to every color target. Use them for overlays, glow, UI, and other loaded-pass compositing. For explicit blends, `op` defaults to `"add"` and omitted `alpha` copies `color`.
- One-shot `effect.draw()` does not join a surrounding frame. Inside `gpu.frame()`, draw through `frame.pass()`.
- There is no implicit screen target. Browser code should create a `Surface` and pass it as `target`.
- Do not rely on implicit uniforms like time or resolution; pass `gpu.time`, `target.size`, or `target.texelSize` explicitly through `set()`.
- **See also:** `Gpu.effect`, `Draw`, `FramePass.draw`, `Surface`, `Target`, `SharedUniforms`.
