// Composites the picture: the wall, the glass, the beam on its way in, and the
// accumulated caustic on its way out.
//
// The traced estimator only reaches light that went *through* the glass, because
// every one of its paths ends on the prism. The beam arriving at the prism is
// the other half of the same lamp: a direct term, shadowed by the glass, which
// is why the rainbow always lands inside the prism's shadow.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";
import { vogelDisk } from "@vgpu/wgsl-std/sampling";
import { Scene, scenePoint, scenePrism, sceneLamp } from "./scene.wgsl";
import { insideTriangle, intersectTriangle, spotProfile, surfaceEpsilon } from "./optics.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var caustic: texture_2d<f32>;
@group(0) @binding(2) var causticSampler: sampler;

/** Distance from a point to the triangle's outline, for the glass rim. */
fn distanceToOutline(point: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  var vertices = array<vec2f, 3>(a, b, c);
  var best = 1e9;
  for (var index = 0u; index < 3u; index = index + 1u) {
    let edgeStart = vertices[index];
    let edge = vertices[(index + 1u) % 3u] - edgeStart;
    let t = clamp(dot(point - edgeStart, edge) / dot(edge, edge), 0.0, 1.0);
    best = min(best, length(point - (edgeStart + edge * t)));
  }
  return best;
}

/**
 * Light reaching `point` straight from the lamp.
 *
 * Only the part of the beam the glass does not block: `intersectTriangle`
 * between here and the lamp is the shadow test, and the shadow it carves is
 * exactly where the refracted fan reappears.
 */
fn beamHaze(point: vec2f) -> f32 {
  let lamp = sceneLamp(scene);
  let towardsLamp = lamp.center - point;
  let distance = length(towardsLamp);
  let direction = towardsLamp / distance;
  let profile = spotProfile(lamp, -direction);
  if (profile <= 0.0) {
    return 0.0;
  }
  let blocker = intersectTriangle(scenePrism(scene), point, direction, surfaceEpsilon);
  if (blocker.hit && blocker.t < distance) {
    return 0.0;
  }
  return profile / distance;
}

/** A dim, slightly uneven wall so the room reads as a room and not as a void. */
fn wall(point: vec2f, uv: vec2f) -> vec3f {
  let falloff = 1.0 - 0.55 * length(point * vec2f(0.45, 0.5));
  let grain = unitFloat(pcg2d(vec2u(uv * 2048.0)).x) - 0.5;
  return vec3f(0.0198, 0.0209, 0.0246) * max(falloff, 0.0) + vec3f(grain * 0.0022);
}

/**
 * The accumulated caustic, smoothed over a disc whose radius shrinks as the
 * estimate converges.
 *
 * Early frames are mostly Monte Carlo noise, and a wide disc trades detail the
 * estimate does not have yet for a picture that already reads correctly; by the
 * time enough rays have landed, `scene.causticBlur` has fallen to its floor and
 * the fan is as sharp as the accumulation buffer allows. The taps are a Vogel
 * disc rotated per pixel, so what is left of the noise never lines up into a
 * cross or a grid.
 */
fn causticAt(uv: vec2f) -> vec3f {
  let texel = scene.causticBlur / vec2f(textureDimensions(caustic, 0));
  let phi = unitFloat(pcg2d(vec2u(uv * 4096.0)).y) * 6.2831853;
  var total = textureSampleLevel(caustic, causticSampler, uv, 0.0).rgb;
  for (var tap = 0u; tap < 8u; tap = tap + 1u) {
    let offset = vogelDisk(tap, 8u, phi) * texel;
    total = total + textureSampleLevel(caustic, causticSampler, uv + offset, 0.0).rgb;
  }
  return total / 9.0;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let point = scenePoint(scene, uv);
  var color = causticAt(uv);

  if (scene.causticOnly == 0u) {
    color = color + wall(point, uv) + vec3f(scene.haze * beamHaze(point));

    let inside = insideTriangle(scenePrism(scene), point);
    let rim = distanceToOutline(point, scene.prismA, scene.prismB, scene.prismC);
    if (inside) {
      // Glass: darker than the wall, brightening towards the faces the way a
      // solid block of it does, and carrying a little of the light crossing it.
      let facing = 1.0 - smoothstep(0.0, 0.09, rim);
      color = mix(vec3f(0.020, 0.026, 0.034), vec3f(0.10, 0.12, 0.16), facing * facing);
      color = color + vec3f(0.055, 0.050, 0.075) * beamHaze(point) * scene.haze * 6.0;
    }
    // A thin bright edge on both sides of the outline reads as a lit corner.
    color = color + vec3f(0.16, 0.17, 0.20) * (1.0 - smoothstep(0.0, 0.008, rim));
  }

  return vec4f(linearToSrgb3(tonemapAces(color)), 1.0);
}
