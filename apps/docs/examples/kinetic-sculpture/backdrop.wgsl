import { Studio, display, keyShadow, wallColor } from "./studio.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: VertexOut;
  out.clip = vec4f(corner, 0.0, 1.0);
  out.ndc = corner;
  return out;
}

// The studio behind the sculpture: an analytic floor (lit, shadowed, with contact occlusion
// around the plinth) that fades into the cyclorama wall, so there is no horizon line.
@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let direction = normalize(
    studio.forward
      + studio.right * input.ndc.x * studio.tanHalfFov * studio.aspect
      + studio.up * input.ndc.y * studio.tanHalfFov,
  );
  let wall = wallColor(direction);
  var radiance = wall;
  if (direction.y < 0.0) {
    let distance = -studio.eye.y / direction.y;
    let position = studio.eye + direction * distance;
    let normal = vec3f(0.0, 1.0, 0.0);
    let shadow = keyShadow(shadowMap, shadowSampler, studio, position, normal);
    // The key is a spotlight: its pool fades out a few metres from the plinth.
    let pool = 1.0 - smoothstep(1.6, 5.5, length(position.xz - vec2f(-0.5, 0.35)));
    let footprint = length(max(abs(position.xz) - studio.plinthHalf, vec2f(0.0)));
    let contact = mix(0.32, 1.0, smoothstep(0.0, 0.55, footprint));
    let albedo = vec3f(0.36, 0.32, 0.28);
    let key = vec3f(1.0, 0.84, 0.64) * 3.1 * studio.keyDirection.y * shadow * pool;
    let floorColor = albedo / 3.14159265 * (key + vec3f(0.42, 0.38, 0.35) * contact);
    let fog = smoothstep(5.0, 15.0, distance);
    radiance = mix(floorColor * contact, wall, fog);
  }
  return vec4f(display(radiance, studio.exposure), 1.0);
}
