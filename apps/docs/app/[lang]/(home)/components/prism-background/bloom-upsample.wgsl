// One additive step of the bloom reconstruction chain.
//
// The source is the next-smaller pyramid level. Its filtered contribution is
// blended over the preserved destination, so updated energy travels from
// 1/16 -> 1/8 -> 1/4 -> 1/2 without another ping-pong texture.

struct UpsampleParams {
  sourceTexelSize: vec2f,
  radius: f32,
  scatter: f32,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: UpsampleParams;

const TAU = 6.28318530718;

fn hash12(pixel: vec2f) -> f32 {
  let p = fract(pixel * vec2f(0.1031, 0.1030));
  let mixed = p + dot(p, p.yx + vec2f(33.33));
  return fract((mixed.x + mixed.y) * mixed.x);
}

@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @builtin(position) position: vec4f,
) -> @location(0) vec4f {
  let rotation = hash12(floor(position.xy) + vec2f(19.0, 73.0)) * TAU;
  let radius = max(params.radius, 0.0);
  var color = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb * 0.25;
  for (var tap = 0; tap < 6; tap = tap + 1) {
    let angle = rotation + f32(tap) * (TAU / 6.0);
    let offset = vec2f(cos(angle), sin(angle)) * params.sourceTexelSize * radius;
    color += textureSampleLevel(sourceTexture, sourceSampler, uv + offset, 0.0).rgb
      * 0.125;
  }
  return vec4f(color * max(params.scatter, 0.0), 0.0);
}
