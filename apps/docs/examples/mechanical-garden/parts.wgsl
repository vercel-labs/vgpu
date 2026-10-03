import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";
import { saturate } from "@vgpu/wgsl-std/math";
import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import {
  Camera,
  Scene,
  Surface,
  finish,
  lightSurface,
  sunShadow,
} from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

// Robot parts and the plinth share this shader: every mesh vertex carries a material code, and the
// instance style is (variant, LED glow, part, unused).
struct PartInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) material: f32,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) style: vec4f,
}

struct PartVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) normal: vec3f,
  @location(2) localPosition: vec3f,
  @location(3) @interpolate(flat, either) material: u32,
  @location(4) @interpolate(flat, either) style: vec4f,
}

@vertex
fn vs_main(input: PartInput) -> PartVarying {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  var output: PartVarying;
  output.worldPosition = transformPosition(world, input.position);
  output.normal = transformNormal(world, input.normal);
  output.localPosition = input.position;
  output.material = u32(input.material + 0.5);
  output.style = input.style;
  output.clip = camera.viewProjection * vec4f(output.worldPosition, 1.0);
  return output;
}

fn speckle(position: vec3f, scale: f32) -> f32 {
  let cell = vec3u(vec3i(floor(position * scale) + vec3f(4096.0)));
  return unitFloat(pcg3d(cell).x);
}

fn surfaceFor(input: PartVarying) -> Surface {
  var surface = Surface(vec3f(0.5), vec3f(0.04), 32.0, 1.0, vec3f(0.0));
  // Case values are the MATERIAL codes in common.wgsl / meshes.ts (the linker keeps only consts
  // referenced from expressions, so the selectors are literals).
  switch input.material {
    case 0u: { // MATERIAL_YELLOW: glossy safety-yellow plastic covers
      surface.albedo = vec3f(0.86, 0.47, 0.006);
      surface.shininess = 70.0;
      surface.specular = vec3f(0.05);
    }
    case 1u: { // MATERIAL_PANEL: the pale, barely warm satin top plate over the yellow chassis
      surface.albedo = vec3f(0.4, 0.39, 0.35);
      surface.shininess = 40.0;
      surface.specular = vec3f(0.06);
    }
    case 2u: { // MATERIAL_GRAPHITE: black frame plastic with a faint moulded grain
      let grain = speckle(input.localPosition, 260.0);
      surface.albedo = vec3f(0.022, 0.023, 0.025) * (0.85 + 0.3 * grain);
      surface.shininess = 36.0;
      surface.specular = vec3f(0.05);
    }
    case 3u: { // MATERIAL_LENS: dark glass
      surface.albedo = vec3f(0.006, 0.008, 0.012);
      surface.specular = vec3f(0.12);
      surface.shininess = 220.0;
    }
    case 4u: { // MATERIAL_LED: a green status strip, lit by the instance glow
      let glow = input.style.y;
      surface.albedo = vec3f(0.01, 0.03, 0.012);
      surface.specular = vec3f(0.08);
      surface.shininess = 120.0;
      surface.emission = vec3f(0.25, 2.4, 0.45) * glow;
    }
    case 5u: { // MATERIAL_RUBBER
      surface.albedo = vec3f(0.032, 0.032, 0.033);
      surface.shininess = 10.0;
      surface.specular = vec3f(0.03);
    }
    case 6u: { // MATERIAL_METAL: brushed actuator housings and the lidar ring
      surface.albedo = vec3f(0.05, 0.052, 0.056);
      surface.specular = vec3f(0.55, 0.56, 0.58);
      surface.shininess = 55.0;
    }
    case 7u: { // MATERIAL_PLINTH
      // Cast concrete, darker than the deck, with a pale chamfered lip at the rim.
      let rim = smoothstep(-0.04, -0.01, input.localPosition.y);
      let grain = speckle(input.localPosition, 40.0);
      surface.albedo = mix(vec3f(0.16, 0.16, 0.158) * (0.92 + 0.16 * grain), vec3f(0.42, 0.42, 0.41), rim);
      surface.specular = vec3f(0.03);
      surface.shininess = 12.0;
      surface.occlusion = mix(0.55, 1.0, saturate(input.localPosition.y / 0.9 + 1.0));
    }
    default: {}
  }
  return surface;
}

@fragment
fn fs_main(input: PartVarying, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = normalize(select(-input.normal, input.normal, front));
  let viewDirection = normalize(camera.eye - input.worldPosition);
  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, input.worldPosition, n);
  let surface = surfaceFor(input);
  let radiance = lightSurface(surface, n, viewDirection, scene.sunDirection, scene.sunColor, scene.skyColor, shadow);
  return finish(radiance, scene.exposure);
}
