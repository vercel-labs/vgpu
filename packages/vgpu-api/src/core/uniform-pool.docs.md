# `UniformPool`

`UniformPool` is the ring allocator used for many per-object uniforms with dynamic offsets. Pair it with R4 group claim.

```ts
import { UniformPool } from "vgpu/core";
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc({ size: 64, bindGroupLayout: draw.layout(1, { dynamicOffsets: true }) });
draw.group(1, slot.bindGroup);
```
