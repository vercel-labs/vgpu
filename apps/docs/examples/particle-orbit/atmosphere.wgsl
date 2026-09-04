// Multiplies the field by the fog vignette, then screens the ember over it.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct Params {
  time: f32,
  aspect: f32,
}
@group(0) @binding(2) var<uniform> params: Params;

const FRAME = 480.0;

fn gradientStops(t: f32, mid: f32, c0: vec4f, c1: vec4f, c2: vec4f) -> vec4f {
  if (t < mid) {
    return mix(c0, c1, t / mid);
  }
  return mix(c1, c2, (t - mid) / (1.0 - mid));
}

// Canvas stops: white → #a8aab4 @0.4 → #2a2c38 @0.75 → #050608, radius 50→290px.
fn fogTint(t: f32) -> vec3f {
  let c0 = vec3f(1.0, 1.0, 1.0);
  let c1 = vec3f(0.659, 0.667, 0.706);
  let c2 = vec3f(0.165, 0.173, 0.220);
  let c3 = vec3f(0.020, 0.024, 0.031);
  if (t < 0.4) {
    return mix(c0, c1, t / 0.4);
  }
  if (t < 0.75) {
    return mix(c1, c2, (t - 0.4) / 0.35);
  }
  return mix(c2, c3, (t - 0.75) / 0.25);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let p = (uv - vec2f(0.5)) * vec2f(params.aspect, 1.0) * FRAME;
  color *= fogTint(clamp((length(p) - 50.0) / 240.0, 0.0, 1.0));

  // Four orbiting lobes, 'screen'-composited: stays below 1, never blows out.
  let orbit = params.time * 0.6;
  for (var i = 0u; i < 4u; i++) {
    let angle = f32(i) * 1.5707963 + orbit;
    let center = vec2f(cos(angle) * 18.0, sin(angle * 1.1) * 14.0);
    let radius = 110.0 + 20.0 * sin(orbit * 1.4 + f32(i));
    let ember = gradientStops(
      clamp(length(p - center) / radius, 0.0, 1.0),
      0.4,
      vec4f(0.275, 0.431, 0.941, 0.55),
      vec4f(0.118, 0.235, 0.667, 0.22),
      vec4f(0.0),
    );
    color += ember.a * ember.rgb * (1.0 - color);
  }
  // Gentle HDR lift for the bloom to shape, no edge introduced.
  let r = length(p);
  color += vec3f(0.25, 0.45, 1.0) * 0.05 * exp(-r * r / 3200.0);
  return vec4f(color, 1.0);
}
