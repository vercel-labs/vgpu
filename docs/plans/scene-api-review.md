# Scene API review: WebGPU coverage + engine comparison (phase 1)

Status: review round over the phase-1 scene tree (`docs/plans/scene-tree-render.md`), run
before starting phase 2. Produced by a multi-agent pipeline: three code reviewers (WebGPU
feature coverage, correctness, ergonomics), five engine comparisons (three.js, Babylon.js,
Unity, Unreal, and PlayCanvas/Bevy/rend3 as WebGPU-native references), and an adversarial
verification pass that reproduced every confirmed bug against the real sources.

The two questions asked: **does the API hide WebGPU features?** and **how does it compare to
mature engines?** Short answers: the layering is right and several house choices are
genuinely ahead of the compared engines, but the material contract is missing rasterizer
state that phase 2 cannot ship without (depth-write/cull), the geometry contract is closed
in a way phase 4 (glTF) cannot be built on, and six real bugs were confirmed in phase-1 code.

## 1. Confirmed bugs (reproduced by verifiers)

Fix before or during phase 2 — none require design changes:

1. **OrbitControls is wrong for parented cameras** (`orbit-controls.ts`): `update()` writes
   `position` in parent-local space but `lookAt()` interprets the target in world space, and
   the constructor derives the initial pose from a local position. A camera inside a
   translated rig orbits the wrong center with a wrong distance. Fix: run the whole
   computation in one space (transform the world target into parent space via
   `invertAffineMat4(parent.worldMatrix)`), or assert `node.parent === null`.
2. **One NaN `deltaTime` poisons OrbitControls forever**: `Math.max(NaN, 0)` is NaN, the
   easing writes NaN into yaw/pitch/distance, and the snap rescue never fires
   (`NaN < EPSILON` is false). Classic first-frame `performance.now()` bug shape. Fix:
   `if (!Number.isFinite(deltaTime)) deltaTime = 1/60`, plus finite checks in `set()`.
3. **Constructors validate after `super()` has reparented children**: `perspectiveCamera({
   fov: 0, children: [child] })` throws — but `child` has already been detached from its old
   parent and stranded on the dead camera. Same in OrthographicCamera and both lights. Fix:
   validate raw options before `super()`.
4. **`lookAt` is wrong under a non-uniform-scaled parent**: parent compensation extracts
   rotation only (scale-stripped), skewing the forward vector 30°+ in the repro. Fix: do
   lookAt in parent space using the existing affine inverse (handles non-uniform scale
   exactly).
5. **Material validation errors read `undefined.set`**: `this.kind` is a subclass field not
   yet initialized when ColorMaterial's constructor validates. Fix: pass kind into the base
   constructor (SceneNode already does this correctly).
6. **`aspect` is the only unvalidated camera parameter**: `set({ aspect: 0 })` (a real input
   from `canvas.width/height` during layout) produces an Infinity matrix silently; ortho
   accepts `left === right`. Fix: same `sceneValueError` pattern as fov/near/far.

Unverified low-severity findings worth batching in: NaN/Infinity accepted in node transform
setters; pointer-up ignores `pointerId`/button (second pointer cancels an active drag); one
huge wheel delta with unbounded max distance drives distance to Infinity.

## 2. WebGPU features the API currently hides

The audit diffed the scene surface (and the planned SceneView contract) against
`DrawOptions`/`TargetOptions`/`gpu.geometry` and native WebGPU. Grouped by decision:

### Blocks phase 2's own plan (must land in phase 2)

- **Depth write / depth compare** — `draw.ts` hardcodes `depthStencil: { depthWriteEnabled:
  true, depthCompare: "less" }`; neither DrawOptions nor materials can change it. The planned
  back-to-front transparent pass will self-occlude with depth writes on. Also precluded:
  skyboxes (`less-equal`, no write), overlays (`always`), depth-prepass (`equal`),
  reversed-Z. → Add `depthWrite`/`depthCompare` to DrawOptions (pipeline-keyed), surface on
  all materials; renderer defaults `depthWrite: blend === undefined`. *(Flagged independently
  by all five engine comparisons.)*
- **Cull mode / winding** — never set anywhere; everything renders double-sided (~2× fragment
  cost on closed meshes) and inside-out rendering is impossible. glTF requires honoring
  `doubleSided`. → `cull`/`frontFace` on DrawOptions; on materials a three-familiar
  `side: "front" | "back" | "double"` on **all** materials (not just shaderMaterial as the
  plan sketched), default `"front"`. *(Flagged by all five comparisons — "a `plane()` ground
  viewed from below disappears" will be the first issue filed.)*
- **Geometry contract is a closed union** — `mesh()` only takes `SceneGeometry` (15
  primitives, position/normal/uv pinned). Custom vertex data, vertex colors, tangents
  (needed by phase-4 PBR normal mapping), skinning weights, morph targets, non-triangle
  topologies, index formats, and geometry slices (glTF multi-primitive) are unreachable —
  **loadGltf cannot be built on this contract**. → Widen to
  `mesh(geometry: SceneGeometry | Geometry | GeometrySlice, …)` accepting `gpu.geometry()`
  objects directly (0.2.0 names); renderer keys pipelines on the geometry's own
  layouts/topology. Reserved locations
  0–2 stay pinned; custom attributes start at `@location(3)` and reach shaderMaterial vertex
  stages by name.
- **Custom materials can't reach scene lights** — since `@group(0)` is renderer-owned,
  `@vgpu/wgsl-std/scene` must export the lights struct + eval helpers, or every lit
  shaderMaterial recreates the layout.

### Design the contract now, implement later (phase 3)

- **Instancing** — lower layers have full support (instance streams, `firstInstance`); the
  tree has none and the planned `instancedMesh` only mentions a count. Spec it thin-instance
  style: node-owned flat `Float32Array` of transforms with in-place `set()` (bundle-safe),
  live `count`, optional extra instance streams. *(High in three of five comparisons.)*
- **Render order** — insertion order only; skybox/decal/UI patterns need a numeric
  `renderOrder` escape hatch designed with the transparent sorter.
- **Layers/visibility masks** — `layers?: number` bitmask on nodes + camera/view mask for
  per-camera filtering; part of the bake key.
- **Bounding volumes** — closed-form bounds on SceneGeometry descriptors; prerequisite for
  frustum culling, picking, and `camera.fit(node)` (disproportionately valuable for agents).
- **Viewport/scissor** — absent from FramePass entirely; blocks split-screen. Pass-level
  first, then `view.render(camera, { viewport })`.
- **Alpha-test/masked mode** — `blend: "masked"` + `alphaTest` threshold: sorts opaque,
  keeps depth write, stays bundle-valid, required by glTF `alphaMode: MASK`.
- **Depth bias** — decals/shadow acne have no fix today; fold into the DrawOptions depth
  extension.

### Documented non-goals (for now)

- Full `BlendOptions` on materials (escape hatch: shaderMaterial could accept the existing
  DrawOptions blend object), camera projection-matrix override / TAA jitter (design
  `projectionOffset` slot when post-processing lands), MRT material outputs, stencil state
  (dead-end even at draw layer — document), alpha-to-coverage, occlusion queries,
  blend-constant factors (warn until supported).

## 3. Cross-engine consensus

Items flagged high/medium by **4–5 of 5** engines — the strongest signal in the review:

| Item | Consensus recommendation |
| --- | --- |
| Material `side` + `depthWrite` | Phase 2, all materials (see §2). |
| Transparency semantics | Define `opacity < 1` with no blend (recommend: implies transparent queue) — never silently ignore. |
| DirectionalLight dual source of truth | Its transform (position/rotation/lookAt) type-checks and does nothing. Either derive direction from world -Z (three-compatible, recommended) or reject transform keys with a coded error. Decide before the light ABI freezes. |
| Light block ABI | Design `@group(0)` lights as a count-prefixed fixed-capacity array (type tag + params) NOW so point/spot lights later don't break every compiled shaderMaterial. |
| `node.find(label)` / `findAll(predicate)` | Trivial over traverse+label; mandatory by phase 4 (glTF subtrees are useless without name lookup); disproportionately valuable for agents. |
| `visible` inheritance semantics | Undefined today. Spec: `visible: false` skips the subtree (three/Babylon/Unity all converged here); state whether it applies to lights. |
| Texture `map` on unlit/lambert | Phase 2, not 4 — the plan text already says `map?` but material.ts lacks it; texture plumbing should land with the renderer. |
| Pipeline cache keyed by shader source, not material identity | Two `shaderMaterial(sameSource)` calls must share one pipeline (Unreal's material-instance lesson); built-in material params should ride the UniformPool dynamic offsets. |
| OrbitControls pan + pinch zoom | Without pinch, zoom doesn't exist on mobile. Phase 2/3. |
| Intensity units + shadow option-bag space | Zero-code docs decisions that are expensive to retrofit (three r155). Reserve `directionalLight({ shadow? })` shape; shadows themselves post-phase-4. |

## 4. Ergonomics findings (own-codebase reviewer)

- **Writable Float32Arrays make stale-transform bugs silent** (high): `node.position[0] = 5`
  works and never dirties. Type getters as readonly views (compile-time, zero runtime cost);
  the plan promised read-only views.
- **`kind` doesn't narrow** (high): subclasses never redeclare literal kinds, so the
  documented `node.kind === "mesh"` filter can't reach `.geometry` without casts. Give
  subclasses `declare readonly kind: "mesh"` etc. + export union aliases and
  `SceneNodeOfKind<K>`, mirroring `SceneGeometryOfKind`.
- **`SceneCamera` can't support auto-aspect** (medium): `aspect` getter erases the unset
  state and the interface exposes no `set()`. Expose `aspect(): number | undefined` (or
  `explicitAspect`) and decide `render()`'s parameter type now.
- **`set()` silently ignores unknown keys** (medium): diverges from draw.set strictness; a
  `VGPU-SCENE-KEY-UNKNOWN` error listing accepted keys is what makes mistakes
  LLM-recoverable.
- **OrbitControls options/values shape clash** (medium): `distance`/`pitch` mean limits in
  Options but scalars in Values. Rename limits (`minDistance`/`maxDistance`…) and let
  Options extend Values.
- **`SceneMaterial.blend` is a bare mutable field** (medium/high in comparisons): pipeline
  state mutable outside `set()` with undefined re-key semantics. Make it constructor-only.
- **`CameraVec3` vs `Vec3Like`** (medium): plain `number[]` works in `lookAt()` but not the
  camera `target` option. Unify on `Vec3Like`.
- Low: validate NaN in transforms; `instanceof SceneNode` guard in `add()`; `normalMaterial()`
  options bag for uniformity; consider renaming `orbit()` (turntable matrix) now that
  `orbitControls` exists.

## 5. Naming notes for migrating muscle memory

Divergences to document prominently (or reconsider) — each flagged by the relevant engine
reviewer: `node.rotation` is write-only (no readable Euler; three/Babylon users will read
`undefined`); `lookAt` aims **-Z for all nodes** (three aims +Z for non-cameras; Unity +Z;
Unreal +X — one JSDoc sentence saves hours); mixed angle units (rotation radians, fov
degrees) need saying everywhere fov appears; `damping` is a time constant in seconds, not
three's per-frame factor; `DirectionalLight.direction` is the travel direction (opposite of
three's position→target mental model); `add()` keeps local transform (Unity/Unreal keep
world — consider `attach()`/`{ keepWorld: true }` later); camera option `target` is a
one-shot lookAt, not a retained tracked target (consider renaming to `lookAt:`); handedness
and winding conventions should be stated once, explicitly.

## 6. What the review validated (keep these)

Every comparison independently endorsed: set()-based mutation with exact dirty flags + lazy
worldMatrix (avoids three's updateMatrixWorld tax and matrixAutoUpdate footguns, Bevy's
one-frame-stale GlobalTransform, Babylon's evaluateActiveMeshes cost); quaternion-canonical
rotation with Euler as write-only input (avoids three/Babylon dual-state sync bugs, Unreal's
FRotator gimbal pain); pure descriptors + explicit `gpu.scene()` binding (avoids Babylon's
god-object Scene and three's dispose() leak model; matches rend3/Bevy layering); stable
Float32Array identities (exactly what keeps bundles valid — the rend3 property); planned
auto-aspect (kills three's most duplicated resize boilerplate); separate camera classes
(avoids Unity's half-dead-properties Camera); renderer-owned group(0) + material group(1)+
(UE's proven View/Primitive vs material-params split); blend as preset enum at material
altitude (UE's EBlendMode lesson); explicit direction on DirectionalLight avoids three's
light.target-in-scene footgun (but see the dual-source-of-truth decision in §3); linear-RGB
with `srgb()` from day one (avoids three's r152 color-management flip).

## 7. Roadmap impact

Phase 2 scope grows by (in priority order): material render state (`side`, `depthWrite`,
`depthCompare`, transparency semantics + `opacity` rule), DrawOptions plumbing for
depth/cull state, widened `mesh()` geometry contract, texture `map` on color materials,
lights ABI as fixed-capacity array + lights access from shaderMaterial via
`@vgpu/wgsl-std/scene`, `node.find`/`findAll`, `visible` subtree semantics, pipeline cache
keyed by shader source, readonly-typed array getters, kind narrowing, and the §1 bug fixes.

Phase 3 additions: instancing contract (thin-instance style), `renderOrder`, layers,
bounds (+ `camera.fit`), viewport/scissor, alpha-test mode, depth bias, orbit pan/pinch,
static-hint for `bake()` partitioning.

Phase 4 additions: node `clone()`, picking/unproject (post-bounds), IBL/environment term
for PBR (analytic lights alone will make standardMaterial look broken).

Already fixed during this review round: `srgb()` accepts `"#rrggbb"` strings (docs taught
it, implementation rejected it), `OrbitControlsElement` is now actually satisfiable by
`HTMLCanvasElement` (listener typing), docs narrowing example made honest (`instanceof`),
plan-doc `zoom`→`distance` drift reconciled.
