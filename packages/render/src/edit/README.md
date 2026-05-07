# Mesh editing

`@vgpu/render/edit` is the CPU-side mesh editing layer for `@vgpu/render`.
It uses a two-type model:

- `Mesh` is upload-ready render data.
- `EditableMesh` is a CPU-side mesh value for topology edits.

The bridge is explicit. Use `toEditable(mesh)` to enter the edit layer, then
`editable.toRenderMesh({ device })` to return to render data. Operators are
public free functions. Internally, `EditableMesh` uses an opaque half-edge
kernel. Advanced users can inspect `em.gpu.halfEdgeKernel`, but code that
mutates it is outside the public safety contract.

## Quick start

```ts
import { Mesh } from "@vgpu/render";
import { toEditable, extrude, bevel } from "@vgpu/render/edit";

const em = toEditable(Mesh.box({ device, size: 1 }));
const top = em.faces.scoreBy((f) => f.center[1]).top();
const raised = extrude(em, top, { distance: 0.4 });
const rounded = bevel(raised.mesh, raised.descendants.capRing, { offset: 0.04 });
const mesh = rounded.mesh.toRenderMesh({ device });
```

## Operator examples

```ts
const result = extrude(em, em.faces.scoreBy((f) => f.center[1]).top(), { distance: 0.25 });
```

```ts
const result = bevel(em, em.hardEdges, { offset: 0.05, segments: 1 });
```

```ts
const result = inset(em, em.faces.byIndex([0]), { thickness: 0.2, depth: 0.03 });
```

```ts
const result = subdivideEdges(em, em.edges.byIndex([0, 1]), { cuts: 1 });
```

```ts
const result = subdivideFaces(em, em.faces.byIndex([0]));
```

```ts
const seedEdge = em.edges.scoreBy((e) => Math.abs(e.direction[1])).top().indices[0];
const result = loopCut(em, seedEdge, { cuts: 1 });
```

```ts
const loops = em.edges.loop(firstEdge); // ordered edge selection
const result = bridge(em, loops);
```

```ts
const result = fillHole(em, boundaryLoop);
```

```ts
const result = gridFill(em, boundaryLoop);
```

```ts
const result = dissolveVertices(em, em.vertices.byIndex([0]));
```

```ts
const result = dissolveEdges(em, em.edges.byIndex([0]));
```

```ts
const result = dissolveFaces(em, em.faces.byIndex([0, 1]));
```

```ts
const result = mergeByDistance(em, em.vertices.all(), { threshold: 0.001 });
```

```ts
const result = healManifold(em);
```

```ts
const result = recomputeNormals(em, { creaseAngle: Math.PI / 6 });
```

Each topology operator returns `{ mesh, descendants }`. Thread `result.mesh` into
the next operation and use descendant selections when the next step should target
new geometry.

## Hard edges and normals

Hard edges are first-class. Edge views expose `isSharp`; face views expose
`useSmooth`. `toEditable(mesh, { creaseAngle })` detects sharp edges by face angle.
The default crease angle is 30 degrees (`Math.PI / 6`).

`bevel` marks new bevel boundaries sharp by default (`markSharp: true`).
`recomputeNormals` rebuilds normals while respecting hard edges and smooth faces.
Tangents are stripped on entry to the edit layer; apply tangent generation after
`toRenderMesh` if the final material needs tangents.

## Diagnostics

Errors throw `MeshEditError`. Error codes are:

- `NON_MANIFOLD`
- `STALE_SELECTION`
- `EMPTY_SELECTION`
- `WRONG_DOMAIN`
- `NOT_ORDERED`
- `DEGENERATE_RESULT`
- `AMBIGUOUS_TOPOLOGY`
- `UNSUPPORTED_INPUT`

Warnings are `MeshEditWarning` values returned in `warnings` when an operation can
continue with a degraded result. Warning codes are:

- `NON_MANIFOLD_EDGE_SKIPPED`
- `NON_MANIFOLD_VERTEX_SKIPPED`
- `DEGENERATE_FACE_DROPPED`
- `TANGENTS_STRIPPED`
- `BEVEL_ACUTE_CLAMPED`
- `INSET_OVERLAP_CLAMPED`
- `SEAM_DESTROYED`
- `BRIDGE_LOOP_LENGTH_MISMATCH`
- `FILL_NON_PLANAR_BOUNDARY`
- `LOOP_CUT_AMBIGUOUS_CONTINUATION`
- `FILL_HOLE_TRIANGULATED`
- `GRID_FILL_TRIANGULATED`
- `DISSOLVE_FACES_RETRIANGULATED`
- `MERGE_DEGENERATE_FACES_REMOVED`
- `HEAL_NON_MANIFOLD_RESIDUE`

## Selection API

Selections are anonymous values, not named groups. Author selections from the
sets attached to an editable mesh:

- `em.vertices`
- `em.edges`
- `em.faces`

Each set supports:

- `where((view) => boolean)`
- `byIndex(indices)`
- `all()`
- `none()`
- `loop(seedEdge)` for edge loops
- `ring(seedEdge)` for edge rings
- `grow(selection, layers?)`
- `shrink(selection, layers?)`
- `boundaryOf(selection)`
- `connectedComponentOf(seedIndex)`

Use `scoreBy` for deterministic natural-language style picks:

```ts
const topFace = em.faces.scoreBy((f) => f.center[1]).top();
const largestThree = em.faces.scoreBy((f) => f.area).topN(3);
const upward = em.faces.scoreBy((f) => f.normal[1]).threshold(0.7);
const bottomVertex = em.vertices.scoreBy((v) => v.position[1]).bottom();
const twoLowest = em.vertices.scoreBy((v) => v.position[1]).bottomN(2);
```

Ties are broken by lowest index first.

## Performance

The public API is functional: operators return new `EditableMesh` values. This is
safer for pipelines, but each edit copies and rebuilds compact topology arrays.
Reference data is committed in `packages/render/perf-baselines/`:

- `long-pipeline.json` records 100 edits chosen from five operators.
- `extrude-box-face.txt` records a timing breakdown for extruding one box face.

This PR documents a 50% regression gate for future work. CI currently keeps a
loose runtime ceiling so platform noise does not block this first baseline.

## Limitations

The v1 kernel stores triangles only. Operators that conceptually create or remove
n-gons retriangulate deterministically and may warn with:

- `FILL_HOLE_TRIANGULATED`
- `GRID_FILL_TRIANGULATED`
- `DISSOLVE_FACES_RETRIANGULATED`

Full quad and n-gon preservation is planned as future work. Named selection groups,
CSG, GPU-resident editing, and full subdivision-surface evaluation are also out of
scope for v1.
