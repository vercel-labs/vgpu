// DPR1 bloom: downsample + soft threshold, then dense separable 7-tap Gaussian blur.
const BLOOM_SAMPLES_PER_SIDE: i32 = 3;

struct Config { target_size: vec4f, params: vec4f, options: vec4f, bloom_bounds: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

struct VSOut { @builtin(position) pos: vec4f };

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  return out;
}

fn soft_threshold(c: vec3f) -> vec3f {
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let mask = smoothstep(cfg.params.z, cfg.params.z + 0.5, lum);
  return c * mask;
}

fn gaussian_weight_1d(offset: f32) -> f32 {
  let sigma = max(cfg.params.w, 0.001);
  return exp(-(offset * offset) / (2.0 * sigma * sigma));
}

fn blur_gaussian(uv: vec2f) -> vec3f {
  // Dense unit-texel spacing avoids the sparse-grid pixelation artifacts from wider tap spacing.
  let texel_step = cfg.params.xy / cfg.target_size.xy;
  var colour = vec3f(0.0);
  var weight_sum = 0.0;
  for (var i = -BLOOM_SAMPLES_PER_SIDE; i <= BLOOM_SAMPLES_PER_SIDE; i = i + 1) {
    let offset = f32(i);
    let weight = gaussian_weight_1d(offset);
    colour += textureSampleLevel(source_tex, linear_samp, uv + texel_step * offset, 0.0).rgb * weight;
    weight_sum += weight;
  }
  return colour / weight_sum;
}

fn outside_bloom_bounds(pixel: vec2f) -> bool {
  return pixel.x < cfg.bloom_bounds.x ||
    pixel.y < cfg.bloom_bounds.y ||
    pixel.x > cfg.bloom_bounds.z ||
    pixel.y > cfg.bloom_bounds.w;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  if (outside_bloom_bounds(in.pos.xy)) {
    return vec4f(0.0);
  }

  let uv = in.pos.xy / cfg.target_size.xy;
  if (cfg.options.x < 0.5) {
    return vec4f(soft_threshold(textureSampleLevel(source_tex, linear_samp, uv, 0.0).rgb), 1.0);
  }
  return vec4f(blur_gaussian(uv), 1.0);
}
