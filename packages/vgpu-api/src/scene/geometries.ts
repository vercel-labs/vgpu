/**
 * Every recipe in one object, for callers that pick a primitive by name at runtime.
 *
 * It lives alone because naming all 15 factories in a single frozen object is what would pin all 15
 * generators into a bundle: `import { box } from "./geometry.ts"` must not drag `torus` along, so
 * this convenience is a separate module you opt into.
 */
import {
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
} from "./geometry.ts";

export const geometries = Object.freeze({
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
});
