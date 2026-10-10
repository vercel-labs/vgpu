# composeMatrix

Writes a complete local transform matrix from position, rotation (Euler or quaternion) and scale into `out`. Use it to fill matrices for flat hierarchy rows, instance worlds, or any shader uniform that needs an object transform without a `SceneNode`.

## Import

```ts
import { composeMatrix } from "vgpu/scene";
```

## Signature

```ts
declare function composeMatrix(
  values: import("vgpu/scene").TransformValues,
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| values | `TransformValues` | ✔ | — | Complete transform description. Every omitted field resets to its default; `composeMatrix` never reads the previous contents of `out`. |
| values.position | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | Exactly 3 finite numbers; written to translation indices 12, 13, 14. |
| values.rotation | `ArrayLike<number>` | ✖ | no rotation | Exactly 3 finite numbers: intrinsic XYZ Euler angles in radians. Ignored — and not validated — when `quaternion` is present. |
| values.quaternion | `ArrayLike<number>` | ✖ | `[0, 0, 0, 1]` | Exactly 4 finite numbers in XYZW order, nonzero length. Normalized for the calculation; the caller's array is not modified. Wins over `rotation`. |
| values.scale | `number \| ArrayLike<number>` | ✖ | `1` | One finite number for uniform scale, or exactly 3 finite per-axis factors. Zero and negative factors are allowed (the matrix is then singular or reflected). |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. Fully overwritten on success, untouched on any error. |

**Returns:** `Mat4` — the same `out` array, so calls can be chained into other matrix functions.

**Throws:**
- `VGPU-SPATIAL-SIZE` when `out` does not have exactly 16 elements — allocate `new Float32Array(16)` or pass an exact 16-element `subarray`.
- `VGPU-SCENE-VALUE` when `position`, `rotation` or vector `scale` does not have exactly 3 elements, `quaternion` does not have exactly 4, any component or scalar `scale` is `NaN`/`Infinity`, the quaternion has zero length, or a result element is outside finite float32 range (about ±3.4e38) — the message names the field and index; pass finite, correctly sized values and a nonzero quaternion.

## Examples

```ts
import { composeMatrix } from "vgpu/scene";

const modelMatrix = new Float32Array(16);
composeMatrix({ position: [0, 1, -4], rotation: [0, Math.PI / 4, 0], scale: 2 }, modelMatrix);

composeMatrix({ position: [0, 1, -4] }, modelMatrix); // complete replacement: rotation and scale reset to identity
```

Write one row of a packed matrix array by passing an exact 16-element view:

```ts
import { composeMatrix } from "vgpu/scene";

const rowCount = 3;
const locals = new Float32Array(rowCount * 16);
for (let row = 0; row < rowCount; row++) {
  composeMatrix({ position: [row * 2, 0, 0] }, locals.subarray(row * 16, row * 16 + 16));
}
```

## Notes

- Conventions: right-handed, +Y up, column-major storage, translation at indices 12, 13, 14, affine bottom row at indices 3, 7, 11, 15 = `0, 0, 0, 1`. The matrix applies scale, then rotation, then translation.
- Complete composition, not a patch: omitted fields take their defaults. To change one component of existing state, keep the other values yourself or use a node's `set()`, which patches.
- Math runs in JavaScript doubles and is rounded to float32 when written. Float32 carries about 7 significant digits: at a distance of `1e7` units, adjacent representable translations are 1 unit apart. There is no large-coordinate precision handling; keep coordinates near the origin.
- Validation and computation finish before the first write, so `out` may share memory with the input arrays.
- **See also:** `TransformValues`, `multiplyMatrices`, `invertAffine`, `SceneNode`, `evaluateHierarchy`.

---

# multiplyMatrices

Writes the column-major product `a × b` into `out`. Use it to combine a parent world with a child local (`world = parentWorld × local`) or a projection with a view; neither argument has to be affine.

## Import

```ts
import { multiplyMatrices } from "vgpu/scene";
```

## Signature

```ts
declare function multiplyMatrices(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| a | `ArrayLike<number>` | ✔ | — | Left matrix, exactly 16 finite numbers, column-major. |
| b | `ArrayLike<number>` | ✔ | — | Right matrix, exactly 16 finite numbers, column-major. Applied to a vector first. |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. May be the same array as `a` or `b`, or a view that partially overlaps them. |

**Returns:** `Mat4` — the same `out` array.

**Throws:**
- `VGPU-SPATIAL-SIZE` when `a`, `b` or `out` does not have exactly 16 elements — the message states the actual length; pass exact 16-element matrices.
- `VGPU-SCENE-VALUE` when an element of `a` or `b` is `NaN`/`Infinity`, or a product element is outside finite float32 range — pass finite matrices whose product fits in float32.

## Examples

```ts
import { composeMatrix, multiplyMatrices } from "vgpu/scene";

const parentWorld = composeMatrix({ position: [0, 2, 0], rotation: [0, Math.PI / 2, 0] }, new Float32Array(16));
const childLocal = composeMatrix({ position: [1, 0, 0] }, new Float32Array(16));

const childWorld = multiplyMatrices(parentWorld, childLocal, new Float32Array(16));
multiplyMatrices(parentWorld, childLocal, childLocal); // in place: childLocal now holds the world matrix
void childWorld;
```

The product is staged before any write, so `out` can alias either input without corrupting the result.

## Notes

- Order matters: `multiplyMatrices(a, b, out)` transforms by `b` first, then `a`. For hierarchies, pass the parent world as `a` and the child local as `b`.
- You do not need a temporary matrix to avoid aliasing; in-place output is supported.
- **See also:** `composeMatrix`, `invertAffine`, `localFromWorld`, `evaluateHierarchy`.

---

# invertAffine

Writes the inverse of an affine matrix into `out`, or throws without touching `out` when no finite float32 inverse exists. Use it to move points from world space into an object's local space.

## Import

```ts
import { invertAffine } from "vgpu/scene";
```

## Signature

```ts
declare function invertAffine(
  matrix: ArrayLike<number>,
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| matrix | `ArrayLike<number>` | ✔ | — | Exactly 16 finite numbers, column-major, affine: indices 3, 7, 11, 15 must be exactly `0, 0, 0, 1`. Shear and reflection are supported. |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. May alias `matrix`. Untouched on any error. |

**Returns:** `Mat4` — the same `out` array.

**Throws:**
- `VGPU-SPATIAL-SIZE` when `matrix` or `out` does not have exactly 16 elements — pass exact 16-element matrices.
- `VGPU-SCENE-VALUE` when an element of `matrix` is `NaN`/`Infinity`, or the bottom row is not exactly `0, 0, 0, 1` — pass a finite affine matrix; use a general inverse for projections.
- `VGPU-SPATIAL-SINGULAR` when the determinant of the 3×3 linear part is zero or non-finite, or an inverse element is outside finite float32 range — restore an invertible finite affine matrix and use scales whose inverse fits in float32; `out` is left unchanged.

## Examples

```ts
import { composeMatrix, invertAffine } from "vgpu/scene";

const objectWorld = composeMatrix({ position: [3, 0, 0], scale: [2, 1, 1] }, new Float32Array(16));
const worldToObject = invertAffine(objectWorld, new Float32Array(16));
void worldToObject;
```

Recover from a singular matrix instead of rendering with zeros or `NaN`:

```ts
import { composeMatrix, invertAffine } from "vgpu/scene";
import { VGPUError } from "vgpu";

const collapsed = composeMatrix({ scale: [1, 0, 1] }, new Float32Array(16));
const inverse = new Float32Array(16);
try {
  invertAffine(collapsed, inverse);
} catch (error) {
  if (!(error instanceof VGPUError) || error.code !== "VGPU-SPATIAL-SINGULAR") throw error;
  // inverse still holds its previous contents (all zeros here)
}
```

## Notes

- There is no absolute epsilon: any nonzero finite determinant is accepted as long as every inverse element fits in float32. A uniform scale of `1e-20` inverts to about `1e20`; a scale of `1e-39` throws `VGPU-SPATIAL-SINGULAR` because its inverse, `1e39`, exceeds float32 range.
- Near-singular matrices invert with large elements and reduced precision; the function does not warn about conditioning.
- Do not invert a perspective or orthographic projection with `invertAffine`; its bottom row is not `0, 0, 0, 1` and the call throws `VGPU-SCENE-VALUE`.
- **See also:** `localFromWorld`, `multiplyMatrices`, `composeMatrix`.

---

# localFromWorld

Writes the local matrix that reproduces `world` under `parentWorld` — `inverse(parentWorld) × world` — into `out`. Use it when an external system (physics, animation import) supplies final world matrices and you need local rows for a flat hierarchy.

## Import

```ts
import { localFromWorld } from "vgpu/scene";
```

## Signature

```ts
declare function localFromWorld(
  parentWorld: ArrayLike<number>,
  world: ArrayLike<number>,
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| parentWorld | `ArrayLike<number>` | ✔ | — | Parent world matrix: exactly 16 finite numbers, affine (indices 3, 7, 11, 15 = `0, 0, 0, 1`), invertible. |
| world | `ArrayLike<number>` | ✔ | — | Desired child world matrix: exactly 16 finite numbers, affine. May contain shear. |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. May alias either input. Untouched on any error. |

**Returns:** `Mat4` — the same `out` array; `multiplyMatrices(parentWorld, out, result)` reproduces `world` up to float32 rounding.

**Throws:**
- `VGPU-SPATIAL-SIZE` when any argument does not have exactly 16 elements — pass exact 16-element matrices.
- `VGPU-SCENE-VALUE` when an element of `parentWorld` or `world` is `NaN`/`Infinity`, or either bottom row is not exactly `0, 0, 0, 1` — pass finite affine matrices.
- `VGPU-SPATIAL-SINGULAR` when `parentWorld` has a zero or non-finite linear determinant or its inverse is outside finite float32 range — restore an invertible finite affine parent with representable scales; `out` is left unchanged.
- `VGPU-SCENE-VALUE` when an element of the resulting local matrix is outside finite float32 range — use parent/world values whose local product fits in float32; `out` is left unchanged.

## Examples

```ts
import { composeMatrix, localFromWorld, multiplyMatrices } from "vgpu/scene";

const parentWorld = composeMatrix({ position: [0, 1, 0], scale: 2 }, new Float32Array(16));
const physicsWorld = composeMatrix({ position: [4, 1, 0] }, new Float32Array(16)); // from your physics step

const childLocal = localFromWorld(parentWorld, physicsWorld, new Float32Array(16));
const check = multiplyMatrices(parentWorld, childLocal, new Float32Array(16)); // equals physicsWorld
void check;
```

## Notes

- The result is a matrix, not position/rotation/scale: vgpu has no matrix decomposition and nodes cannot take a matrix. Feed the result to matrix consumers such as `evaluateHierarchy` locals rows or instance worlds.
- If the world matrix is already final and nothing inherits from it, skip the hierarchy and use the world matrix directly.
- The inverse and final local matrix are computed in doubles and each is checked against finite float32 range before `out` is written. Cancellation with `world` does not make an unrepresentable parent inverse valid.
- **See also:** `invertAffine`, `multiplyMatrices`, `evaluateHierarchy`.

---

# TransformValues

Position, rotation and scale input shared by `composeMatrix` and node options. Every field is optional; what an omitted field means depends on the consumer.

## Import

```ts
import type { TransformValues } from "vgpu/scene";
```

## Signature

```ts
interface TransformValues {
  position?: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  quaternion?: ArrayLike<number>;
  scale?: number | ArrayLike<number>;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| position | `ArrayLike<number>` | ✖ | `[0, 0, 0]` in `composeMatrix`; current value in `set()` | Exactly 3 finite numbers. |
| rotation | `ArrayLike<number>` | ✖ | no rotation in `composeMatrix`; current value in `set()` | Exactly 3 finite numbers, intrinsic XYZ Euler angles in radians. Converted to a quaternion; ignored and not validated when `quaternion` is present. |
| quaternion | `ArrayLike<number>` | ✖ | `[0, 0, 0, 1]` in `composeMatrix`; current value in `set()` | Exactly 4 finite numbers, XYZW, nonzero length. Normalized without modifying the input. |
| scale | `number \| ArrayLike<number>` | ✖ | `1` in `composeMatrix`; current value in `set()` | One number for uniform scale or exactly 3 per-axis numbers. |

**Returns:** Not a callable.

**Throws:** None by itself; consumers throw `VGPU-SCENE-VALUE` for invalid fields.

## Examples

```ts
import { composeMatrix, group, type TransformValues } from "vgpu/scene";

const pose: TransformValues = { position: [0, 1, 0], quaternion: [0, 0.7071, 0, 0.7071] };
composeMatrix(pose, new Float32Array(16)); // complete: scale defaults to 1
group().set(pose); // patch: fields you omit keep their current values
```

## Notes

- Tuples, plain arrays and typed arrays all work; values are read once and copied.
- Do not pass both `rotation` and `quaternion` expecting them to combine — `quaternion` wins and `rotation` is ignored.
- **See also:** `composeMatrix`, `NodeTransformValues`, `Vec3Like`, `QuatLike`.

---

# Mat4

A 4×4 matrix stored as a `Float32Array` of exactly 16 elements in column-major order. Every scene matrix output and every node matrix getter uses this type.

## Import

```ts
import type { Mat4 } from "vgpu/scene";
```

## Signature

```ts
type Mat4 = Float32Array;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| Mat4 | `Float32Array` | ✔ | — | Exactly 16 elements. Column `c`, row `r` lives at index `c * 4 + r`; translation is at 12, 13, 14; an affine matrix has `0, 0, 0, 1` at 3, 7, 11, 15. |

**Returns:** Not a callable.

**Throws:** None by itself; matrix functions throw `VGPU-SPATIAL-SIZE` when a `Mat4` does not have exactly 16 elements.

## Examples

```ts
import { composeMatrix, type Mat4 } from "vgpu/scene";

const identity: Mat4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
composeMatrix({ position: [1, 2, 3] }, identity);
console.log(identity[12], identity[13], identity[14]); // 1 2 3
```

## Notes

- The type alias cannot enforce the length; functions check it at runtime.
- A 16-element `subarray` of a larger `Float32Array` is a valid `Mat4`, which lets you write rows of packed matrix arrays in place.
- **See also:** `composeMatrix`, `multiplyMatrices`, `Vec3Like`.

---

# Vec3Like

Three-component vector input: a tuple, plain array, or typed array with exactly 3 numbers.

## Import

```ts
import type { Vec3Like } from "vgpu/scene";
```

## Signature

```ts
type Vec3Like = ArrayLike<number>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| Vec3Like | `ArrayLike<number>` | ✔ | — | Exactly 3 finite numbers at runtime; other lengths throw `VGPU-SCENE-VALUE`. |

**Returns:** Not a callable.

**Throws:** None by itself.

## Examples

```ts
import { group, type Vec3Like } from "vgpu/scene";

const target: Vec3Like = new Float32Array([0, 0, -5]);
group({ position: [0, 2, 0] }).lookAt(target);
```

## Notes

- The type alias cannot enforce the length; consumers check it at runtime and copy the values.
- **See also:** `QuatLike`, `TransformValues`, `Mat4`.

---

# QuatLike

Quaternion input in XYZW order: a tuple, plain array, or typed array with exactly 4 numbers.

## Import

```ts
import type { QuatLike } from "vgpu/scene";
```

## Signature

```ts
type QuatLike = ArrayLike<number>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| QuatLike | `ArrayLike<number>` | ✔ | — | Exactly 4 finite numbers, `[x, y, z, w]`, nonzero length. Need not be unit length: consumers normalize a copy. |

**Returns:** Not a callable.

**Throws:** None by itself; consumers throw `VGPU-SCENE-VALUE` for a wrong length, non-finite component, or zero-length quaternion.

## Examples

```ts
import { group, type QuatLike } from "vgpu/scene";

const halfTurnY: QuatLike = [0, 1, 0, 0];
const node = group({ quaternion: halfTurnY });
console.log(node.quaternion); // Float32Array [0, 1, 0, 0]
```

## Notes

- The identity rotation is `[0, 0, 0, 1]`, not `[1, 0, 0, 0]`.
- **See also:** `Vec3Like`, `TransformValues`, `SceneNode`.
