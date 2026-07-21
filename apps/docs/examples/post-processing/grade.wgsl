struct Uniforms {
  resolution: vec2f,
  time: f32,
  bloomStrength: f32,
  caAmount: f32,
  grainAmount: f32,
  bloomOn: f32,
  caOn: f32,
  grainOn: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var linear_samp: sampler;

fn hash21(p: vec2f) -> f32 {
  let q = fract(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3))));
  return fract(sin(q.x + q.y) * 43758.5453);
}

fn load_scene(uv: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(scene_tex));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(scene_tex, pixel, 0).rgb;
}

fn load_bloom(uv: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(bloom_tex));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(bloom_tex, pixel, 0).rgb;
}

fn sample_composite(uv: vec2f) -> vec3f {
  return load_scene(uv) + load_bloom(uv) * uniforms.bloomStrength * uniforms.bloomOn;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let centered = uv - vec2f(0.5);
  // Classic radial lens separation: zero at the optical center and strongest at corners.
  // R and B travel in opposite directions while green remains the reference channel.
  let radial_offset = centered * dot(centered, centered) * uniforms.caAmount * uniforms.caOn;
  var color = vec3f(
    sample_composite(clamp(uv + radial_offset, vec2f(0.001), vec2f(0.999))).r,
    sample_composite(uv).g,
    sample_composite(clamp(uv - radial_offset, vec2f(0.001), vec2f(0.999))).b,
  );

  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  // Fine monochromatic grain varies per pixel/frame, but rolls away in blacks. This avoids
  // the previous whole-screen brightness pulse while retaining a deterministic fixed-time thumb.
  let grain_seed = position.xy + floor(uniforms.time * 60.0) * vec2f(47.13, 19.71);
  let grain = (hash21(grain_seed) - 0.5) * uniforms.grainAmount * smoothstep(0.025, 0.42, luminance);
  color += vec3f(grain) * uniforms.grainOn;

  let vignette = smoothstep(0.92, 0.30, distance(uv, vec2f(0.5)));
  color *= 0.76 + 0.28 * vignette;
  color = pow(max(color, vec3f(0.0)), vec3f(0.94));
  return vec4f(color, 1.0);
}
