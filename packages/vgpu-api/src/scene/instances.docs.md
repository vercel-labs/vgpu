# instances

Creates a fixed-capacity collection of instance records: one world matrix plus your typed per-instance attributes, packed for upload. Use it for large populations of the same mesh (trees, particles, crowd agents, debris) where one `SceneNode` per object is unnecessary.

## Import

```ts
import { instances } from "vgpu/scene";
```

## Signature

```ts
declare function instances<const A extends import("vgpu/scene").InstanceAttributes = {}>(options: {
  capacity: number;
  attributes?: A;
}): import("vgpu/scene").InstanceCollection<A>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| options.capacity | `number` | ✔ | — | Maximum number of live instances. A nonnegative integer; `0` is valid (every `add()` then throws `VGPU-INSTANCE-CAPACITY`). Fixed for the life of the collection: there is no growth. |
| options.attributes | `InstanceAttributes` | ✖ | `{}` | Per-instance attributes in declaration order. Each value is an `InstanceFormat` string (required on `add`) or `{ format, default }` (optional on `add`). Names must not be numeric and must not be `world0`, `world1`, `world2` or `world3`, which are reserved for the world matrix columns. Snapshotted: later changes to this object or its default arrays have no effect. |

**Returns:** `InstanceCollection<A>` — an empty collection (`count` is `0`) whose `add`, `set` and value types are inferred from `attributes`. You do not need `as const`.

**Throws:**
- `VGPU-INSTANCE-CAPACITY` when `capacity` is negative, fractional, `NaN`, `Infinity`, or so large that `capacity × stride` bytes cannot be represented — pass a nonnegative integer sized for your peak population.
- `VGPU-INSTANCE-ATTRIBUTE` when an attribute has an unknown format, a numeric name, or a reserved `world0`–`world3` name — use one of the 12 `InstanceFormat` values and rename the key.
- `VGPU-INSTANCE-VALUE` when a `default` does not match its format: wrong arity (a number for a vector format, an array for a scalar, or the wrong length), a non-finite or float32-overflowing float, or a non-integer or out-of-range integer — the message names the attribute path; supply a default of the exact format.

## Examples

One required attribute and one defaulted attribute:

```ts
import { instances } from "vgpu/scene";

const trees = instances({
  capacity: 1024,
  attributes: {
    windPhase: "float32", // required on add()
    tint: { format: "float32x3", default: [0.3, 0.6, 0.2] }, // optional on add()
  },
});

const oak = trees.add({ windPhase: 0.4 }); // tint uses the default, world is identity
const birch = trees.add({ windPhase: 1.7, tint: [0.8, 0.8, 0.7] });
trees.setWorld(oak, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, -2, 1]); // translate to (4, 0, -2)
console.log(trees.count, trees.slotOf(birch)); // 2, 1
```

A collection without attributes stores only world matrices, and `add()` takes no argument:

```ts
import { instances } from "vgpu/scene";

const rocks = instances({ capacity: 64 });
const boulder = rocks.add(); // identity world
rocks.setWorld(boulder, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]); // uniform scale 2
```

## Notes

- Record layout: each record starts with the 64-byte column-major world matrix, followed by your attributes in declaration order, tightly packed at 4-byte alignment (4 bytes per component, no padding to 16). The stride is `64 + 4 × (total attribute components)`: `windPhase: "float32"` plus `tint: "float32x3"` gives an 80-byte record, with `windPhase` at byte 64 and `tint` at byte 68.
- Fixed capacity: memory for `capacity` records is allocated once. When you outgrow it, create a larger collection, re-add your instances (which issues new `InstanceId`s), re-create any `bindWorld` sources and GPU bridges, and switch your draws to the new ones.
- Types check scalar versus vector and the attribute names; they cannot check vector length, because vector values are `ArrayLike<number>`. The runtime checks exact arity on every write. A `default`'s shape is not checked against its `format` by the types either.
- The collection is CPU-only. It never uploads: nothing reaches the GPU until a GPU bridge publishes it (`instanceGeometry(gpu, collection, { mesh })` from `vgpu/scene/gpu`, whose reference documents publication ordering).
- **See also:** `InstanceCollection`, `InstanceAttributes`, `InstanceFormat`, `InstanceId`, `evaluateHierarchy`, `group`.

---

# InstanceCollection

A dense, fixed-capacity store of instance records created by `instances()`. Each live instance has an opaque `InstanceId` handle and a current slot in `0..count-1`; the handle is stable while the instance lives, the slot is not.

## Import

```ts
import type { InstanceCollection } from "vgpu/scene";
```

## Signature

```ts
interface InstanceCollection<A extends import("vgpu/scene").InstanceAttributes = {}> {
  readonly capacity: number;
  readonly count: number;
  add(...args: import("vgpu/scene").InstanceAddArgs<A>): import("vgpu/scene").InstanceId;
  remove(id: import("vgpu/scene").InstanceId): void;
  set(id: import("vgpu/scene").InstanceId, values: Partial<import("vgpu/scene").InstanceValues<A>>): void;
  setWorld(id: import("vgpu/scene").InstanceId, world: ArrayLike<number>): void;
  setWorlds(ids: ArrayLike<import("vgpu/scene").InstanceId>, worlds: Float32Array, firstRow?: number): void;
  bindWorld(id: import("vgpu/scene").InstanceId, source: () => ArrayLike<number>): void;
  unbindWorld(id: import("vgpu/scene").InstanceId): void;
  syncWorlds(): number;
  slotOf(id: import("vgpu/scene").InstanceId): number;
  idAt(slot: number): import("vgpu/scene").InstanceId;
}
```

## Parameters

| Member | Type | Required | Default | Notes |
|---|---|---|---|---|
| capacity | `number` | — | from `instances()` | Read-only. Maximum live instances; never changes. |
| count | `number` | — | `0` | Read-only. Live instances, stored densely in slots `0..count-1`. |
| add(values) | `InstanceInitialValues<A>` | ✔ when any attribute has no `default`, otherwise ✖ | omitted fields use their `default`; world is identity | Appends a record and returns its new `InstanceId`. Unknown and missing required fields are rejected. Validates every field before writing, so a failed `add` leaves `count` unchanged. |
| remove(id) | `InstanceId` | ✔ | — | Swap-remove: the record in the last slot is copied into the removed slot and `count` drops by 1. The moved instance keeps its `InstanceId` but its slot changes. Drops the removed instance's `bindWorld` source. The removed `id` is never valid again and never reused. |
| set(id, values) | `InstanceId, Partial<InstanceValues<A>>` | ✔ | — | Patches attributes: omitted fields keep their values. All fields are validated before any is written. Allowed on world-bound instances. Cannot write the world; use `setWorld`, `setWorlds` or `bindWorld`. |
| setWorld(id, world) | `InstanceId, ArrayLike<number>` | ✔ | — | Copies one world matrix: exactly 16 column-major values, finite and float32-representable, with bottom row (indices 3, 7, 11, 15) exactly `0, 0, 0, 1`. Shear and reflection are allowed. Rejected on a world-bound instance. |
| setWorlds(ids, worlds, firstRow) | `ArrayLike<InstanceId>, Float32Array, number` | ids ✔, worlds ✔, firstRow ✖ | firstRow `0` | Copies `ids[i]`'s world from `worlds` row `firstRow + i` (elements `(firstRow + i) × 16` to `+16`). Validates the whole batch — every handle, duplicates, bound state, the range and every matrix — before copying any row. An empty `ids` is valid and changes nothing. |
| bindWorld(id, source) | `InstanceId, () => ArrayLike<number>` | ✔ | — | Registers a synchronous accessor that `syncWorlds()` reads. Does not call `source`; the world keeps its current value until the next `syncWorlds()`. |
| unbindWorld(id) | `InstanceId` | ✔ | — | Removes the source. The world keeps the last copied value. A no-op for a live, unbound instance. |
| syncWorlds() | — | — | — | Calls every bound source once and copies its result into that instance's world. Never uploads. |
| slotOf(id) | `InstanceId` | ✔ | — | Current slot of a live instance. Changes when another instance is removed. |
| idAt(slot) | `number` | ✔ | — | The `InstanceId` currently in `slot`; `slot` must be an integer in `0..count-1`. |

**Returns:** `add` returns the new `InstanceId`. `syncWorlds` returns the number of sources it copied. `slotOf` returns a slot number and `idAt` an `InstanceId`. `remove`, `set`, `setWorld`, `setWorlds`, `bindWorld` and `unbindWorld` return `undefined`.

**Throws:** every method validates its complete input before changing anything, except `syncWorlds` (see the source bullet).
- `VGPU-INSTANCE-HANDLE` from any method taking an `InstanceId` when the handle was removed, belongs to another collection, or is a number that was not returned by this collection's `add` — use a live `InstanceId` from this collection; never pass a slot as a handle.
- `VGPU-INSTANCE-CAPACITY` from `add` when `count` equals `capacity` — remove instances, or create a larger collection and rebuild its bindings and GPU bridges.
- `VGPU-INSTANCE-ATTRIBUTE` from `add` when a required attribute is missing, or from `add`/`set` when a key is not a declared attribute — pass every attribute without a `default` and only declared names.
- `VGPU-INSTANCE-VALUE` from `add`/`set` when a value has the wrong arity, is `NaN`/`Infinity` or overflows float32 for a float format, or is fractional or outside the 32-bit range for `sint32` (`-2147483648..2147483647`) or `uint32` (`0..4294967295`); from `setWorld`/`setWorlds` when a matrix is not 16 finite float32-representable values or its bottom row is not exactly `0, 0, 0, 1`; or from `setWorlds` when `worlds` is not a `Float32Array` — the message names the attribute or matrix element; pass a value of the exact format, or an affine `Float32Array` of 16-value rows.
- `VGPU-INSTANCE-RANGE` from `setWorlds` when `ids` is not array-like, `firstRow` is not a nonnegative integer, `worlds` has fewer than `(firstRow + ids.length) × 16` elements, or an `InstanceId` appears twice in `ids`; from `idAt` when `slot` is not an integer in `0..count-1` — pass in-range contiguous rows, each handle at most once, and a live slot.
- `VGPU-INSTANCE-BOUND` from `bindWorld` when the instance already has a source, or from `setWorld`/`setWorlds` when it has one — call `unbindWorld(id)` first.
- `VGPU-INSTANCE-SOURCE` from `bindWorld` when `source` is not a function, or from `syncWorlds` when a source throws (the original error is the `cause`) or returns an invalid matrix (the `VGPU-INSTANCE-VALUE` error is the `cause`) — the message names the instance; make the source return a finite affine 16-value matrix synchronously. Sources called before the failing one have already been copied: there is no rollback or retry.
- `VGPU-INSTANCE-REENTRANT` when any mutation (`add`, `remove`, `set`, `setWorld`, `setWorlds`, `bindWorld`, `unbindWorld`), a nested `syncWorlds`, or a GPU bridge publication runs while `syncWorlds` is calling sources — keep sources read-only and mutate or publish after `syncWorlds` returns.
- `VGPU-INSTANCE-EXHAUSTED` when an internal identity or change counter would pass the largest safe integer — the message names the counter. Counters never wrap into stale values; stop using the exhausted collection and rebuild your instance state as the message directs.

## Examples

Drive instance worlds from articulated nodes with `bindWorld`:

```ts
import { group, instances } from "vgpu/scene";

const turret = group({ position: [0, 1, 0] });
const barrelLeft = group({ position: [-0.3, 0.2, -1] });
const barrelRight = group({ position: [0.3, 0.2, -1] });
turret.add(barrelLeft, barrelRight);

const barrels = instances({ capacity: 2, attributes: { heat: { format: "float32", default: 0 } } });
const left = barrels.add();
const right = barrels.add();
barrels.bindWorld(left, () => barrelLeft.worldMatrix); // read-only accessor; the result is copied
barrels.bindWorld(right, () => barrelRight.worldMatrix);

// every frame: update nodes, copy their worlds, then publish through your GPU bridge
turret.set({ rotation: [0, 0.3, 0] });
const copied = barrels.syncWorlds(); // 2
barrels.set(left, { heat: 0.8 }); // attributes stay writable while the world is bound
```

Copy final worlds from an external array in one validated batch:

```ts
import { composeMatrix, instances } from "vgpu/scene";

const agentCount = 3;
const crowd = instances({ capacity: 256, attributes: { team: "uint32" } });
const agentIds = Array.from({ length: agentCount }, (_, index) => crowd.add({ team: index % 2 }));

const simulationWorlds = new Float32Array(agentCount * 16); // owned by your simulation
for (let row = 0; row < agentCount; row++) {
  composeMatrix({ position: [row * 2, 0, 0] }, simulationWorlds.subarray(row * 16, row * 16 + 16));
}

crowd.setWorlds(agentIds, simulationWorlds); // row i → agentIds[i]; all-or-nothing
crowd.setWorlds(agentIds.slice(1), simulationWorlds, 1); // rows 1 and 2 only
```

Hand an instance from a node to a physics engine that writes final worlds:

```ts
import { group, instances } from "vgpu/scene";

const hand = group({ position: [0, 1.2, 0] });
const crates = instances({ capacity: 32 });
const crate = crates.add();
crates.bindWorld(crate, () => hand.worldMatrix); // carried by the hand
crates.syncWorlds();

crates.unbindWorld(crate); // released: the last copied world stays in place
const physicsWorld = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.9, 0, 1]);
crates.setWorld(crate, physicsWorld); // direct writes are allowed again
```

Map a picked `instance_index` back to your data and remove it:

```ts
import { instances, type InstanceId } from "vgpu/scene";

const stars = instances({ capacity: 3, attributes: { brightness: "float32" } });
const names = new Map<InstanceId, string>();
names.set(stars.add({ brightness: 1 }), "Vega");
names.set(stars.add({ brightness: 0.4 }), "Deneb");
const altair = stars.add({ brightness: 0.8 });
names.set(altair, "Altair");

const pickedSlot = 0; // e.g. instance_index read back from a picking pass drawn from instance 0
const pickedId = stars.idAt(pickedSlot); // resolve before the next add/remove moves slots
stars.remove(pickedId); // swap-remove: Altair moves from slot 2 to slot 0
names.delete(pickedId);
console.log(stars.count, stars.slotOf(altair)); // 2, 0
```

## Notes

- Handles vs slots: an `InstanceId` identifies one live instance of one collection and is never reused. A slot is its current position in the packed records and equals WGSL `instance_index` when the draw starts at instance 0. Slots move on every `remove` that is not the last slot. Keep your own data keyed by `InstanceId`, never by slot. Picking maps and per-frame slot snapshots for results read back later are yours to keep; `idAt` answers only for the current state.
- Handles are opaque numbers with no serialization or cross-process meaning. Do not store them in files or send them across workers.
- Sources: a source runs synchronously inside `syncWorlds()` and its result is copied, so returning a borrowed array such as `node.worldMatrix` is safe. `syncWorlds()` does not evaluate hierarchies or cameras for you — sources read whatever state they close over.
- When `syncWorlds()` throws `VGPU-INSTANCE-SOURCE`, some worlds may already hold this frame's values and others last frame's. Let the error end the frame (an uncaught error stops `frameLoop(gpu)`), fix or `unbindWorld` the failing source, then call `syncWorlds()` again before the next publication. The reentrancy guard is always released, even after a throw.
- Costs: `setWorld` and each `setWorlds` row cost validation plus a 64-byte copy; `setWorlds` validates the entire batch before copying. `syncWorlds` calls each source once and pays the same validation and copy per source. `add` writes one full record, and `set` stages and copies one full record after validating the supplied fields. A `remove` that is not the last slot copies one full record. No method promises to be allocation-free.
- Change tracking: every successful `add`, `set`, world write, swap-remove move and `syncWorlds` copy marks the affected slot as changed; a `remove` of the last slot shrinks `count` and that change is visible too. Each GPU bridge keeps its own cursor, so two bridges over the same collection each see every change — publishing one does not consume another's pending updates. Do not assume publication cost is proportional to the number of changes; a bridge may scan every record.
- The world is written only by `setWorld`, `setWorlds` and `syncWorlds`. There is no implicit parent/child relationship between instances; combine matrices yourself, or use nodes or `evaluateHierarchy` and copy the results.
- Do not read or write the packed records directly; the collection exposes no mutable arrays. Write through the methods so change tracking stays correct.
- **See also:** `instances`, `InstanceId`, `InstanceValues`, `group`, `evaluateHierarchy`, `composeMatrix`.

---

# InstanceId

An opaque, branded handle for one live instance in one `InstanceCollection`. Returned by `add()` and accepted by every per-instance method.

## Import

```ts
import type { InstanceId } from "vgpu/scene";
```

## Signature

```ts
type InstanceId = number & { readonly __instanceId: unique symbol };
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| (value) | `number` | — | — | Issued by `add()`. Stable while the instance lives, invalid after `remove()`, never reused, and rejected by other collections with `VGPU-INSTANCE-HANDLE`. |

## Examples

```ts
import { instances, type InstanceId } from "vgpu/scene";

const lamps = instances({ capacity: 8 });
const lampIds: InstanceId[] = [lamps.add(), lamps.add()];
lamps.remove(lampIds[0]!);
console.log(lamps.slotOf(lampIds[1]!)); // 0: the handle stayed valid, the slot moved
```

## Notes

- The brand stops plain numbers and slots from type-checking as handles. Do not cast a slot or a stored number to `InstanceId`; `VGPU-INSTANCE-HANDLE` rejects handles this collection did not issue.
- The numeric value carries no slot, generation or ordering information you can rely on.
- **See also:** `InstanceCollection`, `instances`.

---

# InstanceFormat

The 12 formats an instance attribute can use: 32-bit float, signed integer and unsigned integer scalars and 2-, 3- and 4-component vectors.

## Import

```ts
import type { InstanceFormat } from "vgpu/scene";
```

## Signature

```ts
type InstanceFormat =
  | "float32" | "float32x2" | "float32x3" | "float32x4"
  | "sint32" | "sint32x2" | "sint32x3" | "sint32x4"
  | "uint32" | "uint32x2" | "uint32x3" | "uint32x4";
```

## Parameters

| Value | Type | Required | Default | Notes |
|---|---|---|---|---|
| `float32`, `float32x2..4` | `number` / `ArrayLike<number>` | — | — | 4 bytes per component. Values must be finite and stay finite when rounded to float32. |
| `sint32`, `sint32x2..4` | `number` / `ArrayLike<number>` | — | — | 4 bytes per component. Integers in `-2147483648..2147483647`. |
| `uint32`, `uint32x2..4` | `number` / `ArrayLike<number>` | — | — | 4 bytes per component. Integers in `0..4294967295`. |

## Examples

```ts
import { instances, type InstanceFormat } from "vgpu/scene";

const cellFormat: InstanceFormat = "sint32x2";
const tiles = instances({ capacity: 16, attributes: { cell: cellFormat } });
tiles.add({ cell: new Int32Array([3, -1]) });
```

## Notes

- Scalar formats take a `number`; vector formats take an `ArrayLike<number>` of exactly 2, 3 or 4 values — arrays and typed arrays both work.
- No 8- or 16-bit or normalized formats exist; widen small values to 32 bits.
- **See also:** `InstanceAttribute`, `InstanceValue`.

---

# InstanceAttribute

One attribute declaration: a bare `InstanceFormat` (required on `add`) or `{ format, default }` (optional on `add`, filled from `default`).

## Import

```ts
import type { InstanceAttribute } from "vgpu/scene";
```

## Signature

```ts
type InstanceAttribute = import("vgpu/scene").InstanceFormat | {
  format: import("vgpu/scene").InstanceFormat;
  default: number | ArrayLike<number>;
};
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| (string form) | `InstanceFormat` | — | — | No default: `add()` must supply the value. |
| format | `InstanceFormat` | ✔ | — | Format of the attribute. |
| default | `number \| ArrayLike<number>` | ✔ | — | Value used when `add()` omits the field. A `number` for scalar formats, exactly 2–4 values for vectors. Validated and copied when the collection is created. |

## Examples

```ts
import { instances, type InstanceAttribute } from "vgpu/scene";

const tint: InstanceAttribute = { format: "float32x4", default: [1, 1, 1, 1] };
const sprites = instances({ capacity: 100, attributes: { tint, frame: "uint32" } });
sprites.add({ frame: 0 }); // tint defaults to opaque white
```

## Notes

- The types do not tie `default`'s shape to `format`; `instances()` throws `VGPU-INSTANCE-VALUE` for a mismatched default.
- **See also:** `InstanceAttributes`, `InstanceFormat`, `instances`.

---

# InstanceAttributes

The schema object passed as `instances({ attributes })`: attribute names mapped to `InstanceAttribute` declarations, in declaration order.

## Import

```ts
import type { InstanceAttributes } from "vgpu/scene";
```

## Signature

```ts
type InstanceAttributes = Record<string, import("vgpu/scene").InstanceAttribute>;
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| [name] | `InstanceAttribute` | ✖ | no attributes | Key order is record layout order. Names must not be numeric and must not be `world0`–`world3`. |

## Examples

```ts
import { instances } from "vgpu/scene";

const particles = instances({
  capacity: 4096,
  attributes: {
    velocity: "float32x3",
    age: { format: "float32", default: 0 },
    seed: "uint32",
  },
});
particles.add({ velocity: [0, 2, 0], seed: 7 }); // record: world, velocity, age, seed (84 bytes)
```

## Notes

- Pass the object literal directly to `instances()` so required and defaulted keys are inferred. A value annotated as `InstanceAttributes` loses its literal keys, and `add`/`set` then accept any string key at compile time.
- **See also:** `instances`, `InstanceAttribute`, `InstanceInitialValues`.

---

# InstanceAttributeFormat

Type helper that extracts the `InstanceFormat` of one attribute declaration, whether it is a bare format or `{ format, default }`.

## Import

```ts
import type { InstanceAttributeFormat } from "vgpu/scene";
```

## Signature

```ts
type InstanceAttributeFormat<T extends import("vgpu/scene").InstanceAttribute> =
  T extends { format: infer F extends import("vgpu/scene").InstanceFormat }
    ? F
    : Extract<T, import("vgpu/scene").InstanceFormat>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| T | `InstanceAttribute` | ✔ | — | `"float32x3"` and `{ format: "float32x3"; default: … }` both resolve to `"float32x3"`. |

## Examples

```ts
import type { InstanceAttributeFormat } from "vgpu/scene";

type TintFormat = InstanceAttributeFormat<{ format: "float32x4"; default: [1, 1, 1, 1] }>; // "float32x4"
const tintFormat: TintFormat = "float32x4";
```

## Notes

- **See also:** `InstanceValue`, `InstanceValues`.

---

# InstanceValue

Type helper that maps an `InstanceFormat` to the value you pass: `number` for scalar formats, `ArrayLike<number>` for vector formats.

## Import

```ts
import type { InstanceValue } from "vgpu/scene";
```

## Signature

```ts
type InstanceValue<F extends import("vgpu/scene").InstanceFormat> =
  F extends "float32" | "sint32" | "uint32" ? number : ArrayLike<number>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| F | `InstanceFormat` | ✔ | — | Scalar formats resolve to `number`; `x2`/`x3`/`x4` formats resolve to `ArrayLike<number>`. |

## Examples

```ts
import type { InstanceValue } from "vgpu/scene";

const layer: InstanceValue<"uint32"> = 3;
const offset: InstanceValue<"float32x2"> = new Float32Array([0.5, -0.5]);
```

## Notes

- Vector length is checked at runtime, not by this type.
- **See also:** `InstanceFormat`, `InstanceValues`.

---

# InstanceValues

Type helper for a complete set of attribute values of a schema: every attribute key, each typed by `InstanceValue` of its format. `set()` takes `Partial<InstanceValues<A>>`.

## Import

```ts
import type { InstanceValues } from "vgpu/scene";
```

## Signature

```ts
type InstanceValues<A extends import("vgpu/scene").InstanceAttributes> = {
  [K in keyof A]: import("vgpu/scene").InstanceValue<import("vgpu/scene").InstanceAttributeFormat<A[K]>>;
};
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| A | `InstanceAttributes` | ✔ | — | The collection's schema. Defaulted attributes are required here too; use `InstanceInitialValues` for `add()` input. |

## Examples

```ts
import { instances, type InstanceValues } from "vgpu/scene";

const schema = { heading: "float32", color: { format: "float32x3", default: [1, 1, 1] } } as const;
const boids = instances({ capacity: 500, attributes: schema });
const boid = boids.add({ heading: 0 });

const update: Partial<InstanceValues<typeof schema>> = { color: [1, 0.2, 0.2] };
boids.set(boid, update);
```

## Notes

- When you hoist a schema into a variable to reuse its type, keep its literal types with `as const`; inline object literals passed to `instances()` need no annotation.
- **See also:** `InstanceInitialValues`, `InstanceCollection`.

---

# InstanceInitialValues

Type helper for `add()` input: attributes without a `default` are required keys, attributes with a `default` are optional keys.

## Import

```ts
import type { InstanceInitialValues } from "vgpu/scene";
```

## Signature

```ts
type InstanceInitialValues<A extends import("vgpu/scene").InstanceAttributes> =
  { [K in keyof A as A[K] extends { default: unknown } ? never : K]: import("vgpu/scene").InstanceValues<A>[K] } &
  { [K in keyof A as A[K] extends { default: unknown } ? K : never]?: import("vgpu/scene").InstanceValues<A>[K] };
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| A | `InstanceAttributes` | ✔ | — | The collection's schema. Omitted optional keys take the declared `default`. |

## Examples

```ts
import type { InstanceInitialValues } from "vgpu/scene";

type Schema = { mass: "float32"; tint: { format: "float32x3"; default: [1, 1, 1] } };
const heavy: InstanceInitialValues<Schema> = { mass: 40 }; // tint may be omitted
const painted: InstanceInitialValues<Schema> = { mass: 2, tint: [0.9, 0.1, 0.1] };
```

## Notes

- Unknown keys are rejected at compile time for object literals and at runtime with `VGPU-INSTANCE-ATTRIBUTE`.
- **See also:** `InstanceAddArgs`, `InstanceValues`.

---

# InstanceAddArgs

Type helper for the argument tuple of `add()`: the values argument is optional when every attribute has a `default` (or there are none) and required otherwise.

## Import

```ts
import type { InstanceAddArgs } from "vgpu/scene";
```

## Signature

```ts
type InstanceAddArgs<A extends import("vgpu/scene").InstanceAttributes> = {} extends import("vgpu/scene").InstanceInitialValues<A>
  ? [values?: import("vgpu/scene").InstanceInitialValues<A>]
  : [values: import("vgpu/scene").InstanceInitialValues<A>];
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| A | `InstanceAttributes` | ✔ | — | `[values?]` when no attribute is required, `[values]` when at least one is. |

## Examples

```ts
import { instances } from "vgpu/scene";

const markers = instances({ capacity: 4, attributes: { size: { format: "float32", default: 1 } } });
markers.add(); // every attribute has a default
const labelled = instances({ capacity: 4, attributes: { labelIndex: "uint32" } });
labelled.add({ labelIndex: 0 }); // required: labelled.add() does not compile
```

## Notes

- **See also:** `InstanceInitialValues`, `InstanceCollection`.
