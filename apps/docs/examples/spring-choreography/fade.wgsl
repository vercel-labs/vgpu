// Trails: instead of clearing, the scene is multiplied by `keep` (blend
// src = zero, dst = src) before the sparks are drawn, so every spark leaves
// an exponentially fading light trail in the HDR target.

struct Fade {
  keep: f32,
}

@group(0) @binding(0) var<uniform> fade: Fade;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(vec3f(fade.keep), 1.0);
}
