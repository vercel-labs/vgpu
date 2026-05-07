# meshToWireframe

`meshToWireframe(mesh, device)` converts a readable triangle-list `Mesh` into a
line-list index buffer with duplicate edges removed by endpoint position.

```ts
import { meshToWireframe } from "@vgpu/render/inspect";

const wireframe = await meshToWireframe(readableMesh, device);

// wireframe.vertexBuffer is readableMesh.vertexBuffer
// wireframe.indexBuffer contains two indices per line segment
```

The source mesh's vertex buffer must be created with `GPUBufferUsage.COPY_SRC`
so `meshToWireframe` can read back vertex positions. If the buffer is not
readable, the function throws `VGPU-CORE-INVALID-USAGE`; `Mesh.box` currently
does not satisfy this contract.

Endpoints are quantized to a `1e-6` grid before comparison. Meshes with distinct
features below that scale may have edges incorrectly merged, so author debug
geometry at a larger scale or use a precomputed wireframe for tiny details.

Coplanar triangle diagonals are omitted by comparing triangle face normals, so a
readable unit-box triangle list produces 12 line segments and 24 indices.

The returned `indexBuffer` is a raw `GPUBuffer`. Callers own its lifetime and
should call `indexBuffer.destroy()` when done, or rely on `device.destroy()` to
clean up at teardown.
