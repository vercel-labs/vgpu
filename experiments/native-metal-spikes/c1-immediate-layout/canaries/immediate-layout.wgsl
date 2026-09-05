struct RuntimeValues {
  values: array<u32>,
}

struct ComputeResult {
  values: array<u32, 2>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) runtimeLength: u32,
  @location(1) @interpolate(flat) runtimeValue: u32,
}

struct FragmentDepthOutput {
  @location(0) color: vec4u,
  @builtin(frag_depth) depth: f32,
}

@group(0) @binding(0) var<storage, read> runtimeValues: RuntimeValues;
@group(0) @binding(1) var<storage, read_write> computeResult: ComputeResult;

@compute @workgroup_size(1) fn computeMain() {
  computeResult.values[0] = arrayLength(&runtimeValues.values);
  computeResult.values[1] = runtimeValues.values[0];
}

@vertex fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let positions = array(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.runtimeLength = arrayLength(&runtimeValues.values);
  output.runtimeValue = runtimeValues.values[0];
  return output;
}

@fragment fn fragmentDepthMain(input: VertexOutput) -> FragmentDepthOutput {
  var output: FragmentDepthOutput;
  output.color = vec4u(
    arrayLength(&runtimeValues.values),
    input.runtimeLength,
    runtimeValues.values[0],
    input.runtimeValue,
  );
  output.depth = 0.9;
  return output;
}

@fragment fn fragmentNoDepthMain(input: VertexOutput) -> @location(0) vec4u {
  return vec4u(
    arrayLength(&runtimeValues.values),
    input.runtimeLength,
    runtimeValues.values[0],
    input.runtimeValue,
  );
}
