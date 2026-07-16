struct Globals {
  time: f32,
  pointer: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;

@vertex fn vs_main(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4<f32> {
  const positions = array<vec2<f32>, 3>(
    vec2<f32>(-0.5, -0.5),
    vec2<f32>(0.0, 0.5),
    vec2<f32>(0.5, -0.5),
  );
  let pos = positions[vid];
  return vec4<f32>(pos, 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(globals.time, globals.pointer.x, globals.pointer.y, 1.0);
}
