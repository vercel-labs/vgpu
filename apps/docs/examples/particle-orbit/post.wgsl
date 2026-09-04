// CRT finish over the composite.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var radiance: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct Params {
  time: f32,
  aspect: f32,
  pointer: vec2f,
}
@group(0) @binding(4) var<uniform> params: Params;

fn pcg(seed: u32) -> u32 {
  var state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash01(seed: u32) -> f32 {
  return f32(pcg(seed)) * (1.0 / 4294967295.0);
}

@fragment fn fs_main(
  @builtin(position) frag: vec4f,
  @location(0) uv: vec2f,
) -> @location(0) vec4f {
  // Subtle pointer parallax; a slight zoom keeps the shifted sample on-frame.
  let centered = (uv - vec2f(0.5)) / 1.02;
  let lookup = centered + vec2f(0.5) + params.pointer * vec2f(0.012, -0.012);
  // Chromatic aberration: red out, blue in, growing toward the corners.
  let fringe = centered * 0.006;
  var color = vec3f(
    textureSampleLevel(src, samp, lookup + fringe, 0.0).r,
    textureSampleLevel(src, samp, lookup, 0.0).g,
    textureSampleLevel(src, samp, lookup - fringe, 0.0).b,
  );
  // Radiance lands on surfaces (scaled by the pixel underneath), with only
  // a faint haze in the void, so it never reads as a second orb in the air.
  let irradiance = textureSampleLevel(radiance, samp, lookup, 0.0).rgb;
  let surface = clamp(dot(color, vec3f(0.2126, 0.7152, 0.0722)) * 2.6, 0.0, 1.0);
  color += irradiance * (0.04 + 0.7 * surface);
  color += textureSampleLevel(bloom, samp, lookup, 0.0).rgb * 0.55;

  let scan = step(0.5, fract(uv.y * 200.0));
  color *= mix(0.88, 1.0, scan);
  color *= 1.0 + sin(params.time) * 0.04;
  color *= 1.0 + sin(uv.y * 60.0 + params.time * 0.9) * 0.022;

  // Film grain, reshuffled ~11×/s like the source's noise canvas.
  let cell = vec2u(frag.xy);
  let epoch = u32(params.time * 11.0);
  let grain = hash01(cell.x ^ pcg(cell.y ^ pcg(epoch)));
  color = mix(color, vec3f(grain), 0.025);

  let vignette = 1.0 - smoothstep(0.55, 1.05, length(centered) * 1.9);
  color *= mix(0.62, 1.0, vignette);
  color *= smoothstep(0.0, 2.2, params.time);

  return vec4f(color, 1.0);
}
