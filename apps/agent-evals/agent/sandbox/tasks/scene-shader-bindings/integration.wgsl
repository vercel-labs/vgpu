struct CameraData {
  viewProjection: mat4x4f,
}

struct Style {
  gain: f32,
  floor: f32,
}

@group(0) @binding(0) var<uniform> style: Style;
@group(1) @binding(0) var<uniform> viewState: CameraData;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat, either) tint: vec4f,
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
) -> VertexOutput {
  let world = mat4x4f(world0, world1, world2, world3);
  var output: VertexOutput;
  output.position = viewState.viewProjection * world * vec4f(position, 1.0);
  output.tint = tint;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(
    vec3f(style.floor) + style.gain * input.tint.rgb,
    1.0,
  );
}
