import { Frame, Material, Vertices } from "./types.wgsl";

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> vertices: Vertices;
@group(0) @binding(2) var albedo: texture_2d<f32>;
@group(0) @binding(3) var albedo_sampler: sampler;
@group(0) @binding(10) var<uniform> material: Material;

@vertex
fn resource_vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(vertices.values[index] + frame.offset, 0.0, 1.0);
}

@fragment
fn resource_fragment() -> @location(0) vec4f {
  let sampled = textureSample(albedo, albedo_sampler, vec2f(0.5));
  return sampled * material.tint + vec4f(frame.offset, 0.0, 0.0);
}
