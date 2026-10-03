---
title: Using math with scene data
summary: Use pmndrs/math for numerical operations and vgpu/scene for hierarchies, instances, cameras, and explicit GPU publication. Pass ordinary matrices across the boundary without a compatibility class.
keywords: math, pmndrs, external math, interoperability, scope, boundary, matrix, quaternion, float32, typed array, setWorld, setWorlds, bindWorld, ecs, physics, perspectiveZO, orthoZO
relatedSymbols:
  - instances
  - InstanceCollection
  - evaluateHierarchy
  - instanceGeometry
  - composeMatrix
  - viewMatrices
---

# Using math with scene data

Use [`math` from pmndrs](https://github.com/pmndrs/math) for general numerical operations and
`vgpu/scene` for composing data into a scene. Pass math arrays directly to vgpu's array inputs;
copy vgpu's typed-array outputs into math tuples when reading them back into math. No adapter
class is required. `math` is an optional application dependency, not a vgpu runtime dependency.

## Choose who owns each operation

| Need | Use |
| --- | --- |
| Vector/quaternion arithmetic, matrix decomposition, interpolation | `math` |
| Spatial queries, springs, noise, random values, inverse kinematics | The corresponding `math` subpath, or another specialized library |
| Parent/child relationships and world propagation | `group`, or `hierarchyOrder` and `evaluateHierarchy` over your arrays |
| Instance identity, packed attributes, external world matrices | `instances` |
| Orbit/pan/dolly behavior on application-owned camera state | The composable camera functions in `vgpu/scene` |
| Renderable boxes, spheres, and other mesh recipes | Geometry recipes in `vgpu/scene` |
| Instance uploads and vertex stream layout | `instanceGeometry` from `vgpu/scene/gpu` |
| Shader-side transform math | `@vgpu/wgsl-std/scene` in your WGSL |

The existing `composeMatrix`, `multiplyMatrices`, `invertAffine`, `localFromWorld`, projections,
`degToRad`, and `srgb` remain supported conveniences. You can keep using them. Scene utilities do
not aim to provide a complete CPU math API, an ECS, physics, or a material system.

## Pass a math matrix into an instance

Install `math` in the application. These examples are checked against `math@0.1.0`.

```sh
npm install math@0.1.0
```

```ts
import { mat4, quat, type Vec3 } from "math";
import { instances } from "vgpu/scene";

const objects = instances({ capacity: 1 });
const objectId = objects.add();
const position: Vec3 = [2, 0, 0];
const rotation = quat.create(); // identity XYZW quaternion
const scale: Vec3 = [1, 2, 1];
const world = mat4.create(); // math's plain-array Mat4

mat4.fromRotationTranslationScale(world, rotation, position, scale);
objects.setWorld(objectId, world); // validates and copies into the instance record

position[0] = 3;
mat4.fromRotationTranslationScale(world, rotation, position, scale);
objects.setWorld(objectId, world); // repeat the copy after computing a new world
```

`setWorld` accepts `ArrayLike<number>`, so no intermediate `Float32Array` is necessary for this
call. It still copies and stores float32 data. Later changes to `world` have no effect until you
call `setWorld` again. A bound source is another option: `bindWorld(id, () => world)` followed by
`syncWorlds()` each update. Do not also call `setWorld` on a bound instance; unbind it first.

After CPU updates, call your bridge's `publish()` before encoding its consumers, and pass its
returned count to each draw. The complete setup is in [Scene composition](scene-composition.docs.md).

## Write local transforms into an external hierarchy

Packed hierarchy arrays must be typed arrays even when you calculate each local matrix with
`math`. Allocate them once and make the representation change explicit:

```ts
import { mat4 } from "math";
import { evaluateHierarchy, hierarchyOrder, instances } from "vgpu/scene";

const parents = new Int32Array([-1, 0]);
const order = hierarchyOrder(parents);
const locals = new Float32Array(32);
const worlds = new Float32Array(32);
const local = mat4.create();

locals.set(local, 0); // root identity
mat4.fromTranslation(local, [0, 2, 0]);
locals.set(local, 16); // child local, copied into row 1
evaluateHierarchy({ order, parents, locals, worlds }); // full initialization

const objects = instances({ capacity: 2 });
const ids = [objects.add(), objects.add()];
objects.setWorlds(ids, worlds);
```

For later updates, rewrite the affected local rows and evaluate again. If you use dirty flags,
mark changed rows yourself and fully evaluate after topology changes or replacing the output
buffer. Hierarchy evaluation trusts matrix values for speed; validate untrusted data before
writing rows. See the [hierarchy contract](scene-composition.docs.md#evaluate-a-hierarchy-stored-in-your-own-arrays).

If physics or an ECS already calculates final world matrices, skip vgpu hierarchy evaluation and
pass those worlds to `setWorld` or `setWorlds`. Do not multiply a parent into an already-world-space
matrix again.

## Read a vgpu matrix with math

In `math@0.1.0`, `Mat4` is a fixed-length array tuple. A vgpu `Float32Array` is not assignable to
that type, even though both contain 16 numbers. Copy into a reusable math matrix before calling
its matrix operations; do not cast away the type difference. For example, decompose a world
matrix containing translation, rotation, and positive scale:

```ts
import { mat4, quat, vec3 } from "math";
import { group } from "vgpu/scene";

const node = group({ position: [2, 0, 0], scale: [1, 2, 1] });
const matrix = mat4.create();
const rotation = quat.create();
const position = vec3.create();
const scale = vec3.create();

const world = node.worldMatrix; // borrowed vgpu output: read, do not mutate
for (let i = 0; i < 16; i++) matrix[i] = world[i]!;
mat4.decompose(rotation, position, scale, matrix);
```

Reuse these outputs and repeat the copy after the node changes. For packed hierarchy worlds,
read row `r` from `worlds[r * 16 + i]`. For a vgpu `Pose`, `vec3.fromBuffer(position, pose.position, 0)`
and `quat.fromBuffer(rotation, pose.quaternion, 0)` copy into math tuples. A sheared world matrix
cannot generally round-trip through translation/rotation/scale; preserve the original matrix when
your external system is matrix-authoritative.

## Match camera and matrix conventions

Both libraries use column-major matrices and XYZW quaternions. Keep multiplication order explicit:
`world = parentWorld * local` and `viewProjection = projection * view`.

For a camera managed outside vgpu, you can compute its entire view-projection matrix with `math`:

```ts
import { mat4 } from "math";

const projection = mat4.create();
const view = mat4.create();
const viewProjection = mat4.create();
const cameraUniform = new Float32Array(16);

mat4.perspectiveZO(projection, Math.PI / 4, 960 / 540, 0.1, 100);
mat4.lookAt(view, [0, 0, 8], [0, 0, 0], [0, 1, 0]);
mat4.multiply(viewProjection, projection, view); // math takes out first
cameraUniform.set(viewProjection); // ready for your named uniform .set()
```

Use `perspectiveZO` or `orthoZO` for WebGPU's `0..1` depth range. `math`'s perspective field of
view is in radians; vgpu's `Lens.fov` is in degrees. `math` operations take the output first,
whereas vgpu's transform conveniences take it last. Their validation and failure semantics also
differ: for example, `math`'s matrix inversion returns `null` for a singular matrix; vgpu's
`invertAffine` throws a structured error and leaves its output unchanged.

Alternatively, use vgpu camera behavior to fill a `Pose`, and pass a math projection directly
to `viewMatrices`, whose projection input accepts `ArrayLike<number>`. Keep one authority for camera
pose and one for projection; neither library subscribes to the other's mutations.

The WGSL declaration still chooses its own group and binding. After each camera update, call
your draw's named setter again, for example `drawable.set({ camera: { viewProjection: cameraUniform } })`
when the shader declares `camera.viewProjection`. Nothing in `math` or the scene helpers injects
uniforms or reserves bind groups. See
[Connect the camera to your shader by name](scene-composition.docs.md#connect-the-camera-to-your-shader-by-name)
for the explicit binding setup.
