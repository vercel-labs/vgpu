---
title: External hierarchy
summary: Evaluate parent-child transforms stored in application-owned arrays.
---

# hierarchyOrder

Validates a dense parent-index array and compiles it into an opaque `HierarchyOrder` token for `evaluateHierarchy`. Build it once per topology — at load time and again whenever any parent link changes.

## Import

```ts
import { hierarchyOrder } from "vgpu/scene";
```

## Signature

```ts
declare function hierarchyOrder(parents: Int32Array): import("vgpu/scene").HierarchyOrder;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| parents | `Int32Array` | ✔ | — | One entry per row: `-1` for a root, otherwise the index of the parent row in `0..n-1`. Rows may appear in any order (a child may precede its parent) and there may be any number of roots. An empty array is valid. Copied: later changes to your array do not affect the token. |

**Returns:** `HierarchyOrder` — an opaque, frozen token whose only public field is `size` (the row count). It privately holds a copy of `parents`, a parent-before-child traversal order, and reusable scratch memory.

**Throws:**
- `VGPU-SPATIAL-PARENT` when `parents[row]` is below `-1` or at least `parents.length` — the message names the row and value; use `-1` for a root or a valid row index.
- `VGPU-SPATIAL-CYCLE` when a row is its own parent or several rows form a cycle — the message lists the implicated rows; remove the cyclic parent links before compiling.

## Examples

```ts
import { hierarchyOrder } from "vgpu/scene";

// row 0: base (root), row 1: upper arm, row 2: forearm, row 3: a second, unrelated root
const parents = new Int32Array([-1, 0, 1, -1]);
const order = hierarchyOrder(parents);
console.log(order.size); // 4
```

## Notes

- Cost: O(n) time plus a few `Int32Array`/`Uint8Array` allocations of size n. Keep the token and reuse it every frame; do not rebuild it per frame unless the topology actually changes.
- After any change to `parents`, build a new token and run a full evaluation (omit `changed`). Evaluating with the old token throws `VGPU-SPATIAL-ORDER`.
- The token has no mutable rows or traversal data; you cannot inspect or edit the compiled order.
- **See also:** `evaluateHierarchy`, `HierarchyOrder`, `HierarchyEvaluation`.

---

# evaluateHierarchy

Computes world matrices for a flat hierarchy stored in packed arrays: `worlds[row] = worlds[parent] × locals[row]`, or `locals[row]` for roots. Use it for large or externally owned hierarchies (imported skeletons, ECS data, physics-driven rigs) where one `SceneNode` object per row is unnecessary.

## Import

```ts
import { evaluateHierarchy } from "vgpu/scene";
```

## Signature

```ts
declare function evaluateHierarchy(input: import("vgpu/scene").HierarchyEvaluation): number;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| input.order | `HierarchyOrder` | ✔ | — | Token from `hierarchyOrder(parents)`. Hand-made objects are rejected. |
| input.parents | `Int32Array` | ✔ | — | Exactly `order.size` entries, identical to the array the token was compiled from. Read-only. |
| input.locals | `Float32Array` | ✔ | — | Exactly `16 * order.size` values: one column-major local matrix per row. Read-only. Assumed finite and affine; not validated per call. |
| input.worlds | `Float32Array` | ✔ | — | Exactly `16 * order.size` values. Written for every recomputed row; rows that are not recomputed are read (as parent worlds) and left as they are. |
| input.changed | `Uint8Array` | ✖ | omitted: recompute every row | Exactly `order.size` flags; nonzero marks a row whose local matrix changed. Marked rows and every descendant of a recomputed row are recomputed. Never modified. |
| input.updated | `Uint8Array` | ✖ | omitted: no report | Exactly `order.size` flags. Every entry is overwritten: `1` for rows recomputed by this call, `0` for all others. |

**Returns:** `number` — how many world rows this call recomputed, including descendants reached through propagation. `0` for an empty hierarchy or when no flag is set.

**Throws:** all checks run before any write, so `worlds` and `updated` are untouched when the call throws.
- `VGPU-SPATIAL-ORDER` when `order` was not created by `hierarchyOrder`, or `parents` differs from the compiled copy — the message names the first differing row; rebuild with `hierarchyOrder(parents)`, then run a full evaluation without `changed`.
- `VGPU-SPATIAL-SIZE` when `parents`, `changed` or `updated` does not have exactly `order.size` entries, or `locals` or `worlds` does not have exactly `16 * order.size` — the message states the actual and required length; allocate exact lengths (use `subarray` to trim a larger buffer).
- `VGPU-SPATIAL-ALIAS` when `worlds` or `updated` overlaps the other output or any input array in memory — use non-overlapping byte ranges for the writable outputs.

## Examples

Initialize with a full evaluation, then recompute only what changed:

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder } from "vgpu/scene";

const parents = new Int32Array([-1, 0, 1]); // base → upper arm → forearm
const rowCount = parents.length;
const locals = new Float32Array(rowCount * 16);
const worlds = new Float32Array(rowCount * 16);
const localRow = (row: number) => locals.subarray(row * 16, row * 16 + 16);

composeMatrix({ position: [0, 0.5, 0] }, localRow(0));
composeMatrix({ position: [0, 1, 0] }, localRow(1));
composeMatrix({ position: [0, 1, 0] }, localRow(2));

const order = hierarchyOrder(parents);
evaluateHierarchy({ order, parents, locals, worlds }); // full evaluation: returns 3

const changed = new Uint8Array(rowCount);
composeMatrix({ position: [0, 1, 0], rotation: [0, 0, 0.4] }, localRow(1));
changed[1] = 1; // you must mark every row whose local you wrote
const recomputed = evaluateHierarchy({ order, parents, locals, worlds, changed }); // 2: upper arm + forearm
changed.fill(0); // evaluateHierarchy never clears your flags
void recomputed;
```

Change the topology — rebuild the token and evaluate everything:

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder } from "vgpu/scene";

const parents = new Int32Array([-1, 0, 1]);
const locals = new Float32Array(3 * 16);
const worlds = new Float32Array(3 * 16);
for (let row = 0; row < parents.length; row++) {
  composeMatrix({}, locals.subarray(row * 16, row * 16 + 16));
}
let order = hierarchyOrder(parents);
evaluateHierarchy({ order, parents, locals, worlds });

parents[2] = 0; // reparent the forearm onto the base
order = hierarchyOrder(parents); // the old token now throws VGPU-SPATIAL-ORDER
evaluateHierarchy({ order, parents, locals, worlds }); // full evaluation after a topology change
```

Report which rows need re-upload, using disjoint views of one buffer:

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder } from "vgpu/scene";

const rowCount = 2;
const parents = new Int32Array([-1, 0]);
const matrices = new Float32Array(rowCount * 32); // locals then worlds in one allocation
const locals = matrices.subarray(0, rowCount * 16);
const worlds = matrices.subarray(rowCount * 16); // disjoint from locals: allowed
const changed = new Uint8Array(rowCount);
const updated = new Uint8Array(rowCount);
const order = hierarchyOrder(parents);
for (let row = 0; row < rowCount; row++) {
  composeMatrix({}, locals.subarray(row * 16, row * 16 + 16));
}

evaluateHierarchy({ order, parents, locals, worlds, updated }); // updated = [1, 1]
changed[1] = 1;
evaluateHierarchy({ order, parents, locals, worlds, changed, updated }); // updated = [0, 1]
```

## Notes

- Full evaluation first: omit `changed` after creating a token, after a topology change, and whenever `worlds` is a new, reset, or externally overwritten buffer. With `changed`, clean rows keep whatever `worlds` already holds and children of clean rows read that stored parent world, so stale or zeroed rows stay stale.
- Dirty marking is your responsibility: vgpu cannot detect a local row you wrote without setting its flag. `evaluateHierarchy` does not clear `changed`; reset it yourself after the call.
- Cost: every call compares `parents` with the compiled copy and scans all n rows in parent-before-child order (O(n)), then performs one 4×4 multiply (or a 16-value copy for roots) per recomputed row. There is no partial traversal and no sparse-only path; a single changed root recomputes its whole subtree.
- Aliasing: the writable outputs `worlds` and `updated` must not share any byte with each other or with `parents`, `locals` or `changed` — checked by byte range, so overlapping `subarray` views of one buffer are rejected while disjoint views are allowed. Read-only inputs may overlap each other.
- No output state is retained: the token does not remember `worlds` or whether a buffer was initialized, so the same token can drive several output buffers as long as each gets its own full evaluation first.
- `locals` are trusted for speed: non-finite or non-affine rows are not detected and propagate into `worlds`. Validate data from untrusted sources before writing it, or write rows with `composeMatrix`/`localFromWorld`, which validate.
- Calls are synchronous; mutating the arrays concurrently (for example from a worker through a `SharedArrayBuffer`) is not supported.
- **See also:** `hierarchyOrder`, `HierarchyEvaluation`, `composeMatrix`, `localFromWorld`, `SceneNode`.

---

# HierarchyOrder

The opaque compiled-topology token returned by `hierarchyOrder`. Pass it back to `evaluateHierarchy` unchanged; its only public field is the row count.

## Import

```ts
import type { HierarchyOrder } from "vgpu/scene";
```

## Signature

```ts
interface HierarchyOrder {
  readonly size: number;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| size | `number` | ✔ | — | Number of rows compiled into the token (`parents.length` at compile time). |

**Returns:** Not a callable.

**Throws:** None by itself; `evaluateHierarchy` throws `VGPU-SPATIAL-ORDER` for any object not produced by `hierarchyOrder`, even one with a matching `size`.

## Examples

```ts
import { hierarchyOrder, type HierarchyOrder } from "vgpu/scene";

const order: HierarchyOrder = hierarchyOrder(new Int32Array([-1, 0, 0]));
const rowCount = order.size; // 3
const worlds = new Float32Array(rowCount * 16);
void worlds;
```

## Notes

- Do not construct `{ size }` objects yourself; they cannot carry the compiled topology.
- The token is frozen and holds private copies, so it stays valid until you stop referencing it. Memory is released when the token is garbage-collected.
- **See also:** `hierarchyOrder`, `evaluateHierarchy`.

---

# HierarchyEvaluation

The input object for `evaluateHierarchy`: a compiled order, its parents, packed local and world matrices, and optional dirty flags in and out.

## Import

```ts
import type { HierarchyEvaluation } from "vgpu/scene";
```

## Signature

```ts
interface HierarchyEvaluation {
  order: import("vgpu/scene").HierarchyOrder;
  parents: Int32Array;
  locals: Float32Array;
  worlds: Float32Array;
  changed?: Uint8Array;
  updated?: Uint8Array;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| order | `HierarchyOrder` | ✔ | — | From `hierarchyOrder(parents)`. |
| parents | `Int32Array` | ✔ | — | Length n; must equal the compiled parents exactly. Read-only. |
| locals | `Float32Array` | ✔ | — | Length 16n; finite affine column-major matrices. Read-only. |
| worlds | `Float32Array` | ✔ | — | Length 16n; output. Must not overlap any other field. |
| changed | `Uint8Array` | ✖ | omitted: recompute all rows | Length n; nonzero = local changed. Read-only; never cleared by vgpu. |
| updated | `Uint8Array` | ✖ | omitted: no report | Length n; output, fully overwritten with `1`/`0`. Must not overlap any other field. |

**Returns:** Not a callable.

**Throws:** None by itself; see `evaluateHierarchy` for `VGPU-SPATIAL-ORDER`, `VGPU-SPATIAL-SIZE` and `VGPU-SPATIAL-ALIAS`.

## Examples

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder, type HierarchyEvaluation } from "vgpu/scene";

const parents = new Int32Array([-1, 0]);
const locals = new Float32Array(2 * 16);
for (let row = 0; row < parents.length; row++) {
  composeMatrix({}, locals.subarray(row * 16, row * 16 + 16));
}
const skeleton: HierarchyEvaluation = {
  order: hierarchyOrder(parents),
  parents,
  locals,
  worlds: new Float32Array(2 * 16),
};
evaluateHierarchy(skeleton); // full evaluation
skeleton.changed = new Uint8Array(2);
evaluateHierarchy(skeleton); // later frames: set flags, evaluate, clear flags
```

## Notes

- The object fields are mutable so an app may attach or replace `changed`; the typed arrays remain app-owned. Omit `changed` whenever a full evaluation is required.
- **See also:** `evaluateHierarchy`, `hierarchyOrder`, `HierarchyOrder`.
