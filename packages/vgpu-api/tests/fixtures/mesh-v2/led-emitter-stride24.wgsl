// gpu.mesh v2 fixture: triangle-led-front LED emitter stream.
// Expected mesh buffer: stride 24 with float32x2 position @0, float32x2 local @8, float32 led_index @16.
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) led_index: f32,
};

@vertex fn vs_main(
  @location(0) position: vec2f,
  @location(1) local: vec2f,
  @location(2) led_index: f32,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.local = local;
  out.led_index = led_index;
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.local, input.led_index, 1.0);
}
