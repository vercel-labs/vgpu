---
title: Camera state
summary: Compose orbit, pan, dolly, zoom, smoothing, and projection with application-owned camera state.
---

# orbitRig

Creates the mutable state of an orbit camera: a followed point, a world-space pan offset, yaw, pitch and distance. Use it for the goal and current rigs of a smoothed orbit camera; you own the state, the input handling and the update order.

## Import

```ts
import { orbitRig } from "vgpu/scene";
```

## Signature

```ts
declare function orbitRig(initial?: import("vgpu/scene").OrbitRigOptions): import("vgpu/scene").OrbitRig;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| initial | `OrbitRigOptions` | ✖ | `{}` | Every omitted field takes its default. |
| initial.target | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | World-space point the camera looks at. Exactly 3 finite float32-representable numbers. Copied into a new `Float32Array`. |
| initial.pan | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | World-space offset added to `target`. Same rules as `target`; copied into its own `Float32Array`. |
| initial.yaw | `number` | ✖ | `0` | Radians around world +Y. Any finite value; never wrapped. |
| initial.pitch | `number` | ✖ | `0` | Radians of elevation. Strictly between `-π/2` and `π/2`. Not clamped to the default `RigLimits`; the next `orbit()` clamps it. |
| initial.distance | `number` | ✖ | `1` | Camera distance from the pivot in world units. Finite and positive. |

**Returns:** `OrbitRig` — a new object whose `target` and `pan` are new `Float32Array(3)`s. Two rigs from `orbitRig()` never share vectors, and later changes to your input arrays do not affect the rig.

**Throws:**
- `VGPU-CAMERA-SIZE` when `target` or `pan` does not have exactly 3 values — pass 3 components.
- `VGPU-CAMERA-VALUE` when a `target` or `pan` component is `NaN`, `Infinity` or outside finite float32 range (about ±3.4e38), `yaw` is not finite, `pitch` is not strictly between `-π/2` and `π/2`, or `distance` is not finite and positive — the message names the field; pass values in those ranges.

## Examples

```ts
import { degToRad, orbitRig } from "vgpu/scene";

const goal = orbitRig({ target: [0, 1, 0], yaw: degToRad(30), pitch: degToRad(20), distance: 6 });
const current = orbitRig({ target: [0, 1, 0], yaw: degToRad(30), pitch: degToRad(20), distance: 6 }); // separate vectors
```

A complete smoothed orbit camera following a moving object. Input changes the goal, `smoothRig` eases an independent current rig toward it, and the matrices are packed into the draw on every update:

```wgsl
// scene.wgsl
struct ModelData { world: mat4x4f }
struct CameraData { viewProjection: mat4x4f }
@group(0) @binding(0) var<uniform> model: ModelData;
@group(1) @binding(0) var<uniform> camera: CameraData;

struct VertexOut { @builtin(position) position: vec4f, @location(0) normal: vec3f }

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.position = camera.viewProjection * model.world * vec4f(position, 1.0);
  out.normal = (model.world * vec4f(normal, 0.0)).xyz;
  return out;
}

@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let shade = max(dot(normalize(normal), normalize(vec3f(0.4, 1.0, 0.6))), 0.15);
  return vec4f(vec3f(0.9, 0.5, 0.2) * shade, 1.0);
}
```

```ts
import { clock, draw, frameLoop, geometry, init, surface } from "vgpu";
import {
  box, composeMatrix, dolly, orbit, orbitRig, pan, perspective, rigPose, smoothRig, viewMatrices, worldPerPixel,
  type CameraMatrices, type Lens, type Pose, type RigLimits,
} from "vgpu/scene";
import sceneShader from "./scene.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);

// ---cut---
const cube = draw(gpu, { shader: sceneShader, geometry: geometry(gpu, box({ size: 1 })), cull: "back" });

const limits: RigLimits = { minPitch: -0.2, maxPitch: 1.2, minDistance: 2, maxDistance: 30 };
const goal = orbitRig({ yaw: 0.6, pitch: 0.4, distance: 6 }); // input writes here
const current = orbitRig({ yaw: 0.6, pitch: 0.4, distance: 6 }); // smoothRig writes here
const lens: Lens = { fov: 50, near: 0.1, far: 100 };
const pose: Pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = new Float32Array(16);
const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
const cubeWorld = new Float32Array(16);

// input is yours: pick the listeners, buttons and sensitivity
canvas.addEventListener("pointermove", (event) => {
  if (event.buttons !== 1) return;
  if (event.shiftKey) {
    const unitsPerPixel = worldPerPixel(current.distance, lens, Math.max(1, canvas.clientHeight)); // CSS pixels
    pan(goal, -event.movementX * unitsPerPixel, event.movementY * unitsPerPixel); // along goal's right/up axes
  } else {
    orbit(goal, -event.movementX * 0.005, event.movementY * 0.005, limits); // 0.005 radians per CSS pixel
  }
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  dolly(goal, Math.exp(event.deltaY * 0.001), limits); // factor > 1 moves away
}, { passive: false });

frameLoop(gpu, (currentFrame) => {
  const { time, deltaTime } = clock(gpu);

  // 1. move the followed object, then point the goal at it; goal.pan keeps the user's offset
  const angle = time * 0.5;
  composeMatrix({ position: [Math.cos(angle) * 3, 0.5, Math.sin(angle) * 3], rotation: [0, angle, 0] }, cubeWorld);
  goal.target.set(cubeWorld.subarray(12, 15)); // world translation

  // 2. the input handlers above already changed the goal with orbit/pan/dolly

  // 3. ease the independent current rig toward the goal
  smoothRig(current, goal, deltaTime, { timeConstant: 0.12 });

  // 4. matrices from the smoothed state
  rigPose(current, pose);
  perspective(lens, canvasSurface.size[0] / canvasSurface.size[1], projection);
  viewMatrices(pose, projection, matrices);

  // 5. set() packs the values now, so repeat it on every update
  cube.set({ model: { world: cubeWorld }, camera: { viewProjection: matrices.viewProjection } });
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.08, 1] }, (pass) => pass.draw(cube));
});
```

The shader author chooses `@group(1) @binding(0)` for the camera; reflection maps the binding name `camera`, so the TypeScript side names no group index. `smoothRig` runs before `rigPose`, so the pose always comes from the current rig, never the goal.

## Notes

- Keep two rigs: a goal that input and following write, and a current that only `smoothRig` writes. Create both with `orbitRig()`; `smoothRig` throws `VGPU-CAMERA-ALIAS` when they share an object or any vector storage.
- To follow an object, write its world position into `goal.target` every update and leave `goal.pan` alone: the pan is a separate world-space offset, so the user's pan survives while the target moves. To follow without lag, also write `current.target`, or pass `timeConstant: 0`.
- The rig is plain data. You may write any field directly; every function validates the rig it reads (finite float32 3-vectors, finite `yaw`, `pitch` strictly inside `(-π/2, π/2)`, finite positive `distance`) and throws before changing anything when it is invalid. Direct writes are not clamped to your `RigLimits`.
- No input listeners, pointer sensitivity, scheduler, camera node or automatic uniform upload exist: you call each function in the order you want, and you pack the result into your draws.
- **See also:** `OrbitRig`, `orbit`, `pan`, `dolly`, `smoothRig`, `rigPose`, `viewMatrices`, `worldPerPixel`. See [Scene composition](/guides/scene-composition) for the complete update loop and [Scene migration](/guides/scene-migration) for removed API replacements.

## Migrate from camera nodes and orbitControls

`perspectiveCamera`, `orthographicCamera`, the camera node classes and `orbitControls` are removed. Their state now lives in your `OrbitRig`, `Lens`, `Pose` and matrix arrays. The scene composition guide and the release migration notes carry the full removed-export table.

Before (removed API):

```ts illustrative
import { clock, frameLoop } from "vgpu";
import { orbitControls, perspectiveCamera } from "vgpu/scene";

const camera = perspectiveCamera({ fov: 45, aspect: 16 / 9, near: 0.1, far: 100, position: [2, 2, 3], target: [0, 0, 0] });
const controls = orbitControls(camera, { element: canvas, damping: 0.1 });
cube.set({ camera: { viewProjection: camera.viewProjection } }); // bound once, updated in place

frameLoop(gpu, () => {
  controls.update(clock(gpu).deltaTime);
});
```

After — convert the old `position`/`target` pair into a rig once:

```ts
import { orbitRig, perspective, rigPose, viewMatrices, type CameraMatrices, type Lens, type Pose } from "vgpu/scene";

const eye = { x: 2, y: 2, z: 3 }; // old options.position
const lookAt = { x: 0, y: 0, z: 0 }; // old options.target
const offsetX = eye.x - lookAt.x, offsetY = eye.y - lookAt.y, offsetZ = eye.z - lookAt.z;
const rig = orbitRig({
  target: [lookAt.x, lookAt.y, lookAt.z],
  yaw: Math.atan2(offsetX, offsetZ),
  pitch: Math.atan2(offsetY, Math.hypot(offsetX, offsetZ)),
  distance: Math.hypot(offsetX, offsetY, offsetZ),
});

const lens: Lens = { fov: 45, near: 0.1, far: 100 }; // old fov/near/far; aspect moves to perspective()
const pose: Pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const projection = new Float32Array(16);
const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

rigPose(rig, pose);
perspective(lens, 16 / 9, projection);
viewMatrices(pose, projection, matrices); // then draw.set({ camera: { viewProjection: matrices.viewProjection } })
```

| Removed | Replacement |
|---|---|
| `perspectiveCamera({ fov, aspect, near, far })` | A `Lens` plus `perspective(lens, aspect, out)`. |
| `orthographicCamera({ left, right, bottom, top, near, far })` | `orthographic(bounds, out)`. |
| camera `position` / `target` / `up` / `lookAt()` / parenting under a group | A world-space `Pose` from `rigPose(rig, pose)`, or one you compute yourself. |
| `camera.view`, `camera.viewProjection` | `viewMatrices(pose, projection, matrices)`. |
| `camera.set({ fov, aspect, near, far })` | Change the `Lens` (or call `zoom`) and call `perspective` again. |
| `orbitControls(node, { element, rotateSpeed, zoomSpeed })` | Your own listeners calling `orbit`, `pan` and `dolly` on the goal rig; multiply pointer deltas by your sensitivity (the old default was `0.005` radians per pixel). The old wheel zoom changed distance: use `dolly`, not `zoom`. |
| `orbitControls` `damping`, `distance`, `pitch` options | `smoothRig(current, goal, dt, { timeConstant })` (the old `damping` was already a time constant in seconds) and `RigLimits`. |
| `controls.update(deltaTime?)` | `smoothRig` with an explicit `dt`. |
| binding `camera.viewProjection` once | `draw.set({ camera: { viewProjection: matrices.viewProjection } })` after every change. |
| `VGPU-SCENE-VALUE-INVALID` from cameras | `VGPU-CAMERA-VALUE`, `VGPU-CAMERA-SIZE`, `VGPU-CAMERA-ALIAS`. |

Behavior changes to check when you migrate:

- `dt` is explicit. `smoothRig` has no fallback frame time; pass `clock(gpu).deltaTime` or your own finite, nonnegative seconds.
- Distance smooths in log space, so zooming from 1 to 100 passes 10 halfway instead of 50.5. The old controls interpolated distance linearly.
- The default pitch limits are `±(π/2 − 1e-4)` radians instead of the old `±(π/2 − 0.01)`, so the camera can get closer to the poles. Pass `{ minPitch: -(Math.PI / 2 - 0.01), maxPitch: Math.PI / 2 - 0.01 }` to keep the old range.
- The old orthographic camera rejected equal bounds but accepted flipped (mirrored) horizontal or vertical ranges. `orthographic` now requires `left < right` and `bottom < top` and throws `VGPU-CAMERA-VALUE` for flipped bounds. To mirror an image, build your own projection and pass it to `viewMatrices`. `near` may now be `0` (the old camera required a positive `near` and defaulted it to `0.1`).
- `Lens.far` must be finite. For an infinite far plane, build your own projection and pass it to `viewMatrices`.
- Matrices no longer update in place behind a stable binding. Each `set()` copies values when you call it.

---

# OrbitRig

The mutable orbit-camera state created by `orbitRig()` and changed by `orbit`, `pan`, `dolly` and `smoothRig`.

## Import

```ts
import type { OrbitRig } from "vgpu/scene";
```

## Signature

```ts
interface OrbitRig {
  target: Float32Array;
  pan: Float32Array;
  yaw: number;
  pitch: number;
  distance: number;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| target | `Float32Array` | ✔ | — | Exactly 3 finite values: the world-space point to follow. `orbitRig()` starts it at `[0, 0, 0]`. Write it (`goal.target.set(...)`) to follow an object. |
| pan | `Float32Array` | ✔ | — | Exactly 3 finite values: a world-space offset added to `target`. `orbitRig()` starts it at `[0, 0, 0]`. `pan()` accumulates into it. |
| yaw | `number` | ✔ | — | Radians around world +Y, finite, never wrapped. `0` places the camera on the +Z side of the pivot; positive yaw moves it toward +X. `orbitRig()` starts it at `0`. |
| pitch | `number` | ✔ | — | Radians, strictly between `-π/2` and `π/2`. Positive pitch raises the camera above the pivot so it looks down. `orbitRig()` starts it at `0`. |
| distance | `number` | ✔ | — | Finite, positive world-space distance from the pivot to the camera. `orbitRig()` starts it at `1`. |

## Examples

```ts
import { orbitRig, type OrbitRig } from "vgpu/scene";

const rig: OrbitRig = orbitRig({ distance: 8 });
rig.target.set([0, 2, -1]); // direct writes are allowed; the next rig function validates them
rig.yaw += Math.PI / 8;
```

## Notes

- The pivot is `target + pan`. The camera sits at `pivot + distance × [cos(pitch)·sin(yaw), sin(pitch), cos(pitch)·cos(yaw)]` and looks at the pivot along its local -Z axis, with +Y up (right-handed).
- Keep `target` and `pan` in separate storage. Build rigs with `orbitRig()` instead of object literals that share or overlap arrays: `smoothRig` rejects overlapping vectors with `VGPU-CAMERA-ALIAS`.
- `yaw` is unwrapped on purpose, so continuous spins keep accumulating. If you assign an absolute heading to `goal.yaw`, unwrap it relative to the current yaw yourself, or `smoothRig` takes the long way around.
- **See also:** `orbitRig`, `OrbitRigOptions`, `RigLimits`, `rigPose`.

---

# OrbitRigOptions

Initial values for `orbitRig()`. Every field is optional and copied.

## Import

```ts
import type { OrbitRigOptions } from "vgpu/scene";
```

## Signature

```ts
interface OrbitRigOptions {
  target?: ArrayLike<number>;
  pan?: ArrayLike<number>;
  yaw?: number;
  pitch?: number;
  distance?: number;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| target | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | Exactly 3 finite float32-representable numbers. Copied. |
| pan | `ArrayLike<number>` | ✖ | `[0, 0, 0]` | Exactly 3 finite float32-representable numbers. Copied. |
| yaw | `number` | ✖ | `0` | Finite radians. |
| pitch | `number` | ✖ | `0` | Radians strictly between `-π/2` and `π/2`. |
| distance | `number` | ✖ | `1` | Finite and positive. |

## Examples

```ts
import { orbitRig, type OrbitRigOptions } from "vgpu/scene";

const start: OrbitRigOptions = { target: new Float32Array([0, 1, 0]), pitch: 0.3, distance: 5 };
const goal = orbitRig(start);
const current = orbitRig(start); // same values, independent vectors
```

## Notes

- One options object can seed several rigs: each `orbitRig()` call copies `target` and `pan` into new arrays.
- **See also:** `orbitRig`, `OrbitRig`.

---

# RigLimits

Pitch and distance bounds applied by `orbit()` and `dolly()`. Limits are not stored in the rig: pass the same object on every call that should respect them.

## Import

```ts
import type { RigLimits } from "vgpu/scene";
```

## Signature

```ts
interface RigLimits {
  minPitch?: number;
  maxPitch?: number;
  minDistance?: number;
  maxDistance?: number;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| minPitch | `number` | ✖ | `-(π/2 − 1e-4)` (≈ `-1.5706963`) | Radians, strictly between `-π/2` and `π/2`, and `<= maxPitch`. |
| maxPitch | `number` | ✖ | `π/2 − 1e-4` (≈ `1.5706963`) | Radians, strictly between `-π/2` and `π/2`, and `>= minPitch`. |
| minDistance | `number` | ✖ | `1e-4` | Finite, positive, and `<= maxDistance`. |
| maxDistance | `number` | ✖ | `Infinity` | Positive and finite, or `Infinity`. |

Equal minimum and maximum values are valid and pin the value.

## Examples

```ts
import { dolly, orbit, orbitRig, type RigLimits } from "vgpu/scene";

const limits: RigLimits = { minPitch: 0.05, maxPitch: 1.4, minDistance: 2, maxDistance: 40 };
const goal = orbitRig({ pitch: 0.3, distance: 10 });
orbit(goal, 0, 5, limits); // pitch clamps to 1.4
dolly(goal, 100, limits); // distance clamps to 40
```

## Notes

- `orbit()` and `dolly()` validate all four fields on every call, even the ones they do not apply: an invalid distance limit also fails `orbit()`. One shared limits object for both calls is the intended use.
- Limits bound only the results of `orbit()` (pitch) and `dolly()` (distance). `orbitRig()`, `pan()`, `smoothRig()` and direct field writes ignore them. `smoothRig` stays between the current and goal values, so it stays inside your limits when both rigs are.
- Invalid or reversed limits throw `VGPU-CAMERA-VALUE` before the rig changes.
- **See also:** `orbit`, `dolly`, `OrbitRig`.

---

# orbit

Rotates an orbit rig around its pivot by adding yaw and pitch deltas, clamping pitch to limits. Use it from your pointer or keyboard handlers on the goal rig. This `orbit` changes camera state; it replaces the removed object-animation helper `orbit(time, options)`.

## Import

```ts
import { orbit } from "vgpu/scene";
```

## Signature

```ts
declare function orbit(
  rig: import("vgpu/scene").OrbitRig,
  deltaYaw: number,
  deltaPitch: number,
  limits?: import("vgpu/scene").RigLimits,
): import("vgpu/scene").OrbitRig;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| rig | `OrbitRig` | ✔ | — | Mutated: `yaw` and `pitch` only. Validated in full first. |
| deltaYaw | `number` | ✔ | — | Finite radians added to `rig.yaw`. Not wrapped or clamped. |
| deltaPitch | `number` | ✔ | — | Finite radians added to `rig.pitch`; the sum is clamped to `[minPitch, maxPitch]`. `0` still clamps an out-of-range pitch into the limits. |
| limits | `RigLimits` | ✖ | `{}` (every default: pitch `±(π/2 − 1e-4)`, distance `[1e-4, Infinity]`) | See `RigLimits`. All four fields are validated. |

**Returns:** `OrbitRig` — the same `rig`, for chaining.

**Throws:** every check runs before `rig` changes.
- `VGPU-CAMERA-SIZE` when `rig.target` or `rig.pan` does not have exactly 3 values — allocate 3-element vectors, for example with `orbitRig()`.
- `VGPU-CAMERA-VALUE` when `limits` are invalid or reversed, the rig state is invalid (non-finite vector component or `yaw`, `pitch` outside `(-π/2, π/2)`, non-positive `distance`), a delta is not finite, or `yaw + deltaYaw` or `pitch + deltaPitch` overflows to a non-finite value — the message names the field; pass finite deltas, ordered limits inside the stated ranges and a valid rig.

## Examples

```ts
import { degToRad, orbit, orbitRig } from "vgpu/scene";

const goal = orbitRig({ distance: 5 });
orbit(goal, degToRad(90), degToRad(30)); // camera moves from +Z to +X and rises 30°
orbit(goal, 4 * Math.PI, 0); // yaw keeps accumulating: no wrap
```

Order matters with `pan`, because `pan` moves along the rig's current axes:

```ts
import { orbit, orbitRig, pan } from "vgpu/scene";

const panThenOrbit = orbitRig();
pan(panThenOrbit, 1, 0); // offset along the yaw-0 right axis, world +X
orbit(panThenOrbit, Math.PI / 2, 0); // the camera swings around the panned pivot; the offset stays +X

const orbitThenPan = orbitRig();
orbit(orbitThenPan, Math.PI / 2, 0);
pan(orbitThenPan, 1, 0); // offset along the yaw-90° right axis, world -Z
```

## Notes

- `orbit` only changes angles. It never moves `target`, `pan` or `distance`, and never touches a `Lens`.
- There is no built-in sensitivity or sign convention. `orbit(goal, -movementX * k, movementY * k, limits)` gives the common drag-to-rotate feel; choose `k` in radians per pixel yourself.
- **See also:** `pan`, `dolly`, `RigLimits`, `smoothRig`.

## Migrate from orbit(time, options)

The removed `orbit(time, { radius, height, speed }): Mat4` animated an object; the new `orbit(rig, deltaYaw, deltaPitch, limits?): OrbitRig` changes camera state. TypeScript rejects the old call because the first parameter is now an `OrbitRig`.

Before (removed API):

```ts illustrative
import { orbit } from "vgpu/scene";

const model = orbit(time, { radius: 2, height: 0.5, speed: 0.4 }); // new matrix every call
```

After — build the same matrix with `composeMatrix`, using explicit sine/cosine translation and a Y rotation:

```ts
import { composeMatrix } from "vgpu/scene";

const time = 1.5; // your explicit clock value
const modelMatrix = new Float32Array(16); // allocate once, reuse every frame

const angle = time * 0.4; // old speed
composeMatrix({
  position: [Math.cos(angle) * 2, 0.5, Math.sin(angle) * 2], // old radius and height
  rotation: [0, angle, 0], // Y rotation, same as the old matrix
}, modelMatrix);
```

The result matches the old matrix up to float rounding. `composeMatrix` writes into your array instead of allocating, and rejects non-finite values with `VGPU-SCENE-VALUE`.

---

# pan

Moves an orbit rig's pivot sideways and vertically in the rig's own screen axes, accumulating into its world-space `pan` offset. Use it on the goal rig for drag-to-pan.

## Import

```ts
import { pan } from "vgpu/scene";
```

## Signature

```ts
declare function pan(rig: import("vgpu/scene").OrbitRig, right: number, up: number): import("vgpu/scene").OrbitRig;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| rig | `OrbitRig` | ✔ | — | Mutated: `pan` only. Its `yaw` and `pitch` define the axes. Validated in full first. |
| right | `number` | ✔ | — | Finite world units along the rig's right axis `[cos(yaw), 0, -sin(yaw)]`. Positive moves the pivot, and so the view, to the camera's right. |
| up | `number` | ✔ | — | Finite world units along the rig's up axis `[-sin(yaw)·sin(pitch), cos(pitch), -cos(yaw)·sin(pitch)]`. Positive moves the view up. |

**Returns:** `OrbitRig` — the same `rig`, for chaining.

**Throws:** every check runs before `rig` changes.
- `VGPU-CAMERA-SIZE` when `rig.target` or `rig.pan` does not have exactly 3 values — allocate 3-element vectors.
- `VGPU-CAMERA-VALUE` when the rig state is invalid, `right` or `up` is not finite, or a new `pan` component is outside finite float32 range — pass finite offsets and a valid rig.

## Examples

Grab-and-drag panning, converting CSS-pixel pointer deltas into world units at the orbit distance:

```ts
import { orbitRig, pan, worldPerPixel, type Lens } from "vgpu/scene";

const canvas = document.querySelector("canvas")!;
const lens: Lens = { fov: 50, near: 0.1, far: 100 };
const goal = orbitRig({ distance: 8 });
const current = orbitRig({ distance: 8 });

canvas.addEventListener("pointermove", (event) => {
  if (event.buttons !== 1) return;
  const unitsPerPixel = worldPerPixel(current.distance, lens, Math.max(1, canvas.clientHeight));
  pan(goal, -event.movementX * unitsPerPixel, event.movementY * unitsPerPixel); // content follows the pointer
});
```

## Notes

- Pan the goal, and the axes come from the goal's `yaw`/`pitch` — the direction the camera is heading — not from a lagging current rig. `pan()` uses exactly the rig you pass.
- The offset is stored in world space. Later `orbit` calls rotate the camera around the panned pivot without rotating the offset, and writing `target` to follow an object keeps the offset.
- Reset panning with `goal.pan.fill(0)`.
- **See also:** `worldPerPixel`, `orbit`, `OrbitRig`.

---

# dolly

Scales an orbit rig's distance by a factor, clamped to distance limits. Use it for wheel or pinch "zoom" that physically moves the camera; use `zoom` to change the lens instead.

## Import

```ts
import { dolly } from "vgpu/scene";
```

## Signature

```ts
declare function dolly(
  rig: import("vgpu/scene").OrbitRig,
  factor: number,
  limits?: import("vgpu/scene").RigLimits,
): import("vgpu/scene").OrbitRig;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| rig | `OrbitRig` | ✔ | — | Mutated: `distance` only. Validated in full first. |
| factor | `number` | ✔ | — | Finite and positive. `distance × factor` is clamped to `[minDistance, maxDistance]`. `> 1` moves away, `< 1` moves closer, `1` only clamps. `0` is invalid. |
| limits | `RigLimits` | ✖ | `{}` (every default: pitch `±(π/2 − 1e-4)`, distance `[1e-4, Infinity]`) | See `RigLimits`. All four fields are validated. |

**Returns:** `OrbitRig` — the same `rig`, for chaining.

**Throws:** every check runs before `rig` changes.
- `VGPU-CAMERA-SIZE` when `rig.target` or `rig.pan` does not have exactly 3 values — allocate 3-element vectors.
- `VGPU-CAMERA-VALUE` when `limits` are invalid or reversed, the rig state is invalid, `factor` is not finite and positive, or `distance × factor` overflows to a non-finite value — pass a finite positive factor, ordered limits and a valid rig.

## Examples

```ts
import { dolly, orbitRig } from "vgpu/scene";

const canvas = document.querySelector("canvas")!;
const goal = orbitRig({ distance: 10 });

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  dolly(goal, Math.exp(event.deltaY * 0.001), { minDistance: 1, maxDistance: 50 }); // exp keeps factors positive
}, { passive: false });
```

## Notes

- `dolly` never changes a `Lens`, and `zoom` never changes a rig: pick the one you want. Dollying changes perspective (near objects grow faster than far ones); zooming only narrows the field of view.
- `dolly` does not change an orthographic image's size, because orthographic bounds do not depend on distance. Scale the bounds instead.
- **See also:** `zoom`, `orbit`, `RigLimits`.

---

# smoothRig

Eases a current orbit rig toward a goal rig by an exponential step of `dt` seconds. Use it once per update, after input and following have changed the goal and before `rigPose`.

## Import

```ts
import { smoothRig } from "vgpu/scene";
```

## Signature

```ts
declare function smoothRig(
  current: import("vgpu/scene").OrbitRig,
  goal: import("vgpu/scene").OrbitRig,
  dt: number,
  options: { timeConstant: number },
): import("vgpu/scene").OrbitRig;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| current | `OrbitRig` | ✔ | — | Mutated: every field moves toward `goal`. Must not be `goal` and must not share vector storage with it. |
| goal | `OrbitRig` | ✔ | — | Read-only; never modified. Its `target` and `pan` may overlap each other. |
| dt | `number` | ✔ | — | Seconds since the last step. Finite and `>= 0`. There is no fallback frame time. |
| options.timeConstant | `number` | ✔ | — | Seconds, finite and `>= 0`: the time to cover about 63% of the remaining gap. `0` snaps to the goal. |

**Returns:** `OrbitRig` — the same `current`, for chaining.

**Throws:** every check runs before `current` changes.
- `VGPU-CAMERA-ALIAS` when `current` and `goal` are the same object, `current.target` overlaps `current.pan`, or either `current` vector overlaps either `goal` vector — including different views of one buffer whose byte ranges overlap — create each rig with `orbitRig()` so every vector has its own storage.
- `VGPU-CAMERA-SIZE` when a `target` or `pan` of either rig does not have exactly 3 values — allocate 3-element vectors.
- `VGPU-CAMERA-VALUE` when either rig's state is invalid, `dt` or `timeConstant` is negative, `NaN` or `Infinity`, or a result is non-finite or leaves the valid pitch or distance range — pass valid rigs and finite nonnegative `dt` and `timeConstant`.

## Examples

```ts
import { clock, frameLoop, init } from "vgpu";
import { orbitRig, smoothRig } from "vgpu/scene";

const gpu = await init();
const goal = orbitRig({ distance: 5 });
const current = orbitRig({ distance: 5 });

frameLoop(gpu, () => {
  smoothRig(current, goal, clock(gpu).deltaTime, { timeConstant: 0.15 });
});
```

Distance moves in log space, so the halfway point between 1 and 100 is 10:

```ts
import { orbitRig, smoothRig } from "vgpu/scene";

const current = orbitRig({ distance: 1 });
const goal = orbitRig({ distance: 100 });
smoothRig(current, goal, Math.LN2, { timeConstant: 1 }); // k = 0.5
console.log(current.distance); // ≈ 10

smoothRig(current, goal, 0, { timeConstant: 0 }); // timeConstant 0 snaps, even with dt 0
console.log(current.distance); // 100
```

## Notes

- Each call computes `k = 1 − exp(−dt / timeConstant)` (as `-Math.expm1(-dt / timeConstant)`), then moves `target`, `pan`, `yaw` and `pitch` linearly by `k` and `distance` geometrically: `exp(lerp(log current, log goal, k))`. `timeConstant: 0` gives `k = 1`; `dt: 0` with a positive `timeConstant` gives `k = 0` and leaves `current` unchanged.
- Yaw is interpolated unwrapped. A goal at `yaw + 4π` spins the camera twice; this is intentional for continuous spins. Keep the goal's yaw continuous — change it with `orbit()` deltas — rather than assigning wrapped absolute angles.
- For a fixed goal, one step of `dt₁ + dt₂` lands where two steps of `dt₁` and `dt₂` land, up to float rounding. When the goal moves between calls (following, dragging), the path depends on how often you call `smoothRig`; there is no frame-rate independence guarantee for moving goals.
- Results stay between the current and goal values, so a current rig inside your `RigLimits` stays inside them while it converges to a goal that is also inside them.
- **See also:** `orbitRig`, `rigPose`, `OrbitRig`.

---

# rigPose

Converts an orbit rig into a world-space camera `Pose`: the camera position and its orientation quaternion. Use it on the current (smoothed) rig before `viewMatrices`.

## Import

```ts
import { rigPose } from "vgpu/scene";
```

## Signature

```ts
declare function rigPose(rig: import("vgpu/scene").OrbitRig, out: import("vgpu/scene").Pose): import("vgpu/scene").Pose;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| rig | `OrbitRig` | ✔ | — | Read-only. Validated in full. |
| out | `Pose` | ✔ | — | `out.position` needs exactly 3 elements and `out.quaternion` exactly 4. The two must not overlap. Both are overwritten on success and untouched on any error. |

**Returns:** `Pose` — the same `out`. `out.position = target + pan + distance × [cos(pitch)·sin(yaw), sin(pitch), cos(pitch)·cos(yaw)]`; `out.quaternion` is the unit XYZW quaternion `Ry(yaw) × Rx(−pitch)`, which points the camera's -Z axis at `target + pan` with +Y up.

**Throws:** every check runs before `out` changes.
- `VGPU-CAMERA-SIZE` when `rig.target` or `rig.pan` does not have exactly 3 values, `out.position` does not have exactly 3, or `out.quaternion` does not have exactly 4 — allocate `{ position: new Float32Array(3), quaternion: new Float32Array(4) }`.
- `VGPU-CAMERA-ALIAS` when `out.position` and `out.quaternion` overlap — allocate disjoint arrays.
- `VGPU-CAMERA-VALUE` when the rig state is invalid, or a position component is outside finite float32 range — keep the rig finite and in range.

## Examples

```ts
import { orbitRig, rigPose, type Pose } from "vgpu/scene";

const rig = orbitRig({ target: [0, 1, 0], distance: 4 });
const pose: Pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };

rigPose(rig, pose); // position [0, 1, 4], identity rotation: on +Z of the target, looking down -Z
rig.yaw = Math.PI / 2;
rigPose(rig, pose); // position ≈ [4, 1, 0], looking down world -X at the target
```

## Notes

- Everything is read before anything is written, so `out` may share storage with the rig's `target` or `pan`. That overwrites your rig; normally keep one separate `Pose` and reuse it.
- The pose is world-space. There is no parent node: to mount the camera on a moving object, follow it through `target` or compute your own `Pose`.
- **See also:** `Pose`, `viewMatrices`, `OrbitRig`.

---

# Pose

A world-space camera position and orientation. Produced by `rigPose` or built by you (first-person, flight or tracked cameras) and consumed by `viewMatrices`.

## Import

```ts
import type { Pose } from "vgpu/scene";
```

## Signature

```ts
interface Pose {
  position: Float32Array;
  quaternion: Float32Array;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| position | `Float32Array` | ✔ | — | Exactly 3 finite values: the camera's world-space position. |
| quaternion | `Float32Array` | ✔ | — | Exactly 4 finite values in XYZW order, nonzero length. `[0, 0, 0, 1]` looks down world -Z with +Y up. `viewMatrices` normalizes a copy; `rigPose` writes unit quaternions. |

## Examples

A first-person pose you compute yourself — yaw only, eye height 1.7:

```ts
import { degToRad, type Pose } from "vgpu/scene";

const heading = degToRad(30); // turn left 30° from -Z
const pose: Pose = {
  position: new Float32Array([0, 1.7, 5]),
  quaternion: new Float32Array([0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]),
};
```

## Notes

- The camera looks along its local -Z axis with local +Y up, in a right-handed world with +Y up. A pose has no scale.
- Keep `position` and `quaternion` in separate storage: `rigPose` rejects overlapping output fields with `VGPU-CAMERA-ALIAS`.
- **See also:** `rigPose`, `viewMatrices`.

---

# Lens

The perspective lens: vertical field of view in degrees and the near and far clip distances. Read by `perspective`, `zoom` and `worldPerPixel`.

## Import

```ts
import type { Lens } from "vgpu/scene";
```

## Signature

```ts
interface Lens {
  fov: number;
  near: number;
  far: number;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| fov | `number` | ✔ | — | Vertical field of view in degrees, finite and strictly between `0` and `180`. |
| near | `number` | ✔ | — | Near clip distance, finite and positive. |
| far | `number` | ✔ | — | Far clip distance, finite and greater than `near`. `Infinity` is rejected. |

## Examples

```ts
import { perspective, type Lens } from "vgpu/scene";

const lens: Lens = { fov: 45, near: 0.1, far: 200 };
const projection = perspective(lens, 16 / 9, new Float32Array(16));
lens.fov = 30; // plain data: change it, then rebuild the projection
perspective(lens, 16 / 9, projection);
```

## Notes

- A lens is independent of the rig. Changing the lens never moves the camera, and `orbit`/`pan`/`dolly` never change the lens. Nothing re-runs `perspective` for you after a lens change.
- `fov` is degrees while rig angles are radians. Convert rig angles with `degToRad`; pass `fov` in degrees.
- There is no `lens()` factory; write the object literal.
- **See also:** `perspective`, `zoom`, `worldPerPixel`.

---

# zoom

Narrows or widens a lens by a factor applied to `tan(fov / 2)`, clamped to field-of-view limits. Use it for optical zoom that does not move the camera.

## Import

```ts
import { zoom } from "vgpu/scene";
```

## Signature

```ts
declare function zoom(
  lens: import("vgpu/scene").Lens,
  factor: number,
  limits?: { minFov?: number; maxFov?: number },
): import("vgpu/scene").Lens;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| lens | `Lens` | ✔ | — | Mutated: `fov` only. Validated in full first. |
| factor | `number` | ✔ | — | Any finite positive number, including extremes such as `Number.MIN_VALUE` and `Number.MAX_VALUE`. The new FOV is `2 × atan(tan(fov / 2) / factor)`, clamped to `[minFov, maxFov]`. `> 1` narrows (magnifies), `< 1` widens, `2` shows half the height at the focus distance. |
| limits.minFov | `number` | ✖ | `1e-4` | Degrees, strictly between `0` and `180`, `<= maxFov`. |
| limits.maxFov | `number` | ✖ | `180 − 1e-4` (`179.9999`) | Degrees, strictly between `0` and `180`, `>= minFov`. |

**Returns:** `Lens` — the same `lens`, for chaining.

**Throws:** checks run in this order — limits, lens, factor, computed FOV — and all of them run before `lens` changes.
- `VGPU-CAMERA-VALUE` when `limits.minFov` or `limits.maxFov` is not strictly between `0` and `180` or `minFov > maxFov`, the lens is invalid (see `Lens`), `factor` is `0`, negative, `NaN` or `Infinity`, or the computed FOV arithmetic is non-finite — pass ordered limits inside `(0, 180)`, a valid lens and a finite positive factor. The last check is a guard: for inputs that pass the earlier checks, `tan` and `atan` keep the result finite.

## Examples

```ts
import { perspective, zoom, type Lens } from "vgpu/scene";

const lens: Lens = { fov: 60, near: 0.1, far: 100 };
const projection = new Float32Array(16);

zoom(lens, 2, { minFov: 10, maxFov: 90 }); // fov ≈ 32.2°: tan(fov/2) halves
perspective(lens, 16 / 9, projection); // zoom changes the lens; rebuild the projection yourself
```

Extreme factors clamp instead of throwing:

```ts
import { zoom, type Lens } from "vgpu/scene";

const wide: Lens = { fov: 60, near: 0.1, far: 100 };
zoom(wide, Number.MIN_VALUE); // raw FOV rounds to 180°; clamps to maxFov: 179.9999

const narrow: Lens = { fov: 60, near: 0.1, far: 100 };
zoom(narrow, Number.MAX_VALUE, { minFov: 10, maxFov: 90 }); // raw FOV ≈ 0°; clamps to minFov: 10
```

## Notes

- Every finite positive factor is valid. When the raw FOV is a finite value outside your limits — including one that rounds to exactly `0` or `180` degrees — `zoom` clamps it into `[minFov, maxFov]`. The limits are validated to lie strictly inside `(0, 180)`, so the result is always a valid `Lens.fov`. Clamp the factor yourself if you want to reject extreme input instead.
- `zoom` never changes a rig, and `dolly` never changes the lens. Use `dolly` to move the camera, `zoom` to change magnification.
- After `zoom`, `worldPerPixel` returns smaller values at the same distance, so drag panning stays matched to the screen if you recompute it.
- **See also:** `Lens`, `dolly`, `perspective`, `worldPerPixel`.

---

# perspective

Writes a right-handed perspective projection with WebGPU depth (`0` at near, `1` at far) into `out`. Use it with a `Lens` and your render target's aspect ratio.

## Import

```ts
import { perspective } from "vgpu/scene";
```

## Signature

```ts
declare function perspective(
  lens: import("vgpu/scene").Lens,
  aspect: number,
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| lens | `Lens` | ✔ | — | Vertical FOV in degrees and finite near/far. Read-only. |
| aspect | `number` | ✔ | — | Width / height, finite and positive. Use the target's size, for example `canvasSurface.size[0] / canvasSurface.size[1]`. |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. Overwritten on success, untouched on any error. |

**Returns:** `Mat4` — the same `out`, column-major: with `f = 1 / tan(fov / 2)`, it is `[f/aspect, 0, 0, 0,  0, f, 0, 0,  0, 0, far/(near−far), −1,  0, 0, far·near/(near−far), 0]`. View-space points at `z = −near` map to depth `0` and at `z = −far` to depth `1`.

**Throws:**
- `VGPU-CAMERA-VALUE` when the lens is invalid, `aspect` is not finite and positive, or an element is outside finite float32 range (for example an extremely small `fov`) — pass a valid lens and a positive aspect.
- `VGPU-CAMERA-SIZE` when `out` does not have exactly 16 elements — allocate `new Float32Array(16)`.

## Examples

```ts
import { perspective, type Lens } from "vgpu/scene";

const lens: Lens = { fov: 60, near: 0.1, far: 100 };
const projection = new Float32Array(16);
perspective(lens, 1920 / 1080, projection);
```

## Notes

- The depth range matches the default draw depth state (`compare: "less-equal"`) and pass `clearDepth: 1`. For reversed-Z or an infinite far plane, write your own 16-value projection and pass it to `viewMatrices`.
- Call `perspective` again after changing the lens or when the target resizes; nothing tracks those for you.
- **See also:** `Lens`, `orthographic`, `viewMatrices`.

---

# orthographic

Writes a right-handed orthographic projection with WebGPU depth into `out` from a view-space box. Use it for CAD, 2D-in-3D, isometric or shadow-map views without perspective foreshortening.

## Import

```ts
import { orthographic } from "vgpu/scene";
```

## Signature

```ts
declare function orthographic(
  bounds: { left: number; right: number; bottom: number; top: number; near: number; far: number },
  out: import("vgpu/scene").Mat4,
): import("vgpu/scene").Mat4;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| bounds.left | `number` | ✔ | — | Finite, `< right`. View-space x mapped to clip x `−1`. |
| bounds.right | `number` | ✔ | — | Finite, `> left`. Mapped to clip x `+1`. |
| bounds.bottom | `number` | ✔ | — | Finite, `< top`. Mapped to clip y `−1`. |
| bounds.top | `number` | ✔ | — | Finite, `> bottom`. Mapped to clip y `+1`. |
| bounds.near | `number` | ✔ | — | Finite, `>= 0` and `< far`. Distance in front of the camera (view `z = −near`) mapped to depth `0`. `0` is allowed. |
| bounds.far | `number` | ✔ | — | Finite, `> near`. View `z = −far` mapped to depth `1`. |
| out | `Mat4` | ✔ | — | `Float32Array` with exactly 16 elements. Overwritten on success, untouched on any error. |

**Returns:** `Mat4` — the same `out`, column-major: `[2/(r−l), 0, 0, 0,  0, 2/(t−b), 0, 0,  0, 0, 1/(n−f), 0,  (r+l)/(l−r), (t+b)/(b−t), n/(n−f), 1]`.

**Throws:** bounds are checked first, then `out`.
- `VGPU-CAMERA-VALUE` when a bound is not finite, `left >= right`, `bottom >= top`, `near < 0`, `near >= far`, or an element is outside finite float32 range (bounds extremely close together) — pass ordered finite bounds with `0 <= near < far`.
- `VGPU-CAMERA-SIZE` when `out` does not have exactly 16 elements — allocate `new Float32Array(16)`.

## Examples

An orthographic view of an orbit rig, sized by a half-height in world units:

```ts
import { orbitRig, orthographic, rigPose, viewMatrices, type CameraMatrices, type Pose } from "vgpu/scene";

const aspect = 16 / 9;
const halfHeight = 5; // world units visible above the pivot; scale it to zoom
const rig = orbitRig({ pitch: 0.6, distance: 20 });
const projection = orthographic({
  left: -halfHeight * aspect, right: halfHeight * aspect,
  bottom: -halfHeight, top: halfHeight,
  near: 0, far: 40, // bracket rig.distance so the pivot is inside the depth range
}, new Float32Array(16));

const pose: Pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, pose), projection, matrices);

const unitsPerPixel = (halfHeight * 2) / 1080; // orthographic world units per pixel: (top − bottom) / height
```

## Notes

- Bounds are in view space, relative to the camera, not world space. Move the camera with a `Pose`.
- Mirrored bounds (`left > right`) throw. To mirror, write your own projection and pass it to `viewMatrices`.
- `zoom`, `dolly` and `worldPerPixel` are perspective tools: an orthographic image changes size only when you change the bounds.
- **See also:** `perspective`, `viewMatrices`, `Pose`.

---

# viewMatrices

Writes a camera's view matrix and the combined view-projection matrix into `out`. Use it after `rigPose` (or your own `Pose`) and `perspective`/`orthographic`, then pack `viewProjection` into your draws.

## Import

```ts
import { viewMatrices } from "vgpu/scene";
```

## Signature

```ts
declare function viewMatrices(
  pose: import("vgpu/scene").Pose,
  projection: ArrayLike<number>,
  out: import("vgpu/scene").CameraMatrices,
): void;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| pose | `Pose` | ✔ | — | Read-only. `position`: exactly 3 finite float32-representable values. `quaternion`: exactly 4 finite values with nonzero length; a normalized copy is used, `pose` is not modified. |
| projection | `ArrayLike<number>` | ✔ | — | Exactly 16 finite column-major values. Any projection works: from `perspective`, `orthographic`, or your own (reversed-Z, infinite far, jittered, off-axis). |
| out.view | `Mat4` | ✔ | — | Exactly 16 elements. Receives the inverse of the pose's rigid transform. |
| out.viewProjection | `Mat4` | ✔ | — | Exactly 16 elements, not overlapping `out.view`. Receives `projection × view`. |

**Returns:** `void` — the results are in `out.view` and `out.viewProjection`. Both are written on success; neither changes on any error.

**Throws:** every check runs before `out` changes.
- `VGPU-CAMERA-SIZE` when `pose.position` does not have exactly 3 values, `pose.quaternion` exactly 4, or `projection`, `out.view` or `out.viewProjection` exactly 16 — allocate the stated lengths.
- `VGPU-CAMERA-VALUE` when a pose or projection component is `NaN` or `Infinity`, a position component is outside finite float32 range, the quaternion has zero length, or a result element is outside finite float32 range — pass a finite pose with a nonzero quaternion and a finite projection.
- `VGPU-CAMERA-ALIAS` when `out.view` and `out.viewProjection` overlap — allocate two disjoint 16-element arrays.

## Examples

```ts
import { degToRad, perspective, viewMatrices, type CameraMatrices, type Pose } from "vgpu/scene";

const heading = degToRad(30);
const pose: Pose = {
  position: new Float32Array([0, 1.7, 5]),
  quaternion: new Float32Array([0, 2 * Math.sin(heading / 2), 0, 2 * Math.cos(heading / 2)]), // not unit: normalized for the calculation
};
const projection = perspective({ fov: 70, near: 0.05, far: 500 }, 16 / 9, new Float32Array(16));
const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(pose, projection, matrices); // pose.quaternion keeps its length-2 values
```

Pass your own projection — here reversed-Z with an infinite far plane:

```ts
import { viewMatrices, type CameraMatrices, type Pose } from "vgpu/scene";

const near = 0.1;
const aspect = 16 / 9;
const focal = 1 / Math.tan((60 * Math.PI) / 360); // 60° vertical FOV
const reversedInfinite = new Float32Array([
  focal / aspect, 0, 0, 0,
  0, focal, 0, 0,
  0, 0, 0, -1,
  0, 0, near, 0, // depth 1 at near, approaching 0 at infinity
]);
const pose: Pose = { position: new Float32Array([0, 2, 10]), quaternion: new Float32Array([0, 0, 0, 1]) };
const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(pose, reversedInfinite, matrices); // draw with depth: { compare: "greater" } and clearDepth: 0
```

## Notes

- `viewMatrices` fills your arrays, but draws do not watch them. `draw.set({ camera: { viewProjection: matrices.viewProjection } })` copies the values when you call it; call `set()` again after every `viewMatrices` you want rendered. Binding the array once does not keep it fresh.
- Inputs are read before anything is written, so `out.view` or `out.viewProjection` may share storage with `pose` or `projection` — for example, you may reuse one scratch buffer as both a projection input and an output. Only the two output fields must be disjoint, since they hold different results.
- Conventions: right-handed, +Y up, camera looks down -Z, column-major, clip depth `0..1` as produced by `perspective` and `orthographic`.
- **See also:** `CameraMatrices`, `rigPose`, `perspective`, `orthographic`.

---

# CameraMatrices

Output storage for `viewMatrices`: the view matrix and the combined view-projection matrix.

## Import

```ts
import type { CameraMatrices } from "vgpu/scene";
```

## Signature

```ts
interface CameraMatrices {
  view: import("vgpu/scene").Mat4;
  viewProjection: import("vgpu/scene").Mat4;
}
```

## Parameters

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| view | `Mat4` | ✔ | — | `Float32Array` of exactly 16 elements: world → view space. Use it for view-space effects such as matcaps or fog. |
| viewProjection | `Mat4` | ✔ | — | `Float32Array` of exactly 16 elements, disjoint from `view`: world → clip space. Pack it into the shader's camera uniform. |

## Examples

```ts
import type { CameraMatrices } from "vgpu/scene";

const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

const shared = new Float32Array(32); // one allocation, two disjoint views
const packed: CameraMatrices = { view: shared.subarray(0, 16), viewProjection: shared.subarray(16, 32) };
```

## Notes

- Allocate once and reuse every update. Overlapping `view` and `viewProjection` throw `VGPU-CAMERA-ALIAS`.
- **See also:** `viewMatrices`.

---

# worldPerPixel

Returns how many world units one pixel of screen height spans at a given distance through a perspective lens. Use it to turn pointer deltas into `pan` offsets so dragged content stays under the pointer.

## Import

```ts
import { worldPerPixel } from "vgpu/scene";
```

## Signature

```ts
declare function worldPerPixel(distance: number, lens: import("vgpu/scene").Lens, heightPixels: number): number;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| distance | `number` | ✔ | — | World-space distance from the camera to the plane you are dragging, finite and positive. For an orbit camera, the rendered rig's `distance`. |
| lens | `Lens` | ✔ | — | Validated in full; only `fov` affects the result. |
| heightPixels | `number` | ✔ | — | Viewport height, finite and positive, in the same units as your pointer deltas: `canvas.clientHeight` for CSS-pixel `movementX`/`movementY`. |

**Returns:** `number` — `2 × distance × tan(fov / 2) / heightPixels`, finite and positive.

**Throws:**
- `VGPU-CAMERA-VALUE` when `distance` or `heightPixels` is not finite and positive, the lens is invalid, or the result is not finite and positive — pass positive finite values; guard a hidden canvas with `Math.max(1, canvas.clientHeight)`.

## Examples

```ts
import { worldPerPixel } from "vgpu/scene";

const unitsPerPixel = worldPerPixel(10, { fov: 60, near: 0.1, far: 100 }, 1000);
console.log(unitsPerPixel); // ≈ 0.01155: 2 × 10 × tan(30°) / 1000
```

## Notes

- Mixing units breaks the 1:1 drag: device-pixel deltas need a device-pixel height, CSS-pixel deltas a CSS-pixel height. The canvas's backing size (`canvasSurface.size`) is in device pixels.
- Recompute it whenever the distance, the lens (`zoom`) or the canvas height changes; it is cheap and pure.
- For an orthographic camera use `(top − bottom) / heightPixels` instead.
- **See also:** `pan`, `Lens`, `zoom`.
