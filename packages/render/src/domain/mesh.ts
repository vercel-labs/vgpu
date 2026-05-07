import { box as createBox } from "./mesh-box.ts";
import { capsule as createCapsule } from "./mesh-capsule.ts";
import { cone as createCone } from "./mesh-cone.ts";
import { cylinder as createCylinder } from "./mesh-cylinder.ts";
import { disk as createDisk } from "./mesh-disk.ts";
import { fullscreenQuad as createFullscreenQuad } from "./mesh-fullscreen-quad.ts";
import { icosphere as createIcosphere } from "./mesh-icosphere.ts";
import { plane as createPlane } from "./mesh-plane.ts";
import { ring as createRing } from "./mesh-ring.ts";
import { sphere as createSphere } from "./mesh-sphere.ts";
import { torus as createTorus } from "./mesh-torus.ts";

export type { BoxSpec } from "./mesh-box.ts";
export type { CapsuleSpec } from "./mesh-capsule.ts";
export type { ConeSpec } from "./mesh-cone.ts";
export type { CylinderSpec } from "./mesh-cylinder.ts";
export type { DiskSpec } from "./mesh-disk.ts";
export type { FullscreenQuadSpec } from "./mesh-fullscreen-quad.ts";
export type { IcosphereSpec } from "./mesh-icosphere.ts";
export type { PlaneSpec } from "./mesh-plane.ts";
export type { RingSpec } from "./mesh-ring.ts";
export type { SphereSpec } from "./mesh-sphere.ts";
export type { TorusSpec } from "./mesh-torus.ts";
export type { Mesh, MeshGpu, VertexAttributes } from "./mesh-types.ts";
export { box } from "./mesh-box.ts";
export { capsule } from "./mesh-capsule.ts";
export { cone } from "./mesh-cone.ts";
export { cylinder } from "./mesh-cylinder.ts";
export { disk } from "./mesh-disk.ts";
export { fullscreenQuad } from "./mesh-fullscreen-quad.ts";
export { icosphere } from "./mesh-icosphere.ts";
export { plane } from "./mesh-plane.ts";
export { ring } from "./mesh-ring.ts";
export { sphere } from "./mesh-sphere.ts";
export { torus } from "./mesh-torus.ts";

export namespace Mesh {
  export const box = createBox;
  export const capsule = createCapsule;
  export const cone = createCone;
  export const cylinder = createCylinder;
  export const disk = createDisk;
  export const fullscreenQuad = createFullscreenQuad;
  export const icosphere = createIcosphere;
  export const plane = createPlane;
  export const ring = createRing;
  export const sphere = createSphere;
  export const torus = createTorus;
}
