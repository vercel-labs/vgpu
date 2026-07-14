# Authoring for performance

Use the ring-1 `vgpu` API. WGSL declares bindings, JavaScript passes values explicitly with `set()`, frames are on-demand, and target size is the source of resolution.

```ts
import { init } from "vgpu";

const gpu = await init(canvas, { dpr: [1, 2] });
const target = gpu.target({ format: "rgba16float", depth: true });
const pass = gpu.pass(`
struct Params { time: f32, texel: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time) * .5 + .5, 1);
}
`, { set: { texel: target.texelSize } });

gpu.frame.loop((f) => {
  pass.set({ time: gpu.time });
  f.pass({ target }, (p) => p.draw(pass));
});
```

## Defaults

- Use `gpu.frame(f => f.pass(...))` for multi-pass and for explicit one-shot bakes.
- Use `gpu.bundle()` when the same static draws replay for many frames.
- Use `targets: [...]` on `gpu.draw()` when the first visible frame cannot hitch.
- Use `gpu.uniforms()` for shared values consumed by multiple shaders.
- Use `draw.group()` plus dynamic offsets for hundreds or thousands of per-object uniforms.
- Use `gpu.pingPong()` / `gpu.pingPongStorage()` for iterative effects; R2 makes the two identities cheap.
