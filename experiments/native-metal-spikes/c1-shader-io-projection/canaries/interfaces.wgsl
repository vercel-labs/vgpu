enable dual_source_blending;

struct VertexInputs {
  @location(3) model_position: vec3f,
  @location(7) weight: f32,
  @builtin(vertex_index) vertex_number: u32,
  @builtin(instance_index) instance_number: u32,
}

struct VertexOutputs {
  @builtin(position) clip_position: vec4f,
  @location(2) @interpolate(linear, centroid) uv: vec2f,
  @location(5) @interpolate(flat) tag: u32,
  @location(6) shade: f32,
}

@vertex
fn vertex_main(input: VertexInputs) -> VertexOutputs {
  let offset = f32(input.vertex_number & 1u) * 0.01 + f32(input.instance_number & 1u) * 0.02;
  return VertexOutputs(
    vec4f(input.model_position.xy + vec2f(offset), input.model_position.z, 1.0),
    vec2f(input.weight, offset),
    input.instance_number,
    input.weight,
  );
}

struct FragmentInputs {
  @builtin(position) pixel_position: vec4f,
  @builtin(front_facing) is_front: bool,
  @builtin(sample_index) sample_number: u32,
  @location(2) @interpolate(linear, centroid) uv: vec2f,
  @location(5) @interpolate(flat) tag: u32,
  @location(6) shade: f32,
}

struct FragmentOutputs {
  @location(0) @blend_src(0) primary: vec4f,
  @location(0) @blend_src(1) secondary: vec4f,
  @builtin(frag_depth) depth: f32,
  @builtin(sample_mask) coverage: u32,
}

@fragment
fn fragment_main(input: FragmentInputs) -> FragmentOutputs {
  let facing = select(0.25, 1.0, input.is_front);
  let sample_bit = f32(input.sample_number & 1u);
  let tag_bit = f32(input.tag & 1u);
  let color = vec4f(input.uv, input.shade + tag_bit * 0.01, facing);
  return FragmentOutputs(
    color,
    vec4f(sample_bit, input.pixel_position.x * 0.001, 0.0, 1.0),
    input.pixel_position.z,
    0xffffffffu,
  );
}

@fragment
fn fragment_single(input: FragmentInputs) -> @location(0) vec4f {
  let facing = select(0.25, 1.0, input.is_front);
  let sample_bit = f32(input.sample_number & 1u);
  let tag_bit = f32(input.tag & 1u);
  return vec4f(
    input.uv,
    input.shade + tag_bit * 0.01 + sample_bit * 0.001,
    facing + input.pixel_position.x * 0.0001,
  );
}

@fragment
fn scalar_fragment(@location(9) amount: f32) -> @location(3) vec4f {
  return vec4f(amount);
}

struct SparseVertexOutputs {
  @builtin(position) position: vec4f,
  @location(9) amount: f32,
}

@vertex
fn sparse_vertex(@builtin(vertex_index) vertex_number: u32) -> SparseVertexOutputs {
  let x = f32((vertex_number << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vertex_number & 2u) * 2.0 - 1.0;
  return SparseVertexOutputs(vec4f(x, y, 0.0, 1.0), f32(vertex_number) / 3.0);
}

@vertex
fn position_only_vertex(@builtin(vertex_index) vertex_number: u32) -> @builtin(position) vec4f {
  let x = f32((vertex_number << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vertex_number & 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn constant_color3_fragment() -> @location(3) vec4f {
  return vec4f(0.25, 0.5, 0.75, 1.0);
}

struct SparseMrtOutputs {
  @location(1) first: vec4f,
  @location(4) second: vec4f,
}

@fragment
fn sparse_mrt_fragment() -> SparseMrtOutputs {
  return SparseMrtOutputs(vec4f(1.0, 0.0, 0.0, 1.0), vec4f(0.0, 1.0, 0.0, 1.0));
}

struct DualConstantOutputs {
  @location(0) @blend_src(0) primary: vec4f,
  @location(0) @blend_src(1) secondary: vec4f,
}

@fragment
fn dual_constant_fragment() -> DualConstantOutputs {
  return DualConstantOutputs(
    vec4f(0.25, 0.5, 0.75, 0.8),
    vec4f(0.5, 0.25, 0.75, 0.5),
  );
}

@fragment
fn missing_interstage_fragment(@location(4) missing: f32) -> @location(0) vec4f {
  return vec4f(missing);
}

@fragment
fn interpolation_mismatch_fragment(
  @location(2) @interpolate(perspective, centroid) uv: vec2f,
) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}

@fragment
fn type_mismatch_fragment(
  @location(2) @interpolate(flat) value: u32,
) -> @location(0) vec4f {
  return vec4f(f32(value));
}
