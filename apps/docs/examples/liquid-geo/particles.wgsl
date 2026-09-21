struct Particle {
  position: vec4f,
  velocity: vec4f,
  seed: vec4f,
  geo: vec4f,
}

struct View {
  aspect: f32,
  pixel_scale: f32,
  height: f32,
  time: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> view: View;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) shell_normal: vec3f,
  @location(2) grain: f32,
  @location(3) earth_land: f32,
  @location(4) earth_mix: f32,
}

@vertex
fn vertex_main(
  @builtin(vertex_index) vertex: u32,
  @builtin(instance_index) instance: u32
) -> VertexOut {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  );
  let particle = particles[instance];
  let position = particle.position.xyz;
  let perspective = 3.25 / (3.25 - position.z * 0.3);
  let center = position.xy * perspective * 0.59 * vec2f(1.0 / view.aspect, 1.0);
  let earth_size = mix(0.42, 1.5, particle.position.w);
  let size = (1.55 + particle.seed.w * 0.8) * view.pixel_scale *
    mix(1.0, earth_size, particle.velocity.w);

  var out: VertexOut;
  out.position = vec4f(
    center + corners[vertex] * size / view.height * vec2f(1.0 / view.aspect, 1.0),
    clamp(0.5 - position.z * 0.18, 0.01, 0.99),
    1.0
  );
  out.uv = corners[vertex];
  out.shell_normal = normalize(position);
  out.grain = particle.seed.w;
  out.earth_land = particle.position.w;
  out.earth_mix = particle.velocity.w;
  return out;
}

@fragment
fn fragment_main(in: VertexOut) -> @location(0) vec4f {
  let radius = dot(in.uv, in.uv);
  if (radius > 1.0) { discard; }

  let bead = vec3f(in.uv, sqrt(max(0.0, 1.0 - radius)));
  let normal = normalize(in.shell_normal + bead * 0.55);
  let light = normalize(vec3f(-0.7, 0.9, 1.2));
  let half_vector = normalize(light + vec3f(0.0, 0.0, 1.0));
  let diffuse = max(dot(normal, light), 0.0);
  let specular = pow(max(dot(normal, half_vector), 0.0), 38.0);
  let reflection = reflect(vec3f(0.0, 0.0, -1.0), normal);
  let silver_strip = exp(-pow((reflection.x + 0.35) * 9.0, 2.0)) * smoothstep(-0.2, 0.8, reflection.y);
  let warm_strip = exp(-pow((reflection.x - 0.48) * 11.0, 2.0)) * smoothstep(-0.3, 0.7, -reflection.y);
  let fresnel = pow(1.0 - max(normal.z, 0.0), 3.0);

  let ocean = vec3f(0.018, 0.075, 0.11);
  let continent_color = vec3f(0.035, 0.04, 0.045);
  let earth_base = mix(ocean, continent_color, in.earth_land);
  let earth_diffuse = mix(vec3f(0.06, 0.2, 0.27), vec3f(0.2, 0.21, 0.22), in.earth_land);
  let earth_reflection = mix(0.16, 0.48, in.earth_land);
  var color = mix(vec3f(0.035, 0.04, 0.046), earth_base, in.earth_mix) +
    mix(vec3f(0.34, 0.36, 0.38), earth_diffuse, in.earth_mix) * diffuse;
  color += vec3f(0.82, 0.85, 0.89) * specular * mix(1.0, earth_reflection, in.earth_mix);
  color += vec3f(0.34, 0.38, 0.42) * silver_strip * mix(1.0, earth_reflection, in.earth_mix);
  color += vec3f(0.34, 0.18, 0.08) * warm_strip * 0.3;
  color += vec3f(0.12, 0.15, 0.18) * fresnel;
  color += vec3f(0.045, 0.05, 0.055) * in.earth_land * in.earth_mix * (0.3 + 0.7 * diffuse);
  color *= (0.72 + 0.28 * in.grain) * (0.68 + 0.32 * bead.z);
  return vec4f(color, 1.0);
}
