import { describe, expect, it } from 'vitest';
import { bloomSize, cameraBasis, EARTH_TUNING, orbitPosition, sunDegreesAt, sunDirection } from './planet';

const EPSILON = 1e-6;

function length(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('earth sun', () => {
  it('keeps the 13 degree tilt at every rotation and stays on the unit sphere', () => {
    const tilt = Math.sin((EARTH_TUNING.sun.tiltDegrees * Math.PI) / 180);
    for (const degrees of [0, 37, 90, 128, 274, 359.5]) {
      const direction = sunDirection(degrees);
      expect(length(direction)).toBeCloseTo(1, 6);
      expect(direction[1]).toBeCloseTo(tilt, 6);
    }
  });

  it('starts pointing along +X at the configured seed direction', () => {
    const [x, y, z] = sunDirection(0);
    expect(x).toBeCloseTo(Math.cos((13 * Math.PI) / 180), 6);
    expect(y).toBeCloseTo(Math.sin((13 * Math.PI) / 180), 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('completes exactly one revolution every 360 degrees', () => {
    const start = sunDirection(41);
    const wrapped = sunDirection(41 + 360);
    start.forEach((value, index) => expect(wrapped[index]).toBeCloseTo(value, 6));
  });

  it('advances the rotation linearly with time', () => {
    expect(sunDegreesAt(0)).toBe(0);
    expect(sunDegreesAt(10)).toBeCloseTo(EARTH_TUNING.sun.degreesPerSecond * 10, 6);
  });
});

describe('earth camera', () => {
  it('orbits at the requested radius and clamps the pitch away from the poles', () => {
    const position = orbitPosition({ yaw: 1.1, pitch: 0.3, radius: 8 });
    expect(length(position)).toBeCloseTo(8, 5);
    const overTheTop = orbitPosition({ yaw: 0, pitch: Math.PI, radius: 8 });
    expect(overTheTop[1]).toBeGreaterThan(0);
    expect(length(overTheTop)).toBeCloseTo(8, 5);
  });

  it('builds an orthonormal, right-handed basis pointing at the target', () => {
    const position = orbitPosition({ yaw: 0.62, pitch: 0.16, radius: 7.4 });
    const basis = cameraBasis(position, [0, 0, 0], EARTH_TUNING.camera.fov);
    for (const axis of [basis.right, basis.up, basis.forward]) {
      expect(length(axis)).toBeCloseTo(1, 6);
    }
    expect(Math.abs(dot(basis.right, basis.up))).toBeLessThan(EPSILON);
    expect(Math.abs(dot(basis.right, basis.forward))).toBeLessThan(EPSILON);
    expect(Math.abs(dot(basis.up, basis.forward))).toBeLessThan(EPSILON);
    // Forward must point from the eye toward the origin.
    const toTarget = position.map((value) => -value / length(position)) as unknown as [number, number, number];
    expect(dot(basis.forward, toTarget)).toBeCloseTo(1, 6);
    // Screen up must keep world up on the upper half of the frame.
    expect(basis.up[1]).toBeGreaterThan(0);
  });

  it('matches the half-angle used by the projection matrix', () => {
    const basis = cameraBasis([0, 0, 8], [0, 0, 0], 40);
    expect(basis.tanHalfFov).toBeCloseTo(Math.tan((40 * Math.PI) / 180 / 2), 9);
    // A view ray at the right edge of the frame must sit exactly fov/2 off axis.
    const edge = Math.atan(basis.tanHalfFov);
    expect((edge * 180) / Math.PI).toBeCloseTo(20, 6);
  });
});

describe('earth bloom chain', () => {
  it('keeps the aspect ratio and never exceeds the configured height', () => {
    expect(bloomSize([1280, 720])).toEqual([640, 360]);
    expect(bloomSize([1600, 900])).toEqual([640, 360]);
    // Below the cap, the bloom buffer matches the output.
    expect(bloomSize([320, 180])).toEqual([320, 180]);
  });
});
