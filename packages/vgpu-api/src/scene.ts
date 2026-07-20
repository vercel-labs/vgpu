export {
  box,
  capsule,
  cone,
  cylinder,
  disk,
  dodecahedron,
  fullscreenQuad,
  geometries,
  icosahedron,
  icosphere,
  octahedron,
  plane,
  ring,
  sphere,
  tetrahedron,
  torus,
} from "./scene/geometry.ts";
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
export { orthographicCamera, perspectiveCamera } from "./scene/camera.ts";
export type { Camera, CameraVec3, OrthographicCameraOptions, PerspectiveCameraOptions, SceneCamera } from "./scene/camera.ts";
export { orbit } from "./scene/orbit.ts";
export type { Mat4, OrbitOptions } from "./scene/orbit.ts";
/** Three-component vector type accepted by low-level scene camera helpers. */
export type { Vec3 } from "./scene/geometry-src/index.ts";
export type { SceneMesh } from "./scene/mesh.ts";
export { Mesh } from "./scene/mesh-descriptor.ts";
export type { MeshAttributeOverride, MeshAttributes, MeshBuffer, MeshBufferOptions, MeshData, MeshOptions, MeshSlice, MeshSliceOptions } from "./scene/mesh-descriptor.ts";
