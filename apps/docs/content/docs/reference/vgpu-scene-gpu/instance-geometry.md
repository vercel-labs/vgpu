---
title: "Instance geometry"
description: "Publish fixed-capacity instance collections as vertex streams for application-owned geometry and shaders."
---

# instanceGeometry

Publishes an instance collection from `instances()` as an instanced vertex stream on top of a base mesh, and returns a composed `Geometry` for `draw(gpu, { geometry })`. Use it to draw a whole collection — crates, trees, particles — with one instanced draw call and your own WGSL.

## Import

```ts
import { instanceGeometry } from "vgpu/scene/gpu";
```

## Signature

```ts
declare function instanceGeometry<A extends import("vgpu/scene").InstanceAttributes>(
  gpu: import("vgpu").Gpu,
  collection: import("vgpu/scene").InstanceCollection<A>,
  options: { mesh: import("vgpu").Geometry },
): import("vgpu/scene/gpu").InstanceGeometry;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| gpu | `Gpu` | ✔ | — | The live `gpu` from `init()`. The bridge's buffer and composed geometry belong to it. |
| collection | `InstanceCollection<A>` | ✔ | — | A collection created by `instances()`. Its `capacity` and attribute schema fix the size and layout of the instance buffer for the bridge's lifetime. |
| options.mesh | `Geometry` | ✔ | — | The base mesh, for example `geometry(gpu, box())`. Must be live, created from the same `gpu`, and have no instance-step vertex buffer of its own. Borrowed, never destroyed by the bridge. |

**Returns:** `InstanceGeometry` — a bridge whose `geometry` holds the base mesh's vertex streams and index buffer plus one instance stream sized for the full `capacity`. Nothing is uploaded from the collection until the first `publish()`.

**Throws:** every check below runs before the bridge allocates any GPU resource.
- `VGPU-GPU-DISPOSED` / `VGPU-GPU-FOREIGN` when `gpu` is disposed or is not a `gpu` from `init()` — pass the live `gpu`.
- `TypeError` ("Expected an instance collection created by instances().") when `collection` was not created by `instances()` — pass the collection itself, not a copy or a plain object.
- `VGPU-INSTANCE-LAYOUT` when `options.mesh` is missing, is not a `Geometry` (for a `GeometrySlice`, pass `slice.geometry`), belongs to a different `gpu`, or is already destroyed — create a live base mesh with the same `gpu`.
- `VGPU-INSTANCE-LAYOUT` when `options.mesh` already has an instance-step vertex buffer — use a vertex-only base mesh; the bridge appends the single instance stream.
- `VGPU-INSTANCE-LAYOUT` when a base attribute name equals `world0`–`world3` or one of your attribute names; the message names the attribute — rename it on the base mesh or in the collection schema so every shader input has one source.
- `VGPU-INSTANCE-LAYOUT` when the composed geometry needs more vertex buffers than `min(8, maxVertexBuffers)`, more vertex attributes than `maxVertexAttributes`, an instance stride above `min(2048, maxVertexBufferArrayStride)` bytes, or a buffer (`capacity × stride`, at least 4 bytes) above `maxBufferSize`; the message prints the actual and permitted numbers — drop base or custom attributes, narrow attribute formats, lower `capacity`, or split the population across several collections and bridges.
- `VGPU-INSTANCE-LAYOUT` when the CPU copy of the initial zero-filled buffer contents cannot be allocated; the message prints the byte count — lower `capacity` or the attribute width.
- A failure while creating the instance buffer or composing the geometry propagates unchanged. The bridge destroys only the buffer it just created; the base mesh stays usable.

## Examples

Publish once and draw once. The shader declares every vertex input the composed geometry provides, including `kind`, which it does not use, and the draw passes the count from `publish()`:

```wgsl
// crates.wgsl
struct CameraData { viewProjection: mat4x4f }
@group(0) @binding(0) var<uniform> camera: CameraData; // group and binding are your choice

struct VertexIn {
  @location(0) position: vec3f, // box() mesh
  @location(1) normal: vec3f,   // box() mesh
  @location(3) world0: vec4f,   // instance stream: world matrix columns
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) tint: vec3f,     // "tint": "float32x3"
  @location(8) kind: u32,       // "kind": "uint32" — unused, but must be declared
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) tint: vec3f,
}

@vertex fn vs_main(input: VertexIn) -> VertexOut {
  let world = mat4x4f(input.world0, input.world1, input.world2, input.world3);
  var out: VertexOut;
  out.clip = camera.viewProjection * world * vec4f(input.position, 1.0);
  out.normal = (world * vec4f(input.normal, 0.0)).xyz;
  out.tint = input.tint;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let light = max(dot(normalize(input.normal), normalize(vec3f(0.4, 1.0, 0.3))), 0.0);
  return vec4f(input.tint * (0.2 + 0.8 * light), 1.0);
}
```

```ts
import { draw, frame, geometry, init, surface } from "vgpu";
import { box, instances } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import crateShader from "./crates.wgsl";

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const viewProjection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); // from your camera

// ---cut---
const crates = instances({ capacity: 256, attributes: { tint: "float32x3", kind: "uint32" } });
const firstCrate = crates.add({ tint: [0.9, 0.5, 0.1], kind: 0 });
const secondCrate = crates.add({ tint: [0.2, 0.6, 0.9], kind: 1 });
crates.setWorld(firstCrate, [0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0, -0.5, 0, 0, 1]);
crates.setWorld(secondCrate, [0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0, 0.5, 0, 0, 1]);

const crateMesh = geometry(gpu, box()); // yours: the bridge borrows it
const crateBridge = instanceGeometry(gpu, crates, { mesh: crateMesh });
const crateDraw = draw(gpu, { shader: crateShader, geometry: crateBridge.geometry });

const crateCount = crateBridge.publish(); // uploads both records, returns 2
crateDraw.set({ camera: { viewProjection } });

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.08, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount }); // the count reaches the GPU only here
  });
});
```

`box()` pins `position` to `@location(0)` and `normal` to `@location(1)`; the instance inputs start at `@location(3)` so they also stay clear of `uv` at `@location(2)` on recipes that have one. The world columns and custom attributes match by name, so their locations are free as long as they do not collide.

Every frame follows the same order: update your state, write the worlds, compute the camera, publish, set uniforms, then encode every pass. `frameLoop(gpu)` submits when the callback returns:

```ts
import { clock, draw, frameLoop, geometry, init, surface, target } from "vgpu";
import { box, instances, type InstanceId } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import crateShader from "./crates.wgsl";

declare function stepSimulation(deltaTime: number, worldRows: Float32Array): void; // your physics or ECS
declare function writeViewProjection(out: Float32Array): void; // your camera

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const minimapTarget = target(gpu, { size: [256, 256] });
const crates = instances({ capacity: 1024, attributes: { tint: "float32x3", kind: "uint32" } });
const crateIds: InstanceId[] = [];
for (let index = 0; index < 64; index++) crateIds.push(crates.add({ tint: [0.8, 0.6, 0.3], kind: index % 3 }));
const worldRows = new Float32Array(crateIds.length * 16); // one 16-float world row per crate
const crateBridge = instanceGeometry(gpu, crates, { mesh: geometry(gpu, box()) });
const crateDraw = draw(gpu, { shader: crateShader, geometry: crateBridge.geometry });
const viewProjection = new Float32Array(16);
const frameClock = clock(gpu);

// ---cut---
const loop = frameLoop(gpu, (currentFrame) => {
  stepSimulation(frameClock.deltaTime, worldRows); // 1–2. app update, evaluate worlds
  crates.setWorlds(crateIds, worldRows);           // 3. copy worlds (or syncWorlds() for bindWorld sources)
  writeViewProjection(viewProjection);             // 4. camera matrices
  const crateCount = crateBridge.publish();        // 5. publish once per frame
  crateDraw.set({ camera: { viewProjection } });   // 6. named uniforms

  // 7. every pass that reads this bridge sees the same publication
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.08, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount });
  });
  currentFrame.pass({ target: minimapTarget, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(crateDraw, { instances: crateCount });
  });
}); // 8. submit when the callback returns

// call loop.stop() when your component unmounts
```

A render bundle records the count it was given. Record a new bundle when `publish()` returns a different count; changed row contents need no new bundle, because replay reads the same instance buffer. Record the next bundle first, swap it in, then dispose the old one, so a recording that throws leaves the previous bundle in place:

```ts
import { bundle, draw, frameLoop, geometry, init, surface, type Bundle } from "vgpu";
import { box, instances } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import crateShader from "./crates.wgsl";

declare function moveCrates(collection: typeof crates): void; // your per-frame world updates

const gpu = await init();
const canvasSurface = surface(gpu, document.querySelector("canvas")!);
const crates = instances({ capacity: 1024, attributes: { tint: "float32x3", kind: "uint32" } });
const crateBridge = instanceGeometry(gpu, crates, { mesh: geometry(gpu, box()) });
const crateDraw = draw(gpu, { shader: crateShader, geometry: crateBridge.geometry });
crateDraw.set({ camera: { viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } });

// ---cut---
let crateBundle: Bundle | undefined;
let recordedCount = -1;

function recordCrates(count: number): Bundle {
  return bundle(gpu, { target: canvasSurface, label: "crates" }, (recorder) => { // reads the surface's configuration, no canvas texture
    recorder.draw(crateDraw, { instances: count }); // the count is frozen into the bundle
  });
}

const loop = frameLoop(gpu, (currentFrame) => {
  moveCrates(crates); // adds, removes and moves change rows; adds and removes change the count
  const crateCount = crateBridge.publish();
  if (crateCount !== recordedCount) {
    const nextBundle = recordCrates(crateCount); // if this throws, crateBundle is untouched
    const previousBundle = crateBundle;
    crateBundle = nextBundle;
    recordedCount = crateCount;
    previousBundle?.dispose(); // release the old count's bundle now
  }
  currentFrame.pass({ target: canvasSurface, clear: [0.05, 0.05, 0.08, 1] }, (pass) => {
    pass.bundles(crateBundle!);
  });
});

function teardown(): void { // call it when your component unmounts
  loop.stop();
  crateBundle?.dispose(); // the draw, bridge and base mesh stay usable
  crateBridge.destroy();
}
```

Recording against `canvasSurface` reads only its configured render signature, so it does not depend on the frame's canvas texture, works inside or outside a frame, and keeps replaying when the canvas resizes. Dropping a replaced bundle also lets it be collected eventually; `dispose()` releases it at that point instead. Disposing a bundle never destroys `crateDraw`, the bridge or the base mesh.

## Notes

- **Instance layout.** One vertex buffer with `stepMode: "instance"`, `capacity × stride` bytes, allocated once and zero-filled. Each record is the collection's record: `world0`, `world1`, `world2`, `world3` as `float32x4` at byte offsets 0, 16, 32 and 48 (the column-major world matrix), then your attributes in declaration order at 4-byte alignment. The stride is `64 + 4 × (total custom components)`: `tint: "float32x3"` plus `kind: "uint32"` gives 80 bytes. There is no growth: to raise `capacity`, create a new collection and a new bridge.
- **Formats.** Custom attributes use the 12 `InstanceFormat` values: `float32`, `sint32` and `uint32` scalars and `x2`/`x3`/`x4` vectors, read in WGSL as `f32`/`vecNf`, `i32`/`vecNi` and `u32`/`vecNu`. There are no 8- or 16-bit or normalized formats.
- **The world matrix costs four attributes.** Each world column is its own vertex attribute, so the bridge adds `4 + (number of custom attributes)` to the base mesh's attribute count, and 64 bytes to every record. At the WebGPU default of 16 `maxVertexAttributes`, a `box()` base (2 attributes) leaves room for 10 custom attributes and a `sphere()` base (3 attributes) for 9. A custom attribute costs one vertex attribute whatever its width, so a `float32x4` is cheaper in attributes than four `float32`s.
- **Composed geometry.** `bridge.geometry` keeps every base attribute's name, format, offset and explicit location, and the base topology, index buffer, index format, index count and vertex count. Its `instanceCount` is `0`, and it adds no bindings: the instance data reaches your shader only as the vertex inputs you declare. There is no shader injection, no storage-buffer variant and no reserved bind group — `@group(0) @binding(0)` in the examples is the shader author's choice.
- **Declare every name-matched input.** Instance attributes carry no explicit location, so all of them — `world0..world3` and each custom attribute — are matched by name and must be declared in every shader drawn with `bridge.geometry`, including depth-only or picking shaders that ignore them; a missing one throws `VGPU-MESH-ATTRIBUTE-UNMATCHED` when the draw is created. The same applies to named base attributes without a location. Recipe attributes (`position` at 0, `normal` at 1, `uv` at 2) have explicit locations and may still be omitted, as with any geometry, but their locations stay taken: two inputs on one location throw `VGPU-MESH-LOCATION-CONFLICT`, an input the geometry does not provide throws `VGPU-MESH-INPUT-MISSING`, and a type that does not match the format throws `VGPU-MESH-FORMAT-MISMATCH`.
- **The shared shader input layout** for a `box()` bridge over `{ tint: "float32x3", kind: "uint32" }` is: `position: vec3f` and `normal: vec3f` from the base, then `world0: vec4f`, `world1: vec4f`, `world2: vec4f`, `world3: vec4f`, `tint: vec3f`, `kind: u32` from the instance stream. Declare the complete list in every shader that shares the bridge so all consumers read the same stream layout.
- **The draw count is explicit.** Pass the value from `publish()` as `instances` on every `pass.draw()`, `drawable.draw()` or `recorder.draw()`. `0` is valid and draws nothing. Omitting `instances` falls back to the composed geometry's `instanceCount` of `0`, so the draw silently renders nothing. vgpu does not compare a caller-supplied `instances` count with the collection's `count` or `capacity`. Pass exactly the value `publish()` returned: any other count can address inactive or out-of-capacity instance indices, and the result is not defined by vgpu.
- **Bundles capture the count.** A bundle freezes the `instances` value it was recorded with and the buffer it reads, not the row contents. Record a new one whenever the count from `publish()` changes — record next, swap, then `dispose()` the old bundle — and dispose the current one on teardown; rows published later are what replay reads.
- **Frame order.** `app update → evaluate/read worlds → syncWorlds or setWorlds → camera matrices → publish → named uniform set → encode all passes → submit`. `publish()` never calls bound sources, evaluates nodes or hierarchies, or touches the camera, so everything before it must already be in the collection.
- **One publication per frame per bridge.** `publish()` writes through the device queue, and a queue write lands before the next submit — before every pass of the frame being encoded, including passes encoded before the call. Do not publish a bridge again while passes that read it are still unsubmitted: the second write replaces what those passes read. Later frames are ordered by the queue, so publishing at the start of the next frame needs no wait for the GPU to go idle. If two passes in one frame need different instance contents, use separate bridges or separate collections — a second bridge mirrors the collection as of its own last `publish()`.
- **What `publish()` costs.** Each call scans slots `0..count-1` for changes since this bridge's last successful publication — O(`count`) even when nothing changed — then copies each contiguous run of changed records out of the collection and writes it to the buffer. The first `publish()` writes every active record; a `publish()` with no changes in between writes 0 bytes; a swap-remove writes the moved record; removing the last slot writes nothing and only lowers the returned count. A collection with `capacity: 0` still gets a minimal 4-byte buffer; its `publish()` returns `0` and writes nothing.
- **Independent mirrors.** Each bridge has its own buffer and its own change cursor. Two bridges over one collection — a detailed mesh and a low-poly proxy — each see every change, and publishing one never consumes the other's pending changes.
- **When `publish()` throws.** The bridge's cursor and returned count stay where they were, so nothing is lost: fix the cause and the next `publish()` writes every change still pending. Records written before the failure stay written and are written again. The write is not part of the frame's command buffer, so a frame that throws after `publish()` does not undo it; the uncaught error ends a `frameLoop(gpu)`.
- **When a world source throws.** `syncWorlds()` throwing `VGPU-INSTANCE-SOURCE` leaves some worlds at this frame's values and others at the previous frame's, and there is no rollback. `publish()` uploads whatever the records hold, so recover before you publish: let the error end the frame, fix or `unbindWorld` the failing source, call `syncWorlds()` again, then `publish()`. The same applies to any synchronous failure in your own update or world-writing code.
- **Ownership.** The bridge owns its instance buffer and the composed `bridge.geometry` wrapper; the base mesh stays yours. The bridge borrows the base's vertex buffers and index buffer, never destroys them, and sees later writes to them. Destroying the bridge leaves the base mesh usable.
- **Lifetimes.** `bridge.destroy()` and `bridge.geometry.destroy()` share one destroyed state, and both are idempotent. `gpu.dispose()` destroys the bridge too. Once the bridge, its geometry or the base mesh is destroyed, `publish()`, creating or encoding a draw with `bridge.geometry` (direct, indexed, indirect or zero-instance), recording it into a bundle, and replaying a bundle that contains it all throw `VGPU-INSTANCE-DESTROYED` — also for draws compiled before the destruction. Replaying a bundle you already disposed throws `VGPU-BUNDLE-DISPOSED` instead. Destroying the base mesh does not free the bridge's instance buffer; call `bridge.destroy()` to release it. vgpu detects destruction through `Geometry.destroy()` only; destroying a raw `GPUBuffer` behind vgpu's back is not detected.
- **Anti-pattern:** `pass.draw(crateDraw)` without `instances` renders nothing. Always pass `{ instances: crateCount }`, where `crateCount` is the value this frame's `publish()` returned.
- **Anti-pattern:** calling `publish()` between two passes of one frame to show each pass different rows. Both passes see the second publication; use two bridges.
- **See also:** `InstanceGeometry`, `instances`, `InstanceCollection`, `geometry`, `draw`, `bundle`, `frame`, `frameLoop`, `instanceWorldMatrix` and `transformNormal` from `@vgpu/wgsl-std/scene`, [Scene composition](/guides/scene-composition).

---

# InstanceGeometry

The bridge returned by `instanceGeometry()`: a composed `Geometry` to draw with, a `publish()` that uploads pending collection changes and returns the count to draw, and a `destroy()` that releases the instance buffer.

## Import

```ts
import type { InstanceGeometry } from "vgpu/scene/gpu";
```

## Signature

```ts
interface InstanceGeometry {
  readonly geometry: import("vgpu").Geometry;
  publish(): number;
  destroy(): void;
}
```

## Parameters

| Member | Type | Required | Default | Notes |
|---|---|---|---|---|
| geometry | `Geometry` | — | composed at creation | Read-only. The base mesh's streams and index buffer plus the instance stream; `instanceCount` is `0`. Pass it as `draw(gpu, { geometry })` and always draw with an explicit `instances`. Destroying it destroys the bridge. |
| publish() | — | — | — | Writes the collection's records changed since this bridge's last successful publication to the instance buffer, then returns the collection's current `count`. Never calls bound sources. Call it once per frame, after the worlds are written and before encoding passes. |
| destroy() | — | — | — | Destroys the instance buffer and the composed geometry. Idempotent. Does not destroy the base mesh. |

**Returns:** `publish()` returns the number of live instances to pass as `instances` — `0` when the collection is empty. `destroy()` returns `undefined`.

**Throws:**
- `VGPU-INSTANCE-DESTROYED` from `publish()` after `destroy()`, `geometry.destroy()`, `gpu.dispose()` or destruction of the base mesh; also from creating, encoding, recording or replaying a draw that uses `geometry` after any of those — create a new bridge from a live base mesh, then recreate the affected draws and re-record the affected bundles. Disposing an affected bundle does not throw; it only releases the bundle.
- `VGPU-INSTANCE-REENTRANT` from `publish()` when a bound world source calls it during `syncWorlds()` — keep sources read-only and publish after `syncWorlds()` returns. `syncWorlds()` rethrows this error unwrapped.
- Errors from writing the instance buffer propagate unchanged; the bridge's cursor does not advance, so the next `publish()` retries every pending change.
- Collection errors (`VGPU-INSTANCE-SOURCE`, `VGPU-INSTANCE-VALUE`, `VGPU-INSTANCE-CAPACITY` and the rest) come from the collection methods that caused them, never from `publish()`, and keep their original code, path and fix — see `InstanceCollection`.

## Examples

Tear down in any order; the base mesh outlives the bridge:

```ts
import { geometry, init } from "vgpu";
import { box, instances } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";

const gpu = await init();

// ---cut---
const crateMesh = geometry(gpu, box());
const crates = instances({ capacity: 64 });
const crateBridge = instanceGeometry(gpu, crates, { mesh: crateMesh });

crates.add();
console.log(crateBridge.publish()); // 1

crateBridge.destroy(); // frees the instance buffer; crateMesh is still usable
crateBridge.destroy(); // no-op
// crateBridge.publish() would now throw VGPU-INSTANCE-DESTROYED

const proxyBridge = instanceGeometry(gpu, crates, { mesh: crateMesh }); // a fresh bridge on the same mesh
console.log(proxyBridge.publish()); // 1 — a new bridge uploads every active record
```

A collection without custom attributes still needs `world0..world3` declared in the shader.

## Notes

- `publish()` is the only way data moves from the collection to the GPU. Mutating the collection after `publish()` changes nothing on the GPU until the next `publish()`.
- Keep the base mesh alive while the bridge is in use; destroying it invalidates the bridge without freeing the bridge's buffer.
- **See also:** `instanceGeometry`, `instances`, `InstanceCollection`, `Geometry`, `bundle`.
