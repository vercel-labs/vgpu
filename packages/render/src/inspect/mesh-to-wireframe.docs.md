# meshToWireframe

`meshToWireframe(mesh, device)` converts a triangle-list `Mesh` into a line-list index buffer with duplicate edges removed by endpoint position.

```ts
import { Mesh } from "@vgpu/render";
import { meshToWireframe } from "@vgpu/render/inspect";

const mesh = Mesh.box({ device });
const wireframe = await meshToWireframe(mesh, device);

// wireframe.vertexBuffer is mesh.vertexBuffer
// wireframe.indexBuffer contains two indices per line segment
```

Edges are matched by endpoint positions within `1e-6`, regardless of vertex index. Coplanar triangle diagonals are omitted, so a unit box produces 12 line segments and 24 indices.

The function is asynchronous because general meshes may require GPU readback to inspect vertex positions. The built-in box mesh is reconstructed from its bounding box because its vertex buffer is not created for readback.
