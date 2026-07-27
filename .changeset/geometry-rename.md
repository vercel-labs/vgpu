---
"vgpu": minor
---

**BREAKING:** the low-level GPU vertex/index resource is now called `Geometry`, freeing the name `Mesh` for the renderable scene-tree node (`mesh(geometry, material)` in `vgpu/scene`, the three.js acception). This is a clean break at 0.2.0 — the old names are removed, there are no deprecated aliases.

| Old (0.1.x) | New (0.2.0) |
|---|---|
| `gpu.mesh(geometry)` / `gpu.mesh(options)` | `gpu.geometry(descriptor)` / `gpu.geometry(options)` |
| `DrawOptions.mesh` | `DrawOptions.geometry` |
| `Mesh` | `Geometry` |
| `MeshOptions` | `GeometryOptions` |
| `MeshLike` | `GeometryLike` |
| `MeshBuffer` / `MeshBufferOptions` | `GeometryBuffer` / `GeometryBufferOptions` |
| `MeshSlice` / `MeshSliceOptions` | `GeometrySlice` / `GeometrySliceOptions` |
| `MeshAttributes` / `MeshAttributeOverride` / `MeshData` | `GeometryAttributes` / `GeometryAttributeOverride` / `GeometryData` |
| `slice.mesh` (parent back-reference) | `slice.geometry` |
| `SceneMesh` (`vgpu/scene`) | `Geometry` (re-exported as a type from `vgpu/scene`) |

Migration:

```ts
// before
import type { Mesh, MeshLike, MeshSlice } from "vgpu";
const cube: Mesh = gpu.mesh(box({ size: 1 }));
const half = cube.slice({ vertexCount: 18 });
const draw = gpu.draw({ shader, mesh: cube });

// after
import type { Geometry, GeometryLike, GeometrySlice } from "vgpu";
const cube: Geometry = gpu.geometry(box({ size: 1 }));
const half = cube.slice({ vertexCount: 18 });
const draw = gpu.draw({ shader, geometry: cube });
```

`SceneGeometry` (the pure, device-agnostic descriptor produced by `box()`, `sphere()`, …) keeps its name, and the scene-tree `mesh()` / `MeshNode` exports of `vgpu/scene` are unchanged. Error codes stay `VGPU-MESH-*` (they are scope-bound identifiers), but their `where`/message text now teaches the new names — e.g. `gpu.geometry`, `geometry.slice`, `GeometryLike.vertexCount`.

Also in 0.2.0, scene cameras and controls validate their inputs instead of silently producing broken matrices — these are observable behavior changes for call sites that were passing degenerate values:

- `perspectiveCamera()` validates `aspect` (must be positive and finite) in the constructor and in `set()`. Call sites that passed `canvas.width / canvas.height` without clamping (zero-sized canvas → `0` or `Infinity`) now throw `VGPU-SCENE-VALUE-INVALID` instead of producing `Infinity`-filled projection matrices.
- `orthographicCamera()` rejects empty or non-finite extents (`left === right`, `top === bottom`, `NaN`, …). Inverted ranges are still legal — they remain the supported way to Y-flip.
- Orbit controls and lights reject non-finite values (`NaN`/`Infinity`) instead of poisoning transforms and light blocks.
