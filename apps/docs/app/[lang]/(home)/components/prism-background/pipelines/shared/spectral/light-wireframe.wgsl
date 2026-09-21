// Triangle topology of the generated light sheet. Every six vertices are one
// quad split into two triangles, so the diagonal is intentionally visible.

import { Scene } from "../../../scene/scene.wgsl";

@group(0) @binding(0) var<uniform> scene: Scene;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) barycentric: vec3f,
  @location(1) @interpolate(flat, either) quadIndex: u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) index: u32,
  @location(0) position: vec2f,
) -> VertexOut {
  var corners = array<vec3f, 3>(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0),
  );
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(position, scene.lightPlaneZ, 1.0);
  out.barycentric = corners[index % 3u];
  out.quadIndex = index / 6u;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  if in.quadIndex >= scene.lightWhiteQuads {
    let spectralQuad = in.quadIndex - scene.lightWhiteQuads;
    if spectralQuad < scene.lightInternalQuads {
      let ray = spectralQuad / scene.lightInternalSegments;
      let wavelength = ray / scene.lightBeamSlices;
      let profile = ray % scene.lightBeamSlices;
      let wavelengthStride = max(1u, scene.lightSpectralSamples / 16u);
      let profileStride = max(1u, scene.lightBeamSlices / 4u);
      if wavelength % wavelengthStride != 0u || profile % profileStride != 0u {
        discard;
      }
    } else {
      let outgoingCell = spectralQuad - scene.lightInternalQuads;
      let interval = outgoingCell / scene.lightBeamSlices;
      let profile = outgoingCell % scene.lightBeamSlices;
      let wavelengthStride = max(1u, scene.lightSpectralSamples / 16u);
      let profileStride = max(1u, scene.lightBeamSlices / 4u);
      if interval % wavelengthStride != 0u || profile % profileStride != 0u {
        discard;
      }
    }
  }
  let closest = min(in.barycentric.x, min(in.barycentric.y, in.barycentric.z));
  let pixel = max(fwidth(closest), 1e-5);
  let line = 1.0 - smoothstep(pixel * 0.7, pixel * 1.7, closest);
  let alpha = line * 0.72;
  return vec4f(vec3f(0.08, 0.42, 0.46) * alpha, alpha);
}
