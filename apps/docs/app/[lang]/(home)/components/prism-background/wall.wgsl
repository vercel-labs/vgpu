// The wall: a plane at z = 0, facing the camera, written in linear HDR.
//
// The wall uses the sRGB color selected in lil-gui wherever no light reaches it.
// The light bundle is a separate sheet in front of this plane, composited between
// the prism's back and front glass interfaces.

import { srgbToLinear3 } from "@vgpu/wgsl-std/color";
import { Scene, scenePoint } from "./scene.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

/**
 * Two triangles covering the wall rectangle, wound counter-clockwise as the
 * camera sees them.
 *
 * There is no vertex buffer: the wall is defined by `scene.wallHalfExtent` and
 * the mapping in `scenePoint`, and reading those from the uniform block is what
 * keeps the plane in step with the texture when the canvas changes shape.
 */
@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
  );
  let uv = corners[index];
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(scenePoint(scene, uv), 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let wallBase = select(srgbToLinear3(scene.wallColor), vec3f(0.0), scene.causticOnly != 0u);
  return vec4f(wallBase, 1.0);
}
