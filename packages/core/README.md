# @vgpu/core

> 0.1.5 — core layer (`vgpu/core`) runtime primitives

`@vgpu/core` contains the low-level WebGPU wrappers used by `vgpu/core`: `Device`, `Buffer`, `Texture`, `Queue`, shader modules, bind-group helpers, resource identities, and validation errors. Most applications should start from `init()` in `vgpu`, `vgpu/node`, or `vgpu/mock` and drop to these primitives only for explicit native control.

## Install

```bash
pnpm add vgpu
```

## Use from the main API (`vgpu`)

```ts
import { init } from "vgpu/mock";
import { UniformPool } from "vgpu/core";

const gpu = await init();
const draw = gpu.draw({ shader: OBJ_WGSL });
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc({ size: 64, bindGroupLayout: draw.layout(1, { dynamicOffsets: true }) });
draw.group(1, slot.bindGroup);
```

Use raw `.gpu` handles deliberately. Wrapper lifecycle methods (`buffer.destroy()`, `texture.destroy()`, `device.destroy()`) remain preferred for resources created through vgpu.

## License

MIT.
