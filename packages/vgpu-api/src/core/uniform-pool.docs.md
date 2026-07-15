# `UniformPool`, `UniformLayout`, `UniformSlot`

`UniformPool` is the ring allocator used for many per-object uniforms with dynamic offsets. A slot is allocated from a real `UniformLayout<T>`: it must declare `size` and `encode(value, dst, byteOffset)`; optionally share `bindGroupLayout` with `draw.layout(group, { dynamicOffsets: true })`.

```ts
import { UniformPool, type UniformLayout } from "vgpu/core";

type ObjectUniforms = { model: Float32Array };
const objectLayout: UniformLayout<ObjectUniforms> = {
  size: 64,
  bindGroupLayout: cube.layout(1, { dynamicOffsets: true }),
  encode(value, dst, byteOffset) {
    new Float32Array(dst, byteOffset, 16).set(value.model);
  },
};
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc(objectLayout);
cube.group(1, slot.bindGroup);

gpu.frame.loop((f) => {
  pool.beginFrame(gpu.frameCount);
  f.pass({ target: scene }, (p) => {
    for (const obj of objects) {
      const offset = slot.push({ model: obj.model });
      p.draw(cube, { offsets: { 1: [offset] } });
    }
  });
  pool.endFrame();
});
```

Call `pool.beginFrame(frameIndex)` before pushes and `pool.endFrame()` before the frame submits. Use the returned offsets in `p.draw(draw, { offsets: { group: [offset] } })`.
