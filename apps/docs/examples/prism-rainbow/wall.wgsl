// The wall: a plane at z = 0, facing the camera, painted with the light the
// deterministic light ribbons rasterized onto it.
//
// This is where the linear-light ribbon target is combined with the user-selected
// wall color. Its corners use the same world rectangle that clipped the CPU rays,
// so the rasterized fan and the wall plane stay registered at every aspect ratio.
//
// The wall uses the sRGB color selected in lil-gui wherever no light reaches it.
// The light target already contains all three parts of the same physical bundle:
// incoming white beam, refracted interior and dispersed outgoing fan.

import { linearToSrgb3, srgbToLinear3, tonemapAces } from "@vgpu/wgsl-std/color";
import { Scene, scenePoint } from "./scene.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var lightTexture: texture_2d<f32>;

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
  let light = textureLoad(lightTexture, vec2i(in.position.xy), 0).rgb;
  let wallBase = select(srgbToLinear3(scene.wallColor), vec3f(0.0), scene.causticOnly != 0u);
  return vec4f(linearToSrgb3(tonemapAces(wallBase + light)), 1.0);
}
