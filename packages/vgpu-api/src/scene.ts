export {
  box,
  capsule,
  cone,
  cylinder,
  disk,
  dodecahedron,
  fullscreenQuad,
  icosahedron,
  icosphere,
  octahedron,
  plane,
  ring,
  sphere,
  tetrahedron,
  torus,
} from "./scene/geometry.ts";
export { geometries } from "./scene/geometries.ts";
export type {
  BoxOptions,
  CapsuleOptions,
  ConeOptions,
  CylinderOptions,
  DiskOptions,
  FullscreenQuadOptions,
  GeometryKind,
  IcosphereOptions,
  PlaneOptions,
  PolyhedronOptions,
  RingOptions,
  SceneGeometry,
  SceneGeometryOfKind,
  SphereOptions,
  TorusOptions,
} from "./scene/geometry.ts";
export { degToRad, srgb } from "./scene/geometry-src/index.ts";
export { OrthographicCamera, orthographicCamera, PerspectiveCamera, perspectiveCamera } from "./scene/camera.ts";
export type {
  Camera,
  CameraVec3,
  OrthographicCameraOptions,
  OrthographicCameraValues,
  PerspectiveCameraOptions,
  PerspectiveCameraValues,
  SceneCamera,
} from "./scene/camera.ts";
export { orbit } from "./scene/orbit.ts";
export type { Mat4, OrbitOptions } from "./scene/orbit.ts";
/** Three-component vector type accepted by low-level scene camera helpers. */
export type { Vec3 } from "./scene/geometry-src/index.ts";
export type { Geometry, GeometryAttributeOverride, GeometryAttributes, GeometryBuffer, GeometryBufferOptions, GeometryData, GeometryOptions, GeometrySlice, GeometrySliceOptions } from "./scene/geometry-descriptor.ts";
export { group, SceneNode } from "./scene/tree/node.ts";
export type { NodeOptions, NodeTransformValues, QuatLike, SceneNodeKind, Vec3Like } from "./scene/tree/node.ts";
export { mesh, MeshNode, scene } from "./scene/tree/mesh-node.ts";
export {
  LambertMaterial,
  lambertMaterial,
  NormalMaterial,
  normalMaterial,
  SceneMaterial,
  ShaderMaterial,
  shaderMaterial,
  UnlitMaterial,
  unlitMaterial,
} from "./scene/tree/material.ts";
export type { ColorMaterialOptions, ColorMaterialValues, MaterialBlend, SceneMaterialKind, ShaderMaterialOptions } from "./scene/tree/material.ts";
export { AmbientLight, ambientLight, DirectionalLight, directionalLight } from "./scene/tree/light.ts";
export type { AmbientLightOptions, AmbientLightValues, DirectionalLightOptions, DirectionalLightValues } from "./scene/tree/light.ts";
export { OrbitControls, orbitControls } from "./scene/tree/orbit-controls.ts";
export type { OrbitControlsElement, OrbitControlsOptions, OrbitControlsValues } from "./scene/tree/orbit-controls.ts";
