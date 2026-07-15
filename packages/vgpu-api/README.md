# vgpu

> 0.0.8 — public main API (`vgpu`) preview

`vgpu` is the public package for the new API. It is built around one `Gpu` context, explicit WGSL reflection, and `set()` ownership rules that make the fast path the default.

## Install

```bash
pnpm add vgpu
pnpm add -D @webgpu/types
```

## Entry points and layers

- **main API (`vgpu`)**: `init`, `Gpu`, `pass`, `draw`, `compute`, `frame`, `bundle`, `target`, `pingPong`, `uniforms`.
- **core layer (`vgpu/core`)**: device/resource escape hatches, native handles, bind groups, `Uniform`, `UniformPool`, storage buffers.
- **scene helpers (`vgpu/scene`)**: pure geometry and camera helpers. No scene graph and no material layer.

## Browser quick start

```ts
import { init } from "vgpu";

const gpu = await init(canvas, { dpr: [1, 2] });
const wave = gpu.pass(/* wgsl */ `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * .5 + .5, 1);
}
`, { set: { speed: 2 } });

gpu.frame.loop(() => {
  wave.set({ time: gpu.time });
  wave.draw();
});
```

## Node quick start

```ts
import { init } from "vgpu/node";

const gpu = await init({ size: [256, 256] });
const target = gpu.target({ format: "rgba8unorm" });
const tri = gpu.draw({ shader: TRIANGLE_WGSL });
gpu.frame((f) => f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(tri)));
const pixels = await target.read();
gpu.dispose();
```

## Performance defaults

Read `docs/topics/performance-playbook.docs.md` before writing shader code. It documents bundles, target pre-warm, R4 dynamic offsets, in-place `set()`, bake, instancing, shared uniforms, ping-pong, and MSAA/depth as defaults rather than late optimizations.

## WGSL imports

For app projects that import `.wgsl` files, add:

```ts
/// <reference types="vgpu/client" />
```

Runtime reflection remains the source of truth for binding names, types, and layouts.
