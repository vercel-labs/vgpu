// The wall: a plane at z = 0, facing the camera, painted with the light the
// tracer accumulated on it.
//
// This is the only place the two-dimensional estimate becomes something in the
// room. Its four corners are the tracer's own coordinate rectangle — `scenePoint`
// maps a corner's uv to the same world position the trace pass integrated at — so
// the texture lands on the wall at 1:1 and the fan reaches the floor of the frame
// exactly where the optics put it.
//
// The plane also carries the two terms that are not worth tracing. The wall's own
// shade is a flat colour with a falloff and a little grain, and the beam on its
// way *in* is analytic: a direct connection to the lamp, blocked by the triangle.
// That blocker test is what plants the rainbow inside the prism's shadow, since
// the traced paths all pass through the glass the shadow belongs to.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";
import { vogelDisk } from "@vgpu/wgsl-std/sampling";
import { Scene, scenePoint, scenePrism, sceneLamp } from "./scene.wgsl";
import { intersectTriangle, spotProfile, surfaceEpsilon } from "./optics.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var caustic: texture_2d<f32>;
@group(0) @binding(2) var causticSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

/**
 * Two triangles covering the traced rectangle, wound counter-clockwise as the
 * camera sees them.
 *
 * There is no vertex buffer: the wall is defined by `scene.wallHalfExtent` and
 * the mapping in `scenePoint`, and reading those from the uniform block is what
 * keeps the plane in step with the texture when the canvas changes shape.
 */
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
  );
  let uv = corners[index];
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(scenePoint(scene, uv), 0.0, 1.0);
  out.uv = uv;
  return out;
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

/**
 * A dim, slightly uneven wall so the room reads as a room and not as a void.
 *
 * The vignette is measured in fractions of the wall rather than in scene units.
 * It has to be: the wall grows with the canvas, and an absolute falloff that
 * looked right on a 16:9 frame reached zero — a pure black corner, brighter than
 * nothing only by its grain — on a wide one.
 */
fn wall(point: vec2f, uv: vec2f) -> vec3f {
  let falloff = 1.0 - 0.55 * length((point / scene.wallHalfExtent) * vec2f(0.8, 0.5));
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
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let point = scenePoint(scene, in.uv);
  var color = causticAt(in.uv);
  if (scene.causticOnly == 0u) {
    color = color + wall(point, in.uv) + vec3f(scene.haze * beamHaze(point));
  }
  return vec4f(linearToSrgb3(tonemapAces(color)), 1.0);
}
