struct Present {
  resolution: vec2f,
}

@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var sceneColor: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

// The scene target already holds tone-mapped sRGB; this pass resolves it with a soft vignette.
@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / present.resolution;
  let color = textureSampleLevel(sceneColor, linearSampler, uv, 0.0).rgb;
  let centered = (uv - 0.5) * vec2f(present.resolution.x / present.resolution.y, 1.0);
  let vignette = 1.0 - 0.32 * smoothstep(0.3, 1.1, length(centered));
  return vec4f(saturate(color * vignette), 1.0);
}
