# @vgpu/render

> 0.1.6 — slim legacy/utility render package

New applications should use the public `vgpu` package. `@vgpu/render` remains as a slim package for edit/inspect/utils/perf helpers and compatibility while the old thick render surface is removed from the public path.

## What stays here

- `@vgpu/render/inspect`: wireframe/normal debug helpers and inspect materials.
- `@vgpu/render/edit`: mesh edit utilities.
- `@vgpu/render/utils`: canvas/mouse/frame-clock helpers that are independent from the main API (`vgpu`).
- `@vgpu/render/perf`: measurement utilities such as frame timing and pixel diff.

## Preferred rendering API

```ts
import { init, draw, frameLoop, surface } from "vgpu";

const gpu = await init();
const canvasSurface = surface(gpu, canvas);
const drawable = draw(gpu, { shader: WGSL, targets: [canvasSurface] });
frameLoop(gpu, (f) => f.pass({ target: canvasSurface }, (p) => p.draw(drawable)));
```

Keep performance-sensitive rendering in `vgpu`: use `bundle(gpu)` for static replay, `targets: [...]` for pipeline pre-warm, `uniforms(gpu)` for shared values, and `draw.group()` with dynamic offsets for many objects.

## License

MIT.
