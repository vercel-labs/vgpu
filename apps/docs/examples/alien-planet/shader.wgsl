fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(41.0, 289.0))) * 45758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let p = (position.xy * 2.0 - uniforms.resolution) / min(uniforms.resolution.x, uniforms.resolution.y);
  let starUv = position.xy / uniforms.resolution * vec2f(uniforms.resolution.x / uniforms.resolution.y, 1.0);
  let stars = smoothstep(0.995, 1.0, hash(floor(starUv * 170.0)));
  var color = vec3f(0.005, 0.008, 0.028) + stars * vec3f(0.8, 0.9, 1.0);
  let center = vec2f(0.0, -0.05);
  let q = p - center;
  let r = length(q);
  let atmosphere = smoothstep(0.82, 0.50, r) - smoothstep(0.98, 0.82, r);
  color += vec3f(0.12, 0.85, 1.0) * atmosphere * 0.45;
  if (r < 0.72) {
    let n = noise(q * 8.0 + vec2f(uniforms.time * 0.05, 0.0)) + 0.5 * noise(q * 17.0);
    let bands = sin((q.y + n * 0.13) * 20.0 + uniforms.time * 0.35);
    let terrain = mix(vec3f(0.16, 0.04, 0.26), vec3f(0.68, 0.95, 0.24), smoothstep(-0.25, 0.65, bands + n - 0.65));
    let normal = normalize(vec3f(q, sqrt(max(0.0, 0.72 * 0.72 - r * r))));
    let light = max(dot(normal, normalize(vec3f(-0.45, 0.35, 0.85))), 0.0);
    color = terrain * (0.2 + light * 0.95) + vec3f(0.0, 0.18, 0.16) * pow(1.0 - normal.z, 2.0);
  }
  return vec4f(color, 1.0);
}
