/**
 * Scene definition for the prism rainbow example.
 *
 * The room is three-dimensional and the light transport is not, which is the
 * whole trick. `z = 0` is the wall: a flat plane facing the camera, `x` growing
 * right and `y` growing up, centred on the origin and sized by `camera.ts` to
 * cover whatever the frame can see of it. The CPU solves the spectral ray bundle
 * in that plane — enter one face, cross the glass, leave through another — and
 * turns its finite width into additive, wavelength-connected mesh sheets. The
 * glass the camera sees is that same triangle extruded towards the viewer by
 * `PRISM_DEPTH`.
 *
 * So the triangle below is read twice: as the two-dimensional obstacle the ray
 * bundle refracts through, and as the cross-section of the three-dimensional prism. One
 * set of vertices, which is what keeps the rainbow registered with the object
 * that made it — the fan always leaves the glass exactly where the model's silhouette
 * meets the wall.
 *
 * Every constant here is derived from four decisions (how big the prism is, how
 * it is tilted, how steeply the beam arrives, and how far away the lamp sits)
 * rather than typed in, because the interesting values are the angles; the
 * vertices only follow from them. `optics.test.ts` asserts the properties the
 * derivation is supposed to guarantee.
 *
 * These constants are also the single source of truth across languages:
 * `optics.ts` traces them directly, `light-mesh.ts` makes the spectral mesh, and
 * `prism-mesh.ts` extrudes them into the solid `glass.wgsl` shades.
 */

export type Vec2 = readonly [number, number];

export interface Triangle {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly c: Vec2;
}

export interface CollimatedLight {
  /** Emitter center, in scene units. */
  readonly center: Vec2;
  /** Unit direction the beam is aimed in. */
  readonly direction: Vec2;
  /** Half the physical width of the collimated beam, perpendicular to its axis. */
  readonly beamHalfWidth: number;
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

export const PRISM_DISPERSION_ORDER: readonly PrismDispersion[] = [
  "stylized",
  "crown",
  "flint",
];

export const PRISM_DISPERSION_LABELS: Record<PrismDispersion, string> = {
  stylized: "Stylized",
  crown: "Crown glass",
  flint: "Dense flint",
};

/**
 * What the frame shows, peeling the picture back one layer at a time.
 *
 * `glass` is the scene. `wall` takes the prism out of the room, which is how you
 * see the whole shadow and the fan the glass would otherwise be standing in front
 * of. `caustic` goes further and shows the light mesh alone over black.
 */
export type PrismView = "glass" | "wall" | "caustic";

export const PRISM_VIEW_ORDER: readonly PrismView[] = [
  "glass",
  "wall",
  "caustic",
];

export const PRISM_VIEW_LABELS: Record<PrismView, string> = {
  glass: "Prism",
  wall: "Wall only",
  caustic: "Light only",
};

export interface PrismControls {
  readonly dispersion: PrismDispersion;
  readonly view: PrismView;
  /** Full beam width in scene units, measured perpendicular to its axis. */
  readonly beamWidth: number;
  /** CSS hex color, interpreted as sRGB before the additive light is applied. */
  readonly wallColor: string;
  /** Draw the generated triangle edges over the glass for topology inspection. */
  readonly wireframe: boolean;
}

export const PRISM_DEFAULT_BEAM_WIDTH = 0.08;
export const PRISM_BEAM_WIDTH_RANGE = { min: 0.01, max: 0.2, step: 0.005 } as const;

export function clampBeamWidth(width: number): number {
  if (!Number.isFinite(width)) return PRISM_DEFAULT_BEAM_WIDTH;
  return Math.min(PRISM_BEAM_WIDTH_RANGE.max, Math.max(PRISM_BEAM_WIDTH_RANGE.min, width));
}

export const DEFAULT_PRISM_CONTROLS: PrismControls = {
  dispersion: "stylized",
  view: "glass",
  beamWidth: PRISM_DEFAULT_BEAM_WIDTH,
  wallColor: "#141414",
  wireframe: false,
};

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

function rotate(point: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    point[0] * cosine - point[1] * sine,
    point[0] * sine + point[1] * cosine,
  ];
}

/** Side length of the equilateral prism, in scene units. */
export const PRISM_SIDE = 0.57;
/** Upright from the resting front camera, so the solid reads as a triangle. */
export const PRISM_TILT_DEGREES = 0;
/**
 * The prism stands at the middle of the wall, so the camera can look straight at
 * it and the fan has the whole lower right quadrant to open into.
 */
export const PRISM_CENTROID: Vec2 = [0, 0];

/**
 * Equilateral prism, apex up, tilted, wound counter-clockwise.
 *
 * The winding matters: `optics.ts` takes each edge's
 * outward normal to be `(edge.y, -edge.x)`, which only points out of the
 * triangle for counter-clockwise vertices.
 */
export const PRISM_TRIANGLE: Triangle = (() => {
  const circumradius = PRISM_SIDE / Math.sqrt(3);
  const vertex = (degrees: number): Vec2 => {
    const spun = rotate(
      [circumradius, 0],
      radians(degrees + PRISM_TILT_DEGREES)
    );
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
export function lampForIncidence(
  incidenceDegrees: number,
  beamWidth = PRISM_DEFAULT_BEAM_WIDTH,
): CollimatedLight {
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
    // A narrow slit-like beam. Its boundaries are parallel, so refraction bends
    // the bundle without focusing it to the infinitesimal point produced by the
    // old point-light estimator.
    beamHalfWidth: clampBeamWidth(beamWidth) * 0.5,
  };
}

/** The default lamp, at `PRISM_INCIDENCE_DEGREES`. */
export const PRISM_LIGHT: CollimatedLight = lampForIncidence(PRISM_INCIDENCE_DEGREES);

/** Where `PRISM_INCIDENCE_DEGREES` sits on `PRISM_INCIDENCE_ARC`, in [0, 1]. */
export const PRISM_DEFAULT_ARC =
  (PRISM_INCIDENCE_DEGREES - PRISM_INCIDENCE_ARC.min) /
  (PRISM_INCIDENCE_ARC.max - PRISM_INCIDENCE_ARC.min);

/** Visible wavelength range the continuous spectral mesh subdivides, in nanometres. */
export const PRISM_WAVELENGTHS = { min: 400, max: 700 } as const;

/** Wavelength vertices connected into the smooth spectral mesh. */
export const PRISM_SPECTRAL_SAMPLES = 64;

/** Additive sheets that integrate the finite width of the collimated beam. */
export const PRISM_BEAM_SLICES = 24;

/** Display exposure for the finite spectral integral represented by the mesh. */
export const PRISM_LIGHT_EXPOSURE = 5.5;

/** Internal reflections a ray may take before the analytic solver gives up. */
export const PRISM_MAX_INTERNAL_BOUNCES = 3;

/**
 * How far the triangle is extruded off the wall, towards the camera.
 *
 * The light mesh lives in the wall plane, so the beam and the fan it
 * paints belong to the cross-section, not to the solid. Depth is therefore a
 * framing decision rather than an optical one: enough for the side faces to catch
 * the studio environment at their own angles and read as a block of glass, little
 * enough that the parallax between the solid's silhouette and the shadow it casts
 * still reads as the object standing in front of the wall.
 */
export const PRISM_DEPTH = 0.3;

/**
 * Gap between the prism's back face and the wall.
 *
 * Only large enough to keep the two surfaces from meeting: coplanar geometry
 * would z-fight, and the refracted lookup at the very edge of the glass would
 * sample the wall it is standing on.
 */
export const PRISM_WALL_GAP = 0.015;

/** The prism occupies `z` in [`PRISM_BACK_Z`, `PRISM_FRONT_Z`]; the wall is `z = 0`. */
export const PRISM_BACK_Z = PRISM_WALL_GAP;
export const PRISM_FRONT_Z = PRISM_WALL_GAP + PRISM_DEPTH;

/**
 * Transmissive glass, as `vgpu.sh/examples/glass-fractal` shades it.
 *
 * Same parameters and the same responses. Against the near-white wall most of
 * the shell is transmitted light, so the solid is defined by its absorption,
 * Fresnel edges and studio reflections. `reflectionStrength` and
 * `environmentExposure` keep those reflections legible without tinting the wall
 * the prism refracts behind itself.
 */
export interface GlassMaterial {
  /** Index of refraction, for both the Fresnel term and the refracted lookup. */
  readonly ior: number;
  /** Multiplier on the studio environment before it is reflected. */
  readonly reflectionStrength: number;
  /** Beer-Lambert absorption per scene unit, in linear RGB. */
  readonly absorption: readonly [number, number, number];
  /** Screen-space blur radius of the transmitted image, in pixels. */
  readonly frostRadius: number;
  /** Red/blue separation of the refracted lookup. */
  readonly dispersion: number;
  /** Strength of the angle-dependent spectral tint on reflections. */
  readonly iridescenceStrength: number;
  /** Spectral tint cycles across the Fresnel range. */
  readonly iridescenceFrequency: number;
  /** XYZ rotation of the studio environment, in degrees. */
  readonly environmentRotation: readonly [number, number, number];
  /** Exposure applied to the studio environment before material response. */
  readonly environmentExposure: number;
}

export const PRISM_GLASS: GlassMaterial = {
  ior: 1.5,
  reflectionStrength: 1.2,
  absorption: [0.1, 0.085, 0.075],
  frostRadius: 1.4,
  dispersion: 0.02,
  iridescenceStrength: 0.08,
  iridescenceFrequency: 2,
  environmentRotation: [0, -36, 0],
  environmentExposure: 1.6,
};

/** Vertical field of view of the camera looking at the wall, in degrees. */
export const CAMERA_FOV_DEGREES = 38;

/**
 * How far the camera sits from the wall.
 *
 * The one real trade-off in the framing, because both sides of it follow from
 * this number alone: closer and the prism grows in the frame — it takes about a
 * fifth of the width here, which leaves the fan the room it needs to open — while
 * further back it shrinks and more wall fits in frame. `camera.ts` derives the wall's
 * size from whatever this is, so moving it cannot break the picture; it only
 * changes how many texels the fan gets.
 */
export const CAMERA_DISTANCE = 2.55;

/**
 * The resting camera is centered on the prism and square to the wall. Hovering
 * may still reveal its depth with a small orbit, but the composed shot is a
 * straight-on elevation with no keystone or perspective bias.
 */
export const CAMERA_YAW_DEGREES = 0;
export const CAMERA_PITCH_DEGREES = 0;

/** Widest angle the pointer can swing the camera off its resting view, in degrees. */
export const CAMERA_ORBIT_DEGREES = 3.5;

/** Per-frame interpolation towards the pointer's camera angle. */
export const CAMERA_ORBIT_LERP = 0.08;
