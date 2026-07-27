# Plan: scene tree + renderer for `vgpu/scene`

Status: draft for API validation (snippet-first). Companion topic (PBR materials + glTF) is
sketched at the end but tracked separately.

## Motivation

`vgpu/scene` today is a helpers library: pure geometry descriptors (`box()`, `sphere()`, …),
frozen camera snapshots (`perspectiveCamera()` → `{ viewProjection, position }`), and a lone
`orbit(time)` model-matrix helper. There is no scene graph, no materials, no renderer.

The cost of that gap is visible in the repo itself:

- `apps/docs/examples/fft-ocean/camera.ts` hand-rolls `lookAt`/`perspective`/mat4 multiply.
- `apps/docs/examples/raymarched-fractal` and `black-hole` each carry their own
  `installOrbitInput` / `installDragOrbit` pointer-orbit implementation (three copies, two shapes).
- `packages/vgpu-api/tests/scene/primitives/primitive-camera.ts` wraps cameras a fourth way.
- Frozen cameras cannot be resized or animated in place, so every consumer rebuilds them
  per frame — the opposite of vgpu's stable-identity model.

Goal: one retained scene tree (groups/meshes/cameras/lights), a small material contract that
user WGSL can plug into, and a renderer that maps the tree onto vgpu's existing primitives
(`gpu.draw`, `gpu.uniforms`, `UniformPool`, bundles) so the perf playbook applies by default.

## Design principles

- **Pure tree, explicit GPU binding.** Nodes/cameras/materials are plain JS state with no GPU
  resources, mirroring how `SceneGeometry` is pure until `gpu.geometry()`. GPU work happens only
  when a tree is bound via `gpu.scene(root, opts)`.
- **Stable identities.** World matrices, camera matrices, and light blocks live in stable
  `Float32Array`s updated in place, so bind groups and bundles stay valid across frames.
- **`set()`-based mutation.** Nodes follow the library-wide `set()` ownership convention;
  returned vectors/matrices are read-only views. Dirty flags propagate down the tree.
- **Nothing implicit — but batteries included.** No global scene, no default camera. The
  renderer may own *derived* resources (depth texture matched to the target, uniform pools),
  which is bookkeeping, not hidden semantics.
- **Local runtime math.** `geometry-src/camera-math.ts` deliberately avoids loading the
  `wgpu-matrix` runtime to protect the `vgpu/scene` bundle budget; the tree follows the same
  policy with a minimal local mat4/quat module (`scene/tree/math.ts`). `wgpu-matrix` stays a
  type-only dependency.

## Proposed API

### 1. Nodes and the tree

```ts
import { init } from "vgpu";
import {
  scene, group, mesh, box, sphere, plane,
  unlitMaterial, lambertMaterial, directionalLight,
  perspectiveCamera, orbitControls, srgb,
} from "vgpu/scene";

const gpu = await init();
const surface = gpu.surface(canvas, { dpr: [1, 2] });

// Pure tree — no GPU resources yet.
const root = scene();

const ground = mesh(plane({ size: 10 }), unlitMaterial({ color: srgb("#1e1e28") }));
const ball = mesh(sphere({ radius: 0.5 }), lambertMaterial({ color: srgb("#3b82f6") }));
ball.set({ position: [0, 0.5, 0] });

const spinner = group({ children: [ball] });
root.add(ground, spinner);

const sun = directionalLight({ direction: [-1, -2, -1], intensity: 1.2 });
root.add(sun);

// Stateful camera node: matrices are stable Float32Arrays updated in place.
const camera = perspectiveCamera({ fov: 45, position: [2, 2, 3], target: [0, 0, 0] });

// GPU binding: compiles materials, caches draws, owns a depth texture for the target.
const view = gpu.scene(root, { target: surface, clear: [0.02, 0.02, 0.04, 1] });

const controls = orbitControls(camera, { element: canvas, damping: 0.1 });

gpu.frame.loop(() => {
  controls.update(gpu.deltaTime);
  spinner.set({ rotation: [0, gpu.time, 0] });
  view.render(camera);
});
```

Node contract (shared by `group`, `mesh`, cameras, lights):

```ts
interface SceneNode {
  set(values: {
    position?: Vec3Like;
    rotation?: Vec3Like;          // Euler radians, XYZ order
    quaternion?: QuatLike;        // wins over rotation when both given
    scale?: number | Vec3Like;
    visible?: boolean;
  }): this;
  lookAt(target: Vec3Like): this;
  add(...children: SceneNode[]): this;
  remove(...children: SceneNode[]): this;
  readonly position: ReadonlyFloat32Array;   // read-only views; mutate via set()
  readonly worldMatrix: ReadonlyFloat32Array; // stable identity, lazily recomputed
  readonly parent: SceneNode | null;
  readonly children: readonly SceneNode[];
  traverse(cb: (node: SceneNode) => void): void;
  label?: string;
}
```

Rationale for `set()` over three.js-style mutable `position.x = …`: it matches `draw.set()` /
`uniforms.set()` ownership semantics, makes dirty tracking exact (no per-frame full-tree
matrix recompute), and keeps returned arrays safe to hand to bindings.

### 2. Cameras (rework of the existing frozen snapshots)

`perspectiveCamera()` / `orthographicCamera()` keep their names and options but become
**stateful nodes**. `viewProjection` remains a `Float32Array` property, so the s06 example
usage (`cam.viewProjection` passed to `set()`) still works — it just also stays fresh.

```ts
const cam = perspectiveCamera({ fov: 45, near: 0.1, far: 100 });
cam.set({ position: [0, 2, 5] });
cam.lookAt([0, 0, 0]);
cam.set({ fov: 60 });                    // projection params via the same set()

cam.viewProjection;                      // stable Float32Array(16), updated in place
cam.view; cam.projection; cam.worldPosition;
```

Aspect: when a camera with no explicit `aspect` is rendered through a view, the view applies
the target's aspect (and tracks resize). Passing `aspect` opts out. This is the single most
duplicated fix-up in current examples.

Breaking-change note (0.1.x): the frozen-snapshot behavior goes away; consumers that relied on
immutability get the same field names with live values. `orbit(time)` stays as-is (it is a
model-matrix animation helper, unrelated to camera controls); its docs will point to
`orbitControls` for interaction.

### 3. Controls

One shared implementation to replace the three per-example copies:

```ts
const controls = orbitControls(camera, {
  element: canvas,
  target: [0, 0.5, 0],
  damping: 0.1,                 // 0 disables easing
  distance: { min: 1, max: 20 },
  pitch: { min: -1.2, max: 1.2 },
});
gpu.frame.loop(() => {
  controls.update(gpu.deltaTime);   // explicit update, no hidden rAF
  view.render(camera);
});
controls.dispose();                  // removes DOM listeners
```

DOM-touching, browser-only; ships from `vgpu/scene` but is tree-shakeable and inert in Node.

### 4. Materials (phase-1 contract; PBR builds on this)

A material = a WGSL fragment stage + params, compiled per (target signature) by the view.
The renderer owns the vertex stage by default and reserves `@group(0)` for scene globals
(camera, model, lights). Material params live in `@group(1)`+.

Built-ins for phase 1: `unlitMaterial({ color, map? })`, `normalMaterial()`,
`lambertMaterial({ color })` (uses the existing `@vgpu/wgsl-std/light` `lambert()`).

Custom materials — the escape hatch users will extend into PBR:

```ts
import { shaderMaterial } from "vgpu/scene";

const glow = shaderMaterial(/* wgsl */ `
  import { SceneVarying } from "@vgpu/wgsl-std/scene";

  struct Params { color: vec3f, intensity: f32 }
  @group(1) @binding(0) var<uniform> params: Params;

  @fragment fn fs_main(in: SceneVarying) -> @location(0) vec4f {
    let fresnel = pow(1.0 - max(dot(normalize(in.normal), in.viewDir), 0.0), 3.0);
    return vec4f(params.color * params.intensity * fresnel, 1.0);
  }
`, { set: { params: { color: [0.2, 0.5, 1.0], intensity: 2 } } });

glow.set({ params: { intensity: 4 } });   // same values-first set() as Draw/Effect
```

New `@vgpu/wgsl-std/scene` module (pure — struct/const/fn exports only, per resolver rules):

- `SceneVarying` — `{ position (clip), worldPosition, normal, uv, viewDir }`.
- The default vertex stage that produces it (standard locations: position=0, normal=1, uv=2 —
  already pinned by `scene/mesh.ts`).

`shaderMaterial` options for later phases: `vertex` (custom vertex stage / displacement),
`blend` ("alpha" | "additive" | …, same enum as `DrawOptions`), `cull`, `depthWrite`.

### 5. The view (renderer)

```ts
const view = gpu.scene(root, {
  target: surface,               // Target | Surface
  clear: [0, 0, 0, 1],           // or false to load
});

view.render(camera);             // one frame, one pass (the 90% case)

// Composition with existing frames (post-processing):
gpu.frame((f) => {
  view.render(camera, { frame: f });          // appends its pass instead of submitting
  f.pass({ target: surface }, (p) => p.draw(post));
});

view.bake();                     // records a render bundle while the draw list is static
view.stats;                      // { draws, nodes, pipelines } for perf docs/tests
view.dispose();                  // frees pools/depth texture; tree remains usable
```

How it maps to the perf playbook (this is the point of doing it in-library):

- **Draw cache** keyed by (mesh identity × material shader identity × target signature);
  adding N spheres with one material = 1 pipeline, N dynamic-offset draws.
- **Group 0 claimed by the renderer**: one `gpu.uniforms()` block for camera + lights shared
  across all draws; per-node model matrices in a `UniformPool` bound with dynamic offsets
  (`p.draw(draw, { offsets })` — already supported).
- **Bundle-friendly**: transform/material-param updates are in-place buffer writes; bundles
  recorded by `view.bake()` stay valid until the draw list or a resource identity changes
  (then the view re-records and reports, mirroring `VGPU-R3-BUNDLE-STALE` semantics).
- **Depth**: if the target lacks depth, the view creates and resizes a matching depth texture
  (documented, since targets normally own depth config).
- Sorting/culling: phase 1 renders opaque in insertion order; transparent (blend != none)
  drawn last back-to-front. Frustum culling and opaque front-to-back sorting are phase 3,
  behind flags with `view.stats` to prove wins.

## Naming decisions (settled in 0.2.0)

1. **`mesh(geometry, material)` factory vs the old `Mesh` class — settled by renaming the
   resource.** `Mesh` now means the renderable scene-tree node (three.js acception); the
   low-level GPU buffer resource was renamed to `Geometry`. The whole family moved in one
   clean break — no deprecated aliases: `Mesh` → `Geometry`, `MeshOptions` →
   `GeometryOptions`, `MeshBuffer(Options)` → `GeometryBuffer(Options)`, `MeshSlice(Options)`
   → `GeometrySlice(Options)`, `MeshAttributes`/`MeshAttributeOverride`/`MeshData` →
   `Geometry*`, `MeshLike` → `GeometryLike`, `gpu.mesh()` → `gpu.geometry()`,
   `DrawOptions.mesh` → `DrawOptions.geometry`, and the `SceneMesh` alias was deleted
   (`vgpu/scene` re-exports the `Geometry` type instead). `SceneGeometry` (the pure CPU
   recipe) keeps its name; the `VGPU-MESH-*` error codes keep theirs (scope-bound), while
   their messages teach the new names. Breaking at 0.2.0.
2. **`gpu.scene(root, opts)`** as the binding point (vs a standalone `renderer(gpu, …)`);
   follows the `gpu.*` factory convention and the existing `gpu.geometry(sceneGeometry)`
   bridge.
3. **Auto-aspect** from target unless `aspect` is explicit.

## Phases

1. **Tree + transforms + cameras + controls** — nodes, dirty propagation, wgpu-matrix runtime
   adoption, stateful cameras, `orbitControls`. Pure JS, fully unit-testable in mock.
2. **Materials + view** — `@vgpu/wgsl-std/scene`, built-in materials, `shaderMaterial`
   contract, `gpu.scene()` with draw cache + shared globals + lights (directional + ambient).
   GPU acceptance test: lit multi-object scene snapshot (extend `tests/gpu/scene.test.ts`).
3. **Perf layer** — UniformPool dynamic offsets, `view.bake()`, transparent sorting,
   `instancedMesh(geometry, material, { count })`.
4. **Topic 2: PBR + glTF** (separate plan) — `@vgpu/wgsl-std/pbr` (BRDF, normal mapping,
   tonemap reuse from `/color`), `standardMaterial({ baseColor, metalness, roughness, maps })`,
   texture/sampler support in the material contract, then `loadGltf(url)` returning a pure
   subtree with standard materials, so `.glb` files drop into any scene:

   ```ts
   import { loadGltf } from "vgpu/scene";
   const helmet = await loadGltf("/damaged-helmet.glb");
   root.add(helmet.scene);
   ```

   Custom materials stay first-class: users override a mesh's material while keeping the
   loaded geometry, or import `@vgpu/wgsl-std/pbr` pieces into their own `shaderMaterial`.
