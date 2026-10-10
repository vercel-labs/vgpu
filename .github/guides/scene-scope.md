# Scene library boundary

Read this before designing or changing `vgpu/scene`, `vgpu/scene/gpu`, or their scene guides.

## Responsibility

`vgpu/scene` composes scene data for rendering. General numerical algorithms belong in a
dedicated math library, such as [pmndrs/math](https://github.com/pmndrs/math), used directly by
the application. External ECS, physics, and animation systems remain authoritative for their
own data. Integration happens through explicit arrays and function calls.

| vgpu maintains | Applications obtain elsewhere |
| --- | --- |
| Material-independent nodes, parent/child topology, world propagation, and dirty reporting | General vector, quaternion, matrix, decomposition, and interpolation APIs |
| Instance handles, packed records, custom attributes, and explicit world sources | Collision detection, ray queries, spatial indexes, physics, and ECS storage |
| Composable camera rig operations and scene camera conventions | General springs, easing, noise, random generators, and inverse kinematics |
| Renderable mesh recipes and their vertex/index layouts | General triangulation, hull, and polygon-processing algorithms |
| GPU instance publication, resource lifetime, and shader layout integration | Materials, PBR composition, lighting systems, input handling, and scheduling |

The CPU boundary does not remove shader-side numerical functions from `@vgpu/wgsl-std`.
JavaScript math libraries do not replace WGSL implementations running on the GPU.

## Existing conveniences

Keep `composeMatrix`, `multiplyMatrices`, `invertAffine`, `localFromWorld`, camera projections,
`degToRad`, and `srgb` supported. They form the existing scene convenience surface; this boundary
does not deprecate them or change their semantics. Do not grow that surface into a parallel
general-purpose math library. New numerical needs should first use an external library directly.

Retain scene-specific validation, error messages, and guarantees about output writes. Reusing an
external calculation internally is a separate implementation decision: check representation,
rotation/depth conventions, aliasing, singularity handling, float32 range, allocation cost, and
bundle size before replacing an implementation. Do not add wrappers just to rename external APIs.

## Interoperability contract

- Accept external arrays where the existing API declares `ArrayLike<number>`, including
  `TransformValues` inputs, `setWorld`, bound world sources, and the projection input of
  `viewMatrices`. Do not require a math-library class.
- Document both directions: math's tuple arrays fit these inputs, but vgpu's `Float32Array`
  outputs do not satisfy math's tuple types. Copy them into reusable math values before calling
  math operations; do not recommend type assertions as an interoperability mechanism.
- Keep packed hierarchy and batch interfaces as `Float32Array`/`Int32Array`, as declared. Do not
  imply that accepting arrays at one boundary makes every scene interface representation-generic.
- Preserve column-major matrices, `world = parentWorld * local`, XYZW quaternions, and WebGPU
  projection depth `0..1`. Document any unit conversion explicitly.
- Choose one world-transform authority per object: vgpu hierarchy evaluation or an external
  system. A final external world enters the instance collection directly.
- Copies and publication stay explicit. Mutation of an external array does not automatically
  update a collection, GPU buffer, or previously packed uniform.
- Do not expose `math` types in vgpu's public signatures, re-export its API, or require it as a
  runtime/peer dependency merely for interoperability. A pinned development dependency may
  verify documentation examples against a concrete version.

See [Using math with scene data](../../docs/topics/scene-math.docs.md) for checked examples.

## Admission rule for new APIs

Before adding a scene export, identify the scene ownership, hierarchy, instance, camera behavior,
or GPU integration responsibility it solves. If it is a general numerical operation that an
application can already perform before passing arrays into vgpu, use the external operation and
document the connection instead. If integration requires a copy, expose that copy honestly rather
than inventing a compatibility class or silently claiming zero-copy behavior.

This change establishes scope and examples. It removes no implementation and claims no measured
performance improvement. A future internal math replacement must include its own tests and release
notes; existing geometry code's `wgpu-matrix` dependency is not replaced by this decision.
