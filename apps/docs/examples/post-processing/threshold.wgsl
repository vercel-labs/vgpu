struct Uniforms {
  resolution: vec2f,
  threshold: f32,
  knee: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;

fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
}

fn load_scene(pixel: vec2i) -> vec3f {
  let dims = vec2i(textureDimensions(scene_tex));
  return textureLoad(scene_tex, clamp(pixel, vec2i(0), dims - vec2i(1)), 0).rgb;
}

fn sample_scene_linear(uv: vec2f) -> vec3f {
  // Manual bilinear filtering works around the facade's conservative unfilterable-float
  // reflection while still producing a stable 2x downsample for the bloom chain.
  let dims = vec2f(textureDimensions(scene_tex));
  let coord = uv * dims - vec2f(0.5);
  let base = vec2i(floor(coord));
  let blend = fract(coord);
  let top = mix(load_scene(base), load_scene(base + vec2i(1, 0)), blend.x);
  let bottom = mix(load_scene(base + vec2i(0, 1)), load_scene(base + vec2i(1, 1)), blend.x);
  return mix(top, bottom, blend.y);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let color = sample_scene_linear(uv);
  let brightness = luma(color);
  // Preserve the hue of selected pixels. The narrow knee deliberately excludes every
  // mid-tone shape, leaving only the small emissive cores for the bloom blur.
  let selected = smoothstep(uniforms.threshold - uniforms.knee, uniforms.threshold + uniforms.knee, brightness);
  return vec4f(color * selected, 1.0);
}
