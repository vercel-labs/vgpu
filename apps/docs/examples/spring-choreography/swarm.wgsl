// One thread per particle. A particle's position is a pure function of the
// timeline: its point on the base shape plus, for every morph still in flight,
// the step to the next shape scaled by the baked Motion spring at the
// particle's own time (the cue's elapsed time minus its stagger delay). The
// same spring's velocity stretches and colours it. The pointer field and click
// bursts then displace it in screen space, and the record for the sprite pass
// is written out.

import { hashU32, unitFloat } from "@vgpu/wgsl-std/hash";
import { simplex3d } from "@vgpu/wgsl-std/noise/simplex";

const TAU = 6.2831853;
const LOOP = 22.5;
const SPRING_SAMPLES = 1024u;
const STAGGER_BASE = 2048u;
const STAGGER_BINS = 256u;
const BURST_ROW = 3u;
const BURST_REACH = 2.4;
const MAX_STREAK_PX = 56.0;

struct Params {
  viewProjection: mat4x4f,
  resolution: vec2f,
  pointer: vec2f,
  pointerVelocity: vec2f,
  pointerStrength: f32,
  pointerRadius: f32,
  time: f32,
  springDuration: f32,
  springPeak: f32,
  spread: f32,
  count: u32,
  activeCount: u32,
  baseShape: u32,
  colorMode: u32,
  energy: f32,
  size: f32,
  streak: f32,
  yaw: f32,
  pixelRatio: f32,
  pad: f32,
}

struct Segment {
  source: u32,
  goal: u32,
  coord: u32,
  row: u32,
  elapsed: f32,
  originX: f32,
  originY: f32,
  reach: f32,
}

struct Burst {
  origin: vec2f,
  age: f32,
  amplitude: f32,
}

struct State {
  segments: array<Segment, 4>,
  bursts: array<Burst, 4>,
}

struct Particle {
  ndc: vec2f,
  streak: vec2f,
  color: vec3f,
  size: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> tables: array<f32>;
@group(0) @binding(2) var<storage, read> state: State;
@group(0) @binding(3) var<storage, read_write> particles: array<Particle>;

struct Seed {
  u: f32,
  v: f32,
  w: f32,
  x: f32,
  y: f32,
}

// u, v: the R2 low-discrepancy sequence in fixed point, so 2D parametrisations
// fill evenly; w, x, y: independent integer hashes.
fn seedFor(i: u32) -> Seed {
  let u = f32((i * 3242174889u + 2147483648u) >> 8u) / 16777216.0;
  let v = f32((i * 2447445414u + 2147483648u) >> 8u) / 16777216.0;
  let h = hashU32(i * 747796405u + 2891336453u);
  let g = hashU32(h ^ 0x9e3779b9u);
  return Seed(u, v, unitFloat(h), unitFloat(g), unitFloat(hashU32(g + 0x68bc21ebu)));
}

struct Point {
  pos: vec3f,
  color: vec3f,
}

fn rotateY(p: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

fn rotateX(p: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

// Every shape's own motion completes a whole number of cycles per loop, so the
// loop seam is seamless even for particles still on their way.
fn loopPhase(t: f32) -> f32 {
  return t / LOOP * TAU;
}

// The hello triangle: barycentric red, green and blue, facing the camera.
fn triangle(seed: Seed) -> Point {
  let a = vec3f(0.0, 1.02, 0.0);
  let b = vec3f(-1.1, -0.82, 0.0);
  let c = vec3f(1.1, -0.82, 0.0);
  var bary: vec3f;
  if (seed.w < 0.3) {
    // A third of the particles trace the edges so the outline stays crisp.
    let f = seed.u;
    let edge = u32(seed.x * 3.0);
    if (edge == 0u) {
      bary = vec3f(1.0 - f, f, 0.0);
    } else if (edge == 1u) {
      bary = vec3f(0.0, 1.0 - f, f);
    } else {
      bary = vec3f(f, 0.0, 1.0 - f);
    }
  } else {
    var p = vec2f(seed.u, seed.v);
    if (p.x + p.y > 1.0) {
      p = 1.0 - p;
    }
    bary = vec3f(1.0 - p.x - p.y, p.x, p.y);
  }
  let depth = (seed.y - 0.5) * 0.05;
  let pos = a * bary.x + b * bary.y + c * bary.z + vec3f(0.0, 0.0, depth);
  let color = vec3f(1.0, 0.13, 0.2) * bary.x + vec3f(0.16, 1.0, 0.38) * bary.y + vec3f(0.2, 0.38, 1.0) * bary.z;
  return Point(rotateY(pos, params.yaw), color * 1.15);
}

// A banded planet with a tilted ring.
fn sphere(seed: Seed, t: f32) -> Point {
  if (seed.w < 0.27) {
    let r = 1.1 + 0.42 * seed.v;
    let a = seed.u * TAU + loopPhase(t);
    var p = vec3f(cos(a) * r, (seed.y - 0.5) * 0.012, sin(a) * r);
    p = rotateX(p, 0.42);
    let bands = 0.55 + 0.45 * sin(r * 70.0) * sin(r * 23.0);
    return Point(p, vec3f(1.0, 0.64, 0.32) * (0.45 + 0.75 * bands));
  }
  let z = 1.0 - 2.0 * seed.v;
  let rho = sqrt(max(0.0, 1.0 - z * z));
  let a = seed.u * TAU - loopPhase(t);
  let p = vec3f(rho * cos(a), z, rho * sin(a)) * 0.8;
  let latitude = pow(0.5 + 0.5 * cos(z * 42.0), 10.0);
  let color = mix(vec3f(0.12, 0.72, 1.0), vec3f(0.62, 0.3, 1.0), 0.5 + 0.5 * z) * (0.8 + 1.2 * latitude);
  return Point(rotateX(p, 0.42), color);
}

fn knotCurve(phi: f32) -> vec3f {
  let r = 2.0 + cos(3.0 * phi);
  return vec3f(r * cos(2.0 * phi), sin(3.0 * phi) * 1.1, r * sin(2.0 * phi)) * 0.34;
}

// A (2, 3) torus knot; particles flow along the tube once per loop.
fn knot(seed: Seed, t: f32) -> Point {
  let along = fract(seed.u + t / LOOP);
  let phi = along * TAU;
  let center = knotCurve(phi);
  let tangent = normalize(knotCurve(phi + 0.002) - knotCurve(phi - 0.002));
  let normal = normalize(cross(tangent, vec3f(0.0, 1.0, 0.0)));
  let binormal = cross(tangent, normal);
  let theta = seed.v * TAU;
  let radius = select(0.13 * sqrt(seed.x), 0.13, seed.w < 0.8);
  let pos = center + (normal * cos(theta) + binormal * sin(theta)) * radius;
  let hue = along * 2.0;
  let color = 0.5 + 0.5 * cos(TAU * (vec3f(hue) + vec3f(0.0, 0.36, 0.64)));
  return Point(pos, (color * color + 0.08) * 1.35);
}

// Three logarithmic arms around a warm bulge, turning once per loop.
fn galaxy(seed: Seed, t: f32) -> Point {
  if (seed.w < 0.14) {
    let z = 1.0 - 2.0 * seed.v;
    let rho = sqrt(max(0.0, 1.0 - z * z));
    let a = seed.u * TAU;
    let r = 0.3 * pow(seed.x, 1.6);
    let p = vec3f(rho * cos(a), z * 0.55, rho * sin(a)) * r;
    return Point(rotateY(p, -loopPhase(t)), vec3f(1.0, 0.78, 0.5) * 1.3);
  }
  // An exponential disk, cut off at r = 1.6 and faded out before it: no hard rim.
  let r = 0.14 - 0.4 * log(1.0 - seed.u * 0.975);
  let arm = floor(seed.x * 3.0);
  // Logistic scatter across the arm: a dense spine with soft, unbounded edges.
  // A quarter of the particles fill the disk between the arms.
  let v = clamp(seed.v, 0.001, 0.999);
  let scatter = log(v / (1.0 - v)) * select(0.075, 0.5, fract(seed.x * 3.0) < 0.25);
  let angle = arm * TAU / 3.0 + log(r / 0.14) * 2.1 + scatter * (0.35 + 0.12 / r) - loopPhase(t);
  let height = (seed.y - 0.5) * 0.07 * (1.3 - r * 0.7);
  let pos = vec3f(cos(angle) * r, height, sin(angle) * r);
  let inner = vec3f(1.0, 0.62, 0.9);
  let outer = vec3f(0.28, 0.52, 1.0);
  var color = mix(inner, outer, smoothstep(0.2, 1.3, r)) * (0.45 + 0.8 * exp(-abs(scatter) * 4.0));
  if (fract(seed.y * 37.0) < 0.035) {
    // Sparse star-forming knots along the arms.
    color = vec3f(1.0, 0.32, 0.6) * 2.2;
  }
  return Point(pos, color * (1.0 - smoothstep(1.2, 1.62, r)));
}

// A rippling lattice: most particles sit on grid lines, so it reads as a mesh.
fn waves(seed: Seed, t: f32) -> Point {
  var x = (seed.u - 0.5) * 3.4;
  var z = (seed.v - 0.5) * 2.4;
  if (seed.w < 0.4) {
    x = round(x * 10.0) / 10.0;
  } else if (seed.w < 0.8) {
    z = round(z * 10.0) / 10.0;
  }
  let d = length(vec2f(x, z + 0.3));
  let phase = loopPhase(t);
  let height = 0.19 * sin(d * 5.5 - phase * 6.0) * exp(-d * 0.4) + 0.07 * sin(x * 2.4 + phase * 3.0);
  let crest = clamp(height * 3.2 + 0.5, 0.0, 1.0);
  var color = mix(vec3f(0.08, 0.22, 0.95), vec3f(0.2, 0.95, 1.0), crest) + vec3f(pow(crest, 6.0) * 0.9);
  let edge = max(abs(x) / 1.7, abs(z) / 1.2);
  color *= 1.0 - 0.75 * smoothstep(0.7, 1.0, edge);
  return Point(vec3f(x, height - 0.05, z), color);
}

fn shapeAt(id: u32, seed: Seed, t: f32) -> Point {
  switch id {
    case 0u: { return triangle(seed); }
    case 1u: { return sphere(seed, t); }
    case 2u: { return knot(seed, t); }
    case 3u: { return galaxy(seed, t); }
    default: { return waves(seed, t); }
  }
}

// Position and velocity (per second) of the unit spring step at tau seconds.
fn springAt(tau: f32) -> vec2f {
  if (tau <= 0.0) {
    return vec2f(0.0);
  }
  if (tau >= params.springDuration) {
    return vec2f(1.0, 0.0);
  }
  let f = tau / params.springDuration * f32(SPRING_SAMPLES - 1u);
  let i = u32(f);
  let j = min(i + 1u, SPRING_SAMPLES - 1u);
  let a = vec2f(tables[i * 2u], tables[i * 2u + 1u]);
  let b = vec2f(tables[j * 2u], tables[j * 2u + 1u]);
  return mix(a, b, f - f32(i));
}

// Motion's stagger() delay for a 0..1 pattern coordinate.
fn staggerAt(row: u32, coord: f32) -> f32 {
  let f = clamp(coord, 0.0, 1.0) * f32(STAGGER_BINS - 1u);
  let i = u32(f);
  let j = min(i + 1u, STAGGER_BINS - 1u);
  let base = STAGGER_BASE + row * STAGGER_BINS;
  return mix(tables[base + i], tables[base + j], f - f32(i));
}

fn project(p: vec3f) -> vec3f {
  let clip = params.viewProjection * vec4f(p, 1.0);
  let w = max(clip.w, 0.05);
  return vec3f(clip.xy / w, clip.w);
}

fn aspectScale() -> vec2f {
  return vec2f(params.resolution.x / max(params.resolution.y, 1.0), 1.0);
}

fn staggerCoord(segment: Segment, start: vec3f) -> f32 {
  switch segment.coord {
    // Radius from the centre of the shape being left.
    case 0u: { return length(start) / 1.3; }
    // Horizontal screen position.
    case 1u: { return project(start).x * 0.5 + 0.5; }
    // Smooth noise patches, different for every cue.
    case 2u: { return 0.5 + 0.62 * simplex3d(start * 2.4 + vec3f(f32(segment.source) * 3.7, 0.0, 0.0)); }
    // Angle around the vertical axis, wound by radius.
    case 3u: { return fract(atan2(start.z, start.x) / TAU + 0.5 + length(start.xz) * 0.45); }
    // Screen distance from where the pointer was when the cue fired.
    default: {
      let offset = (project(start).xy - vec2f(segment.originX, segment.originY)) * aspectScale();
      return length(offset) * segment.reach;
    }
  }
}

// Blue while waiting and closing in, white on arrival, orange-pink past the
// target and violet on the way back: the spring's phase made visible.
fn phaseColor(motion: vec3f) -> vec3f {
  if (motion.z < 0.5) {
    return vec3f(0.2, 0.3, 0.85) * 0.55;
  }
  let s = motion.x;
  let v = motion.y;
  if (s > 1.0) {
    let over = clamp((s - 1.0) * 5.0, 0.0, 1.0);
    return mix(vec3f(1.0, 0.58, 0.16), vec3f(1.0, 0.22, 0.52), over) * (1.3 + over * 1.4);
  }
  if (v < 0.0) {
    return vec3f(0.6, 0.3, 1.0) * 1.2;
  }
  return mix(vec3f(0.08, 0.42, 1.0), vec3f(1.0), s * s * s) * (0.9 + s * 0.5);
}

fn inferno(x: f32) -> vec3f {
  let t = clamp(x, 0.0, 1.0);
  let low = mix(vec3f(0.2, 0.12, 0.75), vec3f(0.95, 0.2, 0.45), smoothstep(0.0, 0.45, t));
  let high = mix(vec3f(1.0, 0.55, 0.1), vec3f(1.0, 0.97, 0.75), smoothstep(0.7, 1.0, t));
  return mix(low, high, smoothstep(0.35, 0.75, t)) * (1.0 + t * 1.4);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) {
    return;
  }
  let seed = seedFor(i);
  let t = params.time;

  var prev = shapeAt(params.baseShape, seed, t);
  var position = prev.pos;
  var color = prev.color;
  var velocity = vec3f(0.0);
  var overshoot = 0.0;
  // Spring position, velocity and state (0 at rest, 1 in motion) of the newest morph in flight.
  var motion = vec3f(1.0, 0.0, 0.0);
  for (var k = 0u; k < params.activeCount; k++) {
    let segment = state.segments[k];
    let to = shapeAt(segment.goal, seed, t);
    // The pattern reads the shape being left as it was when the cue fired, so
    // each particle's delay holds for the whole morph while the shapes turn.
    let start = shapeAt(segment.source, seed, t - segment.elapsed).pos;
    let delay = staggerAt(segment.row, staggerCoord(segment, start)) + seed.y * 0.08 * params.spread;
    let tau = segment.elapsed - delay;
    let s = springAt(tau);
    let step = to.pos - prev.pos;
    position += step * s.x;
    velocity += step * s.y;
    color += (to.color - prev.color) * clamp(s.x, 0.0, 1.0);
    overshoot += max(s.x - 1.0, 0.0) * length(step);
    if (tau > 0.0 && tau < params.springDuration) {
      motion = vec3f(s, 1.0);
    }
    prev = to;
  }

  // Only the fast flight streaks; the settling wobble stays a crisp spark.
  let speed = length(velocity) / max(params.springPeak * 1.6, 1e-3);
  let head = project(position);
  var ndc = head.xy;
  let tail = project(position - velocity * params.streak * smoothstep(0.12, 0.7, speed));
  let aspect = aspectScale();
  var streak = (ndc - tail.xy) * aspect;
  var heat = 0.0;

  // Pointer: a Gaussian push around the (sprung) cursor plus a wake along its velocity.
  let toParticle = (ndc - params.pointer) * aspect;
  let radius = params.pointerRadius * 2.0 / max(params.resolution.y, 1.0);
  let r2 = dot(toParticle, toParticle);
  let field = exp(-r2 / max(radius * radius, 1e-6)) * params.pointerStrength;
  let wake = exp(-r2 / max(radius * radius * 2.5, 1e-6)) * params.pointerStrength;
  var offset = toParticle / max(sqrt(r2), 1e-4) * radius * 0.6 * field + params.pointerVelocity * 0.045 * wake;
  heat += field * 0.7;

  // Bursts: a ring that leaves the click point with Motion's stagger and moves
  // every particle by the spring's impulse response s'(τ) / max s'.
  for (var b = 0u; b < 4u; b++) {
    let burst = state.bursts[b];
    if (burst.amplitude <= 0.0) {
      continue;
    }
    let d = (ndc - burst.origin) * aspect;
    let r = length(d);
    let tau = burst.age - staggerAt(BURST_ROW, r / BURST_REACH);
    let fall = burst.amplitude / (1.0 + r * r * 3.0);
    let dir = d / max(r, 1e-3);
    let now = springAt(tau).y / params.springPeak;
    let before = springAt(tau - params.streak).y / params.springPeak;
    offset += dir * fall * now;
    streak += dir * fall * (now - before);
    heat += abs(now) * fall * 5.0;
  }
  ndc += offset / aspect;

  // Keep very fast streaks readable instead of screen-wide smears.
  let streakPx = streak * params.resolution.y * 0.5;
  let streakLength = length(streakPx);
  let maxStreak = MAX_STREAK_PX * params.pixelRatio;
  if (streakLength > maxStreak) {
    streak *= maxStreak / streakLength;
  }

  var shade: vec3f;
  switch params.colorMode {
    case 1u: { shade = inferno(speed); }
    case 2u: { shade = phaseColor(motion); }
    default: {
      shade = color * (1.0 + speed * 0.6) + vec3f(1.0, 0.5, 0.18) * overshoot * 3.5;
    }
  }
  shade += vec3f(1.0, 0.62, 0.3) * heat;

  var out: Particle;
  out.ndc = ndc;
  out.streak = streak / aspect;
  out.color = shade * params.energy * (0.7 + 0.6 * seed.w);
  let perspective = clamp(4.7 / head.z, 0.6, 1.8);
  out.size = select(0.0, params.size * params.pixelRatio * perspective * (0.75 + 0.5 * seed.x), head.z > 0.05);
  particles[i] = out;
}
