# Entity system

`world.mjs` is the application's entity system. It stores each entity's local transform, builds its
local and world matrices with the installed `math@0.1.0` package, and keeps hierarchy and lifecycle
bookkeeping. Treat it as an existing dependency: import it, do not edit it.

```js
import { createWorld } from "./ecs/world.mjs";

const world = createWorld({ capacity: 64 });
const cameraEntity = world.spawn({
  parent: null,
  position: [0, 0, 10],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  camera: { left: -4, right: 4, bottom: -3, top: 3, near: 0.1, far: 20 },
});
const crate = world.spawn({
  parent: null,
  position: [1, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [2, 1, 1],
  renderable: { size: [1, 0.5, 0.5], offset: [0, 0, 0], color: [255, 0, 0] },
});

const changedRows = world.update(); // [0, 1]: both world matrices were just computed
const row = world.rowOf(crate);
const crateWorld = world.worldMatrices.subarray(row * 16, row * 16 + 16); // column-major
```

## API

| Call | Result |
| --- | --- |
| `createWorld({ capacity = 64 })` | A new world with room for `capacity` live entities, an integer from 1 to 65535. |
| `spawn({ parent, position, rotation, scale, renderable?, camera? })` | Adds an entity and returns its handle. `parent` is a live handle or `null`. `position` and `scale` are 3 numbers, `rotation` is an XYZW quaternion. |
| `setPosition(handle, [x, y, z])` | Replaces the local position. |
| `setRotation(handle, [x, y, z, w])` | Replaces the local rotation. |
| `setScale(handle, [x, y, z])` | Replaces the local scale. |
| `setParent(handle, parentHandle \| null)` | Reparents the entity and keeps its local transform; its world matrix is recomputed under the new parent. Rejects self-parenting and cycles. |
| `despawn(handle)` | Removes the entity and all its descendants. |
| `isAlive(handle)` | `true` while the handle names a live entity. |
| `rowOf(handle)` | The entity's row in the matrix buffers. |
| `parentOf(handle)` | The parent's handle, or `null`. |
| `renderable(handle)` | The `{ size, offset, color }` copied at `spawn`, or `null`. |
| `camera(handle)` | The `{ left, right, bottom, top, near, far }` copied at `spawn`, or `null`. |
| `entities()` | Live handles in row order. |
| `update()` | Recomputes dirty matrices and returns the row numbers whose world matrix it recomputed, in ascending order. |

`spawn` and the setters copy their arrays. Calls that take a handle throw a `TypeError` for a
stale or unknown handle; `spawn` throws a `RangeError` when the world is full.

## Matrices

| Property | Contents |
| --- | --- |
| `localMatrices` | `Float32Array(capacity * 16)`; row `r` occupies `[16r, 16r + 16)`. |
| `worldMatrices` | `Float32Array(capacity * 16)`, same layout. |
| `worldVersion` | `Uint32Array(capacity)`; a row's value increases by one each time `update()` recomputes its world matrix. |

All three buffers are allocated once by `createWorld` and never replaced, so subarray views of them
stay valid for the world's lifetime. Matrices are column-major for column vectors.

`update()` rebuilds each dirty local as `T(position) · R(rotation) · S(scale)` and then computes
worlds parent-first as `world = parentWorld · local`. A change to an entity also marks all its
descendants. The world matrix is the full affine product, so a nonuniform parent scale shears a
rotated child. The setters, `spawn`, `setParent` and `despawn` only mark rows dirty: the matrix
buffers reflect the last `update()` call.

A renderable's `size`, `offset` and `color` are component data. They are never part of any local or
world matrix and never affect children.

## Handles and rows

A handle is generational: the upper bits hold a generation and the lower 16 bits the row
(`generation * 65536 + row`). Keep handles opaque and use `rowOf(handle)` to find a row.

Despawning frees rows. A later `spawn` reuses the most recently freed row first, with a new
generation, so the old handle becomes stale while a different entity occupies that row. Use
`entities()` and `isAlive()` to determine which handles are live.
