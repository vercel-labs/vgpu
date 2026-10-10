# @vgpu/wgsl-std/scene

Pure WGSL transform helpers for instanced and scene-composed vertex shaders. Import them when a vertex shader receives a world matrix — as four per-instance columns from [`instanceGeometry()`](/reference/vgpu-scene-gpu/instance-geometry) or from your own data — and needs world-space positions, directions, and normals without declaring any resources.

## Import

```wgsl
import { instanceWorldMatrix, transformDirection, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
```

## Signature

```wgsl
export fn instanceWorldMatrix(world0: vec4f, world1: vec4f, world2: vec4f, world3: vec4f) -> mat4x4f;
export fn transformPosition(world: mat4x4f, position: vec3f) -> vec3f;
export fn transformDirection(world: mat4x4f, direction: vec3f) -> vec3f;
export fn transformNormal(world: mat4x4f, normal: vec3f) -> vec3f;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| world0 | `vec4f` | ✔ | — | Column 0 of the world matrix for `instanceWorldMatrix` (matrix elements 0–3, the transformed X axis). `instanceGeometry()` supplies it as the `world0` instance attribute. |
| world1 | `vec4f` | ✔ | — | Column 1 (elements 4–7, the transformed Y axis). Supplied as the `world1` instance attribute. |
| world2 | `vec4f` | ✔ | — | Column 2 (elements 8–11, the transformed Z axis). Supplied as the `world2` instance attribute. |
| world3 | `vec4f` | ✔ | — | Column 3 (elements 12–15): translation in `xyz`, `1.0` in `w` for an affine matrix. Supplied as the `world3` instance attribute. |
| world | `mat4x4f` | ✔ | — | Column-major world matrix for `transformPosition`, `transformDirection`, and `transformNormal`. Only finite affine matrices (bottom row `0, 0, 0, 1`) have defined results. |
| position | `vec3f` | ✔ | — | Local-space point for `transformPosition`. Transformed with `w = 1.0`, so translation applies. |
| direction | `vec3f` | ✔ | — | Local-space direction for `transformDirection`, for example a tangent. Transformed with `w = 0.0`, so translation is ignored. Any length, including zero. |
| normal | `vec3f` | ✔ | — | Local-space surface normal for `transformNormal`. Any nonzero length; the result is normalized. A zero vector returns `vec3f(0.0)`. |

**Returns:**

### instanceWorldMatrix

Returns `mat4x4f(world0, world1, world2, world3)` — the four arguments become the matrix columns, in order.

### transformPosition

Returns `(world * vec4f(position, 1.0)).xyz`, the world-space point.

### transformDirection

Returns `(world * vec4f(direction, 0.0)).xyz`, the world-space direction. It is **not** normalized: scale and shear in `world` change its length.

### transformNormal

Returns the normalized inverse-transpose of the upper-left 3×3 linear part of `world` applied to `normal`, with the determinant sign preserved. For well-conditioned finite inputs, a nonzero `normal` and a nonsingular linear part produce a unit-length `vec3f`. An exact-zero guard returns `vec3f(0.0)` when the supplied `f32` arithmetic detects a zero normal, zero linear magnitude, zero computed determinant, or zero cofactor result.

**Throws:** These WGSL declarations do not throw and raise no `VGPU-*` errors at runtime. `resolveShader()` or the WGSL loader can still throw `VGPU-WGSL-SYM-NOEXPORT` for misspelled imports, `VGPU-WGSL-PKG-NOTFOUND` if the package import cannot be resolved, or validation errors such as `VGPU-WGSL-NAGA-UNKNOWN` if caller WGSL is invalid.

## Examples

Transform a point, a tangent, and a normal by a world matrix you already have:

```ts
const transformWgsl = `
import { transformDirection, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";

struct WorldVertex {
  position: vec3f,
  tangent: vec3f,
  normal: vec3f,
}

fn toWorld(world: mat4x4f, position: vec3f, tangent: vec3f, normal: vec3f) -> WorldVertex {
  return WorldVertex(
    transformPosition(world, position),
    normalize(transformDirection(world, tangent)), // normalize yourself when you need unit length
    transformNormal(world, normal), // already unit length, or vec3f(0.0)
  );
}
`;

console.log(transformWgsl.includes("toWorld"));
```

### Instanced vertex shader with an explicit camera uniform

A complete vertex input for a mesh drawn through `instanceGeometry()`. The base mesh contributes `position`, `normal`, and `uv`; the bridge contributes the four world columns `world0`–`world3` plus each custom attribute declared on the collection — here a `tint` attribute declared as `"float32x4"`. Declare every attribute the geometry provides, even ones the shader does not use. vgpu matches named attributes to vertex inputs by name; attributes that carry an explicit location — the primitive recipes such as `sphere()` pin `position`, `normal`, and `uv` to `@location(0)`, `@location(1)`, and `@location(2)` — must keep that location. The world columns and custom attributes can use any other unique locations.

```wgsl
// instanced-scene.wgsl
import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";

struct CameraData {
  viewProjection: mat4x4f,
}

// Owned by this entry shader: you choose the group and binding, vgpu reflects the name `camera`.
@group(1) @binding(0) var<uniform> camera: CameraData;

struct VertexInput {
  @location(0) position: vec3f, // base mesh
  @location(1) normal: vec3f, // base mesh
  @location(2) uv: vec2f, // base mesh, declared even though only passed through
  @location(3) world0: vec4f, // instance world column 0
  @location(4) world1: vec4f, // instance world column 1
  @location(5) world2: vec4f, // instance world column 2
  @location(6) world3: vec4f, // instance world column 3 (translation)
  @location(7) tint: vec4f, // custom instance attribute
}

struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) worldNormal: vec3f,
  @location(1) uv: vec2f,
  @location(2) tint: vec4f,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  var out: VertexOutput;
  out.clip = camera.viewProjection * vec4f(transformPosition(world, input.position), 1.0);
  out.worldNormal = transformNormal(world, input.normal);
  out.uv = input.uv;
  out.tint = input.tint;
  return out;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return input.tint; // shading is yours: re-normalize input.worldNormal and light it as you like
}
```

Connect the camera by binding name from TypeScript. Pass the full binding object — `{ camera: { viewProjection } }` — so the value maps to the `camera` binding and its `viewProjection` member without a group or binding index in TypeScript:

```ts
import { draw, frame, geometry, init, target } from "vgpu";
import { instances, orbitRig, perspective, rigPose, sphere, viewMatrices } from "vgpu/scene";
import { instanceGeometry } from "vgpu/scene/gpu";
import sceneShader from "./instanced-scene.wgsl";

const gpu = await init();
const sceneTarget = target(gpu, { size: [640, 360], depth: true });
const objects = instances({ capacity: 1, attributes: { tint: "float32x4" } });
objects.add({ tint: [0.8, 0.4, 0.2, 1] });
const bridge = instanceGeometry(gpu, objects, { mesh: geometry(gpu, sphere()) });
const projection = perspective({ fov: 45, near: 0.1, far: 100 }, 640 / 360, new Float32Array(16));
const pose = rigPose(orbitRig({ distance: 4 }), { position: new Float32Array(3), quaternion: new Float32Array(4) });
const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
viewMatrices(pose, projection, matrices);

// ---cut---
const instancedScene = draw(gpu, { shader: sceneShader, geometry: bridge.geometry });

frame(gpu, (currentFrame) => {
  const count = bridge.publish(); // upload changed instance rows before encoding any pass
  instancedScene.set({ camera: { viewProjection: matrices.viewProjection } });
  currentFrame.pass({ target: sceneTarget, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(instancedScene, { instances: count });
  });
});
```

`set()` validates and packs `matrices.viewProjection` when you call it — it keeps no reference to your `Float32Array`. After you mutate the matrix (for example by calling `viewMatrices()` again), call `set()` again; the draw keeps using the values from the last `set()` call. The instance world matrix needs no bind group at all: it arrives through vertex locations.

## Notes

- This module is pure WGSL: it declares no `@group`, no `@binding`, no overrides, no hidden state, no resources, and no entry points. Camera data, textures, and every other resource stay in your entry shader; the resolver rejects bindings in imported modules anyway.
- **Column-major.** The world matrix uses vgpu's column-major convention: CPU `Mat4` index `4 * column + row`, translation at indices 12, 13, 14. `instanceWorldMatrix` takes columns, not rows — passing rows produces the transposed matrix.
- **Normals.** `transformNormal` returns the normalized inverse-transpose of the 3×3 linear part applied to `normal`, so normals stay perpendicular to transformed surfaces under rotation, nonuniform scale, shear, and reflections. The result depends only on the direction of `normal`, not its length. Translation never affects it.
- **Reflected (negative-determinant) transforms** keep normal orientation: the determinant sign is preserved, so an outward normal stays outward on the mirrored surface. The helper only transforms normals; triangle winding and face culling are not affected by it.
- **Exact-zero fallback.** `transformNormal` returns exactly `vec3f(0.0)` when `normal` is the zero vector or when its guarded `f32` calculations produce a zero linear magnitude, determinant, or cofactor result. There is no epsilon or rank tolerance. A matrix intended to be singular before conversion to `f32` can become full-rank after rounding, so the helper cannot recover that pre-rounded intent and can return a direction instead of the fallback. Use a stable exact singular representation, such as a zero column, when the fallback is required; test for zero length if your shading needs a fallback direction.
- **Finite-precision limits.** Scaling the inputs before determinant and normalization calculations reduces avoidable overflow and underflow, but it does not make ill-conditioned normal transforms exact. Near-singular matrices and extreme axis ratios can amplify `f32` rounding, change the computed determinant sign or direction, or encounter backend-dependent subnormal flushing. Do not rely on exact symbolic rank detection or a unit result for those extreme cases. Well-conditioned finite affine transforms, including shear, reflection, nonuniform scale, and small uniform scale, preserve the behavior described above.
- **Finite affine input only.** Results are defined for finite matrices with bottom row `0, 0, 0, 1`. `NaN`, infinities, and projective matrices have no promised behavior. `transformPosition` drops `w` without a perspective divide — do not pass a view-projection matrix to it; multiply `camera.viewProjection * vec4f(worldPosition, 1.0)` for clip space as the example does.
- **Extra deformation needs the complete transform.** The helpers only see the matrix you pass. If your shader also scales, stretches, or displaces vertices — a per-instance stretch attribute, wind sway, a morph target — build the complete matrix (for example `world * shape`) and pass it to both `transformPosition` and `transformNormal`, or compute an adjusted normal yourself. The helpers cannot infer displacement applied elsewhere in the shader, and a normal transformed by `world` alone is wrong for the deformed surface.
- **No material, lighting, or color behavior.** The helpers return geometry only. There is no PBR model, light model, default material, or color-space assumption; shade `worldNormal` with your own fragment code, for example `lambert` from `@vgpu/wgsl-std/light`.
- **See also:** [`instanceGeometry()`](/reference/vgpu-scene-gpu/instance-geometry), the [Scene composition guide](/guides/scene-composition), [`Draw.set()`](/reference/vgpu/draw#draw), [WGSL modules](/concepts/wgsl-modules), `resolveShader`.
