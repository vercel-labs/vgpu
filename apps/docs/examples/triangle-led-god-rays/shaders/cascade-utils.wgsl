const PI: f32 = 3.14159265359;
const TWO_PI: f32 = 2.0 * PI;

export struct CascadeInfo { dims: i32, angles: i32, level: i32, range: vec2f };
export struct CascadeAabb { minp: vec2f, maxp: vec2f, center: vec2f };

export fn cascade_info(params: vec4f, level: i32) -> CascadeInfo {
  let dims = i32(params.x) << u32(level);
  let f = 4.0;
  let l = f32(level);
  let start = params.y * (1.0 - pow(f, l)) / (1.0 - f);
  let end = params.y * (1.0 - pow(f, l + 1.0)) / (1.0 - f);
  return CascadeInfo(dims, dims * dims, level, vec2f(start, end));
}

export fn probe_index(pixel: vec2f, ci: CascadeInfo) -> vec2i {
  return vec2i(floor(pixel / f32(ci.dims)));
}

export fn probe_aabb(idx: vec2i, ci: CascadeInfo) -> CascadeAabb {
  let d = f32(ci.dims);
  let bl = d * vec2f(idx);
  return CascadeAabb(bl, bl + vec2f(d - 1.0), bl + vec2f(0.5 * (d - 1.0)));
}

export fn wrap_i(v: i32, m: i32) -> i32 {
  return ((v % m) + m) % m;
}

export fn fmod(a: f32, b: f32) -> f32 {
  return a - floor(a / b) * b;
}

export fn angle_from(cidx: vec2i, ci: CascadeInfo) -> f32 {
  let id = cidx.x + cidx.y * ci.dims;
  let stepv = TWO_PI / f32(ci.angles);
  return fmod(f32(id) * stepv - stepv * 0.5, TWO_PI);
}

export fn ray_dir(angle: f32) -> vec2f {
  return vec2f(cos(angle), sin(angle));
}

export fn idx_to_cascade(id_in: i32, ci: CascadeInfo) -> vec2i {
  let id = wrap_i(id_in, ci.angles);
  return vec2i(id % ci.dims, id / ci.dims);
}

export fn angle_to_index(angle: f32, ci: CascadeInfo) -> i32 {
  return wrap_i(i32(floor((angle / TWO_PI) * f32(ci.angles))), ci.angles);
}
