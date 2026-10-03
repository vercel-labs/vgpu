import { instanceWorldMatrix, transformPosition } from "@vgpu/wgsl-std/scene";
import { Studio } from "./studio.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;

// Depth-only key-light pass over the same published instance streams as the lit pass. Named
// instance attributes must have a shader input, so tint and finish are declared but unused.
struct CasterIn {
  @location(0) position: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) tint: vec3f,
  @location(8) finish: vec2f,
}

@vertex
fn vs_main(input: CasterIn) -> @builtin(position) vec4f {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  return studio.lightViewProjection * vec4f(transformPosition(world, input.position), 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0);
}
