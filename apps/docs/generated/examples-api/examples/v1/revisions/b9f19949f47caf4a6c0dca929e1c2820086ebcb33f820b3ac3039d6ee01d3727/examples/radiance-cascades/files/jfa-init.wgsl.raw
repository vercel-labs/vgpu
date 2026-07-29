import { jfa_empty, jfa_seed } from "./jfa-step.wgsl";

// Seeds the jump flood: every emitter texel points at itself, everything else is empty.
// Seeds are absolute pixel centres in an rgba32float target — f16 cannot hold a 2560-wide
// coordinate exactly, and a seed that is off by a texel becomes an SDF that is off by a
// texel, which sphere tracing turns into light leaking through a wall.

struct JfaInit {
  size: vec2f,
  /** Mask threshold: anything the paint pass wrote as opaque. */
  threshold: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> jfa: JfaInit;
@group(0) @binding(1) var emitter: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = clamp(floor(uv * jfa.size), vec2f(0.0), jfa.size - 1.0);
  let mask = textureLoad(emitter, vec2i(pixel), 0).a;
  if (mask > jfa.threshold) {
    return jfa_seed(pixel + 0.5);
  }
  return jfa_empty();
}
