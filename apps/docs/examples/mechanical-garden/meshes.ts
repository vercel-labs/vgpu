// Procedural meshes, built once on the CPU. Every part mesh is one merged vertex buffer whose
// vertices carry a material code, so a robot part (a yellow cover over a black frame with a metal
// actuator) is a single instanced draw. Leg segments run along +Y from the joint at 0 to the next
// joint at the bone length, matching the rig locals; the hinge axis is local +X. Body space is +Z
// forward, +Y up, +X to the robot's right. Right-side hips and femurs face their cover toward +X;
// the left meshes are the same geometry mirrored in X.
//
// Vertex layout (shared with the terrain): position (3), normal (3), material (1) floats.

import { FEMUR, HIP_OFFSET, TIBIA } from "./leg";
import { FOOT_RADIUS } from "./robot";
import { HALF } from "./terrain";

export const MESH_VERTEX_FLOATS = 7;

/** Material codes; keep in sync with the MATERIAL_* constants in common.wgsl. */
export const MATERIAL = {
  yellow: 0,
  panel: 1,
  graphite: 2,
  lens: 3,
  led: 4,
  rubber: 5,
  metal: 6,
  plinth: 7,
} as const;

export interface MeshData {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

type V3 = readonly [number, number, number];

/** A local frame: the primitive's x/y/z axes and origin in mesh space. */
interface Frame {
  readonly x: V3;
  readonly y: V3;
  readonly z: V3;
  readonly origin: V3;
}

const AXES: Frame = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], origin: [0, 0, 0] };

function at(origin: V3): Frame {
  return { ...AXES, origin };
}

/** A frame whose +Y runs along local +X (actuators and hinge pins across a leg). */
function across(origin: V3): Frame {
  return { x: [0, -1, 0], y: [1, 0, 0], z: [0, 0, 1], origin };
}

/** A frame whose +Y runs along +Z (forward). */
function forward(origin: V3): Frame {
  return { x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0], origin };
}

/** One cross-section of a sweep: centre (x, y, z) and elliptical half widths across X and Z. */
interface Station {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly rz: number;
}

class Builder {
  private readonly vertices: number[] = [];
  private readonly indices: number[] = [];

  private vertex(frame: Frame, p: V3, n: V3, material: number): number {
    const { x, y, z, origin } = frame;
    const nx = x[0] * n[0] + y[0] * n[1] + z[0] * n[2];
    const ny = x[1] * n[0] + y[1] * n[1] + z[1] * n[2];
    const nz = x[2] * n[0] + y[2] * n[1] + z[2] * n[2];
    const length = Math.hypot(nx, ny, nz) || 1;
    this.vertices.push(
      origin[0] + x[0] * p[0] + y[0] * p[1] + z[0] * p[2],
      origin[1] + x[1] * p[0] + y[1] * p[1] + z[1] * p[2],
      origin[2] + x[2] * p[0] + y[2] * p[1] + z[2] * p[2],
      nx / length,
      ny / length,
      nz / length,
      material,
    );
    return this.vertices.length / MESH_VERTEX_FLOATS - 1;
  }

  /** Counter-clockwise quads over a (rows+1)×(columns+1) vertex grid starting at `first`. */
  private grid(first: number, rows: number, columns: number): void {
    const stride = columns + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const a = first + r * stride + c;
        const b = a + 1;
        const d = a + stride;
        const e = d + 1;
        this.indices.push(a, b, d, b, e, d);
      }
    }
  }

  /** Ellipsoid with `radii` and an optional radial `shape(u, v)` multiplier (u around, v up). */
  ellipsoid(frame: Frame, radii: V3, material: number, segments = 18, rings = 12, shape?: (u: number, v: number) => number): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    for (let r = 0; r <= rings; r++) {
      const v = r / rings;
      const phi = Math.PI * (v - 0.5);
      for (let s = 0; s <= segments; s++) {
        const u = s / segments;
        const theta = u * Math.PI * 2;
        const k = shape ? shape(u % 1, v) : 1;
        const ux = Math.cos(phi) * Math.sin(theta);
        const uy = Math.sin(phi);
        const uz = Math.cos(phi) * Math.cos(theta);
        // The normal of an ellipsoid is the unit direction scaled by 1/radii.
        this.vertex(frame, [ux * radii[0] * k, uy * radii[1] * k, uz * radii[2] * k], [ux / radii[0], uy / radii[1], uz / radii[2]], material);
      }
    }
    this.grid(first, rings, segments);
    return this;
  }

  /**
   * Superellipsoid: `squareness` 1 is an ellipsoid, smaller values flatten the faces toward a
   * rounded box (machined panels rather than organic shells).
   */
  rounded(frame: Frame, radii: V3, squareness: number, material: number, segments = 28, rings = 16): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    const e = squareness;
    // Snap trig residuals (sin 2π ≈ −2.4e-16) to zero first: a fractional power lifts them to a few
    // thousandths, which opens the seam column and the poles into visible slits.
    const spow = (value: number, exponent: number) => (Math.abs(value) < 1e-12 ? 0 : Math.sign(value) * Math.abs(value) ** exponent);
    for (let r = 0; r <= rings; r++) {
      const phi = Math.PI * (r / rings - 0.5);
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        const st = Math.sin(theta);
        const ct = Math.cos(theta);
        this.vertex(
          frame,
          [radii[0] * spow(cp, e) * spow(st, e), radii[1] * spow(sp, e), radii[2] * spow(cp, e) * spow(ct, e)],
          [(spow(cp, 2 - e) * spow(st, 2 - e)) / radii[0], spow(sp, 2 - e) / radii[1], (spow(cp, 2 - e) * spow(ct, 2 - e)) / radii[2]],
          material,
        );
      }
    }
    this.grid(first, rings, segments);
    return this;
  }

  /** Tapered tube along +Y from y0 (radius r0) to y1 (radius r1), with flat caps. */
  tube(frame: Frame, y0: number, y1: number, r0: number, r1: number, material: number, sides = 12): this {
    return this.sweep(
      frame,
      [
        { x: 0, y: y0, z: 0, rx: r0, rz: r0 },
        { x: 0, y: y1, z: 0, rx: r1, rz: r1 },
      ],
      material,
      sides,
    );
  }

  /**
   * Capped sweep through `stations` stacked along +Y, each an ellipse in the plane across the spine
   * (local X and the spine-perpendicular in YZ). Bowed, tapered limbs and covers.
   */
  sweep(frame: Frame, stations: readonly Station[], material: number, sides = 16): this {
    const first = this.vertices.length / MESH_VERTEX_FLOATS;
    const across: [number, number][] = [];
    for (let k = 0; k < stations.length; k++) {
      const previous = stations[Math.max(0, k - 1)]!;
      const next = stations[Math.min(stations.length - 1, k + 1)]!;
      const ty = next.y - previous.y;
      const tz = next.z - previous.z;
      const length = Math.hypot(ty, tz) || 1;
      // X × tangent: the in-plane axis perpendicular to the spine (+Z for a spine along +Y).
      across.push([-tz / length, ty / length]);
    }
    const ring = (k: number, s: number): V3 => {
      const station = stations[k]!;
      const [by, bz] = across[k]!;
      const theta = (s / sides) * Math.PI * 2;
      const sx = Math.sin(theta) * station.rx;
      const sz = Math.cos(theta) * station.rz;
      return [station.x + sx, station.y + by * sz, station.z + bz * sz];
    };
    for (let k = 0; k < stations.length; k++) {
      const station = stations[k]!;
      const [by, bz] = across[k]!;
      for (let s = 0; s <= sides; s++) {
        const theta = (s / sides) * Math.PI * 2;
        const nx = Math.sin(theta) / station.rx;
        const nb = Math.cos(theta) / station.rz;
        this.vertex(frame, ring(k, s), [nx, by * nb, bz * nb], material);
      }
    }
    this.grid(first, stations.length - 1, sides);
    for (const [k, outward] of [
      [0, -1],
      [stations.length - 1, 1],
    ] as const) {
      const station = stations[k]!;
      const [by, bz] = across[k]!;
      // Cap normal: ± the spine tangent (perpendicular to `across` in YZ).
      const normal: V3 = [0, bz * outward, -by * outward];
      const centre = this.vertex(frame, [station.x, station.y, station.z], normal, material);
      for (let s = 0; s <= sides; s++) this.vertex(frame, ring(k, s), normal, material);
      for (let s = 0; s < sides; s++) {
        if (outward > 0) this.indices.push(centre, centre + 1 + s, centre + 2 + s);
        else this.indices.push(centre, centre + 2 + s, centre + 1 + s);
      }
    }
    return this;
  }

  /** Open box sides from y0 to y1 with half extent `half`, outward normals (the plinth). */
  walls(half: number, y0: number, y1: number, material: number): this {
    const sides: [V3, V3][] = [
      [[1, 0, 0], [0, 0, -1]],
      [[-1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0]],
      [[0, 0, -1], [-1, 0, 0]],
    ];
    for (const [n, t] of sides) {
      const first = this.vertices.length / MESH_VERTEX_FLOATS;
      for (const y of [y0, y1]) {
        for (const side of [-1, 1]) {
          this.vertex(AXES, [n[0] * half + t[0] * half * side, y, n[2] * half + t[2] * half * side], n, material);
        }
      }
      this.indices.push(first, first + 1, first + 2, first + 1, first + 3, first + 2);
    }
    return this;
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
  }
}

/** The same mesh reflected in X, with the winding flipped so it stays front-facing. */
export function mirrorX(mesh: MeshData): MeshData {
  const vertices = mesh.vertices.slice();
  for (let v = 0; v < vertices.length; v += MESH_VERTEX_FLOATS) {
    vertices[v] = -vertices[v]!;
    vertices[v + 3] = -vertices[v + 3]!;
  }
  const indices = mesh.indices.slice();
  for (let i = 0; i < indices.length; i += 3) {
    const b = indices[i + 1]!;
    indices[i + 1] = indices[i + 2]!;
    indices[i + 2] = b;
  }
  return { vertices, indices };
}

/** Linear interpolation of station rows: `count` stations from t = 0 to 1. */
function stations(count: number, at: (t: number) => Station): Station[] {
  return Array.from({ length: count }, (_, k) => at(k / (count - 1)));
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export type PartMeshes = Record<"shell" | "payload" | "hipRight" | "hipLeft" | "femurRight" | "femurLeft" | "tibia" | "foot", MeshData>;

/** Chassis half extents, body space (the shell is centred on the body origin). */
export const CHASSIS: V3 = [0.125, 0.072, 0.4];

export function buildPartMeshes(): PartMeshes {
  const { yellow, panel, graphite, lens, led, rubber, metal } = MATERIAL;
  const [cx, cy, cz] = CHASSIS;
  // Chassis: a long yellow box with chamfered edges over a black belly, a pale top plate, a black
  // side stripe, and the sensor heads front, sides and rear.
  const shell = new Builder()
    .rounded(at([0, 0, 0]), [cx, cy, cz], 0.2, yellow, 36, 20)
    .rounded(at([0, -0.045, 0]), [cx - 0.007, 0.042, cz - 0.035], 0.3, graphite, 28, 14)
    .rounded(at([0, cy - 0.001, -0.01]), [cx - 0.017, 0.011, cz - 0.06], 0.15, panel, 28, 10);
  for (const side of [-1, 1]) {
    shell.rounded(at([side * (cx - 0.001), -0.014, -0.03]), [0.005, 0.011, 0.27], 0.3, graphite, 12, 8);
    // Side stereo head near the front.
    shell.rounded(at([side * (cx - 0.001), 0.028, 0.27]), [0.005, 0.016, 0.05], 0.25, graphite, 14, 8);
    for (const z of [0.25, 0.29]) shell.ellipsoid(at([side * (cx + 0.004), 0.028, z]), [0.003, 0.007, 0.007], lens, 10, 6);
    for (const z of [0.3, 0, -0.3]) shell.ellipsoid(at([side * (cx - 0.024), cy + 0.012, z]), [0.005, 0.004, 0.005], graphite, 8, 5);
  }
  // Front sensor face: a black inset in the yellow frame, a stereo lens column each side, a grille
  // between them, and a vertical status LED (lit on payload robots).
  shell.rounded(at([0, 0.002, cz - 0.002]), [cx - 0.025, 0.05, 0.012], 0.2, graphite, 24, 10);
  for (const side of [-1, 1]) {
    for (const y of [0.03, 0.01, -0.01, -0.03]) shell.ellipsoid(at([side * 0.062, y, cz + 0.009]), [0.008, 0.0065, 0.004], lens, 12, 6);
  }
  for (let k = 0; k < 6; k++) shell.rounded(at([0, -0.03 + k * 0.012, cz + 0.009]), [0.034, 0.0022, 0.003], 0.4, metal, 10, 4);
  shell.rounded(at([0.088, 0.002, cz + 0.008]), [0.0035, 0.03, 0.004], 0.4, led, 8, 8);
  // Rear sensor face.
  shell.rounded(at([0, 0.004, -cz + 0.002]), [cx - 0.035, 0.042, 0.012], 0.2, graphite, 24, 10);
  for (const side of [-1, 1]) shell.ellipsoid(at([side * 0.045, 0.006, -cz - 0.009]), [0.008, 0.0065, 0.004], lens, 12, 6);

  // Payload (Field AI): a low black box on the top plate, corner cameras, and a lidar mast at the
  // front with a silver ring and a slim mast on top. Origin on the top plate (rig PAYLOAD_OFFSET).
  const payload = new Builder().rounded(at([0, 0.028, 0]), [0.1, 0.028, 0.27], 0.15, graphite, 28, 12);
  for (const side of [-1, 1]) payload.rounded(at([side * 0.07, 0.058, 0.255]), [0.024, 0.011, 0.02], 0.3, metal, 12, 6);
  payload
    .tube(at([0, 0, 0.2]), 0.05, 0.09, 0.022, 0.022, graphite, 14)
    .tube(at([0, 0, 0.2]), 0.09, 0.155, 0.042, 0.04, graphite, 24)
    .tube(at([0, 0, 0.2]), 0.104, 0.13, 0.045, 0.045, metal, 24)
    .tube(at([0, 0, 0.2]), 0.155, 0.168, 0.03, 0.026, graphite, 18)
    .tube(at([0, 0, 0.2]), 0.168, 0.29, 0.011, 0.01, graphite, 10)
    .ellipsoid(at([0, 0.245, 0.2105]), [0.004, 0.006, 0.003], led, 8, 6);

  // Hip (right): the black roll actuator along Z at the pivot and the pitch actuator out along X to
  // the femur hinge.
  const hip = new Builder()
    .tube(forward([0, 0, -0.06]), 0, 0.12, 0.042, 0.042, graphite, 20)
    .tube(across([0, 0, 0]), 0.02, HIP_OFFSET - 0.03, 0.047, 0.047, metal, 22)
    .tube(across([0, 0, 0]), HIP_OFFSET - 0.034, HIP_OFFSET - 0.026, 0.051, 0.051, graphite, 22);

  // Femur (right): a thick, tapering yellow cover on the outer face over a black frame on the
  // inner face, a rounded shoulder over the pitch actuator, and a knee pin.
  const femur = new Builder()
    .tube(across([-0.03, 0, 0]), 0, 0.06, 0.046, 0.046, graphite, 22)
    .rounded(at([0.014, 0.025, 0.006]), [0.03, 0.068, 0.058], 0.6, yellow, 22, 12)
    .sweep(
      AXES,
      stations(7, (t) => ({ x: 0.009, y: mix(0.03, FEMUR - 0.015, t), z: 0.008 + 0.012 * Math.sin(Math.PI * t), rx: mix(0.031, 0.021, t), rz: mix(0.054, 0.026, t) })),
      yellow,
      20,
    )
    .sweep(
      AXES,
      stations(5, (t) => ({ x: -0.011, y: mix(0.02, FEMUR - 0.01, t), z: -0.006, rx: mix(0.025, 0.017, t), rz: mix(0.046, 0.024, t) })),
      graphite,
      16,
    )
    .tube(across([-0.027, FEMUR, 0]), 0, 0.054, 0.024, 0.024, graphite, 16)
    .tube(across([0.027, FEMUR, 0]), 0, 0.006, 0.011, 0.011, metal, 12);

  // Tibia: a black knee block and a flat, slightly bowed blade, deep at the knee and narrowing to
  // the ankle, which flares into the foot cuff.
  const tibia = new Builder()
    .rounded(at([0, 0.022, -0.004]), [0.024, 0.044, 0.038], 0.5, graphite, 18, 10)
    .sweep(
      AXES,
      stations(9, (t) => ({ x: 0, y: mix(0.02, TIBIA - FOOT_RADIUS * 0.9, t), z: -0.016 * Math.sin(Math.PI * t), rx: mix(0.019, 0.012, t), rz: mix(0.04, 0.013, t) })),
      graphite,
      16,
    )
    .tube(AXES, TIBIA - FOOT_RADIUS * 1.7, TIBIA - FOOT_RADIUS * 0.4, 0.012, 0.02, graphite, 14);

  // Foot: a ribbed rubber drum across the hinge whose tread touches the ground one FOOT_RADIUS below
  // the foot point (the ankle pin at its centre).
  const half = FOOT_RADIUS * 0.85;
  const foot = new Builder().sweep(
    across([0, 0, 0]),
    stations(13, (t) => {
      const edge = Math.abs(t * 2 - 1);
      const rib = 1 - 0.07 * Math.max(0, Math.cos(t * Math.PI * 8)) ** 2;
      const radius = FOOT_RADIUS * (1 - 0.3 * edge ** 6) * rib;
      return { x: 0, y: mix(-half, half, t), z: 0, rx: radius, rz: radius };
    }),
    rubber,
    24,
  );

  const hipMesh = hip.build();
  const femurMesh = femur.build();
  return {
    shell: shell.build(),
    payload: payload.build(),
    hipRight: hipMesh,
    hipLeft: mirrorX(hipMesh),
    femurRight: femurMesh,
    femurLeft: mirrorX(femurMesh),
    tibia: tibia.build(),
    foot: foot.build(),
  };
}

/** Plinth depth below the tile rim. */
export const PLINTH_DEPTH = 0.9;

/** The training ground's concrete plinth walls. */
export function buildPlinthMesh(): MeshData {
  return new Builder().walls(HALF, -PLINTH_DEPTH, 0.002, MATERIAL.plinth).build();
}
