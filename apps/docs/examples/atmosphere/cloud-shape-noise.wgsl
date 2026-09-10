import { perlinFbm, remap, worley3 } from "./noise-common.wgsl";

@group(0) @binding(0) var shapeNoise: texture_storage_3d<rgba8unorm, write>;

const SIZE: f32 = 128.0;

/**
 * Schneider-style base shape: R = Perlin dilated by Worley, GBA = inverted Worley at 5, 10 and 20 cells.
 * The Perlin lattice (3 cells) and the Worley lattice (5 cells) have different periods so no grid shows through.
 */
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(id) + 0.5) / SIZE;
  let perlin = saturate(perlinFbm(p, 3.0, 6) * 0.5 + 0.5);
  let worley5 = 1.0 - worley3(p * 5.0, 5.0);
  let worley10 = 1.0 - worley3(p * 10.0, 10.0);
  let worley20 = 1.0 - worley3(p * 20.0, 20.0);
  let perlinWorley = saturate(remap(perlin, 0.0, 1.0, worley5 * 0.6, 1.0));
  textureStore(shapeNoise, id, vec4f(perlinWorley, worley5, worley10, worley20));
}
