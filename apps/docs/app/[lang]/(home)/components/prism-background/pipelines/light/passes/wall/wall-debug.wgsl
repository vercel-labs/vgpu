import { LightWall, WallSample, evaluateWall, wallPoint } from "./wall-common.wgsl";
import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

@group(0) @binding(0) var<uniform> params: LightWall;
@group(0) @binding(1) var wallMaterial: texture_2d<f32>;
@group(0) @binding(2) var wallLighting: texture_2d<f32>;
@group(0) @binding(3) var materialSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPosition: vec2f,
};

@vertex
fn vs_debug(@builtin(vertex_index) index: u32) -> VertexOut {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
  );
  let uv = corners[index];
  let worldPosition = wallPoint(params, uv);
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(worldPosition, 0.0, 1.0);
  out.uv = uv;
  out.worldPosition = worldPosition;
  return out;
}

fn sample(in: VertexOut) -> WallSample {
  return evaluateWall(in.worldPosition, in.uv, params, wallMaterial, wallLighting, materialSampler);
}

@fragment fn fs_albedo(in: VertexOut) -> @location(0) vec4f { return vec4f(sample(in).albedo, 1.0); }
@fragment fn fs_large_normal(in: VertexOut) -> @location(0) vec4f { return vec4f(sample(in).largeNormal * 0.5 + 0.5, 1.0); }
@fragment fn fs_micro_normal(in: VertexOut) -> @location(0) vec4f { return vec4f(sample(in).microNormal * 0.5 + 0.5, 1.0); }
@fragment fn fs_normal(in: VertexOut) -> @location(0) vec4f { return vec4f(sample(in).normal * 0.5 + 0.5, 1.0); }
@fragment fn fs_roughness(in: VertexOut) -> @location(0) vec4f { return vec4f(vec3f(sample(in).roughness), 1.0); }
@fragment fn fs_global_shadow(in: VertexOut) -> @location(0) vec4f { return vec4f(vec3f(sample(in).globalLight), 1.0); }
@fragment fn fs_prism_shadow(in: VertexOut) -> @location(0) vec4f { return vec4f(vec3f(sample(in).prismShadow), 1.0); }
@fragment fn fs_prism_ao(in: VertexOut) -> @location(0) vec4f { return vec4f(vec3f(sample(in).prismAo), 1.0); }
@fragment fn fs_composed(in: VertexOut) -> @location(0) vec4f {
  let composed = max(sample(in).composed, vec3f(0.0));
  return vec4f(linearToSrgb3(tonemapAces(composed)), 1.0);
}
