/**
 * Physics and geometry, checked on the CPU reference. Runs on any machine — no
 * GPU involved. `examples/prism-validation` checks the resulting ribbons on a
 * real GPU.
 *
 * These tests are the design notes made executable: every threshold below is a
 * measurement that the picture depends on, and the comments say which.
 */

import { describe, expect, test } from 'vitest';

import {
  insideTriangle,
  intersectTriangle,
  iorAt,
  reflect,
  refract,
  tracePrism,
  tracePrismDetailed,
  triangleWinding,
  wavelengthToBeamRgb,
  wavelengthToLinearRgb,
} from './optics';
import {
  PRISM_DISPERSION_ORDER,
  PRISM_DISPERSION_PRESETS,
  PRISM_CENTROID,
  PRISM_ENTRY_FACE_MIDPOINT,
  PRISM_INCIDENCE_ARC,
  PRISM_INCIDENCE_DEGREES,
  PRISM_LAMP_DISTANCE,
  PRISM_LIGHT,
  PRISM_SIDE,
  PRISM_TILT_DEGREES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  collimatedLightBetween,
  lampForIncidence,
  type PrismDispersion,
  type Vec2,
} from '../types';

const degrees = (radians: number): number => (radians * 180) / Math.PI;
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angleOf = (direction: Vec2): number => degrees(Math.atan2(direction[1], direction[0]));
const signedAngleDelta = (a: number, b: number): number =>
  ((a - b + 540) % 360) - 180;
const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
const normalize2 = (value: Vec2): Vec2 => {
  const magnitude = Math.hypot(value[0], value[1]);
  return [value[0] / magnitude, value[1] / magnitude];
};

function edgeFrame(edgeIndex: number): { midpoint: Vec2; outward: Vec2; tangent: Vec2 } {
  const corners = [PRISM_TRIANGLE.a, PRISM_TRIANGLE.b, PRISM_TRIANGLE.c] as const;
  const start = corners[edgeIndex]!;
  const end = corners[(edgeIndex + 1) % corners.length]!;
  const tangent = normalize2([end[0] - start[0], end[1] - start[1]]);
  return {
    midpoint: [(start[0] + end[0]) * 0.5, (start[1] + end[1]) * 0.5],
    outward: [tangent[1], -tangent[0]],
    tangent,
  };
}

/** Traces the lamp's own beam forward through the glass, one wavelength at a time. */
function beamThrough(dispersion: PrismDispersion, wavelength: number, incidence = PRISM_INCIDENCE_DEGREES) {
  const light = lampForIncidence(incidence);
  const ior = iorAt(wavelength, PRISM_DISPERSION_PRESETS[dispersion].base, PRISM_DISPERSION_PRESETS[dispersion].strength);
  const perpendicular: Vec2 = [-light.direction[1], light.direction[0]];
  const exits: { origin: Vec2; direction: Vec2; bounces: number }[] = [];
  let trapped = 0;
  let missed = 0;
  const rays = 128;
  for (let index = 0; index < rays; index++) {
    // Across the finite beam, edge to edge. Every direction remains parallel.
    const offset = ((index / (rays - 1)) * 2 - 1) * light.beamHalfWidth;
    const origin: Vec2 = [
      light.center[0] + perpendicular[0] * offset,
      light.center[1] + perpendicular[1] * offset,
    ];
    if (!intersectTriangle(PRISM_TRIANGLE, origin, light.direction, 1e-4)) {
      missed++;
      continue;
    }
    const path = tracePrism(PRISM_TRIANGLE, origin, light.direction, ior);
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

describe('internal environment reflection', () => {
  test('reflects back into the solid with equal incidence on every inner face', () => {
    const incidence = (28 * Math.PI) / 180;
    for (let edge = 0; edge < 3; edge++) {
      const { midpoint, outward, tangent } = edgeFrame(edge);
      // A ray already in glass approaches this boundary from its inner side.
      const incident: Vec2 = [
        outward[0] * Math.cos(incidence) + tangent[0] * Math.sin(incidence),
        outward[1] * Math.cos(incidence) + tangent[1] * Math.sin(incidence),
      ];
      // This is the exact convention used by glass-back.wgsl: the rasterized
      // back face exposes the normal pointing into the solid.
      const inwardNormal: Vec2 = [-outward[0], -outward[1]];
      const reflected = reflect(incident, inwardNormal);

      expect(Math.hypot(reflected[0], reflected[1])).toBeCloseTo(1, 12);
      expect(dot2(reflected, outward)).toBeCloseTo(-dot2(incident, outward), 12);
      expect(dot2(reflected, tangent)).toBeCloseTo(dot2(incident, tangent), 12);
      expect(dot2(reflected, outward)).toBeLessThan(0);
      expect(insideTriangle(PRISM_TRIANGLE, [
        midpoint[0] + reflected[0] * 1e-3,
        midpoint[1] + reflected[1] * 1e-3,
      ])).toBe(true);
    }
  });

  test('the reflected environment ray reaches another interface before escaping', () => {
    const ior = iorAt(550, PRISM_DISPERSION_PRESETS.stylized.base, PRISM_DISPERSION_PRESETS.stylized.strength);
    const path = tracePrismDetailed(
      PRISM_TRIANGLE,
      PRISM_LIGHT.center,
      PRISM_LIGHT.direction,
      ior,
    );
    expect(path).toBeDefined();
    expect(path!.points).toHaveLength(2);

    const entry = path!.points[0]!;
    const innerFace = path!.points[1]!;
    const insideDirection = normalize2([
      innerFace[0] - entry[0],
      innerFace[1] - entry[1],
    ]);
    const { outward } = edgeFrame(path!.edges[1]!);
    const reflected = reflect(insideDirection, [-outward[0], -outward[1]]);
    const nextHit = intersectTriangle(
      PRISM_TRIANGLE,
      [innerFace[0] + reflected[0] * 1e-4, innerFace[1] + reflected[1] * 1e-4],
      reflected,
      1e-4,
    );

    expect(nextHit).toBeDefined();
    expect(nextHit!.edge).not.toBe(path!.edges[1]);
    expect(dot2(reflected, nextHit!.normal)).toBeGreaterThan(0);
    const environmentDirection = refract(
      reflected,
      [-nextHit!.normal[0], -nextHit!.normal[1]],
      ior,
    );
    expect(environmentDirection).toBeDefined();
    expect(dot2(environmentDirection!, nextHit!.normal)).toBeGreaterThan(0);
    expect(angleOf(environmentDirection!)).not.toBeCloseTo(angleOf(reflected), 3);
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

  test('the stylized preset opens a much wider fan than physical glass', () => {
    const fanOf = (dispersion: PrismDispersion) => {
      const violet = beamThrough(dispersion, PRISM_WAVELENGTHS.min);
      const red = beamThrough(dispersion, PRISM_WAVELENGTHS.max);
      return Math.abs(signedAngleDelta(violet.meanAngle, red.meanAngle));
    };
    // The whole reason a preset exists: crown glass really is this subtle.
    expect(fanOf('crown')).toBeLessThan(2);
    expect(fanOf('flint')).toBeGreaterThan(4);
    expect(fanOf('stylized')).toBeGreaterThan(14);
  });

  test('violet is deviated further than red, which is why the fan is ordered', () => {
    const violet = beamThrough('stylized', PRISM_WAVELENGTHS.min);
    const red = beamThrough('stylized', PRISM_WAVELENGTHS.max);
    // Mirroring the light reverses the signed angular order while preserving
    // the physical fact that violet deviates farther than red.
    expect(signedAngleDelta(violet.meanAngle, red.meanAngle)).toBeGreaterThan(0);
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

  test('beam colors use one D65 exposure and integrate back to neutral white', () => {
    const sum = [0, 0, 0];
    for (let index = 0; index < 128; index++) {
      const wavelength = 400 + (300 * index) / 127;
      const color = wavelengthToBeamRgb(wavelength);
      for (let channel = 0; channel < 3; channel++) {
        expect(color[channel]).toBeGreaterThanOrEqual(0);
        sum[channel] += color[channel]!;
      }
    }
    expect(Math.min(...sum) / Math.max(...sum)).toBeGreaterThan(0.99);

    // The central spectrum stays continuously luminous instead of dipping
    // between the monitor's blue, green and red primaries.
    for (let wavelength = 475; wavelength <= 625; wavelength++) {
      expect(Math.max(...wavelengthToBeamRgb(wavelength))).toBeGreaterThan(0.8);
    }
    expect(Math.max(...wavelengthToBeamRgb(400))).toBeLessThan(0.02);
    expect(Math.max(...wavelengthToBeamRgb(700))).toBeLessThan(0.02);
  });

  test('beam colors follow the continuous CIE spectral locus', () => {
    const violet = wavelengthToBeamRgb(450);
    const cyan = wavelengthToBeamRgb(480);
    const green = wavelengthToBeamRgb(540);
    const yellow = wavelengthToBeamRgb(570);
    const red = wavelengthToBeamRgb(600);
    expect(violet[2]).toBeGreaterThan(violet[0] * 4);
    expect(violet[0]).toBeGreaterThan(0);
    expect(cyan[2]).toBeGreaterThan(cyan[1]);
    expect(cyan[1]).toBeGreaterThan(0.2);
    expect(green[1]).toBeGreaterThan(green[2] * 2);
    expect(yellow[0]).toBeGreaterThan(0.9);
    expect(yellow[1]).toBeGreaterThan(0.9);
    expect(yellow[2]).toBe(0);
    expect(red[0]).toBeGreaterThan(red[1] * 8);
  });

});

describe('the lamp', () => {
  test('can enter and refract through any triangle face', () => {
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const { midpoint, outward, tangent } = edgeFrame(edgeIndex);
      const source: Vec2 = [
        midpoint[0] + outward[0] * 2,
        midpoint[1] + outward[1] * 2,
      ];
      const target: Vec2 = [
        PRISM_CENTROID[0] + tangent[0] * 0.03,
        PRISM_CENTROID[1] + tangent[1] * 0.03,
      ];
      const light = collimatedLightBetween(source, target);
      const path = tracePrismDetailed(
        PRISM_TRIANGLE,
        light.center,
        light.direction,
        iorAt(550, PRISM_DISPERSION_PRESETS.stylized.base, PRISM_DISPERSION_PRESETS.stylized.strength)
      );
      expect(path, `entry edge ${edgeIndex}`).toBeDefined();
      expect(path!.edges[0]).toBe(edgeIndex);
      expect(path!.edges.at(-1)).not.toBe(edgeIndex);
    }
  });

  test('sits outside the frame at the declared distance, aimed at the entry face', () => {
    expect(distance(PRISM_LIGHT.center, PRISM_ENTRY_FACE_MIDPOINT)).toBeCloseTo(PRISM_LAMP_DISTANCE, 6);
    // Well outside x in [-aspect, aspect] for any reasonable aspect ratio.
    expect(PRISM_LIGHT.center[0]).toBeGreaterThan(3);
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
      PRISM_TRIANGLE.a[0] - PRISM_TRIANGLE.c[0],
      PRISM_TRIANGLE.a[1] - PRISM_TRIANGLE.c[1],
    ];
    const faceLength = Math.hypot(face[0], face[1]);
    const outward: Vec2 = [face[1] / faceLength, -face[0] / faceLength];
    const cosine = -(PRISM_LIGHT.direction[0] * outward[0] + PRISM_LIGHT.direction[1] * outward[1]);
    expect(degrees(Math.acos(cosine))).toBeCloseTo(PRISM_INCIDENCE_DEGREES, 4);
  });

  test('can aim from left to right along the entry face', () => {
    const edge: Vec2 = [
      PRISM_TRIANGLE.c[0] - PRISM_TRIANGLE.a[0],
      PRISM_TRIANGLE.c[1] - PRISM_TRIANGLE.a[1],
    ];
    const edgeLengthSquared = dot2(edge, edge);
    const impactPositions: number[] = [];
    for (const position of [0, 0.25, 0.5, 0.75, 1]) {
      const light = lampForIncidence(PRISM_INCIDENCE_DEGREES, undefined, position);
      const impact: Vec2 = [
        light.center[0] + light.direction[0] * PRISM_LAMP_DISTANCE,
        light.center[1] + light.direction[1] * PRISM_LAMP_DISTANCE,
      ];
      impactPositions.push(dot2([
        impact[0] - PRISM_TRIANGLE.a[0],
        impact[1] - PRISM_TRIANGLE.a[1],
      ], edge) / edgeLengthSquared);
    }
    expect(impactPositions[0]).toBeGreaterThan(0);
    expect(impactPositions[2]).toBeCloseTo(0.5, 6);
    expect(impactPositions[4]).toBeLessThan(1);
    expect(impactPositions).toEqual([...impactPositions].sort((a, b) => a - b));
  });

  test('the top pointer extreme sends the light from above and out through the base', () => {
    const light = lampForIncidence(PRISM_INCIDENCE_ARC.min);
    const path = tracePrismDetailed(
      PRISM_TRIANGLE,
      light.center,
      light.direction,
      iorAt(550, PRISM_DISPERSION_PRESETS.stylized.base, PRISM_DISPERSION_PRESETS.stylized.strength)
    );
    expect(light.center[1]).toBeGreaterThan(PRISM_TRIANGLE.a[1]);
    expect(path).toBeDefined();
    expect(path!.edges[0]).toBe(2);
    expect(path!.edges.at(-1)).toBe(1);
  });

  test('is collimated: every boundary of one wavelength leaves in parallel', () => {
    expect(beamThrough('stylized', 550).spread).toBeLessThan(1e-8);
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

    // At the original 44-degree threshold dense flint sheds its violet, even
    // though the homepage interaction can now sweep much farther past it.
    const violetAtArcMin = beamThrough('flint', PRISM_WAVELENGTHS.min, 44);
    const redAtArcMin = beamThrough('flint', PRISM_WAVELENGTHS.max, 44);
    expect(Math.abs(violetAtArcMin.meanAngle - redAtArcMin.meanAngle)).toBeGreaterThan(40);
    expect(violetAtArcMin.bounced).toBeGreaterThan(0.5);
    expect(redAtArcMin.bounced).toBe(0);
  });

  test('the wider pointer arc keeps tracing light through reflected regimes', () => {
    for (const incidence of [PRISM_INCIDENCE_ARC.min, PRISM_INCIDENCE_ARC.max]) {
      const violet = beamThrough('stylized', PRISM_WAVELENGTHS.min, incidence);
      const red = beamThrough('stylized', PRISM_WAVELENGTHS.max, incidence);
      expect(violet.missed, `violet at ${incidence} degrees`).toBe(0);
      expect(red.missed, `red at ${incidence} degrees`).toBe(0);
      expect(violet.trapped, `violet at ${incidence} degrees`).toBe(0);
      expect(red.trapped, `red at ${incidence} degrees`).toBe(0);
    }
    expect(
      beamThrough('stylized', PRISM_WAVELENGTHS.min, PRISM_INCIDENCE_ARC.min).bounced
    ).toBeGreaterThan(0);
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
