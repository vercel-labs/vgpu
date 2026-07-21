struct Uniforms {
  resolution: vec2f,
  threshold: f32,
  knee: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
}

fn load_scene(uv: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(scene_tex));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(scene_tex, pixel, 0).rgb;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let color = load_scene(uv);
  let brightness = luma(color);
  // Preserve the hue of selected pixels. The narrow knee deliberately excludes every
  // mid-tone shape, leaving only the small emissive cores for the bloom blur.
  let selected = smoothstep(uniforms.threshold - uniforms.knee, uniforms.threshold + uniforms.knee, brightness);
  return vec4f(color * selected, 1.0);
}
