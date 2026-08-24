struct Scene {
  view_projection: mat4x4f,
  time: f32,
  clip: f32,
  cap: f32,
};
@group(0) @binding(0) var<uniform> scene: Scene;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec3f,
  @location(1) normal: vec3f,
};

fn rotate(p: vec3f) -> vec3f {
  let cy = cos(scene.time * 0.28); let sy = sin(scene.time * 0.28);
  let q = vec3f(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  let cx = cos(0.62); let sx = sin(0.62);
  return vec3f(q.x, cx * q.y - sx * q.z, sx * q.y + cx * q.z);
}

@vertex fn vs_main(@location(0) position: vec3f, @location(1) normal: vec3f) -> VertexOut {
  var local = position;
  if (scene.cap > 0.5) {
    let radius = sqrt(max(0.0, 1.0 - scene.clip * scene.clip));
    local = vec3f(position.x * radius, scene.clip, position.z * radius);
  }

  var out: VertexOut;
  out.position = scene.view_projection * vec4f(rotate(local), 1.0);
  out.local = local;
  out.normal = rotate(normal);
  return out;
}

fn grid_line(x: f32) -> f32 {
  let d = min(fract(x), 1.0 - fract(x));
  return 1.0 - smoothstep(0.02, 0.07, d);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  if (scene.cap < 0.5 && in.local.y > scene.clip) { discard; }

  let n = normalize(in.normal);
  let diffuse = max(dot(n, normalize(vec3f(-0.4, 0.8, 1.0))), 0.0);
  let rim = pow(1.0 - abs(n.z), 2.5);

  if (scene.cap > 0.5) {
    let grid = max(grid_line(in.local.x * 5.0), grid_line(in.local.z * 5.0));
    let radius = sqrt(max(0.001, 1.0 - scene.clip * scene.clip));
    let edge = smoothstep(0.78, 1.0, length(in.local.xz) / radius);
    let color = mix(vec3f(1.0, 0.18, 0.035), vec3f(1.0, 0.72, 0.16), grid * 0.38 + diffuse * 0.28);
    return vec4f(mix(color, vec3f(1.0, 0.88, 0.42), edge), 1.0);
  }

  let latitude = 0.5 + 0.5 * sin((in.local.y + 0.08) * 12.0);
  var color = mix(vec3f(0.08, 0.11, 0.55), vec3f(0.05, 0.72, 0.95), latitude * 0.24 + diffuse * 0.7);
  color += vec3f(0.18, 0.35, 0.7) * rim;
  let cut_edge = 1.0 - smoothstep(0.0, 0.045, abs(in.local.y - scene.clip));
  return vec4f(mix(color, vec3f(1.0, 0.27, 0.055), cut_edge), 1.0);
}
