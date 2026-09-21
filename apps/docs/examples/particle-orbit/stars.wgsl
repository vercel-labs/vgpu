// Motes from the TypeGPU simulation buffer vgpu wraps for rendering. This
// struct matches TypeGPU's 48-byte Particle layout.
struct Particle {
  position: vec2f,
  velocity: vec2f,
  seed: f32,
  energy: f32,
  tint: vec3f,
}

struct Params {
  time: f32,
  aspect: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

const HALF_HEIGHT_PX = 240.0;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) alpha: f32,
  @location(2) heat: f32,
  @location(3) tint: vec3f,
}

@vertex fn vs_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  var quad = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let corner = quad[vertex];
  let mote = particles[instance];

  let radius = 0.7 + mote.seed * 1.4 + mote.energy * 2.2;
  let twinkle = 0.5 + 0.5 * (0.5 + 0.5 * sin(params.time * (0.8 + mote.seed * 2.2) + f32(instance)));

  let px = mote.position + corner * radius;
  var out: VertexOut;
  out.position = vec4f(px.x / (HALF_HEIGHT_PX * params.aspect), px.y / HALF_HEIGHT_PX, 0.0, 1.0);
  out.local = corner;
  out.alpha = twinkle * mix(0.24, 0.62, mote.seed) + mote.energy * 0.5;
  out.heat = mote.energy;
  out.tint = mote.tint;
  return out;
}

@fragment fn fs_main(
  @location(0) local: vec2f,
  @location(1) alpha: f32,
  @location(2) heat: f32,
  @location(3) tint: vec3f,
) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - length(local));
  // Excited motes flare white; the rest glow with the light they soaked up.
  var color = mix(vec3f(0.75, 0.83, 1.0), vec3f(1.0, 0.98, 0.92), heat);
  color += tint * 1.6;
  return vec4f(color, alpha * falloff * falloff);
}
