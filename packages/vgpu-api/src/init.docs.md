# `init`

`init()` creates the ring-1 `Gpu` context. Browser, Node, and mock entrypoints return the same `Gpu` shape; the import is the only environment difference.

```ts
// Browser
import { init } from "vgpu";
const gpu = await init(canvas, { dpr: [1, 2], autoResize: true });

// Node / Dawn
import { init as initNode } from "vgpu/node";
const nodeGpu = await initNode({ size: [256, 256] });

// Mock tests
import { init as initMock } from "vgpu/mock";
const mockGpu = await initMock({ size: [64, 64] });
```

DPR is explicit and clamped by `dpr`. Every `.size` reports device pixels. `autoResize` defaults to true for canvas screens; set it to false when you want a user-owned resize timeline.

```ts
import { init } from "vgpu";

const gpu = await init(canvas, { autoResize: false, dpr: [1, 2] });
let pending: readonly [number, number] | null = null;
gpu.onResize((size) => { pending = size; });

function render() {
  if (pending) {
    gpu.screen!.resize(pending);
    pending = null;
  }
  gpu.frame((f) => f.pass({ target: gpu.screen! }, (p) => p.draw(wave)));
}
```

Time is not a binding. `gpu.time`, `gpu.deltaTime`, and `gpu.frameCount` are plain JS numbers that you pass explicitly through `set()`.

## Ownership and performance defaults

- WGSL is the source of truth. Declare every `@group/@binding` in the shader and bind by name with `set()`.
- JS values passed to `set()` are lib-owned and are written in-place (R1/R2), so animated uniforms do not recreate bind groups.
- Resources (`Uniform`, storage buffers, textures, targets, samplers, claimed bind groups) are user-owned; vgpu only binds their identity.
- Time is explicit JS (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`). Resolution lives on targets (`target.size`, `target.texelSize`).
