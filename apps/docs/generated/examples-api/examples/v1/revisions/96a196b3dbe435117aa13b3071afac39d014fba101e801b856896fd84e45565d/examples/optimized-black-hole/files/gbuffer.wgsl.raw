// Shared decoding contract for the baked crossings consumed by the frame shader.

export const HORIZON: f32 = 1.0;

export const ISCO: f32 = 3.0;
export const TAU: f32 = 6.28318530718;
export const PI_CONST: f32 = 3.14159265359;

export struct GBufferSample {
  position: vec3f,
  normal: vec3f,
  diskUv: vec2f,
  diskPolar: vec2f,
  rayDirection: vec3f,
  viewDirection: vec3f,
  side: f32,
  coverage: f32,
  span: f32,
  isHit: bool,
  synthesized: bool,
  isBlackHole: bool,
  escaped: bool,
}

export struct GBufferLayers {
  front: GBufferSample,
  back: GBufferSample,
}

fn decodeDirection(encoded: vec2f) -> vec3f {
  let horizontal = sqrt(max(1.0 - encoded.x * encoded.x, 0.0));
  return vec3f(cos(encoded.y) * horizontal, encoded.x, sin(encoded.y) * horizontal);
}

fn decodeLayer(
  plane: vec2f, encodedDirection: vec2f, sky: vec4f, flags: i32,
  diskOuter: f32, aa: vec2f, synthesized: bool,
) -> GBufferSample {
  var sample: GBufferSample;
  let planeRadius = length(plane);
  let isHit = planeRadius > ISCO * 0.5;
  let radius = max(planeRadius, ISCO);
  let azimuth = atan2(plane.y, plane.x);
  let direction = decodeDirection(encodedDirection);
  let side = select(1.0, -1.0, direction.y > 0.0);

  sample.position = select(vec3f(0.0), vec3f(plane.x, 0.0, plane.y), isHit);
  sample.normal = select(vec3f(0.0), vec3f(0.0, side, 0.0), isHit);
  sample.diskUv = vec2f(
    clamp((radius - ISCO) / max(diskOuter - ISCO, 0.001), 0.0, 1.0),
    (azimuth + PI_CONST) / TAU,
  );
  sample.diskPolar = vec2f(radius, azimuth);
  sample.rayDirection = sky.xyz;
  sample.viewDirection = direction;
  sample.side = select(0.0, side, isHit);
  sample.coverage = clamp(aa.x, 0.0, 1.0);
  sample.span = clamp(aa.y, 0.0, 1.0);
  sample.isHit = isHit;
  sample.synthesized = synthesized && isHit;
  sample.isBlackHole = (flags & 1) != 0;
  sample.escaped = (flags & 2) != 0;
  return sample;
}

export fn decodeGBuffer(
  hit1: vec2f, hit2: vec2f, sky: vec4f, view: vec4f,
  diskOuter: f32, aa: vec2f, aaGeom: vec4f,
) -> GBufferLayers {
  let flags = i32(sky.w + 0.5);
  let substitute = length(hit1) <= ISCO * 0.5 && length(aaGeom.xy) > ISCO * 0.5;
  let frontPlane = select(hit1, aaGeom.xy, substitute);
  let frontDirection = select(view.xy, aaGeom.zw, substitute);
  var layers: GBufferLayers;
  layers.front = decodeLayer(frontPlane, frontDirection, sky, flags, diskOuter, aa, substitute);
  layers.back = decodeLayer(hit2, view.zw, sky, flags, diskOuter, vec2f(1.0, 0.0), false);
  if (!layers.front.isHit) {
    layers.back.isHit = false;
    layers.back.side = 0.0;
    layers.back.normal = vec3f(0.0);
  }
  return layers;
}

export fn sampleAtRadius(g: GBufferSample, radius: f32, diskOuter: f32) -> GBufferSample {
  var moved = g;
  let clamped = clamp(radius, ISCO, max(diskOuter, ISCO));
  let azimuth = g.diskPolar.y;
  moved.position = vec3f(cos(azimuth) * clamped, 0.0, sin(azimuth) * clamped);
  moved.diskPolar = vec2f(clamped, azimuth);
  moved.diskUv = vec2f(
    clamp((clamped - ISCO) / max(diskOuter - ISCO, 0.001), 0.0, 1.0),
    g.diskUv.y,
  );
  return moved;
}
