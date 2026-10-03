import { instanceWorldMatrix, transformPosition } from "@vgpu/wgsl-std/scene";
import { Studio } from "./common.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;

// Every attribute of the shared instance stream is declared, `look` included, so all three
// collections cast through this one shader.
struct CasterIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) look: vec4f,
}

@vertex
fn vs_main(input: CasterIn) -> @builtin(position) vec4f {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  return studio.lightViewProjection * vec4f(transformPosition(world, input.position), 1.0);
}

// Only depth matters; the color attachment exists because targets always have one.
@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0);
}
