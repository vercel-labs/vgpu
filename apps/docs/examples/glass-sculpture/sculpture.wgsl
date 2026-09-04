// A raymarched glass sculpture on a studio floor.
//
// Every pixel marches to the sculpture, then follows the refracted ray *through*
// the glass (marching the inverted distance field), bouncing on total internal
// reflection up to three times, and reads the environment where it exits.
// Red, green and blue take slightly different paths (dispersion), and tinted
// glass absorbs along the internal path length (Beer-Lambert).

struct Params {
  resolution: vec2f,
  time: f32,
  shape: f32,
  tint: f32,
  quality: f32,
  yaw: f32,
  pitch: f32,
  radius: f32,
  dispersion: f32,
  strip_angle: f32,
  floor_luminance: f32,
  key: vec4f,               // xyz direction, w power
  key_color: vec4f,
  rim: vec4f,
  rim_color: vec4f,
  background_top: vec4f,
  background_bottom: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;

const FLOOR_Y: f32 = -1.05;
const IOR: f32 = 1.5;

fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(c, s, -s, c);
}

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn sd_torus(p: vec3f, t: vec2f) -> f32 {
  let q = vec2f(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

fn sd_box(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn fresnel(cos_theta: f32) -> f32 {
  return 0.04 + 0.96 * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}

// ---------- the sculpture ----------

fn sculpture(p0: vec3f) -> f32 {
  let shape = i32(params.shape + 0.5);
  let t = params.time;
  let xz = rot2(t * 0.25) * p0.xz; // slow turntable
  let p = vec3f(xz.x, p0.y, xz.y);
  if (shape == 1) {
    // gyroid shell carved out of a sphere
    let sc = 5.0;
    let g = (sin(p.x * sc) * cos(p.y * sc) + sin(p.y * sc) * cos(p.z * sc) + sin(p.z * sc) * cos(p.x * sc)) / sc;
    return max(length(p) - 1.0, abs(g) - 0.07);
  }
  if (shape == 2) {
    // cluster of merging droplets
    var d = 1e5;
    for (var i = 0; i < 6; i = i + 1) {
      let fi = f32(i);
      let c = vec3f(sin(t * 0.7 + fi * 2.1), cos(t * 0.5 + fi * 1.3) * 0.6, sin(t * 0.6 + fi * 0.7 + 1.0)) * 0.55;
      d = smin(d, length(p - c) - (0.42 + 0.1 * sin(fi * 3.0 + t)), 0.35);
    }
    return d;
  }
  // a torus whose cross-section rotates as it goes around, wrapped by a thin ring
  let a = atan2(p.z, p.x);
  var q = vec3f(length(p.xz) - 0.75, p.y, 0.0);
  q = vec3f(rot2(a * 1.5 + t * 0.5) * q.xy, 0.0);
  let bar = sd_box(q, vec3f(0.34, 0.12, 0.0)) - 0.08;
  let ring = sd_torus(p, vec2f(1.05, 0.06));
  return smin(bar, ring, 0.15);
}

fn normal_at(p: vec3f) -> vec3f {
  let e = 0.0015;
  let k = vec2f(1.0, -1.0);
  return normalize(
    k.xyy * sculpture(p + k.xyy * e) + k.yyx * sculpture(p + k.yyx * e) +
    k.yxy * sculpture(p + k.yxy * e) + k.xxx * sculpture(p + k.xxx * e));
}

fn march(ro: vec3f, rd: vec3f, sign: f32, max_t: f32, steps: i32) -> f32 {
  var t = 0.0;
  for (var i = 0; i < 160; i = i + 1) {
    if (i >= steps) { break; }
    let d = sculpture(ro + rd * t) * sign;
    if (d < 0.0008) { return t; }
    t = t + d * 0.9;
    if (t > max_t) { break; }
  }
  return -1.0;
}

// ---------- studio ----------

fn softbox(d: vec3f, dir: vec3f, size: f32, power: f32) -> f32 {
  return pow(clamp(dot(d, dir), 0.0, 1.0), size) * power;
}

// Procedural environment: a cyclorama gradient, a movable key softbox, a rim
// light, a top fill and a long strip light that rotates behind the sculpture.
fn environment(d: vec3f) -> vec3f {
  var c = mix(params.background_bottom.rgb, params.background_top.rgb, pow(clamp(d.y * 0.5 + 0.5, 0.0, 1.0), 1.5));
  c = c + params.key_color.rgb * softbox(d, normalize(params.key.xyz), 24.0, params.key.w);
  c = c + params.rim_color.rgb * softbox(d, normalize(params.rim.xyz), 40.0, params.rim.w);
  c = c + params.background_top.rgb * softbox(d, vec3f(0.0, 1.0, 0.0), 6.0, 0.6);
  let sd = vec2f(cos(params.strip_angle), sin(params.strip_angle));
  let strip = smoothstep(0.985, 1.0, abs(d.x * sd.x + d.z * sd.y)) * smoothstep(0.35, 0.0, abs(d.y - 0.1));
  c = c + mix(vec3f(1.0), params.key_color.rgb, 0.3) * strip * 3.0 * clamp(params.key.w / 6.0, 0.3, 1.5);
  return c;
}

fn tint_color() -> vec3f {
  let k = i32(params.tint + 0.5);
  if (k == 1) { return vec3f(0.95, 0.45, 0.6); }   // rose
  if (k == 2) { return vec3f(0.35, 0.55, 0.95); }  // cobalt
  if (k == 3) { return vec3f(0.5, 0.9, 0.65); }    // emerald
  return vec3f(0.0);                                // clear
}

fn floor_shade(p: vec3f, rd: vec3f) -> vec3f {
  let r = length(p.xz);
  var base = params.background_bottom.rgb * params.floor_luminance * (1.0 + 0.25 * smoothstep(3.5, 0.0, r));
  let n = vec3f(0.0, 1.0, 0.0);
  base = base + environment(reflect(rd, n)) * fresnel(-dot(rd, n)) * 0.5;
  // contact shadow under the sculpture, and a caustic that sits opposite the key light
  base = base * (1.0 - 0.45 * smoothstep(1.5, 0.3, r));
  let kd = normalize(params.key.xyz);
  let caustic = pow(smoothstep(0.9, 0.0, length(p.xz + kd.xz * 0.55)), 3.0) * (0.6 + 0.4 * sin(params.time * 1.3));
  base = base + params.key_color.rgb * caustic * 0.35 * clamp(params.key.w / 6.0, 0.2, 1.5);
  return base;
}

// Radiance carried by one wavelength (ior) after entering the glass at ro + rd * hit_t.
fn glass_ray(ro: vec3f, rd: vec3f, hit_t: f32, ior: f32) -> vec3f {
  var p = ro + rd * hit_t;
  var dir = refract(rd, normal_at(p), 1.0 / ior);
  var color = vec3f(0.0);
  var throughput = 1.0;
  var path_length = 0.0;
  for (var bounce = 0; bounce < 3; bounce = bounce + 1) {
    let start = p + dir * 0.004;
    let ti = march(start, dir, -1.0, 6.0, 90);
    if (ti < 0.0) {
      color = color + environment(dir) * throughput;
      throughput = 0.0;
      break;
    }
    path_length = path_length + ti;
    p = start + dir * ti;
    let n = -normal_at(p); // pointing back into the glass
    let out_dir = refract(dir, n, ior);
    if (dot(out_dir, out_dir) < 0.5) {
      dir = reflect(dir, n); // total internal reflection
      continue;
    }
    let f = fresnel(dot(-dir, n));
    var outside = environment(out_dir);
    if (out_dir.y < 0.0) {
      let tf = (FLOOR_Y - p.y) / out_dir.y;
      let fp = p + out_dir * tf;
      outside = mix(floor_shade(fp, out_dir), environment(out_dir), smoothstep(2.5, 6.0, length(fp.xz)));
    }
    color = color + outside * (1.0 - f) * throughput;
    throughput = throughput * f;
    dir = reflect(dir, n);
    if (throughput < 0.05) { break; }
  }
  color = color + environment(dir) * throughput; // energy still bouncing escapes somewhere
  let tint = tint_color();
  let absorb = exp(-(vec3f(1.0) - tint) * path_length * 1.1 * step(0.01, length(tint)));
  return color * absorb;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  var q = (uv - 0.5) * 2.0;
  q.y = -q.y;
  q.x = q.x * aspect;

  let yaw = params.yaw;
  let pitch = params.pitch;
  let radius = params.radius;
  let ro = vec3f(radius * sin(yaw) * cos(pitch), radius * sin(pitch) + 0.1, radius * cos(yaw) * cos(pitch));
  let forward = normalize(vec3f(0.0, -0.05, 0.0) - ro);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let rd = normalize(q.x * right + q.y * up + 2.2 * forward);

  let steps = i32(mix(80.0, 160.0, params.quality));
  let t_hit = march(ro, rd, 1.0, 12.0, steps);
  let t_floor = select(-1.0, (FLOOR_Y - ro.y) / rd.y, rd.y < 0.0);

  var color: vec3f;
  if (t_hit > 0.0 && (t_floor < 0.0 || t_hit < t_floor)) {
    let p = ro + rd * t_hit;
    let n = normal_at(p);
    let f = fresnel(-dot(rd, n));
    let reflection = environment(reflect(rd, n));
    let spread = 0.008 * params.dispersion;
    var refraction: vec3f;
    if (spread > 0.001) {
      refraction = vec3f(
        glass_ray(ro, rd, t_hit, IOR - spread).r,
        glass_ray(ro, rd, t_hit, IOR).g,
        glass_ray(ro, rd, t_hit, IOR + spread).b);
    } else {
      refraction = glass_ray(ro, rd, t_hit, IOR);
    }
    color = reflection * f + refraction * (1.0 - f);
    // crisp specular highlights from the key and rim lights
    let hk = normalize(normalize(params.key.xyz) - rd);
    color = color + params.key_color.rgb * pow(clamp(dot(n, hk), 0.0, 1.0), 400.0) * 0.4 * params.key.w;
    let hr = normalize(normalize(params.rim.xyz) - rd);
    color = color + params.rim_color.rgb * pow(clamp(dot(n, hr), 0.0, 1.0), 300.0) * 0.25 * params.rim.w;
  } else if (t_floor > 0.0) {
    let fp = ro + rd * t_floor;
    let rdir = reflect(rd, vec3f(0.0, 1.0, 0.0));
    let tr = march(fp + vec3f(0.0, 0.002, 0.0), rdir, 1.0, 8.0, 70);
    var base = floor_shade(fp, rd);
    if (tr > 0.0) {
      // the sculpture's reflection in the glossy floor
      let rp = fp + rdir * tr;
      let rn = normal_at(rp);
      let rf = fresnel(-dot(rdir, rn));
      let ghost = environment(reflect(rdir, rn)) * rf + environment(refract(rdir, rn, 1.0 / IOR)) * (1.0 - rf) * 0.6;
      base = mix(base, ghost, clamp(fresnel(-rd.y) * 1.5, 0.0, 0.85));
    }
    color = mix(base, environment(rd), smoothstep(3.0, 8.0, length(fp.xz)));
  } else {
    color = environment(rd);
  }
  return vec4f(color, 1.0);
}
