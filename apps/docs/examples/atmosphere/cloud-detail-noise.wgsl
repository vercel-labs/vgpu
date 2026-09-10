import { worley3 } from "./noise-common.wgsl";

@group(0) @binding(0) var detailNoise: texture_storage_3d<rgba8unorm, write>;

const SIZE: f32 = 32.0;

/** High-frequency erosion detail: inverted Worley at 2, 4 and 8 cells. */
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(id) + 0.5) / SIZE;
  let worley2 = 1.0 - worley3(p * 2.0, 2.0);
  let worley4 = 1.0 - worley3(p * 4.0, 4.0);
  let worley8 = 1.0 - worley3(p * 8.0, 8.0);
  textureStore(detailNoise, id, vec4f(worley2, worley4, worley8, 1.0));
}
