# @vgpu/render

> 0.1.2 — slim legacy/utility render package

New applications should use the public `vgpu` package. `@vgpu/render` remains as a slim package for edit/inspect/utils/perf helpers and compatibility while the old thick render surface is removed from the public path.

## What stays here

- `@vgpu/render/inspect`: wireframe/normal debug helpers and inspect materials.
- `@vgpu/render/edit`: mesh edit utilities.
- `@vgpu/render/utils`: canvas/mouse/frame-clock helpers that are independent from the main API (`vgpu`).
- `@vgpu/render/perf`: measurement utilities such as frame timing and pixel diff.

## Preferred rendering API

```ts
import { init } from "vgpu";

const gpu = await init();
const surface = gpu.surface(canvas);
const draw = gpu.draw({ shader: WGSL, targets: [surface] });
gpu.frame.loop((f) => f.pass({ target: surface }, (p) => p.draw(draw)));
```

Keep performance-sensitive rendering in `vgpu`: use `gpu.bundle()` for static replay, `targets: [...]` for pipeline pre-warm, `gpu.uniforms()` for shared values, and `draw.group()` with dynamic offsets for many objects.

## License

MIT.
