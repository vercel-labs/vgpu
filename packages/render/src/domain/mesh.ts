import { box as createBox } from "./mesh-box.ts";
import { fullscreenQuad as createFullscreenQuad } from "./mesh-fullscreen-quad.ts";
import { sphere as createSphere } from "./mesh-sphere.ts";

export type { BoxSpec } from "./mesh-box.ts";
export type { FullscreenQuadSpec } from "./mesh-fullscreen-quad.ts";
export type { SphereSpec } from "./mesh-sphere.ts";
export type { Mesh, MeshGpu, VertexAttributes } from "./mesh-types.ts";
export { box } from "./mesh-box.ts";
export { fullscreenQuad } from "./mesh-fullscreen-quad.ts";
export { sphere } from "./mesh-sphere.ts";

export namespace Mesh {
  export const box = createBox;
  export const fullscreenQuad = createFullscreenQuad;
  export const sphere = createSphere;
}
