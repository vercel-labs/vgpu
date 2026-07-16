import { lambert } from "@vgpu/wgsl-std/light";

struct Camera { viewProjection: mat4x4f }
struct Model { matrix: mat4x4f }
struct Light { direction: vec3f, color: vec3f, intensity: f32 }

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: Model;
@group(0) @binding(2) var<uniform> light: Light;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
};

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  let world = model.matrix * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = camera.viewProjection * world;
  out.normal = normalize((model.matrix * vec4f(normal, 0.0)).xyz);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let lit = lambert(in.normal, light.direction, light.color, light.intensity);
  return vec4f(lit, 1.0);
}
