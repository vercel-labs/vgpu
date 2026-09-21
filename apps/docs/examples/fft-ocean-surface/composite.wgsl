// Tone-map the HDR scene to the canvas.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

const EXPOSURE = 0.62;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hdr = textureSampleLevel(src, samp, uv, 0.0).rgb * EXPOSURE;
  var col = pow(aces(hdr), vec3f(1.0 / 2.2));

  col = (col - 0.5) * 1.07 + 0.5;
  col *= vec3f(1.05, 1.0, 0.95);
  let d = uv - vec2f(0.5);
  col *= 1.0 - 0.28 * dot(d, d);

  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
