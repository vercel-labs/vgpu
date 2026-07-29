/**
 * Mesh recipes: pure CPU values (`{ kind, props }`) that carry their own upload.
 *
 * Each factory imports exactly one generator and closes over it, so the module graph — not a
 * registry — decides what a program pays for: `box()` links `mesh-box.ts` and nothing else, and
 * `geometry(gpu, recipe)` needs no knowledge of any primitive to expand it. The values stay frozen,
 * device-free and lazy, which keeps them safe to store in a scene node and to fingerprint by
 * `kind` + `props`.
 */
import { recipe, type GeometryRecipe, type GeometryRecipeOf } from "./geometry-recipe.ts";
import { box as generateBox } from "./geometry-src/mesh-box.ts";
import { capsule as generateCapsule } from "./geometry-src/mesh-capsule.ts";
import { cone as generateCone } from "./geometry-src/mesh-cone.ts";
import { cylinder as generateCylinder } from "./geometry-src/mesh-cylinder.ts";
import { disk as generateDisk } from "./geometry-src/mesh-disk.ts";
import { dodecahedron as generateDodecahedron } from "./geometry-src/mesh-dodecahedron.ts";
import { fullscreenQuad as generateFullscreenQuad } from "./geometry-src/mesh-fullscreen-quad.ts";
import { icosahedron as generateIcosahedron } from "./geometry-src/mesh-icosahedron.ts";
import { icosphere as generateIcosphere } from "./geometry-src/mesh-icosphere.ts";
import { octahedron as generateOctahedron } from "./geometry-src/mesh-octahedron.ts";
import { plane as generatePlane } from "./geometry-src/mesh-plane.ts";
import { ring as generateRing } from "./geometry-src/mesh-ring.ts";
import { sphere as generateSphere } from "./geometry-src/mesh-sphere.ts";
import { tetrahedron as generateTetrahedron } from "./geometry-src/mesh-tetrahedron.ts";
import { torus as generateTorus } from "./geometry-src/mesh-torus.ts";
import type {
  BoxSpec,
  CapsuleSpec,
  ConeSpec,
  CylinderSpec,
  DiskSpec,
  FullscreenQuadSpec,
  IcosphereSpec,
  PlaneSpec,
  PolyhedronSpec,
  RingSpec,
  SphereSpec,
  TorusSpec,
} from "./geometry-src/index.ts";

export type { GeometryRecipe } from "./geometry-recipe.ts";

/** Removes Device and makes render-domain spec fields optional so scene descriptors stay pure. */
type WithoutDevice<T> = Partial<Omit<T, "device">>;

export type BoxOptions = WithoutDevice<BoxSpec>;
export type CapsuleOptions = WithoutDevice<CapsuleSpec>;
export type ConeOptions = WithoutDevice<ConeSpec>;
export type CylinderOptions = WithoutDevice<CylinderSpec>;
export type DiskOptions = WithoutDevice<DiskSpec>;
export type FullscreenQuadOptions = WithoutDevice<FullscreenQuadSpec>;
export type IcosphereOptions = WithoutDevice<IcosphereSpec>;
export type PlaneOptions = WithoutDevice<PlaneSpec>;
export type PolyhedronOptions = WithoutDevice<PolyhedronSpec>;
export type RingOptions = WithoutDevice<RingSpec>;
export type SphereOptions = WithoutDevice<SphereSpec>;
export type TorusOptions = WithoutDevice<TorusSpec>;

type RecipeProps = {
  readonly box: BoxOptions;
  readonly capsule: CapsuleOptions;
  readonly cone: ConeOptions;
  readonly cylinder: CylinderOptions;
  readonly disk: DiskOptions;
  readonly dodecahedron: PolyhedronOptions;
  readonly fullscreenQuad: FullscreenQuadOptions;
  readonly icosahedron: PolyhedronOptions;
  readonly icosphere: IcosphereOptions;
  readonly octahedron: PolyhedronOptions;
  readonly plane: PlaneOptions;
  readonly ring: RingOptions;
  readonly sphere: SphereOptions;
  readonly tetrahedron: PolyhedronOptions;
  readonly torus: TorusOptions;
};

export type GeometryKind = keyof RecipeProps;
export type SceneGeometryOfKind<K extends GeometryKind> = Extract<SceneGeometry, { readonly kind: K }>;
/**
 * Any of the 15 recipes. Still `{ kind, props }` for consumers that inspect or store it — the
 * `build()` it also carries is internal, and is what lets `geometry()` expand it without a table.
 */
export type SceneGeometry = {
  [K in GeometryKind]: GeometryRecipeOf<K, RecipeProps[K]>;
}[GeometryKind];

export function box(options: BoxOptions = {}): SceneGeometryOfKind<"box"> {
  return recipe("box", options, (device, props) => generateBox({ device, ...props }));
}

export function capsule(options: CapsuleOptions = {}): SceneGeometryOfKind<"capsule"> {
  return recipe("capsule", options, (device, props) => generateCapsule({ device, radius: 0.5, height: 1, ...props }));
}

export function cone(options: ConeOptions = {}): SceneGeometryOfKind<"cone"> {
  return recipe("cone", options, (device, props) => generateCone({ device, radius: 0.5, height: 1, ...props }));
}

export function cylinder(options: CylinderOptions = {}): SceneGeometryOfKind<"cylinder"> {
  return recipe("cylinder", options, (device, props) => generateCylinder({ device, radius: 0.5, height: 1, ...props }));
}

export function disk(options: DiskOptions = {}): SceneGeometryOfKind<"disk"> {
  return recipe("disk", options, (device, props) => generateDisk({ device, radius: 0.5, ...props }));
}

export function dodecahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"dodecahedron"> {
  return recipe("dodecahedron", options, (device, props) => generateDodecahedron({ device, radius: 0.5, ...props }));
}

export function fullscreenQuad(options: FullscreenQuadOptions = {}): SceneGeometryOfKind<"fullscreenQuad"> {
  return recipe("fullscreenQuad", options, (device, props) => generateFullscreenQuad({ device, ...props }));
}

export function icosahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"icosahedron"> {
  return recipe("icosahedron", options, (device, props) => generateIcosahedron({ device, radius: 0.5, ...props }));
}

export function icosphere(options: IcosphereOptions = {}): SceneGeometryOfKind<"icosphere"> {
  return recipe("icosphere", options, (device, props) => generateIcosphere({ device, radius: 0.5, ...props }));
}

export function octahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"octahedron"> {
  return recipe("octahedron", options, (device, props) => generateOctahedron({ device, radius: 0.5, ...props }));
}

export function plane(options: PlaneOptions = {}): SceneGeometryOfKind<"plane"> {
  return recipe("plane", options, (device, props) => generatePlane({ device, ...props }));
}

export function ring(options: RingOptions = {}): SceneGeometryOfKind<"ring"> {
  return recipe("ring", options, (device, props) => generateRing({ device, innerRadius: 0.25, outerRadius: 0.5, ...props }));
}

export function sphere(options: SphereOptions = {}): SceneGeometryOfKind<"sphere"> {
  return recipe("sphere", options, (device, props) => generateSphere({ device, ...props }));
}

export function tetrahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"tetrahedron"> {
  return recipe("tetrahedron", options, (device, props) => generateTetrahedron({ device, radius: 0.5, ...props }));
}

export function torus(options: TorusOptions = {}): SceneGeometryOfKind<"torus"> {
  return recipe("torus", options, (device, props) => generateTorus({ device, radius: 0.5, tube: 0.2, ...props }));
}
