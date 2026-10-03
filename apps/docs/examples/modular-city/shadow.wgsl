import { instanceWorldMatrix, transformPosition } from "@vgpu/wgsl-std/scene";
import { Scene } from "./common.wgsl";

@group(0) @binding(1) var<uniform> scene: Scene;

// Every instance attribute matches by name, so this depth-only pass declares them all even
// though it only reads the world columns.
struct ShadowInput {
  @location(0) position: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) pickId: u32,
  @location(8) tint: vec3f,
  @location(9) style: vec4u,
}

// Depth-only sun pass over the same published instance bridges as the color pass.
@vertex
fn vs_main(input: ShadowInput) -> @builtin(position) vec4f {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  return scene.lightViewProjection * vec4f(transformPosition(world, input.position), 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0);
}
