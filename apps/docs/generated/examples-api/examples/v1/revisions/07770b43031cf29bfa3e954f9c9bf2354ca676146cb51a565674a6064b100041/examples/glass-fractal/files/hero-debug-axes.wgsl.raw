struct Params {
  viewProjection: mat4x4f,
  model: mat4x4f,
  resolution: vec2f,
  lineWidth: f32,
  opacity: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
};

@vertex fn vs_main(
  @location(0) line_start: vec3f,
  @location(1) line_end: vec3f,
  @location(2) axis_color: vec3f,
  @location(3) corner: vec2f,
) -> VertexOut {
  let start = params.viewProjection * params.model * vec4f(line_start, 1.0);
  let end = params.viewProjection * params.model * vec4f(line_end, 1.0);
  let startNdc = start.xy / max(start.w, 0.0001);
  let endNdc = end.xy / max(end.w, 0.0001);
  let pixelDirection = (endNdc - startNdc) * params.resolution * 0.5;
  let direction = pixelDirection / max(length(pixelDirection), 0.0001);
  let normal = vec2f(-direction.y, direction.x);
  let offsetNdc = normal * corner.y * params.lineWidth / params.resolution;

  var clipPosition = mix(start, end, corner.x);
  clipPosition.x += offsetNdc.x * clipPosition.w;
  clipPosition.y += offsetNdc.y * clipPosition.w;

  var out: VertexOut;
  out.position = clipPosition;
  out.color = axis_color;
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let alpha = clamp(params.opacity, 0.0, 1.0);
  return vec4f(in.color * alpha, alpha);
}
