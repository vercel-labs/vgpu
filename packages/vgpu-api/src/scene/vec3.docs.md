# Vec3

A three-component float32 vector. Use this retained type for owned vector storage; functions accepting read-only input usually take the broader `Vec3Like` type.

## Import

```ts
import type { Vec3 } from "vgpu/scene";
```

## Signature

```ts illustrative
type Vec3 = Float32Array;
```

## Parameters

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| elements | `number` | ✔ | — | Three components in X, Y, Z order. The type alone cannot enforce length; scene functions validate their inputs. |

**Returns:** Not callable; a type alias for vector storage.
**Throws:** None; consuming functions perform validation.

## Examples

```ts
import type { Vec3 } from "vgpu/scene";

const position: Vec3 = new Float32Array([1, 2, 3]);
console.log(position[0]);
```

## Notes

- Float32 storage loses precision at large coordinates. Keep application coordinates near the origin or rebase them explicitly.
- A node's borrowed vector getters remain read-only by contract even though `Float32Array` is mutable. Use node `.set()` for local changes.
- **See also:** `Vec3Like`, `Pose`, `SceneNode`, `Mat4`.
