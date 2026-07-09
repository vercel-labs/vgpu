fn scene(p: vec3f) -> f32 {
  let wobble = 0.16 * sin(4.0 * p.x + uniforms.time) * sin(4.0 * p.y - uniforms.time * 0.7) * sin(4.0 * p.z);
  return length(p) - (1.0 + wobble);
}

fn normal(p: vec3f) -> vec3f {
  let e = 0.001;
  return normalize(vec3f(
    scene(p + vec3f(e, 0.0, 0.0)) - scene(p - vec3f(e, 0.0, 0.0)),
    scene(p + vec3f(0.0, e, 0.0)) - scene(p - vec3f(0.0, e, 0.0)),
    scene(p + vec3f(0.0, 0.0, e)) - scene(p - vec3f(0.0, 0.0, e))
  ));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = (position.xy * 2.0 - uniforms.resolution) / min(uniforms.resolution.x, uniforms.resolution.y);
  let ro = vec3f(0.0, 0.0, -3.5);
  let rd = normalize(vec3f(uv, 1.6));
  var t = 0.0;
  var hit = false;
  for (var i = 0; i < 80; i++) {
    let p = ro + rd * t;
    let d = scene(p);
    if (d < 0.001) { hit = true; break; }
    t += d;
    if (t > 8.0) { break; }
  }
  if (!hit) {
    let bg = 0.12 + 0.18 * pow(max(0.0, 1.0 - length(uv)), 2.0);
    return vec4f(bg * vec3f(0.12, 0.20, 0.45), 1.0);
  }
  let p = ro + rd * t;
  let n = normal(p);
  let light = normalize(vec3f(0.6, 0.8, -0.7));
  let diff = max(dot(n, light), 0.0);
  let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
  let color = vec3f(0.18, 0.58, 1.0) * diff + vec3f(0.9, 0.25, 1.0) * rim + vec3f(0.03);
  return vec4f(color, 1.0);
}
