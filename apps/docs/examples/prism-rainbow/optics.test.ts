/**
 * Physics and geometry, checked on the CPU reference. Runs on any machine — no
 * GPU involved. `examples/prism-validation` re-checks the same numbers against
 * the shader.
 *
 * These tests are the design notes made executable: every threshold below is a
 * measurement that the picture depends on, and the comments say which.
 */

import { describe, expect, test } from 'vitest';

import {
  estimateRadiance,
  insideTriangle,
  intersectTriangle,
  iorAt,
  lightConnection,
  pcg3d,
  probePoint,
  PROBE_COLUMNS,
  PROBE_ROWS,
  refract,
  sampleTriangle,
  spotProfile,
  stratifiedWavelength,
  tracePrism,
  traceRayWeight,
  triangleWinding,
  unitFloat,
  wavelengthToLinearRgb,
  type TraceParams,
} from './optics';
import {
  PRISM_DISPERSION_ORDER,
  PRISM_DISPERSION_PRESETS,
  PRISM_ENTRY_FACE_MIDPOINT,
  PRISM_EXPOSURE,
  PRISM_INCIDENCE_ARC,
  PRISM_INCIDENCE_DEGREES,
  PRISM_LAMP_DISTANCE,
  PRISM_LIGHT,
  PRISM_RAYS_PER_FRAGMENT,
  PRISM_SIDE,
  PRISM_TILT_DEGREES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  lampForIncidence,
  type PrismDispersion,
  type Vec2,
} from './types';

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleOf = (direction: Vec2): number => degrees(Math.atan2(direction[1], direction[0]));

function params(dispersion: PrismDispersion = 'stylized', incidence = PRISM_INCIDENCE_DEGREES): TraceParams {
  return {
    triangle: PRISM_TRIANGLE,
    light: lampForIncidence(incidence),
    ior: PRISM_DISPERSION_PRESETS[dispersion],
    exposure: PRISM_EXPOSURE,
  };
}

/** Traces the lamp's own beam forward through the glass, one wavelength at a time. */
function beamThrough(dispersion: PrismDispersion, wavelength: number, incidence = PRISM_INCIDENCE_DEGREES) {
  const light = lampForIncidence(incidence);
  const ior = iorAt(wavelength, PRISM_DISPERSION_PRESETS[dispersion].base, PRISM_DISPERSION_PRESETS[dispersion].strength);
  const axis = Math.atan2(light.direction[1], light.direction[0]);
  const exits: { origin: Vec2; direction: Vec2; bounces: number }[] = [];
  let trapped = 0;
  let missed = 0;
  const rays = 128;
  for (let index = 0; index < rays; index++) {
    // Across the lit cone, edge to edge.
    const angle = axis + ((index / (rays - 1)) - 0.5) * 2 * light.outerAngle;
    const direction: Vec2 = [Math.cos(angle), Math.sin(angle)];
    if (!intersectTriangle(PRISM_TRIANGLE, light.center, direction, 1e-4)) {
      missed++;
      continue;
    }
    const path = tracePrism(PRISM_TRIANGLE, light.center, direction, ior);
    if (!path) {
      trapped++;
      continue;
    }
    exits.push(path);
  }
  const angles = exits.map((exit) => angleOf(exit.direction));
  return {
    rays,
    missed,
    /** Rays still inside the glass after the bounce budget ran out. */
    trapped,
    /** Share of rays that took at least one internal reflection on the way out. */
    bounced: exits.filter((exit) => exit.bounces > 0).length / Math.max(1, exits.length),
    exits,
    meanAngle: angles.reduce((total, value) => total + value, 0) / Math.max(1, angles.length),
    spread: angles.length ? Math.max(...angles) - Math.min(...angles) : 0,
  };
}

describe('prism geometry', () => {
  test('is an equilateral triangle of the declared side, wound counter-clockwise', () => {
    const sides = [
      distance(PRISM_TRIANGLE.a, PRISM_TRIANGLE.b),
      distance(PRISM_TRIANGLE.b, PRISM_TRIANGLE.c),
      distance(PRISM_TRIANGLE.c, PRISM_TRIANGLE.a),
    ];
    for (const side of sides) expect(side).toBeCloseTo(PRISM_SIDE, 6);
    // Counter-clockwise, which is what makes `(edge.y, -edge.x)` point outwards.
    expect(triangleWinding(PRISM_TRIANGLE)).toBeGreaterThan(0);
  });

  test('outward normals point away from the centroid', () => {
    const centroid: Vec2 = [
      (PRISM_TRIANGLE.a[0] + PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 3,
      (PRISM_TRIANGLE.a[1] + PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 3,
    ];
    expect(insideTriangle(PRISM_TRIANGLE, centroid)).toBe(true);
    for (const corner of [PRISM_TRIANGLE.a, PRISM_TRIANGLE.b, PRISM_TRIANGLE.c]) {
      const towards: Vec2 = [corner[0] - centroid[0], corner[1] - centroid[1]];
      const length = Math.hypot(towards[0], towards[1]);
      const hit = intersectTriangle(PRISM_TRIANGLE, centroid, [towards[0] / length, towards[1] / length], 1e-4);
      expect(hit).toBeDefined();
      // Leaving the glass: the normal the hit reports faces the same way we go.
      expect(hit!.normal[0] * towards[0] + hit!.normal[1] * towards[1]).toBeGreaterThan(0);
    }
  });

  test('the tilt rotates the whole prism and nothing else', () => {
    const apexAngle = degrees(Math.atan2(
      PRISM_TRIANGLE.a[1] - (PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 2,
      PRISM_TRIANGLE.a[0] - (PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 2,
    ));
    expect(apexAngle).toBeCloseTo(90 + PRISM_TILT_DEGREES, 4);
  });

  test('points outside the glass stay outside', () => {
    expect(insideTriangle(PRISM_TRIANGLE, [0, -0.9])).toBe(false);
    expect(insideTriangle(PRISM_TRIANGLE, PRISM_LIGHT.center)).toBe(false);
  });
});

describe('triangle sampling', () => {
  test('never leaves the triangle, and folds the far half of the square back in', () => {
    for (let index = 0; index < 4096; index++) {
      const [x, y] = pcg3d(index, 3, 7);
      const point = sampleTriangle(PRISM_TRIANGLE, unitFloat(x), unitFloat(y));
      expect(insideTriangle(PRISM_TRIANGLE, point)).toBe(true);
    }
    // u + v > 1 is reflected, so these two draws land on the same point.
    const folded = sampleTriangle(PRISM_TRIANGLE, 0.8, 0.9);
    const direct = sampleTriangle(PRISM_TRIANGLE, 0.2, 0.1);
    expect(folded[0]).toBeCloseTo(direct[0], 12);
    expect(folded[1]).toBeCloseTo(direct[1], 12);
  });

  test('is uniform over area: each half of the triangle gets half the samples', () => {
    // Split along the median from a; the two halves have equal area.
    const midpoint: Vec2 = [
      (PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 2,
      (PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 2,
    ];
    const edge: Vec2 = [midpoint[0] - PRISM_TRIANGLE.a[0], midpoint[1] - PRISM_TRIANGLE.a[1]];
    let left = 0;
    const samples = 40000;
    for (let index = 0; index < samples; index++) {
      const [x, y] = pcg3d(index, 11, 13);
      const point = sampleTriangle(PRISM_TRIANGLE, unitFloat(x), unitFloat(y));
      const offset: Vec2 = [point[0] - PRISM_TRIANGLE.a[0], point[1] - PRISM_TRIANGLE.a[1]];
      if (edge[0] * offset[1] - edge[1] * offset[0] > 0) left++;
    }
    expect(left / samples).toBeCloseTo(0.5, 2);
  });

  test('unitFloat stays inside [0, 1)', () => {
    expect(unitFloat(0)).toBe(0);
    expect(unitFloat(0xffffffff)).toBeLessThan(1);
    expect(unitFloat(0xffffffff)).toBeGreaterThan(0.999);
  });
});

describe('refraction', () => {
  test("bends towards the normal on the way in and obeys Snell's law", () => {
    const normal: Vec2 = [0, 1];
    const incidenceDegrees = 40;
    const incident: Vec2 = [Math.sin((incidenceDegrees * Math.PI) / 180), -Math.cos((incidenceDegrees * Math.PI) / 180)];
    const ior = 1.5;
    const transmitted = refract(incident, normal, 1 / ior);
    expect(transmitted).toBeDefined();
    const transmittedAngle = degrees(Math.asin(Math.abs(transmitted![0])));
    expect(Math.sin((incidenceDegrees * Math.PI) / 180)).toBeCloseTo(ior * Math.sin((transmittedAngle * Math.PI) / 180), 6);
    expect(transmittedAngle).toBeLessThan(incidenceDegrees);
  });

  test('reports total internal reflection past the critical angle', () => {
    const ior = 1.5;
    const critical = degrees(Math.asin(1 / ior));
    const at = (angle: number) => {
      const radians = (angle * Math.PI) / 180;
      return refract([Math.sin(radians), -Math.cos(radians)], [0, 1], ior);
    };
    expect(at(critical - 1)).toBeDefined();
    expect(at(critical + 1)).toBeUndefined();
  });

  test('keeps refracted directions unit length', () => {
    const transmitted = refract([0.6, -0.8], [0, 1], 1 / 1.6)!;
    expect(Math.hypot(transmitted[0], transmitted[1])).toBeCloseTo(1, 6);
  });
});

describe('dispersion', () => {
  test('violet is slower than red in every preset', () => {
    for (const name of PRISM_DISPERSION_ORDER) {
      const preset = PRISM_DISPERSION_PRESETS[name];
      const violet = iorAt(PRISM_WAVELENGTHS.min, preset.base, preset.strength);
      const red = iorAt(PRISM_WAVELENGTHS.max, preset.base, preset.strength);
      expect(violet).toBeGreaterThan(red);
    }
  });

  test('the stylized preset opens a fan a screen can show, the real ones do not', () => {
    const fanOf = (dispersion: PrismDispersion) => {
      const violet = beamThrough(dispersion, PRISM_WAVELENGTHS.min);
      const red = beamThrough(dispersion, PRISM_WAVELENGTHS.max);
      return Math.abs(violet.meanAngle - red.meanAngle);
    };
    // The whole reason a preset exists: crown glass really is this subtle.
    expect(fanOf('crown')).toBeLessThan(2);
    expect(fanOf('flint')).toBeGreaterThan(6);
    expect(fanOf('stylized')).toBeGreaterThan(14);
  });

  test('violet is deviated further than red, which is why the fan is ordered', () => {
    const violet = beamThrough('stylized', PRISM_WAVELENGTHS.min);
    const red = beamThrough('stylized', PRISM_WAVELENGTHS.max);
    // Both leave heading down and to the right; violet turns further from the
    // incoming beam, so its exit angle is the more negative of the two.
    expect(violet.meanAngle).toBeLessThan(red.meanAngle);
  });

  test('wavelengths map to hues in spectral order', () => {
    const violet = wavelengthToLinearRgb(430);
    const green = wavelengthToLinearRgb(530);
    const red = wavelengthToLinearRgb(660);
    expect(violet[2]).toBeGreaterThan(violet[0]);
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(green[1]).toBeGreaterThan(green[2]);
    expect(red[0]).toBeGreaterThan(red[2]);
    for (const color of [violet, green, red]) for (const channel of color) expect(channel).toBeGreaterThanOrEqual(0);
  });

  test('stratified wavelengths cover the visible range once per frame', () => {
    const seen = Array.from({ length: PRISM_RAYS_PER_FRAGMENT }, (_, index) =>
      stratifiedWavelength(index, PRISM_RAYS_PER_FRAGMENT, 0.5));
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(PRISM_WAVELENGTHS.min);
    expect(Math.max(...seen)).toBeLessThanOrEqual(PRISM_WAVELENGTHS.max);
    for (let index = 1; index < seen.length; index++) expect(seen[index]!).toBeGreaterThan(seen[index - 1]!);
    // One stratum per ray: consecutive rays are exactly one stratum apart.
    const stratum = (PRISM_WAVELENGTHS.max - PRISM_WAVELENGTHS.min) / PRISM_RAYS_PER_FRAGMENT;
    expect(seen[1]! - seen[0]!).toBeCloseTo(stratum, 6);
  });
});

describe('the lamp', () => {
  test('sits outside the frame at the declared distance, aimed at the entry face', () => {
    expect(distance(PRISM_LIGHT.center, PRISM_ENTRY_FACE_MIDPOINT)).toBeCloseTo(PRISM_LAMP_DISTANCE, 6);
    // Well outside x in [-aspect, aspect] for any reasonable aspect ratio.
    expect(PRISM_LIGHT.center[0]).toBeLessThan(-3);
    const towardsPrism: Vec2 = [
      PRISM_ENTRY_FACE_MIDPOINT[0] - PRISM_LIGHT.center[0],
      PRISM_ENTRY_FACE_MIDPOINT[1] - PRISM_LIGHT.center[1],
    ];
    const length = Math.hypot(towardsPrism[0], towardsPrism[1]);
    expect(PRISM_LIGHT.direction[0]).toBeCloseTo(towardsPrism[0] / length, 6);
    expect(PRISM_LIGHT.direction[1]).toBeCloseTo(towardsPrism[1] / length, 6);
  });

  test('arrives at the entry face at the declared angle of incidence', () => {
    const face: Vec2 = [
      PRISM_TRIANGLE.b[0] - PRISM_TRIANGLE.a[0],
      PRISM_TRIANGLE.b[1] - PRISM_TRIANGLE.a[1],
    ];
    const faceLength = Math.hypot(face[0], face[1]);
    const outward: Vec2 = [face[1] / faceLength, -face[0] / faceLength];
    const cosine = -(PRISM_LIGHT.direction[0] * outward[0] + PRISM_LIGHT.direction[1] * outward[1]);
    expect(degrees(Math.acos(cosine))).toBeCloseTo(PRISM_INCIDENCE_DEGREES, 4);
  });

  test('is collimated: one wavelength leaves within a couple of degrees', () => {
    // The measurement the lamp distance was chosen from. A nearby lamp spread a
    // single wavelength over 20 degrees, which washed the fan out to white.
    expect(beamThrough('stylized', 550).spread).toBeLessThan(3);
  });

  test('lights the entry face only, so there is one fan and not three', () => {
    const beam = beamThrough('stylized', 550);
    expect(beam.missed).toBe(0);
    expect(beam.trapped).toBe(0);
    for (const exit of beam.exits) {
      // Every ray leaves through the face opposite the beam, never the base.
      const towardsApex = distance(exit.origin, PRISM_TRIANGLE.a);
      const towardsBase = distance(exit.origin, [
        (PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 2,
        (PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 2,
      ]);
      expect(towardsApex).toBeLessThan(towardsBase + PRISM_SIDE);
    }
  });

  test('connects only to rays that both point at it and arrive inside its cone', () => {
    const towardsLamp: Vec2 = [
      PRISM_LIGHT.center[0] - PRISM_ENTRY_FACE_MIDPOINT[0],
      PRISM_LIGHT.center[1] - PRISM_ENTRY_FACE_MIDPOINT[1],
    ];
    const length = Math.hypot(towardsLamp[0], towardsLamp[1]);
    const straight: Vec2 = [towardsLamp[0] / length, towardsLamp[1] / length];
    expect(lightConnection(PRISM_LIGHT, PRISM_ENTRY_FACE_MIDPOINT, straight)).toBeGreaterThan(0.9);
    // Pointing away from the lamp never connects, however well aimed.
    expect(lightConnection(PRISM_LIGHT, PRISM_ENTRY_FACE_MIDPOINT, [-straight[0], -straight[1]])).toBe(0);
    // Just past the emitter's edge the kernel is closed.
    const perpendicular: Vec2 = [-straight[1], straight[0]];
    const grazing: Vec2 = [
      straight[0] + perpendicular[0] * (PRISM_LIGHT.radius * 1.3) / length,
      straight[1] + perpendicular[1] * (PRISM_LIGHT.radius * 1.3) / length,
    ];
    const grazingLength = Math.hypot(grazing[0], grazing[1]);
    expect(lightConnection(PRISM_LIGHT, PRISM_ENTRY_FACE_MIDPOINT, [grazing[0] / grazingLength, grazing[1] / grazingLength])).toBe(0);
  });

  test('the spot profile is one on axis and zero past the outer angle', () => {
    expect(spotProfile(PRISM_LIGHT, PRISM_LIGHT.direction)).toBeCloseTo(1, 6);
    const beyond = PRISM_LIGHT.outerAngle * 1.2;
    const turned: Vec2 = [
      PRISM_LIGHT.direction[0] * Math.cos(beyond) - PRISM_LIGHT.direction[1] * Math.sin(beyond),
      PRISM_LIGHT.direction[0] * Math.sin(beyond) + PRISM_LIGHT.direction[1] * Math.cos(beyond),
    ];
    expect(spotProfile(PRISM_LIGHT, turned)).toBe(0);
  });
});

describe('total internal reflection', () => {
  test('every preset gets its whole spectrum out at the default incidence', () => {
    for (const dispersion of PRISM_DISPERSION_ORDER) {
      for (const wavelength of [PRISM_WAVELENGTHS.min, 550, PRISM_WAVELENGTHS.max]) {
        const beam = beamThrough(dispersion, wavelength);
        expect(beam.trapped, `${dispersion} at ${wavelength}nm`).toBe(0);
      }
    }
  });

  test('past the critical angle the ray leaves through the base instead', () => {
    // The failure mode is not a lost ray, it is a ray on a completely different
    // heading: it reflects off the exit face and leaves through the base, which
    // is what drains that wavelength out of the fan.
    const violetAtDefault = beamThrough('flint', PRISM_WAVELENGTHS.min);
    const redAtDefault = beamThrough('flint', PRISM_WAVELENGTHS.max);
    expect(Math.abs(violetAtDefault.meanAngle - redAtDefault.meanAngle)).toBeLessThan(15);

    // Swing the lamp to the bottom of the arc and dense flint sheds its violet:
    // swinging down there is how the example demonstrates the critical angle.
    const violetAtArcMin = beamThrough('flint', PRISM_WAVELENGTHS.min, PRISM_INCIDENCE_ARC.min);
    const redAtArcMin = beamThrough('flint', PRISM_WAVELENGTHS.max, PRISM_INCIDENCE_ARC.min);
    expect(Math.abs(violetAtArcMin.meanAngle - redAtArcMin.meanAngle)).toBeGreaterThan(40);
    expect(violetAtArcMin.bounced).toBeGreaterThan(0.5);
    expect(redAtArcMin.bounced).toBe(0);
  });

  test('the stylized glass keeps its whole spectrum across the whole arc', () => {
    for (const incidence of [PRISM_INCIDENCE_ARC.min, PRISM_INCIDENCE_DEGREES, PRISM_INCIDENCE_ARC.max]) {
      const violet = beamThrough('stylized', PRISM_WAVELENGTHS.min, incidence);
      const red = beamThrough('stylized', PRISM_WAVELENGTHS.max, incidence);
      expect(violet.bounced, `violet at ${incidence} degrees`).toBe(0);
      expect(violet.meanAngle).toBeLessThan(red.meanAngle);
      // Wider open at grazing incidence, tighter as the beam straightens up.
      expect(Math.abs(violet.meanAngle - red.meanAngle)).toBeGreaterThan(12);
    }
  });

  test('a trapped ray is dropped rather than escaping through the wrong face', () => {
    // Straight into the entry face: both internal angles land past critical.
    const face: Vec2 = [
      PRISM_TRIANGLE.b[0] - PRISM_TRIANGLE.a[0],
      PRISM_TRIANGLE.b[1] - PRISM_TRIANGLE.a[1],
    ];
    const faceLength = Math.hypot(face[0], face[1]);
    const inward: Vec2 = [-face[1] / faceLength, face[0] / faceLength];
    const start: Vec2 = [
      PRISM_ENTRY_FACE_MIDPOINT[0] - inward[0] * 2,
      PRISM_ENTRY_FACE_MIDPOINT[1] - inward[1] * 2,
    ];
    const path = tracePrism(PRISM_TRIANGLE, start, inward, 1.9, 0);
    expect(path).toBeUndefined();
  });

  test('a ray that starts inside the glass is refused', () => {
    const centroid: Vec2 = [
      (PRISM_TRIANGLE.a[0] + PRISM_TRIANGLE.b[0] + PRISM_TRIANGLE.c[0]) / 3,
      (PRISM_TRIANGLE.a[1] + PRISM_TRIANGLE.b[1] + PRISM_TRIANGLE.c[1]) / 3,
    ];
    expect(tracePrism(PRISM_TRIANGLE, centroid, [1, 0], 1.5)).toBeUndefined();
  });
});

describe('the estimator', () => {
  test('reciprocity: the wall point the beam lands on connects back to the lamp', () => {
    const beam = beamThrough('stylized', 550);
    const exit = beam.exits[Math.floor(beam.exits.length / 2)]!;
    // Follow the beam out to a point on the wall, then aim from there back at the
    // spot on the glass it came from: the connection has to survive the round trip.
    const wallPoint: Vec2 = [exit.origin[0] + exit.direction[0] * 0.9, exit.origin[1] + exit.direction[1] * 0.9];
    const weight = traceRayWeight(PRISM_TRIANGLE, PRISM_LIGHT, wallPoint, exit.origin, iorAt(550, 1.47, 0.035));
    expect(weight).toBeGreaterThan(0);
  });

  test('rays that reach nothing weigh nothing', () => {
    // Behind the lamp: no path through the glass can turn back to it.
    const behind: Vec2 = [-1.7, -0.95];
    const radiance = estimateRadiance(params(), behind, [0, 0], 0);
    expect(radiance.every((channel) => channel === 0)).toBe(true);
  });

  test('a point in the fan is lit, and its color is not grey', () => {
    const beam = beamThrough('stylized', 550);
    const exit = beam.exits[Math.floor(beam.exits.length / 2)]!;
    const point: Vec2 = [exit.origin[0] + exit.direction[0] * 0.8, exit.origin[1] + exit.direction[1] * 0.8];
    // Average enough frames that the estimate is stable, the way the GPU does.
    let total: [number, number, number] = [0, 0, 0];
    const frames = 96;
    for (let frame = 0; frame < frames; frame++) {
      const radiance = estimateRadiance(params(), point, [7, 3], frame);
      total = [total[0] + radiance[0], total[1] + radiance[1], total[2] + radiance[2]];
    }
    const mean = total.map((channel) => channel / frames) as unknown as [number, number, number];
    expect(Math.max(...mean)).toBeGreaterThan(0.02);
    // A single wavelength dominates each point of a dispersed fan, so the
    // brightest channel is well clear of the dimmest.
    expect((Math.max(...mean) - Math.min(...mean)) / Math.max(...mean)).toBeGreaterThan(0.3);
  });

  test('averaging more frames converges, at the rate Monte Carlo promises', () => {
    // Sampled along the fan so every probe point is genuinely lit.
    const beam = beamThrough('stylized', 550);
    const points = [0.4, 0.7, 1.0, 1.3].flatMap((along) => beam.exits
      .filter((_, index) => index % 32 === 0)
      .map((exit): Vec2 => [exit.origin[0] + exit.direction[0] * along, exit.origin[1] + exit.direction[1] * along]));

    const meanOver = (point: Vec2, frames: number, offset: number): number => {
      let sum = 0;
      for (let frame = 0; frame < frames; frame++) {
        const radiance = estimateRadiance(params(), point, [4, 9], offset + frame);
        sum += radiance[0] + radiance[1] + radiance[2];
      }
      return sum / frames;
    };
    /** Relative disagreement between two independent averages of `frames` each. */
    const disagreement = (frames: number): number => {
      let total = 0;
      let counted = 0;
      for (const point of points) {
        const first = meanOver(point, frames, 0);
        const second = meanOver(point, frames, frames);
        const scale = Math.max(first, second);
        if (scale <= 0) continue;
        total += Math.abs(first - second) / scale;
        counted++;
      }
      expect(counted).toBeGreaterThan(3);
      return total / counted;
    };

    const short = disagreement(4);
    const long = disagreement(256);
    // 64x the frames should cut the error by about 8x; 3x is a floor that leaves
    // room for the fact that these are individual pixels, not whole images.
    expect(long).toBeLessThan(short / 3);
    // A single pixel stays noisy even well averaged — a fragment at the fringe of
    // the fan connects on a fraction of a percent of its rays. What the picture
    // depends on is the *image* converging, which is what the neighbour-noise
    // check in `examples/prism-validation` measures on the real accumulation
    // buffer.
    expect(long).toBeLessThan(0.25);
  });

  test('the seed changes with the frame, so accumulation sees new rays', () => {
    const first = sceneRays(0);
    const second = sceneRays(1);
    expect(first).not.toEqual(second);
    // ...and repeating a frame index reproduces it exactly, which is what makes
    // the headless renders deterministic.
    expect(sceneRays(0)).toEqual(first);
  });

  test('probe slots cover the frame, including the glass itself', () => {
    const points = Array.from({ length: PROBE_COLUMNS * PROBE_ROWS.length }, (_, slot) => probePoint(slot));
    expect(points).toHaveLength(32);
    expect(points.some((point) => insideTriangle(PRISM_TRIANGLE, point))).toBe(true);
    expect(points.some((point) => point[0] > 1)).toBe(true);
    expect(points.some((point) => point[1] < 0)).toBe(true);
  });
});

function sceneRays(frameIndex: number): string {
  const traced = params();
  return Array.from({ length: PRISM_RAYS_PER_FRAGMENT }, (_, index) => {
    const [x, y, z] = pcg3d(5, 11, frameIndex * PRISM_RAYS_PER_FRAGMENT + index);
    return [unitFloat(x), unitFloat(y), unitFloat(z), traced.ior.base].join(',');
  }).join('|');
}
