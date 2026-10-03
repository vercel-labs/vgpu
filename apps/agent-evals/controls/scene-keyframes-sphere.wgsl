struct ViewState {
  viewProjection: mat4x4f,
}

@group(0) @binding(0) var<uniform> viewState: ViewState;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat, either) tint: vec4f,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) tint: vec4f,
  @location(8) pickingId: u32,
) -> VertexOutput {
  let world = mat4x4f(world0, world1, world2, world3);
  var output: VertexOutput;
  output.position = viewState.viewProjection * world * vec4f(position, 1.0);
  output.tint = tint;
  return output;
}

@fragment
fn fs_color(input: VertexOutput) -> @location(0) vec4f {
  return input.tint;
}
