# Getting started

Start with the public `vgpu` package. A program has one `Gpu` context, explicit WGSL bindings, and explicit frames. There are no global uniforms: time comes from JavaScript (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`) and resolution comes from targets (`target.size`, `target.texelSize`).

```text
import { init } from "vgpu";

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });
const screen = surface!;
const gradient = gpu.pass(`
struct Params { time: f32, texel: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time) * 0.5 + 0.5, 1.0);
}
`, { set: { time: 0, texel: screen.texelSize } });

gpu.frame.loop((f) => {
  gradient.set({ time: gpu.time, texel: screen.texelSize });
  f.pass({ target: screen }, (p) => p.draw(gradient));
});
```

## Default choices

- Use `gpu.pass()` for fullscreen fragment work.
- Use `gpu.draw()` for vertex shaders, meshes, storage-driven vertices, instancing, MRT, and depth.
- Use `gpu.frame((f) => ...)` for explicit one-shot work and `gpu.frame.loop(...)` only for animation.
- Use `set()` for every binding declared in WGSL; missing bindings fail with `VGPU-R1-BINDING-NEVER-SET`.
- Keep plain JS values plain from their first `set()`; if you need user-owned lifetime, pass a resource from the first `set()`.

## Open concrete docs

```sh
vgpu docs cat /guides/performance-model.docs.md
vgpu docs cat /guides/performance-patterns.docs.md
vgpu docs cat browser-testing
```
