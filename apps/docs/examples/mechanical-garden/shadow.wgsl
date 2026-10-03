import { instanceWorldMatrix, transformPosition } from "@vgpu/wgsl-std/scene";
import { Scene } from "./common.wgsl";

@group(0) @binding(1) var<uniform> scene: Scene;

// Instance attributes match by name, so the depth-only pass declares them all.
struct ShadowInput {
  @location(0) position: vec3f,
  @location(2) material: f32,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) style: vec4f,
}

// Depth-only sun pass over the same instance bridges as the colour pass.
@vertex
fn vs_main(input: ShadowInput) -> @builtin(position) vec4f {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  return scene.lightViewProjection * vec4f(transformPosition(world, input.position), 1.0);
}

// Terrain casts too (its own vertex layout: no instance attributes).
@vertex
fn vs_terrain(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return scene.lightViewProjection * vec4f(position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0);
}
