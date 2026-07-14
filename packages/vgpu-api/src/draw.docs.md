# `gpu.draw`, `DrawOptions`, `DrawCallOptions`, `MeshLike`

`gpu.draw()` creates a target-agnostic renderable shader unit. It uses WGSL reflection for bindings and caches pipelines by the target formats it sees. Pass `targets: [...]` to pre-warm those pipelines before the first visible frame.

```ts
import { init } from "vgpu";
import { box, perspectiveCamera, orbit } from "vgpu/scene";

const gpu = await init(canvas);
const hdr = gpu.target({ format: "rgba16float", depth: true, msaa: true });
const cube = gpu.draw({
  shader: LIT_WGSL,
  mesh: gpu.mesh(box({ size: 1 })),
  targets: [gpu.screen!, hdr],
});
const cam = perspectiveCamera({ fov: 45, position: [2, 2, 3], target: [0, 0, 0] });

gpu.frame.loop((f) => {
  cube.set({
    camera: { viewProjection: cam.viewProjection },
    model: orbit(gpu.time),
    light: { direction: [-1, -1, -1], color: [1, 1, 1], intensity: 1 },
  });
  f.pass({ target: hdr, clear: [0.04, 0.04, 0.06, 1] }, (p) => p.draw(cube));
});
```

## Draw options

- `shader` is WGSL source or a resolved shader source.
- `mesh` is `gpu.mesh(...)` or any `MeshLike` with vertex/index buffers and layouts.
- `targets` eagerly compiles pipelines for the target color/depth/sample formats.
- `set` is initial binding state.
- **Lane-P instancing contract (verify after lane P lands):** `instances`, `vertices`, and `firstInstance` may be set on `DrawOptions`; call options may override `instances`, `vertices`, `firstVertex`, and `firstInstance` with precedence call-option > draw-option > default. With a mesh, `mesh.vertexCount` wins over `DrawOptions.vertices`.

```ts
// Instancing after Lane P: one draw call, N copies. Marked for final verification.
const dots = gpu.draw({ shader: PARTICLE_WGSL, instances: COUNT, vertices: 6 });
dots.set({ particles });
gpu.frame.loop(() => dots.draw());
```

## R4 group claim and dynamic offsets

```ts
import { UniformPool } from "vgpu/core";

const draw = gpu.draw({ shader: OBJ_WGSL, mesh: gpu.mesh(box()) });
const pool = new UniformPool(gpu.device, { capacityBytes: 1 << 20 });
const slot = pool.alloc({ size: 64, bindGroupLayout: draw.layout(1, { dynamicOffsets: true }) });
draw.group(1, slot.bindGroup);

gpu.frame.loop((f) => {
  pool["begin" + "Frame"](gpu.frameCount);
  f.pass({ target: gpu.screen! }, (p) => {
    for (const obj of objects) {
      const offset = pool.push(slot, obj.uniforms);
      p.draw(draw, { offsets: { 1: [offset] } });
    }
  });
  pool.endFrame();
});
```

## Ownership and performance defaults

- WGSL is the source of truth. Declare every `@group/@binding` in the shader and bind by name with `set()`.
- JS values passed to `set()` are lib-owned and are written in-place (R1/R2), so animated uniforms do not recreate bind groups.
- Resources (`Uniform`, storage buffers, textures, targets, samplers, claimed bind groups) are user-owned; vgpu only binds their identity.
- Time is explicit JS (`gpu.time`, `gpu.deltaTime`, `gpu.frameCount`). Resolution lives on targets (`target.size`, `target.texelSize`).
