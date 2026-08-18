/**
 * Scene definition for the prism rainbow example.
 *
 * The whole scene is two-dimensional: the frame is a slice through a room seen
 * from the front. `x` grows right, `y` grows up, and the visible region is `y` in
 * [-1, 1] with `x` in [-aspect, aspect]. The prism is the triangle a viewer sees
 * when looking straight at it, so a ray that stays in the frame's plane refracts
 * entirely within it — enter one face, cross the glass, leave through another.
 *
 * Every constant here is derived from four decisions (how big the prism is, how
 * it is tilted, how steeply the beam arrives, and how far away the lamp sits)
 * rather than typed in, because the interesting values are the angles; the
 * vertices only follow from them. `optics.test.ts` asserts the properties the
 * derivation is supposed to guarantee.
 *
 * These constants are also the single source of truth across languages:
 * `optics.ts` (the CPU reference) reads them directly and `scene.ts` uploads
 * them as uniforms, so `optics.wgsl` traces exactly the same geometry.
 */

export type Vec2 = readonly [number, number];

export interface Triangle {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly c: Vec2;
}

export interface SpotLight {
  /** Emitter center, in scene units. */
  readonly center: Vec2;
  /** Emitter radius. A ray reaches the lamp when it passes this close to the center. */
  readonly radius: number;
  /** Unit direction the beam is aimed in. */
  readonly direction: Vec2;
  /** Half-angle of the fully lit cone, in radians. */
  readonly innerAngle: number;
  /** Half-angle at which the cone has fallen off to zero, in radians. */
  readonly outerAngle: number;
}

/**
 * Cauchy dispersion, `n(l) = base + strength / l^2` with `l` in micrometres.
 *
 * `crown` and `flint` are real glasses. Measured through this prism at the
 * default incidence their 400-700nm fans open 1.6 and 7.3 degrees — a colored
 * edge on a white beam, which is honestly what a prism this size does over a
 * throw this short. `stylized` keeps the geometry and only widens `strength`,
 * which opens the fan to 16 degrees and turns that edge into the rainbow the
 * example is named after.
 */
export interface DispersionPreset {
  readonly base: number;
  readonly strength: number;
}

export const PRISM_DISPERSION_PRESETS = {
  stylized: { base: 1.47, strength: 0.035 },
  crown: { base: 1.5046, strength: 0.0042 },
  flint: { base: 1.664, strength: 0.0105 },
} as const satisfies Record<string, DispersionPreset>;

export type PrismDispersion = keyof typeof PRISM_DISPERSION_PRESETS;

export const PRISM_DISPERSION_ORDER: readonly PrismDispersion[] = ['stylized', 'crown', 'flint'];

export const PRISM_DISPERSION_LABELS: Record<PrismDispersion, string> = {
  stylized: 'Stylized',
  crown: 'Crown glass',
  flint: 'Dense flint',
};

export interface PrismControls {
  readonly dispersion: PrismDispersion;
  /** Show the traced caustic alone, without the wall, the glass or the beam. */
  readonly causticOnly: boolean;
}

export const DEFAULT_PRISM_CONTROLS: PrismControls = {
  dispersion: 'stylized',
  causticOnly: false,
};

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

function rotate(point: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine];
}

/** Side length of the equilateral prism, in scene units. */
export const PRISM_SIDE = 0.57;
/** Tilt of the whole prism, which tilts the fan it throws by as much. */
export const PRISM_TILT_DEGREES = 10;
export const PRISM_CENTROID: Vec2 = [0, 0.34];

/**
 * Equilateral prism, apex up, tilted, wound counter-clockwise.
 *
 * The winding matters: `optics.ts` and `optics.wgsl` both take each edge's
 * outward normal to be `(edge.y, -edge.x)`, which only points out of the
 * triangle for counter-clockwise vertices.
 */
export const PRISM_TRIANGLE: Triangle = (() => {
  const circumradius = PRISM_SIDE / Math.sqrt(3);
  const vertex = (degrees: number): Vec2 => {
    const spun = rotate([circumradius, 0], radians(degrees + PRISM_TILT_DEGREES));
    return [PRISM_CENTROID[0] + spun[0], PRISM_CENTROID[1] + spun[1]];
  };
  return { a: vertex(90), b: vertex(210), c: vertex(330) };
})();

/** Midpoint of the face the beam enters, and the point the lamp is aimed at. */
export const PRISM_ENTRY_FACE_MIDPOINT: Vec2 = [
  (PRISM_TRIANGLE.a[0] + PRISM_TRIANGLE.b[0]) / 2,
  (PRISM_TRIANGLE.a[1] + PRISM_TRIANGLE.b[1]) / 2,
];

/**
 * How far outside the frame the lamp sits — and the reason there is a rainbow at
 * all.
 *
 * Dispersion spreads this glass by about 16 degrees, so any blur wider than that
 * washes the fan back to white, and a nearby lamp is exactly that blur: rays
 * reaching different parts of the entry face arrive at different angles of
 * incidence and leave over a spread of their own. Measured with the lamp 1.15
 * units away, a single wavelength left over a 20-degree spread and the picture
 * was a white smear with colored edges. At 6.5 units the beam is collimated to
 * 1.3 degrees per wavelength and the colors separate. Real prism photographs use
 * sunlight or a slit for the same reason, never a bare bulb up close.
 */
export const PRISM_LAMP_DISTANCE = 6.5;

/**
 * Angle of incidence on the entry face, in degrees, for the default view.
 *
 * A 60-degree apex forces the two internal angles to sum to 60, so a beam that
 * enters too straight-on meets the exit face beyond the critical angle. What
 * happens then is not that the ray dies: it reflects internally and leaves
 * through the base instead, on a completely different heading, which drains that
 * wavelength out of the fan. Measured, the switch happens below 44 degrees for
 * the stylized glass and below 48 for dense flint, whose higher index has a
 * shallower critical angle. 50 degrees keeps every preset's whole spectrum on the
 * exit face with a couple of degrees to spare, and still sits well off minimum
 * deviation, where the fan is widest: 16.2 degrees of spread against 13.2 at 60.
 */
export const PRISM_INCIDENCE_DEGREES = 50;

/**
 * The arc the pointer can swing the lamp along, in degrees of incidence.
 *
 * Both ends show something. Towards 44 the fan opens to 23 degrees and dense
 * flint visibly loses its violet end to the critical angle — swinging down there
 * is how the example demonstrates it. Towards 58 the fan narrows to 13.5 and
 * flattens out across the frame. The clamp keeps the default view clear of the
 * lower cliff, where the stylized glass would start shedding violet too.
 */
export const PRISM_INCIDENCE_ARC = { min: 44, max: 58 } as const;

/**
 * The lamp for a given angle of incidence on the entry face.
 *
 * The prism never moves. The lamp swings around it on a fixed radius, always
 * aimed at the middle of the entry face, so incidence is the only thing the
 * pointer changes.
 */
export function lampForIncidence(incidenceDegrees: number): SpotLight {
  const face: Vec2 = [
    PRISM_TRIANGLE.b[0] - PRISM_TRIANGLE.a[0],
    PRISM_TRIANGLE.b[1] - PRISM_TRIANGLE.a[1],
  ];
  const faceLength = Math.hypot(face[0], face[1]);
  // Outward normal of a counter-clockwise edge, flipped to point into the glass:
  // a beam along it would strike the face head on, at zero incidence.
  const inward: Vec2 = [-face[1] / faceLength, face[0] / faceLength];
  const direction = rotate(inward, radians(incidenceDegrees));
  return {
    center: [
      PRISM_ENTRY_FACE_MIDPOINT[0] - direction[0] * PRISM_LAMP_DISTANCE,
      PRISM_ENTRY_FACE_MIDPOINT[1] - direction[1] * PRISM_LAMP_DISTANCE,
    ],
    direction,
    // A disc this small subtends 0.9 degrees from the glass, against the 16
    // degrees dispersion opens. That ratio is what decides whether neighbouring
    // wavelengths land on distinguishable bands or on top of each other.
    radius: 0.05,
    // Narrow enough that the beam lands entirely on the entry face. A wider cone
    // spills onto the base face and past the apex, and both spills show up as
    // extra bands in the picture.
    innerAngle: 0.008,
    outerAngle: 0.018,
  };
}

/** The default lamp, at `PRISM_INCIDENCE_DEGREES`. */
export const PRISM_LIGHT: SpotLight = lampForIncidence(PRISM_INCIDENCE_DEGREES);

/** Where `PRISM_INCIDENCE_DEGREES` sits on `PRISM_INCIDENCE_ARC`, in [0, 1]. */
export const PRISM_DEFAULT_ARC = (PRISM_INCIDENCE_DEGREES - PRISM_INCIDENCE_ARC.min)
  / (PRISM_INCIDENCE_ARC.max - PRISM_INCIDENCE_ARC.min);

/** Visible wavelength range the tracer samples, in nanometres. */
export const PRISM_WAVELENGTHS = { min: 400, max: 700 } as const;

/** Rays cast per fragment per frame. */
export const PRISM_RAYS_PER_FRAGMENT = 16;

/** Internal reflections a ray may take before the tracer gives up on it. */
export const PRISM_MAX_INTERNAL_BOUNCES = 3;

/** Scales the traced estimator into display range. */
export const PRISM_EXPOSURE = 52;

/** Brightness of the direct term that makes the incoming beam visible. */
export const PRISM_HAZE = 0.05;
