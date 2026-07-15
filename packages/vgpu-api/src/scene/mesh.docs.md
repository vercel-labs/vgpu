# `Mesh` and `gpu.mesh()`

Scene geometry is pure data until `gpu.mesh()` uploads it. Use `gpu.draw()` for every mesh-backed shader.

```ts
import { box } from "vgpu/scene";
const cubeMesh = gpu.mesh(box({ size: 1 }));
const cube = gpu.draw({ shader: LIT_WGSL, mesh: cubeMesh, targets: [gpu.screen!] });
```

There is no material factory or scene graph. Your WGSL declares resources; `set()` supplies values by name.
