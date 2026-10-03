---
title: Scene composition
summary: vgpu/scene composes transforms, hierarchies, instance collections, and cameras on the CPU; vgpu/scene/gpu publishes an instance collection as a vertex stream that your own WGSL reads through @vgpu/wgsl-std/scene helpers.
keywords: scene, scene graph, transforms, hierarchy, parent child, group, SceneNode, world matrix, local matrix, composeMatrix, evaluateHierarchy, hierarchyOrder, ecs, external ecs, physics, instances, instancing, instance collection, instanceGeometry, publish, bindWorld, setWorlds, syncWorlds, camera, orbit camera, orbit rig, pan, dolly, zoom, smoothing, damping, perspective, orthographic, viewMatrices, viewProjection, worldPerPixel, normal matrix, inverse transpose, transformNormal, wgsl-std scene, camera uniform, group 1 binding 0, migration, perspectiveCamera, orbitControls, mesh, material
relatedSymbols:
  - group
  - SceneNode
  - composeMatrix
  - multiplyMatrices
  - invertAffine
  - localFromWorld
  - hierarchyOrder
  - evaluateHierarchy
  - instances
  - InstanceCollection
  - instanceGeometry
  - InstanceGeometry
  - orbitRig
  - orbit
  - pan
  - dolly
  - zoom
  - smoothRig
  - rigPose
  - perspective
  - orthographic
  - viewMatrices
  - worldPerPixel
  - Draw
  - Geometry
  - Frame
---

# Scene composition

`vgpu/scene` gives you the CPU half of a 3D scene: transform math, parent/child hierarchies, compact instance collections, and camera state you own. `vgpu/scene/gpu` adds one GPU piece — a bridge that publishes an instance collection as an instanced vertex stream. Everything else stays yours: the WGSL, the lighting, the passes, the render loop, the input handling, and — if you have one — your ECS or physics engine.

Use it when you render meshes with your own shaders and need world matrices, many copies of a mesh, or a camera, without adopting a renderer or a material system. A minimal instanced object looks like this:

```ts
import { draw, frame, geometry, init, target } from "vgpu";
import { box, instances, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import boxShader from "./boxes.wgsl"; // declares `camera` at @group(1) @binding(0)

const gpu = await init();
const sceneTarget = target(gpu, { size: [960, 540], depth: true });

const crates = instances({ capacity: 1, attributes: { size: "float32x3", tint: "float32x4" } });
crates.add({ size: [1, 1, 1], tint: [0.9, 0.5, 0.1, 1] }); // world starts as identity

const crateBridge = instanceGeometry(gpu, crates, { mesh: geometry(gpu, box()) });
const crateDraw = draw(gpu, { shader: boxShader, geometry: crateBridge.geometry, cull: "back" });

const projection = new Float32Array(16);
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
perspective({ fov: 45, near: 0.1, far: 100 }, 960 / 540, projection);
viewMatrices(rigPose(orbitRig({ yaw: 0.6, pitch: 0.4, distance: 4 }), pose), projection, matrices);

crateDraw.set({
  camera: { viewProjection: matrices.viewProjection }, // WGSL binding `camera`, member `viewProjection`
  lighting: { direction: [-0.4, -1, -0.3], ambient: 0.15 },
});
const crateCount = crateBridge.publish(); // CPU records -> instance buffer

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: sceneTarget, clear: [0.05, 0.05, 0.07, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount });
  });
});
```

Every connection is visible in the code: the collection feeds the bridge, the bridge geometry feeds the draw, the camera matrix reaches the shader through a named `set()`, and the instance count reaches the pass through `instances`. Nothing is injected into your shader, and no bind group is reserved.

## Architecture

### Scope and external math

Scene utilities own hierarchy composition, instance records, camera behavior, mesh recipes, and
their rendering integration. Use a dedicated CPU math library such as `math` for general vector
and quaternion operations, decomposition, interpolation, spatial queries, springs, and noise.
The existing scene transform conveniences remain supported; they are not a growing general math
API. Shader-side WGSL utilities remain separate from this CPU boundary.

External matrices enter through `setWorld`, bound world sources, or packed `setWorlds` batches.
There is no required math-library class or runtime dependency. See
[Using math with scene data](scene-math.docs.md) for checked examples, typed-array boundaries,
camera conventions, and copy/publication timing.

### Data flow

The common flow is **local transforms → world matrices → instance records → GPU instance stream → your draw**. Each stage is a separate function call you make, in an order you choose. A system that already has final world matrices — a physics engine, for example — enters directly at the instance records and skips the earlier stages.

```text
local transforms          world matrices             instance records          GPU
────────────────          ──────────────             ────────────────          ───
group().set(...)    ──►   node.worldMatrix     ─┐
                          (lazy, per node)      ├─►  instances(...)      ──►   instanceGeometry(...)
composeMatrix(...)  ──►   evaluateHierarchy()  ─┤    setWorld / setWorlds      .publish()
(your arrays)             (your arrays)         │    bindWorld + syncWorlds     └─► pass.draw(yourDraw, { instances })
physics / ECS  ─────────────────────────────────┘

camera:  orbitRig ─► orbit / pan / dolly ─► smoothRig ─► rigPose ─► Pose ─┐
         Lens ─► zoom ─► perspective / orthographic ─► projection ───────┴─► viewMatrices ─► yourDraw.set({ camera })
```

| Import | Contains | Needs a GPU |
|---|---|---|
| `vgpu/scene` | Geometry recipes (`box`, `sphere`, …), `geometries`, `degToRad`, `srgb`; transform math; `group` and `SceneNode`; `hierarchyOrder` and `evaluateHierarchy`; `instances`; camera functions | No — plain CPU data and functions |
| `vgpu/scene/gpu` | `instanceGeometry` | Yes — takes the `gpu` from `init()` |
| `@vgpu/wgsl-std/scene` | `instanceWorldMatrix`, `transformPosition`, `transformDirection`, `transformNormal` | Shader-side, pure functions with no bindings |

Each transform has exactly one authority at a time. A node owns its local transform; a bound instance reads its world matrix from a source you provide; an unbound instance holds whatever you last wrote. Copies between stages are explicit calls, so you can always tell which value a stage is reading.

What you own and what vgpu owns:

| You own | vgpu owns |
|---|---|
| Shaders, shading, lighting, materials, blending | The instance vertex buffer created by `instanceGeometry` and its composed `Geometry` wrapper |
| The base mesh passed to `instanceGeometry` (it is borrowed, never destroyed by the bridge) | Validation of every value that crosses into a collection, a camera function, or the bridge |
| Camera state (`OrbitRig`, `Lens`, `Pose`) and all input handling | Nothing about your render loop — there is no scheduler and no implicit update |
| Local/world arrays for external hierarchies, and their dirty flags | The compiled topology token from `hierarchyOrder` (a copy of your parents) |
| Stable application IDs for picking, and when to publish | Instance handles (`InstanceId`) and slot packing |

## Conventions

These rules hold for every function in `vgpu/scene` and every helper in `@vgpu/wgsl-std/scene`:

- **Matrices.** `Mat4` is a `Float32Array` with exactly 16 elements, column-major, the same layout as WGSL `mat4x4f`. Translation lives at indices `12, 13, 14`. An affine matrix has the mathematical bottom row `0, 0, 0, 1` at indices `3, 7, 11, 15`.
- **Composition order.** `world = parentWorld * local`. A point is transformed as `world * vec4(position, 1)`.
- **Axes.** Right-handed, +Y up. A camera looks down its local −Z axis.
- **Rotation.** `rotation` is intrinsic XYZ Euler angles in radians. `quaternion` is `[x, y, z, w]`. When both are supplied, `quaternion` wins.
- **Transform defaults.** Position `[0, 0, 0]`, quaternion identity `[0, 0, 0, 1]`, scale `1`. `scale` accepts a number (uniform) or a 3-vector.
- **Inputs and outputs.** Read-only numeric inputs accept any `ArrayLike<number>` (arrays, typed arrays). Functions that produce a matrix or vector write into an `out` you allocate — `Float32Array(16)` for matrices, `Float32Array(3)` or `Float32Array(4)` for vectors. `composeMatrix`, `multiplyMatrices`, `invertAffine`, `localFromWorld`, `rigPose`, `perspective`, and `orthographic` return the `out` they wrote; `viewMatrices` fills both fields of its `out` and returns `void`. Allocate outputs once and reuse them every frame.
- **Aliasing.** Math and camera outputs may overlap their inputs: results are computed in staging before anything is written, so `multiplyMatrices(a, b, a)` is safe. Two outputs of one call cannot share storage — `view`/`viewProjection` in `viewMatrices`, `position`/`quaternion` in `rigPose` — and `smoothRig` rejects any overlap between `current` and `goal`. Hierarchy evaluation is stricter; see [below](#evaluate-a-hierarchy-stored-in-your-own-arrays).
- **Projection depth.** `perspective` and `orthographic` map view-space −Z to WebGPU clip depth `0..1`.
- **Validation happens before writes.** A function that throws has not modified its `out`, its rig, its lens, or its collection — except where a section below says otherwise (bound sources in `syncWorlds`).

Matrices and owned vectors are stored as float32; JavaScript scalar calculations use ordinary numbers. There is no large-coordinate precision support — at 100 000 units from the origin, adjacent float32 values are about `0.008` units apart, so keep the scene near the origin or rebase it yourself. Inversion rejects matrices whose determinant is zero or non-finite, and any result that is not finite in float32; there is no arbitrary epsilon, so small but invertible scales such as `1e-6` are accepted.

## Transform math

```ts illustrative
type Mat4 = Float32Array; // exactly 16 elements

interface TransformValues {
  position?: ArrayLike<number>;   // 3 values, default [0, 0, 0]
  rotation?: ArrayLike<number>;   // 3 values, intrinsic XYZ radians
  quaternion?: ArrayLike<number>; // 4 values [x, y, z, w]; wins over rotation
  scale?: number | ArrayLike<number>; // number or 3 values, default 1
}

function composeMatrix(values: TransformValues, out: Mat4): Mat4;
function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>, out: Mat4): Mat4; // out = a * b
function invertAffine(matrix: ArrayLike<number>, out: Mat4): Mat4;
function localFromWorld(parentWorld: ArrayLike<number>, world: ArrayLike<number>, out: Mat4): Mat4; // inverse(parentWorld) * world
```

`composeMatrix` is a complete composition, not a patch: every omitted field takes its default. It normalizes a nonzero quaternion for the calculation without mutating your array, and rejects a zero-length quaternion.

```ts
import { composeMatrix, localFromWorld, multiplyMatrices } from "vgpu/scene";

const baseLocal = composeMatrix({ position: [0, 0.25, 0], rotation: [0, 0.3, 0] }, new Float32Array(16));
const armLocal = composeMatrix({ position: [0, 0.5, 0], rotation: [0, 0, 0.6] }, new Float32Array(16));

const armWorld = multiplyMatrices(baseLocal, armLocal, new Float32Array(16)); // world = parentWorld * local
const armBack = localFromWorld(baseLocal, armWorld, new Float32Array(16));  // recovers armLocal
```

Math outputs may alias their inputs — `multiplyMatrices(a, b, a)` is safe because the result is computed before anything is written. `invertAffine` and `localFromWorld` throw `VGPU-SPATIAL-SINGULAR` for a singular or non-finite inverse before touching `out`, instead of producing a matrix of zeros or `NaN`.

A matrix can represent shear, which a position/rotation/scale triple cannot. There is no decomposition function: when an external system is matrix-authoritative, keep its matrices as matrices and feed them to `setWorld`/`setWorlds` directly.

## Articulate a few objects with nodes

`group()` creates a `SceneNode`: a transform with a parent and children, and nothing else — no geometry, no material. Use nodes when you have a handful of articulated parts and want world matrices computed for you.

```ts illustrative
function group(options?: NodeOptions): SceneNode;

interface NodeOptions {
  position?: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  quaternion?: ArrayLike<number>;
  scale?: number | ArrayLike<number>;
  label?: string;
  visible?: boolean;
  children?: readonly SceneNode[];
}

declare class SceneNode {
  constructor(kind: "group", options?: NodeOptions);
  readonly kind: "group";
  label: string | undefined;
  visible: boolean;
  set(values: NodeTransformValues): this; // position/rotation/quaternion/scale/label/visible
  lookAt(target: ArrayLike<number>, up?: ArrayLike<number>): this;
  add(...nodes: SceneNode[]): this;
  remove(...nodes: SceneNode[]): this;
  removeFromParent(): this;
  traverse(visit: (node: SceneNode) => void): void;
  readonly parent: SceneNode | null;
  readonly children: readonly SceneNode[];
  readonly position: Float32Array; // borrowed, read-only
  readonly quaternion: Float32Array; // borrowed, read-only
  readonly scale: Float32Array; // borrowed, read-only
  readonly localMatrix: Mat4;   // borrowed, read-only
  readonly worldMatrix: Mat4;   // borrowed, read-only
  readonly worldPosition: Float32Array; // borrowed, read-only
}
```

A three-part arm — base, arm, claw — with the same local values used throughout this guide:

```ts
import { group } from "vgpu/scene";

const claw = group({ label: "claw", position: [0, 1.6, 0] });
const arm = group({ label: "arm", position: [0, 0.5, 0], children: [claw] });
const base = group({ label: "base", position: [0, 0.25, 0], children: [arm] });

function animateArm(time: number) {
  base.set({ rotation: [0, time * 0.3, 0] });
  arm.set({ rotation: [0, 0, Math.sin(time) * 0.6] });
}

animateArm(1.5);
claw.worldPosition; // base * arm * claw, recomputed only because base and arm changed
```

Nodes evaluate lazily: `set()` marks the node and its descendants dirty, and reading `worldMatrix` recomputes only what is stale. The matrix math is the same as `composeMatrix` and `multiplyMatrices`.

Rules for nodes:

- **Write through `set()`.** `position`, `quaternion`, `scale`, `localMatrix`, `worldMatrix`, and `worldPosition` return borrowed arrays with a stable identity. Treat them as read-only: writing into them does not mark the node dirty, so the tree goes stale silently. `set()` updates only the fields you pass; the others keep their values.
- **Reparenting keeps the local transform.** `add()` and `remove()` move a node without adjusting its local values, so its world matrix changes to follow the new parent. There is no keep-world node operation or matrix setter. External matrix-based hierarchies can use `localFromWorld` to calculate a replacement local matrix without decomposing it into node fields.
- **Existing spatial methods remain.** `lookAt(target, up)` points local −Z toward a world-space target and compensates for the parent transform; `up` defaults to `[0, 1, 0]`. A singular parent throws before changing the quaternion. `traverse(visit)` visits the node and its descendants; `removeFromParent()` detaches the node while preserving its local transform.
- **`label` and `visible` are plain flags.** Nothing in vgpu reads them: a bound instance copies only the world matrix. To hide an instance, `remove()` it from its collection.
- **Cycles throw.** `add()` throws `VGPU-SCENE-CYCLE` when a node would become its own ancestor.

Nodes are for articulated parts, not populations. For thousands of objects, use an instance collection directly and keep the hierarchy, if any, in flat arrays.

## Evaluate a hierarchy stored in your own arrays

When an ECS already stores local transforms, evaluate them in place instead of mirroring them as nodes. `hierarchyOrder` compiles a topology once; `evaluateHierarchy` computes world matrices from it.

```ts illustrative
interface HierarchyOrder { readonly size: number } // opaque token

function hierarchyOrder(parents: Int32Array): HierarchyOrder;

interface HierarchyEvaluation {
  order: HierarchyOrder;
  parents: Int32Array;   // n entries
  locals: Float32Array;  // 16 * n
  worlds: Float32Array;  // 16 * n, written
  changed?: Uint8Array;  // n entries, read only
  updated?: Uint8Array;  // n entries, fully overwritten
}

function evaluateHierarchy(input: HierarchyEvaluation): number; // number of world rows recomputed by this call
```

`parents[i]` is the dense row index of row `i`'s parent, or `-1` for a root. Rows can appear in any order and a hierarchy can have several roots. Your entity IDs stay in your ECS; the evaluator only sees row indices.

The same arm as above, as three rows:

```ts
import { composeMatrix, evaluateHierarchy, hierarchyOrder } from "vgpu/scene";

const parents = new Int32Array([-1, 0, 1]); // base is a root, arm's parent is base, claw's parent is arm
const locals = new Float32Array(3 * 16);
const worlds = new Float32Array(3 * 16);
const localRows = [0, 1, 2].map((row) => locals.subarray(row * 16, row * 16 + 16)); // views, created once

composeMatrix({ position: [0, 0.25, 0] }, localRows[0]);
composeMatrix({ position: [0, 0.5, 0] }, localRows[1]);
composeMatrix({ position: [0, 1.6, 0] }, localRows[2]);

const order = hierarchyOrder(parents);
evaluateHierarchy({ order, parents, locals, worlds }); // full evaluation: required once after setup

const changed = new Uint8Array(3);
const armHierarchy = { order, parents, locals, worlds, changed };

function animateArmRows(time: number) {
  composeMatrix({ position: [0, 0.25, 0], rotation: [0, time * 0.3, 0] }, localRows[0]);
  changed[0] = 1;
  composeMatrix({ position: [0, 0.5, 0], rotation: [0, 0, Math.sin(time) * 0.6] }, localRows[1]);
  changed[1] = 1;
  evaluateHierarchy(armHierarchy); // recomputes rows 0, 1 and their descendant, row 2
  changed.fill(0);                 // you clear your flags; the evaluator never does
}
```

How evaluation works:

- **Without `changed`, every row is recomputed.** Do a full evaluation after initialization, after any topology change, and whenever you replace or reset `worlds`. The evaluator keeps no hidden state about your output buffers, so it cannot detect a missing initialization or a local you changed without flagging it.
- **With `changed`, a row is recomputed when its flag is nonzero or its parent was recomputed in this call.** `changed` is never mutated. When `updated` is given, every entry is overwritten: `1` for recomputed rows, `0` for the rest — useful for copying only recomputed rows onward.
- **Topology is compiled and checked.** `hierarchyOrder` validates indices and cycles, copies `parents`, and owns its scratch memory. Every `evaluateHierarchy` compares `parents` with that copy and throws `VGPU-SPATIAL-ORDER` if they differ — rebuild the token with `hierarchyOrder(parents)` after changing any parent.
- **Lengths are exact:** `parents` n, `locals` 16n, `worlds` 16n, `changed` n, `updated` n. Shape, topology, and aliasing are checked before any output is written.
- **Outputs must not overlap.** `worlds` and `updated` may not share bytes with each other or with any input (checked by byte range, not object identity). Read-only inputs may overlap each other.
- **Locals are trusted.** The evaluator assumes finite affine locals and does not scan every component on every call; invalid values propagate into `worlds`. Validate at your import boundary. The instance collection re-validates every world matrix you copy into it.
- **Synchronous and single-threaded.** Do not mutate the arrays concurrently; `SharedArrayBuffer` synchronization is not supported.

Cost: `hierarchyOrder` is O(n) time and memory. Each `evaluateHierarchy` scans all n rows and performs one matrix multiplication per recomputed row. There is no partial traversal of a subtree.

## Store many copies in an instance collection

An instance collection is a fixed-capacity set of records on the CPU. Every record has a world matrix and the attributes you declare. It has no geometry, no material, and no GPU resources; the GPU bridge reads it later.

```ts illustrative
type InstanceFormat =
  | "float32" | "float32x2" | "float32x3" | "float32x4"
  | "sint32" | "sint32x2" | "sint32x3" | "sint32x4"
  | "uint32" | "uint32x2" | "uint32x3" | "uint32x4";
type InstanceAttribute = InstanceFormat | { format: InstanceFormat; default: number | ArrayLike<number> };
type InstanceAttributes = Record<string, InstanceAttribute>;
type InstanceId = number & { readonly __instanceId: unique symbol };

function instances<const A extends InstanceAttributes = {}>(options: {
  capacity: number;
  attributes?: A;
}): InstanceCollection<A>;

interface InstanceCollection<A extends InstanceAttributes = {}> {
  readonly capacity: number;
  readonly count: number;
  add(...args: InstanceAddArgs<A>): InstanceId; // values required when an attribute has no default
  remove(id: InstanceId): void;
  set(id: InstanceId, values: Partial<InstanceValues<A>>): void;
  setWorld(id: InstanceId, world: ArrayLike<number>): void;
  setWorlds(ids: ArrayLike<InstanceId>, worlds: Float32Array, firstRow?: number): void;
  bindWorld(id: InstanceId, source: () => ArrayLike<number>): void;
  unbindWorld(id: InstanceId): void;
  syncWorlds(): number; // number of sources copied
  slotOf(id: InstanceId): number;
  idAt(slot: number): InstanceId;
}
```

Declare attributes once; TypeScript infers what `add()` requires:

```ts
import { instances } from "vgpu/scene";

const markers = instances({
  capacity: 10_000,
  attributes: {
    tint: { format: "float32x4", default: [1, 1, 1, 1] }, // optional in add()
    pickId: "uint32",                                      // required in add(): no default
  },
});

const marker = markers.add({ pickId: 7 });           // tint = [1, 1, 1, 1], world = identity
markers.set(marker, { tint: [1, 0.2, 0.2, 1] });     // partial attribute update
// @ts-expect-error pickId is required; executing this also throws VGPU-INSTANCE-ATTRIBUTE.
markers.add({ tint: [0, 0, 1, 1] });
```

Scalar formats take a `number`; vector formats take an `ArrayLike<number>` of exactly that many components. `float32` values must stay finite after float32 conversion. `sint32`/`uint32` values must be integers inside their 32-bit range.

Layout and capacity:

- **The schema is snapshotted at creation.** Attribute order is declaration order. Mutating the `attributes` object or a `default` array afterwards changes nothing.
- **Names** are unique, non-numeric, and must not be `world0`, `world1`, `world2`, or `world3` — those are reserved for the world matrix columns.
- **Capacity is fixed.** It is a nonnegative integer, `0` included. `add()` on a full collection throws `VGPU-INSTANCE-CAPACITY`. There is no growth: to grow, create a larger collection and bridge, copy your data, re-establish bindings, and update your stored handles and draws.
- **Records start with the identity world matrix.**

### Handles, slots, and removal

`add()` returns an `InstanceId`: an opaque handle specific to this collection, stable while the instance lives, and never silently reused. A removed, stale, or foreign handle throws `VGPU-INSTANCE-HANDLE`. Handles are not persistent or serializable — do not save them.

A slot is the record's current position in the packed buffer; it is what the shader sees as `@builtin(instance_index)`. `remove()` compacts the collection by moving the last record into the removed slot, so slots change and handles do not. `slotOf(id)` and `idAt(slot)` describe the current packing only.

> Good to know: For GPU picking, read a stable application ID from an attribute such as `pickId` rather than `instance_index`. Readbacks arrive frames later, after slots may have moved. Do not recycle your own IDs while a readback is pending — the collection cannot know about it.

### Who writes the world matrix

Each instance has one world authority at a time:

| Authority | Call | When to use |
|---|---|---|
| Direct write | `setWorld(id, world)` | One-off placement, occasional moves |
| Batch write | `setWorlds(ids, worlds, firstRow?)` | Physics or ECS output: many final world matrices in one `Float32Array` |
| Bound source | `bindWorld(id, () => matrix)` once, then `syncWorlds()` per frame | A node or another object that already owns a world matrix |

```ts illustrative
armParts.bindWorld(clawId, () => claw.worldMatrix); // once; the collection knows nothing about SceneNode
armParts.syncWorlds();                                // per frame: calls each source once and copies its matrix

armParts.unbindWorld(clawId);                        // keeps the last copied matrix
armParts.setWorld(clawId, physicsWorld);             // a new, explicit authority
```

Rules:

- **Every world write is validated.** `setWorld`, `setWorlds`, and `syncWorlds` check 16 finite values and the exact affine bottom row `0, 0, 0, 1` at indices `3, 7, 11, 15`.
- **`setWorlds` is all-or-nothing.** Row `firstRow + i` of `worlds` goes to `ids[i]`; the ids' slots need not be contiguous. The whole batch is validated first — live handles of this collection, no duplicates, no bound ids, enough rows, every matrix — and nothing is written if any check fails. An empty batch is valid. `firstRow` defaults to `0` and must be a nonnegative integer.
- **Bound instances reject direct world writes.** `setWorld`/`setWorlds` on a bound id throw `VGPU-INSTANCE-BOUND`; call `unbindWorld(id)` first. Binding an already bound id also throws — unbind it before replacing the source. Attributes stay writable with `set()` while bound.
- **`unbindWorld`** validates the handle, then does nothing if the id is already unbound. `remove()` drops the binding. The collection holds your source function, and whatever it captures, until you unbind or remove.
- **Sources are synchronous readers.** During `syncWorlds`, a source must not mutate the collection, call `syncWorlds` again, or publish a bridge — those throw `VGPU-INSTANCE-REENTRANT`. The collection does not keep the returned array and does not compare values.
- **A failing source can leave partial copies.** Sources run in order; if one throws or returns an invalid matrix (`VGPU-INSTANCE-SOURCE`), rows copied before it keep their new values. There is no rollback or retry. Abort that frame (a throw inside the `frameLoop` callback cancels the frame and stops the loop), fix the source, and run a complete `syncWorlds` again.

Cost: `syncWorlds` costs one source call, validation, and a 64-byte copy per bound instance, plus whatever lazy node recomputation the source triggers. `setWorlds` costs validation plus a 64-byte copy per row.

## Drive a camera from state you own

Camera functions operate on plain objects you allocate and keep. The rig and lens operations mutate the state you pass and return it; `rigPose`, `perspective`, and `orthographic` write into the `out` you pass and return it; `viewMatrices` writes into its `out` and returns `void`; `worldPerPixel` returns a number. None of them listen to the DOM, schedule frames, or create nodes.

```ts illustrative
interface OrbitRig { target: Float32Array; pan: Float32Array; yaw: number; pitch: number; distance: number }
interface OrbitRigOptions { target?: ArrayLike<number>; pan?: ArrayLike<number>; yaw?: number; pitch?: number; distance?: number }
interface RigLimits { minPitch?: number; maxPitch?: number; minDistance?: number; maxDistance?: number }
interface Pose { position: Float32Array; quaternion: Float32Array } // world space, lengths 3 and 4
interface Lens { fov: number; near: number; far: number }            // vertical fov in degrees
interface CameraMatrices { view: Mat4; viewProjection: Mat4 }

function orbitRig(initial?: OrbitRigOptions): OrbitRig;
function orbit(rig: OrbitRig, deltaYaw: number, deltaPitch: number, limits?: RigLimits): OrbitRig;
function pan(rig: OrbitRig, right: number, up: number): OrbitRig;
function dolly(rig: OrbitRig, factor: number, limits?: RigLimits): OrbitRig;
function zoom(lens: Lens, factor: number, limits?: { minFov?: number; maxFov?: number }): Lens;
function smoothRig(current: OrbitRig, goal: OrbitRig, dt: number, options: { timeConstant: number }): OrbitRig;
function rigPose(rig: OrbitRig, out: Pose): Pose;
function perspective(lens: Lens, aspect: number, out: Mat4): Mat4;
function orthographic(bounds: { left: number; right: number; bottom: number; top: number; near: number; far: number }, out: Mat4): Mat4;
function viewMatrices(pose: Pose, projection: ArrayLike<number>, out: CameraMatrices): void;
function worldPerPixel(distance: number, lens: Lens, heightPixels: number): number;
```

### The orbit rig

An `OrbitRig` orbits a pivot, `target + pan`. `target` is what the camera follows — set it from your app, an animation, or physics. `pan` is the user's world-space offset from it. Keeping them separate means updating the followed target never erases the user's pan.

| Field | Default | Meaning |
|---|---|---|
| `target` | `[0, 0, 0]` | Followed world point. `orbitRig()` copies your input into a new `Float32Array(3)`. |
| `pan` | `[0, 0, 0]` | User offset in world units, added to `target`. |
| `yaw` | `0` | Radians around +Y. `0` places the camera on the +Z side of the pivot. Not wrapped, so continuous spins stay continuous. |
| `pitch` | `0` | Radians. Positive raises the camera above the pivot. Must stay inside `(-π/2, π/2)`. |
| `distance` | `1` | World units from the pivot. Must be finite and positive. |

`rigPose(rig, out)` writes a world-space pose:

- `position = pivot + distance * [cos(pitch) * sin(yaw), sin(pitch), cos(pitch) * cos(yaw)]`
- `quaternion = Ry(yaw) * Rx(-pitch)`, so the camera's −Z axis points at the pivot.

The operations:

- **`orbit(rig, deltaYaw, deltaPitch, limits?)`** adds radians and clamps pitch. Default pitch limits are `±(π/2 − 1e-4)`.
- **`pan(rig, right, up)`** adds world units along the right and up axes of the rig you pass it. Pass the goal rig (see smoothing below), so the pan follows the orientation the user is steering toward.
- **`dolly(rig, factor, limits?)`** multiplies `distance`: a factor above `1` moves away. Default distance limits are `[1e-4, Infinity]`.
- **`zoom(lens, factor, limits?)`** narrows the lens instead of moving the camera: it sets `tan(fov / 2) /= factor`, so a factor above `1` zooms in. Default limits are `minFov: 1e-4` and `maxFov: 180 − 1e-4` degrees.

Factors must be finite and positive — `1` is the neutral value, `0` throws. Limits that are invalid or reversed throw before anything is mutated. `orbit` and `dolly` clamp valid candidates into the limits; when you write rig fields directly, keep `distance` finite and positive and `pitch` inside `(-π/2, π/2)`.

### Smoothing

Keep two rigs: a **goal** that input and following write to, and a **current** that the camera renders from. `smoothRig` moves only `current` toward `goal`:

```ts
import { orbitRig, smoothRig } from "vgpu/scene";

const goal = orbitRig({ yaw: 0.6, pitch: 0.35, distance: 9 });
const current = orbitRig(goal); // a copy — no shared arrays
const smoothing = { timeConstant: 0.15 }; // seconds

smoothRig(current, goal, 1 / 60, smoothing);
```

Each call blends by `k = 1 − exp(−dt / timeConstant)`: linearly for `target`, `pan`, `yaw`, and `pitch`, and logarithmically for `distance`. After `timeConstant` seconds of steady calls, `current` has covered about 63% of a fixed gap.

- `timeConstant: 0` snaps `current` to `goal`, even with `dt = 0` — useful for a paused editor.
- `timeConstant > 0` with `dt = 0` changes nothing.
- `dt` and `timeConstant` must be finite and nonnegative.
- `current` and `goal` must not share or overlap arrays, and `current`'s writable fields must not overlap each other — `VGPU-CAMERA-ALIAS`. Create both with `orbitRig()` to be safe.
- A lens is never smoothed or followed implicitly; zoom it yourself.

Exact frame-rate independence is not promised while the goal itself moves every frame.

### Projection and view matrices

```ts
import { orbitRig, orthographic, perspective, rigPose, viewMatrices } from "vgpu/scene";

const current = orbitRig({ distance: 9 });
const lens = { fov: 50, near: 0.1, far: 200 };
const projection = new Float32Array(16);
const pose = { position: new Float32Array(3), quaternion: new Float32Array([0, 0, 0, 1]) };
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

perspective(lens, 16 / 9, projection);
viewMatrices(rigPose(current, pose), projection, matrices); // matrices.viewProjection = projection * view

orthographic({ left: -4, right: 4, bottom: -2.25, top: 2.25, near: 0, far: 50 }, projection); // or an orthographic lens
```

- `perspective` requires `0 < fov < 180` (vertical, degrees), `0 < near < far`, all finite, and a finite positive `aspect`.
- `orthographic` requires `left < right`, `bottom < top`, and `0 <= near < far`, all finite. The previous camera allowed flipped bounds (but rejected equal bounds). For a mirrored projection, pass your own projection matrix to `viewMatrices`.
- `viewMatrices` accepts any finite projection matrix, not only the ones above. It requires a finite pose, normalizes a nonzero quaternion for the calculation without mutating the pose, and rejects a zero quaternion.
- A free-fly or physics camera can skip the rig entirely and write `pose.position` and `pose.quaternion` itself.

### Pointer input stays in your app

There is no built-in input adapter. Convert your events into rig deltas, accumulate them, and apply them once per tick. `worldPerPixel(distance, lens, heightPixels)` returns `2 * distance * tan(fov / 2) / heightPixels`, the world size of one pixel at the pivot, so a pan follows the cursor:

```ts
import { orbitRig, worldPerPixel } from "vgpu/scene";

const canvas = document.createElement("canvas");
const goal = orbitRig({ distance: 9 });
const lens = { fov: 50, near: 0.1, far: 200 };
const radiansPerPixel = 0.005;
const input = { yaw: 0, pitch: 0, panRight: 0, panUp: 0, dolly: 1 }; // neutral values

canvas.addEventListener("pointermove", (event) => {
  if (event.buttons !== 1) return;
  if (event.shiftKey) {
    const units = worldPerPixel(goal.distance, lens, canvas.clientHeight); // CSS pixels, like movementX/Y
    input.panRight -= event.movementX * units;
    input.panUp += event.movementY * units;
  } else {
    input.yaw -= event.movementX * radiansPerPixel;
    input.pitch += event.movementY * radiansPerPixel;
  }
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  input.dolly *= Math.exp(event.deltaY * 0.001); // scroll down moves away
}, { passive: false });
```

`heightPixels` and the deltas must use the same units. Pointer events report CSS pixels, so pass `canvas.clientHeight`, not the physical `canvas.height`.

## Publish instances to the GPU

`instanceGeometry` from `vgpu/scene/gpu` combines a base mesh with an instance vertex stream fed by one collection. It returns a composed `Geometry` you pass to `draw(gpu, { geometry })`.

```ts illustrative
import type { Geometry, Gpu } from "vgpu";
import type { InstanceAttributes, InstanceCollection } from "vgpu/scene";

interface InstanceGeometry {
  readonly geometry: Geometry; // base mesh streams + the instance stream
  publish(): number;           // uploads pending changes, returns the current count
  destroy(): void;
}

function instanceGeometry<A extends InstanceAttributes>(
  gpu: Gpu,
  collection: InstanceCollection<A>,
  options: { mesh: Geometry },
): InstanceGeometry;
```

### The instance stream layout

The instance stream is one vertex buffer with `stepMode: "instance"`, sized to the collection's `capacity` and allocated once. Each record is the 64-byte world matrix followed by your attributes in declaration order, 4-byte aligned:

| Attribute name | WGSL input type | Content |
|---|---|---|
| `world0` … `world3` | `vec4f` | World matrix columns 0–3 (one vertex attribute each) |
| each `float32` / `float32xN` attribute | `f32` / `vecNf` | Your value |
| each `sint32` / `sint32xN` attribute | `i32` / `vecNi` | Your value |
| each `uint32` / `uint32xN` attribute | `u32` / `vecNu` | Your value |

The attributes are matched to vertex shader inputs by name, like any other `geometry(gpu)` attribute. The base mesh keeps its own attributes. `vgpu/scene` recipes pin `position` to `@location(0)`, `normal` to `@location(1)`, and — for recipes that have one — `uv` to `@location(2)`: `box()` supplies only `position` and `normal`, while `sphere()` also supplies `uv`. Pick free locations for the instance inputs in your shader.

> Warning: Every shader drawn with `bridge.geometry` must declare every instance attribute as a vertex input — `world0..world3` and each custom attribute — even when that shader does not use it. A missing input throws `VGPU-MESH-ATTRIBUTE-UNMATCHED` when the pipeline is created. This applies to every pass that shares the geometry, a depth prepass included. Declare the base mesh attributes too: the explicit-location recipe attributes may be omitted, but a complete declaration keeps every consumer of the bridge consistent.

Creation limits, checked by `instanceGeometry` before it allocates anything and reported as `VGPU-INSTANCE-LAYOUT` with the offending names and the actual versus permitted counts:

- `mesh` must come from the same `gpu`.
- `mesh` must not already have an instance-step buffer, and none of its attribute names may collide with `world0..world3` or your attribute names. Instance attributes are matched by name; choose their locations explicitly in WGSL.
- The total vertex attributes (base mesh + 4 world columns + your attributes) must fit the device's `maxVertexAttributes`. On the WebGPU default of 16, a `box()` mesh (2 attributes) leaves room for 10 custom instance attributes, and a `sphere()` mesh (3 attributes) for 9.
- The composed geometry may have at most 8 vertex buffers (and no more than the device's `maxVertexBuffers`). The instance stride (`64 + 4 × total attribute components`) may be at most 2048 bytes (and no more than `maxVertexBufferArrayStride`), and `capacity × stride` must fit `maxBufferSize`.

A base mesh that is already destroyed fails the factory's layout preflight with `VGPU-INSTANCE-LAYOUT`. Pass a live base mesh to `instanceGeometry`.

There is no storage-buffer variant and no shader injection; the stream reaches your shader only through the vertex inputs you declare.

### Ownership and lifetime

- The bridge owns its instance buffer and the composed `bridge.geometry` wrapper. The base `mesh` stays yours: the bridge borrows its buffers and never destroys them.
- `bridge.destroy()` and `bridge.geometry.destroy()` share one destroyed state and are idempotent. Disposing the `gpu` destroys the bridge too.
- After the bridge, its composed geometry, or the base mesh is destroyed, `publish()`, drawing with `bridge.geometry`, recording it into a render bundle, and replaying a bundle that already contains it all throw `VGPU-INSTANCE-DESTROYED` instead of reading destroyed buffers. This includes draws compiled before the destruction. Create a new bridge on a live base mesh, then recreate the draws and re-record the bundles that used the old one.
- Keep the base mesh alive for as long as any bridge built on it is in use. Destroying the base invalidates its bridges but does not release their instance buffers; call `bridge.destroy()` or dispose the GPU to release those buffers.

### What `publish()` does

`publish()` copies the collection's current CPU records to the instance buffer and returns the collection's `count`. It never calls bound sources, never evaluates nodes or hierarchies, and never touches the camera — run `syncWorlds()`/`setWorlds()` first.

- The first `publish()` of a bridge uploads every active record. A later `publish()` with no changes in between uploads 0 bytes, though it may still scan all records.
- Removals, slot moves, and a shrinking count are tracked, so the buffer always matches the current packing.
- Each bridge keeps its own cursor. Two bridges on the same collection — for example one with a detailed mesh and one with a low-poly proxy mesh — each see every change, and a failed publish on one never consumes the other's pending changes.
- `publish()` during `syncWorlds()` throws `VGPU-INSTANCE-REENTRANT`.

### Ordering contract

The instance buffer is a live resource, not a per-draw snapshot:

1. Update worlds and attributes, then call `publish()`.
2. Encode every pass that draws with this bridge.
3. Do not `publish()` again until the frame holding those passes is submitted — a second publish in the same frame rewrites the buffer the earlier passes read.

Publication queues buffer writes immediately; an exception later in the frame does not undo them. Later frames are ordered by the GPU queue, so publishing at the start of the next frame is safe without waiting for the GPU to go idle. If two passes in one frame need different instance contents, give them separate collections and bridges.

The count comes from `publish()` and reaches the GPU only through the draw call: `pass.draw(boxDraw, { instances: count })`. `0` is valid and draws nothing. The composed geometry has `instanceCount: 0`: omitting the explicit `instances` option also draws nothing. A [render bundle](/concepts/render-bundles) records the count at record time; re-record it whenever the count changes.

## WGSL helpers from `@vgpu/wgsl-std/scene`

`@vgpu/wgsl-std/scene` provides pure functions for the math every instanced shader repeats. They declare no bindings — imported WGSL modules cannot, see [WGSL modules](/concepts/wgsl-modules) — and implement no shading, color, or lighting.

```wgsl
export fn instanceWorldMatrix(world0: vec4f, world1: vec4f, world2: vec4f, world3: vec4f) -> mat4x4f;
export fn transformPosition(world: mat4x4f, position: vec3f) -> vec3f;
export fn transformDirection(world: mat4x4f, direction: vec3f) -> vec3f;
export fn transformNormal(world: mat4x4f, normal: vec3f) -> vec3f;
```

| Helper | Returns |
|---|---|
| `instanceWorldMatrix` | `mat4x4f(world0, world1, world2, world3)` — the columns published by the bridge. |
| `transformPosition` | `(world * vec4f(position, 1.0)).xyz` — applies rotation, scale, shear, and translation. |
| `transformDirection` | The linear part applied to `direction`, without translation and without normalization. |
| `transformNormal` | The normalized inverse-transpose of the linear part applied to `normal` for well-conditioned inputs, including nonuniform scale, shear, and reflections. Returns `vec3f(0.0)` when its guarded `f32` calculations detect a zero normal, linear magnitude, determinant, or cofactor result. |

Only finite affine matrices are supported. The zero guard has no epsilon or rank tolerance: rounding can make singular authoring data produce a nonzero computed determinant and direction. Near-singular matrices and extreme axis ratios can amplify rounding or backend-dependent subnormal behavior; this helper is not symbolic rank detection. Use an exact singular representation such as a zero column when you require the fallback. Handle the `vec3f(0.0)` fallback where you normalize again after interpolation — `safeNormalize3` from `@vgpu/wgsl-std/math` does that with a fallback you choose.

> Warning: If your shader stretches or deforms the mesh beyond the world matrix — a per-instance `size`, a displacement — pass the complete transform to `transformPosition` and `transformNormal`, or supply an adjusted normal yourself. The helpers cannot see transforms they are not given.

Mirrored instances (negative determinant) get correct normals, but their triangles flip winding on screen. Use `cull: "none"` for a draw that mixes mirrored and unmirrored instances, or `frontFace: "cw"` when every instance is mirrored.

### A complete instanced shader

This shader is used by every example below. `box()` supplies `position` and `normal`; the bridge supplies `world0..world3`, `size`, and `tint`; `lighting` and `camera` are uniforms you set by name.

```wgsl
// boxes.wgsl
import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import { safeNormalize3 } from "@vgpu/wgsl-std/math";

struct Lighting { direction: vec3f, ambient: f32 }
struct CameraData { viewProjection: mat4x4f }

@group(0) @binding(0) var<uniform> lighting: Lighting;
@group(1) @binding(0) var<uniform> camera: CameraData;

struct VertexIn {
  @location(0) position: vec3f, // box() mesh
  @location(1) normal: vec3f,   // box() mesh
  @location(3) world0: vec4f,   // instance stream: world matrix columns
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) size: vec3f,     // instance attribute "size": "float32x3"
  @location(8) tint: vec4f,     // instance attribute "tint": "float32x4"
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) tint: vec4f,
}

@vertex fn vs_main(input: VertexIn) -> VertexOut {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  // box() is a unit cube; `size` stretches it, so the complete transform is world * shape
  let shape = mat4x4f(
    vec4f(input.size.x, 0.0, 0.0, 0.0),
    vec4f(0.0, input.size.y, 0.0, 0.0),
    vec4f(0.0, 0.0, input.size.z, 0.0),
    vec4f(0.0, 0.0, 0.0, 1.0),
  );
  let model = world * shape;

  var out: VertexOut;
  out.clip = camera.viewProjection * vec4f(transformPosition(model, input.position), 1.0);
  out.normal = transformNormal(model, input.normal);
  out.tint = input.tint;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let normal = safeNormalize3(input.normal, vec3f(0.0, 1.0, 0.0));
  let diffuse = max(dot(normal, normalize(-lighting.direction)), 0.0);
  return vec4f(input.tint.rgb * (lighting.ambient + diffuse), input.tint.a);
}
```

Import it through a bundler loader or `resolveShader()` so the `@vgpu/wgsl-std` imports resolve — see [WGSL modules](/concepts/wgsl-modules).

The vertex inputs match the geometry exactly: every attribute the geometry provides is declared, and nothing else. The matching rules are asymmetric:

- A shader input the geometry does not provide always throws `VGPU-MESH-INPUT-MISSING`.
- A name-matched geometry attribute without a shader input throws `VGPU-MESH-ATTRIBUTE-UNMATCHED`. Every instance attribute (`world0..world3` and your custom attributes) is name-matched, so all of them must be declared.
- Recipe attributes carry an explicit location, so a shader may omit one — a depth-only shader could skip `normal`. Declare the complete set anyway in shaders that share a bridge, so every consumer reads the same stream layout.

This shader is written for `box()`, which supplies only `position` and `normal`. To instance `sphere()` instead, add `@location(2) uv: vec2f` to `VertexIn`; a shader that declares `uv` fails against a `box()` bridge, so give each base mesh its own vertex entry point.

## Connect the camera to your shader by name

The camera matrix is plain CPU data. It reaches the shader only when you pass it to `set()` under the WGSL binding name. The shader author chooses the group and binding; reflection maps the name `camera` to `@group(1) @binding(0)`, so the TypeScript side never repeats the numbers.

```wgsl
// lit.wgsl
struct Lighting { direction: vec3f, ambient: f32 }
struct CameraData { viewProjection: mat4x4f }
@group(0) @binding(0) var<uniform> lighting: Lighting;
@group(1) @binding(0) var<uniform> camera: CameraData;

struct VertexOut { @builtin(position) clip: vec4f, @location(0) normal: vec3f }

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var out: VertexOut;
  out.clip = camera.viewProjection * vec4f(position, 1.0);
  out.normal = normal;
  return out;
}

@fragment fn fs_main(@location(0) normal: vec3f) -> @location(0) vec4f {
  let diffuse = max(dot(normalize(normal), normalize(-lighting.direction)), 0.0);
  return vec4f(vec3f(0.9, 0.5, 0.1) * (lighting.ambient + diffuse), 1.0);
}
```

```ts
import { draw, geometry, init } from "vgpu";
import { box } from "vgpu/scene";
import litShader from "./lit.wgsl";

const gpu = await init();
const viewProjection = new Float32Array(16);

// ---cut---
const cube = draw(gpu, { shader: litShader, geometry: geometry(gpu, box({ size: 1 })) });

// viewProjection is matrices.viewProjection, written by viewMatrices()
cube.set({
  lighting: { direction: [-0.4, -1, -0.3], ambient: 0.15 }, // binding `lighting` -> @group(0) @binding(0)
  camera: { viewProjection },                              // binding `camera` -> @group(1) @binding(0)
});
```

The rules of this connection:

- **Use the full binding name.** `set({ camera: { viewProjection } })` names the binding and its member. `set()` also accepts a bare member name when it is unambiguous, but the full form keeps the wiring readable and stays correct when two structs share a member name.
- **`set()` packs at call time.** Mutating `matrices.viewProjection` afterwards does not update the GPU value. Call `set()` again after every `viewMatrices()` you want the draw to see.
- **Direct draws capture values when encoded.** Inside a frame, `pass.draw()` captures the uniform values current at that moment, so setting a different camera before each of two `pass.draw()` calls renders two views — see [Frames](/concepts/frames).
- **The matrix has no group of its own.** The same `matrices.viewProjection` can feed several draws whose shaders put `camera` in different groups or under different names.
- **Instance data has no bind group.** It travels as vertex inputs; its only connection is `geometry: bridge.geometry` at draw creation plus the matching WGSL inputs.

## The frame, step by step

The executable `examples/by-example-s06-scene/src/composition.ts` and its native tests demonstrate equivalent group, external-hierarchy, and final-world paths using the same shader and two passes.

Both complete examples below render the same scene with the same shader: a three-part arm (base → arm → claw) plus a population of crates, all drawn with one instanced draw call, with an orbit camera that follows the claw. They differ only in where the arm's world matrices come from.

This setup renders the scene into an offscreen depth target and composites it to the canvas, which is where a post-processing pass belongs. If you only present the scene, render it straight to a depth surface instead — see [Render straight to the canvas](#render-straight-to-the-canvas).

Shared setup — targets, the collection, the bridge, the draw, and camera state — is created once:

```wgsl
// present.wgsl
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(scene, sceneSampler, uv, 0.0);
}
```

```ts
// shared.ts
import { clock, draw, effect, frameLoop, geometry, init, sampler, surface, target, type Frame } from "vgpu";
import { box, composeMatrix, dolly, instances, orbit, orbitRig, pan, perspective, rigPose, smoothRig, viewMatrices, type InstanceId } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import boxShader from "./boxes.wgsl";
import presentShader from "./present.wgsl";

export const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
const sceneTarget = target(gpu, { size: canvasSurface.size, depth: true }); // offscreen, so the present pass can sample it
canvasSurface.onResize(({ width, height }) => sceneTarget.resize([width, height]));
const present = effect(gpu, presentShader, { set: { scene: sceneTarget, sceneSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }) } });

// One collection for arm parts and crates: same mesh, same attributes, one draw call.
export const crateCount = 2000;
export const boxes = instances({
  capacity: 3 + crateCount,
  attributes: { size: "float32x3", tint: { format: "float32x4", default: [1, 1, 1, 1] } },
});
export const partIds: InstanceId[] = [
  boxes.add({ size: [1.2, 0.5, 1.2], tint: [0.3, 0.3, 0.35, 1] }), // base
  boxes.add({ size: [0.3, 1.6, 0.3], tint: [0.9, 0.5, 0.1, 1] }),  // arm
  boxes.add({ size: [0.6, 0.2, 0.6] }),                            // claw, default tint
];
export const crateIds: InstanceId[] = Array.from({ length: crateCount }, () => boxes.add({ size: [0.4, 0.4, 0.4], tint: [0.6, 0.45, 0.3, 1] }));

const boxMesh = geometry(gpu, box()); // you own it; the bridge borrows it
const bridge = instanceGeometry(gpu, boxes, { mesh: boxMesh });
const boxDraw = draw(gpu, { shader: boxShader, geometry: bridge.geometry, cull: "back" });
boxDraw.set({ lighting: { direction: [-0.4, -1, -0.3], ambient: 0.15 } }); // constant: set once

// Camera state, allocated once and reused every frame.
export const goal = orbitRig({ yaw: 0.6, pitch: 0.35, distance: 9 });
const current = orbitRig(goal);
const lens = { fov: 50, near: 0.1, far: 200 };
const smoothing = { timeConstant: 0.15 };
const projection = new Float32Array(16);
const pose = { position: new Float32Array(3), quaternion: new Float32Array([0, 0, 0, 1]) };
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

// Neutral input renders without listeners. Optionally attach the handlers shown above here.
const input = { yaw: 0, pitch: 0, panRight: 0, panUp: 0, dolly: 1 };

export function renderFrame(currentFrame: Frame, dt: number) {
  // 1. Input -> goal rig, once per tick, then reset to neutral values.
  orbit(goal, input.yaw, input.pitch);
  pan(goal, input.panRight, input.panUp);
  dolly(goal, input.dolly);
  Object.assign(input, { yaw: 0, pitch: 0, panRight: 0, panUp: 0, dolly: 1 });

  // 2. Smooth, project, and build the view matrices.
  smoothRig(current, goal, dt, smoothing);
  perspective(lens, sceneTarget.size[0] / sceneTarget.size[1], projection);
  viewMatrices(rigPose(current, pose), projection, matrices);

  // 3. Connect the camera by binding name; set() packs now.
  boxDraw.set({ camera: { viewProjection: matrices.viewProjection } });

  // 4. Publish instance records before encoding any pass that reads them.
  const count = bridge.publish();

  // 5. Encode: the scene into the depth target, then composite to the canvas.
  currentFrame.pass({ target: sceneTarget, clear: [0.05, 0.05, 0.07, 1], clearDepth: 1 }, (pass) => {
    pass.draw(boxDraw, { instances: count });
  });
  currentFrame.pass(canvasSurface, present);
}

export function run(tick: (currentFrame: Frame, time: number, dt: number) => void) {
  const frameClock = clock(gpu);
  return frameLoop(gpu, (currentFrame) => tick(currentFrame, frameClock.time, frameClock.deltaTime));
}

// Example simulation writes final worlds directly. Replace it with your physics engine's output.
export function simulateCrates(time: number, out: Float32Array): void {
  for (let row = 0; row < crateCount; row++) {
    composeMatrix({
      position: [(row % 50 - 25) * 0.7, -0.5 + Math.sin(time + row * 0.1) * 0.1, (Math.floor(row / 50) - 20) * 0.7],
      rotation: [0, time * 0.1, 0],
    }, out.subarray(row * 16, row * 16 + 16));
  }
}
```

The per-frame order is fixed by data dependencies, and every step is a call you can see:

1. Apply input to the goal rig.
2. Update local transforms (nodes or your arrays).
3. Resolve world matrices (lazy node reads, or `evaluateHierarchy`).
4. Copy worlds into the collection (`syncWorlds`, `setWorlds`).
5. Follow: write the goal's `target` from a world position.
6. Smooth the rig, then build the projection and view matrices.
7. `set()` the camera on each draw that uses it.
8. `publish()` each bridge once.
9. Encode the passes with the count from `publish()`.

Steps 1 and 6–9 live in `renderFrame`; steps 2–5 differ per variant.

### Variant A: nodes

```ts illustrative
import { group } from "vgpu/scene";
import { boxes, crateCount, crateIds, goal, partIds, renderFrame, run, simulateCrates } from "./shared.ts";

const claw = group({ position: [0, 1.6, 0] });
const arm = group({ position: [0, 0.5, 0], children: [claw] });
const base = group({ position: [0, 0.25, 0], children: [arm] });

// Bind once: each part's world matrix comes from its node.
[base, arm, claw].forEach((node, index) => boxes.bindWorld(partIds[index], () => node.worldMatrix));

const crateWorlds = new Float32Array(crateCount * 16);

run((currentFrame, time, dt) => {
  base.set({ rotation: [0, time * 0.3, 0] });           // 2. local transforms
  arm.set({ rotation: [0, 0, Math.sin(time) * 0.6] });
  boxes.syncWorlds();                                    // 3 + 4. nodes resolve lazily, 3 matrices copied
  simulateCrates(time, crateWorlds);
  boxes.setWorlds(crateIds, crateWorlds);                // 4. physics output: final worlds, no hierarchy
  goal.target.set(claw.worldPosition);                   // 5. follow the claw; pan is untouched
  renderFrame(currentFrame, dt);
});
```

### Variant B: your own arrays (ECS)

```ts illustrative
import { composeMatrix, evaluateHierarchy, hierarchyOrder } from "vgpu/scene";
import { boxes, crateCount, crateIds, goal, partIds, renderFrame, run, simulateCrates } from "./shared.ts";

const parents = new Int32Array([-1, 0, 1]); // rows: base, arm, claw — same order as partIds
const locals = new Float32Array(3 * 16);
const worlds = new Float32Array(3 * 16);
const localRows = [0, 1, 2].map((row) => locals.subarray(row * 16, row * 16 + 16));
composeMatrix({ position: [0, 0.25, 0] }, localRows[0]);
composeMatrix({ position: [0, 0.5, 0] }, localRows[1]);
composeMatrix({ position: [0, 1.6, 0] }, localRows[2]);

const order = hierarchyOrder(parents);
evaluateHierarchy({ order, parents, locals, worlds }); // full evaluation after setup
const changed = new Uint8Array(3);
const armHierarchy = { order, parents, locals, worlds, changed };

const crateWorlds = new Float32Array(crateCount * 16);

run((currentFrame, time, dt) => {
  composeMatrix({ position: [0, 0.25, 0], rotation: [0, time * 0.3, 0] }, localRows[0]); // 2. locals
  changed[0] = 1;
  composeMatrix({ position: [0, 0.5, 0], rotation: [0, 0, Math.sin(time) * 0.6] }, localRows[1]);
  changed[1] = 1;
  evaluateHierarchy(armHierarchy);                        // 3. rows 0, 1 and descendant 2
  changed.fill(0);
  boxes.setWorlds(partIds, worlds);                       // 4. row i -> partIds[i]
  simulateCrates(time, crateWorlds);
  boxes.setWorlds(crateIds, crateWorlds);                 // 4. physics output skips the evaluator
  goal.target.set(worlds.subarray(2 * 16 + 12, 2 * 16 + 15)); // 5. claw translation, indices 44..46
  renderFrame(currentFrame, dt);
});
```

Both variants copy the same `3 + crateCount` matrices per frame into the same collection and render identically; neither is claimed to be faster. Variant B never creates a node, and a physics engine that already produces final world matrices needs only the `setWorlds` line. The part sizes are instance attributes applied in the shader, so the joints themselves keep unit scale and children are not stretched by their parents.

### Two passes, one bridge

A depth prepass and a color pass can share the bridge. Publish once, then encode both:

```ts illustrative
const count = bridge.publish(); // once per frame, before both passes
depthDraw.set({ camera: { viewProjection: matrices.viewProjection } });
boxDraw.set({ camera: { viewProjection: matrices.viewProjection } });

currentFrame.pass({ target: sceneTarget, clearDepth: 1 }, (pass) => pass.draw(depthDraw, { instances: count }));
currentFrame.pass({ target: sceneTarget, clear: false }, (pass) => pass.draw(boxDraw, { instances: count }));
```

`depthDraw` uses `geometry: bridge.geometry` too, so its shader declares `world0..world3`, `size`, and `tint` even though it ignores `tint`.

### Render straight to the canvas

When nothing samples the rendered scene, the offscreen target and present pass are optional. Create the surface with `depth` — and `msaa` for antialiased edges — and draw the bridge into it directly:

```ts
import { draw, frameLoop, geometry, init, surface } from "vgpu";
import { box, instances, orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import boxShader from "./boxes.wgsl";

const gpu = await init();
const canvas = document.querySelector("canvas")!;

// ---cut---
const canvasSurface = surface(gpu, canvas, { depth: true, msaa: true }); // owned depth24plus + 4× MSAA

const crates = instances({ capacity: 1, attributes: { size: "float32x3", tint: "float32x4" } });
crates.add({ size: [1, 1, 1], tint: [0.9, 0.5, 0.1, 1] });
const crateBridge = instanceGeometry(gpu, crates, { mesh: geometry(gpu, box()) }); // you still own the mesh
const crateDraw = draw(gpu, { shader: boxShader, geometry: crateBridge.geometry, cull: "back" });
crateDraw.set({ lighting: { direction: [-0.4, -1, -0.3], ambient: 0.15 } });

const rig = orbitRig({ yaw: 0.6, pitch: 0.4, distance: 4 });
const projection = new Float32Array(16);
const pose = { position: new Float32Array(3), quaternion: new Float32Array(4) };
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };

frameLoop(gpu, (currentFrame) => {
  perspective({ fov: 45, near: 0.1, far: 100 }, canvasSurface.size[0] / canvasSurface.size[1], projection);
  viewMatrices(rigPose(rig, pose), projection, matrices);
  crateDraw.set({ camera: { viewProjection: matrices.viewProjection } }); // set() packs now
  const crateCount = crateBridge.publish(); // before the pass that reads it
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.07, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount });
  });
});
```

Only the target changed: the camera, the named `set()` calls, `publish()` before encoding, and the explicit `instances` count are the same as in `renderFrame`. To switch the shared setup over, drop `sceneTarget` and `present`, compute the aspect from `canvasSurface.size`, and encode the single surface pass in step 5. With `msaa`, every surface pass clears, so the depth prepass above needs the offscreen target or a surface without `msaa`. See [`Surface`](/reference/vgpu/surface#surface) for attachment lifetimes and resize.

## Errors and how to fix them

The validation errors listed below are `VGPUError`s with a `code`, a message naming the offending field path, handle, attribute, or count, and a `fix`. Passing an object that was not created by `instances()` as a GPU bridge collection throws a `TypeError`; pass the original collection instead. Validation runs before any mutation unless the row says otherwise.

### Transforms and nodes

| Code | When | Fix |
|---|---|---|
| `VGPU-SCENE-VALUE` | A transform value has the wrong length, is not finite, or a quaternion has zero length. | Pass 3 finite numbers for `position`/`rotation`/vector `scale`, 4 for a nonzero `quaternion`. |
| `VGPU-SCENE-CYCLE` | `add()` would make a node its own ancestor. | Remove the node from the ancestor chain first, or add a different node. |
| `VGPU-SPATIAL-SIZE` | A matrix input or `out` does not have exactly 16 elements. | Allocate `new Float32Array(16)`; for packed arrays pass a `subarray(row * 16, row * 16 + 16)` view. |
| `VGPU-SPATIAL-SINGULAR` | `invertAffine`/`localFromWorld` got a matrix with zero or non-finite determinant, or the inverse is not finite in float32. `out` is untouched. | Check for a zero scale or a collapsed axis in the matrix (or parent) you invert. |

### Hierarchies

| Code | When | Fix |
|---|---|---|
| `VGPU-SPATIAL-PARENT` | A parent index is not an integer in `[-1, n)`. | Use dense row indices, `-1` for roots. |
| `VGPU-SPATIAL-CYCLE` | The parents form a cycle. | Break the cycle; every row must reach a root. |
| `VGPU-SPATIAL-ORDER` | `parents` no longer matches the copy compiled into `order`. | Rebuild with `hierarchyOrder(parents)` after changing topology, then run a full evaluation. |
| `VGPU-SPATIAL-SIZE` | `locals`/`worlds` are not 16n, or `changed`/`updated` are not n. | Size arrays from `order.size`. |
| `VGPU-SPATIAL-ALIAS` | `worlds` or `updated` overlaps another output or any input. | Give each writable array its own buffer. |

### Instance collections

| Code | When | Fix |
|---|---|---|
| `VGPU-INSTANCE-ATTRIBUTE` | Invalid schema (duplicate, numeric, or reserved `world0..world3` name; unknown format), an unknown attribute in `add`/`set`, or a required attribute missing from `add`. | Match the declared attribute names; add a `default` to make an attribute optional. |
| `VGPU-INSTANCE-VALUE` | An attribute value has the wrong arity, is non-finite in float32, or is a non-integer/out-of-range `sint32`/`uint32`; or a world matrix is not 16 finite values with bottom row `0, 0, 0, 1`. | Fix the value at the path in the message. |
| `VGPU-INSTANCE-HANDLE` | A removed, stale, foreign, or forged `InstanceId`. | Use live handles returned by this collection's `add()`; drop handles after `remove()`; do not pass slots as handles. |
| `VGPU-INSTANCE-BOUND` | `setWorld`/`setWorlds` on a bound id, or `bindWorld` on an already bound id. | Call `unbindWorld(id)` first. |
| `VGPU-INSTANCE-CAPACITY` | `capacity` is not a nonnegative integer, or `add()` on a full collection. | Create a larger collection and bridge; capacity never grows. |
| `VGPU-INSTANCE-EXHAUSTED` | An identity or revision counter reached its largest safe integer; the message names the counter. Counters never wrap, so a stale handle can never alias a new instance. | Stop using the exhausted domain and recreate that application state — for example reload the page or restart the process. The handle counter is shared by all collections, so creating another collection does not fix identity exhaustion. |
| `VGPU-INSTANCE-RANGE` | `setWorlds` has an invalid `firstRow`, too few rows, or the same id twice; `idAt` got a slot outside `[0, count)`. | Pass a nonnegative integer `firstRow` with `worlds.length >= (firstRow + ids.length) * 16`, list each id at most once, and use live slots. |
| `VGPU-INSTANCE-SOURCE` | A bound source returned an invalid world matrix. Earlier sources in the same `syncWorlds` may already be copied. | Fix the source, abort the frame, and run `syncWorlds()` again. |
| `VGPU-INSTANCE-REENTRANT` | A source mutated the collection, called `syncWorlds`, or published a bridge during `syncWorlds`. | Keep sources as pure reads; mutate before or after syncing. |

### Cameras

| Code | When | Fix |
|---|---|---|
| `VGPU-CAMERA-VALUE` | A non-finite or out-of-range value: `fov` outside `(0, 180)`, `near`/`far`/`aspect`/bounds out of order, a zero or negative factor, invalid or reversed limits, `pitch` outside `(-π/2, π/2)`, non-positive `distance`, negative `dt`/`timeConstant`, a zero quaternion. Nothing is mutated. | Pass the value range named in the message; `1` is the neutral factor. |
| `VGPU-CAMERA-SIZE` | A pose vector or output matrix has the wrong length. | `position: Float32Array(3)`, `quaternion: Float32Array(4)`, matrices `Float32Array(16)`. |
| `VGPU-CAMERA-ALIAS` | `smoothRig` got a `current` and `goal` that are the same object or share or overlap arrays, or whose `current` fields overlap each other; or two outputs of one call overlap — `view`/`viewProjection` in `viewMatrices`, `position`/`quaternion` in `rigPose`. Output-to-input overlap is allowed. | Create each rig with `orbitRig()`; give each output field its own array. |

### GPU bridge

| Code | When | Fix |
|---|---|---|
| `VGPU-INSTANCE-LAYOUT` | A destroyed or unrecognized base mesh, base mesh from another `gpu`, base mesh with an instance-step buffer, an attribute name collision, or a limit exceeded (`maxVertexAttributes`, 8 buffers / `maxVertexBuffers`, 2048-byte / `maxVertexBufferArrayStride` stride, `maxBufferSize`). The message lists the names and actual versus permitted counts. | Use a live vertex-only mesh from the same gpu, rename attributes, reduce attribute width or capacity, or split into several collections. |
| `VGPU-INSTANCE-DESTROYED` | `publish()`, a draw, a bundle recording, or a bundle replay after the bridge, its composed geometry, or the base mesh was destroyed. | Create a new bridge on a live base mesh, then recreate the affected draws and re-record the affected bundles. |
| `VGPU-INSTANCE-REENTRANT` | `publish()` during `syncWorlds()`. | Finish syncing, then publish. |

### Wiring errors from the draw

These come from the existing draw and `set()` validation, and are the usual symptoms of a broken connection between CPU data and your WGSL:

| Code | Symptom | Fix |
|---|---|---|
| `VGPU-R1-BINDING-NEVER-SET` | The draw ran before `camera` (or `lighting`) was set. The message names the binding with its `@group`/`@binding`. | Call `draw.set({ camera: { viewProjection } })` before the first draw. |
| `VGPU-RING1-UNSUPPORTED` | `Binding 'cam' does not exist` — the key passed to `set()` matches no WGSL binding or member. | Use the WGSL variable name, e.g. `camera`. |
| `VGPU-SET-VALUE-INVALID` | Wrong member name, or a matrix that is not 16 values; the detail gives the value path such as `camera.viewProjection`. | Pass the reflected struct shape; `mat4x4f` takes 16 numbers. |
| `VGPU-MESH-ATTRIBUTE-UNMATCHED` | The shader does not declare an instance input such as `world2` or `tint`. | Declare every bridge attribute as a vertex input, in every shader drawn with that geometry. |
| `VGPU-MESH-INPUT-MISSING` | The shader declares a `@location` input that neither the mesh nor the bridge provides — for example `uv` against a `box()` base, which has only `position` and `normal`. | Remove the input, add the attribute to the collection, or use a base mesh that provides it (`sphere()` has `uv`). |
| `VGPU-MESH-FORMAT-MISMATCH` | An input type does not match its attribute, e.g. `pickId: f32` for a `"uint32"` attribute. | Use `f32`/`i32`/`u32` to match `float32`/`sint32`/`uint32`. Pass integer attributes to the fragment stage with `@interpolate(flat, either)`. |
| `VGPU-R1-DRAW-COUNT` | `instances` is not an integer `>= 0`. | Pass the number returned by `publish()`. |

## Migrate from the previous `vgpu/scene`

This release revises `vgpu/scene`. Geometry recipes (`box`, `sphere`, `plane`, …), `geometries`, `degToRad`, `srgb`, the geometry types, `group`, and `SceneNode` stay. Mesh nodes, materials, lights, camera nodes, the old `orbit`, and orbit controls are removed in favor of the explicit functions in this guide. There is no deprecated compatibility layer. The [migration lookup](/guides/scene-migration) preserves historical symbol links, and `.changeset/scene-composition-utilities.md` contains the release steps; this table maps every removed export:

| Removed | Replacement |
|---|---|
| `scene(options)` | `group(options)` — any node can be a root. |
| `mesh(geometry, material, options)`, `MeshNode` | `group(options)` for the transform, `geometry(gpu, box())` for buffers, and `draw(gpu, { shader, geometry })` with your WGSL. For many copies, an instance collection with `bindWorld(id, () => node.worldMatrix)`. |
| `normalMaterial`, `lambertMaterial`, `unlitMaterial`, `shaderMaterial`, and their classes `NormalMaterial`, `LambertMaterial`, `UnlitMaterial`, `ShaderMaterial`, `SceneMaterial`; types `ColorMaterialOptions`, `ColorMaterialValues`, `MaterialBlend`, `SceneMaterialKind`, `ShaderMaterialOptions` | Your fragment stage and `draw(gpu, { blend })`. `lambert` from `@vgpu/wgsl-std/light` covers diffuse lighting. |
| `ambientLight`, `directionalLight`, `AmbientLight`, `DirectionalLight`, and their option/value types | A uniform you declare, e.g. `lighting: Lighting`, set with `draw.set({ lighting: { … } })`. |
| `perspectiveCamera`, `PerspectiveCamera`, `PerspectiveCameraOptions`, `PerspectiveCameraValues` | A `Lens` + `perspective(lens, aspect, out)`, a `Pose` (from `rigPose` or written directly), and `viewMatrices(pose, projection, out)`. |
| `orthographicCamera`, `OrthographicCamera`, `OrthographicCameraOptions`, `OrthographicCameraValues` | `orthographic(bounds, out)` + `viewMatrices`. |
| `SceneCamera`, `Camera`, `CameraVec3` | `CameraMatrices`, `Pose`, `Lens`. `camera.viewProjection` becomes `matrices.viewProjection`. |
| `orbit(time, { radius, height, speed })` (model matrix), `OrbitOptions` | `composeMatrix({ position: [Math.cos(angle) * radius, height, Math.sin(angle) * radius], rotation: [0, angle, 0] }, out)` with `angle = time * speed`. The name `orbit` is now the camera function `orbit(rig, deltaYaw, deltaPitch, limits?)`. |
| `orbitControls(node, options)`, `OrbitControls`, `OrbitControlsElement`, `OrbitControlsOptions`, `OrbitControlsValues` | Your pointer listeners + `orbit`, `pan`, `dolly`, and `smoothRig`. `damping` (already a time constant in seconds) → `smoothRig`'s `timeConstant`; `rotateSpeed` → your radians-per-pixel factor; `zoomSpeed` → the exponent scale in your wheel handler's `dolly` factor; `target` → `orbitRig({ target })`; `distance: { min, max }` → `RigLimits.minDistance`/`maxDistance`; `pitch: { min, max }` → `minPitch`/`maxPitch`. |
| `SceneNodeKind` values `"scene"`, `"mesh"`, `"perspective-camera"`, `"orthographic-camera"`, `"directional-light"`, `"ambient-light"` | Only `"group"` remains. Store application-specific classifications separately. |

A fixed camera, before and after:

```ts illustrative
// Before
import { perspectiveCamera } from "vgpu/scene";

const camera = perspectiveCamera({ fov: 45, aspect: 16 / 9, position: [2, 2, 3], target: [0, 0, 0] });
cube.set({ camera: { viewProjection: camera.viewProjection } });
```

```ts
// After
import { orbitRig, perspective, rigPose, viewMatrices } from "vgpu/scene";

const lens = { fov: 45, near: 0.1, far: 100 }; // the old defaults, now explicit
const rig = orbitRig({
  target: [0, 0, 0],
  yaw: Math.atan2(2, 3),                  // atan2(x, z) of the old position
  pitch: Math.atan2(2, Math.hypot(2, 3)), // atan2(y, horizontal distance)
  distance: Math.hypot(2, 2, 3),
});
const projection = perspective(lens, 16 / 9, new Float32Array(16));
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(rigPose(rig, { position: new Float32Array(3), quaternion: new Float32Array(4) }), projection, matrices);

console.log(matrices.viewProjection); // pass to cube.set({ camera: { viewProjection: matrices.viewProjection } })
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

Behavior differences to check while migrating:

- **Re-`set()` after every camera change.** Old camera objects updated their matrices in place; `set()` has always packed at call time, so call it again after each `viewMatrices()`.
- **`far` must be finite.** The old perspective camera accepted `far: Infinity`; `perspective` requires `0 < near < far`, all finite.
- **Pitch limits are wider.** Old orbit controls clamped to `±(π/2 − 0.01)`; the new default is `±(π/2 − 1e-4)`. Pass `{ minPitch, maxPitch }` to keep the old range.
- **Smoothing is explicit.** The old controls defaulted missing or non-finite delta time to 1/60 second, blended distance linearly, snapped within 1e-6, and returned a changed boolean. `smoothRig` requires explicit finite nonnegative seconds, blends positive distance logarithmically, returns the current rig, and has no epsilon snap or changed boolean. Keep your own settling/render policy.
- **Reuse object matrices.** The old object `orbit` allocated a new matrix; `composeMatrix` writes into your `out`.
- **Input is yours.** Nothing attaches listeners to the canvas anymore; see [Pointer input stays in your app](#pointer-input-stays-in-your-app).
- **Node quaternions are normalized** when composed, matching `composeMatrix`; a zero quaternion throws `VGPU-SCENE-VALUE`.

## What `vgpu/scene` does not do

- No renderer, material or PBR system, lights, or render loop — the helpers supply math; shading is yours.
- No automatic uniforms, reserved bind groups, or generated WGSL interfaces. Every binding is connected by name with `set()`.
- No ECS, scheduler, or imposed scene store; external systems keep their own authority.
- No culling, automatic bounds, heterogeneous batching, GPU compute-owned instances, or storage-buffer instance variant.
- No automatic capacity growth, keep-world reparenting, matrix decomposition, or partial hierarchy traversal.
- No large-coordinate precision beyond float32.

See [Draws](/concepts/draws) for the `draw(gpu)` and `geometry(gpu)` basics this guide builds on, and [Two-pass rendering](/guides/two-pass-rendering) for the depth target and present pass used in the complete example, or a depth [`Surface`](/reference/vgpu/surface#surface) for single-pass rendering.
