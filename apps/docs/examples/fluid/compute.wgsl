struct SimUniforms {
  resolution: vec2f,
  time: f32,
  frame: f32,
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var<storage, read_write> dye: array<vec4f>;

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var a = 0.5;
  var v = 0.0;
  for (var i = 0; i < 5; i++) {
    v += a * noise(p);
    p = mat2x2f(1.62, 1.18, -1.18, 1.62) * p;
    a *= 0.52;
  }
  return v;
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(sim.resolution);
  if (id.x >= size.x || id.y >= size.y) { return; }

  let uv = (vec2f(id.xy) + 0.5) / sim.resolution;
  let p = (uv - 0.5) * vec2f(sim.resolution.x / sim.resolution.y, 1.0);
  let t = sim.time;
  let swirl = atan2(p.y, p.x) + length(p) * 5.0 - t * 0.7;
  let flow = fbm(p * 3.0 + vec2f(cos(swirl), sin(swirl)) * 0.5 + vec2f(t * 0.08, -t * 0.04));
  let plume = exp(-dot(p - vec2f(0.25 * sin(t), 0.18 * cos(t * 1.4)), p - vec2f(0.25 * sin(t), 0.18 * cos(t * 1.4))) * 6.0);
  let color = mix(vec3f(0.02, 0.04, 0.12), vec3f(0.05, 0.85, 1.0), flow) + plume * vec3f(1.0, 0.22, 0.06);
  dye[id.y * size.x + id.x] = vec4f(pow(color / (1.0 + color), vec3f(0.45)), 1.0);
}
