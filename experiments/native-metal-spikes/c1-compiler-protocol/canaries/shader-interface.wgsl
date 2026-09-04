struct VertexInputs {
  @location(3) model_position: vec2f,
  @location(7) tint: vec4f,
  @builtin(vertex_index) vertex_index: u32,
  @builtin(instance_index) instance_index: u32,
}

struct VertexOutputs {
  @builtin(position) @invariant position: vec4f,
  @location(2) @interpolate(linear, centroid) uv: vec2f,
  @location(5) @interpolate(flat) tag: u32,
  @location(6) weight: f32,
}

@vertex
fn vertex_main(input: VertexInputs) -> VertexOutputs {
  var output: VertexOutputs;
  output.position = vec4f(
    input.model_position + vec2f(f32(input.vertex_index), f32(input.instance_index)),
    0.0,
    1.0
  );
  output.uv = input.tint.xy;
  output.tag = input.vertex_index;
  output.weight = input.tint.w;
  return output;
}

struct FragmentInputs {
  @builtin(position) position: vec4f,
  @builtin(front_facing) front_facing: bool,
  @builtin(sample_index) sample_index: u32,
  @builtin(sample_mask) sample_mask: u32,
  @location(2) @interpolate(linear, centroid) uv: vec2f,
  @location(5) @interpolate(flat) tag: u32,
  @location(6) weight: f32,
}

struct FragmentOutputs {
  @location(1) first: vec4f,
  @location(4) second: vec4f,
  @builtin(frag_depth) depth: f32,
  @builtin(sample_mask) sample_mask: u32,
}

@fragment
fn fragment_main(input: FragmentInputs) -> FragmentOutputs {
  var output: FragmentOutputs;
  output.first = vec4f(input.uv, input.weight, select(0.0, 1.0, input.front_facing));
  output.second = vec4f(f32(input.tag), f32(input.sample_index), input.position.z, 1.0);
  output.depth = input.position.z;
  output.sample_mask = input.sample_mask;
  return output;
}

@fragment
fn scalar_fragment(@location(9) value: f32) -> @location(3) vec4f {
  return vec4f(value);
}

@compute @workgroup_size(1)
fn compute_builtins(
  @builtin(local_invocation_id) local_id: vec3u,
  @builtin(local_invocation_index) local_index: u32,
  @builtin(global_invocation_id) global_id: vec3u,
  @builtin(workgroup_id) workgroup_id: vec3u,
  @builtin(num_workgroups) workgroup_count: vec3u,
) {
  _ = local_id;
  _ = local_index;
  _ = global_id;
  _ = workgroup_id;
  _ = workgroup_count;
}
