// Black void with three orbiting haze lobes, canvas gradients gone analytic.
struct Params {
  time: f32,
  aspect: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

// Pixel-space math matches the source's 480px square frame.
const FRAME = 480.0;

fn gradientStops(t: f32, mid: f32, c0: vec4f, c1: vec4f, c2: vec4f) -> vec4f {
  if (t < mid) {
    return mix(c0, c1, t / mid);
  }
  return mix(c1, c2, (t - mid) / (1.0 - mid));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = (uv - vec2f(0.5)) * vec2f(params.aspect, 1.0) * FRAME;
  let orbit = params.time * 0.6;
  var color = vec3f(0.0);
  for (var i = 0u; i < 3u; i++) {
    let angle = f32(i) * 2.0943951 + orbit * 0.3;
    let center = vec2f(cos(angle) * 70.0, sin(angle) * 50.0);
    let lobe = gradientStops(
      clamp(length(p - center) / 200.0, 0.0, 1.0),
      0.5,
      vec4f(0.157, 0.275, 0.667, 0.20),
      vec4f(0.039, 0.078, 0.275, 0.08),
      vec4f(0.0),
    );
    // 'screen' over an opaque backdrop: dst + a·src·(1 − dst).
    color += lobe.a * lobe.rgb * (1.0 - color);
  }
  return vec4f(color, 1.0);
}
