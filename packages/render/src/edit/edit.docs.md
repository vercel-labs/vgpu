# @vgpu/render/edit

`@vgpu/render/edit` is the slim CPU-side mesh editing toolbox kept from the
render package. It accepts mesh-like vertex data, converts it to an `EditableMesh`,
runs topology operators, and bakes the result back into the mesh shape consumed
by `vgpu` draw/inspect tooling.

```ts
import { createMockAdapter } from "@vgpu/adapter-mock";
import { bevel, toEditable } from "@vgpu/render/edit";
import { init } from "vgpu/mock";
import { box } from "vgpu/scene";

const gpu = await init({ adapter: createMockAdapter() });
const editable = toEditable(gpu.mesh(box({ size: 1 })));
const beveled = bevel(editable, editable.hardEdges, { offset: 0.04 }).mesh;
const mesh = beveled.toRenderMesh({ device: gpu.device });
```

## EditableMesh

`EditableMesh.fromArrays({ positions, indices })` creates an editable half-edge
mesh from triangle arrays. An editable mesh exposes element sets (`vertices`,
`edges`, `faces`), counts, manifold metadata, and `toRenderMesh({ device })`.

`toEditable(mesh)` converts a mesh-like render object to an editable mesh.
`toEditableWithDiagnostics(mesh)` returns `{ mesh, warnings }`; for example,
tangent data is stripped because edit operations rebuild position/normal topology.

## Operators

Topology operators return `{ mesh, ...selectionInfo }` results so callers can
highlight generated faces/edges in inspection tools:

- `extrude`, `bevel`, `inset`
- `subdivideEdges`, `subdivideFaces`, `loopCut`
- `bridge`, `fillHole`, `gridFill`
- `dissolveVertices`, `dissolveEdges`, `dissolveFaces`
- `mergeByDistance`, `healManifold`, `recomputeNormals`

Use selections from `editable.vertices`, `editable.edges`, and `editable.faces`
to target operators. Bake once at the end of a pipeline instead of rebuilding a
render mesh after every operator.
