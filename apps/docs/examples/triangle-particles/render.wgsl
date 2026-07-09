struct RenderUniforms {
  resolution: vec2f,
  time: f32,
  count: f32,
};

@group(0) @binding(0) var<uniform> renderUniforms: RenderUniforms;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> velocities: array<vec4f>;

struct VertexOut {
  @builtin(position) clipPosition: vec4f,
  @location(0) color: vec3f,
  @location(1) alpha: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  let particle = vertexIndex / 3u;
  let corner = vertexIndex % 3u;
  let basis = array<vec2f, 3>(vec2f(0.0, 1.0), vec2f(-0.866, -0.5), vec2f(0.866, -0.5));
  let pos = positions[particle].xy;
  let velLife = velocities[particle];
  let life = velLife.z;
  let size = mix(0.006, 0.018, smoothstep(0.0, 1.4, life));
  let aspect = renderUniforms.resolution.x / renderUniforms.resolution.y;
  let clip = vec2f((pos.x + basis[corner].x * size) / aspect, pos.y + basis[corner].y * size);
  let hue = fract(f32(particle) * 0.00037 + renderUniforms.time * 0.035 + life * 0.08);
  let color = 0.55 + 0.45 * cos(6.28318 * (vec3f(0.02, 0.33, 0.66) + hue));
  var out: VertexOut;
  out.clipPosition = vec4f(clip, 0.0, 1.0);
  out.color = color;
  out.alpha = smoothstep(0.0, 0.8, life) * (1.0 - smoothstep(6.2, 8.0, life));
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color * input.alpha, input.alpha * 0.72);
}
