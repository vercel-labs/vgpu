# Getting started

Start with the public `vgpu` package. A program has one `Gpu` context, explicit WGSL bindings, and explicit frames. There are no global uniforms: time comes from JavaScript (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`) and resolution comes from targets (`target.size`, `target.texelSize`).

```ts
import { init } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const gradient = gpu.effect(`
struct Params { time: f32, texel: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
}
`, { set: { params: { time: 0, texel: surface.texelSize } } });

surface.onResize(() => {
  gradient.set({ params: { texel: surface.texelSize } });
});

gpu.frame.loop((frame) => {
  gradient.set({ params: { time: gpu.time } });
  frame.pass(surface, gradient);
});
```

Two habits keep this correct as it grows: bindings are set by their WGSL
names — `params` is a struct, so its members nest inside it — and `set()`
writes immediately, so the render loop only writes what actually changes
(`time`); size-class values like `texel` belong in the resize handler.

## Default choices

- Use `gpu.effect()` for fullscreen fragment work.
- Use `gpu.draw()` for vertex shaders, meshes, storage-driven vertices, instancing, MRT, and depth.
- Use `effect.draw(target)` for simple single-pass draws; use `gpu.frame((f) => ...)` to batch multi-pass work and `gpu.frame.loop(...)` for animation.
- Use `set()` for every binding declared in WGSL; missing bindings fail with `VGPU-R1-BINDING-NEVER-SET`.
- Keep plain JS values plain from their first `set()`; if you need user-owned lifetime, pass a resource from the first `set()`.

## Where to go next

Read the concept guides in order — each builds on the previous one:

```sh
vgpu docs cat concepts-context.md         # the Gpu context, surfaces, targets
vgpu docs cat concepts-draws.md           # gpu.draw, meshes, instancing
vgpu docs cat concepts-compilation.md     # compile() and pipeline warmup
vgpu docs cat concepts-effects.md         # fragment effects and set()
vgpu docs cat concepts-passes.md          # frame.pass and multi-pass work
vgpu docs cat concepts-frames.md          # frame batching and animation loops
vgpu docs cat concepts-render-bundles.md  # record draws once, replay cheap
```

For performance work and testing:

```sh
vgpu docs cat /guides/performance-model.docs.md
vgpu docs cat /guides/performance-patterns.docs.md
vgpu docs cat browser-testing
```
