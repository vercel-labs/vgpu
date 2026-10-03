import { perlin3d } from "@vgpu/wgsl-std/noise/perlin";
import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import { Studio, Surface, backdropColor, display, keyShadow, shade } from "./common.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

// look.x: material (MATERIAL in machine.ts), look.y: per-part seed, look.z: 1 for boxes (bevelled edges).
const MATERIAL_MAPLE: u32 = 0u;
const MATERIAL_WALNUT: u32 = 1u;
const MATERIAL_BRASS: u32 = 2u;
const MATERIAL_FELT: u32 = 3u;
const MATERIAL_SLATE: u32 = 4u;
const MATERIAL_STUDIO: u32 = 5u;

const BEVEL_WIDTH: f32 = 0.022;

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
  @location(3) localNormal: vec3f,
  @location(4) scale: vec3f,
  @location(5) look: vec4f,
  @location(6) axisX: vec3f,
  @location(7) axisY: vec3f,
  @location(8) axisZ: vec3f,
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  // The world matrix is the cannon-es pose composed with the part's size: unit meshes, sized here.
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let position = transformPosition(world, input.position);
  var out: VertexOut;
  out.clip = studio.viewProjection * vec4f(position, 1.0);
  out.worldPosition = position;
  out.worldNormal = transformNormal(world, input.normal);
  out.local = input.position;
  out.localNormal = input.normal;
  out.scale = vec3f(length(input.world0.xyz), length(input.world1.xyz), length(input.world2.xyz));
  out.look = input.look;
  out.axisX = input.world0.xyz / out.scale.x;
  out.axisY = input.world1.xyz / out.scale.y;
  out.axisZ = input.world2.xyz / out.scale.z;
  return out;
}

/** Grain coordinates: x runs along the part's longest axis, so every board reads as cut lengthwise. */
fn grainSpace(p: vec3f, scale: vec3f) -> vec3f {
  if (scale.y > scale.x && scale.y >= scale.z) {
    return p.yxz;
  }
  if (scale.z > scale.x && scale.z > scale.y) {
    return p.zyx;
  }
  return p;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let material = u32(input.look.x + 0.5);
  let seed = input.look.y;
  // Object-space position in machine units: the unit mesh times this part's size.
  let p = input.local * input.scale;
  var normal = normalize(input.worldNormal);

  // Wood rings across the grain, softened by their own screen-space frequency so distant
  // boards fade to their average tone instead of shimmering.
  let grain = grainSpace(p, input.scale);
  let warp = perlin3d(vec3f(grain.x * 0.32, grain.y * 2.6, grain.z * 2.6) + vec3f(seed * 37.0));
  let rings = grain.y * 6.0 + grain.z * 3.5 + warp * 1.9;
  let ringBlur = clamp(fwidth(rings) * 1.5, 0.0, 1.0);
  let ring = mix(0.5 + 0.5 * cos(rings * 6.2831853), 0.5, ringBlur);
  let fineBlur = clamp(length(fwidth(p)) * 22.0, 0.0, 1.0);
  let fibre = mix(perlin3d(vec3f(grain.x * 1.1, grain.y * 38.0, grain.z * 38.0) + vec3f(seed * 11.0)), 0.0, fineBlur);
  let speckle = mix(perlin3d(p * 26.0 + vec3f(seed * 5.0)), 0.0, fineBlur);
  let broad = perlin3d(p * 1.4 + vec3f(seed * 13.0));

  // Bevelled box edges: within BEVEL_WIDTH of an edge the normal leans outward, so every
  // board picks up a thin highlight that separates it from the board behind.
  var bevel = 0.0;
  if (input.look.z > 0.5) {
    let toFace = (vec3f(0.5) - abs(input.local)) * input.scale;
    let faceAxis = abs(input.localNormal);
    // Ignore the face this fragment lies on; the nearer of the other two sides is the edge.
    let sides = toFace + faceAxis * 1e4;
    let outward = sign(input.local);
    var edgeDirection = input.axisX * outward.x;
    var edgeDistance = sides.x;
    if (sides.y < edgeDistance) {
      edgeDistance = sides.y;
      edgeDirection = input.axisY * outward.y;
    }
    if (sides.z < edgeDistance) {
      edgeDistance = sides.z;
      edgeDirection = input.axisZ * outward.z;
    }
    bevel = 1.0 - smoothstep(0.0, BEVEL_WIDTH, edgeDistance);
    normal = normalize(normal + edgeDirection * bevel * 1.1);
  }

  var surface = Surface(vec3f(0.5), 0.6, 0.0, 1.0, 0.0);
  // An if chain rather than `switch`: vgsl does not see module constants used as case selectors.
  if (material == MATERIAL_MAPLE) {
    let tone = clamp(ring * 0.6 + fibre * 0.35 + broad * 0.2 + 0.2, 0.0, 1.0);
    surface.albedo = mix(vec3f(0.62, 0.4, 0.2), vec3f(0.4, 0.22, 0.1), tone);
    surface.roughness = 0.48;
    surface.coat = 0.32;
  } else if (material == MATERIAL_WALNUT) {
    let tone = clamp(ring * 0.55 + fibre * 0.4 + broad * 0.25 + 0.2, 0.0, 1.0);
    surface.albedo = mix(vec3f(0.27, 0.15, 0.08), vec3f(0.12, 0.06, 0.032), tone);
    surface.roughness = 0.42;
    surface.coat = 0.3;
  } else if (material == MATERIAL_BRASS) {
    surface.albedo = vec3f(0.93, 0.71, 0.38) * (0.92 + broad * 0.12);
    // Brushed along the part's long axis.
    surface.roughness = 0.26 + fibre * 0.08;
    surface.metallic = 1.0;
  } else if (material == MATERIAL_FELT) {
    surface.albedo = vec3f(0.035, 0.2, 0.11) * (0.86 + speckle * 0.28 + broad * 0.1);
    surface.roughness = 0.95;
  } else if (material == MATERIAL_SLATE) {
    surface.albedo = vec3f(0.056, 0.066, 0.082) * (0.9 + speckle * 0.25 + broad * 0.15);
    surface.roughness = 0.5;
    surface.coat = 0.18;
  } else {
    surface.albedo = vec3f(0.13, 0.135, 0.145) * (0.96 + broad * 0.06);
    surface.roughness = 0.85;
  }

  let shadow = keyShadow(shadowMap, shadowSampler, studio, input.worldPosition, normalize(input.worldNormal));
  var radiance = shade(studio, surface, input.worldPosition, normal, shadow);
  if (material == MATERIAL_FELT) {
    // Felt scatters light back toward grazing views.
    let toEye = normalize(studio.eye - input.worldPosition);
    radiance += vec3f(0.05, 0.13, 0.08) * pow(1.0 - max(dot(normal, toEye), 0.0), 3.0) * (0.5 + 0.5 * shadow);
  }
  if (material == MATERIAL_STUDIO) {
    // A spotlight pool under the machine, then the floor fades into the cyclorama: no horizon line.
    let fromMachine = input.worldPosition.xz - vec2f(0.4, 0.5);
    radiance *= 0.18 + 0.82 * exp(-dot(fromMachine, fromMachine) / 32.0);
    let toPoint = input.worldPosition - studio.eye;
    let fog = smoothstep(9.0, 40.0, length(toPoint));
    radiance = mix(radiance, backdropColor(normalize(toPoint)), fog);
  }
  return vec4f(display(radiance, studio.exposure), 1.0);
}
