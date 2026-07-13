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
} from "@vgpu/render";

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

type GeometryOptions = {
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

export type GeometryKind = keyof GeometryOptions;
export type SceneGeometryOfKind<K extends GeometryKind> = Extract<SceneGeometry, { readonly kind: K }>;
export type SceneGeometry = {
  [K in GeometryKind]: {
    readonly kind: K;
    readonly props: Readonly<GeometryOptions[K]>;
  };
}[GeometryKind];

export function box(options: BoxOptions = {}): SceneGeometryOfKind<"box"> {
  return createGeometry("box", options);
}

export function capsule(options: CapsuleOptions = {}): SceneGeometryOfKind<"capsule"> {
  return createGeometry("capsule", options);
}

export function cone(options: ConeOptions = {}): SceneGeometryOfKind<"cone"> {
  return createGeometry("cone", options);
}

export function cylinder(options: CylinderOptions = {}): SceneGeometryOfKind<"cylinder"> {
  return createGeometry("cylinder", options);
}

export function disk(options: DiskOptions = {}): SceneGeometryOfKind<"disk"> {
  return createGeometry("disk", options);
}

export function dodecahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"dodecahedron"> {
  return createGeometry("dodecahedron", options);
}

export function fullscreenQuad(options: FullscreenQuadOptions = {}): SceneGeometryOfKind<"fullscreenQuad"> {
  return createGeometry("fullscreenQuad", options);
}

export function icosahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"icosahedron"> {
  return createGeometry("icosahedron", options);
}

export function icosphere(options: IcosphereOptions = {}): SceneGeometryOfKind<"icosphere"> {
  return createGeometry("icosphere", options);
}

export function octahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"octahedron"> {
  return createGeometry("octahedron", options);
}

export function plane(options: PlaneOptions = {}): SceneGeometryOfKind<"plane"> {
  return createGeometry("plane", options);
}

export function ring(options: RingOptions = {}): SceneGeometryOfKind<"ring"> {
  return createGeometry("ring", options);
}

export function sphere(options: SphereOptions = {}): SceneGeometryOfKind<"sphere"> {
  return createGeometry("sphere", options);
}

export function tetrahedron(options: PolyhedronOptions = {}): SceneGeometryOfKind<"tetrahedron"> {
  return createGeometry("tetrahedron", options);
}

export function torus(options: TorusOptions = {}): SceneGeometryOfKind<"torus"> {
  return createGeometry("torus", options);
}

function createGeometry<K extends GeometryKind>(kind: K, options: GeometryOptions[K]): SceneGeometryOfKind<K> {
  const props = Object.freeze({ ...(options ?? {}) }) as Readonly<GeometryOptions[K]>;
  return Object.freeze({ kind, props }) as SceneGeometryOfKind<K>;
}

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
