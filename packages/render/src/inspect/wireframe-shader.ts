export const WIREFRAME_SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection: mat4x4<f32>,
  model: mat4x4<f32>,
  color: vec3<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
  return u.viewProjection * u.model * vec4<f32>(input.position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(u.color, 1.0);
}
`;
