// Cascade 0 resolved to per-pixel irradiance. Probes are addressed by field
// pixel: the atlas is padded, so mapping uv through it would stretch the field.
import { rc_atlas_texel, rc_block_size, rc_ray_count } from './rc-directions.wgsl';

@group(0) @binding(0) var cascade_tex: texture_2d<f32>;
@group(0) @binding(1) var field_tex: texture_2d<f32>;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let block = rc_block_size(0.0);
  let rays = rc_ray_count(0.0);
  let field_size = vec2f(textureDimensions(field_tex));
  let probe = clamp(floor(uv * field_size), vec2f(0.0), field_size - 1.0);
  var total = vec3f(0.0);
  for (var i = 0.0; i < rays; i = i + 1.0) {
    let coord = rc_atlas_texel(probe, i, block);
    total += textureLoad(cascade_tex, vec2i(coord), 0).rgb;
  }
  return vec4f(total / rays, 1.0);
}
