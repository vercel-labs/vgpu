struct RuntimeValues {
  values: array<u32>,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@group(4) @binding(2) var<storage, read> runtimeValues: RuntimeValues;

@vertex fn vertexMain(@location(0) position: vec4f) -> VertexOutput {
  var output: VertexOutput;
  let observed = arrayLength(&runtimeValues.values) + runtimeValues.values[0];
  let x = select(-1.0, 1.0, observed > 0u);
  output.position = position + vec4f(x, 0.0, 0.0, 0.0);
  return output;
}

@fragment fn fragmentMain() -> @location(0) vec4f {
  let observed = arrayLength(&runtimeValues.values) + runtimeValues.values[0];
  return vec4f(f32(observed), 0.0, 0.0, 1.0);
}
