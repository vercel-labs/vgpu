---
title: "Scene API migration"
description: "Replace the previous vgpu/scene camera, mesh, material, and light API with explicit transforms, external camera state, instances, and application-owned shaders."
---

This page explains the previous scene API and its replacements. The names below are historical unless explicitly marked retained. They are not a compatibility API. Follow [Scene composition](/guides/scene-composition#migrate-from-the-previous-vgpu-scene) for complete current examples and the source migration notes in `.changeset/scene-composition-utilities.md` for the release changes.

## Import

Import CPU composition from `vgpu/scene`, the optional GPU bridge from `vgpu/scene/gpu`, and shader helpers from `@vgpu/wgsl-std/scene` inside WGSL. Remove imports of the retired names below.

## Signature

The notable name reuse is `orbit`: it now takes an external rig and angular deltas. Object animation that previously passed time and radius must call `composeMatrix` instead. No renderer or material object is required by the new scene API.

## Parameters

Keep camera FOV in degrees and transform/orbit angles in radians. Supply explicit finite near/far planes and aspect, exact-sized matrices, and independent current/goal rig vectors. See the current [camera reference](/reference/vgpu-scene/camera-state) for validation and defaults.

## Examples

The [composition guide](/guides/scene-composition) shows nodes, external hierarchy arrays, and direct physics worlds feeding the same instance stream. `examples/by-example-s06-scene` contains executable examples and native output checks. In each path, publish instances before encoding passes and repeat named uniform `.set()` after camera matrix changes.

## Notes

Parented cameras use `invertAffine(cameraNode.worldMatrix, view)` followed by `multiplyMatrices(projection, view, viewProjection)` to preserve parent transforms and scale. See the checked migration example in [Scene composition](/guides/scene-composition#migrate-from-the-previous-vgpu-scene).

Unlike the old controls, `smoothRig` requires explicit finite nonnegative delta time, blends distance logarithmically, and returns the current rig without epsilon snapping or a changed boolean. The old object `orbit` allocated its output; `composeMatrix` writes into a reusable matrix.

Bindings remain shader-owned. Existing geometry recipes, `geometries`, `degToRad`, and `srgb` remain available. Legacy material/light objects do not have a new scene equivalent; use your own data and WGSL. The following lookup preserves published documentation links while explaining each replacement.

## Camera

`Camera` is removed. Use `Pose`, `Lens`, and `CameraMatrices` for owned state and `Vec3Like` for vector inputs. The camera world position is `pose.position`; `matrices.viewProjection` reaches WGSL through explicit named `.set()`.

## SceneCamera

`SceneCamera` is removed. Use `Pose`, `Lens`, and `CameraMatrices` for owned state and `Vec3Like` for vector inputs. The camera world position is `pose.position`; `matrices.viewProjection` reaches WGSL through explicit named `.set()`.

## CameraVec3

`CameraVec3` is removed. Use `Pose`, `Lens`, and `CameraMatrices` for owned state and `Vec3Like` for vector inputs. The camera world position is `pose.position`; `matrices.viewProjection` reaches WGSL through explicit named `.set()`.

## Vec3

`Vec3` is retained. See its current [reference](/reference/vgpu-scene/vec3). It no longer depends on the previous camera or scene-tree implementation.

## Mat4

`Mat4` is retained. See its current [reference](/reference/vgpu-scene/transforms). It no longer depends on the previous camera or scene-tree implementation.

## orthographicCamera

`orthographicCamera` is removed. Use `orthographic(bounds, projection)` and `viewMatrices(pose, projection, matrices)`. Bounds must be finite and ordered; `0 <= near < far`.

## OrthographicCameraOptions

`OrthographicCameraOptions` is removed. Use `orthographic(bounds, projection)` and `viewMatrices(pose, projection, matrices)`. Bounds must be finite and ordered; `0 <= near < far`.

## perspectiveCamera

`perspectiveCamera` is removed. Use `Lens`, `Pose`, `perspective(lens, aspect, projection)`, and `viewMatrices`. Supply finite near/far and aspect explicitly, and repack the camera uniform after updates.

## PerspectiveCameraOptions

`PerspectiveCameraOptions` is removed. Use `Lens`, `Pose`, `perspective(lens, aspect, projection)`, and `viewMatrices`. Supply finite near/far and aspect explicitly, and repack the camera uniform after updates.

## orbit

The old time-based object orbit is removed. Use `composeMatrix` with explicit translation and rotation for object animation. The current `orbit(rig, deltaYaw, deltaPitch, limits?)` updates camera state; see [camera functions](/reference/vgpu-scene/camera-state).

## OrbitOptions

The old time-based object orbit is removed. Use `composeMatrix` with explicit translation and rotation for object animation. The current `orbit(rig, deltaYaw, deltaPitch, limits?)` updates camera state; see [camera functions](/reference/vgpu-scene/camera-state).

## PerspectiveCameraValues

`PerspectiveCameraValues` is removed. Use `Lens`, `Pose`, `perspective(lens, aspect, projection)`, and `viewMatrices`. Supply finite near/far and aspect explicitly, and repack the camera uniform after updates.

## OrthographicCameraValues

`OrthographicCameraValues` is removed. Use `orthographic(bounds, projection)` and `viewMatrices(pose, projection, matrices)`. Bounds must be finite and ordered; `0 <= near < far`.

## scene

Replace `scene(options)` with `group(options)`. Any group can be a root; a root has no renderer or material responsibilities.

## group

`group` is retained for material-independent group transforms. Only the `"group"` kind remains; use `.set()` for local updates and treat borrowed arrays as read-only. See [nodes](/reference/vgpu-scene/nodes).

## mesh

Replace the transform with `group` or an externally owned world matrix. Keep GPU geometry and draw/shader state in the application. Use `instances` plus `instanceGeometry` for many copies of a mesh.

## MeshNode

Replace the transform with `group` or an externally owned world matrix. Keep GPU geometry and draw/shader state in the application. Use `instances` plus `instanceGeometry` for many copies of a mesh.

## SceneNode

`SceneNode` is retained for material-independent group transforms. Only the `"group"` kind remains; use `.set()` for local updates and treat borrowed arrays as read-only. See [nodes](/reference/vgpu-scene/nodes).

## NodeOptions

`NodeOptions` is retained for material-independent group transforms. Only the `"group"` kind remains; use `.set()` for local updates and treat borrowed arrays as read-only. See [nodes](/reference/vgpu-scene/nodes).

## NodeTransformValues

`NodeTransformValues` is retained for material-independent group transforms. Only the `"group"` kind remains; use `.set()` for local updates and treat borrowed arrays as read-only. See [nodes](/reference/vgpu-scene/nodes).

## Vec3Like

`Vec3Like` is retained. See its current [reference](/reference/vgpu-scene/transforms). It no longer depends on the previous camera or scene-tree implementation.

## QuatLike

`QuatLike` is retained. See its current [reference](/reference/vgpu-scene/transforms). It no longer depends on the previous camera or scene-tree implementation.

## SceneNodeKind

`SceneNodeKind` is retained for material-independent group transforms. Only the `"group"` kind remains; use `.set()` for local updates and treat borrowed arrays as read-only. See [nodes](/reference/vgpu-scene/nodes).

## unlitMaterial

`unlitMaterial` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## lambertMaterial

`lambertMaterial` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## normalMaterial

`normalMaterial` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## shaderMaterial

`shaderMaterial` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## SceneMaterial

`SceneMaterial` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## ColorMaterialOptions

`ColorMaterialOptions` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## ColorMaterialValues

`ColorMaterialValues` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## MaterialBlend

`MaterialBlend` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## SceneMaterialKind

`SceneMaterialKind` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## ShaderMaterialOptions

`ShaderMaterialOptions` is removed. Define application material data, WGSL shading, named uniforms, and draw pipeline options explicitly. There is no required scene material class or built-in PBR model.

## directionalLight

`directionalLight` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## DirectionalLightOptions

`DirectionalLightOptions` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## DirectionalLightValues

`DirectionalLightValues` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## ambientLight

`ambientLight` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## AmbientLightOptions

`AmbientLightOptions` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## AmbientLightValues

`AmbientLightValues` is removed. Keep light values in application data and bind them by name to your own WGSL lighting code.

## orbitControls

`orbitControls` is removed. Own input listeners and their cleanup in your app, accumulate deltas into a goal `OrbitRig`, and compose `orbit`, `pan`, `dolly`, and `smoothRig`. Use explicit delta time and independent current/goal state.

## OrbitControlsElement

`OrbitControlsElement` is removed. Own input listeners and their cleanup in your app, accumulate deltas into a goal `OrbitRig`, and compose `orbit`, `pan`, `dolly`, and `smoothRig`. Use explicit delta time and independent current/goal state.

## OrbitControlsOptions

`OrbitControlsOptions` is removed. Own input listeners and their cleanup in your app, accumulate deltas into a goal `OrbitRig`, and compose `orbit`, `pan`, `dolly`, and `smoothRig`. Use explicit delta time and independent current/goal state.

## OrbitControlsValues

`OrbitControlsValues` is removed. Own input listeners and their cleanup in your app, accumulate deltas into a goal `OrbitRig`, and compose `orbit`, `pan`, `dolly`, and `smoothRig`. Use explicit delta time and independent current/goal state.
