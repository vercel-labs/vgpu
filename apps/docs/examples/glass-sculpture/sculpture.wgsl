struct SculptureParams {
  resolution: vec2f,
  shape: f32,
  tint: f32,
  time: f32,
  quality: f32,
  yaw: f32,
  pitch: f32,
  radius: f32,
  dispersion: f32,
  strip_angle: f32,
  floor_luminance: f32,
  padding: f32,
  key: vec4f,
  key_color: vec4f,
  rim: vec4f,
  rim_color: vec4f,
  background_top: vec4f,
  background_bottom: vec4f,
}

@group(0) @binding(0) var<uniform> params: SculptureParams;

const FLOOR_HEIGHT: f32 = -1.05;
const GLASS_IOR: f32 = 1.5;
const HIT_EPSILON: f32 = 0.0008;

fn rotate2(angle: f32) -> mat2x2f {
  let c = cos(angle);
  let s = sin(angle);
  return mat2x2f(c, s, -s, c);
}

fn smooth_union(a: f32, b: f32, radius: f32) -> f32 {
  let blend = clamp(0.5 + 0.5 * (b - a) / radius, 0.0, 1.0);
  return mix(b, a, blend) - radius * blend * (1.0 - blend);
}

fn torus_distance(point: vec3f, radii: vec2f) -> f32 {
  return length(vec2f(length(point.xz) - radii.x, point.y)) - radii.y;
}

fn rounded_box_distance(point: vec3f, bounds: vec3f, radius: f32) -> f32 {
  let delta = abs(point) - bounds;
  return length(max(delta, vec3f(0.0))) + min(max(delta.x, max(delta.y, delta.z)), 0.0) - radius;
}

fn sculpture_distance(world_point: vec3f) -> f32 {
  let rotated = rotate2(params.time * 0.25) * world_point.xz;
  let point = vec3f(rotated.x, world_point.y, rotated.y);
  let mode = i32(params.shape + 0.5);

  if (mode == 1) {
    let frequency = 5.0;
    let gyroid = (
      sin(point.x * frequency) * cos(point.y * frequency) +
      sin(point.y * frequency) * cos(point.z * frequency) +
      sin(point.z * frequency) * cos(point.x * frequency)
    ) / frequency;
    return max(length(point) - 1.0, abs(gyroid) - 0.07);
  }

  if (mode == 2) {
    var distance = 100000.0;
    for (var i = 0; i < 6; i += 1) {
      let index = f32(i);
      let center = vec3f(
        sin(params.time * 0.7 + index * 2.1),
        cos(params.time * 0.5 + index * 1.3) * 0.6,
        sin(params.time * 0.6 + index * 0.7 + 1.0)
      ) * 0.55;
      let radius = 0.42 + sin(index * 3.0 + params.time) * 0.1;
      distance = smooth_union(distance, length(point - center) - radius, 0.35);
    }
    return distance;
  }

  let angle = atan2(point.z, point.x);
  let cross_section = rotate2(angle * 1.5 + params.time * 0.5) * vec2f(length(point.xz) - 0.75, point.y);
  let ribbon = rounded_box_distance(vec3f(cross_section, 0.0), vec3f(0.34, 0.12, 0.0), 0.08);
  let ring = torus_distance(point, vec2f(1.05, 0.06));
  return smooth_union(ribbon, ring, 0.15);
}

fn sculpture_normal(point: vec3f) -> vec3f {
  let epsilon = 0.0015;
  let axis = vec2f(1.0, -1.0);
  return normalize(
    axis.xyy * sculpture_distance(point + axis.xyy * epsilon) +
    axis.yyx * sculpture_distance(point + axis.yyx * epsilon) +
    axis.yxy * sculpture_distance(point + axis.yxy * epsilon) +
    axis.xxx * sculpture_distance(point + axis.xxx * epsilon)
  );
}

fn march_surface(origin: vec3f, direction: vec3f, distance_sign: f32, limit: f32, step_limit: i32) -> f32 {
  var travel = 0.0;
  for (var step_index = 0; step_index < 160; step_index += 1) {
    if (step_index >= step_limit) { break; }
    let distance = sculpture_distance(origin + direction * travel) * distance_sign;
    if (distance < HIT_EPSILON) { return travel; }
    travel += distance * 0.9;
    if (travel > limit) { break; }
  }
  return -1.0;
}

fn fresnel_schlick(cosine: f32) -> f32 {
  return 0.04 + 0.96 * pow(clamp(1.0 - cosine, 0.0, 1.0), 5.0);
}

fn softbox(direction: vec3f, light_direction: vec3f, hardness: f32, power: f32) -> f32 {
  return pow(clamp(dot(direction, light_direction), 0.0, 1.0), hardness) * power;
}

fn studio_radiance(direction: vec3f) -> vec3f {
  let sky_mix = pow(clamp(direction.y * 0.5 + 0.5, 0.0, 1.0), 1.5);
  var color = mix(params.background_bottom.rgb, params.background_top.rgb, sky_mix);
  color += params.key_color.rgb * softbox(direction, normalize(params.key.xyz), 24.0, params.key.w);
  color += params.rim_color.rgb * softbox(direction, normalize(params.rim.xyz), 40.0, params.rim.w);
  color += params.background_top.rgb * softbox(direction, vec3f(0.0, 1.0, 0.0), 6.0, 0.6);
  let strip_axis = vec2f(cos(params.strip_angle), sin(params.strip_angle));
  let strip_horizontal = abs(dot(direction.xz, strip_axis));
  let strip = smoothstep(0.985, 1.0, strip_horizontal) * smoothstep(0.35, 0.0, abs(direction.y - 0.1));
  color += mix(vec3f(1.0), params.key_color.rgb, 0.3) * strip * 3.0 * clamp(params.key.w / 6.0, 0.3, 1.5);
  return color;
}

fn absorption_color() -> vec3f {
  let mode = i32(params.tint + 0.5);
  if (mode == 1) { return vec3f(0.95, 0.45, 0.60); }
  if (mode == 2) { return vec3f(0.35, 0.55, 0.95); }
  if (mode == 3) { return vec3f(0.50, 0.90, 0.65); }
  return vec3f(0.0);
}

fn shade_floor(point: vec3f, incoming: vec3f) -> vec3f {
  let radius = length(point.xz);
  var color = params.background_bottom.rgb * params.floor_luminance * (1.0 + 0.25 * smoothstep(3.5, 0.0, radius));
  color += studio_radiance(reflect(incoming, vec3f(0.0, 1.0, 0.0))) * fresnel_schlick(-incoming.y) * 0.5;
  color *= 1.0 - 0.45 * smoothstep(1.5, 0.3, radius);
  let key_direction = normalize(params.key.xyz);
  let caustic_position = point.xz + key_direction.xz * 0.55;
  let caustic = pow(smoothstep(0.9, 0.0, length(caustic_position)), 3.0);
  let pulse = 0.6 + 0.4 * sin(params.time * 1.3);
  color += params.key_color.rgb * caustic * pulse * 0.35 * clamp(params.key.w / 6.0, 0.2, 1.5);
  return color;
}

fn trace_glass(origin: vec3f, direction: vec3f, hit_distance: f32, ior: f32) -> vec3f {
  var position = origin + direction * hit_distance;
  var ray = refract(direction, sculpture_normal(position), 1.0 / ior);
  var radiance = vec3f(0.0);
  var throughput = 1.0;
  var internal_distance = 0.0;

  for (var bounce = 0; bounce < 3; bounce += 1) {
    let start = position + ray * 0.004;
    let exit_distance = march_surface(start, ray, -1.0, 6.0, 90);
    if (exit_distance < 0.0) {
      radiance += studio_radiance(ray) * throughput;
      throughput = 0.0;
      break;
    }

    internal_distance += exit_distance;
    position = start + ray * exit_distance;
    let inward_normal = -sculpture_normal(position);
    let exit_ray = refract(ray, inward_normal, ior);
    if (dot(exit_ray, exit_ray) < 0.5) {
      ray = reflect(ray, inward_normal);
      continue;
    }

    let reflection = fresnel_schlick(dot(-ray, inward_normal));
    var outside = studio_radiance(exit_ray);
    if (exit_ray.y < 0.0) {
      let floor_distance = (FLOOR_HEIGHT - position.y) / exit_ray.y;
      let floor_point = position + exit_ray * floor_distance;
      outside = mix(shade_floor(floor_point, exit_ray), outside, smoothstep(2.5, 6.0, length(floor_point.xz)));
    }
    radiance += outside * (1.0 - reflection) * throughput;
    throughput *= reflection;
    ray = reflect(ray, inward_normal);
    if (throughput < 0.05) { break; }
  }

  radiance += studio_radiance(ray) * throughput;
  let tint = absorption_color();
  let absorption = exp(-(vec3f(1.0) - tint) * internal_distance * 1.1 * step(0.01, length(tint)));
  return radiance * absorption;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  var screen = (uv - 0.5) * 2.0;
  screen = vec2f(screen.x * aspect, -screen.y);

  let camera_position = vec3f(
    params.radius * sin(params.yaw) * cos(params.pitch),
    params.radius * sin(params.pitch) + 0.1,
    params.radius * cos(params.yaw) * cos(params.pitch)
  );
  let forward = normalize(vec3f(0.0, -0.05, 0.0) - camera_position);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let ray = normalize(screen.x * right + screen.y * up + 2.2 * forward);

  let surface_steps = i32(mix(80.0, 160.0, params.quality));
  let sculpture_hit = march_surface(camera_position, ray, 1.0, 12.0, surface_steps);
  let floor_hit = select(-1.0, (FLOOR_HEIGHT - camera_position.y) / ray.y, ray.y < 0.0);
  var color: vec3f;

  if (sculpture_hit > 0.0 && (floor_hit < 0.0 || sculpture_hit < floor_hit)) {
    let point = camera_position + ray * sculpture_hit;
    let normal = sculpture_normal(point);
    let reflection_weight = fresnel_schlick(-dot(ray, normal));
    let reflected = studio_radiance(reflect(ray, normal));
    let spread = 0.008 * params.dispersion;
    var refracted: vec3f;
    if (spread > 0.001) {
      refracted = vec3f(
        trace_glass(camera_position, ray, sculpture_hit, GLASS_IOR - spread).r,
        trace_glass(camera_position, ray, sculpture_hit, GLASS_IOR).g,
        trace_glass(camera_position, ray, sculpture_hit, GLASS_IOR + spread).b
      );
    } else {
      refracted = trace_glass(camera_position, ray, sculpture_hit, GLASS_IOR);
    }
    color = mix(refracted, reflected, reflection_weight);
    let key_half = normalize(normalize(params.key.xyz) - ray);
    let rim_half = normalize(normalize(params.rim.xyz) - ray);
    color += params.key_color.rgb * pow(clamp(dot(normal, key_half), 0.0, 1.0), 400.0) * params.key.w * 0.4;
    color += params.rim_color.rgb * pow(clamp(dot(normal, rim_half), 0.0, 1.0), 300.0) * params.rim.w * 0.25;
  } else if (floor_hit > 0.0) {
    let floor_point = camera_position + ray * floor_hit;
    let reflected_ray = reflect(ray, vec3f(0.0, 1.0, 0.0));
    let reflection_hit = march_surface(floor_point + vec3f(0.0, 0.002, 0.0), reflected_ray, 1.0, 8.0, 70);
    var floor_color = shade_floor(floor_point, ray);
    if (reflection_hit > 0.0) {
      let reflection_point = floor_point + reflected_ray * reflection_hit;
      let reflection_normal = sculpture_normal(reflection_point);
      let reflection_weight = fresnel_schlick(-dot(reflected_ray, reflection_normal));
      let ghost = mix(
        studio_radiance(refract(reflected_ray, reflection_normal, 1.0 / GLASS_IOR)) * 0.6,
        studio_radiance(reflect(reflected_ray, reflection_normal)),
        reflection_weight
      );
      floor_color = mix(floor_color, ghost, clamp(fresnel_schlick(-ray.y) * 1.5, 0.0, 0.85));
    }
    color = mix(floor_color, studio_radiance(ray), smoothstep(3.0, 8.0, length(floor_point.xz)));
  } else {
    color = studio_radiance(ray);
  }

  return vec4f(color, 1.0);
}
