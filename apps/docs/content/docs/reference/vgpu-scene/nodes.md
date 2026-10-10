---
title: "group"
description: "Creates a spatial `SceneNode`: a local position/rotation/scale with parent and children links. Use nodes for a modest number of articulated objects (a robot arm, a camera rig, a vehicle and its wheels); use `evaluateHierarchy` for large or externally owned hierarchies and instance collections for large populations."
---

## Import

```ts
import { group } from "vgpu/scene";
```

## Signature

```ts
declare function group(options?: import("vgpu/scene").NodeOptions): import("vgpu/scene").SceneNode;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| options | `NodeOptions` | ✖ | `{}` | Initial transform, flags and children. Omit it for an unlabeled, visible node at the origin with identity rotation and scale 1. |
| options.position | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | Exactly 3 finite, float32-representable numbers. Copied. |
| options.rotation | `ArrayLike<number>` | ✖ | no rotation | Exactly 3 finite numbers, intrinsic XYZ Euler radians. Stored as a quaternion. Ignored when `quaternion` is present. |
| options.quaternion | `ArrayLike<number>` | ✖ | `[0, 0, 0, 1]` | Exactly 4 finite numbers, XYZW, nonzero length. A normalized copy is stored; your array is not modified. |
| options.scale | `number \| ArrayLike<number>` | ✖ | `1` | One number or exactly 3 numbers, each finite and float32-representable. |
| options.visible | `boolean` | ✖ | `true` | App metadata only; see `SceneNode`. |
| options.label | `string` | ✖ | `undefined` | App metadata; also used in error `where` strings. |
| options.children | `readonly SceneNode[]` | ✖ | `[]` | Attached in order after the transform is validated. A child that already has a parent is moved here with its local transform unchanged. |

**Returns:** `SceneNode` with `kind: "group"`.

**Throws:**
- `VGPU-SCENE-VALUE` when a transform field has the wrong length, a non-finite or non-float32 component, a zero-length quaternion, a composed matrix outside float32 range, `visible` is not a boolean, `label` is not a string, or a `children` entry is not a `SceneNode` — the message names the field (for example `group.set.position[1]`); fix the value. Nothing is attached when this throws.

## Examples

```ts
import { group } from "vgpu/scene";

const wheelFront = group({ label: "wheel-front", position: [0, -0.3, 1.2] });
const wheelBack = group({ label: "wheel-back", position: [0, -0.3, -1.2] });
const car = group({ label: "car", position: [0, 0.5, 0], children: [wheelFront, wheelBack] });

console.log(wheelFront.worldPosition); // ≈ [0, 0.2, 1.2], rounded to float32
void car;
```

## Notes

- `group()` is the only node factory; it is equivalent to `new SceneNode("group", options)`.
- Nodes are plain CPU state: no geometry, material, or GPU resources. Upload `worldMatrix` to your own uniforms or instance worlds.
- **See also:** `SceneNode`, `NodeOptions`, `composeMatrix`, `evaluateHierarchy`.

---

# SceneNode

A spatial node with a local transform, lazily computed local and world matrices, and parent/children links. Write the transform through `set()` or `lookAt()`; read matrices from the getters, which return stable arrays refreshed on read.

## Import

```ts
import { SceneNode } from "vgpu/scene";
```

## Signature

```ts
declare class SceneNode {
  constructor(kind: import("vgpu/scene").SceneNodeKind, options?: import("vgpu/scene").NodeOptions);
  readonly kind: import("vgpu/scene").SceneNodeKind;
  label: string | undefined;
  visible: boolean;
  set(values: import("vgpu/scene").NodeTransformValues): this;
  lookAt(target: import("vgpu/scene").Vec3Like, up?: import("vgpu/scene").Vec3Like): this;
  add(...nodes: SceneNode[]): this;
  remove(...nodes: SceneNode[]): this;
  removeFromParent(): this;
  traverse(visit: (node: SceneNode) => void): void;
  get parent(): SceneNode | null;
  get children(): readonly SceneNode[];
  get position(): Float32Array;
  get quaternion(): Float32Array;
  get scale(): Float32Array;
  get localMatrix(): import("vgpu/scene").Mat4;
  get worldMatrix(): import("vgpu/scene").Mat4;
  get worldPosition(): Float32Array;
}
```

## Parameters

| Member | Type | Required | Default | Notes |
|---|---|---|---|---|
| constructor kind | `SceneNodeKind` | ✔ | — | Only `"group"`. Prefer `group(options)`. |
| constructor options | `NodeOptions` | ✖ | `{}` | Same as `group(options)`. |
| label | `string \| undefined` | ✖ | `undefined` | Writable app metadata. Used in error `where` strings. |
| visible | `boolean` | ✖ | `true` | Writable app metadata. Nothing in vgpu reads it: it does not hide the node, skip its matrices, or propagate to children or instances. |
| set(values) | `NodeTransformValues` | ✔ | — | Patches the local state: omitted fields keep their current values. Validates the complete candidate state before writing anything. |
| lookAt(target, up) | `Vec3Like, Vec3Like` | target ✔, up ✖ | up `[0, 1, 0]` | Rotates the node so its local -Z axis points at the world-space `target`, with +Y as close to the world-space `up` as possible. Position and scale are unchanged. |
| add(...nodes) | `SceneNode[]` | ✖ | no nodes | Appends children in order. Nodes with another parent are moved; re-adding an existing child moves it to the end. Local transforms are preserved, so world matrices change with the new parent. |
| remove(...nodes) | `SceneNode[]` | ✖ | no nodes | Detaches direct children. Nodes that are not children of this node are ignored. The removed node keeps its local transform and becomes a root. |
| removeFromParent() | — | — | — | Detaches this node from its parent; no-op on a root. |
| traverse(visit) | `(node: SceneNode) => void` | ✔ | — | Depth-first pre-order walk of this node and its descendants, children in insertion order. Iterative, so deep chains do not overflow the stack. |
| parent / children | `SceneNode \| null` / `readonly SceneNode[]` | — | `null` / `[]` | Read-only links. Change them only through `add`, `remove` and `removeFromParent`. |
| position / quaternion / scale | `Float32Array` | — | `[0, 0, 0]` / `[0, 0, 0, 1]` / `[1, 1, 1]` | Local state, stored as float32. The quaternion is always normalized. There is no Euler getter. |
| localMatrix | `Mat4` | — | identity | `composeMatrix` of the local state, recomputed on read after a change. |
| worldMatrix | `Mat4` | — | identity | `parent.worldMatrix × localMatrix`, recomputed on read for this node and any changed ancestors. |
| worldPosition | `Float32Array` | — | `[0, 0, 0]` | Elements 12, 13, 14 of `worldMatrix`, refreshed on each read. |

**Returns:** `set`, `lookAt`, `add`, `remove` and `removeFromParent` return the same node for chaining; `traverse` returns `undefined`.

**Throws:**
- `VGPU-SCENE-VALUE` from `set()` or the constructor for an invalid field (see `group`), from `lookAt()` when `target` or `up` does not have exactly 3 finite, float32-representable numbers, and from `add()` when an argument is not a `SceneNode` — fix the named field; the node is unchanged.
- `VGPU-SCENE-CYCLE` from `add()` when a node is this node or one of its ancestors — remove the ancestor link or attach a different node. `add()` checks every argument first, so nothing is attached when it throws.
- `VGPU-SPATIAL-SINGULAR` from `lookAt()` when the parent's world matrix cannot be inverted (for example a zero scale on an ancestor) — restore an invertible ancestor transform; the quaternion is unchanged.
- `VGPU-SCENE-VALUE` from reading `worldMatrix` or `worldPosition` when a parent × local product leaves float32 range (for example nested scales of `1e20`) — keep accumulated transforms within float32 range.

## Examples

```ts
import { group } from "vgpu/scene";

const shoulder = group({ label: "shoulder", position: [0, 1.5, 0] });
const elbow = group({ label: "elbow", position: [0, 0, -1] });
shoulder.add(elbow);

const elbowWorld = elbow.worldMatrix; // stable identity
shoulder.set({ rotation: [0, Math.PI / 2, 0] }); // patch: position stays [0, 1.5, 0]
console.log(elbowWorld === elbow.worldMatrix, elbow.worldPosition); // true, ≈ [-1, 1.5, 0]
```

Aim a node at a world-space point, even under a rotated, non-uniformly scaled parent:

```ts
import { group } from "vgpu/scene";

const turret = group({ rotation: [0, 0.6, 0], scale: [2, 1, 0.5] });
const barrel = group({ position: [0, 0.4, 0] });
turret.add(barrel);

barrel.lookAt([5, 0, -3]); // world-space target; the parent transform is compensated
```

Reparent while keeping the local transform:

```ts
import { group } from "vgpu/scene";

const table = group({ position: [4, 0, 0] });
const hand = group({ position: [0, 1, 0] });
const cup = group({ position: [0, 0.8, 0] });
table.add(cup);

hand.add(cup); // cup.position is still [0, 0.8, 0]; its world position now follows hand
console.log(cup.worldPosition); // ≈ [0, 1.8, 0]
```

## Notes

- Borrowed arrays: `position`, `quaternion`, `scale`, `localMatrix`, `worldMatrix` and `worldPosition` return the node's own arrays with a stable identity. They are safe to read or upload, but treat them as read-only — writing to them skips dirty tracking and leaves matrices stale. Change state through `set()` or `lookAt()`.
- Patch vs compose: `node.set({ scale: 2 })` changes only the scale. `composeMatrix({ scale: 2 }, out)` resets position and rotation to defaults.
- `set()` stores `rotation` as a quaternion and normalizes a supplied `quaternion`, so `node.quaternion` can differ from the array you passed. Inputs are stored as float32; `localMatrix` matches `composeMatrix` of the stored `position`, `quaternion` and `scale`.
- `set({ label: undefined })` and `set({ visible: undefined })` keep the current values; assign `node.label = undefined` to clear a label.
- Lazy reads: `set`, `lookAt` and reparenting only mark the node and its descendants dirty. Each `worldMatrix` read walks up to the root and recomputes dirty ancestors, so read it once per frame per node rather than in inner loops.
- `lookAt` aims from the node's own world position. If `target`, rounded to float32, equals `worldPosition`, the quaternion becomes identity after any parent inverse is validated; a singular parent therefore still throws without changing the quaternion. If `up` is parallel to the view direction, a fixed fallback axis keeps the result deterministic.
- Keep-world reparenting is not supported: there is no matrix decomposition and no matrix input on nodes. Recompute the local transform yourself before `add()` if the node must stay in place.
- Mutating the tree from inside a `traverse` callback changes which nodes are visited; collect the nodes first, then mutate.
- **See also:** `group`, `NodeTransformValues`, `composeMatrix`, `localFromWorld`, `evaluateHierarchy`.

---

# NodeOptions

Options for `group()` and the `SceneNode` constructor: every `NodeTransformValues` field plus initial `children`.

## Import

```ts
import type { NodeOptions } from "vgpu/scene";
```

## Signature

```ts
interface NodeOptions {
  position?: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  quaternion?: ArrayLike<number>;
  scale?: number | ArrayLike<number>;
  readonly visible?: boolean;
  readonly label?: string;
  readonly children?: readonly import("vgpu/scene").SceneNode[];
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| position | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | Exactly 3 finite, float32-representable numbers. |
| rotation | `ArrayLike<number>` | ✖ | no rotation | Intrinsic XYZ Euler radians. Ignored when `quaternion` is present. |
| quaternion | `ArrayLike<number>` | ✖ | `[0, 0, 0, 1]` | XYZW, nonzero length, normalized copy stored. |
| scale | `number \| ArrayLike<number>` | ✖ | `1` | Uniform number or 3 per-axis numbers. |
| visible | `boolean` | ✖ | `true` | App metadata; not consumed by vgpu. |
| label | `string` | ✖ | `undefined` | App metadata and error context. |
| children | `readonly SceneNode[]` | ✖ | `[]` | Attached in order after validation; existing parents are replaced, local transforms kept. |

**Returns:** Not a callable.

**Throws:** None by itself; `group()` throws `VGPU-SCENE-VALUE` for invalid fields.

## Examples

```ts
import { group, type NodeOptions } from "vgpu/scene";

const rigOptions: NodeOptions = { label: "rig", position: [0, 2, 0], children: [group({ label: "pivot" })] };
const rig = group(rigOptions);
console.log(rig.children.length); // 1
```

## Notes

- The options object and its arrays are copied; mutating them after `group()` has no effect on the node.
- **See also:** `group`, `NodeTransformValues`, `TransformValues`.

---

# NodeTransformValues

Transform and flag values accepted by `SceneNode.set()`. Every field is optional and omitted fields keep the node's current value.

## Import

```ts
import type { NodeTransformValues } from "vgpu/scene";
```

## Signature

```ts
interface NodeTransformValues {
  position?: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  quaternion?: ArrayLike<number>;
  scale?: number | ArrayLike<number>;
  readonly visible?: boolean;
  readonly label?: string;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| position | `ArrayLike<number>` | ✖ | current position | Exactly 3 finite, float32-representable numbers. |
| rotation | `ArrayLike<number>` | ✖ | current rotation | Exactly 3 finite numbers, intrinsic XYZ Euler radians; replaces the whole rotation. Ignored when `quaternion` is present. |
| quaternion | `ArrayLike<number>` | ✖ | current rotation | Exactly 4 finite numbers, XYZW, nonzero length; normalized copy stored. |
| scale | `number \| ArrayLike<number>` | ✖ | current scale | Uniform number or 3 per-axis numbers, each finite and float32-representable. |
| visible | `boolean` | ✖ | current value | App metadata; `undefined` keeps the current value. |
| label | `string` | ✖ | current value | App metadata; `undefined` keeps the current value. |

**Returns:** Not a callable.

**Throws:** None by itself; `set()` throws `VGPU-SCENE-VALUE` for invalid fields and then leaves the node unchanged.

## Examples

```ts
import { group } from "vgpu/scene";

const lamp = group({ position: [0, 3, 0], scale: 0.5 });
lamp.set({ rotation: [-Math.PI / 4, 0, 0] }); // position and scale unchanged
lamp.set({ visible: false, label: "lamp" }); // flags only: matrices stay clean
```

## Notes

- A `set()` call that touches only `visible` or `label` does not invalidate any matrix.
- **See also:** `SceneNode`, `TransformValues`, `NodeOptions`.

---

# SceneNodeKind

The kind tag of a `SceneNode`. The only supported kind is `"group"`.

## Import

```ts
import type { SceneNodeKind } from "vgpu/scene";
```

## Signature

```ts
type SceneNodeKind = "group";
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| SceneNodeKind | `"group"` | ✔ | — | Nodes are spatial only; there are no mesh, camera, light or scene node kinds. |

**Returns:** Not a callable.

**Throws:** None.

## Examples

```ts
import { group, type SceneNodeKind } from "vgpu/scene";

const kind: SceneNodeKind = group().kind;
console.log(kind); // "group"
```

## Notes

- Use `label` for your own categories; `kind` does not describe what you draw.
- **See also:** `SceneNode`, `group`.
