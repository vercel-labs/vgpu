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
  stylized: { base: 1.245, strength: 0.06 },
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
 * `glass` is the final scene after Pass B. `back` presents Pass A after its
 * external-light, back-face and internal-light draws. `wall` and `caustic` are
 * retained as programmatic GPU-test isolations; they only skip draws inside
 * Pass A and never allocate another render target or render pass.
 */
export type PrismView = "glass" | "back" | "wall" | "caustic";

/** The two composed outputs retained for programmatic render isolation. */
export const PRISM_VIEW_ORDER = [
  "glass",
  "back",
] as const satisfies readonly PrismView[];

export const PRISM_VIEW_LABELS: Record<PrismView, string> = {
  glass: "Final (Pass B)",
  back: "Pass A (back face + light)",
  wall: "Wall pass",
  caustic: "Light only",
};

export type PrismTheme = "dark" | "light";

export interface GlassTransmissionControls {
  /** Index of refraction used by both rasterized glass interfaces. */
  readonly ior: number;
  /** Beer-Lambert absorption per scene unit, in linear RGB. */
  readonly absorption: readonly [number, number, number];
}

export type GlassTransmissionByTheme = Readonly<
  Record<PrismTheme, GlassTransmissionControls>
>;

export interface GlassReflectionControls {
  /** Multiplier on the studio environment before it is reflected. */
  readonly reflectionStrength: number;
  /** Exposure applied to the studio environment before material response. */
  readonly environmentExposure: number;
}

export type GlassReflectionByTheme = Readonly<
  Record<PrismTheme, GlassReflectionControls>
>;

export interface GlassControls {
  /** Theme-specific transmission response. */
  readonly transmission: GlassTransmissionByTheme;
  /** Theme-specific environment reflection response. */
  readonly reflection: GlassReflectionByTheme;
}

export interface PostprocessControls {
  /** Multiplier applied to the blurred HDR highlights before tone mapping. */
  readonly bloomStrength: number;
  /** Linear-light brightness at which pixels begin contributing to bloom. */
  readonly bloomThreshold: number;
  /** Moves visible bloom energy across its two progressively wider scales. */
  readonly bloomRadius: number;
}

export interface LightFadeControls {
  /** Linear multiplier applied to the complete emissive light sheet. */
  readonly beamOpacity: number;
  /** Exponential concentration from the beam centre toward its side edges. */
  readonly edgeFalloff: number;
  /** Distance scale at which the dispersed outgoing light starts to fade. */
  readonly rainbowFalloffRate: number;
  /** Curvature of the dispersed outgoing light's distance attenuation. */
  readonly rainbowFalloffPower: number;
}

export interface LightWallControls {
  /** Multiplier shared by the large and micro normal layers. */
  readonly normalStrength: number;
  /** Transfer exponent applied to the authored global-light mask. */
  readonly lightmapGamma: number;
  /** Contrast exponent around shadowPivot; 1 preserves the authored mask. */
  readonly shadowContrast: number;
  /** Mask value around which shadow contrast is expanded or compressed. */
  readonly shadowPivot: number;
  /** Base exposure retained in the darkest part of the lightmap. */
  readonly shadowFloor: number;
  /** Base exposure reached in the brightest part of the lightmap. */
  readonly highlightExposure: number;
  /** Neutral incident light added after the wall's direct response. */
  readonly ambientFill: number;
}

export interface LightCausticControls {
  readonly strength: number;
  readonly coverage: number;
  /** Mixes wall-normal response into exterior white and spectral light. */
  readonly normalInfluence: number;
  /** Elevation of the projected beam above the wall plane, in degrees. */
  readonly normalElevation: number;
}

export type LightToneMapping = "aces" | "neutral" | "reinhard" | "clamp";

export interface LightOutputControls {
  /** Linear scene exposure applied before the selected tone mapper. */
  readonly exposure: number;
  readonly toneMapping: LightToneMapping;
}

export interface LightModeControls {
  readonly wall: LightWallControls;
  readonly caustic: LightCausticControls;
  readonly output: LightOutputControls;
}

export interface BeamMouseYControls {
  /** Beam incidence in degrees when the pointer is at the top of the viewport. */
  readonly top: number;
  /** Beam incidence in degrees when the pointer is at the bottom of the viewport. */
  readonly bottom: number;
}

export interface PrismControls {
  readonly dispersion: PrismDispersion;
  /** Optional custom Cauchy coefficients; the selected preset is used when absent. */
  readonly spectralDispersion?: DispersionPreset;
  readonly view: PrismView;
  /** Vertical field of view of the perspective camera, in degrees. */
  readonly cameraFov: number;
  /** Full beam width in scene units, measured perpendicular to its axis. */
  readonly beamWidth: number;
  /** Incidence-angle endpoints controlled by the pointer's vertical position. */
  readonly beamMouseY: BeamMouseYControls;
  /** Visual attenuation of the finite light sheet. */
  readonly lightFade: LightFadeControls;
  /** Look-development parameters used only by the light-mode pipeline. */
  readonly lightMode: LightModeControls;
  /** CSS hex color, interpreted as sRGB before the additive light is applied. */
  readonly wallColor: string;
  /** Draw the generated triangle edges over the glass for topology inspection. */
  readonly wireframe: boolean;
  /** Draw the triangulation of the generated light sheet. */
  readonly lightWireframe: boolean;
  /** Show an orbitable mirror sphere for inspecting the analytic studio environment. */
  readonly environmentDebug: boolean;
  /** Runtime material parameters shared by the front and back glass passes. */
  readonly glass: GlassControls;
  /** HDR operations performed after both glass interfaces. */
  readonly postprocess: PostprocessControls;
}

export const PRISM_DEFAULT_BEAM_WIDTH = 0.025;
export const PRISM_BEAM_WIDTH_RANGE = {
  min: 0.01,
  max: 0.2,
  step: 0.005,
} as const;
export const DEFAULT_BEAM_MOUSE_Y_CONTROLS: BeamMouseYControls = {
  top: -35,
  bottom: 75,
};
export const PRISM_BEAM_MOUSE_Y_RANGES = {
  top: { min: -85, max: 85, step: 1 },
  bottom: { min: -85, max: 85, step: 1 },
} as const;
export const DEFAULT_LIGHT_FADE_CONTROLS: LightFadeControls = {
  beamOpacity: 1,
  edgeFalloff: 16,
  rainbowFalloffRate: 3.8,
  rainbowFalloffPower: 3.7,
};
export const PRISM_LIGHT_FADE_RANGES = {
  beamOpacity: { min: 0, max: 1, step: 0.01 },
  edgeFalloff: { min: 0, max: 16, step: 0.1 },
  rainbowFalloffRate: { min: 0, max: 40, step: 0.1 },
  rainbowFalloffPower: { min: 0.25, max: 8, step: 0.05 },
} as const;
export const PRISM_LIGHT_MODE_RANGES = {
  wall: {
    normalStrength: { min: 0, max: 3, step: 0.05 },
    lightmapGamma: { min: 0.5, max: 4, step: 0.05 },
    shadowContrast: { min: 0.25, max: 8, step: 0.05 },
    shadowPivot: { min: 0.05, max: 0.95, step: 0.01 },
    shadowFloor: { min: 0, max: 1.2, step: 0.01 },
    highlightExposure: { min: 0.25, max: 8, step: 0.01 },
    ambientFill: { min: 0, max: 2.5, step: 0.01 },
  },
  caustic: {
    strength: { min: 0, max: 4, step: 0.01 },
    coverage: { min: 0, max: 1, step: 0.01 },
    normalInfluence: { min: 0, max: 1, step: 0.01 },
    normalElevation: { min: 5, max: 85, step: 1 },
  },
  output: {
    exposure: { min: 0.25, max: 2, step: 0.01 },
  },
} as const;
export const PRISM_LIGHT_TONE_MAPPING_ORDER: readonly LightToneMapping[] = [
  "aces",
  "neutral",
  "reinhard",
  "clamp",
];
export const PRISM_LIGHT_TONE_MAPPING_LABELS: Record<LightToneMapping, string> =
  {
    aces: "ACES",
    neutral: "Neutral",
    reinhard: "Reinhard",
    clamp: "Clamp (none)",
  };
export const PRISM_LIGHT_TONE_MAPPING_CODES: Record<LightToneMapping, number> =
  {
    aces: 0,
    neutral: 1,
    reinhard: 2,
    clamp: 3,
  };
export const DEFAULT_LIGHT_MODE_CONTROLS: LightModeControls = {
  wall: {
    normalStrength: 0.6,
    lightmapGamma: 0.65,
    shadowContrast: 6.85,
    shadowPivot: 0.9,
    shadowFloor: 0.87,
    highlightExposure: 3.31,
    ambientFill: 0.42,
  },
  caustic: {
    strength: 1.9,
    coverage: 0.86,
    normalInfluence: 1,
    normalElevation: 35,
  },
  output: {
    exposure: 1,
    toneMapping: "aces",
  },
};
/** Vertical field of view of the camera looking at the wall, in degrees. */
export const CAMERA_FOV_DEGREES = 48;
/** Fallback camera distance before a DOM framing slot is available. */
export const CAMERA_DISTANCE = 1.25;
export const PRISM_CAMERA_RANGES = {
  fov: { min: 20, max: 70, step: 1 },
} as const;
export const PRISM_GLASS_RANGES = {
  ior: { min: 1, max: 2.5, step: 0.001 },
  reflectionStrength: { min: 0, max: 3, step: 0.01 },
  absorption: { min: 0, max: 1, step: 0.005 },
  environmentExposure: { min: 0, max: 4, step: 0.05 },
} as const;

/** Practical optical-glass Cauchy ranges, widened for stylized experimentation. */
export const PRISM_SPECTRAL_DISPERSION_RANGES = {
  base: { min: 1.2, max: 2.1, step: 0.001 },
  strength: { min: 0, max: 0.2, step: 0.0005 },
} as const;

export const DEFAULT_GLASS_TRANSMISSION: GlassTransmissionByTheme = {
  dark: {
    ior: 1.645,
    absorption: [1, 1, 0.54],
  },
  light: {
    ior: 1.645,
    absorption: [0, 0, 0],
  },
};

export const DEFAULT_GLASS_CONTROLS: GlassControls = {
  transmission: DEFAULT_GLASS_TRANSMISSION,
  reflection: {
    dark: { reflectionStrength: 2.14, environmentExposure: 2.3 },
    light: { reflectionStrength: 3, environmentExposure: 4 },
  },
};

export const PRISM_POSTPROCESS_RANGES = {
  bloomStrength: { min: 0, max: 3, step: 0.05 },
  bloomThreshold: { min: 0, max: 4, step: 0.05 },
  bloomRadius: { min: 0.25, max: 3, step: 0.05 },
} as const;

export const DEFAULT_POSTPROCESS_CONTROLS: PostprocessControls = {
  bloomStrength: 0.7,
  bloomThreshold: 0.1,
  bloomRadius: 0.25,
};

export function clampBeamWidth(width: number): number {
  if (!Number.isFinite(width)) return PRISM_DEFAULT_BEAM_WIDTH;
  return Math.min(
    PRISM_BEAM_WIDTH_RANGE.max,
    Math.max(PRISM_BEAM_WIDTH_RANGE.min, width)
  );
}

export function clampCameraFov(fov: number): number {
  if (!Number.isFinite(fov)) return CAMERA_FOV_DEGREES;
  return Math.min(
    PRISM_CAMERA_RANGES.fov.max,
    Math.max(PRISM_CAMERA_RANGES.fov.min, fov)
  );
}

export const DEFAULT_PRISM_CONTROLS: PrismControls = {
  dispersion: "stylized",
  spectralDispersion: { base: 1.2, strength: 0.1 },
  view: "glass",
  cameraFov: CAMERA_FOV_DEGREES,
  beamWidth: PRISM_DEFAULT_BEAM_WIDTH,
  beamMouseY: DEFAULT_BEAM_MOUSE_Y_CONTROLS,
  lightFade: DEFAULT_LIGHT_FADE_CONTROLS,
  lightMode: DEFAULT_LIGHT_MODE_CONTROLS,
  wallColor: "#000000",
  wireframe: false,
  lightWireframe: false,
  environmentDebug: false,
  glass: DEFAULT_GLASS_CONTROLS,
  postprocess: DEFAULT_POSTPROCESS_CONTROLS,
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
 * it and the fan has the whole lower left quadrant to open into.
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

/** Midpoint of the right face the beam enters, and the default aim point. */
export const PRISM_ENTRY_FACE_MIDPOINT: Vec2 = [
  (PRISM_TRIANGLE.a[0] + PRISM_TRIANGLE.c[0]) / 2,
  (PRISM_TRIANGLE.a[1] + PRISM_TRIANGLE.c[1]) / 2,
];

/** Point along the entry edge, ordered left-to-right as it appears on screen. */
export function prismEntryPoint(position: number): Vec2 {
  const clamped = Math.min(1, Math.max(0, position));
  return [
    PRISM_TRIANGLE.a[0] + (PRISM_TRIANGLE.c[0] - PRISM_TRIANGLE.a[0]) * clamped,
    PRISM_TRIANGLE.a[1] + (PRISM_TRIANGLE.c[1] - PRISM_TRIANGLE.a[1]) * clamped,
  ];
}

/** A finite collimated beam emitted from one point and aimed at another. */
export function collimatedLightBetween(
  center: Vec2,
  target: Vec2,
  beamWidth = PRISM_DEFAULT_BEAM_WIDTH
): CollimatedLight {
  const offset: Vec2 = [target[0] - center[0], target[1] - center[1]];
  const distance = Math.hypot(offset[0], offset[1]);
  if (!Number.isFinite(distance) || distance <= 1e-8) {
    throw new Error(
      "A collimated light needs distinct finite center and target points."
    );
  }
  return {
    center,
    direction: [offset[0] / distance, offset[1] / distance],
    beamHalfWidth: clampBeamWidth(beamWidth) * 0.5,
  };
}

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
 * shallower critical angle. 60 degrees keeps every preset's whole spectrum on
 * the exit face with a comfortable margin and is the neutral midpoint of the
 * homepage's pointer motion.
 */
export const PRISM_INCIDENCE_DEGREES = 60;

/**
 * The arc the pointer can swing the lamp along, in degrees of incidence.
 *
 * The homepage uses a deliberately broad sweep so the source can travel from
 * above the frame to below it. The negative minimum deliberately makes a
 * top-positioned pointer send the beam steeply down through the prism and out
 * through its base. The default remains at 60 degrees.
 */
export const PRISM_INCIDENCE_ARC = {
  min: DEFAULT_BEAM_MOUSE_Y_CONTROLS.top,
  max: DEFAULT_BEAM_MOUSE_Y_CONTROLS.bottom,
} as const;

/** Incidence reached when the pointer crosses the viewport's vertical centre. */
export const PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES = PRISM_INCIDENCE_DEGREES;

/**
 * The lamp for a given angle of incidence on the entry face.
 *
 * The prism never moves. The lamp swings around it on a fixed radius, always
 * aimed at a point along the entry face. The pointer can therefore change the
 * incidence and the point of impact independently.
 */
export function lampForIncidence(
  incidenceDegrees: number,
  beamWidth = PRISM_DEFAULT_BEAM_WIDTH,
  entryPosition = 0.5
): CollimatedLight {
  const face: Vec2 = [
    PRISM_TRIANGLE.a[0] - PRISM_TRIANGLE.c[0],
    PRISM_TRIANGLE.a[1] - PRISM_TRIANGLE.c[1],
  ];
  const faceLength = Math.hypot(face[0], face[1]);
  // Outward normal of a counter-clockwise edge, flipped to point into the glass:
  // a beam along it would strike the face head on, at zero incidence.
  const inward: Vec2 = [-face[1] / faceLength, face[0] / faceLength];
  // Negating incidence mirrors the former left-entry setup exactly: the white
  // beam now arrives from the right and its dispersed output heads left.
  const direction = rotate(inward, radians(-incidenceDegrees));
  const clampedBeamWidth = clampBeamWidth(beamWidth);
  // Keep both finite beam boundaries on the face even when the pointer reaches
  // a viewport edge. At oblique incidence their footprint along the face grows
  // by 1 / cos(incidence).
  const entryMargin = Math.min(
    0.45,
    clampedBeamWidth /
      (2 *
        faceLength *
        Math.max(0.05, Math.abs(Math.cos(radians(incidenceDegrees))))) +
      1e-4
  );
  const entryPoint = prismEntryPoint(
    Math.min(1 - entryMargin, Math.max(entryMargin, entryPosition))
  );
  return collimatedLightBetween(
    [
      entryPoint[0] - direction[0] * PRISM_LAMP_DISTANCE,
      entryPoint[1] - direction[1] * PRISM_LAMP_DISTANCE,
    ],
    entryPoint,
    clampedBeamWidth
  );
}

/** The default lamp, at `PRISM_INCIDENCE_DEGREES`. */
export const PRISM_LIGHT: CollimatedLight = lampForIncidence(
  PRISM_INCIDENCE_DEGREES
);

/** The neutral 60-degree shot sits at the vertical centre of the viewport. */
export const PRISM_DEFAULT_ARC = 0.5;

/** Visible wavelength range the continuous spectral mesh subdivides, in nanometres. */
export const PRISM_WAVELENGTHS = { min: 400, max: 700 } as const;

/** Wavelength vertices connected into the smooth spectral mesh. */
export const PRISM_SPECTRAL_SAMPLES = 64 * 2;

/** Additive sheets that integrate the finite width of the collimated beam. */
export const PRISM_BEAM_SLICES = 24;

/** Display exposure for the finite spectral integral represented by the mesh. */
export const PRISM_LIGHT_EXPOSURE = 88;

/** Internal reflections a ray may take before the analytic solver gives up. */
export const PRISM_MAX_INTERNAL_BOUNCES = 3;

/**
 * How far the triangle is extruded off the wall, towards the camera.
 *
 * The analytic tracer still solves a 2D cross-section, but that result is drawn
 * halfway through this depth. The distance is therefore both a framing decision
 * and the separation that gives the light sheet parallax: enough for the side
 * faces to catch the studio environment and read as a block of glass, little
 * enough that the scene still reads as one compact prism.
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
/** The emissive light sheet crosses halfway between the two glass interfaces. */
export const PRISM_LIGHT_PLANE_Z = (PRISM_BACK_Z + PRISM_FRONT_Z) * 0.5;

/**
 * Transmissive glass, as `vgpu.sh/examples/glass-fractal` shades it.
 *
 * Same parameters and the same responses. Against the near-white wall most of
 * the shell is transmitted light, so the solid is defined by its absorption,
 * Fresnel edges and studio reflections. `reflectionStrength` and
 * `environmentExposure` keep those reflections legible without tinting the wall
 * the prism refracts behind itself.
 */
export interface GlassMaterial extends GlassControls {
  /** XYZ rotation of the studio environment, in degrees. */
  readonly environmentRotation: readonly [number, number, number];
}

export const PRISM_GLASS: GlassMaterial = {
  ...DEFAULT_GLASS_CONTROLS,
  environmentRotation: [0, 0, 0],
};

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

/** Per-frame interpolation towards the pointer's requested lamp position. */
export const LAMP_AIM_LERP = 0.12;
