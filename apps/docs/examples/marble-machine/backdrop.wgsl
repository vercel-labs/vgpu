import { Studio, backdropColor, display } from "./common.wgsl";

@group(0) @binding(0) var<uniform> studio: Studio;

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
}

// One triangle that covers the screen; drawn first and without depth, so the machine and the
// studio floor cover it.
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u)) * 2.0 - 1.0;
  var out: VertexOut;
  out.clip = vec4f(corner, 0.0, 1.0);
  out.ndc = corner;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let direction = normalize(
    studio.forward
      + studio.right * input.ndc.x * studio.tanHalfFov * studio.aspect
      + studio.up * input.ndc.y * studio.tanHalfFov,
  );
  return vec4f(display(backdropColor(direction), studio.exposure), 1.0);
}
