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
export {
  composeMatrix,
  invertAffine,
  localFromWorld,
  multiplyMatrices,
} from "./scene/transforms.ts";
export type {
  Mat4,
  QuatLike,
  TransformValues,
  Vec3Like,
} from "./scene/transforms.ts";
export type { Vec3 } from "./scene/geometry-src/index.ts";
export type {
  Geometry,
  GeometryAttributeOverride,
  GeometryAttributes,
  GeometryBuffer,
  GeometryBufferOptions,
  GeometryData,
  GeometryOptions,
  GeometrySlice,
  GeometrySliceOptions,
} from "./scene/geometry-descriptor.ts";
export { group, SceneNode } from "./scene/nodes.ts";
export type { NodeOptions, NodeTransformValues, SceneNodeKind } from "./scene/nodes.ts";
export { evaluateHierarchy, hierarchyOrder } from "./scene/hierarchy.ts";
export type { HierarchyEvaluation, HierarchyOrder } from "./scene/hierarchy.ts";
export { instances } from "./scene/instances.ts";
export type {
  InstanceAddArgs,
  InstanceAttribute,
  InstanceAttributeFormat,
  InstanceAttributes,
  InstanceCollection,
  InstanceFormat,
  InstanceId,
  InstanceInitialValues,
  InstanceValue,
  InstanceValues,
} from "./scene/instances.ts";
export {
  dolly,
  orbit,
  orbitRig,
  orthographic,
  pan,
  perspective,
  rigPose,
  smoothRig,
  viewMatrices,
  worldPerPixel,
  zoom,
} from "./scene/camera-state.ts";
export type {
  CameraMatrices,
  Lens,
  OrbitRig,
  OrbitRigOptions,
  Pose,
  RigLimits,
} from "./scene/camera-state.ts";
