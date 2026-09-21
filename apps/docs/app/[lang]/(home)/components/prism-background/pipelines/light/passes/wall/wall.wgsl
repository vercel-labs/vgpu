import { LightWall, evaluateWall, wallPoint } from "./wall-common.wgsl";

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
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
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

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let wall = evaluateWall(
    in.worldPosition,
    in.uv,
    params,
    wallMaterial,
    wallLighting,
    materialSampler,
  );
  return vec4f(max(wall.composed, vec3f(0.0)), 1.0);
}
