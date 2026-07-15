# Mesh editing

`@vgpu/render/edit` is the CPU-side mesh editing layer for mesh-like render data.
`Mesh` is upload-ready render data; `EditableMesh` is a CPU-side topology value.
Use `toEditable(mesh)` to enter the edit layer and `editable.toRenderMesh({ device })`
to return to render data. Operators are public free functions and return new
`EditableMesh` values.

## Escape hatch

`em.gpu.halfEdgeKernel` is an opaque internal handle. Advanced users who need the
mutable kernel must explicitly opt in by importing the internal helper
`@vgpu/render/src/edit/kernel-handle.ts` and calling `unwrapKernel(handle)`. Code
that unwraps the handle is outside the public safety contract.

## Quick start

```ts
import { box } from "vgpu/scene";
import { toEditable, extrude, bevel } from "@vgpu/render/edit";

const em = toEditable(gpu.mesh(box({ size: 1 })));
const top = em.faces.scoreBy((f) => f.center[1]).top();
const raised = extrude(em, top, { distance: 0.4 });
const rounded = bevel(raised.mesh, raised.boundaryEdges, { offset: 0.04 });
const mesh = rounded.mesh.toRenderMesh({ device });
```

## Operators

```ts
extrude(em, faces, opts);          // { mesh, sideFaces, capFaces, boundaryEdges, warnings? }
bevel(em, edges, opts);            // { mesh, newFaces, originalFaces, profileLoops, warnings? }
inset(em, faces, opts);            // { mesh, insetFaces, boundaryFaces, rimEdges, warnings? }
subdivideEdges(em, edges, opts);   // { mesh, newVertices, newEdges }
subdivideFaces(em, faces, opts);   // { mesh, newFaces, newEdges }
loopCut(em, seedEdge, opts);       // { mesh, insertedLoop }
bridge(em, loops, opts);           // { mesh, bridgeFaces, chosenTwist }
dissolveVertices(em, vertices);    // { mesh, surroundingFaces, warnings? }
dissolveEdges(em, edges);          // { mesh, mergedFaces, warnings? }
dissolveFaces(em, faces);          // { mesh, resultFace, warnings? }
mergeByDistance(em, { selection: em.vertices.all(), threshold: 0.001 });
fillHole(em, boundaryLoop);        // { mesh, newFaces, warnings? }
gridFill(em, boundaryLoop);        // { mesh, newFaces, warnings? }
healManifold(em);                  // { mesh, report, warnings? }
recomputeNormals(em, opts);        // EditableMesh
```

Topology operators return `{ mesh, ...descendants }`. Thread `result.mesh` into
the next operation and use descendant selections when the next step should target
new geometry. `recomputeNormals` returns `EditableMesh` directly because it is a
pure attribute operation.

## Hard edges and normals

Hard edges are first-class. Edge views expose `isSharp`; face views expose
`useSmooth`. `toEditable(mesh, { creaseAngle })` detects sharp edges by face angle.
The default crease angle is 30 degrees (`Math.PI / 6`). `bevel` marks bevel strip
rim edges sharp by default (`markSharp: true`). `recomputeNormals` preserves
existing `isSharp` flags by default; passing `creaseAngle` explicitly re-runs
sharp-edge detection. Tangents are stripped on entry; apply tangent generation
after `toRenderMesh` if the final material needs tangents.

## Diagnostics

Errors throw `MeshEditError` with one of:

- `NON_MANIFOLD`
- `STALE_SELECTION`
- `EMPTY_SELECTION`
- `WRONG_DOMAIN`
- `NOT_ORDERED`
- `DEGENERATE_RESULT`
- `AMBIGUOUS_TOPOLOGY`
- `UNSUPPORTED_INPUT`

Warnings are `MeshEditWarning` values returned in `warnings` when an operation can
continue with a degraded result:

- `NON_MANIFOLD_EDGE_SKIPPED` — an edge was skipped because its topology is not supported.
- `NON_MANIFOLD_VERTEX_SKIPPED` — a vertex was skipped because its topology is not supported.
- `DEGENERATE_FACE_DROPPED` — a zero-area face was removed.
- `TANGENTS_STRIPPED` — tangent data was removed on entry to the edit layer.
- `BEVEL_ACUTE_CLAMPED` — bevel offset was clamped near an acute corner.
- `BEVEL_SEGMENTS_CLAMPED` — bevel `segments > 1` was clamped to one segment.
- `INSET_OVERLAP_CLAMPED` — inset thickness was clamped before faces crossed.
- `SEAM_DESTROYED` — position-only merge may destroy attribute seams.
- `BRIDGE_LOOP_LENGTH_MISMATCH` — bridge loops had different lengths.
- `FILL_NON_PLANAR_BOUNDARY` — fill boundary was not planar.
- `LOOP_CUT_AMBIGUOUS_CONTINUATION` — loop cut used the deterministic fallback.
- `FILL_HOLE_TRIANGULATED` — fill hole produced deterministic triangles.
- `GRID_FILL_TRIANGULATED` — grid fill produced deterministic triangles.
- `DISSOLVE_FACES_RETRIANGULATED` — face dissolve produced deterministic triangles.
- `MERGE_DEGENERATE_FACES_REMOVED` — merge removed faces that collapsed.
- `HEAL_NON_MANIFOLD_RESIDUE` — heal left some non-manifold residue.

## Selection API

Selections are anonymous values from `em.vertices`, `em.edges`, and `em.faces`.
Each set supports `where`, `byIndex`, `all`, `none`, `loop`, `ring`, `grow`,
`shrink`, `boundaryOf`, `connectedComponentOf`, and `scoreBy`. Scored selection
helpers are `top`, `topN`, `threshold`, `bottom`, and `bottomN`; ties are broken
by lowest index first.

## Performance

The public API is functional, so each edit copies and rebuilds compact topology
arrays. Reference data is committed in `packages/render/perf-baselines/`:

- `long-pipeline.json` records 100 edits chosen from five operators.
- `extrude-box-face.txt` records a timing breakdown for extruding one box face.

## Limitations

The v1 kernel stores triangles only. Operators that conceptually create or remove
n-gons retriangulate deterministically and may warn with:

- `FILL_HOLE_TRIANGULATED` — hole fill emits a triangle fan.
- `GRID_FILL_TRIANGULATED` — grid fill emits deterministic triangles.
- `DISSOLVE_FACES_RETRIANGULATED` — face dissolve emits deterministic triangles.
- `MERGE_DEGENERATE_FACES_REMOVED` — merge removes collapsed faces.
- `HEAL_NON_MANIFOLD_RESIDUE` — heal may leave residue for explicit follow-up.

Full quad and n-gon preservation is planned as future work. Named selection groups,
CSG, GPU-resident editing, and full subdivision-surface evaluation are also out of
scope for v1.

## Known limitations (v1)

- **Triangle-only kernel.** v1 stores triangles. Operators that produce n-gons
  (`fillHole`, `gridFill`, `dissolveFaces`) emit `*_TRIANGULATED` warnings and
  produce deterministic triangulations. Future: full quad/n-gon support — see
  [#44](https://github.com/vercel-labs/vgpu/issues/44).
- **Kernel structure.** The kernel today is an undirected-edge structure, not a
  true half-edge SoA. Operators that need twin/next/prev pointer integrity are
  not in v1 scope.
- **Bake to RenderMesh** emits per-face flat normals and does not partition
  incident faces by hard-edge / smooth-shading flags. `Mesh.box` round-trip is
  byte-equal because box is fully sharp-edged. Smooth-shaded round-trip is not
  supported in v1; output normals will be flat per face.
- **Bevel multi-segment.** v1 supports `segments: 1` only. `segments > 1` clamps
  with a `BEVEL_SEGMENTS_CLAMPED` warning.
- **See [#44](https://github.com/vercel-labs/vgpu/issues/44)** for the kernel +
  smooth-shading rebuild.
