struct Particle {
  position: vec4f,
  velocity: vec4f,
  seed: vec4f,
  geo: vec4f,
}

struct Params {
  time: f32,
  dt: f32,
  aspect: f32,
  reduced_motion: f32,
  earth_mix: f32,
  pointer: vec2f,
  pointer_strength: f32,
  particle_count: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;

fn rotate_y(value: vec3f, angle: f32) -> vec3f {
  let c = cos(angle);
  let s = sin(angle);
  return vec3f(c * value.x + s * value.z, value.y, -s * value.x + c * value.z);
}

@compute @workgroup_size(128)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.particle_count) { return; }

  var particle = particles[id.x];
  let seed = particle.seed;
  let motion = 1.0 - params.reduced_motion;
  let angle = seed.x + params.time * (0.15 + seed.w * 0.06) * motion;
  let ring = sqrt(max(0.0, 1.0 - seed.y * seed.y));
  let sphere = vec3f(cos(angle) * ring, seed.y, sin(angle) * ring) * seed.z;
  var home = sphere;

  let drift_time = params.time * motion;
  home += 0.045 * motion * vec3f(
    sin(home.y * 5.0 + drift_time * 0.7),
    sin(home.z * 4.0 - drift_time * 0.55),
    sin(home.x * 5.0 + drift_time * 0.5)
  );
  let azimuth = atan2(home.z, home.x);
  let ridge = pow(0.5 + 0.5 * sin(home.y * 24.0 + azimuth * 4.0 - drift_time * 1.15), 5.0);
  let relief = motion * (0.07 * ridge + 0.025 * sin(azimuth * 7.0 + home.y * 9.0 + drift_time * 0.5));
  home *= 1.0 + relief;

  let latitude = asin(clamp(seed.y, -1.0, 1.0));
  let land = particle.geo.x;
  let earth_angle = seed.x + 2.3 + sin(drift_time * 0.18) * 0.16;
  var earth_home = vec3f(cos(earth_angle) * ring, seed.y, sin(earth_angle) * ring) * seed.z;
  let tectonic_wave = sin(latitude * 17.0 + seed.x * 11.0 + drift_time * 0.32);
  earth_home *= 1.0 + land * (0.035 + 0.012 * tectonic_wave);
  let morph = smoothstep(0.0, 1.0, params.earth_mix);
  home = mix(home, earth_home, morph);

  let shape_strength = params.pointer_strength * (1.0 - morph);
  let direction = normalize(params.pointer + vec2f(0.001));
  let transverse = vec2f(-direction.y, direction.x);
  let along = dot(home.xy, direction);
  let lobe = sin(atan2(home.y, home.x) * 3.0 + drift_time * 1.2 + home.z * 2.0);
  home = vec3f(
    home.xy * (1.0 + shape_strength * 0.2 * lobe),
    home.z
  );
  home = vec3f(
    home.xy + shape_strength * (
      direction * (0.22 + 0.24 * along) +
      transverse * 0.1 * sin(home.z * 5.0 + drift_time)
    ),
    home.z
  );

  var position = particle.position.xyz;
  var velocity = particle.velocity.xyz;
  let delta = position.xy - params.pointer;
  let proximity = exp(-dot(delta, delta) * 4.2) * shape_strength;
  var force = (home - position) * 11.0;
  force += vec3f(
    vec2f(-delta.y, delta.x) * proximity * 6.5,
    proximity * 0.38 * sin(drift_time * 2.0 + seed.x)
  );
  velocity = (velocity + force * params.dt) * exp(-3.3 * params.dt);
  position += velocity * params.dt;

  particle.position = vec4f(position, land * morph);
  particle.velocity = vec4f(velocity, morph);
  particles[id.x] = particle;
}
