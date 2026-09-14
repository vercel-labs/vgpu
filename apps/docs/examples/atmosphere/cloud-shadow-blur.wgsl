@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var filtered: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var linearSampler: sampler;

/**
 * A 5x5 binomial filter, evaluated once on the near shadow map before terrain and air sample it.
 * Pair each side's [4, 1] weights with bilinear sampling: nine fetches instead of twenty-five.
 * Filter transmittance (the visible light fraction), so the kernel preserves average shadow strength.
 */
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(source);
  if (any(id.xy >= size)) { return; }
  let texel = 1.0 / vec2f(size);
  let uv = (vec2f(id.xy) + 0.5) * texel;
  var light = 0.0;
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let weight = select(0.3125, 0.375, x == 0) * select(0.3125, 0.375, y == 0);
      light += weight * textureSampleLevel(source, linearSampler, uv + vec2f(f32(x), f32(y)) * 1.2 * texel, 0.0).r;
    }
  }
  textureStore(filtered, id.xy, vec4f(light, 0.0, 0.0, 1.0));
}
