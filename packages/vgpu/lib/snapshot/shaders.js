export const SNAPSHOT_SIZE = [16, 16];

export const REPRESENTATIVE_GRADIENT_WGSL = `
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;

@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let wave = sin(params.time * params.speed) * 0.5 + 0.5;
  return vec4f(uv.x, uv.y, wave, 1.0);
}
`;
