struct SimUniforms {
  time: f32,
  deltaTime: f32,
  aspect: f32,
  count: f32,
  mouse: vec2f,
  mouseStrength: f32,
  pad: f32,
};

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4f>;

fn hash(seed: f32) -> f32 {
  let s = fract(seed * 0.1031);
  return fract(s * (s + 33.33) * (s + s));
}

fn triangleSdf(p: vec2f, r: f32) -> f32 {
  let k = sqrt(3.0);
  var q = vec2f(abs(p.x) - r, p.y + r / k);
  if (q.x + k * q.y > 0.0) {
    q = vec2f(q.x - k * q.y, -k * q.x - q.y) / 2.0;
  }
  q.x -= clamp(q.x, -2.0 * r, 0.0);
  return -length(q) * sign(q.y);
}

fn animatedSdf(p: vec2f) -> f32 {
  let wobble = 0.08 * sin(p.x * 4.0 + sim.time) * sin(p.y * 5.0 - sim.time * 0.7);
  return triangleSdf(p, 1.45 + wobble);
}

fn sdfGradient(p: vec2f) -> vec2f {
  let e = 0.015;
  return normalize(vec2f(
    animatedSdf(p + vec2f(e, 0.0)) - animatedSdf(p - vec2f(e, 0.0)),
    animatedSdf(p + vec2f(0.0, e)) - animatedSdf(p - vec2f(0.0, e))
  ) + vec2f(0.0001));
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  let index = id.x;
  if (index >= u32(sim.count)) { return; }

  var pos = positions[index].xy;
  let origin = positions[index].zw;
  var vel = velocities[index].xy;
  var life = velocities[index].z;
  let seed = velocities[index].w;

  let sdf = animatedSdf(pos);
  let grad = sdfGradient(pos);
  let tangent = vec2f(-grad.y, grad.x);
  vel += (tangent * 0.22 - grad * sign(sdf) * 0.16) * sim.deltaTime;

  let toMouse = pos - sim.mouse;
  let mouseDist = length(toMouse);
  if (mouseDist < 0.75 && mouseDist > 0.001) {
    vel += normalize(toMouse) * (1.0 - mouseDist / 0.75) * sim.mouseStrength * sim.deltaTime;
  }

  vel *= 0.992;
  pos += vel * sim.deltaTime;
  life += sim.deltaTime;

  if (life > 8.0 || length(pos) > 3.4) {
    pos = origin;
    vel = vec2f(hash(seed + sim.time) - 0.5, hash(seed + 17.0 + sim.time) - 0.5) * 0.45;
    life = hash(seed + sim.time * 2.0) * 1.5;
  }

  positions[index] = vec4f(pos, origin);
  velocities[index] = vec4f(vel, life, seed);
}
