import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import { Studio, Surface, display, keyShadow, shade } from "./common.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

// look.x: palette index (PALETTE_COUNT in simulation.ts), look.y: per-marble seed.
struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) look: vec4f,
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) local: vec3f,
  @location(3) look: vec4f,
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  // The cannon-es body's position and quaternion, scaled by its collider radius.
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let position = transformPosition(world, input.position);
  var out: VertexOut;
  out.clip = studio.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = transformNormal(world, input.normal);
  out.local = input.position;
  out.look = input.look;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  var bases = array<vec3f, 8>(
    vec3f(0.62, 0.02, 0.03),
    vec3f(0.015, 0.1, 0.62),
    vec3f(0.96, 0.66, 0.02),
    vec3f(0.0, 0.38, 0.4),
    vec3f(0.96, 0.24, 0.01),
    vec3f(0.26, 0.04, 0.55),
    vec3f(0.86, 0.82, 0.72),
    vec3f(0.02, 0.46, 0.18),
  );
  var ribbons = array<vec3f, 8>(
    vec3f(0.86, 0.76, 0.56),
    vec3f(0.98, 0.52, 0.04),
    vec3f(0.015, 0.03, 0.2),
    vec3f(0.95, 0.28, 0.18),
    vec3f(0.9, 0.9, 0.88),
    vec3f(0.42, 0.82, 0.04),
    vec3f(0.72, 0.02, 0.03),
    vec3f(0.92, 0.6, 0.08),
  );
  let palette = min(u32(input.look.x + 0.5), 7u);
  let seed = input.look.y;

  // The pattern lives on the unit sphere in object space, so it turns with the body and
  // shows the marble rolling: two ribbons twisting pole to pole and one white pinstripe.
  let n = normalize(input.local);
  let swirl = sin(2.0 * atan2(n.z, n.x) + n.y * (6.0 + seed * 4.0) + seed * 6.2831853);
  let swirlWidth = max(fwidth(swirl), 1e-3);
  let ribbon = smoothstep(0.3 - swirlWidth, 0.3 + swirlWidth, swirl);
  let stripeAxis = normalize(vec3f(sin(seed * 12.0), 0.8, cos(seed * 12.0)));
  let stripeDistance = abs(dot(n, stripeAxis));
  let stripeWidth = max(fwidth(stripeDistance), 1e-3);
  let stripe = 1.0 - smoothstep(0.045 - stripeWidth, 0.045 + stripeWidth, stripeDistance);
  var albedo = mix(bases[palette], ribbons[palette], ribbon);
  albedo = mix(albedo, vec3f(0.92, 0.92, 0.9), stripe);

  let normal = normalize(input.worldNormal);
  let shadow = keyShadow(shadowMap, shadowSampler, studio, input.worldPosition, normal);
  // Glossy glaze: a soft base lobe plus a mirror coat that carries the softbox reflections.
  let surface = Surface(albedo, 0.3, 0.0, 1.0, 0.85);
  let radiance = shade(studio, surface, input.worldPosition, normal, shadow);
  return vec4f(display(radiance, studio.exposure), 1.0);
}
