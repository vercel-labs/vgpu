---
"vgpu": minor
"@vgpu/wgsl-std": minor
---

## Summary

Rebuild `vgpu/scene` around material-independent scene composition: CPU transform math, parent/child groups, external hierarchy evaluation, fixed-capacity typed instances, and camera functions that operate on application-owned state. Geometry recipes remain available.

Add `vgpu/scene/gpu` to publish instance matrices and custom attributes as an instanced vertex stream, borrowing an existing mesh. Add pure `@vgpu/wgsl-std/scene` helpers for world matrices, positions, directions, and normals. Shaders own their resources and binding locations; applications connect uniforms by name and choose their own shading and passes.

Remove the previous mesh, material, light, camera-node, and orbit-control abstractions. This is a breaking pre-1.0 API revision.

## Migration

### Affected usage

Applications using the previous `vgpu/scene` authoring API must update imports and camera/object update code. Geometry recipes, `geometries`, `degToRad`, `srgb`, geometry types, and the material-independent `group`/`SceneNode` path remain.

| Removed or replaced export | Replacement |
| --- | --- |
| `scene` | Use `group` as the root. |
| `mesh`, `MeshNode` | Keep a transform in `group` or your own world matrix; use application-owned `geometry` and `draw`. Repeated objects can use `instances` and `instanceGeometry`. |
| `SceneMaterial`, `UnlitMaterial`, `unlitMaterial`, `LambertMaterial`, `lambertMaterial`, `NormalMaterial`, `normalMaterial`, `ShaderMaterial`, `shaderMaterial` | Author WGSL, pipeline state, and named uniforms. There is no replacement material object. |
| `ColorMaterialOptions`, `ColorMaterialValues`, `MaterialBlend`, `SceneMaterialKind`, `ShaderMaterialOptions` | Use application data types and existing draw options. |
| `AmbientLight`, `ambientLight`, `AmbientLightOptions`, `AmbientLightValues`, `DirectionalLight`, `directionalLight`, `DirectionalLightOptions`, `DirectionalLightValues` | Store light data in application state and pass it to your shader. |
| `PerspectiveCamera`, `perspectiveCamera`, `PerspectiveCameraOptions`, `PerspectiveCameraValues` | Use `Lens`, `Pose`, `perspective`, and `viewMatrices`; optionally derive the pose with `orbitRig`/`rigPose`. |
| `OrthographicCamera`, `orthographicCamera`, `OrthographicCameraOptions`, `OrthographicCameraValues` | Use `orthographic(bounds, out)` and `viewMatrices`. |
| `Camera`, `SceneCamera`, `CameraVec3` | Use `Pose`, `Lens`, `CameraMatrices`, and `Vec3Like` or `ArrayLike<number>`. World camera position is `pose.position`. |
| `OrbitControls`, `orbitControls`, `OrbitControlsElement`, `OrbitControlsOptions`, `OrbitControlsValues` | Own input listeners and independent goal/current `OrbitRig` values; compose `orbit`, `pan`, `dolly`, and `smoothRig`. Remove listeners when disposing your application input handler. |
| `orbit(time, options)`, `OrbitOptions` | Animate objects with `composeMatrix`. The new `orbit(rig, deltaYaw, deltaPitch, limits?)` mutates camera rig state and returns that rig. |
| Non-group `SceneNodeKind` members | Only `"group"` remains. Store application classifications separately. |

### Steps

#### Replace object animation separately from camera orbit

Before:

```ts illustrative
import { orbit } from "vgpu/scene";
const model = orbit(time, { radius: 2, height: 0.5, speed: 0.3 });
```

After:

```ts
import { composeMatrix } from "vgpu/scene";

const model = new Float32Array(16);
function updateObject(time: number) {
  const angle = time * 0.3;
  composeMatrix({
    position: [Math.cos(angle) * 2, 0.5, Math.sin(angle) * 2],
    rotation: [0, angle, 0],
  }, model);
}
```

The old `orbit` allocated a new matrix; `composeMatrix` writes into your reusable `out`. Choose radius, height, and speed explicitly. A radius of zero remains a centered object; do not substitute camera `orbit` for this animation.

#### Separate transforms from materials and geometry

Before:

```ts illustrative
const root = scene();
const object = mesh(box(), normalMaterial(), { position: [1, 0, 0] });
root.add(object);
```

After, the same hierarchy can supply world matrices to instances independently of shading:

```ts
import { group, instances } from "vgpu/scene";

const root = group();
const object = group({ position: [1, 0, 0] });
root.add(object);
const objects = instances({
  capacity: 100,
  attributes: { tint: { format: "float32x4", default: [1, 1, 1, 1] } },
});
const id = objects.add();
objects.bindWorld(id, () => object.worldMatrix);
object.set({ position: [2, 0, 0] });
objects.syncWorlds();
```

Borrowed node vectors/matrices are read-only by contract; change local fields through `.set()`. Adding/removing a parent preserves the local transform, not the world transform. `visible` is metadata: it does not hide an instance or skip a draw automatically. Node composition normalizes nonzero quaternions; zero quaternions and non-finite values now produce actionable `VGPU-SCENE-VALUE` errors. Check error handling that depended on previous invalid-value behavior.

Instance capacity is fixed. To grow, recreate the collection/bridge, copy application data, restore world bindings, and replace handles and draws. Handles remain stable only while their instance lives; dense slots move on removal. Keep picking IDs or per-submission slot mappings in application state, and do not serialize `InstanceId` values.

#### Own the camera state and update its matrices explicitly

Before:

```ts illustrative
const camera = perspectiveCamera({
  fov: 45, aspect: width / height,
  position: [2, 2, 3], target: [0, 0, 0], up: [0, 1, 0],
});
camera.set({ aspect: width / height });
drawable.set({ camera: { viewProjection: camera.viewProjection } });
```

After, preserve arbitrary eye/target/up authoring with a transform and a plain pose:

```ts
import { group, perspective, viewMatrices } from "vgpu/scene";

const lens = { fov: 45, near: 0.1, far: 100 };
const eye = group({ position: [2, 2, 3] });
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = new Float32Array(16);
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

function updateCamera(aspect: number, target: ArrayLike<number>, up: ArrayLike<number>) {
  eye.lookAt(target, up);
  pose.position.set(eye.worldPosition);
  pose.quaternion.set(eye.quaternion); // this unparented node is a world pose
  perspective(lens, aspect, projection);
  viewMatrices(pose, projection, matrices);
}
updateCamera(16 / 9, [0, 0, 0], [0, 1, 0]);
```

A camera attached to a transformed parent can remain a `group`. Invert its complete world matrix to preserve the previous camera-node behavior, including parent scale. A `Pose` contains only world position and quaternion; copying a parented node's local quaternion into it would lose the parent transform.

```ts
import { group, invertAffine, multiplyMatrices, perspective } from "vgpu/scene";

const mount = group({ position: [2, 1, 0], rotation: [0, 0.3, 0] });
const cameraNode = group({ position: [0, 0, 5] });
mount.add(cameraNode);
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, 16 / 9, new Float32Array(16));
const view = new Float32Array(16);
const viewProjection = new Float32Array(16);
invertAffine(cameraNode.worldMatrix, view);
multiplyMatrices(projection, view, viewProjection);
// Repeat these two operations and your draw.set({ camera: { viewProjection } }) after changes.
```

The world transform must be invertible; zero scale throws `VGPU-SPATIAL-SINGULAR`.

The old camera defaults `near: 0.1`, `far: 100`, and `aspect: 1` are application choices now. Perspective requires finite `0 < near < far`, finite positive aspect, and FOV in degrees strictly between 0 and 180. Replace infinite far planes with a finite distance. Orthographic bounds must be finite and ordered (`left < right`, `bottom < top`, `0 <= near < far`); its near plane may be zero. The old orthographic camera rejected equal bounds but allowed flipped bounds; mirrored bounds now throw `VGPU-CAMERA-VALUE`. To preserve a mirrored projection, supply your own projection matrix to `viewMatrices`. Both projections use right-handed −Z view space and WebGPU depth 0..1.

For interactive orbiting, create independent current and goal rigs. Apply events to the goal with `orbit`, `pan`, and `dolly`; call `smoothRig(current, goal, dt, { timeConstant })` with explicit nonnegative seconds, then `rigPose`. Distance smoothing is logarithmic. The old controls blended distance linearly, defaulted missing or non-finite time steps to 1/60 second, snapped within 1e-6, and returned a changed boolean. `smoothRig` requires explicit finite nonnegative time, returns the current rig, and has no epsilon snap or changed boolean; maintain your own settling/render policy. `timeConstant: 0` snaps even at `dt: 0`; positive time constants with `dt: 0` leave current state unchanged. Do not share current/goal vectors. The default pitch range is now ±(π/2−1e−4); pass explicit limits to preserve the previous ±(π/2−0.01) range. `dolly` changes distance, while `zoom` changes the lens independently.

#### Feed external hierarchy or physics data directly

External systems can keep their own arrays without constructing nodes:

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder, instances } from "vgpu/scene";

const parents = new Int32Array([-1, 0]);
const locals = new Float32Array(32);
const worlds = new Float32Array(32);
composeMatrix({ position: [1, 0, 0] }, locals.subarray(0, 16));
composeMatrix({ position: [0, 2, 0] }, locals.subarray(16, 32));
const order = hierarchyOrder(parents);
evaluateHierarchy({ order, parents, locals, worlds }); // full initialization
const objects = instances({ capacity: 2 });
const ids = [objects.add(), objects.add()];
objects.setWorlds(ids, worlds);

const changed = new Uint8Array([1, 0]);
composeMatrix({ position: [3, 0, 0] }, locals.subarray(0, 16));
evaluateHierarchy({ order, parents, locals, worlds, changed });
objects.setWorlds(ids, worlds); // parent change also reaches the child
changed.fill(0); // evaluator leaves input flags untouched
```

Rebuild the opaque order after changing parents and perform a full evaluation after topology changes or world-output replacement/reset. Supply finite affine locals, exact array lengths, and non-overlapping output storage. Evaluation scans all rows; dirty flags reduce matrix recomputation, not traversal. A physics system that already has final world matrices calls `setWorlds` directly and skips hierarchy evaluation.

Direct world batches validate before writing. Bound sources are arbitrary synchronous application functions: if `syncWorlds()` throws, some earlier source results may already have been copied. Abort that frame and repair/retry or unbind/update affected sources before publication. Mutating or publishing the collection during source synchronization is rejected.

#### Connect GPU resources explicitly

Drawing with a destroyed ordinary `Geometry`, recording it in a bundle, or replaying a bundle that uses it now throws `VGPU-MESH-LAYOUT-INVALID` synchronously in vgpu instead of reaching WebGPU validation. Recreate the geometry and its draws, and re-record affected bundles before rendering again. Bridges report their corresponding lifetime failure as `VGPU-INSTANCE-DESTROYED`.

Create the bridge from `vgpu/scene/gpu`, borrowing a live, non-instanced mesh from the same GPU. Declare four world columns and every custom instance attribute in each consuming vertex entry. The world matrix costs four vertex attributes and 64 bytes per record, plus your 32-bit attributes. Account for device limits, up to eight vertex buffers and 2048-byte stride; split batches or reduce attributes/capacity when preflight reports `VGPU-INSTANCE-LAYOUT`.

Your shader chooses the uniform group and binding:

```wgsl
struct CameraData { viewProjection: mat4x4f }
@group(1) @binding(0) var<uniform> camera: CameraData;
```

The app uses the resource name, without repeating group numbers in scene code:

```ts illustrative
const bridge = instanceGeometry(gpu, objects, { mesh: geometry(gpu, box()) });
const drawable = draw(gpu, { shader, geometry: bridge.geometry });

// Each frame, before encoding either consumer:
objects.syncWorlds(); // or setWorlds(ids, finalWorlds)
viewMatrices(pose, projection, matrices);
const count = bridge.publish();
drawable.set({ camera: { viewProjection: matrices.viewProjection } });
frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: firstTarget }, (pass) => pass.draw(drawable, { instances: count }));
  currentFrame.pass({ target: secondTarget }, (pass) => pass.draw(drawable, { instances: count }));
});
```

The frame excerpt above assumes your shader and two targets; the complete runnable setup is in the Scene composition guide and `examples/by-example-s06-scene/src/composition.ts`. `publish()` never updates sources or cameras and returns an explicit count, including zero. Unchanged publication writes no instance bytes; separate bridges have independent upload cursors. Record the returned count explicitly in bundles and re-record when it changes.

Uniform `.set()` packs at call time: repeat it after every matrix mutation. Nothing is auto-injected, no group is reserved, and matrix arrays do not stay live inside a previously packed uniform. Publish before encoding all passes that consume those bytes. Do not rewrite their buffer while earlier consumers remain unsubmitted; different per-pass contents require separate buffers. Later queue-ordered frames do not require waiting for GPU idle.

Destroying a bridge destroys its added instance buffer and composed wrapper, never the borrowed base mesh. Destroying the base invalidates the composed geometry, including previously compiled draws and recorded bundles. Recreate the bridge/draw and re-record bundles; raw GPUBuffer destruction outside the geometry lifecycle is not automatically detectable.

Import `instanceWorldMatrix`, `transformPosition`, `transformDirection`, and `transformNormal` from `@vgpu/wgsl-std/scene` in WGSL. They are pure helpers with no bindings. Position uses `w=1`, direction uses `w=0`; normals use normalized inverse-transpose and preserve reflection sign. Pass the complete world/deformation transform. Zero fallback tests computed float32 zero, with no arbitrary epsilon or symbolic-rank guarantee; extreme ill-conditioned inputs and backend subnormal handling can still lose direction/sign accuracy.

### Verification

- Typecheck imports, required instance attributes, camera state, and new `orbit` call sites.
- Run CPU checks for hierarchy changes, full initialization, parent propagation, world-source recovery, camera resize, and explicit time steps.
- Check native GPU output for transformed positions/normals and both passes. Mutate a camera matrix and explicitly repack it to confirm the next output changes.
- Verify zero instances, swap removal, application picking mappings, independent mirrors, and destroy/recreate paths. Re-record captured bundle counts when needed.
- Use the complete Scene composition guide and the three equivalent paths in `examples/by-example-s06-scene` as migration references. Materials, PBR, lights, event handling, and scheduling remain application responsibilities.
