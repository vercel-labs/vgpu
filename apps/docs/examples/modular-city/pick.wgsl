import { instanceWorldMatrix, transformPosition } from "@vgpu/wgsl-std/scene";
import { Camera } from "./common.wgsl";

// Bound to the pick camera: the same Camera struct with a projection that zooms onto the
// pixels around the pointer.
@group(0) @binding(0) var<uniform> camera: Camera;

// Declares every name-matched instance attribute of the shared bridge geometry.
struct PickInput {
  @location(0) position: vec3f,
  @location(3) world0: vec4f,
  @location(4) world1: vec4f,
  @location(5) world2: vec4f,
  @location(6) world3: vec4f,
  @location(7) pickId: u32,
  @location(8) tint: vec3f,
  @location(9) style: vec4u,
}

struct PickVarying {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat, either) pickId: u32,
}

@vertex
fn vs_main(input: PickInput) -> PickVarying {
  let world = instanceWorldMatrix(input.world0, input.world1, input.world2, input.world3);
  var output: PickVarying;
  output.clip = camera.viewProjection * vec4f(transformPosition(world, input.position), 1.0);
  output.pickId = input.pickId;
  return output;
}

// The application pick code as four little-endian bytes of an rgba8unorm texel.
@fragment
fn fs_main(input: PickVarying) -> @location(0) vec4f {
  let id = input.pickId;
  let bytes = vec4u(id & 0xffu, (id >> 8u) & 0xffu, (id >> 16u) & 0xffu, id >> 24u);
  return vec4f(bytes) / 255.0;
}
