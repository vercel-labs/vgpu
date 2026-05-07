import { box as createBox } from "./mesh-box.ts";
import { disk as createDisk } from "./mesh-disk.ts";
import { fullscreenQuad as createFullscreenQuad } from "./mesh-fullscreen-quad.ts";
import { plane as createPlane } from "./mesh-plane.ts";
import { ring as createRing } from "./mesh-ring.ts";
import { sphere as createSphere } from "./mesh-sphere.ts";

export type { BoxSpec } from "./mesh-box.ts";
export type { DiskSpec } from "./mesh-disk.ts";
export type { FullscreenQuadSpec } from "./mesh-fullscreen-quad.ts";
export type { PlaneSpec } from "./mesh-plane.ts";
export type { RingSpec } from "./mesh-ring.ts";
export type { SphereSpec } from "./mesh-sphere.ts";
export type { Mesh, MeshGpu, VertexAttributes } from "./mesh-types.ts";
export { box } from "./mesh-box.ts";
export { disk } from "./mesh-disk.ts";
export { fullscreenQuad } from "./mesh-fullscreen-quad.ts";
export { plane } from "./mesh-plane.ts";
export { ring } from "./mesh-ring.ts";
export { sphere } from "./mesh-sphere.ts";

export namespace Mesh {
  export const box = createBox;
  export const disk = createDisk;
  export const fullscreenQuad = createFullscreenQuad;
  export const plane = createPlane;
  export const ring = createRing;
  export const sphere = createSphere;
}
