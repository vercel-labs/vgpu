// Direction-first atlas addressing shared by the cascade and presentation passes.

const TAU: f32 = 6.283185307179586;

export fn rc_ray_count(cascade: f32, direction_base: f32) -> f32 {
  let block = rc_block_size(cascade, direction_base);
  return block * block;
}

export fn rc_probe_spacing(cascade: f32) -> f32 {
  return pow(2.0, cascade);
}

// Spacing and block size both double, so every cascade fills the same atlas.
export fn rc_block_size(cascade: f32, direction_base: f32) -> f32 {
  return direction_base * pow(2.0, cascade);
}

export fn rc_direction(index: f32, rays: f32) -> vec2f {
  let theta = TAU * (index + 0.5) / rays;
  return vec2f(cos(theta), sin(theta));
}

export fn rc_atlas_decode(texel: vec2f, block: f32) -> vec3f {
  let probe = floor(texel / block);
  let slot = texel - probe * block;
  return vec3f(probe, slot.y * block + slot.x);
}

export fn rc_atlas_texel(probe: vec2f, direction_index: f32, block: f32) -> vec2f {
  let slot = vec2f(direction_index % block, floor(direction_index / block));
  return probe * block + slot;
}

export fn rc_probe_origin(probe: vec2f, spacing: f32) -> vec2f {
  return (probe + 0.5) * spacing;
}
