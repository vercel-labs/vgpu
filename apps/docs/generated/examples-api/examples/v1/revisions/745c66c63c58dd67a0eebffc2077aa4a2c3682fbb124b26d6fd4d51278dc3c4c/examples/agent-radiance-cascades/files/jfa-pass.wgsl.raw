import { jfa_pick } from "./jfa-step.wgsl";

// One jump-flood round: look at the 3x3 neighborhood `jump` texels away and keep the
// nearest seed. Run with jump = size/2, size/4 ... 1 the seeds converge to the exact
// nearest emitter in ceil(log2(size)) passes instead of a search per texel.

struct JfaStep {
  size: vec2f,
  jump: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> jfa: JfaStep;
@group(0) @binding(1) var seeds: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = clamp(floor(uv * jfa.size), vec2f(0.0), jfa.size - 1.0);
  let position = pixel + 0.5;
  let coord = vec2i(pixel);
  let limit = vec2i(jfa.size) - vec2i(1);
  let jump = i32(jfa.jump);

  var best = textureLoad(seeds, coord, 0);
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let neighbor = coord + vec2i(x, y) * jump;
      // Out-of-bounds neighbors are skipped rather than clamped: a clamped read would
      // duplicate the edge seed and bias distances along the border.
      if (neighbor.x < 0 || neighbor.y < 0 || neighbor.x > limit.x || neighbor.y > limit.y) { continue; }
      best = jfa_pick(best, textureLoad(seeds, neighbor, 0), position);
    }
  }
  return best;
}
