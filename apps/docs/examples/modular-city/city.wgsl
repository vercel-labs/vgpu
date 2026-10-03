import { instanceWorldMatrix, transformNormal, transformPosition } from "@vgpu/wgsl-std/scene";
import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";
import { saturate } from "@vgpu/wgsl-std/math";
import {
  Camera,
  Scene,
  axisLengths,
  finish,
  shade,
  sunShadow,
  MATERIAL_FACADE,
  MATERIAL_GLASS,
  MATERIAL_ROOF,
  MATERIAL_PLAIN,
  MATERIAL_SLAB,
  MATERIAL_FOLIAGE,
  MATERIAL_TRUNK,
} from "./common.wgsl";

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> scene: Scene;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

const FLOOR: f32 = 0.42;
const FACADE_HOUSE: u32 = 0u;
const FACADE_PUNCHED: u32 = 1u;
const FACADE_RIBBON: u32 = 2u;
const FACADE_STOREFRONT: u32 = 3u;
const DISTRICT_PARK: u32 = 3u;

// Recipe attributes keep their fixed locations (position 0, normal 1, uv 2 on cones and
// icospheres); the instance attributes match by name from location 3 on.
struct PartInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) pickId: u32,
  @location(8) tint: vec3f,
  @location(9) style: vec4u,
}

struct PartVarying {
  @builtin(position) clip: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) localPosition: vec3f,
  @location(3) localNormal: vec3f,
  @location(4) @interpolate(flat, either) dims: vec3f,
  @location(5) @interpolate(flat, either) tint: vec3f,
  @location(6) @interpolate(flat, either) style: vec4u,
  @location(7) @interpolate(flat, either) pickId: u32,
}

@vertex
fn vs_main(input: PartInput) -> PartVarying {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let worldPosition = transformPosition(world, input.position);
  var output: PartVarying;
  output.clip = camera.viewProjection * vec4f(worldPosition, 1.0);
  output.worldPosition = worldPosition;
  output.worldNormal = transformNormal(world, input.normal);
  output.localPosition = input.position;
  output.localNormal = input.normal;
  output.dims = axisLengths(world);
  output.tint = input.tint;
  output.style = input.style;
  output.pickId = input.pickId;
  return output;
}

fn isSelected(input: PartInput) -> bool {
  return scene.selectedBuilding != 0u && input.pickId == scene.selectedBuilding;
}

// Inverted hull: the selected building's parts grow by a constant screen width and draw back
// faces only, so a rim shows around the silhouette. Every other instance collapses off screen.
fn selectedPart(input: PartInput, widthPixels: f32) -> vec4f {
  if (!isSelected(input)) {
    return vec4f(2.0, 2.0, 2.0, 1.0);
  }
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  let dims = max(axisLengths(world), vec3f(1e-3));
  let center = transformPosition(world, vec3f(0.0));
  let width = widthPixels * camera.pixelScale * length(center - camera.eye);
  let grown = input.position * (dims + vec3f(2.0 * width)) / dims;
  return camera.viewProjection * vec4f(transformPosition(world, grown), 1.0);
}

@vertex
fn vs_outline(input: PartInput) -> @builtin(position) vec4f {
  return selectedPart(input, scene.outlineWidth);
}

@fragment
fn fs_outline() -> @location(0) vec4f {
  return vec4f(scene.highlightColor, 1.0);
}

// X-ray: the selection's front faces at exactly the vs_main position. The mask draw marks the
// pixels where the selection is visible; the ghost draw tints the pixels where it is hidden
// (depth "greater") behind another building (stencil unmarked).
@vertex
fn vs_ghost(input: PartInput) -> @builtin(position) vec4f {
  if (!isSelected(input)) {
    return vec4f(2.0, 2.0, 2.0, 1.0);
  }
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  return camera.viewProjection * vec4f(transformPosition(world, input.position), 1.0);
}

@fragment
fn fs_ghost() -> @location(0) vec4f {
  return vec4f(scene.highlightColor, 0.38);
}

fn cellHash(cell: vec3i, seed: u32) -> vec3f {
  let h = pcg3d(vec3u(cell + vec3i(4096)) ^ vec3u(seed, seed * 3u, seed * 7u));
  return vec3f(f32(h.x), f32(h.y), f32(h.z)) / 4294967295.0;
}

// Anti-aliased rectangle of half size `half` centered in each cell of size `spacing`.
fn cellRect(coord: vec2f, spacing: vec2f, half: vec2f, footprint: vec2f) -> f32 {
  let local = abs((fract(coord / spacing) - 0.5) * spacing);
  let edge = max(footprint, vec2f(1e-4));
  let inside = vec2f(1.0) - smoothstep(half - edge, half + edge, local);
  let detail = inside.x * inside.y;
  // Fade to the pattern's average coverage once a cell spans only a few pixels.
  let average = (half.x * 2.0 / spacing.x) * (half.y * 2.0 / spacing.y);
  let density = max(footprint.x / spacing.x, footprint.y / spacing.y);
  return mix(detail, average, saturate(density * 3.0 - 0.6));
}

fn skyReflection(direction: vec3f) -> vec3f {
  let up = saturate(direction.y * 0.5 + 0.5);
  let horizon = vec3f(1.0, 0.78, 0.55);
  let zenith = vec3f(0.32, 0.48, 0.72);
  return mix(horizon, zenith, pow(up, 0.6));
}

struct Surface {
  albedo: vec3f,
  emission: vec3f,
  specular: f32,
  occlusion: f32,
}

// Windows, floors and storefronts in facade coordinates: u across the face, v up from the part base.
fn facadeSurface(
  base: vec3f,
  glass: bool,
  facade: u32,
  u: f32,
  v: f32,
  faceWidth: f32,
  height: f32,
  footprint: vec2f,
  cellSeed: u32,
  face: i32,
) -> Surface {
  var surface: Surface;
  surface.albedo = base;
  surface.emission = vec3f(0.0);
  surface.specular = 0.0;
  surface.occlusion = 1.0;

  let floorCount = max(1.0, round(height / FLOOR));
  let floorHeight = height / floorCount;
  var spacing = 0.42;
  var half = vec2f(0.1, 0.11);
  if (facade == FACADE_HOUSE) {
    spacing = 0.48;
    half = vec2f(0.075, 0.1);
  } else if (facade == FACADE_RIBBON) {
    spacing = 0.3;
    half = vec2f(0.13, 0.085);
  } else if (facade == FACADE_STOREFRONT) {
    spacing = 0.6;
    half = vec2f(0.24, 0.14);
  }
  let columns = max(1.0, round(faceWidth / spacing));
  let cell = vec2f(faceWidth / columns, floorHeight);
  let coord = vec2f(u + faceWidth * 0.5, v);
  var windowMask = cellRect(coord, cell, half, footprint);

  // Cornice band at the top of every part, a darker plinth on houses.
  let top = height - v;
  let cornice = 1.0 - smoothstep(0.06 - footprint.y, 0.06 + footprint.y, top);
  windowMask *= 1.0 - smoothstep(0.02, 0.1, cornice);
  if (top < floorHeight * 0.32) {
    windowMask *= saturate(top / (floorHeight * 0.32) - 0.3);
  }

  let id = vec3i(i32(floor(coord.x / cell.x)), i32(floor(v / cell.y)), face);
  let random = cellHash(id, cellSeed);
  let lit = select(0.0, 1.0, random.x < 0.14);

  if (glass) {
    // Curtain wall: mullion grid, tinted glass and spandrel bands.
    let mullion = cellRect(coord, vec2f(cell.x * 0.5, floorHeight), vec2f(cell.x * 0.23, floorHeight * 0.42), footprint);
    surface.albedo = mix(base * 0.55 + vec3f(0.06), base * 0.22, mullion);
    surface.specular = mix(0.35, 0.9, mullion);
    surface.emission = vec3f(1.0, 0.78, 0.48) * lit * mullion * 0.35;
  } else {
    let glassColor = mix(vec3f(0.16, 0.2, 0.23), vec3f(0.22, 0.25, 0.27), random.y);
    surface.albedo = mix(base, glassColor, windowMask);
    surface.albedo = mix(surface.albedo, base * 1.08 + vec3f(0.04), cornice);
    surface.specular = windowMask * 0.5;
    surface.emission = vec3f(1.0, 0.72, 0.42) * lit * windowMask * 0.9;
    // A floor line between storeys reads at mid zoom.
    let floorPhase = fract(v / floorHeight);
    let floorLine = 1.0 - smoothstep(0.012, 0.03 + footprint.y, min(floorPhase, 1.0 - floorPhase) * floorHeight);
    surface.albedo *= 1.0 - floorLine * 0.12 * (1.0 - windowMask);
  }
  // Contact darkening at the base of every part.
  surface.occlusion = mix(0.55, 1.0, smoothstep(0.0, 0.5, v));
  return surface;
}

fn slabSurface(base: vec3f, district: u32, local: vec3f, normal: vec3f, dims: vec3f, neighborhood: u32, footprint: vec3f) -> Surface {
  var surface: Surface;
  surface.emission = vec3f(0.0);
  surface.specular = 0.0;
  surface.occlusion = 1.0;
  let meters = local * dims;
  if (normal.y > 0.5) {
    let edge = min(dims.x * 0.5 - abs(meters.x), dims.z * 0.5 - abs(meters.z));
    if (district == DISTRICT_PARK) {
      let radius = length(meters.xz);
      let stripes = 0.5 + 0.5 * sin(meters.x * 2.2);
      surface.albedo = base * (0.92 + 0.08 * stripes);
      let path = min(abs(meters.x), abs(meters.z));
      let ring = abs(radius - 4.2);
      let gravel = 1.0 - smoothstep(0.32, 0.36 + footprint.x, min(path, ring));
      surface.albedo = mix(surface.albedo, vec3f(0.78, 0.7, 0.56), gravel);
      let pond = 1.0 - smoothstep(1.55, 1.6 + footprint.x, radius);
      surface.albedo = mix(surface.albedo, vec3f(0.12, 0.32, 0.36), pond);
      surface.specular = pond * 0.8;
    } else {
      let tiles = cellRect(meters.xz, vec2f(0.5), vec2f(0.235), footprint.xz);
      surface.albedo = base * mix(0.86, 1.0, tiles);
    }
    let curb = 1.0 - smoothstep(0.18, 0.2 + footprint.x, edge);
    surface.albedo = mix(surface.albedo, vec3f(0.86, 0.83, 0.77), curb);
    if (neighborhood == scene.selectedNeighborhood) {
      // A glowing band just inside the curb marks the selected neighborhood.
      let band = 1.0 - smoothstep(0.08, 0.1 + footprint.x, abs(edge - 0.42));
      surface.emission = scene.highlightColor * band * 1.1;
      surface.albedo = mix(surface.albedo, scene.highlightColor, band * 0.7);
    }
  } else {
    // Earth strata on the slab sides, visible when a neighborhood is lifted.
    let depth = dims.y * 0.5 - meters.y;
    var strata = vec3f(0.55, 0.38, 0.26);
    if (depth < 0.12) {
      strata = select(vec3f(0.82, 0.78, 0.7), vec3f(0.36, 0.48, 0.22), district == DISTRICT_PARK);
    } else if (depth < 0.45) {
      strata = vec3f(0.48, 0.33, 0.22);
    } else if (depth < 0.8) {
      strata = vec3f(0.62, 0.47, 0.32);
    }
    let along = meters.x + meters.z;
    let grain = cellHash(vec3i(i32(floor(along * 9.0)), i32(floor(meters.y * 14.0)), 0), 17u).x;
    surface.albedo = strata * (0.9 + 0.12 * grain);
  }
  return surface;
}

@fragment
fn fs_main(input: PartVarying) -> @location(0) vec4f {
  // Derivatives first, in uniform control flow.
  let footprint = fwidth(input.localPosition * input.dims);
  let worldFootprint = fwidth(input.worldPosition);
  let normal = normalize(input.worldNormal);
  let view = normalize(camera.eye - input.worldPosition);
  let material = input.style.x;
  let facade = input.style.y;
  let neighborhood = input.style.z;
  let seed = input.style.w;
  let local = input.localPosition;
  let n = input.localNormal;
  let dims = input.dims;

  var surface: Surface;
  surface.albedo = input.tint;
  surface.emission = vec3f(0.0);
  surface.specular = 0.0;
  surface.occlusion = 1.0;

  if (material == MATERIAL_FACADE || material == MATERIAL_GLASS) {
    if (abs(n.y) < 0.5) {
      let alongX = abs(n.z) > 0.5;
      let u = select(local.z * dims.z, local.x * dims.x, alongX);
      let faceWidth = select(dims.z, dims.x, alongX);
      let fp = vec2f(select(footprint.z, footprint.x, alongX), footprint.y);
      let face = i32(select(0u, 1u, alongX)) + select(0, 2, n.x + n.z < 0.0);
      surface = facadeSurface(
        input.tint,
        material == MATERIAL_GLASS,
        facade,
        u,
        (local.y + 0.5) * dims.y,
        faceWidth,
        dims.y,
        fp,
        seed,
        face,
      );
    } else {
      // Flat roof with a parapet rim.
      let edge = min(dims.x * 0.5 - abs(local.x * dims.x), dims.z * 0.5 - abs(local.z * dims.z));
      let parapet = 1.0 - smoothstep(0.05, 0.07 + footprint.x, edge);
      // A darker, desaturated parapet, so warm tints do not read as the selection outline.
      let parapetColor = mix(input.tint, vec3f(dot(input.tint, vec3f(0.3, 0.59, 0.11))), 0.4) * 0.72;
      surface.albedo = mix(vec3f(0.56, 0.55, 0.52), parapetColor, parapet);
      surface.occlusion = mix(0.8, 1.0, smoothstep(0.06, 0.4, edge));
    }
  } else if (material == MATERIAL_ROOF) {
    let rows = abs(fract(input.worldPosition.y / 0.075) - 0.5);
    let line = 1.0 - smoothstep(0.08, 0.2 + worldFootprint.y / 0.075, rows);
    surface.albedo = input.tint * (1.0 - 0.28 * line * saturate(1.5 - worldFootprint.y * 30.0));
    let ridge = smoothstep(0.42, 0.5, local.y);
    surface.albedo *= 1.0 - ridge * 0.15;
  } else if (material == MATERIAL_PLAIN) {
    let grille = cellRect(vec2f(local.x * dims.x + local.z * dims.z, local.y * dims.y), vec2f(0.12, 0.5), vec2f(0.03, 0.2), footprint.xy);
    surface.albedo = input.tint * mix(1.0, 0.8, grille * (1.0 - abs(n.y)));
    surface.occlusion = mix(0.7, 1.0, smoothstep(0.0, 0.3, (local.y + 0.5) * dims.y));
  } else if (material == MATERIAL_SLAB) {
    surface = slabSurface(input.tint, facade, local, n, dims, neighborhood, footprint);
  } else if (material == MATERIAL_FOLIAGE) {
    let leaf = cellHash(vec3i(floor(input.worldPosition * 3.0)), seed).x;
    surface.albedo = input.tint * (0.82 + 0.3 * leaf) * mix(0.75, 1.1, saturate(local.y + 0.5));
    surface.occlusion = mix(0.55, 1.0, saturate(local.y + 0.6));
  } else if (material == MATERIAL_TRUNK) {
    surface.occlusion = 0.8;
  }

  // A faint warm lift only: the outline and x-ray mark the selection, so its facade stays readable.
  if (input.pickId == scene.selectedBuilding && scene.selectedBuilding != 0u) {
    surface.emission += scene.highlightColor * 0.07;
  }

  let shadow = sunShadow(shadowMap, shadowSampler, scene.lightViewProjection, input.worldPosition, normal);
  var radiance = shade(surface.albedo, normal, scene.sunDirection, scene.sunColor, scene.skyColor, shadow, surface.occlusion);
  if (surface.specular > 0.0) {
    let fresnel = 0.04 + 0.96 * pow(1.0 - saturate(dot(normal, view)), 5.0);
    let reflected = skyReflection(reflect(-view, normal));
    let highlight = pow(saturate(dot(reflect(-scene.sunDirection, normal), view)), 60.0) * shadow;
    radiance += surface.specular * (reflected * mix(0.12, 1.0, fresnel) * 0.6 + scene.sunColor * highlight);
  }
  radiance += surface.emission;
  return finish(radiance, input.worldPosition, scene.fogColor, scene.exposure);
}
