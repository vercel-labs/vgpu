// Final postprocess pass: add bloom to linear HDR main-scene colour, tonemap, and apply display contrast.
import { aces_fitted, linear_to_srgb_pow } from "./color-utils.wgsl";

const TRIANGLE_HEIGHT_RATIO: f32 = 0.3;
const SQRT3: f32 = 1.7320508075688772;

struct Config { screen: vec4f, culling: vec4f };
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var source_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;
@group(0) @binding(3) var bloom_tex: texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4f };
const POST_BRIGHTNESS: f32 = 1.0;
const POST_CONTRAST: f32 = 1.2;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  return out;
}

fn distance_to_aabb(p: vec2f, box_min: vec2f, box_max: vec2f) -> f32 {
  let d = max(max(box_min - p, p - box_max), vec2f(0.0));
  return length(d);
}

fn outside_probe_discard_margin(pixel: vec2f) -> bool {
  let tri_height = cfg.screen.y * TRIANGLE_HEIGHT_RATIO;
  let tri_half_side = tri_height / SQRT3;
  let scene_center = cfg.screen.xy * 0.5;
  let light_min = vec2f(
    scene_center.x - tri_half_side - cfg.culling.x - cfg.culling.z,
    scene_center.y - tri_height * (2.0 / 3.0) - cfg.culling.y - cfg.culling.z,
  );
  let light_max = vec2f(
    scene_center.x + tri_half_side + cfg.culling.x + cfg.culling.z,
    scene_center.y + tri_height / 3.0 + cfg.culling.y + cfg.culling.z,
  );
  let light_aabb_size = light_max - light_min;
  let discard_margin_px = cfg.screen.w * 1.5 * max(light_aabb_size.x, light_aabb_size.y);
  return distance_to_aabb(pixel, light_min, light_max) > discard_margin_px;
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let uv = in.pos.xy / cfg.screen.xy;
  let bloom_scale = mix(cfg.screen.z, cfg.screen.z * 0.08, cfg.culling.w);
  var hdr = textureSample(source_tex, linear_samp, uv).rgb + textureSample(bloom_tex, linear_samp, uv).rgb * bloom_scale;
  if (cfg.culling.w < 0.5 && outside_probe_discard_margin(in.pos.xy)) {
    hdr = vec3f(0.0);
  }
  if (cfg.culling.w > 0.5) {
    return vec4f(clamp(hdr, vec3f(0.0), vec3f(1.0)), 1.0);
  }
  var final_colour = linear_to_srgb_pow(aces_fitted(hdr));
  final_colour = (final_colour - vec3f(0.5)) * POST_CONTRAST + vec3f(0.5);
  final_colour *= POST_BRIGHTNESS;
  return vec4f(final_colour, 1.0);
}
