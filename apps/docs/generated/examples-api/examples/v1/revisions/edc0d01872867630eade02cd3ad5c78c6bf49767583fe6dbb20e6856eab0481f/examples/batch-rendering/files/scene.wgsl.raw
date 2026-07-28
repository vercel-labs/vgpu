struct Uniforms {
  viewProjection: mat4x4f,
  light: vec3f,
  time: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
};
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) color: vec3f,
  @location(2) world: vec3f,
};
@vertex fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.viewProjection * vec4f(input.position, 1.0);
  out.normal = input.normal;
  out.color = input.color;
  out.world = input.position;
  return out;
}
@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let diffuse = max(dot(normal, normalize(-uniforms.light)), 0.0);
  let rim = pow(1.0 - abs(normal.z), 2.2);
  let lit = input.color * (0.22 + diffuse * 0.82) + vec3f(0.14, 0.25, 0.42) * rim;
  let fog = smoothstep(18.0, 34.0, length(input.world));
  return vec4f(mix(lit, vec3f(0.008, 0.014, 0.035), fog * 0.5), 1.0);
}
