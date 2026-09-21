import { perlinFbm } from "./noise-common.wgsl";

@group(0) @binding(0) var curlNoise: texture_storage_2d<rgba8unorm, write>;

const SIZE: f32 = 128.0;

/** Tileable 2D curl field (rg, centred at 0.5): the divergence-free flow that distorts cloud edges into wisps. */
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec2f(id.xy) + 0.5) / SIZE;
  let e = 1.0 / SIZE;
  // Curl of a scalar potential: (dP/dy, -dP/dx). Finite differences on the tileable fbm keep it seamless.
  let potentialX0 = perlinFbm(vec3f(p.x - e, p.y, 0.61), 4.0, 4);
  let potentialX1 = perlinFbm(vec3f(p.x + e, p.y, 0.61), 4.0, 4);
  let potentialY0 = perlinFbm(vec3f(p.x, p.y - e, 0.61), 4.0, 4);
  let potentialY1 = perlinFbm(vec3f(p.x, p.y + e, 0.61), 4.0, 4);
  let curl = vec2f(potentialY1 - potentialY0, -(potentialX1 - potentialX0)) / (2.0 * e);
  // Normalise to roughly [-1, 1] before packing.
  let packed = clamp(curl * 0.02, vec2f(-1.0), vec2f(1.0)) * 0.5 + 0.5;
  textureStore(curlNoise, id.xy, vec4f(packed, 0.0, 1.0));
}
