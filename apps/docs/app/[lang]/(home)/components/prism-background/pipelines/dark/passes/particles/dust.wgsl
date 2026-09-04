// Sparse volumetric dust, composited after tone mapping.
//
// Every instance is a screen-facing quad whose deterministic index selects one
// of four physical-looking populations: mostly pinprick grains, some visible
// flakes, rare soft motes and exceptional out-of-focus bokeh. One broad,
// unthresholded light level reveals them independently of visible bloom.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

struct DustParams {
  viewProjection: mat4x4f,
  fieldHalfExtent: vec2f,
  outputSize: vec2f,
  time: f32,
  cameraDistance: f32,
  lightPlaneZ: f32,
  prismA: vec2f,
  prismB: vec2f,
  prismC: vec2f,
  prismFrontZ: f32,
  revealProgress: f32,
}

@group(0) @binding(0) var<uniform> params: DustParams;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var lightTexture: texture_2d<f32>;
@group(0) @binding(3) var lightSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) pointCoord: vec2f,
  @location(1) lightUv: vec2f,
  @location(2) @interpolate(flat, either) sparkle: f32,
  @location(3) @interpolate(flat, either) softness: f32,
  @location(4) @interpolate(flat, either) prismUvA: vec2f,
  @location(5) @interpolate(flat, either) prismUvB: vec2f,
  @location(6) @interpolate(flat, either) prismUvC: vec2f,
  @location(7) @interpolate(flat, either) opacity: f32,
};

const TAU: f32 = 6.28318530718;
const LIGHT_RESPONSE: f32 = 82.0;
const LIGHT_FALLOFF_POWER: f32 = 5.5;
const DUST_EXPOSURE: f32 = 0.72;

fn hash11(value: f32) -> f32 {
  return fract(sin(value * 127.1) * 43758.5453);
}

// Integer hashing keeps respawn positions stable for long-running sessions.
// Growing f32 inputs eventually lose the low bits that distinguish particles,
// especially before a trigonometric hash.
fn hashU32(value: u32) -> f32 {
  var mixed = value;
  mixed = mixed ^ (mixed >> 16u);
  mixed = mixed * 0x7feb352du;
  mixed = mixed ^ (mixed >> 15u);
  mixed = mixed * 0x846ca68bu;
  mixed = mixed ^ (mixed >> 16u);
  return f32(mixed & 0x00ffffffu) / 16777216.0;
}

fn quadCorner(vertexIndex: u32) -> vec2f {
  let cornerIndex = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u)[vertexIndex % 6u];
  switch (cornerIndex) {
    case 0u: { return vec2f(-1.0, -1.0); }
    case 1u: { return vec2f( 1.0, -1.0); }
    case 2u: { return vec2f(-1.0,  1.0); }
    default: { return vec2f( 1.0,  1.0); }
  }
}

fn projectUv(point: vec3f) -> vec2f {
  let clip = params.viewProjection * vec4f(point, 1.0);
  let ndc = clip.xy / max(clip.w, 0.00001);
  return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn edgeSide(start: vec2f, end: vec2f, point: vec2f) -> f32 {
  let edge = end - start;
  let offset = point - start;
  return edge.x * offset.y - edge.y * offset.x;
}

fn insideTriangle(
  point: vec2f,
  a: vec2f,
  b: vec2f,
  c: vec2f,
) -> bool {
  let sideA = edgeSide(a, b, point);
  let sideB = edgeSide(b, c, point);
  let sideC = edgeSide(c, a, point);
  let hasNegative = sideA < 0.0 || sideB < 0.0 || sideC < 0.0;
  let hasPositive = sideA > 0.0 || sideB > 0.0 || sideC > 0.0;
  return !(hasNegative && hasPositive);
}

/** Diameter and profile softness for one progressively rarer dust population. */
fn dustAppearance(classSeed: f32, sizeSeed: f32) -> vec2f {
  if (classSeed < 0.82) {
    // Most of the field is stable, just-resolved airborne powder.
    return vec2f(mix(1.05, 1.75, sizeSeed * sizeSeed), 0.04);
  }
  if (classSeed < 0.95) {
    // A small number of flakes carry the readable sparkles.
    return vec2f(mix(1.8, 3.8, pow(sizeSeed, 1.4)), 0.18);
  }
  if (classSeed < 0.99) {
    // Rare larger motes are softer and much less energetic.
    return vec2f(mix(4.2, 9.0, pow(sizeSeed, 0.75)), 0.58);
  }
  if (classSeed < 0.996) {
    // Less than one percent becomes visible defocused bokeh.
    return vec2f(mix(12.0, 28.0, pow(sizeSeed, 0.8)), 1.0);
  }
  // Only a handful of instances become very large foreground bokeh. Their
  // opacity is derived from diameter below, so they remain atmospheric rather
  // than turning into opaque blobs.
  return vec2f(mix(32.0, 72.0, pow(sizeSeed, 0.8)), 1.0);
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOut {
  let id = f32(instanceIndex) + 1.0;
  let seedLife = hash11(id * 19.127 + 71.0);
  let seedPhase = hash11(id * 23.417 + 83.0);
  let lifeDuration = mix(1.0, 7.0, seedLife);
  let lifeClock = params.time + seedPhase * lifeDuration;
  let lifeGeneration = floor(lifeClock / lifeDuration);
  let lifePhase = fract(lifeClock / lifeDuration);

  // A completed lifecycle creates a new particle rather than reviving the old
  // one. The position changes only at the zero-opacity seam between cycles.
  let spawnKey = (instanceIndex + 1u)
    ^ (u32(lifeGeneration) * 0x9e3779b9u);
  let seedX = hashU32(spawnKey ^ 0xa511e9b3u);
  let seedY = hashU32(spawnKey ^ 0x63d83595u);
  let seedZ = hashU32(spawnKey ^ 0x9e3779b9u);
  let seedDepth = hashU32(spawnKey ^ 0xc2b2ae35u);
  let seedSize = hash11(id * 7.731 + 31.0);
  let seedClass = hash11(id * 9.173 + 37.0);
  let seedEnergy = hash11(id * 11.917 + 43.0);
  let seedShape = hash11(id * 13.531 + 47.0);
  let seedAngle = hash11(id * 17.273 + 59.0);

  // A triangular depth distribution concentrates most motes around the same
  // plane as the light sheet. The small remaining spread still reads as volume,
  // without the strong parallax caused by particles close to the camera.
  let dustZ = params.lightPlaneZ + (seedZ + seedDepth - 1.0) * 0.14;
  var worldPosition = vec3f(
    (seedX * 2.0 - 1.0) * params.fieldHalfExtent.x,
    (seedY * 2.0 - 1.0) * params.fieldHalfExtent.y,
    dustZ,
  );
  // `fieldHalfExtent` describes the wall plane. Narrow it towards the camera
  // so every depth slice fills approximately the same visible frustum instead
  // of wasting most of the close particles outside the viewport.
  let depthScale = clamp(
    (params.cameraDistance - worldPosition.z) / max(params.cameraDistance, 0.001),
    0.08,
    1.0,
  );
  worldPosition.x *= depthScale;
  worldPosition.y *= depthScale;
  worldPosition += vec3f(
    sin(params.time * mix(0.09, 0.17, seedY) + seedZ * TAU) * mix(0.008, 0.035, seedSize),
    sin(params.time * mix(0.07, 0.14, seedZ) + seedX * TAU) * mix(0.01, 0.04, seedY),
    sin(params.time * mix(0.05, 0.1, seedX) + seedY * TAU) * mix(0.006, 0.025, seedZ),
  );

  let projected = params.viewProjection * vec4f(worldPosition, 1.0);
  let ndc = projected.xy / max(projected.w, 0.00001);
  let unsnappedUv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  // Anchor every billboard at a physical pixel centre. A one-pixel mote can
  // now move between pixels, but it cannot sit between them and alternate its
  // raster coverage from frame to frame.
  let pixelCenter = floor(
    unsnappedUv * max(params.outputSize, vec2f(1.0)),
  ) + vec2f(0.5);
  let lightUv = pixelCenter / max(params.outputSize, vec2f(1.0));
  let snappedNdc = vec2f(lightUv.x * 2.0 - 1.0, 1.0 - lightUv.y * 2.0);
  let corner = quadCorner(vertexIndex);
  let appearance = dustAppearance(seedClass, seedSize);
  let radiusPixels = appearance.x * 0.5;

  // Powder is not made of perfect discs. Tiny flakes get mild anisotropy and
  // arbitrary orientation; large bokeh stays circular like a defocused lens
  // footprint.
  let rawAspect = mix(0.68, 1.32, seedShape);
  let aspect = mix(rawAspect, 1.0, appearance.y);
  let angle = seedAngle * TAU;
  let axisX = vec2f(cos(angle), sin(angle));
  let axisY = vec2f(-axisX.y, axisX.x);
  let shapedCorner = axisX * corner.x * aspect
    + axisY * corner.y / max(aspect, 0.001);
  let clipOffset = shapedCorner * radiusPixels * 2.0
    / max(params.outputSize, vec2f(1.0));

  // A continuous inverse-size response is the governing rule: every larger
  // mote is dimmer than an equivalently oriented smaller one. Tiny grains keep
  // a useful energy floor so subpixel coverage cannot make them blink out.
  let opacityBySize = min(
    1.0,
    pow(1.5 / max(appearance.x, 1.5), 0.9),
  );
  let energyVariation = 0.3 + 1.1 * pow(seedEnergy, 3.0);
  // Orientation changes are almost imperceptible on the small population and
  // only slightly stronger on soft bokeh; motion, not flicker, carries life.
  let twinkleAmount = mix(0.015, 0.06, appearance.y);
  let twinkle = 1.0 + twinkleAmount * sin(
    params.time * mix(0.12, 0.28, seedShape) + seedAngle * TAU,
  );
  // Each mote has an independent, long visibility cycle. Both ends of the
  // cycle are zero, so wrapping is seamless; the slow smoothsteps make dust
  // materialise and dissolve instead of blinking. Random lifetimes keep the
  // field continuously changing without synchronising its particles.
  let fadeFraction = mix(0.14, 0.24, seedShape);
  let lifecycle = smoothstep(0.0, fadeFraction, lifePhase)
    * (1.0 - smoothstep(1.0 - fadeFraction, 1.0, lifePhase));

  var out: VertexOut;
  out.position = vec4f(
    (snappedNdc + clipOffset) * projected.w,
    projected.z,
    projected.w,
  );
  out.pointCoord = corner;
  out.lightUv = lightUv;
  out.sparkle = opacityBySize * energyVariation * twinkle;
  out.softness = appearance.y;
  out.prismUvA = projectUv(vec3f(params.prismA, params.prismFrontZ));
  out.prismUvB = projectUv(vec3f(params.prismB, params.prismFrontZ));
  out.prismUvC = projectUv(vec3f(params.prismC, params.prismFrontZ));
  out.opacity = lifecycle;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let radiusSquared = dot(in.pointCoord, in.pointCoord);
  if (radiusSquared > 1.0) { discard; }
  let fragmentUv = in.position.xy / max(params.outputSize, vec2f(1.0));
  if (insideTriangle(
    fragmentUv,
    in.prismUvA,
    in.prismUvB,
    in.prismUvC,
  )) { discard; }

  let colorLight = max(textureSampleLevel(
    colorTexture,
    lightSampler,
    in.lightUv,
    0.0,
  ).rgb, vec3f(0.0));
  let light = max(textureSampleLevel(
    lightTexture,
    lightSampler,
    in.lightUv,
    0.0,
  ).rgb, vec3f(0.0));
  let brightness = max(max(light.r, light.g), light.b);
  if (all(light == vec3f(0.0))) { discard; }

  // No threshold is used: weak blurred samples fade continuously instead of
  // making a hard particle halo around the light volume.
  let lightResponse = 1.0
    - exp(-brightness * LIGHT_RESPONSE);
  let illumination = pow(
    clamp(lightResponse, 0.0, 1.0),
    LIGHT_FALLOFF_POWER,
  );

  let edgeFade = 1.0 - smoothstep(0.62, 1.0, radiusSquared);
  let core = exp(-radiusSquared * mix(6.5, 1.8, in.softness));
  let halo = exp(-radiusSquared * 1.25) * in.softness * 0.2;
  let radial = (core + halo) * edgeFade;
  let colorBrightness = max(max(colorLight.r, colorLight.g), colorLight.b);
  let hueSource = select(light, colorLight, colorBrightness > 0.0000001);
  let hueBrightness = max(max(hueSource.r, hueSource.g), hueSource.b);
  let normalizedLight = hueSource / max(hueBrightness, 0.000001);
  let lightColor = linearToSrgb3(clamp(normalizedLight, vec3f(0.0), vec3f(1.0)));
  let energy = illumination * radial * in.sparkle * DUST_EXPOSURE;
  let displayEnergy = linearToSrgb3(tonemapAces(vec3f(energy))).r;
  let reveal = clamp(params.revealProgress, 0.0, 1.0);
  if (reveal <= 0.0) { discard; }
  return vec4f(lightColor * displayEnergy * in.opacity * reveal, 0.0);
}
