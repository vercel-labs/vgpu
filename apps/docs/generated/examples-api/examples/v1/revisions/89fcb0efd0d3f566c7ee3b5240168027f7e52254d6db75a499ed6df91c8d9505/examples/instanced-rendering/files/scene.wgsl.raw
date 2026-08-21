struct Uniforms {
  viewProjection: mat4x4f,
  light: vec3f,
  time: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexIn {
  @location(0) local_position: vec3f,
  @location(1) local_normal: vec3f,
  @location(2) i_position: vec3f,
  @location(3) i_color: vec3f,
  @location(4) i_seed: f32,
};
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) world: vec3f,
};

fn rotate(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  let a = normalize(axis);
  return v * cos(angle) + cross(a, v) * sin(angle) + a * dot(a, v) * (1.0 - cos(angle));
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  let axisA = vec3f(0.35 + fract(input.i_seed * 1.7), 0.6, 0.25 + fract(input.i_seed * 2.3));
  let axisB = vec3f(0.2, 0.4 + fract(input.i_seed * 3.1), 0.8);
  let angle = uniforms.time * (0.35 + fract(input.i_seed * 4.7) * 0.65) + input.i_seed * 6.283;
  let local = rotate(rotate(input.local_position, axisA, angle), axisB, angle * 0.37);
  let normal = rotate(rotate(input.local_normal, axisA, angle), axisB, angle * 0.37);
  let world = input.i_position + local;
  var out: VertexOut;
  out.position = uniforms.viewProjection * vec4f(world, 1.0);
  out.normal = normal;
  out.color = input.i_color;
  out.world = world;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let diffuse = max(dot(normal, normalize(-uniforms.light)), 0.0);
  let rim = pow(1.0 - abs(normal.z), 2.2);
  let lit = input.color * (0.22 + diffuse * 0.82) + vec3f(0.14, 0.25, 0.42) * rim;
  let fog = smoothstep(24.0, 52.0, length(input.world));
  return vec4f(mix(lit, vec3f(0.008, 0.014, 0.035), fog * 0.55), 1.0);
}
