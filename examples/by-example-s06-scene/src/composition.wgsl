import {
  instanceWorldMatrix,
  transformNormal,
  transformPosition,
} from "@vgpu/wgsl-std/scene";

struct CameraData {
  viewProjection: mat4x4f,
}

@group(1) @binding(0) var<uniform> camera: CameraData;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat, either) worldOrigin: vec3f,
  @location(1) @interpolate(flat, either) tint: vec4f,
  @location(2) @interpolate(flat, either) pickingId: u32,
  @location(3) worldNormal: vec3f,
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
  let world = instanceWorldMatrix(world0, world1, world2, world3);
  var output: VertexOutput;
  output.position = camera.viewProjection * vec4f(transformPosition(world, position), 1.0);
  output.worldOrigin = transformPosition(world, vec3f(0.0));
  output.tint = tint;
  output.pickingId = pickingId;
  output.worldNormal = transformNormal(world, normal);
  return output;
}

@fragment
fn fs_position(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.worldOrigin, input.tint.a * length(input.worldNormal));
}

@fragment
fn fs_color(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.tint.rgb * length(input.worldNormal), f32(input.pickingId));
}
