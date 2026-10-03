# Compose 3D scenes

Read this guide when composing 3D scenes, including hierarchies, transforms, instances,
cameras, animation, or integration with an existing ECS or physics engine. Follow the parent
skill's package-version selection first. This guide is version-neutral; resolve API details and
examples through the target project's installed vgpu CLI.

## Find the scene workflow

Start with the installed scene composition guide, then read the API pages for the operations
you need:

```sh
pnpm exec vgpu docs find "scene"
pnpm exec vgpu docs cat "<scene composition guide path returned by find>"
```

Use the project-local equivalent for your package manager. Documentation paths returned by the
CLI are virtual: read them with `vgpu docs cat`, not filesystem tools. This `scene.md` is a real
file beside `SKILL.md`. If the installed package lacks a described capability, follow the parent
skill's version-mismatch guidance rather than assuming a newer API exists.

## Choose ownership and publication

- Use vgpu for scene hierarchies, instance identity and GPU publication. If an ECS or physics
  system already computes world transforms, pass its matrices through the documented array
  interfaces. Keep one world-transform authority per object.
- Keep camera state in application-owned data and compose camera behaviors as needed. Input
  handling and frame scheduling belong to the application.
- Keep materials, lighting and PBR composition in application shaders. Consult the installed
  scene and WGSL helper docs for matrix layouts and transform helpers. Connect matrices and
  shader bindings explicitly; helpers do not reserve bind groups or inject uniforms.
- Follow the installed guide's array, quaternion and projection conventions. Mutating source
  data does not itself publish a GPU update; use the documented collection, upload and uniform
  operations explicitly. Read the examples before connecting these stages.

## Optional numerical helpers for scenes

Keep scene hierarchy, instance identity and GPU publication in vgpu. For numerical work beyond
its scene conveniences, consider [pmndrs/math](https://github.com/pmndrs/math) as an optional
application dependency. Useful cases include:

- Interpolating quaternion orientations between animation keyframes, or general vector/matrix work.
- Spatial queries such as ray intersections for picking or bounds tests.
- Springs, easing, procedural noise or inverse kinematics feeding scene transforms.

Prefer an existing suitable math, animation or physics library when the project already has one;
do not install another just for a simple transform that vgpu already supports. If a new numerical
dependency fits the task, install it with the project's package manager and read its own version's
documentation. vgpu does not require `math` and does not re-export it.

Find interoperability examples through the installed CLI:

```sh
pnpm exec vgpu docs find "math"
pnpm exec vgpu docs cat "<guide path returned by find>"
```
