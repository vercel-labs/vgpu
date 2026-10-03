struct ViewState {
  viewProjection: mat4x4f,
}

@group(0) @binding(0) var<uniform> viewState: ViewState;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat, either) tint: vec4f,
  @location(1) @interpolate(flat, either) pickingId: u32,
}

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) world0: vec4f,
  @location(3) world1: vec4f,
  @location(4) world2: vec4f,
  @location(5) world3: vec4f,
  @location(6) tint: vec4f,
  @location(7) pickingId: u32,
) -> VertexOutput {
  let world = mat4x4f(world0, world1, world2, world3);
  var output: VertexOutput;
  output.position = viewState.viewProjection * world * vec4f(position, 1.0);
  output.tint = tint;
  output.pickingId = pickingId;
  return output;
}

@fragment
fn fs_color(input: VertexOutput) -> @location(0) vec4f {
  return input.tint;
}

@fragment
fn fs_ids(input: VertexOutput) -> @location(0) vec4f {
  let id = input.pickingId;
  return vec4f(
    f32(id & 255u) / 255.0,
    f32((id >> 8u) & 255u) / 255.0,
    f32((id >> 16u) & 255u) / 255.0,
    1.0,
  );
}
