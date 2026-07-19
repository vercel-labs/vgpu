export interface Vec2 {
  x: number;
  y: number;
}

export interface TriangleVertices {
  top: Vec2;
  left: Vec2;
  right: Vec2;
}

export interface AngularInterval {
  start: number;
  length: number;
  valid: boolean;
}

export const DIRECT_TRIANGLE_TARGET_SCALE = 0.5;
export const DIRECT_TRIANGLE_RAY_COUNT = 32;
export const DIRECT_TRIANGLE_MIN_STEP_PX = 1.5;
export const DIRECT_TRIANGLE_HIT_THRESHOLD_PX = 0.75;
/**
 * Volumetric light absorption (Beer-Lambert extinction) of the medium the triangle floats in
 * — the surrounding smoke/atmosphere eats the light, so far LEDs fade faster than geometric
 * spreading alone. Applied per ray as `exp(-σ·distance)`, on top of the {@link
 * DIRECT_TRIANGLE_FALLOFF_POWER} geometric falloff. This value is the extinction over ONE
 * simulation-height of travel (the pass divides by the sim height → resolution-independent).
 * 0 = off (pure geometric falloff); higher = denser smoke, distant glow absorbed sooner.
 */
export const DIRECT_TRIANGLE_ABSORPTION = 2.0;
export const DIRECT_TRIANGLE_FALLOFF_POWER = 1.0;
// Calibrates the direct raycast result back into the HDR range expected by the
// existing dark/light floor falloff shaders. Rays often hit LEDs tens of pixels
// away, so raw pixel-distance attenuation and the ray-count mean otherwise leave
// radiance near 1e-5..1e-3 and the floor tonemap collapses to a thin black line.
export const DIRECT_TRIANGLE_INTENSITY_SCALE = 50.0;
export const DIRECT_TRIANGLE_MIN_SOURCE_LUMA = 0.001;

const TAU = Math.PI * 2;
const EPSILON = 1e-6;

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const vx = p.x - a.x;
  const vy = p.y - a.y;
  const lenSq = ex * ex + ey * ey;
  const h = Math.min(
    1,
    Math.max(0, lenSq <= EPSILON ? 0 : (vx * ex + vy * ey) / lenSq),
  );
  return Math.hypot(vx - ex * h, vy - ey * h);
}

export function triangleEdgeDistance(
  p: Vec2,
  triangle: TriangleVertices,
): number {
  return Math.min(
    segmentDistance(p, triangle.top, triangle.left),
    segmentDistance(p, triangle.left, triangle.right),
    segmentDistance(p, triangle.right, triangle.top),
  );
}

export function directTriangleTargetSize(size: {
  width: number;
  height: number;
}) {
  return {
    width: Math.max(1, Math.ceil(size.width * DIRECT_TRIANGLE_TARGET_SCALE)),
    height: Math.max(1, Math.ceil(size.height * DIRECT_TRIANGLE_TARGET_SCALE)),
  };
}

export function wrapPi(angle: number): number {
  let wrapped = ((angle + Math.PI) % TAU) - Math.PI;
  if (wrapped < -Math.PI) wrapped += TAU;
  return wrapped;
}

export function triangleSignedArea(triangle: TriangleVertices): number {
  const { top: a, left: b, right: c } = triangle;
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function pointInTriangle(p: Vec2, triangle: TriangleVertices): boolean {
  const { top: a, left: b, right: c } = triangle;
  const area = triangleSignedArea(triangle);
  if (Math.abs(area) <= EPSILON) return false;
  const inv = 1 / area;
  const u = ((b.x - p.x) * (c.y - p.y) - (b.y - p.y) * (c.x - p.x)) * inv;
  const v = ((c.x - p.x) * (a.y - p.y) - (c.y - p.y) * (a.x - p.x)) * inv;
  const w = 1 - u - v;
  return u >= -EPSILON && v >= -EPSILON && w >= -EPSILON;
}

export function triangleAngularInterval(
  p: Vec2,
  triangle: TriangleVertices,
  nearThresholdPx = DIRECT_TRIANGLE_HIT_THRESHOLD_PX,
): AngularInterval {
  if (Math.abs(triangleSignedArea(triangle)) <= EPSILON) {
    return { start: 0, length: 0, valid: false };
  }
  if (pointInTriangle(p, triangle)) {
    return { start: 0, length: 0, valid: false };
  }
  if (triangleEdgeDistance(p, triangle) <= nearThresholdPx) {
    return { start: 0, length: 0, valid: false };
  }

  const center = {
    x: (triangle.top.x + triangle.left.x + triangle.right.x) / 3,
    y: (triangle.top.y + triangle.left.y + triangle.right.y) / 3,
  };
  const centerAngle = Math.atan2(center.y - p.y, center.x - p.x);
  const rel = [triangle.top, triangle.left, triangle.right].map((v) =>
    wrapPi(Math.atan2(v.y - p.y, v.x - p.x) - centerAngle),
  );
  const minRel = Math.min(...rel);
  const maxRel = Math.max(...rel);
  const length = maxRel - minRel;
  if (!(length > EPSILON) || length >= Math.PI) {
    return { start: 0, length: 0, valid: false };
  }
  return { start: wrapPi(centerAngle + minRel), length, valid: true };
}

export function deterministicJitter(seed: Vec2): number {
  const x = Math.sin(seed.x * 12.9898 + seed.y * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function directTriangleRayAngles(
  interval: AngularInterval,
  pixel: Vec2,
  rayCount = DIRECT_TRIANGLE_RAY_COUNT,
): number[] {
  if (!interval.valid || rayCount <= 0) return [];
  const jitter = deterministicJitter(pixel) - 0.5;
  const angles: number[] = [];
  for (let i = 0; i < rayCount; i++) {
    const t = (i + 0.5 + jitter) / rayCount;
    angles.push(interval.start + interval.length * Math.min(1, Math.max(0, t)));
  }
  return angles;
}
