// Seeds the jump flood: every emitter texel points at itself, everything else is empty.
// Seeds are absolute pixel centres in an rgba32float target — f16 cannot hold a 2560-wide
// coordinate exactly, and a seed that is off by a texel becomes an SDF that is off by a
// texel, which sphere tracing turns into light leaking through a wall.

@group(0) @binding(0) var emitter: texture_2d<f32>;

fn jfa_empty() -> vec4f {
  return vec4f(0.0, 0.0, 0.0, 0.0);
}

fn jfa_seed(position: vec2f) -> vec4f {
  return vec4f(position, 0.0, 1.0);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(emitter));
  let pixel = clamp(floor(uv * size), vec2f(0.0), size - 1.0);
  let mask = textureLoad(emitter, vec2i(pixel), 0).a;
  if (mask > 0.5) {
    return jfa_seed(pixel + 0.5);
  }
  return jfa_empty();
}
