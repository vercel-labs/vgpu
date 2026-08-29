// Ten circles reproduce the 1 + 2 + 3 + 4 Agent mark. RGB stores linear HDR
// radiance; alpha is deliberately independent from brightness so even a gray dot remains
// a solid occluder while the center-out loading wave changes its emission.

struct AgentDots {
  size: vec2f,
  time: f32,
  spacing: f32,
  radius: f32,
  animation_mode: u32,
};

@group(0) @binding(0) var<uniform> agent: AgentDots;

fn dot_center(row: i32, column: i32) -> vec2f {
  let vertical_spacing = agent.spacing * 0.86;
  let local = vec2f(
    (f32(column) - f32(row) * 0.5) * agent.spacing,
    (f32(row) - 1.5) * vertical_spacing,
  );
  return agent.size * 0.5 + local;
}

fn smootherstep01(value: f32) -> f32 {
  let x = clamp(value, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

fn perimeter_index(row: i32, column: i32) -> i32 {
  if (row == 0) {
    return 0;
  }
  if (column == row) {
    return row;
  }
  if (row == 3) {
    return 6 - column;
  }
  if (column == 0) {
    return 9 - row;
  }
  return -1;
}

fn center_out_strength(center: vec2f) -> f32 {
  let vertical_spacing = agent.spacing * 0.86;
  // The visual centroid is the middle dot of the third row.
  let wave_origin = agent.size * 0.5 + vec2f(0.0, vertical_spacing * 0.5);
  // Quantizing the mark into its three natural rings gives the 1 -> 6 -> 3
  // choreography a steady beat. The long, overlapping ramps keep the wave fluid.
  let ring = round(distance(center, wave_origin) / agent.spacing);
  let phase = fract(agent.time / 2.4);
  let arrival_start = 0.08 + ring * 0.12;
  let reached = smootherstep01((phase - arrival_start) / 0.24);

  // Let the completed logo read as a pose before every dot releases together.
  // A matching smootherstep leaves a quiet gray beat on both sides of the loop.
  let fade = 1.0 - smootherstep01((phase - 0.74) / 0.16);
  return reached * fade;
}

fn edge_orbit_strength(row: i32, column: i32) -> f32 {
  let index = perimeter_index(row, column);
  if (index < 0) {
    return 0.0;
  }

  // Exactly one stationary dot is active while the head steps clockwise through
  // the nine perimeter positions. No position or geometry is animated.
  let head = fract(agent.time / 2.7) * 9.0;
  let active_index = i32(floor(head + 0.5)) % 9;
  return select(0.0, 1.0, index == active_index);
}

fn edge_then_center_strength(row: i32, column: i32) -> f32 {
  let edge_index = perimeter_index(row, column);
  let sequence_index = select(9, edge_index, edge_index >= 0);
  let phase = fract(agent.time / 3.4);
  let arrival_start = 0.04 + f32(sequence_index) * 0.055;
  let reached = smootherstep01((phase - arrival_start) / 0.07);
  let fade = 1.0 - smootherstep01((phase - 0.78) / 0.13);
  return reached * fade;
}

fn animation_strength(row: i32, column: i32, center: vec2f) -> f32 {
  if (agent.animation_mode == 1u) {
    return edge_orbit_strength(row, column);
  }
  if (agent.animation_mode == 2u) {
    return edge_then_center_strength(row, column);
  }
  return center_out_strength(center);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = uv * agent.size;
  var result = vec4f(0.0);

  for (var row = 0; row < 4; row = row + 1) {
    for (var column = 0; column <= row; column = column + 1) {
      let center = dot_center(row, column);
      let signed_distance = distance(pixel, center) - agent.radius;
      let mask = 1.0 - smoothstep(-0.8, 0.8, signed_distance);
      let emission = mix(0.065, 8.5, animation_strength(row, column, center));
      let cool_white = vec3f(emission * 0.96, emission * 0.985, emission);
      result = max(result, vec4f(cool_white * mask, mask));
    }
  }

  return result;
}
