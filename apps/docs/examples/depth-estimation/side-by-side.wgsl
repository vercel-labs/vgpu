// Input on the left, normalized nearness on the right. Both are storage buffers.
struct Uniforms {
  resolution: vec2f,
  depth_size: vec2f,
  mode: f32,
  near_meters: f32,
  far_meters: f32,
  has_result: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
@group(0) @binding(2) var<storage, read> range: array<u32>;
@group(0) @binding(3) var<storage, read> colour: array<u32>;

const PRESENTATION_AUTO_RANGE: f32 = 1.0;
const BG: vec3f = vec3f(0.039, 0.039, 0.039);
const PANEL: vec3f = vec3f(0.098, 0.098, 0.098);
const EDGE: vec3f = vec3f(0.180, 0.184, 0.192);

fn value_of(key: u32) -> f32 {
  let bits = select(~key, key & 0x7fffffffu, (key & 0x80000000u) != 0u);
  return bitcast<f32>(bits);
}

fn depth_at(texel: vec2i) -> f32 {
  let limit = vec2i(i32(uniforms.depth_size.x) - 1, i32(uniforms.depth_size.y) - 1);
  let c = clamp(texel, vec2i(0, 0), limit);
  return depth[u32(c.y) * u32(uniforms.depth_size.x) + u32(c.x)];
}

fn nearness(value: f32) -> f32 {
  if (uniforms.mode == PRESENTATION_AUTO_RANGE) {
    let lo = value_of(range[0]);
    let hi = value_of(range[1]);
    let span = hi - lo;
    if (span <= 0.0) {
      return 0.0;
    }
    return clamp((value - lo) / span, 0.0, 1.0);
  }

  let near = max(uniforms.near_meters, 1e-3);
  let far = max(uniforms.far_meters, near * 1.001);
  let d = clamp(value, near, far);
  return clamp(1.0 - log(d / near) / log(far / near), 0.0, 1.0);
}

fn nearness_at(texel: vec2i) -> f32 {
  return nearness(depth_at(texel));
}

fn nearness_sample(uv: vec2f) -> f32 {
  let p = uv * uniforms.depth_size - vec2f(0.5);
  let base = floor(p);
  let f = p - base;
  let i = vec2i(base);
  let top = mix(nearness_at(i), nearness_at(i + vec2i(1, 0)), f.x);
  let bottom = mix(nearness_at(i + vec2i(0, 1)), nearness_at(i + vec2i(1, 1)), f.x);
  return mix(top, bottom, f.y);
}

fn colour_at(texel: vec2i) -> vec3f {
  let limit = vec2i(i32(uniforms.depth_size.x) - 1, i32(uniforms.depth_size.y) - 1);
  let c = clamp(texel, vec2i(0, 0), limit);
  let packed = colour[u32(c.y) * u32(uniforms.depth_size.x) + u32(c.x)];
  return vec3f(
    f32(packed & 0xffu),
    f32((packed >> 8u) & 0xffu),
    f32((packed >> 16u) & 0xffu),
  ) / 255.0;
}

fn colour_sample(uv: vec2f) -> vec3f {
  let p = uv * uniforms.depth_size - vec2f(0.5);
  let base = floor(p);
  let f = p - base;
  let i = vec2i(base);
  let top = mix(colour_at(i), colour_at(i + vec2i(1, 0)), f.x);
  let bottom = mix(colour_at(i + vec2i(0, 1)), colour_at(i + vec2i(1, 1)), f.x);
  return mix(top, bottom, f.y);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = max(uniforms.resolution, vec2f(1.0));
  let px = position.xy;
  let half_width = resolution.x * 0.5;
  let right = px.x >= half_width;
  let panel = vec2f(half_width, resolution.y);
  let scale = min(panel.x / uniforms.depth_size.x, panel.y / uniforms.depth_size.y);
  let drawn = uniforms.depth_size * scale;
  let origin = (panel - drawn) * 0.5;
  let local = vec2f(px.x - select(0.0, half_width, right), px.y) - origin;
  let uv = local / drawn;
  let inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;

  var content = PANEL;
  if (uniforms.has_result < 0.5) {
    content = select(PANEL, colour_sample(clamp(uv, vec2f(0.0), vec2f(1.0))), !right);
  } else if (right) {
    let n = nearness_sample(clamp(uv, vec2f(0.0), vec2f(1.0)));
    content = vec3f(0.04 + 0.92 * n);
  } else {
    content = colour_sample(clamp(uv, vec2f(0.0), vec2f(1.0)));
  }

  var colour_out = select(BG, content, inside);
  let divider = 1.0 - smoothstep(0.0, 1.0, abs(px.x - half_width));
  colour_out = mix(colour_out, EDGE, divider * 0.9);
  return vec4f(clamp(colour_out, vec3f(0.0), vec3f(1.0)), 1.0);
}
