import { perlinFbm, remap } from "./noise-common.wgsl";

@group(0) @binding(0) var weatherMap: texture_storage_2d<rgba8unorm, write>;

const SIZE: f32 = 1024.0;

/** Tileable weather: R = coverage, G = cloud type (0 stratus, 1 cumulus), B = wispiness. */
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec2f(id.xy) + 0.5) / SIZE;
  // Large fronts (2 cells) modulated by mid-scale cells (6 cells) so fields and gaps both exist.
  let fronts = perlinFbm(vec3f(p, 0.37), 2.0, 3) * 0.5 + 0.5;
  let cells = perlinFbm(vec3f(p + vec2f(0.5, 0.25), 0.91), 6.0, 4) * 0.5 + 0.5;
  let coverage = saturate(remap(mix(fronts, cells, 0.65), 0.38, 0.74, 0.0, 1.0));
  let cloudType = saturate(remap(perlinFbm(vec3f(p, 0.71), 2.0, 3) * 0.5 + 0.5, 0.35, 0.7, 0.0, 1.0));
  let wisps = saturate(perlinFbm(vec3f(p, 0.13), 8.0, 3) * 0.5 + 0.5);
  textureStore(weatherMap, id.xy, vec4f(coverage, cloudType, wisps, 1.0));
}
