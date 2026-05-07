# wireframeMaterial

`wireframeMaterial` renders a mesh as line segments, which is useful for visualizing geometry edges during development.

```ts
import { Mesh } from "@vgpu/render";
import { meshToWireframe, wireframeMaterial } from "@vgpu/render/inspect";

const mesh = Mesh.box({ device });
const wireframe = await meshToWireframe(mesh, device);
const material = wireframeMaterial({ device, color: [1, 1, 1] });
```

The pipeline uses `line-list` topology with depth testing on and no back-face culling. It expects the same interleaved position and normal vertex layout as `Mesh.box`.

`color` defaults to `[1, 1, 1]` in linear RGB. `targetFormat` defaults to `'bgra8unorm-srgb'`; use `'rgba8unorm-srgb'` on platforms that require it.

The returned `InspectMaterial` is for low-level draws. Pair it with `meshToWireframe`, bind a uniform buffer at group 0, then issue an indexed line-list draw.
