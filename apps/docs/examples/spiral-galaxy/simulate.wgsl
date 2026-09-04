// One thread per star: flows it along its stroke, applies the converging
// intro, the drag rotation and the pointer-repel simulation, then writes the
// screen-space record stars.wgsl expands into a quad. Hero stars also publish
// their position for the lens flare, so nothing round-trips through the CPU.

struct Star {
  position: vec3f,
  layer: f32,
  progress: f32,
  across: f32,
  depth: f32,
  brightness: f32,
  scale: f32,
  opacity: f32,
  twinklePhase: f32,
  twinkleRate: f32,
  color: vec3f,
  hero: f32,
  background: f32,
  mass: f32,
  scatterX: f32,
  scatterY: f32,
  scatterZ: f32,
  clearance: f32,
  pad0: f32,
  pad1: f32,
}

struct Layer {
  rotation: vec3f,
  pathOffset: f32,
  sampleBase: f32,
  pathMotion: f32,
  intensity: f32,
  pad: f32,
}

struct Projected {
  ndc: vec2f,
  diameter: f32,
  brightness: f32,
  color: vec3f,
  opacity: f32,
  rays: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

struct Params {
  viewport: vec2f,
  world: vec2f,
  scatter: vec2f,
  pointer: vec2f,
  previous: vec2f,
  impulse: vec2f,
  cameraY: f32,
  pixelRatio: f32,
  time: f32,
  intro: f32,
  densityFalloff: f32,
  sizeFalloff: f32,
  twinkleSpeed: f32,
  intensity: f32,
  backgroundEnabled: f32,
  repelEnabled: f32,
  repelImpulse: f32,
  repelAge: f32,
  repelRadius: f32,
  count: u32,
  coreLayer: u32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> stars: array<Star>;
@group(0) @binding(2) var<storage, read> paths: array<vec4f>;
@group(0) @binding(3) var<storage, read> layers: array<Layer>;
@group(0) @binding(4) var<storage, read_write> motion: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> projected: array<Projected>;
@group(0) @binding(6) var<storage, read_write> flares: array<vec4f>;

const PI = 3.14159265359;
const PATH_SAMPLES = 512.0;
const SETTLE_SECONDS = 6.0;
const REVEAL_END = 0.2;

fn samplePath(base: u32, progress: f32) -> vec3f {
  let scaled = clamp(progress, 0.0, 1.0) * (PATH_SAMPLES - 1.0);
  let lower = floor(scaled);
  let upper = min(lower + 1.0, PATH_SAMPLES - 1.0);
  return mix(paths[base + u32(lower)].xyz, paths[base + u32(upper)].xyz, scaled - lower);
}

// Analytic coast: a repelled star drifts on its velocity while a return spring
// pulls it home, both decaying with the seconds since the last impulse.
fn coast(state: vec4f, mass: f32, age: f32) -> vec4f {
  let drag = 2.3 / sqrt(mass);
  let velocityDecay = exp(-drag * age);
  let returnDecay = exp(-age);
  return vec4f(
    state.xy * returnDecay + state.zw * (returnDecay - velocityDecay) / (drag - 1.0),
    state.zw * velocityDecay,
  );
}

// The intro: each star orbits its scattered sky position while being pulled
// onto the stroke, staggered by its seeds.
fn introMotion(position: vec3f, scattered: vec3f, progress: f32, seed: f32, travelSeed: f32) -> vec3f {
  if (progress >= 1.0) {
    return position;
  }
  let start = 0.14 + seed * 0.18;
  let duration = 0.58 + travelSeed * 0.1;
  let local = clamp((progress - start) / duration, 0.0, 1.0);
  let smoothPull = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);
  let pull = mix(smoothPull, sin(smoothPull * PI * 0.5), 0.5);
  let angle = sin(pull * PI) * (0.44 + seed * 0.22);
  let c = cos(angle);
  let s = sin(angle);
  let orbiting = vec3f(scattered.x * c - scattered.y * s, scattered.x * s + scattered.y * c, scattered.z);
  return mix(orbiting, position, pull);
}

fn revealProgress(progress: f32, seed: f32) -> f32 {
  let delay = seed * 0.015;
  return smoothstep(delay, 0.14 + delay, progress) * mix(0.2, 1.0, smoothstep(0.2, 1.0, progress));
}

// Euler XYZ: apply Z, then Y, then X.
fn rotateEuler(v: vec3f, r: vec3f) -> vec3f {
  let cz = cos(r.z);
  let sz = sin(r.z);
  var p = vec3f(v.x * cz - v.y * sz, v.x * sz + v.y * cz, v.z);
  let cy = cos(r.y);
  let sy = sin(r.y);
  p = vec3f(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  let cx = cos(r.x);
  let sx = sin(r.x);
  return vec3f(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
}

fn edgeVisibility(ndc: vec2f) -> f32 {
  return 1.0 - smoothstep(0.88, 1.08, max(abs(ndc.x), abs(ndc.y)));
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= params.count) {
    return;
  }
  let star = stars[index];
  let layerIndex = u32(star.layer);
  let layer = layers[layerIndex];

  // Flow along the stroke; densityFalloff bunches stars toward its middle.
  let pathPhase = fract(star.progress + layer.pathOffset);
  let progress = pathPhase + params.densityFalloff * sin(pathPhase * 2.0 * PI) / (2.0 * PI);
  let middle = sin(clamp(progress, 0.0, 1.0) * PI);
  var sizeEnvelope = mix(1.0, 0.14 + 0.86 * pow(max(middle, 0.0), 0.68), params.sizeFalloff);
  var endpoint = smoothstep(0.0, 0.055, progress) * (1.0 - smoothstep(0.945, 1.0, progress));
  var animated = star.position;
  if (layer.pathMotion > 0.5) {
    let base = u32(layer.sampleBase);
    let step = 1.0 / (PATH_SAMPLES - 1.0);
    let onPath = samplePath(base, progress);
    let before = samplePath(base, max(progress - step, 0.0));
    let after = samplePath(base, min(progress + step, 1.0));
    let tangent = normalize(after - before);
    let across = normalize(vec3f(-tangent.y, tangent.x, 0.0));
    animated = onPath + across * star.across + vec3f(0.0, 0.0, star.depth);
  } else {
    sizeEnvelope = 1.0;
    endpoint = 1.0;
  }

  // Before the intro every star fills the sky; background stars stay there.
  let sx = star.scatterX;
  let sy = star.scatterY;
  let sz = star.scatterZ;
  let scattered = vec3f((sx - 0.5) * params.scatter.x, (fract(sy) - 0.5) * params.scatter.y, (sz - 0.5) * 0.5);
  let background = star.background * params.backgroundEnabled;
  animated = mix(animated, scattered, background);
  animated = introMotion(animated, scattered, mix(params.intro, 1.0, background), sz, sy);

  let twinkle = 0.86 + 0.14 * sin(star.twinklePhase + params.time * params.twinkleSpeed * star.twinkleRate);
  let brightness = params.intensity * layer.intensity * star.brightness * twinkle;
  var opacity = star.opacity * endpoint * (0.92 + twinkle * 0.08);
  let rays = smoothstep(1.45, 2.8, star.brightness);
  var reveal = revealProgress(params.intro, sz);
  reveal = mix(reveal, min(reveal, 0.2), background);
  opacity *= mix(1.0, params.backgroundEnabled, star.background);
  opacity *= smoothstep(0.0, REVEAL_END, reveal);
  let diameter = params.pixelRatio
    * (0.35 + star.scale * sizeEnvelope * endpoint * 3.8)
    * (0.97 + twinkle * 0.03)
    * sqrt(reveal);

  // Dragging rotates the galaxy; background stars ride the sky instead.
  let world = mix(rotateEuler(animated, layer.rotation), animated, background);
  var ndc = vec2f(world.x / (params.world.x * 0.5), (world.y - params.cameraY) / (params.world.y * 0.5));

  // Pointer repel: an impulse along the pointer's last segment kicks nearby
  // stars; between impulses the stored state coasts analytically.
  if (params.repelEnabled > 0.5 && (params.repelAge < SETTLE_SECONDS || params.repelImpulse > 0.5)) {
    var state = coast(motion[index], star.mass, min(params.repelAge, SETTLE_SECONDS));
    if (params.repelImpulse > 0.5) {
      let aspect = max(params.viewport.x / max(params.viewport.y, 1.0), 0.0001);
      let scale = vec2f(aspect, 1.0);
      let current = (ndc + state.xy) * scale;
      let start = params.previous * scale;
      let segment = (params.pointer - params.previous) * scale;
      let t = clamp(dot(current - start, segment) / max(dot(segment, segment), 0.000001), 0.0, 1.0);
      let radius = max(params.repelRadius * 0.5, 0.025);
      let weight = pow(1.0 - smoothstep(0.0, radius, length(current - start - segment * t)), 2.0);
      var impulse = params.impulse * scale;
      impulse *= min(1.0, 0.18 / max(length(impulse), 0.00001));
      var velocity = state.zw + impulse / scale * weight * 5.4 / star.mass;
      let speed = length(velocity * scale);
      velocity *= min(1.0, 0.5 / max(speed, 0.00001));
      state = vec4f(state.xy, velocity);
      motion[index] = state;
    }
    ndc += state.xy;
  }

  projected[index] = Projected(ndc, diameter, brightness, star.color, opacity, rays, 0.0, 0.0, 0.0);

  if (star.hero > 0.5) {
    let visibility = endpoint * sizeEnvelope * sqrt(reveal) * smoothstep(0.0, REVEAL_END, reveal) * edgeVisibility(ndc);
    flares[layerIndex] = vec4f(0.5 + 0.5 * ndc.x, 0.5 - 0.5 * ndc.y, clamp(visibility, 0.0, 1.0), 0.0);
  }
}
