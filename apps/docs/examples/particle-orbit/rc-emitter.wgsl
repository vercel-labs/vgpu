// Emitter field derived from the frame itself: bright scene pixels occlude
// with a faint bounce tint, the orbs are stamped analytically as emitters.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct Params {
  time: f32,
  aspect: f32,
}
@group(0) @binding(2) var<uniform> params: Params;

const FOCAL_PX = 360.0;
const FRAME = 480.0;
// Luminance above this reads as solid geometry in the light field.
const OCCLUDER_THRESHOLD = 0.30;

fn orbit(index: f32, time: f32) -> vec3f {
  let radius = 0.62 + index * 0.34;
  let speed = 0.56 - index * 0.07;
  let angle = time * speed + index * 1.5707963;
  let tilt = -0.42 + index * 0.28;
  let local = vec2f(cos(angle) * radius, sin(angle) * radius * 0.62);
  let c = cos(tilt);
  let s = sin(tilt);
  let xy = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  return vec3f(xy, 3.2 + sin(angle) * 0.28);
}

fn headUv(index: f32, time: f32, aspect: f32) -> vec2f {
  let p = orbit(index, time);
  let px = p.xy * (FOCAL_PX / max(p.z, 0.01));
  return vec2f(0.5 + px.x / (FRAME * aspect), 0.5 - px.y / FRAME);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var colors = array<vec3f, 4>(
    vec3f(1.0, 0.235, 0.275),
    vec3f(0.47, 1.0, 0.51),
    vec3f(1.0, 0.39, 0.9),
    vec3f(0.47, 0.63, 1.0),
  );

  let sampled = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  let luminance = dot(sampled, vec3f(0.2126, 0.7152, 0.0722));
  var radiance = vec3f(0.0);
  var occupancy = 0.0;
  if (luminance > OCCLUDER_THRESHOLD) {
    radiance = sampled * 0.22;
    occupancy = 1.0;
  }

  let p = (uv - vec2f(0.5)) * vec2f(params.aspect, 1.0);

  // Diffuse ember: wide gaussian, no hard edge.
  let emberDistance = length(p) / 0.12;
  let emberFalloff = exp(-emberDistance * emberDistance * 2.0);
  if (emberFalloff > 0.05) {
    radiance = vec3f(0.4, 0.62, 1.5) * 1.0 * emberFalloff;
    occupancy = 1.0;
  }

  for (var i = 0u; i < 4u; i++) {
    let head = (headUv(f32(i), params.time, params.aspect) - uv) *
      vec2f(params.aspect, 1.0);
    if (length(head) < 0.013) {
      radiance = colors[i] * 4.0;
      occupancy = 1.0;
    }
  }

  return vec4f(radiance, occupancy);
}
